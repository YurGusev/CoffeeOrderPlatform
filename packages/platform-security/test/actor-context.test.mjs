import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import test from "node:test";
import {
  parsePublicTlsHostname,
  parseServiceTransportMaterial,
  signActorContext,
  signServiceDelegation,
  verifyActorContext,
  verifyActorContextWithKeySet,
  verifyServiceDelegation,
  verifyServiceDelegationWithKeySet,
} from "../dist/index.js";

function makeActorClaims(overrides = {}) {
  const iat = 1_800_000_000;
  return {
    iss: "edge-gateway",
    aud: "api-public",
    originalIssuer: "edge-gateway",
    sub: "actor:private-caller",
    permissions: ["catalog:read"],
    operationId: "searchCatalogProducts",
    correlationId: randomUUID(),
    traceparent: "00-00000000000000000000000000000000-0000000000000000-00",
    iat,
    exp: iat + 45,
    jti: randomUUID(),
    kid: "edge-actor-context-v1",
    ...overrides,
  };
}

function signRawActorClaims(claims, privateKey) {
  const payload = Buffer.from(JSON.stringify(claims), "utf8");
  return `${payload.toString("base64url")}.${sign(null, payload, privateKey).toString("base64url")}`;
}

function makeServiceClaims(overrides = {}) {
  const iat = 1_800_000_000;
  return {
    iss: "orders",
    aud: "aroma-gateway",
    originalCaller: "orders-api",
    operationId: "reconcileCart",
    correlationId: randomUUID(),
    traceparent: "00-00000000000000000000000000000000-0000000000000000-00",
    iat,
    exp: iat + 45,
    jti: randomUUID(),
    kid: "orders-delegation-v1",
    ...overrides,
  };
}

function signRawServiceClaims(claims, privateKey) {
  const payload = Buffer.from(JSON.stringify(claims), "utf8");
  return `${payload.toString("base64url")}.${sign(null, payload, privateKey).toString("base64url")}`;
}

function assertActorContextError(run, code, privateValues = []) {
  assert.throws(run, (error) => {
    assert.equal(error?.code, code);
    for (const value of privateValues)
      assert.ok(!error.message.includes(value));
    return true;
  });
}

void test("actor context accepts only the compact signed claim shape", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const iat = 1_800_000_000;
  const claims = {
    iss: "edge-gateway",
    aud: "api-public",
    originalIssuer: "edge-gateway",
    sub: "actor:test",
    permissions: ["catalog:read"],
    operationId: "searchCatalogProducts",
    correlationId: randomUUID(),
    traceparent: "00-00000000000000000000000000000000-0000000000000000-00",
    iat,
    exp: iat + 45,
    jti: randomUUID(),
    kid: "edge-actor-context-v1",
  };
  const token = signActorContext(claims, privateKey);
  assert.deepEqual(
    verifyActorContextWithKeySet(token, {
      publicKeys: [publicKey],
      issuer: "edge-gateway",
      audience: "api-public",
      nowEpochSeconds: iat + 1,
      clockSkewSeconds: 0,
    }),
    claims,
  );
  for (const malformed of [
    { ...claims, actorRef: "actor:admin" },
    { ...claims, traceparent: undefined },
    { ...claims, permissions: ["catalog:read", ""] },
  ])
    assert.throws(
      () => signActorContext(malformed, privateKey),
      (error) => error?.code === "ACTOR_CONTEXT_INVALID",
    );
  assert.throws(
    () =>
      verifyActorContextWithKeySet(token, {
        publicKeys: [],
        issuer: "edge-gateway",
        audience: "api-public",
        nowEpochSeconds: iat + 1,
        clockSkewSeconds: 0,
      }),
    (error) => error?.code === "ACTOR_CONTEXT_INVALID",
  );
});

void test("actor context rejects malformed wire tokens and signed claim shapes safely", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const claims = makeActorClaims();
  const options = {
    publicKey,
    issuer: claims.iss,
    audience: claims.aud,
    nowEpochSeconds: claims.iat + 1,
    clockSkewSeconds: 0,
  };

  for (const token of ["", "one-part", ".signature", "payload."]) {
    assertActorContextError(
      () => verifyActorContext(token, options),
      "ACTOR_CONTEXT_INVALID",
      [claims.sub],
    );
  }
  assertActorContextError(
    () => verifyActorContext("e30.c2ln", options),
    "ACTOR_CONTEXT_INVALID",
  );

  for (const malformed of [
    makeActorClaims({ permissions: "catalog:read" }),
    makeActorClaims({ permissions: ["catalog:read", 42] }),
    { ...claims, actorRef: "private-actor-reference" },
    makeActorClaims({
      iat: Number.MAX_SAFE_INTEGER + 1,
      exp: Number.MAX_SAFE_INTEGER + 2,
    }),
    makeActorClaims({ exp: claims.iat }),
  ]) {
    assertActorContextError(
      () =>
        verifyActorContext(signRawActorClaims(malformed, privateKey), options),
      "ACTOR_CONTEXT_INVALID",
      ["private-actor-reference", claims.sub],
    );
  }
});

void test("actor context binds issuer, audience, time bounds, and signature", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const claims = makeActorClaims();
  const token = signActorContext(claims, privateKey);
  const baseOptions = {
    publicKey,
    issuer: claims.iss,
    audience: claims.aud,
    nowEpochSeconds: claims.iat + 1,
    clockSkewSeconds: 0,
  };

  for (const options of [
    { ...baseOptions, issuer: "untrusted-issuer" },
    { ...baseOptions, audience: "other-service" },
  ]) {
    assertActorContextError(
      () => verifyActorContext(token, options),
      "SERVICE_AUDIENCE_FORBIDDEN",
      [claims.sub, "untrusted-issuer", "other-service"],
    );
  }
  for (const options of [
    { ...baseOptions, nowEpochSeconds: claims.iat - 1 },
    { ...baseOptions, nowEpochSeconds: claims.exp },
  ]) {
    assertActorContextError(
      () => verifyActorContext(token, options),
      "ACTOR_CONTEXT_EXPIRED",
      [claims.sub],
    );
  }
  for (const options of [
    { ...baseOptions, nowEpochSeconds: Number.NaN },
    { ...baseOptions, clockSkewSeconds: -1 },
  ]) {
    assertActorContextError(
      () => verifyActorContext(token, options),
      "ACTOR_CONTEXT_INVALID",
      [claims.sub],
    );
  }

  const [payload, signature] = token.split(".");
  assert.ok(payload && signature);
  const changedSignature = `${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
  assertActorContextError(
    () => verifyActorContext(`${payload}.${changedSignature}`, baseOptions),
    "ACTOR_CONTEXT_INVALID",
    [claims.sub],
  );
});

void test("actor context key rotation accepts any trusted key and rejects unknown keys", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const { publicKey: retiredPublicKey } = generateKeyPairSync("ed25519");
  const claims = makeActorClaims();
  const token = signActorContext(claims, privateKey);
  const options = {
    issuer: claims.iss,
    audience: claims.aud,
    nowEpochSeconds: claims.iat + 1,
    clockSkewSeconds: 0,
  };

  assert.deepEqual(
    verifyActorContextWithKeySet(token, {
      ...options,
      publicKeys: [retiredPublicKey, publicKey],
    }),
    claims,
  );
  assertActorContextError(
    () =>
      verifyActorContextWithKeySet(token, {
        ...options,
        publicKeys: [retiredPublicKey],
      }),
    "ACTOR_CONTEXT_INVALID",
    [claims.sub],
  );
  assertActorContextError(
    () =>
      verifyActorContextWithKeySet(token, {
        ...options,
        publicKeys: ["private-verification-key-sentinel"],
      }),
    "ACTOR_CONTEXT_INVALID",
    [claims.sub, "private-verification-key-sentinel"],
  );
});

void test("actor context verifies DER public keys and rejects non-object claims", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const claims = makeActorClaims();
  const options = {
    publicKey,
    issuer: claims.iss,
    audience: claims.aud,
    nowEpochSeconds: claims.iat + 1,
    clockSkewSeconds: 0,
  };

  assert.deepEqual(
    verifyActorContext(signActorContext(claims, privateKey), {
      ...options,
      publicKey: publicKey.export({ format: "der", type: "spki" }),
    }),
    claims,
  );
  for (const malformed of [null, [], "not-an-object"]) {
    assertActorContextError(
      () =>
        verifyActorContext(signRawActorClaims(malformed, privateKey), options),
      "ACTOR_CONTEXT_INVALID",
    );
  }

  const malformedJson = Buffer.from("{", "utf8");
  const malformedJsonToken = `${malformedJson.toString("base64url")}.${sign(
    null,
    malformedJson,
    privateKey,
  ).toString("base64url")}`;
  assertActorContextError(
    () => verifyActorContext(malformedJsonToken, options),
    "ACTOR_CONTEXT_INVALID",
  );
});

void test("service delegation binds signed claims, audiences, validity, and trusted keys", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const { publicKey: retiredPublicKey } = generateKeyPairSync("ed25519");
  const claims = makeServiceClaims();
  const token = signServiceDelegation(claims, privateKey);
  const baseOptions = {
    publicKey,
    issuer: claims.iss,
    audience: claims.aud,
    nowEpochSeconds: claims.iat + 1,
    clockSkewSeconds: 0,
  };

  assert.deepEqual(verifyServiceDelegation(token, baseOptions), claims);
  assert.deepEqual(
    verifyServiceDelegation(token, {
      ...baseOptions,
      publicKey: publicKey.export({ format: "der", type: "spki" }),
    }),
    claims,
  );
  assert.deepEqual(
    verifyServiceDelegationWithKeySet(token, {
      issuer: claims.iss,
      audience: claims.aud,
      nowEpochSeconds: claims.iat + 1,
      clockSkewSeconds: 0,
      publicKeys: [retiredPublicKey, publicKey],
    }),
    claims,
  );

  for (const options of [
    { ...baseOptions, issuer: "untrusted-service" },
    { ...baseOptions, audience: "other-service" },
    { ...baseOptions, nowEpochSeconds: claims.iat - 1 },
    { ...baseOptions, nowEpochSeconds: claims.exp },
    { ...baseOptions, nowEpochSeconds: Number.NaN },
    { ...baseOptions, clockSkewSeconds: -1 },
  ]) {
    assertActorContextError(
      () => verifyServiceDelegation(token, options),
      "SERVICE_DELEGATION_INVALID",
      [claims.originalCaller, "untrusted-service", "other-service"],
    );
  }
  const [payload, signature] = token.split(".");
  assert.ok(payload && signature);
  const changedSignature = `${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
  assertActorContextError(
    () =>
      verifyServiceDelegation(`${payload}.${changedSignature}`, baseOptions),
    "SERVICE_DELEGATION_INVALID",
    [claims.originalCaller],
  );
  assertActorContextError(
    () =>
      verifyServiceDelegationWithKeySet(token, {
        issuer: claims.iss,
        audience: claims.aud,
        nowEpochSeconds: claims.iat + 1,
        clockSkewSeconds: 0,
        publicKeys: [],
      }),
    "SERVICE_DELEGATION_INVALID",
  );
  assertActorContextError(
    () =>
      verifyServiceDelegationWithKeySet(token, {
        issuer: claims.iss,
        audience: claims.aud,
        nowEpochSeconds: claims.iat + 1,
        clockSkewSeconds: 0,
        publicKeys: [retiredPublicKey],
      }),
    "SERVICE_DELEGATION_INVALID",
    [claims.originalCaller],
  );
});

void test("service delegation rejects malformed signed claims and wire tokens safely", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const claims = makeServiceClaims();
  const options = {
    publicKey,
    issuer: claims.iss,
    audience: claims.aud,
    nowEpochSeconds: claims.iat + 1,
    clockSkewSeconds: 0,
  };

  for (const malformed of [
    null,
    [],
    { ...claims, unexpected: "private-delegation-claim" },
    { ...claims, kid: undefined },
    { ...claims, originalCaller: "" },
    { ...claims, iat: Number.MAX_SAFE_INTEGER + 1 },
    { ...claims, iat: claims.exp },
  ]) {
    assertActorContextError(
      () => signServiceDelegation(malformed, privateKey),
      "SERVICE_DELEGATION_INVALID",
      ["private-delegation-claim"],
    );
    assertActorContextError(
      () =>
        verifyServiceDelegation(
          signRawServiceClaims(malformed, privateKey),
          options,
        ),
      "SERVICE_DELEGATION_INVALID",
      ["private-delegation-claim"],
    );
  }
  for (const token of ["", "one-part", ".signature", "payload."]) {
    assertActorContextError(
      () => verifyServiceDelegation(token, options),
      "SERVICE_DELEGATION_INVALID",
      [claims.originalCaller],
    );
  }
  const malformedJson = Buffer.from("{", "utf8");
  const malformedJsonToken = `${malformedJson.toString("base64url")}.${sign(
    null,
    malformedJson,
    privateKey,
  ).toString("base64url")}`;
  assertActorContextError(
    () => verifyServiceDelegation(malformedJsonToken, options),
    "SERVICE_DELEGATION_INVALID",
  );
});

void test("service transport material rejects malformed and extended secret shapes safely", () => {
  for (const material of [
    "private-transport-secret-not-json",
    JSON.stringify({
      caPem: "private-ca-material",
      certPem: "invalid-certificate",
      keyPem: "private-key-material",
      password: "private-password-sentinel",
    }),
  ]) {
    assertActorContextError(
      () =>
        parseServiceTransportMaterial(material, "development", "edge-gateway"),
      "TRANSPORT_IDENTITY_INVALID",
      [
        "private-transport-secret-not-json",
        "private-ca-material",
        "invalid-certificate",
        "private-key-material",
        "private-password-sentinel",
      ],
    );
  }
});

void test("public TLS hostname parsing accepts HTTPS and rejects invalid hosts", () => {
  assert.equal(
    parsePublicTlsHostname("https://api.example.test:8443/v1"),
    "api.example.test",
  );
  for (const invalid of [
    42,
    "",
    "not-a-url",
    "http://api.example.test",
    "https://",
  ]) {
    assertActorContextError(
      () => parsePublicTlsHostname(invalid),
      "TRANSPORT_IDENTITY_INVALID",
    );
  }
});
