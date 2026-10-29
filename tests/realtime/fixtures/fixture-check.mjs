// Independent fixture readiness, explicitly NOT product/SSE launch evidence.
import assert from "node:assert/strict";
import { createHash, createPublicKey, randomUUID, verify } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { nowMs } from "./protocol.mjs";
import { fixture, request, until } from "./transport.mjs";
let result = {
  status: "FAIL",
  launchProof: false,
  classification: "fixture-transport-only-not-launch-proof",
  transport: { tls: true, realAuthorizer: false, realComposition: false },
  checks: {},
  error: null,
};
try {
  await until(
    async () => {
      const response = await request(
        "idp.fixture.invalid",
        443,
        "/health/live",
      );
      return response.status === 200;
    },
    { timeout: 30000, label: "synthetic provider validated TLS readiness" },
  );
  const nonce = randomUUID(),
    state = randomUUID(),
    verifier = randomUUID() + randomUUID();
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const params = new URLSearchParams({
    client_id: fixture.config.browserOidc.clientId,
    redirect_uri: fixture.config.browserOidc.redirectUri,
    response_type: "code",
    scope: "openid",
    state,
    nonce,
    code_challenge_method: "S256",
    code_challenge: challenge,
  });
  const authorize = await request(
    "idp.fixture.invalid",
    443,
    `/authorize?${params}`,
  );
  assert.equal(authorize.status, 302);
  const callback = new URL(authorize.headers.location);
  assert.equal(callback.searchParams.get("state"), state);
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code: callback.searchParams.get("code"),
    code_verifier: verifier,
    client_id: fixture.config.browserOidc.clientId,
    redirect_uri: fixture.config.browserOidc.redirectUri,
  }).toString();
  const token = await request("idp.fixture.invalid", 443, "/token", {
    method: "POST",
    body: form,
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "content-length": String(Buffer.byteLength(form)),
    },
  });
  assert.equal(token.status, 200);
  const jwks = await request("idp.fixture.invalid", 443, "/keys");
  assert.equal(jwks.status, 200);
  const [head, body, signature] = JSON.parse(token.body).id_token.split(".");
  const headers = JSON.parse(Buffer.from(head, "base64url").toString()),
    claims = JSON.parse(Buffer.from(body, "base64url").toString());
  assert.equal(headers.alg, "RS256");
  const key = JSON.parse(jwks.body).keys.find((k) => k.kid === headers.kid);
  assert.ok(key);
  assert.ok(
    verify(
      "RSA-SHA256",
      Buffer.from(`${head}.${body}`),
      createPublicKey({ key, format: "jwk" }),
      Buffer.from(signature, "base64url"),
    ),
  );
  assert.equal(claims.nonce, nonce);
  assert.equal(claims.iss, fixture.config.browserOidc.issuer);
  assert.equal(claims.aud, fixture.config.browserOidc.clientId);
  assert.ok(claims.exp > Math.floor(nowMs() / 1000));
  const replay = await request("idp.fixture.invalid", 443, "/token", {
    method: "POST",
    body: form,
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
  assert.equal(replay.status, 400, "single-use PKCE code");
  result = {
    ...result,
    status: "fixture-transport-only-not-launch-proof",
    checks: {
      providerTls: true,
      pkce: true,
      nonce: true,
      rs256: true,
      singleUseCode: true,
    },
  };
} catch (e) {
  result.error = { code: e.code ?? "FIXTURE_TLS_FAILED", message: e.message };
}
await writeFile(
  "/results/driver-result.json",
  JSON.stringify(result, null, 2) + "\n",
);
console.log(JSON.stringify(result));
process.exitCode = result.error ? 1 : 0;
