import assert from "node:assert/strict";
import {generateKeyPairSync, randomUUID} from "node:crypto";
import test from "node:test";
import {signActorContext, verifyActorContextWithKeySet} from "../src/index.ts";

void test("actor context accepts only the compact signed claim shape", () => {
  const {privateKey, publicKey} = generateKeyPairSync("ed25519");
  const iat = 1_800_000_000;
  const claims = {
    iss: "edge-gateway", aud: "api-public", originalIssuer: "edge-gateway", sub: "actor:test",
    permissions: ["catalog:read"], operationId: "searchCatalogProducts",
    correlationId: randomUUID(), traceparent: "00-00000000000000000000000000000000-0000000000000000-00",
    iat, exp: iat + 45, jti: randomUUID(), kid: "edge-actor-context-v1",
  };
  const token = signActorContext(claims, privateKey);
  assert.deepEqual(verifyActorContextWithKeySet(token, {
    publicKeys: [publicKey], issuer: "edge-gateway", audience: "api-public", nowEpochSeconds: iat + 1, clockSkewSeconds: 0,
  }), claims);
  for (const malformed of [
    {...claims, actorRef: "actor:admin"},
    {...claims, traceparent: undefined},
    {...claims, permissions: ["catalog:read", ""]},
  ]) assert.throws(() => signActorContext(malformed, privateKey), (error) => error?.code === "ACTOR_CONTEXT_INVALID");
  assert.throws(() => verifyActorContextWithKeySet(token, {
    publicKeys: [], issuer: "edge-gateway", audience: "api-public", nowEpochSeconds: iat + 1, clockSkewSeconds: 0,
  }), (error) => error?.code === "ACTOR_CONTEXT_INVALID");
});
