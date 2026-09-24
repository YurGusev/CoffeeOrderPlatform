import assert from "node:assert/strict";
import test from "node:test";
import {createRuntime} from "../../packages/platform-runtime/dist/index.js";
import {createHttpCatalogClient, registerPublicRoutes} from "../../apps/api-public/dist/index.js";
import {createHttpCatalogPricingClient, registerInternalRoutes} from "../../apps/api-internal/dist/index.js";

const productRef = "prd_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const variantRef = "var_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const searchResponse = {snapshotRevision: "17", items: [{productRef, variantRef, displayName: "Coffee Arabica", unit: "gram", availability: "Available", mappingAvailable: true, imageUrl: "https://catalog.example.test/coffee.png"}], nextCursor: null};
const pricingInput = {productRef, variantRef, offerRef: "off_01ARZ3NDEKTSV4RRFFQ69G5FAV", snapshotRevision: "17", supplierUnitMinor: "1200", currency: "RUB", unit: "gram", availability: "Available", mappingRevision: "2", displayName: "Coffee Arabica"};
const problem404 = {type: "about:blank", title: "CATALOG_PRODUCT_NOT_FOUND", status: 404, code: "CATALOG_PRODUCT_NOT_FOUND", detail: "Catalog product does not exist", instance: "/api/internal-v1/catalog/products", correlationId: "11111111-1111-4111-8111-111111111111", errors: []};

async function runtime(t, register, transportCaller) {
  const app = await createRuntime({name: "catalog-root-test", host: "127.0.0.1", port: 0, shutdownGraceMs: 500, deadlineMs: 5_000, deadlineProfiles: {defaultMs: 5_000}});
  app.addHook("preHandler", async (request) => { request.runtimeContext.transportIdentity = {runtime: transportCaller, environment: "test", san: `spiffe://test/${transportCaller}`}; });
  register(app);
  await app.runtimeController.start();
  t.after(() => app.runtimeController.closeRuntime("SIGTERM"));
  return app;
}

function publicAdapters(state) {
  return {
    verifyTransport: (_request, caller) => caller === "edge-gateway",
    verifyActor: (_token, operationId) => state.actor ?? {iss: "edge-gateway", aud: "api-public", originalIssuer: "edge-gateway", sub: "usr_test", permissions: ["catalog:read"], operationId},
    customer: {create: async () => { throw new Error("unexpected customer work"); }, search: async () => { throw new Error("unexpected customer work"); }},
    catalog: {search: async (query, input) => { state.search = {query, claims: input.actor}; return state.result ?? {status: 200, body: searchResponse}; }},
  };
}

function internalAdapters(state) {
  return {
    verifyTransport: (request, caller) => request.runtimeContext?.transportIdentity?.runtime === caller,
    verifyCallerDelegation: (token, _request, operationId) => {
      state.incomingToken = token;
      return state.claims ?? {iss: "pricing-service", aud: "api-internal", originalCaller: "pricing-service", operationId};
    },
    signDelegation: (claims) => { state.outgoing = claims; return "signed-api-internal-to-catalog"; },
    customer: {orderInput: async () => { throw new Error("unexpected customer work"); }},
    binding: {register: async () => { throw new Error("unexpected binding work"); }},
    catalog: {
      export: async () => { throw new Error("unexpected aroma catalog work"); },
      pricingInput: async (product, variant, context, delegation) => { state.forwarded = {product, variant, correlationId: context.correlationId, delegation}; return state.result ?? {status: 200, body: pricingInput}; },
    },
    cart: {read: async () => { throw new Error("unexpected cart work"); }, setQuantity: async () => { throw new Error("unexpected cart work"); }, remove: async () => { throw new Error("unexpected cart work"); }},
  };
}

void test("public Catalog route validates actor/query, forwards to owner, and returns only typed response", async (t) => {
  const state = {};
  const app = await runtime(t, (value) => registerPublicRoutes(value, publicAdapters(state)), "edge-gateway");
  const response = await app.inject({method: "GET", url: "/api/client-v1/catalog/products?query=coffee&availability=Available&limit=5", headers: {"x-actor-context": "signed-edge-context"}});
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), searchResponse);
  assert.equal(state.search.query.query, "coffee");
  assert.equal(state.search.query.availability, "Available");
  assert.equal(state.search.query.limit, 5);
  assert.equal(state.search.claims.operationId, "searchCatalogProducts");
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal((await app.inject({method: "GET", url: "/api/client-v1/catalog/products?query=coffee&bogus=x", headers: {"x-actor-context": "signed-edge-context"}})).statusCode, 400);
  state.actor = {iss: "browser", aud: "api-public", originalIssuer: "edge-gateway", sub: "usr_test", permissions: ["catalog:read"], operationId: "searchCatalogProducts"};
  assert.equal((await app.inject({method: "GET", url: "/api/client-v1/catalog/products?query=coffee", headers: {"x-actor-context": "forged"}})).statusCode, 403);
  state.actor = undefined;
  state.result = {status: 200, body: {secretPrivateKey: "must-not-leak"}};
  const malformed = await app.inject({method: "GET", url: "/api/client-v1/catalog/products?query=coffee", headers: {"x-actor-context": "signed-edge-context"}});
  assert.equal(malformed.statusCode, 503);
  assert.equal(malformed.json().code, "CATALOG_UNAVAILABLE");
  assert.equal(JSON.stringify(malformed.json()).includes("must-not-leak"), false);
  state.result = {status: 503, body: {...problem404, status: 503}};
  assert.equal((await app.inject({method: "GET", url: "/api/client-v1/catalog/products?query=coffee", headers: {"x-actor-context": "signed-edge-context"}})).json().code, "CATALOG_UNAVAILABLE");
  state.result = {status: 503, body: {...problem404, status: 503, title: "CATALOG_UNAVAILABLE", code: "CATALOG_UNAVAILABLE", detail: "private-canary"}};
  const acceptedError = await app.inject({method: "GET", url: "/api/client-v1/catalog/products?query=coffee", headers: {"x-actor-context": "signed-edge-context"}});
  assert.equal(acceptedError.json().code, "CATALOG_UNAVAILABLE");
  assert.equal(JSON.stringify(acceptedError.json()).includes("private-canary"), false);
});

void test("public Catalog owner client signs delegation, fixes path, and rejects invalid transport DTOs", async () => {
  let call;
  const client = createHttpCatalogClient({fetch: async (path, options) => { call = {path, options}; return new Response(JSON.stringify(searchResponse), {status: 200, headers: {"content-type": "application/json"}}); }}, (_actor, owner, operationId) => `delegated:${owner}:${operationId}`);
  const result = await client.search({query: "coffee", limit: 5}, {actor: {iss: "edge-gateway"}, context: {correlationId: "corr-public", signal: new AbortController().signal}});
  assert.deepEqual(result, {status: 200, body: searchResponse});
  assert.equal(call.path, "/api/client-v1/catalog/products?query=coffee&limit=5");
  assert.equal(call.options.method, "GET");
  assert.equal(call.options.headers["x-actor-context"], "delegated:catalog-service:searchCatalogProducts");
  assert.equal(call.options.headers["x-actor-ref"], undefined);
  const invalidClient = createHttpCatalogClient({fetch: async () => new Response(JSON.stringify({items: []}), {status: 200, headers: {"content-type": "application/json"}})}, () => "signed");
  await assert.rejects(() => invalidClient.search({query: "x"}, {actor: {}, context: {correlationId: "corr", signal: new AbortController().signal}}), /invalid response/u);
  const wrongMedia = createHttpCatalogClient({fetch: async () => new Response(JSON.stringify(searchResponse), {status: 200, headers: {"content-type": "text/plain"}})}, () => "signed");
  await assert.rejects(() => wrongMedia.search({query: "coffee"}, {actor: {}, context: {correlationId: "corr", signal: new AbortController().signal}}), /media type/u);
});

void test("internal Catalog pricing route requires pricing mTLS and exact delegated caller, then forwards typed owner result", async (t) => {
  const state = {};
  const app = await runtime(t, (value) => registerInternalRoutes(value, internalAdapters(state)), "pricing-service");
  const path = `/api/internal-v1/catalog/products/${productRef}/variants/${variantRef}/pricing-input`;
  const response = await app.inject({method: "GET", url: path, headers: {"x-service-delegation": "pricing-signed-token", "x-correlation-id": "corr-internal"}});
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), pricingInput);
  assert.equal(state.incomingToken, "pricing-signed-token");
  assert.equal(state.forwarded.product, productRef);
  assert.equal(state.forwarded.variant, variantRef);
  assert.equal(state.forwarded.delegation, "signed-api-internal-to-catalog");
  assert.deepEqual(state.outgoing, {originalCaller: "pricing-service", operationId: "getCatalogPricingInput", context: state.outgoing.context});
  assert.equal(response.headers["cache-control"], "no-store");
  state.claims = {iss: "orders-service", aud: "api-internal", originalCaller: "orders-service", operationId: "getCatalogPricingInput"};
  assert.equal((await app.inject({method: "GET", url: path, headers: {"x-service-delegation": "orders-token"}})).statusCode, 403);
  state.claims = {iss: "pricing-service", aud: "wrong-audience", originalCaller: "pricing-service", operationId: "getCatalogPricingInput"};
  assert.equal((await app.inject({method: "GET", url: path, headers: {"x-service-delegation": "wrong-audience"}})).statusCode, 403);
  assert.equal((await app.inject({method: "GET", url: path, headers: {"x-service-delegation": "signed", "x-original-caller": "orders-service"}})).statusCode, 401);
  const wrongTransport = await runtime(t, (value) => registerInternalRoutes(value, internalAdapters(state)), "orders-service");
  assert.equal((await wrongTransport.inject({method: "GET", url: path, headers: {"x-service-delegation": "pricing-token"}})).statusCode, 401);
  state.claims = undefined;
  state.result = {status: 404, body: problem404};
  const missing = await app.inject({method: "GET", url: path, headers: {"x-service-delegation": "pricing-token"}});
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().code, "CATALOG_PRODUCT_NOT_FOUND");
  state.result = {status: 503, body: {...problem404, status: 503}};
  assert.equal((await app.inject({method: "GET", url: path, headers: {"x-service-delegation": "pricing-token"}})).json().code, "CATALOG_UNAVAILABLE");
  state.result = {status: 503, body: {...problem404, status: 503, title: "CATALOG_UNAVAILABLE", code: "CATALOG_UNAVAILABLE", detail: "private-canary"}};
  const acceptedError = await app.inject({method: "GET", url: path, headers: {"x-service-delegation": "pricing-token"}});
  assert.equal(acceptedError.json().code, "CATALOG_UNAVAILABLE");
  assert.equal(JSON.stringify(acceptedError.json()).includes("private-canary"), false);
});

void test("internal Catalog owner client validates status and response schema before accepting DTO", async () => {
  let call;
  const client = createHttpCatalogPricingClient({fetch: async (path, options) => { call = {path, options}; return new Response(JSON.stringify(pricingInput), {status: 200, headers: {"content-type": "application/json"}}); }});
  const result = await client.pricingInput(productRef, variantRef, {correlationId: "corr", signal: new AbortController().signal}, "signed-service-delegation");
  assert.deepEqual(result, {status: 200, body: pricingInput});
  assert.equal(call.path, `/api/internal-v1/catalog/products/${productRef}/variants/${variantRef}/pricing-input`);
  assert.equal(call.options.method, "GET");
  assert.equal(call.options.headers["x-service-delegation"], "signed-service-delegation");
  const invalid = createHttpCatalogPricingClient({fetch: async () => new Response(JSON.stringify({displayName: "bad"}), {status: 200, headers: {"content-type": "application/json"}})});
  await assert.rejects(() => invalid.pricingInput(productRef, variantRef, {correlationId: "corr", signal: new AbortController().signal}, "signed"), /invalid response/u);
  const wrongMedia = createHttpCatalogPricingClient({fetch: async () => new Response(JSON.stringify(pricingInput), {status: 200, headers: {"content-type": "text/plain"}})});
  await assert.rejects(() => wrongMedia.pricingInput(productRef, variantRef, {correlationId: "corr", signal: new AbortController().signal}, "signed"), /media type/u);
});
