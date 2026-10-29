import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import {
  signActorContext,
  verifyServiceDelegation,
} from "../../packages/platform-security/dist/index.js";
import { createOrdersSecurity } from "../../apps/orders-service/dist/infrastructure/order-security.js";

const keyPair = () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKey: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    publicKey: publicKey.export({ format: "pem", type: "spki" }).toString(),
  };
};
const fixed = {
  iss: "api-public",
  aud: "orders-service",
  originalIssuer: "edge-gateway",
  sub: "operator-1",
  permissions: ["orders:create"],
  operationId: "createOrderDraft",
  correlationId: "123e4567-e89b-12d3-a456-426614174000",
  traceparent: "00-00000000000000000000000000000000-0000000000000000-00",
  jti: "123e4567-e89b-12d3-a456-426614174001",
  kid: "api-public-v1",
};

function makeSecurity(overrides = {}) {
  const signing = keyPair(),
    incoming = keyPair(),
    previous = keyPair();
  const security = createOrdersSecurity({
    signingPrivateKey: signing.privateKey,
    publicVerificationKeys: {
      active: incoming.publicKey,
      previous: previous.publicKey,
    },
    ...overrides,
  });
  return { security, signing, incoming, previous };
}

void test("Orders refuses absent scoped signer or incoming verifier before registering routes", () => {
  const { signing, incoming } = makeSecurity();
  assert.throws(() =>
    createOrdersSecurity({
      signingPrivateKey: "",
      publicVerificationKeys: {
        active: incoming.publicKey,
        previous: incoming.publicKey,
      },
    }),
  );
  assert.throws(() =>
    createOrdersSecurity({
      signingPrivateKey: signing.privateKey,
      publicVerificationKeys: { active: "", previous: incoming.publicKey },
    }),
  );
});

void test("Orders verifies actor scope and active/previous signatures, not only an actor header", () => {
  const { security, incoming, previous } = makeSecurity();
  const now = Math.floor(Date.now() / 1000);
  const token = (claims, privateKey = incoming.privateKey) =>
    signActorContext(
      { ...fixed, iat: now, exp: now + 40, ...claims },
      privateKey,
    );
  assert.equal(
    security.verifyPublicDelegation(
      token({}),
      "createOrderDraft",
      fixed.correlationId,
    ).sub,
    "operator-1",
  );
  assert.equal(
    security.verifyPublicDelegation(
      token({}, previous.privateKey),
      "createOrderDraft",
      fixed.correlationId,
    ).sub,
    "operator-1",
  );
  for (const wrong of [
    { aud: "pricing-service" },
    { iss: "edge-gateway" },
    { originalIssuer: "untrusted" },
    { operationId: "confirmOrder" },
    { correlationId: "different" },
    { permissions: ["orders:read:any"] },
    { exp: now - 10, iat: now - 80 },
  ])
    assert.throws(() =>
      security.verifyPublicDelegation(
        token(wrong),
        "createOrderDraft",
        fixed.correlationId,
      ),
    );
  assert.throws(() =>
    security.verifyPublicDelegation(
      token({}, keyPair().privateKey),
      "createOrderDraft",
      fixed.correlationId,
    ),
  );
});

void test("outbound Orders delegation is scoped to approved operations and remaining deadline", () => {
  const { security, signing } = makeSecurity();
  for (const operation of ["getCustomerOrderInput", "verifyPricingQuote"]) {
    const encoded = security.signInternalDelegation({
      operationId: operation,
      correlationId: fixed.correlationId,
      traceparent: fixed.traceparent,
      deadlineUtc: new Date(Date.now() + 700).toISOString(),
    });
    const claims = verifyServiceDelegation(encoded, {
      publicKey: signing.publicKey,
      issuer: "orders-service",
      audience: "api-internal",
      nowEpochSeconds: Math.floor(Date.now() / 1000),
      clockSkewSeconds: 5,
    });
    assert.equal(claims.operationId, operation);
    assert.equal(claims.originalCaller, "orders-service");
    assert.ok(claims.exp - claims.iat <= 6);
  }
  assert.throws(() =>
    security.signInternalDelegation({
      operationId: "setAromaCartLineQuantity",
      correlationId: fixed.correlationId,
      deadlineUtc: new Date(Date.now() + 1000).toISOString(),
    }),
  );
  assert.throws(() =>
    security.signInternalDelegation({
      operationId: "verifyPricingQuote",
      correlationId: fixed.correlationId,
      deadlineUtc: new Date(Date.now() - 1000).toISOString(),
    }),
  );
});
