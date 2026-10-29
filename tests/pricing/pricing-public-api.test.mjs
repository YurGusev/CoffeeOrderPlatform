import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import test from "node:test";
import { createRuntime } from "../../packages/platform-runtime/dist/index.js";
import {
  signActorContext,
  verifyActorContextWithKeySet,
} from "../../packages/platform-security/dist/index.js";
import {
  configuredPricingOrigin,
  configuredPricingTls,
  createConfiguredPublicAdapters,
  createHttpPricingClient,
  createUnavailablePublicAdapters,
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
  const malformedJson = await app.inject({
    method: "POST",
    url: path,
    headers: { ...headers(), "content-type": "application/json" },
    payload: '{"private":"PRICING_JSON_PARSER_CANARY"',
  });
  assert.equal(malformedJson.statusCode, 400);
  assert.equal(
    malformedJson.headers["content-type"].split(";")[0],
    "application/problem+json",
  );
  assert.equal(malformedJson.headers["cache-control"], "no-store");
  assert.equal(malformedJson.json().code, "VALIDATION_FAILED");
  assert.equal(malformedJson.json().detail, "Request validation failed");
  assert.doesNotMatch(
    malformedJson.body,
    /PRICING_JSON_PARSER_CANARY|Unexpected|JSON/u,
  );
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

void test("configured public adapters sign pricing-service delegation; outbound rejects supplier fields and invalid owner problems", async (t) => {
  const keys = generateKeyPairSync("ed25519");
  const edgeKeys = generateKeyPairSync("ed25519");
  const edgePublicKey = edgeKeys.publicKey.export({
    type: "spki",
    format: "pem",
  });
  const fakeContext = {
    config: {
      environment: "development",
      services: {
        "api-public": {
          outbound: [
            "customer-service:4101",
            "catalog-service:4102",
            "pricing-service:4103",
            "orders-service:4104",
          ],
        },
      },
    },
    secrets: {
      security: {
        apiPublicDelegationSigningPrivateKey: keys.privateKey.export({
          type: "pkcs8",
          format: "pem",
        }),
        actorContextEdgeVerificationPublicKeys: {
          active: edgePublicKey,
          previous: edgePublicKey,
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
  assert.equal(
    configuredPricingOrigin(fakeContext),
    "https://pricing-service:4103",
  );
  assert.throws(
    () => configuredPricingTls(fakeContext),
    /PUBLIC_API_TRANSPORT_NOT_CONFIGURED/u,
  );
  assert.throws(
    () =>
      configuredPricingTls({
        ...fakeContext,
        secrets: {
          ...fakeContext.secrets,
          security: {
            ...fakeContext.secrets.security,
            serviceTransportKeys: { "api-public": "not-json" },
          },
        },
      }),
    /must be JSON/u,
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

  const ingressCorrelationId = randomUUID();
  const ingressIdempotencyKey = randomUUID();
  const traceparent = `00-${randomUUID().replaceAll("-", "")}-${randomUUID().replaceAll("-", "").slice(0, 16)}-01`;
  const now = Math.floor(Date.now() / 1_000);
  const ingressActor = signActorContext(
    {
      iss: "edge-gateway",
      aud: "api-public",
      originalIssuer: "edge-gateway",
      sub: "usr_configured_pricing",
      permissions: ["pricing:create"],
      operationId: "createPricingQuote",
      correlationId: ingressCorrelationId,
      traceparent,
      iat: now,
      exp: now + 45,
      jti: randomUUID(),
      kid: "edge-test",
    },
    edgeKeys.privateKey,
  );
  const app = await runtime(t, {
    ...configured,
    verifyTransport: () => true,
  });
  const response = await app.inject({
    method: "POST",
    url: path,
    headers: {
      "x-actor-context": ingressActor,
      "x-correlation-id": ingressCorrelationId,
      traceparent: traceparent,
      "idempotency-key": ingressIdempotencyKey,
    },
    payload: body,
  });
  assert.equal(response.statusCode, 201, response.body);
  assert.deepEqual(response.json(), quote);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.headers["x-correlation-id"], ingressCorrelationId);
  const routed = captures[1];
  assert.equal(routed.url, path);
  assert.equal(routed.options.method, "POST");
  assert.equal(routed.options.headers["content-type"], "application/json");
  assert.equal(
    routed.options.headers["x-correlation-id"],
    ingressCorrelationId,
  );
  assert.equal(
    routed.options.headers["idempotency-key"],
    ingressIdempotencyKey,
  );
  assert.deepEqual(JSON.parse(routed.options.body), body);
  const routedClaims = verifyActorContextWithKeySet(
    routed.options.headers["x-actor-context"],
    {
      publicKeys: [keys.publicKey],
      issuer: "api-public",
      audience: "pricing-service",
      nowEpochSeconds: Math.floor(Date.now() / 1_000),
      clockSkewSeconds: 5,
    },
  );
  assert.equal(routedClaims.originalIssuer, "edge-gateway");
  assert.equal(routedClaims.sub, "usr_configured_pricing");
  assert.equal(routedClaims.operationId, "createPricingQuote");
  assert.equal(routedClaims.correlationId, ingressCorrelationId);
  assert.deepEqual(routedClaims.permissions, ["pricing:create"]);

  const grindUnavailable = {
    type: "about:blank",
    title: "Private pricing failure",
    status: 422,
    code: "PRICING_GRIND_NOT_AVAILABLE",
    detail: "PRICING_PRIVATE_DETAIL_CANARY",
    instance: path,
    correlationId: ingressCorrelationId,
    errors: [],
  };
  pricingClient.fetch = async () =>
    new Response(JSON.stringify(grindUnavailable), {
      status: 422,
      headers: { "content-type": "application/problem+json" },
    });
  const unavailableResponse = await app.inject({
    method: "POST",
    url: path,
    headers: {
      "x-actor-context": ingressActor,
      "x-correlation-id": ingressCorrelationId,
      traceparent,
      "idempotency-key": randomUUID(),
    },
    payload: body,
  });
  assert.equal(unavailableResponse.statusCode, 422, unavailableResponse.body);
  assert.equal(unavailableResponse.json().code, "PRICING_GRIND_NOT_AVAILABLE");
  assert.equal(unavailableResponse.json().detail, "pricing request failed");
  assert.equal(unavailableResponse.headers["cache-control"], "no-store");
  assert.equal(
    unavailableResponse.headers["x-correlation-id"],
    ingressCorrelationId,
  );
  assert.doesNotMatch(
    unavailableResponse.body,
    /Private pricing failure|PRICING_PRIVATE_DETAIL_CANARY/u,
  );

  for (const invalid422 of [
    { ...grindUnavailable, code: "CATALOG_PRODUCT_NOT_FOUND" },
    { ...grindUnavailable, status: 409 },
  ]) {
    pricingClient.fetch = async () =>
      new Response(JSON.stringify(invalid422), {
        status: 422,
        headers: { "content-type": "application/problem+json" },
      });
    const invalidResponse = await app.inject({
      method: "POST",
      url: path,
      headers: {
        "x-actor-context": ingressActor,
        "x-correlation-id": ingressCorrelationId,
        traceparent,
        "idempotency-key": randomUUID(),
      },
      payload: body,
    });
    assert.equal(invalidResponse.statusCode, 503, invalidResponse.body);
    assert.equal(invalidResponse.json().code, "CATALOG_UNAVAILABLE");
    assert.equal(
      invalidResponse.json().detail,
      "pricing service is unavailable",
    );
    assert.equal(invalidResponse.headers["cache-control"], "no-store");
    assert.equal(
      invalidResponse.headers["x-correlation-id"],
      ingressCorrelationId,
    );
    assert.doesNotMatch(
      invalidResponse.body,
      /Private pricing failure|PRICING_PRIVATE_DETAIL_CANARY/u,
    );
  }

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
  pricingClient.fetch = async (url, options) => {
    captures.push({ url, options });
    return new Response(
      JSON.stringify({
        type: "about:blank",
        title: "Private pricing failure",
        status: 409,
        code: "OTHER",
        detail: "pricing-upstream-secret",
        instance: path,
        correlationId: ingressCorrelationId,
        errors: [],
      }),
      {
        status: 409,
        headers: { "content-type": "application/problem+json" },
      },
    );
  };
  const failedRoute = await app.inject({
    method: "POST",
    url: path,
    headers: {
      "x-actor-context": ingressActor,
      "x-correlation-id": ingressCorrelationId,
      traceparent,
      "idempotency-key": randomUUID(),
    },
    payload: body,
  });
  assert.equal(failedRoute.statusCode, 503);
  assert.equal(failedRoute.json().code, "CATALOG_UNAVAILABLE");
  assert.equal(failedRoute.json().detail, "pricing service is unavailable");
  assert.equal(failedRoute.body.includes("pricing-upstream-secret"), false);
  assert.equal(failedRoute.body.includes("Private pricing failure"), false);
  const failedOwnerCall = captures[2];
  assert.equal(failedOwnerCall.url, path);
  const failedDelegation = verifyActorContextWithKeySet(
    failedOwnerCall.options.headers["x-actor-context"],
    {
      publicKeys: [keys.publicKey],
      issuer: "api-public",
      audience: "pricing-service",
      nowEpochSeconds: Math.floor(Date.now() / 1_000),
      clockSkewSeconds: 5,
    },
  );
  assert.equal(failedDelegation.operationId, "createPricingQuote");
  assert.equal(failedDelegation.sub, "usr_configured_pricing");
  assert.equal(failedDelegation.correlationId, ingressCorrelationId);
  assert.deepEqual(failedDelegation.permissions, ["pricing:create"]);
});

void test("public configured and unavailable adapters fail closed without scoped credentials", async () => {
  const key = generateKeyPairSync("ed25519");
  const publicPem = key.publicKey.export({ type: "spki", format: "pem" });
  const context = {
    config: {
      environment: "development",
      services: { "api-public": { outbound: ["pricing-service:4103"] } },
    },
    secrets: { security: {} },
  };
  assert.throws(
    () =>
      createConfiguredPublicAdapters(context, {
        fetch: async () => {
          throw new Error("must not fetch");
        },
      }),
    /PUBLIC_API_DELEGATION_KEY_NOT_CONFIGURED/u,
  );
  assert.throws(
    () =>
      createConfiguredPublicAdapters(
        {
          ...context,
          secrets: {
            security: { apiPublicDelegationSigningPrivateKey: "not-a-key" },
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
  const noSigningKey = {
    ...context,
    secrets: {
      security: {
        actorContextEdgeVerificationPublicKeys: {
          active: publicPem,
          previous: publicPem,
        },
      },
    },
  };
  assert.throws(
    () =>
      createConfiguredPublicAdapters(noSigningKey, {
        fetch: async () => {
          throw new Error("must not fetch");
        },
      }),
    /PUBLIC_API_DELEGATION_KEY_NOT_CONFIGURED/u,
  );
  const noActorKeys = {
    ...noSigningKey,
    secrets: {
      security: {
        apiPublicDelegationSigningPrivateKey: key.privateKey.export({
          type: "pkcs8",
          format: "pem",
        }),
      },
    },
  };
  assert.throws(
    () =>
      createConfiguredPublicAdapters(noActorKeys, {
        fetch: async () => {
          throw new Error("must not fetch");
        },
      }),
    /PUBLIC_API_ACTOR_VERIFICATION_KEYS_NOT_CONFIGURED/u,
  );
  const unavailable = createUnavailablePublicAdapters();
  assert.equal(unavailable.verifyTransport({}, "edge-nginx"), false);
  await assert.rejects(
    unavailable.pricing.create(body, {
      actor: actor("createPricingQuote"),
      context: {
        correlationId: randomUUID(),
        signal: new AbortController().signal,
      },
      idempotencyKey: randomUUID(),
      replayOnly: false,
    }),
    /PUBLIC_API_PRICING_CLIENT_NOT_CONFIGURED/u,
  );
});
