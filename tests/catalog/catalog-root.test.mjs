import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import test from "node:test";
import { createRuntime } from "../../packages/platform-runtime/dist/index.js";
import {
  signActorContext,
  verifyActorContextWithKeySet,
} from "../../packages/platform-security/dist/index.js";
import {
  createConfiguredPublicAdapters,
  createHttpCatalogClient,
  registerPublicRoutes,
} from "../../apps/api-public/dist/index.js";
import {
  createHttpCatalogPricingClient,
  registerInternalRoutes,
} from "../../apps/api-internal/dist/index.js";

const productRef = "prd_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const variantRef = "var_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const searchResponse = {
  snapshotRevision: "17",
  items: [
    {
      productRef,
      variantRef,
      displayName: "Coffee Arabica",
      unit: "gram",
      availability: "Available",
      mappingAvailable: true,
      imageUrl: "https://catalog.example.test/coffee.png",
    },
  ],
  nextCursor: null,
};
const pricingInput = {
  productRef,
  variantRef,
  offerRef: "off_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  snapshotRevision: "17",
  supplierUnitMinor: "1200",
  currency: "RUB",
  unit: "gram",
  availability: "Available",
  mappingRevision: "2",
  displayName: "Coffee Arabica",
};
const problem404 = {
  type: "about:blank",
  title: "CATALOG_PRODUCT_NOT_FOUND",
  status: 404,
  code: "CATALOG_PRODUCT_NOT_FOUND",
  detail: "Catalog product does not exist",
  instance: "/api/internal-v1/catalog/products",
  correlationId: "11111111-1111-4111-8111-111111111111",
  errors: [],
};

async function runtime(t, register, transportCaller) {
  const app = await createRuntime({
    name: "catalog-root-test",
    host: "127.0.0.1",
    port: 0,
    shutdownGraceMs: 500,
    deadlineMs: 5_000,
    deadlineProfiles: { defaultMs: 5_000 },
  });
  if (transportCaller !== null)
    app.addHook("preHandler", async (request) => {
      request.runtimeContext.transportIdentity = {
        runtime: transportCaller,
        environment: "test",
        san: `spiffe://test/${transportCaller}`,
      };
    });
  register(app);
  await app.runtimeController.start();
  t.after(() => app.runtimeController.closeRuntime("SIGTERM"));
  return app;
}

function publicAdapters(state) {
  return {
    verifyTransport: (request, caller) =>
      caller === "edge-nginx" &&
      request.runtimeContext?.transportIdentity?.runtime === caller,
    verifyActor: (_token, operationId) =>
      state.actor ?? {
        iss: "edge-gateway",
        aud: "api-public",
        originalIssuer: "edge-gateway",
        sub: "usr_test",
        permissions: ["catalog:read"],
        operationId,
      },
    customer: {
      create: async () => {
        throw new Error("unexpected customer work");
      },
      search: async () => {
        throw new Error("unexpected customer work");
      },
    },
    catalog: {
      search: async (query, input) => {
        state.search = { query, claims: input.actor };
        return state.result ?? { status: 200, body: searchResponse };
      },
    },
  };
}

function internalAdapters(state) {
  return {
    verifyTransport: (request, caller) =>
      request.runtimeContext?.transportIdentity?.runtime === caller,
    verifyCallerDelegation: (token, _request, operationId) => {
      state.incomingToken = token;
      state.verificationCalls = (state.verificationCalls ?? 0) + 1;
      return (
        state.claims ?? {
          iss: "pricing-service",
          aud: "api-internal",
          originalCaller: "pricing-service",
          operationId,
        }
      );
    },
    signDelegation: (claims) => {
      state.outgoing = claims;
      return "signed-api-internal-to-catalog";
    },
    customer: {
      orderInput: async () => {
        throw new Error("unexpected customer work");
      },
    },
    binding: {
      register: async () => {
        throw new Error("unexpected binding work");
      },
    },
    catalog: {
      export: async () => {
        throw new Error("unexpected aroma catalog work");
      },
      pricingInput: async (product, variant, context, delegation) => {
        state.forwarded = {
          product,
          variant,
          correlationId: context.correlationId,
          delegation,
        };
        return state.result ?? { status: 200, body: pricingInput };
      },
    },
    cart: {
      read: async () => {
        throw new Error("unexpected cart work");
      },
      setQuantity: async () => {
        throw new Error("unexpected cart work");
      },
      remove: async () => {
        throw new Error("unexpected cart work");
      },
    },
  };
}

void test("public Catalog route validates actor/query, forwards to owner, and returns only typed response", async (t) => {
  const state = {};
  const app = await runtime(
    t,
    (value) => registerPublicRoutes(value, publicAdapters(state)),
    "edge-nginx",
  );
  const response = await app.inject({
    method: "GET",
    url: "/api/client-v1/catalog/products?query=coffee&availability=Available&limit=5",
    headers: { "x-actor-context": "signed-edge-context" },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), searchResponse);
  assert.equal(state.search.query.query, "coffee");
  assert.equal(state.search.query.availability, "Available");
  assert.equal(state.search.query.limit, 5);
  assert.equal(state.search.claims.operationId, "searchCatalogProducts");
  assert.equal(response.headers["cache-control"], "no-store");
  const browse = await app.inject({
    method: "GET",
    url: "/api/client-v1/catalog/products",
    headers: { "x-actor-context": "signed-edge-context" },
  });
  assert.equal(browse.statusCode, 200);
  assert.equal(state.search.query.query, undefined);
  assert.equal(state.search.query.limit, undefined);
  assert.equal(state.search.claims.operationId, "searchCatalogProducts");
  assert.equal(
    (
      await app.inject({
        method: "GET",
        url: "/api/client-v1/catalog/products?query=coffee&bogus=x",
        headers: { "x-actor-context": "signed-edge-context" },
      })
    ).statusCode,
    400,
  );
  state.actor = {
    iss: "browser",
    aud: "api-public",
    originalIssuer: "edge-gateway",
    sub: "usr_test",
    permissions: ["catalog:read"],
    operationId: "searchCatalogProducts",
  };
  assert.equal(
    (
      await app.inject({
        method: "GET",
        url: "/api/client-v1/catalog/products?query=coffee",
        headers: { "x-actor-context": "forged" },
      })
    ).statusCode,
    403,
  );
  state.actor = undefined;
  state.result = { status: 200, body: { secretPrivateKey: "must-not-leak" } };
  const malformed = await app.inject({
    method: "GET",
    url: "/api/client-v1/catalog/products?query=coffee",
    headers: { "x-actor-context": "signed-edge-context" },
  });
  assert.equal(malformed.statusCode, 503);
  assert.equal(malformed.json().code, "CATALOG_UNAVAILABLE");
  assert.equal(
    JSON.stringify(malformed.json()).includes("must-not-leak"),
    false,
  );
  state.result = { status: 503, body: { ...problem404, status: 503 } };
  assert.equal(
    (
      await app.inject({
        method: "GET",
        url: "/api/client-v1/catalog/products?query=coffee",
        headers: { "x-actor-context": "signed-edge-context" },
      })
    ).json().code,
    "CATALOG_UNAVAILABLE",
  );
  state.result = {
    status: 503,
    body: {
      ...problem404,
      status: 503,
      title: "CATALOG_UNAVAILABLE",
      code: "CATALOG_UNAVAILABLE",
      detail: "private-canary",
    },
  };
  const acceptedError = await app.inject({
    method: "GET",
    url: "/api/client-v1/catalog/products?query=coffee",
    headers: { "x-actor-context": "signed-edge-context" },
  });
  assert.equal(acceptedError.json().code, "CATALOG_UNAVAILABLE");
  assert.equal(
    JSON.stringify(acceptedError.json()).includes("private-canary"),
    false,
  );

  const delegationKeys = generateKeyPairSync("ed25519");
  const edgeKeys = generateKeyPairSync("ed25519");
  const edgePublicKey = edgeKeys.publicKey.export({
    type: "spki",
    format: "pem",
  });
  const configuredContext = {
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
        apiPublicDelegationSigningPrivateKey: delegationKeys.privateKey.export({
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
  const ownerCalls = [];
  let ownerResult = { status: 200, body: searchResponse };
  const configured = createConfiguredPublicAdapters(configuredContext, {
    fetch: async (path, options) => {
      ownerCalls.push({ path, options });
      const problemResponse = ownerResult.status !== 200;
      return new Response(JSON.stringify(ownerResult.body), {
        status: ownerResult.status,
        headers: {
          "content-type": problemResponse
            ? "application/problem+json"
            : "application/json",
        },
      });
    },
  });
  const configuredApp = await runtime(
    t,
    (value) => registerPublicRoutes(value, configured),
    "edge-nginx",
  );
  const traceparent = `00-${randomUUID().replaceAll("-", "")}-${randomUUID().replaceAll("-", "").slice(0, 16)}-01`;
  const issueActor = (correlationId, permissions) => {
    const now = Math.floor(Date.now() / 1_000);
    return signActorContext(
      {
        iss: "edge-gateway",
        aud: "api-public",
        originalIssuer: "edge-gateway",
        sub: "usr_configured_catalog",
        permissions,
        operationId: "searchCatalogProducts",
        correlationId,
        traceparent,
        iat: now,
        exp: now + 45,
        jti: randomUUID(),
        kid: "edge-test",
      },
      edgeKeys.privateKey,
    );
  };
  const requestFor = (correlationId, permissions) => ({
    method: "GET",
    url: "/api/client-v1/catalog/products?query=coffee&availability=Available&limit=5",
    headers: {
      "x-actor-context": issueActor(correlationId, permissions),
      "x-correlation-id": correlationId,
      traceparent,
    },
  });

  const configuredCorrelationId = randomUUID();
  const configuredResponse = await configuredApp.inject(
    requestFor(configuredCorrelationId, ["catalog:read"]),
  );
  assert.equal(configuredResponse.statusCode, 200, configuredResponse.body);
  assert.deepEqual(configuredResponse.json(), searchResponse);
  assert.equal(configuredResponse.headers["cache-control"], "no-store");
  assert.equal(ownerCalls.length, 1);
  const ownerCall = ownerCalls[0];
  assert.equal(
    ownerCall.path,
    "/api/client-v1/catalog/products?query=coffee&availability=Available&limit=5",
  );
  assert.equal(ownerCall.options.method, "GET");
  assert.equal(
    ownerCall.options.headers["x-correlation-id"],
    configuredCorrelationId,
  );
  assert.equal(ownerCall.options.headers.traceparent, traceparent);
  assert.equal(
    ownerCall.options.headers.accept,
    "application/json, application/problem+json",
  );
  const delegation = verifyActorContextWithKeySet(
    ownerCall.options.headers["x-actor-context"],
    {
      publicKeys: [delegationKeys.publicKey],
      issuer: "api-public",
      audience: "catalog-service",
      nowEpochSeconds: Math.floor(Date.now() / 1_000),
      clockSkewSeconds: 5,
    },
  );
  assert.equal(delegation.originalIssuer, "edge-gateway");
  assert.equal(delegation.sub, "usr_configured_catalog");
  assert.equal(delegation.operationId, "searchCatalogProducts");
  assert.equal(delegation.correlationId, configuredCorrelationId);
  assert.equal(delegation.traceparent, traceparent);
  assert.deepEqual(delegation.permissions, ["catalog:read"]);

  const denied = await configuredApp.inject(
    requestFor(randomUUID(), ["orders:read:any"]),
  );
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.json().code, "ACTOR_CONTEXT_INVALID");
  assert.equal(ownerCalls.length, 1);

  const ownerProblem = {
    ...problem404,
    status: 503,
    title: "CATALOG_UNAVAILABLE",
    code: "CATALOG_UNAVAILABLE",
    detail: "owner-private-detail-canary",
    instance: "/private/owner/instance-canary",
    correlationId: randomUUID(),
  };
  ownerResult = { status: 503, body: ownerProblem };
  const failureCorrelationId = randomUUID();
  const failed = await configuredApp.inject(
    requestFor(failureCorrelationId, ["catalog:read"]),
  );
  assert.equal(failed.statusCode, 503);
  assert.match(
    failed.headers["content-type"],
    /^application\/problem\+json(?:;|$)/u,
  );
  assert.equal(failed.headers["cache-control"], "no-store");
  assert.equal(failed.json().code, "CATALOG_UNAVAILABLE");
  assert.equal(failed.json().detail, "catalog request failed");
  assert.equal(failed.json().instance, "/api/client-v1/catalog/products");
  assert.equal(failed.json().correlationId, failureCorrelationId);
  assert.equal(JSON.stringify(failed.json()).includes("owner-private"), false);
  assert.equal(ownerCalls.length, 2);

  const oversizedUrlRequest = requestFor(randomUUID(), ["catalog:read"]);
  oversizedUrlRequest.url += "&".repeat(8 * 1024 + 1);
  const oversizedUrl = await configuredApp.inject(oversizedUrlRequest);
  assert.equal(oversizedUrl.statusCode, 400);
  assert.equal(oversizedUrl.json().code, "VALIDATION_FAILED");
  assert.equal(oversizedUrl.headers["cache-control"], "no-store");
  assert.equal(ownerCalls.length, 2);
});

void test("public Catalog owner client signs delegation, fixes path, and rejects invalid transport DTOs", async () => {
  let call;
  const client = createHttpCatalogClient(
    {
      fetch: async (path, options) => {
        call = { path, options };
        return new Response(JSON.stringify(searchResponse), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    },
    (_actor, owner, operationId) => `delegated:${owner}:${operationId}`,
  );
  const result = await client.search(
    { query: "coffee", limit: 5 },
    {
      actor: { iss: "edge-gateway" },
      context: {
        correlationId: "corr-public",
        signal: new AbortController().signal,
      },
    },
  );
  assert.deepEqual(result, { status: 200, body: searchResponse });
  assert.equal(
    call.path,
    "/api/client-v1/catalog/products?query=coffee&limit=5",
  );
  assert.equal(call.options.method, "GET");
  assert.equal(
    call.options.headers["x-actor-context"],
    "delegated:catalog-service:searchCatalogProducts",
  );
  assert.equal(call.options.headers["x-actor-ref"], undefined);
  await client.search(
    {},
    {
      actor: { iss: "edge-gateway" },
      context: {
        correlationId: "corr-public-browse",
        signal: new AbortController().signal,
      },
    },
  );
  assert.equal(call.path, "/api/client-v1/catalog/products");
  const invalidClient = createHttpCatalogClient(
    {
      fetch: async () =>
        new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    },
    () => "signed",
  );
  await assert.rejects(
    () =>
      invalidClient.search(
        { query: "x" },
        {
          actor: {},
          context: {
            correlationId: "corr",
            signal: new AbortController().signal,
          },
        },
      ),
    /invalid response/u,
  );
  const wrongMedia = createHttpCatalogClient(
    {
      fetch: async () =>
        new Response(JSON.stringify(searchResponse), {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
    },
    () => "signed",
  );
  await assert.rejects(
    () =>
      wrongMedia.search(
        { query: "coffee" },
        {
          actor: {},
          context: {
            correlationId: "corr",
            signal: new AbortController().signal,
          },
        },
      ),
    /media type/u,
  );
});

void test("internal Catalog pricing route requires pricing mTLS and exact delegated caller, then forwards typed owner result", async (t) => {
  const state = {};
  const app = await runtime(
    t,
    (value) => registerInternalRoutes(value, internalAdapters(state)),
    "pricing-service",
  );
  const path = `/api/internal-v1/catalog/products/${productRef}/variants/${variantRef}/pricing-input`;
  const response = await app.inject({
    method: "GET",
    url: path,
    headers: {
      "x-service-delegation": "pricing-signed-token",
      "x-correlation-id": "corr-internal",
    },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), pricingInput);
  assert.equal(state.incomingToken, "pricing-signed-token");
  assert.equal(state.forwarded.product, productRef);
  assert.equal(state.forwarded.variant, variantRef);
  assert.equal(state.forwarded.delegation, "signed-api-internal-to-catalog");
  assert.deepEqual(state.outgoing, {
    originalCaller: "pricing-service",
    operationId: "getCatalogPricingInput",
    context: state.outgoing.context,
  });
  assert.equal(response.headers["cache-control"], "no-store");
  state.claims = {
    iss: "orders-service",
    aud: "api-internal",
    originalCaller: "orders-service",
    operationId: "getCatalogPricingInput",
  };
  assert.equal(
    (
      await app.inject({
        method: "GET",
        url: path,
        headers: { "x-service-delegation": "orders-token" },
      })
    ).statusCode,
    403,
  );
  state.claims = {
    iss: "pricing-service",
    aud: "wrong-audience",
    originalCaller: "pricing-service",
    operationId: "getCatalogPricingInput",
  };
  assert.equal(
    (
      await app.inject({
        method: "GET",
        url: path,
        headers: { "x-service-delegation": "wrong-audience" },
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await app.inject({
        method: "GET",
        url: path,
        headers: {
          "x-service-delegation": "signed",
          "x-original-caller": "orders-service",
        },
      })
    ).statusCode,
    401,
  );
  const wrongTransport = await runtime(
    t,
    (value) => registerInternalRoutes(value, internalAdapters(state)),
    "orders-service",
  );
  assert.equal(
    (
      await wrongTransport.inject({
        method: "GET",
        url: path,
        headers: { "x-service-delegation": "pricing-token" },
      })
    ).statusCode,
    401,
  );
  state.claims = undefined;
  state.result = { status: 404, body: problem404 };
  const missing = await app.inject({
    method: "GET",
    url: path,
    headers: { "x-service-delegation": "pricing-token" },
  });
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().code, "CATALOG_PRODUCT_NOT_FOUND");
  state.result = { status: 503, body: { ...problem404, status: 503 } };
  assert.equal(
    (
      await app.inject({
        method: "GET",
        url: path,
        headers: { "x-service-delegation": "pricing-token" },
      })
    ).json().code,
    "CATALOG_UNAVAILABLE",
  );
  state.result = {
    status: 503,
    body: {
      ...problem404,
      status: 503,
      title: "CATALOG_UNAVAILABLE",
      code: "CATALOG_UNAVAILABLE",
      detail: "private-canary",
    },
  };
  const acceptedError = await app.inject({
    method: "GET",
    url: path,
    headers: { "x-service-delegation": "pricing-token" },
  });
  assert.equal(acceptedError.json().code, "CATALOG_UNAVAILABLE");
  assert.equal(
    JSON.stringify(acceptedError.json()).includes("private-canary"),
    false,
  );
});

void test("internal Catalog pricing route accepts only scoped convergence mTLS without caller delegation", async (t) => {
  const state = {};
  const path = `/api/internal-v1/catalog/products/${productRef}/variants/${variantRef}/pricing-input`;
  const convergence = await runtime(
    t,
    (value) => registerInternalRoutes(value, internalAdapters(state)),
    "aroma-convergence",
  );
  const response = await convergence.inject({ method: "GET", url: path });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(state.outgoing, {
    originalCaller: "aroma-convergence",
    operationId: "getCatalogPricingInput",
    context: state.outgoing.context,
  });
  assert.equal(
    state.verificationCalls,
    undefined,
    "api-internal signs its downstream delegation from the verified transport identity",
  );

  const observer = await runtime(
    t,
    (value) => registerInternalRoutes(value, internalAdapters(state)),
    "aroma-observer",
  );
  assert.equal(
    (await observer.inject({ method: "GET", url: path })).statusCode,
    401,
  );
  const forged = await convergence.inject({
    method: "GET",
    url: path,
    headers: { "x-transport-caller": "aroma-convergence" },
  });
  assert.equal(forged.statusCode, 401);
  const callerDelegation = await convergence.inject({
    method: "GET",
    url: path,
    headers: { "x-service-delegation": "caller-supplied" },
  });
  assert.equal(callerDelegation.statusCode, 403);
  const noCertificate = await runtime(
    t,
    (value) => registerInternalRoutes(value, internalAdapters(state)),
    null,
  );
  assert.equal(
    (await noCertificate.inject({ method: "GET", url: path })).statusCode,
    401,
  );
});

void test("internal Catalog owner client validates status and response schema before accepting DTO", async () => {
  let call;
  const client = createHttpCatalogPricingClient({
    fetch: async (path, options) => {
      call = { path, options };
      return new Response(JSON.stringify(pricingInput), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const result = await client.pricingInput(
    productRef,
    variantRef,
    { correlationId: "corr", signal: new AbortController().signal },
    "signed-service-delegation",
  );
  assert.deepEqual(result, { status: 200, body: pricingInput });
  assert.equal(
    call.path,
    `/api/internal-v1/catalog/products/${productRef}/variants/${variantRef}/pricing-input`,
  );
  assert.equal(call.options.method, "GET");
  assert.equal(
    call.options.headers["x-service-delegation"],
    "signed-service-delegation",
  );
  const invalid = createHttpCatalogPricingClient({
    fetch: async () =>
      new Response(JSON.stringify({ displayName: "bad" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });
  await assert.rejects(
    () =>
      invalid.pricingInput(
        productRef,
        variantRef,
        { correlationId: "corr", signal: new AbortController().signal },
        "signed",
      ),
    /invalid response/u,
  );
  const wrongMedia = createHttpCatalogPricingClient({
    fetch: async () =>
      new Response(JSON.stringify(pricingInput), {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
  });
  await assert.rejects(
    () =>
      wrongMedia.pricingInput(
        productRef,
        variantRef,
        { correlationId: "corr", signal: new AbortController().signal },
        "signed",
      ),
    /media type/u,
  );
});
