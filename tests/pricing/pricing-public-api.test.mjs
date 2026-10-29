import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import test from "node:test";
import { createRuntime } from "../../packages/platform-runtime/src/index.ts";
import { verifyActorContextWithKeySet } from "../../packages/platform-security/src/index.ts";
import {
  createConfiguredPublicAdapters,
  createHttpPricingClient,
  registerPublicRoutes,
} from "../../apps/api-public/dist/index.js";

const customerRef = "cus_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const productRef = "prd_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const variantRef = "var_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const path = "/api/client-v1/pricing/quotes";
const body = {
  customerRef,
  lines: [{ productRef, variantRef, quantity: "2" }],
};
const quote = {
  quoteRef: "prq_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  policyVersionRef: "pvr_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  catalogSnapshotRevision: "1",
  customerRef,
  createdAt: "2026-09-05T00:00:00Z",
  expiresAt: "2026-09-05T00:05:00Z",
  currency: "RUB",
  lines: [
    {
      lineNumber: 1,
      productRef,
      variantRef,
      productDisplayName: "Coffee",
      quantity: "2",
      unit: "piece",
      unitMinor: "150",
      lineTotalMinor: "300",
    },
  ],
  totalMinor: "300",
  hash: "a".repeat(64),
};

async function runtime(t, adapters) {
  const app = await createRuntime({
    name: "pricing-public-test",
    host: "127.0.0.1",
    port: 0,
    shutdownGraceMs: 500,
    deadlineMs: 5_000,
    deadlineProfiles: { defaultMs: 5_000 },
  });
  registerPublicRoutes(app, adapters);
  await app.runtimeController.start();
  t.after(() => app.runtimeController.closeRuntime("SIGTERM"));
  return app;
}
function actor(operationId, permissions = ["pricing:create"]) {
  return {
    iss: "edge-gateway",
    aud: "api-public",
    originalIssuer: "edge-gateway",
    sub: "usr_test",
    permissions,
    operationId,
    correlationId: randomUUID(),
    traceparent: "00-00000000000000000000000000000000-0000000000000000-00",
    iat: 1_000,
    exp: 2_000,
    jti: randomUUID(),
    kid: "test",
  };
}
function adapters(calls, override = {}) {
  return {
    verifyTransport: () => true,
    verifyActor: (_token, operationId) => actor(operationId),
    customer: {
      create: async () => {
        throw new Error("unexpected customer call");
      },
      search: async () => {
        throw new Error("unexpected customer call");
      },
    },
    catalog: {
      search: async () => {
        throw new Error("unexpected catalog call");
      },
    },
    pricing: {
      create: async (request, ctx) => {
        calls.push({ request, ctx });
        return { status: 201, body: quote, replayed: true };
      },
    },
    ...override,
  };
}
const headers = () => ({
  "x-actor-context": "signed-edge",
  "idempotency-key": randomUUID(),
});

void test("pricing ingress requires transport, actor, permission and rejects spoofing before forwarding", async (t) => {
  const calls = [];
  const noTransport = await runtime(
    t,
    adapters(calls, { verifyTransport: () => false }),
  );
  assert.equal(
    (
      await noTransport.inject({
        method: "POST",
        url: path,
        headers: headers(),
        payload: body,
      })
    ).statusCode,
    401,
  );
  const app = await runtime(t, adapters(calls));
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: path,
        headers: { "idempotency-key": randomUUID() },
        payload: body,
      })
    ).statusCode,
    401,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: path,
        headers: { ...headers(), "x-actor-ref": "usr_evil" },
        payload: body,
      })
    ).statusCode,
    403,
  );
  for (const claims of [
    actor("createPricingQuote", []),
    actor("createCustomer"),
    { ...actor("createPricingQuote"), aud: "pricing-service" },
  ]) {
    const denied = await runtime(
      t,
      adapters(calls, { verifyActor: () => claims }),
    );
    assert.equal(
      (
        await denied.inject({
          method: "POST",
          url: path,
          headers: headers(),
          payload: body,
        })
      ).statusCode,
      403,
    );
  }
  assert.equal(calls.length, 0);
});

void test("pricing validates UUID, request guard, and replay-only empty body", async (t) => {
  const calls = [];
  const app = await runtime(t, adapters(calls));
  for (const input of [
    {
      headers: { ...headers(), "idempotency-key": "not-a-uuid" },
      payload: body,
    },
    { headers: headers() },
    {
      headers: headers(),
      payload: { ...body, lines: [{ ...body.lines[0], quantity: "0" }] },
    },
    {
      headers: headers(),
      payload: { ...body, lines: [body.lines[0], body.lines[0]] },
    },
    { headers: { ...headers(), "idempotency-replay-only": "false" } },
    {
      headers: { ...headers(), "idempotency-replay-only": "true" },
      payload: body,
    },
  ]) {
    const result = await app.inject({ method: "POST", url: path, ...input });
    assert.equal(result.statusCode, 400, JSON.stringify(input));
    assert.equal(result.json().code, "VALIDATION_FAILED");
  }
  assert.equal(calls.length, 0);
  const created = await app.inject({
    method: "POST",
    url: path,
    headers: headers(),
    payload: body,
  });
  assert.equal(created.statusCode, 201);
  assert.deepEqual(created.json(), quote);
  assert.equal(created.headers["idempotency-replayed"], "true");
  const replay = await app.inject({
    method: "POST",
    url: path,
    headers: { ...headers(), "idempotency-replay-only": "true" },
  });
  assert.equal(replay.statusCode, 201);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].request, body);
  assert.equal(calls[1].request, undefined);
  assert.equal(calls[1].ctx.replayOnly, true);
});

void test("pricing fails closed on malformed success/problems, private fields and owner exceptions", async (t) => {
  const unavailable = await runtime(
    t,
    adapters([], {
      pricing: {
        create: async () => ({
          status: 503,
          body: {
            type: "about:blank",
            title: "Private",
            status: 503,
            code: "PRICING_POLICY_UNAVAILABLE",
            detail: "private-policy",
            instance: path,
            correlationId: randomUUID(),
            errors: [],
          },
        }),
      },
    }),
  );
  const publicProblem = await unavailable.inject({
    method: "POST",
    url: path,
    headers: headers(),
    payload: body,
  });
  assert.equal(publicProblem.statusCode, 503);
  assert.equal(publicProblem.json().code, "PRICING_POLICY_UNAVAILABLE");
  assert.equal(publicProblem.body.includes("private-policy"), false);
  const invalid = [
    { status: 201, body: { ...quote, supplierCostMinor: "42" } },
    {
      status: 409,
      body: {
        type: "about:blank",
        title: "Bad",
        status: 409,
        code: "OTHER",
        detail: "supplier-secret",
        instance: path,
        correlationId: randomUUID(),
        errors: [],
      },
    },
  ];
  for (const result of invalid) {
    const app = await runtime(
      t,
      adapters([], { pricing: { create: async () => result } }),
    );
    const response = await app.inject({
      method: "POST",
      url: path,
      headers: headers(),
      payload: body,
    });
    assert.equal(response.statusCode, 503);
    assert.equal(response.body.includes("supplier"), false);
  }
  const failed = await runtime(
    t,
    adapters([], {
      pricing: {
        create: async () => {
          throw new Error("supplier-secret");
        },
      },
    }),
  );
  assert.equal(
    (
      await failed.inject({
        method: "POST",
        url: path,
        headers: headers(),
        payload: body,
      })
    ).body.includes("supplier-secret"),
    false,
  );
});

void test("configured outbound client signs pricing delegation and forwards only validated payload and replay header", async (t) => {
  const calls = [];
  const owner = createHttpPricingClient(
    {
      fetch: async (url, options) => {
        calls.push({ url, options });
        return new Response(JSON.stringify(quote), {
          status: 201,
          headers: {
            "content-type": "application/json",
            "idempotency-replayed": "true",
          },
        });
      },
    },
    (claims, aud, operationId, ctx) => {
      assert.equal(aud, "pricing-service");
      assert.equal(operationId, "createPricingQuote");
      assert.equal(claims.sub, "usr_test");
      assert.ok(ctx.correlationId);
      return "signed-pricing";
    },
  );
  const app = await runtime(t, adapters([], { pricing: owner }));
  const result = await app.inject({
    method: "POST",
    url: path,
    headers: headers(),
    payload: body,
  });
  assert.equal(result.statusCode, 201);
  assert.equal(calls[0].url, path);
  assert.equal(calls[0].options.headers["x-actor-context"], "signed-pricing");
  assert.equal(calls[0].options.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(calls[0].options.body), body);
  const replay = await app.inject({
    method: "POST",
    url: path,
    headers: { ...headers(), "idempotency-replay-only": "true" },
  });
  assert.equal(replay.statusCode, 201);
  assert.equal(calls[1].options.headers["idempotency-replay-only"], "true");
  assert.equal(calls[1].options.body, undefined);
  assert.equal(calls[1].options.headers["content-type"], undefined);
});

void test("configured public adapters sign pricing-service delegation; outbound rejects supplier fields and invalid owner problems", async () => {
  const keys = generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey.export({ type: "spki", format: "pem" });
  const fakeContext = {
    config: { services: { "api-public": { outbound: [] } } },
    secrets: {
      security: {
        apiPublicDelegationSigningPrivateKey: keys.privateKey.export({
          type: "pkcs8",
          format: "pem",
        }),
        actorContextEdgeVerificationPublicKeys: {
          active: publicKey,
          previous: publicKey,
        },
      },
    },
  };
  const captures = [];
  const pricingClient = {
    fetch: async (url, options) => {
      captures.push({ url, options });
      return new Response(JSON.stringify(quote), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    },
  };
  const configured = createConfiguredPublicAdapters(
    fakeContext,
    pricingClient,
    pricingClient,
    pricingClient,
  );
  const correlationId = randomUUID();
  const forwardContext = {
    actor: actor("createPricingQuote"),
    context: { correlationId, signal: new AbortController().signal },
    idempotencyKey: randomUUID(),
    replayOnly: false,
  };
  const ok = await configured.pricing.create(body, forwardContext);
  assert.equal(ok.status, 201);
  assert.equal(captures[0].url, path);
  const signed = verifyActorContextWithKeySet(
    captures[0].options.headers["x-actor-context"],
    {
      publicKeys: [keys.publicKey],
      issuer: "api-public",
      audience: "pricing-service",
      nowEpochSeconds: Math.floor(Date.now() / 1000),
      clockSkewSeconds: 5,
    },
  );
  assert.equal(signed.originalIssuer, "edge-gateway");
  assert.equal(signed.operationId, "createPricingQuote");
  assert.equal(signed.correlationId, correlationId);
  assert.ok(signed.permissions.includes("pricing:create"));
  pricingClient.fetch = async () =>
    new Response(JSON.stringify({ ...quote, supplierCostMinor: "42" }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  await assert.rejects(
    configured.pricing.create(body, forwardContext),
    /invalid quote/,
  );
  pricingClient.fetch = async () =>
    new Response(
      JSON.stringify({
        type: "about:blank",
        title: "SECRET",
        status: 409,
        code: "OTHER",
        detail: "supplier",
        instance: path,
        correlationId,
        errors: [],
      }),
      { status: 409, headers: { "content-type": "application/problem+json" } },
    );
  await assert.rejects(
    configured.pricing.create(body, forwardContext),
    /invalid problem/,
  );
});
