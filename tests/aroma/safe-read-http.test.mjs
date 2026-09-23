import assert from "node:assert/strict";
import test from "node:test";
import {ProviderError} from "../../apps/aroma-gateway/dist/domain/provider-errors.js";
import {createRuntime} from "../../packages/platform-runtime/dist/index.js";
import {createHttpAromaCartClient, registerInternalRoutes} from "../../apps/api-internal/dist/index.js";

const requestBody = {cartScopeRef: "aroma-primary"};
const snapshot = {
  cartScopeRef: "aroma-primary",
  providerSnapshotRef: "aroma-gateway:cart-body-sha256:" + "a".repeat(64),
  capturedAt: "2026-09-13T10:00:00Z",
  cartFingerprint: "b".repeat(64),
  lines: [{offerRef: "off_01ARZ3NDEKTSV4RRFFQ69G5FAV", quantity: "1"}],
};

async function runtime(t, caller, adapters) {
  const app = await createRuntime({name: "safe-read-http-test", host: "127.0.0.1", port: 0, shutdownGraceMs: 500, deadlineMs: 15_000, deadlineProfiles: {defaultMs: 15_000}});
  app.addHook("preHandler", async (request) => {
    request.runtimeContext.transportIdentity = {runtime: caller, environment: "test", san: `spiffe://test/${caller}`};
  });
  registerInternalRoutes(app, adapters);
  await app.runtimeController.start();
  t.after(() => app.runtimeController.closeRuntime("SIGTERM"));
  return app;
}

function adapters(callerState) {
  return {
    verifyTransport: (_request, expectedCaller) => callerState.value === expectedCaller,
    verifyCallerDelegation: () => { throw new Error("caller delegation must not be used for safe read"); },
    signDelegation: ({originalCaller, operationId, context}) => {
      callerState.signed = {originalCaller, operationId, correlationId: context.correlationId};
      return `signed:${originalCaller}:${operationId}`;
    },
    customer: {orderInput: async () => { throw new Error("customer adapter must not be used"); }},
    binding: {register: async () => { throw new Error("binding adapter must not be used"); }},
    cart: {read: async (body, context, delegation) => {
      callerState.forwarded = {body, correlationId: context.correlationId, delegation};
      return {status: 200, body: snapshot};
    }},
  };
}

void test("api-internal safe read derives caller from trusted transport and signs exact downstream delegation", async (t) => {
  for (const caller of ["aroma-observer", "aroma-convergence"]) {
    const state = {value: caller};
    const app = await runtime(t, caller, adapters(state));
    const response = await app.inject({method: "POST", url: "/api/internal-v1/aroma/cart-snapshots:read", headers: {"x-correlation-id": "corr-read"}, payload: requestBody});
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), snapshot);
    assert.equal(state.signed.originalCaller, caller);
    assert.equal(state.signed.operationId, "readAromaCartSnapshot");
    assert.equal(typeof state.signed.correlationId, "string");
    assert.deepEqual(state.forwarded.body, requestBody);
    assert.equal(state.forwarded.delegation, `signed:${caller}:readAromaCartSnapshot`);
  }
});

void test("safe read rejects foreign identity, spoofed headers, malformed input, and invalid downstream DTO before provider work", async (t) => {
  const state = {value: "orders-service", calls: 0};
  const adapter = adapters(state);
  adapter.cart.read = async () => { state.calls++; return {status: 200, body: snapshot}; };
  const app = await runtime(t, "aroma-observer", adapter);
  assert.equal((await app.inject({method: "POST", url: "/api/internal-v1/aroma/cart-snapshots:read", payload: requestBody})).statusCode, 401);
  state.value = "aroma-observer";
  assert.equal((await app.inject({method: "POST", url: "/api/internal-v1/aroma/cart-snapshots:read", headers: {"x-service-delegation": "forged"}, payload: requestBody})).statusCode, 403);
  assert.equal((await app.inject({method: "POST", url: "/api/internal-v1/aroma/cart-snapshots:read", payload: {}})).statusCode, 400);
  adapter.cart.read = async () => { state.calls++; return {status: 200, body: {lines: []}}; };
  assert.equal((await app.inject({method: "POST", url: "/api/internal-v1/aroma/cart-snapshots:read", payload: requestBody})).statusCode, 503);
  assert.equal(state.calls, 1);
});

void test("safe read keeps R1/R2 typed provider failures at HTTP 503 instead of returning 200", async (t) => {
  const state = {value: "aroma-observer"};
  const adapter = adapters(state);
  const app = await runtime(t, "aroma-observer", adapter);
  for (const code of ["ProviderCartMappingMissing", "ProviderDecodeInvalid"]) {
    adapter.cart.read = async () => { throw new ProviderError(code); };
    const response = await app.inject({method: "POST", url: "/api/internal-v1/aroma/cart-snapshots:read", payload: requestBody});
    assert.equal(response.statusCode, 503);
    assert.notEqual(response.statusCode, 200);
    assert.equal(response.json().code, "AROMA_PROVIDER_UNAVAILABLE");
  }
});

void test("typed API-internal cart client forwards only the fixed route and bounded JSON", async () => {
  let call;
  const client = createHttpAromaCartClient({fetch: async (path, options) => {
    call = {path, options};
    return new Response(JSON.stringify(snapshot), {status: 200, headers: {"content-type": "application/json"}});
  }});
  const result = await client.read(requestBody, {correlationId: "corr", signal: new AbortController().signal}, "signed");
  assert.deepEqual(result, {status: 200, body: snapshot});
  assert.equal(call.path, "/api/internal-v1/aroma/cart-snapshots:read");
  assert.equal(call.options.method, "POST");
  assert.equal(call.options.headers["x-service-delegation"], "signed");
  assert.equal(call.options.headers["x-actor-ref"], undefined);
});
