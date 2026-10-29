import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createRuntime } from "../../packages/platform-runtime/src/index.ts";
import {
  createHttpPricingVerifyClient,
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
