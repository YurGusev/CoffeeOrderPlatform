import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import test from "node:test";
import { createRuntime } from "../../packages/platform-runtime/dist/index.js";
import {
  signServiceDelegation,
  verifyServiceDelegationWithKeySet,
} from "../../packages/platform-security/dist/index.js";
import {
  configuredPricingOrigin,
  configuredPricingTls,
  createConfiguredInternalAdapters,
  createHttpPricingVerifyClient,
  createUnavailableInternalAdapters,
  registerInternalRoutes,
} from "../../apps/api-internal/dist/index.js";

const ref = (prefix) => `${prefix}_${"0".repeat(26)}`;
const request = {
  quoteRef: ref("prq"),
  hash: "a".repeat(64),
  customerRef: ref("cus"),
  quoteLineNumber: 2,
  productRef: ref("prd"),
  variantRef: ref("var"),
  quantity: "2.5",
};
const verified = {
  valid: true,
  quoteRef: request.quoteRef,
  policyVersionRef: ref("pvr"),
  catalogSnapshotRevision: "1",
  customerRef: request.customerRef,
  expiresAt: "2026-09-26T12:00:00.000Z",
  currency: "RUB",
  line: {
    lineNumber: 2,
    productRef: request.productRef,
    variantRef: request.variantRef,
    productDisplayName: "Coffee",
    offerRef: ref("off"),
    mappingRevision: "1",
    quantity: "2.5",
    unit: "piece",
    supplierUnitMinor: "100",
    unitMinor: "130",
    lineTotalMinor: "325",
    currency: "RUB",
    internalProofHash: "b".repeat(64),
  },
};
const url = "/api/internal-v1/pricing/quotes:verify";
const headers = {
  "content-type": "application/json",
  "x-service-delegation": "signed",
};

async function runtime(t, overrides = {}) {
  const app = await createRuntime({
    name: "pricing-internal-api-test",
    host: "127.0.0.1",
    port: 0,
    shutdownGraceMs: 500,
    deadlineMs: 5_000,
    deadlineProfiles: { defaultMs: 5_000 },
  });
  registerInternalRoutes(app, {
    verifyTransport: () => true,
    verifyCallerDelegation: (_token, _request, operationId) => ({
      iss: "orders-service",
      aud: "api-internal",
      originalCaller: "orders-service",
      operationId,
    }),
    signDelegation: () => "outbound-signed",
    pricing: { verify: async () => ({ status: 200, body: verified }) },
    customer: {
      orderInput: async () => {
        throw new Error("not configured");
      },
    },
    binding: {
      register: async () => {
        throw new Error("not configured");
      },
    },
    catalog: {
      export: async () => {
        throw new Error("not configured");
      },
      pricingInput: async () => {
        throw new Error("not configured");
      },
    },
    cart: {
      read: async () => {
        throw new Error("not configured");
      },
      setQuantity: async () => {
        throw new Error("not configured");
      },
      remove: async () => {
        throw new Error("not configured");
      },
    },
    ...overrides,
  });
  await app.runtimeController.start();
  t.after(() => app.runtimeController.closeRuntime("SIGTERM"));
  return app;
}

void test("internal Pricing verify requires trusted Orders peer and signed exact-scoped delegation", async (t) => {
  const calls = [];
  const app = await runtime(t, {
    pricing: {
      verify: async (...args) => {
        calls.push(args);
        return { status: 200, body: verified };
      },
    },
  });
  const inject = (body = request, extra = headers) =>
    app.inject({ method: "POST", url, headers: extra, payload: body });
  assert.equal(
    (await inject(request, { "content-type": "application/json" })).statusCode,
    401,
  );
  assert.equal(
    (await inject(request, { ...headers, "idempotency-key": randomUUID() }))
      .statusCode,
    400,
  );
  assert.equal(
    (await inject(request, { ...headers, "x-actor-context": "spoofed" }))
      .statusCode,
    401,
  );
  assert.equal(
    (
      await inject({
        ...request,
        lines: [
          {
            productRef: request.productRef,
            variantRef: request.variantRef,
            quantity: request.quantity,
          },
        ],
      })
    ).statusCode,
    400,
  );
  assert.equal(calls.length, 0);
  const denied = await runtime(t, { verifyTransport: () => false });
  assert.equal(
    (await denied.inject({ method: "POST", url, headers, payload: request }))
      .statusCode,
    401,
  );
  const forged = await runtime(t, {
    verifyCallerDelegation: () => ({
      iss: "pricing-service",
      aud: "api-internal",
      originalCaller: "orders-service",
      operationId: "verifyPricingQuote",
    }),
  });
  assert.equal(
    (await forged.inject({ method: "POST", url, headers, payload: request }))
      .statusCode,
    403,
  );
  const result = await inject();
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.json(), verified);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][2], "outbound-signed");
});

void test("internal Pricing verify rejects malformed upstream facts and redacts private errors", async (t) => {
  const app = await runtime(t, {
    pricing: {
      verify: async () => ({
        status: 200,
        body: {
          ...verified,
          line: {
            ...verified.line,
            supplierUnitMinor: "PRIVATE",
            secret: "PRIVATE",
          },
        },
      }),
    },
  });
  const result = await app.inject({
    method: "POST",
    url,
    headers,
    payload: request,
  });
  assert.equal(result.statusCode, 503);
  assert.equal(result.body.includes("PRIVATE"), false);
});

void test("internal Pricing verify forwards only allowlisted owner problem codes", async (t) => {
  const body = {
    type: "about:blank",
    title: "PRICING_QUOTE_EXPIRED",
    status: 409,
    code: "PRICING_QUOTE_EXPIRED",
    detail: "quote expired",
    instance: url,
    correlationId: randomUUID(),
    errors: [],
  };
  const app = await runtime(t, {
    pricing: { verify: async () => ({ status: 409, body }) },
  });
  const result = await app.inject({
    method: "POST",
    url,
    headers,
    payload: request,
  });
  assert.equal(result.statusCode, 409);
  assert.equal(result.json().code, "PRICING_QUOTE_EXPIRED");
});

void test("internal Pricing HTTP client validates status, media type and bounds before forwarding", async () => {
  const captured = [];
  const client = createHttpPricingVerifyClient({
    fetch: async (path, options) => {
      captured.push({ path, options });
      return new Response(JSON.stringify(verified), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const context = {
    correlationId: randomUUID(),
    signal: new AbortController().signal,
  };
  assert.deepEqual(await client.verify(request, context, "signed"), {
    status: 200,
    body: verified,
  });
  assert.equal(captured[0].path, url);
  assert.equal(captured[0].options.headers["x-service-delegation"], "signed");
  assert.deepEqual(JSON.parse(captured[0].options.body), request);
  const bad = createHttpPricingVerifyClient({
    fetch: async () =>
      new Response(JSON.stringify({ ...verified, secret: "PRIVATE" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });
  await assert.rejects(
    bad.verify(request, context, "signed"),
    /invalid response/u,
  );
  const wrongType = createHttpPricingVerifyClient({
    fetch: async () =>
      new Response(JSON.stringify(verified), {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
  });
  await assert.rejects(
    wrongType.verify(request, context, "signed"),
    /unsupported media type/u,
  );
  const tooLarge = createHttpPricingVerifyClient({
    fetch: async () =>
      Response.json({ ...verified, extra: "x".repeat(256 * 1024) }),
  });
  await assert.rejects(
    tooLarge.verify(request, context, "signed"),
    /response too large/u,
  );
});

void test("internal Pricing HTTP client preserves the selected quote line's original number", async () => {
  const client = createHttpPricingVerifyClient({
    fetch: async () => Response.json(verified),
  });
  const context = {
    correlationId: randomUUID(),
    signal: new AbortController().signal,
  };
  const result = await client.verify(request, context, "signed");
  assert.equal(result.body.line.lineNumber, 2);
  assert.equal("lines" in result.body, false);
  assert.equal("totalMinor" in result.body, false);
});

void test("configured internal adapters use scoped owner trust and exact Pricing delegation", async () => {
  const orders = generateKeyPairSync("ed25519");
  const pricing = generateKeyPairSync("ed25519");
  const apiInternal = generateKeyPairSync("ed25519");
  const pem = (key, type) => key.export({ type, format: "pem" });
  const context = {
    config: {
      environment: "development",
      services: {
        "api-internal": {
          outbound: [
            "customer-service:4101",
            "catalog-service:4102",
            "pricing-service:4103",
            "aroma-gateway:4301",
          ],
        },
      },
    },
    secrets: {
      security: {
        apiInternalDelegationSigningPrivateKey: pem(
          apiInternal.privateKey,
          "pkcs8",
        ),
        serviceVerificationKeys: {
          "orders-service": {
            active: pem(orders.publicKey, "spki"),
            previous: pem(orders.publicKey, "spki"),
          },
          "pricing-service": {
            active: pem(pricing.publicKey, "spki"),
            previous: pem(pricing.publicKey, "spki"),
          },
        },
      },
    },
  };
  assert.equal(
    configuredPricingOrigin(context),
    "https://pricing-service:4103",
  );
  assert.throws(
    () => configuredPricingTls(context),
    /scoped service transport material/u,
  );
  assert.throws(
    () =>
      configuredPricingTls({
        ...context,
        secrets: {
          security: {
            ...context.secrets.security,
            serviceTransportKeys: { "api-internal": "not-json" },
          },
        },
      }),
    /must be JSON/u,
  );

  const calls = [];
  const adapters = createConfiguredInternalAdapters(context, {
    fetch: async (url, options) => {
      calls.push({ url, options });
      return Response.json(verified);
    },
  });
  const now = Math.floor(Date.now() / 1_000);
  const callerToken = signServiceDelegation(
    {
      iss: "orders-service",
      aud: "api-internal",
      originalCaller: "orders-service",
      operationId: "verifyPricingQuote",
      correlationId: randomUUID(),
      traceparent: "00-00000000000000000000000000000000-0000000000000000-00",
      iat: now,
      exp: now + 30,
      jti: randomUUID(),
      kid: "test",
    },
    orders.privateKey,
  );
  const caller = adapters.verifyCallerDelegation(
    callerToken,
    {},
    "verifyPricingQuote",
    new AbortController().signal,
  );
  assert.equal(caller.iss, "orders-service");
  const correlationId = randomUUID();
  const signed = adapters.signDelegation({
    originalCaller: "orders-service",
    operationId: "verifyPricingQuote",
    context: { correlationId },
  });
  assert.equal(
    verifyServiceDelegationWithKeySet(signed, {
      publicKeys: [apiInternal.publicKey],
      issuer: "api-internal",
      audience: "pricing-service",
      nowEpochSeconds: now,
      clockSkewSeconds: 5,
    }).originalCaller,
    "orders-service",
  );
  const result = await adapters.pricing.verify(
    request,
    {
      correlationId,
      signal: new AbortController().signal,
    },
    signed,
  );
  assert.equal(result.status, 200);
  assert.equal(calls[0].url, url);
  assert.equal(calls[0].options.headers["x-service-delegation"], signed);
  assert.deepEqual(JSON.parse(calls[0].options.body), request);
});

void test("internal configured and unavailable adapters fail closed without scoped credentials", async () => {
  const keys = generateKeyPairSync("ed25519");
  const pem = (key, type) => key.export({ type, format: "pem" });
  const base = {
    config: {
      environment: "development",
      services: { "api-internal": { outbound: ["pricing-service:4103"] } },
    },
    secrets: { security: {} },
  };
  assert.throws(
    () =>
      createConfiguredInternalAdapters(base, {
        fetch: async () => {
          throw new Error("must not fetch");
        },
      }),
    /INTERNAL_API_DELEGATION_KEY_NOT_CONFIGURED/u,
  );
  assert.throws(
    () =>
      createConfiguredInternalAdapters(
        {
          ...base,
          secrets: {
            security: { apiInternalDelegationSigningPrivateKey: "not-a-key" },
          },
        },
        {
          fetch: async () => {
            throw new Error("must not fetch");
          },
        },
      ),
    /DECODER/u,
  );
  const context = {
    ...base,
    secrets: {
      security: {
        apiInternalDelegationSigningPrivateKey: pem(keys.privateKey, "pkcs8"),
        serviceVerificationKeys: {
          "orders-service": { active: "invalid", previous: "invalid" },
        },
      },
    },
  };
  assert.throws(
    () =>
      createConfiguredInternalAdapters(context, {
        fetch: async () => {
          throw new Error("must not fetch");
        },
      }),
    /DECODER/u,
  );
  const unavailable = createUnavailableInternalAdapters();
  assert.equal(unavailable.verifyTransport({}, "orders-service"), false);
  await assert.rejects(
    unavailable.pricing.verify(
      request,
      { correlationId: randomUUID(), signal: new AbortController().signal },
      "forged",
    ),
    /INTERNAL_API_PRICING_CLIENT_NOT_CONFIGURED/u,
  );
});

void test("configured Pricing route verifies real delegation and hides downstream failure details", async (t) => {
  const orders = generateKeyPairSync("ed25519");
  const pricing = generateKeyPairSync("ed25519");
  const apiInternal = generateKeyPairSync("ed25519");
  const pem = (key, type) => key.export({ type, format: "pem" });
  const context = {
    config: {
      environment: "development",
      services: {
        "api-internal": {
          outbound: ["pricing-service:4103"],
        },
      },
    },
    secrets: {
      security: {
        apiInternalDelegationSigningPrivateKey: pem(
          apiInternal.privateKey,
          "pkcs8",
        ),
        serviceVerificationKeys: {
          "orders-service": {
            active: pem(orders.publicKey, "spki"),
            previous: pem(orders.publicKey, "spki"),
          },
          "pricing-service": {
            active: pem(pricing.publicKey, "spki"),
            previous: pem(pricing.publicKey, "spki"),
          },
        },
      },
    },
  };
  const calls = [];
  const adapters = createConfiguredInternalAdapters(context, {
    fetch: async (path, options) => {
      calls.push({ path, options });
      return Response.json(
        {
          type: "about:blank",
          title: "PRIVATE_DOWNSTREAM_FAILURE",
          status: 503,
          code: "PRIVATE_DOWNSTREAM_FAILURE",
          detail: "owner secret",
        },
        { status: 503 },
      );
    },
  });
  const app = await runtime(t, {
    ...adapters,
    // app.inject does not establish the transport identity supplied by mTLS.
    verifyTransport: () => true,
  });
  const now = Math.floor(Date.now() / 1_000);
  const callerToken = (key, operationId) =>
    signServiceDelegation(
      {
        iss: "orders-service",
        aud: "api-internal",
        originalCaller: "orders-service",
        operationId,
        correlationId: randomUUID(),
        traceparent: "00-00000000000000000000000000000000-0000000000000000-00",
        iat: now,
        exp: now + 30,
        jti: randomUUID(),
        kid: "test",
      },
      key,
    );
  const inject = (token) =>
    app.inject({
      method: "POST",
      url,
      headers: { ...headers, "x-service-delegation": token },
      payload: request,
    });

  const badSignature = await inject(
    callerToken(pricing.privateKey, "verifyPricingQuote"),
  );
  assert.equal(badSignature.statusCode, 403);
  assert.equal(badSignature.json().code, "SERVICE_DELEGATION_INVALID");
  const wrongScope = await inject(
    callerToken(orders.privateKey, "getCustomerOrderInput"),
  );
  assert.equal(wrongScope.statusCode, 403);
  assert.equal(wrongScope.json().code, "SERVICE_DELEGATION_INVALID");
  assert.equal(calls.length, 0);

  const result = await inject(
    callerToken(orders.privateKey, "verifyPricingQuote"),
  );
  assert.equal(result.statusCode, 503);
  assert.equal(result.json().code, "PRICING_POLICY_UNAVAILABLE");
  assert.equal(result.body.includes("PRIVATE_DOWNSTREAM_FAILURE"), false);
  assert.equal(result.body.includes("owner secret"), false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, url);
  const outbound = verifyServiceDelegationWithKeySet(
    calls[0].options.headers["x-service-delegation"],
    {
      publicKeys: [apiInternal.publicKey],
      issuer: "api-internal",
      audience: "pricing-service",
      nowEpochSeconds: Math.floor(Date.now() / 1_000),
      clockSkewSeconds: 5,
    },
  );
  assert.equal(outbound.operationId, "verifyPricingQuote");
  assert.equal(outbound.originalCaller, "orders-service");
  assert.deepEqual(JSON.parse(calls[0].options.body), request);
});
