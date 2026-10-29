import assert from "node:assert/strict";
import { createSign, generateKeyPairSync } from "node:crypto";
import test from "node:test";
import {
  createOidcAuthority,
  OidcDependencyUnavailableError,
} from "../../apps/edge-gateway/dist/oidc-auth.js";

const BASE = 1_800_000_000_000;
const PROFILE = Object.freeze({
  issuer: "https://idp.fixture.invalid",
  clientId: "edge-fixture-client",
  authorizationUrl: "https://idp.fixture.invalid/authorize",
  tokenUrl: "https://idp.fixture.invalid/token",
  jwksUrl: "https://idp.fixture.invalid/keys",
  redirectUri: "https://app.fixture.invalid/auth/callback",
  allowedAlgorithms: Object.freeze(["RS256"]),
});
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const jwk = {
  ...publicKey.export({ format: "jwk" }),
  kid: "fixture-key-1",
  use: "sig",
  alg: "RS256",
  key_ops: ["verify"],
};
const keySet = { keys: [jwk] };

function jwt(
  claimOverrides = {},
  headerOverrides = {},
  signingKey = privateKey,
) {
  const nowSeconds = Math.floor(BASE / 1_000);
  const header = {
    alg: "RS256",
    typ: "JWT",
    kid: "fixture-key-1",
    ...headerOverrides,
  };
  const claims = {
    iss: PROFILE.issuer,
    aud: PROFILE.clientId,
    sub: "provider-subject-must-not-become-actor",
    nonce: "",
    iat: nowSeconds,
    exp: nowSeconds + 3_600,
    ...claimOverrides,
  };
  const first = Buffer.from(JSON.stringify(header)).toString("base64url");
  const second = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signer = createSign("RSA-SHA256");
  signer.update(`${first}.${second}`);
  signer.end();
  return `${first}.${second}.${signer.sign(signingKey).toString("base64url")}`;
}

function response(data, status = 200, contentType = "application/json") {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": contentType },
  });
}

function harness({
  claims = {},
  header = {},
  keys = keySet,
  nowState,
  failJwks = false,
  tokenStatus = 200,
  tokenRedirect = false,
  tokenContentType = "application/json",
  oversizedToken = false,
  refreshKeys,
} = {}) {
  const clock = nowState ?? { value: BASE };
  const calls = [];
  let keyFetches = 0;
  let cancelledResponses = 0;
  const fetcher = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === PROFILE.jwksUrl) {
      keyFetches += 1;
      if (failJwks) throw new Error("fixture JWKS outage");
      return response({
        keys: keyFetches > 1 && refreshKeys ? refreshKeys.keys : keys.keys,
      });
    }
    if (url === PROFILE.tokenUrl) {
      if (tokenRedirect)
        return {
          ok: true,
          redirected: true,
          url: PROFILE.tokenUrl,
          text: async () => JSON.stringify({ id_token: "ignored" }),
        };
      if (oversizedToken)
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(Buffer.alloc(65_537, 32));
            },
            cancel() {
              cancelledResponses += 1;
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      const params = new URLSearchParams(init.body);
      assert.equal(params.get("grant_type"), "authorization_code");
      assert.equal(params.get("redirect_uri"), PROFILE.redirectUri);
      assert.ok(params.get("code_verifier"));
      return response(
        {
          id_token: jwt({ ...claims, nonce: claims.nonce ?? jwtNonce }, header),
        },
        tokenStatus,
        tokenContentType,
      );
    }
    throw new Error(`unexpected URL: ${url}`);
  };
  let jwtNonce = "";
  const authority = createOidcAuthority({
    profile: PROFILE,
    resolveActor: (validatedClaims) => ({
      actorRef:
        validatedClaims.employee_id === "employee-7"
          ? "actor:employee-7"
          : "actor:from-explicit-mapper",
      permissions: ["orders:read", "orders:read"],
    }),
    fetch: fetcher,
    now: () => clock.value,
  });
  return {
    authority,
    calls,
    get keyFetches() {
      return keyFetches;
    },
    get cancelledResponses() {
      return cancelledResponses;
    },
    async begin() {
      const login = await authority.begin();
      const authUrl = new URL(login.authorizationUrl);
      jwtNonce = authUrl.searchParams.get("nonce");
      assert.ok(jwtNonce);
      return login;
    },
    setTime(value) {
      clock.value = value;
    },
  };
}

async function loginAndComplete(h) {
  const { state, loginBinding } = await h.begin();
  return h.authority.complete(state, "fixture-code", loginBinding);
}

void test("profile must be explicit, exact HTTPS and RS256-only", () => {
  assert.throws(
    () =>
      createOidcAuthority({
        resolveActor: () => ({ actorRef: "a", permissions: [] }),
      }),
    /profile/,
  );
  for (const changes of [
    { issuer: "http://idp.fixture.invalid" },
    { tokenUrl: "https://user:pass@idp.fixture.invalid/token" },
    { redirectUri: "https://app.fixture.invalid/callback#frag" },
    { allowedAlgorithms: ["none"] },
  ]) {
    assert.throws(() =>
      createOidcAuthority({
        profile: { ...PROFILE, ...changes },
        resolveActor: () => ({ actorRef: "a", permissions: [] }),
      }),
    );
  }
});

void test("begin creates PKCE S256, nonce and one-use state with a bounded local returnTo", async () => {
  const h = harness();
  const attempt = await h.authority.begin("/app/orders?filter=open");
  const url = new URL(attempt.authorizationUrl);
  assert.equal(url.origin, new URL(PROFILE.authorizationUrl).origin);
  assert.equal(url.searchParams.get("state"), attempt.state);
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("redirect_uri"), PROFILE.redirectUri);
  assert.ok(url.searchParams.get("nonce"));
  assert.match(url.searchParams.get("code_challenge"), /^[\w-]{43}$/u);
  assert.match(attempt.loginBinding, /^[A-Za-z0-9_-]{43}$/u);
  assert.equal(url.search.includes(attempt.loginBinding), false);
  await assert.rejects(
    h.authority.begin("//evil.invalid/app"),
    /unsafe returnTo/,
  );
  await assert.rejects(
    h.authority.begin("/app/%2f%2fevil.invalid"),
    /unsafe returnTo/,
  );
  await assert.rejects(
    h.authority.begin("/app/%2e%2e/admin"),
    /unsafe returnTo/,
  );
  await assert.rejects(h.authority.begin("/app/%252Fadmin"), /unsafe returnTo/);
  await assert.rejects(
    h.authority.begin("https://evil.invalid/app"),
    /unsafe returnTo/,
  );
});

void test("valid callback maps identity only through resolver and yields opaque absolute session plus separate CSRF", async () => {
  const h = harness({ claims: { employee_id: "employee-7" } });
  const login = await h.begin();
  const completed = await h.authority.complete(
    login.state,
    "fixture-code",
    login.loginBinding,
  );
  assert.equal(completed.actorRef, "actor:employee-7");
  assert.equal(completed.returnTo, "/app/customers");
  assert.notEqual(
    completed.sessionId,
    "provider-subject-must-not-become-actor",
  );
  assert.ok(completed.csrf);
  assert.equal(completed.expiresAt, BASE + 15 * 60_000);
  assert.deepEqual(h.authority.session(completed.sessionId), {
    actorRef: "actor:employee-7",
    permissions: ["orders:read"],
    csrf: completed.csrf,
    expiresAt: completed.expiresAt,
  });
  assert.equal(
    h.authority.verifyCsrf(completed.sessionId, completed.csrf),
    true,
  );
  assert.equal(h.authority.verifyCsrf(completed.sessionId, "wrong"), false);
  const tokenCall = h.calls.find((call) => call.url === PROFILE.tokenUrl);
  assert.equal(tokenCall.init.redirect, "error");
  assert.equal(tokenCall.init.method, "POST");
  assert.equal(
    h.calls.every((call) => call.init.signal instanceof AbortSignal),
    true,
    "both OIDC fetches must have deadlines",
  );
  assert.equal(
    h.calls.filter((call) => call.url === PROFILE.jwksUrl).length,
    1,
  );
  assert.equal(h.authority.logout(completed.sessionId), true);
  assert.equal(h.authority.session(completed.sessionId), undefined);
});

void test("fractional clock yields an integer session expiry without extending its absolute lifetime", async () => {
  const h = harness({ nowState: { value: BASE + 0.75 } });
  const completed = await loginAndComplete(h);
  assert.equal(completed.expiresAt, BASE + 15 * 60_000);
  assert.equal(Number.isInteger(completed.expiresAt), true);
  assert.equal(
    h.authority.session(completed.sessionId).expiresAt,
    completed.expiresAt,
  );
  h.setTime(completed.expiresAt - 0.25);
  assert.ok(h.authority.session(completed.sessionId));
  h.setTime(completed.expiresAt);
  assert.equal(h.authority.session(completed.sessionId), undefined);
});

void test("state is consumed before exchange and callback cannot be replayed", async () => {
  const h = harness({ tokenStatus: 503 });
  const login = await h.begin();
  await assert.rejects(
    h.authority.complete(login.state, "code", login.loginBinding),
    OidcDependencyUnavailableError,
  );
  await assert.rejects(
    h.authority.complete(login.state, "code", login.loginBinding),
    /state/,
  );
});

void test("OIDC callback cannot redeem an attacker's state in another browser", async () => {
  const h = harness();
  const login = await h.begin();
  await assert.rejects(
    h.authority.complete(login.state, "fixture-code", "A".repeat(43)),
    /browser binding/,
  );
  assert.equal(
    h.calls.some((call) => call.url === PROFILE.tokenUrl),
    false,
  );
});

void test("state and session expire absolutely", async () => {
  const h = harness();
  const pending = await h.begin();
  h.setTime(BASE + 5 * 60_000);
  await assert.rejects(
    h.authority.complete(pending.state, "code", pending.loginBinding),
    /state/,
  );

  h.setTime(BASE);
  const session = await loginAndComplete(h);
  h.setTime(BASE + 15 * 60_000);
  assert.equal(h.authority.session(session.sessionId), undefined);
});

for (const [name, claims, header] of [
  ["nonce", { nonce: "wrong" }, {}],
  ["issuer", { iss: "https://attacker.fixture.invalid" }, {}],
  ["audience", { aud: "other-client" }, {}],
  [
    "mixed audience types",
    { aud: [PROFILE.clientId, 42], azp: PROFILE.clientId },
    {},
  ],
  [
    "wrong authorized party",
    { aud: PROFILE.clientId, azp: "other-client" },
    {},
  ],
  [
    "missing authorized party for multiple audiences",
    { aud: [PROFILE.clientId, "other-client"] },
    {},
  ],
  ["expired", { exp: Math.floor(BASE / 1_000) - 1 }, {}],
  ["not-yet-valid", { nbf: Math.floor(BASE / 1_000) + 61 }, {}],
  ["future-issued-at", { iat: Math.floor(BASE / 1_000) + 61 }, {}],
  ["algorithm", {}, { alg: "none" }],
  ["unknown kid", {}, { kid: "not-in-jwks" }],
]) {
  void test(`rejects invalid ID token ${typeof name === "string" ? name : "fixture case"}`, async () => {
    const h = harness({ claims, header });
    const login = await h.begin();
    await assert.rejects(
      h.authority.complete(login.state, "code", login.loginBinding),
    );
    assert.equal(h.authority.session("anything"), undefined);
  });
}

void test("unknown kid refreshes JWKS exactly once and fails closed if still unknown", async () => {
  const h = harness({ header: { kid: "rotated" }, refreshKeys: keySet });
  const login = await h.begin();
  await assert.rejects(
    h.authority.complete(login.state, "code", login.loginBinding),
    /unknown signing key/,
  );
  assert.equal(
    h.calls.filter((call) => call.url === PROFILE.jwksUrl).length,
    2,
  );
});

void test("JWKS outage and token endpoint redirect fail closed", async () => {
  for (const setup of [{ failJwks: true }, { tokenRedirect: true }]) {
    const h = harness(setup);
    const login = await h.begin();
    await assert.rejects(
      h.authority.complete(login.state, "code", login.loginBinding),
      OidcDependencyUnavailableError,
    );
    assert.equal(h.authority.session("anything"), undefined);
  }
});

void test("JWKS cache expires at five minutes and refreshes", async () => {
  const h = harness();
  const first = await h.begin();
  await h.authority.complete(first.state, "code", first.loginBinding);
  assert.equal(h.keyFetches, 1);
  h.setTime(BASE + 5 * 60_000);
  const second = await h.begin();
  await h.authority.complete(second.state, "code", second.loginBinding);
  assert.equal(h.keyFetches, 2);
});

void test("oversized OIDC response is cancelled while streaming and creates no session", async () => {
  const h = harness({ oversizedToken: true });
  const { state, loginBinding } = await h.begin();
  await assert.rejects(
    h.authority.complete(state, "fixture-code", loginBinding),
    OidcDependencyUnavailableError,
  );
  assert.equal(h.cancelledResponses, 1);
  assert.equal(h.authority.session("anything"), undefined);
});

void test("OIDC token exchange rejects a wrong media type", async () => {
  const h = harness({ tokenContentType: "text/html" });
  const { state, loginBinding } = await h.begin();
  await assert.rejects(
    h.authority.complete(state, "fixture-code", loginBinding),
    OidcDependencyUnavailableError,
  );
});
