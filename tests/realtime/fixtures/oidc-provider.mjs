import assert from "node:assert/strict";
import { createHash, randomUUID, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import https from "node:https";
import { resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { nowMs } from "./protocol.mjs";

const G15_PERMISSIONS = Object.freeze([
  "customer:create",
  "customer:read",
  "catalog:read",
  "pricing:create",
  "orders:create",
  "orders:edit:any",
  "orders:confirm:any",
  "orders:read:any",
]);
const G15_ACCOUNTS = Object.freeze({
  operator: Object.freeze({
    actorRef: "actor:g15-browser-fixture",
    permissions: G15_PERMISSIONS,
  }),
  restricted: Object.freeze({
    actorRef: "actor:g15-browser-restricted",
    permissions: Object.freeze([]),
  }),
});

export function selectBrowserFixtureAccount(req) {
  const cookie = req.headers.cookie;
  if (cookie === undefined || cookie === "") return G15_ACCOUNTS.operator;
  if (typeof cookie !== "string" || cookie.length > 256)
    throw new Error("invalid fixture account cookie");
  const match = /^g15_fixture_account=(operator|restricted)$/u.exec(cookie);
  if (!match) throw new Error("invalid fixture account cookie");
  return G15_ACCOUNTS[match[1]];
}

export function createOidcProviderServer({
  tlsKeyPem,
  tlsCertificatePem,
  profile,
  signingKey,
  jwk,
  actorRef,
  permissions,
  selectAccount,
  onFail,
}) {
  const codes = new Map();
  const jwt = (claims) => {
    const head = Buffer.from(
        JSON.stringify({ alg: "RS256", typ: "JWT", kid: jwk.kid }),
      ).toString("base64url"),
      body = Buffer.from(JSON.stringify(claims)).toString("base64url");
    return `${head}.${body}.${sign("RSA-SHA256", Buffer.from(`${head}.${body}`), signingKey).toString("base64url")}`;
  };
  const send = (res, status, body) => {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(text),
    });
    res.end(text);
  };
  const server = https.createServer(
    { key: tlsKeyPem, cert: tlsCertificatePem, minVersion: "TLSv1.3" },
    (req, res) => {
      void (async () => {
        const url = new URL(req.url, profile.issuer);
        if (req.method === "GET" && url.pathname === "/health/live")
          return send(res, 200, { live: true });
        if (req.method === "GET" && url.pathname === "/keys")
          return send(res, 200, { keys: [jwk] });
        if (req.method === "GET" && url.pathname === "/authorize") {
          for (const [code, data] of codes)
            if (data.expires < nowMs()) codes.delete(code);
          assert.ok(codes.size < 1000);
          assert.equal(url.searchParams.get("client_id"), profile.clientId);
          assert.equal(
            url.searchParams.get("redirect_uri"),
            profile.redirectUri,
          );
          assert.equal(url.searchParams.get("response_type"), "code");
          assert.equal(url.searchParams.get("code_challenge_method"), "S256");
          const nonce = url.searchParams.get("nonce"),
            state = url.searchParams.get("state"),
            challenge = url.searchParams.get("code_challenge");
          assert.ok(nonce && state && challenge);
          const code = randomUUID();
          const account = selectAccount
            ? selectAccount(req)
            : { actorRef, permissions };
          assert.ok(
            account &&
              typeof account.actorRef === "string" &&
              Array.isArray(account.permissions),
          );
          codes.set(code, {
            nonce,
            challenge,
            expires: nowMs() + 60000,
            account: {
              actorRef: account.actorRef,
              permissions: [...account.permissions],
            },
          });
          const callback = new URL(profile.redirectUri);
          callback.searchParams.set("code", code);
          callback.searchParams.set("state", state);
          res.writeHead(302, {
            location: callback.href,
            "cache-control": "no-store",
          });
          return res.end();
        }
        if (req.method === "POST" && url.pathname === "/token") {
          const chunks = [];
          let bytes = 0;
          for await (const chunk of req) {
            bytes += chunk.length;
            assert.ok(bytes <= 8192);
            chunks.push(chunk);
          }
          const params = new URLSearchParams(Buffer.concat(chunks).toString());
          const pending = codes.get(params.get("code"));
          codes.delete(params.get("code"));
          assert.ok(
            pending && pending.expires > nowMs(),
            "unknown/expired/single-use code",
          );
          assert.equal(params.get("grant_type"), "authorization_code");
          assert.equal(params.get("client_id"), profile.clientId);
          assert.equal(params.get("redirect_uri"), profile.redirectUri);
          assert.equal(
            createHash("sha256")
              .update(params.get("code_verifier") ?? "")
              .digest("base64url"),
            pending.challenge,
          );
          const now = Math.floor(nowMs() / 1000);
          return send(res, 200, {
            id_token: jwt({
              iss: profile.issuer,
              aud: profile.clientId,
              sub: "synthetic-provider-subject",
              [profile.actorRefClaim]: pending.account.actorRef,
              [profile.permissionsClaim]: pending.account.permissions,
              nonce: pending.nonce,
              iat: now,
              exp: now + 3600,
            }),
          });
        }
        if (onFail) return onFail(res, 404, "FIXTURE_ROUTE_NOT_FOUND");
        send(res, 404, { code: "FIXTURE_ROUTE_NOT_FOUND" });
      })().catch(() => {
        if (!res.headersSent) {
          if (onFail) onFail(res, 400, "FIXTURE_REQUEST_REJECTED");
          else send(res, 400, { code: "FIXTURE_REQUEST_REJECTED" });
        } else res.destroy();
      });
    },
  );
  return server;
}

async function runBrowserFixture() {
  const [mode, root, fixtureDir, ...extra] = process.argv.slice(2);
  assert.equal(mode, "--serve-g15");
  assert.ok(root && fixtureDir && extra.length === 0);
  const canonicalRoot = resolve(root);
  const { loadPlatformConfig } = await import(
    pathToFileURL(join(canonicalRoot, "scripts/config-lib.mjs")).href
  );
  const config = await loadPlatformConfig(canonicalRoot);
  const profile = config.browserOidc;
  assert.deepEqual(profile, {
    issuer: "https://idp.fixture.invalid",
    clientId: "realtime-browser-fixture",
    authorizationUrl: "https://idp.fixture.invalid/authorize",
    tokenUrl: "https://idp.fixture.invalid/token",
    jwksUrl: "https://idp.fixture.invalid/keys",
    redirectUri: "https://localhost:8443/auth/callback",
    allowedAlgorithms: ["RS256"],
    actorRefClaim: "actor_ref",
    permissionsClaim: "permissions",
  });
  const [tlsKeyPem, tlsCertificatePem, jwksText, signingKey] =
    await Promise.all([
      readFile(join(fixtureDir, "idp.key"), "utf8"),
      readFile(join(fixtureDir, "idp.crt"), "utf8"),
      readFile(join(fixtureDir, "jwks.json"), "utf8"),
      readFile(join(fixtureDir, "jwks-signing.key"), "utf8"),
    ]);
  const { keys } = JSON.parse(jwksText);
  assert.equal(Array.isArray(keys), true);
  assert.equal(keys.length, 1);
  const [jwk] = keys;
  assert.deepEqual(
    { alg: jwk.alg, kid: jwk.kid, kty: jwk.kty, use: jwk.use },
    {
      alg: "RS256",
      kid: "g15-fixture-rs256-v1",
      kty: "RSA",
      use: "sig",
    },
  );
  const server = createOidcProviderServer({
    tlsKeyPem,
    tlsCertificatePem,
    profile,
    signingKey,
    jwk,
    selectAccount: selectBrowserFixtureAccount,
  });
  server.listen(443, "0.0.0.0");
  return server;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  let server;
  const shutdown = () => {
    server?.close(() => process.exit(0));
    server?.closeAllConnections();
  };
  for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, shutdown);
  runBrowserFixture()
    .then((started) => {
      server = started;
      server.on("error", () => {
        process.exitCode = 1;
      });
    })
    .catch(() => {
      process.exitCode = 1;
    });
}
