import assert from "node:assert/strict";
import {generateKeyPairSync} from "node:crypto";
import test from "node:test";
import {createHttpAromaCartClient, registerInternalRoutes} from "../../apps/api-internal/dist/index.js";
import {registerAromaMutationRoutes} from "../../apps/aroma-gateway/dist/transport/http/index.js";
import {createRuntime} from "../../packages/platform-runtime/dist/index.js";
import {signServiceDelegation} from "../../packages/platform-security/dist/index.js";

const offerRef = "off_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const operationRef = "op_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ack = {operationRef, cartScopeRef: "aroma-primary", offerRef, state: "Acknowledged"};
const context = {correlationId: "corr-mutation", signal: new AbortController().signal};
const setBody = {operationRef, cartScopeRef: "aroma-primary", quantity: "3"};
const removeBody = {operationRef, cartScopeRef: "aroma-primary"};
const selectedGrindKeyHash = "a".repeat(64);

void test("typed internal cart client forwards exact set/remove operation URLs and JSON", async () => {
  const calls = [];
  const client = createHttpAromaCartClient({fetch: async (path, options) => {
    calls.push({path, options});
    return new Response(JSON.stringify(ack), {status: 200, headers: {"content-type": "application/json"}});
  }});
  assert.deepEqual(await client.setQuantity(offerRef, setBody, context, "signed-set"), {status: 200, body: ack});
  assert.deepEqual(await client.remove(offerRef, removeBody, context, "signed-remove"), {status: 200, body: ack});
  const selectedSetBody = {...setBody, sourceGrindKeyHash: selectedGrindKeyHash};
  const selectedRemoveBody = {...removeBody, sourceGrindKeyHash: selectedGrindKeyHash};
  await client.setQuantity(offerRef, selectedSetBody, context, "signed-selected-set");
  await client.remove(offerRef, selectedRemoveBody, context, "signed-selected-remove");
  assert.deepEqual(calls.map(call => call.path), [
    `/api/internal-v1/aroma/cart-lines/${offerRef}:set-quantity`,
    `/api/internal-v1/aroma/cart-lines/${offerRef}:remove`,
    `/api/internal-v1/aroma/cart-lines/${offerRef}:set-quantity`,
    `/api/internal-v1/aroma/cart-lines/${offerRef}:remove`,
  ]);
  assert.deepEqual(calls.map(call => call.options.method), ["POST", "POST", "POST", "POST"]);
  assert.deepEqual(JSON.parse(calls[0].options.body), setBody);
  assert.deepEqual(JSON.parse(calls[1].options.body), removeBody);
  assert.deepEqual(JSON.parse(calls[2].options.body), selectedSetBody);
  assert.deepEqual(JSON.parse(calls[3].options.body), selectedRemoveBody);
  assert.equal(calls[0].options.headers["x-service-delegation"], "signed-set");
  assert.equal(calls[1].options.headers["x-service-delegation"], "signed-remove");
  assert.equal(calls[0].options.headers["x-actor-ref"], undefined);
});

void test("typed internal cart client preserves deterministic Gateway 404", async () => {
  const body = {type: "about:blank", title: "AROMA_CART_ITEM_NOT_FOUND", status: 404, code: "AROMA_CART_ITEM_NOT_FOUND", detail: "Cart line was not present in the fresh provider snapshot", instance: `/api/internal-v1/aroma/cart-lines/${offerRef}:set-quantity`, correlationId: "00000000-0000-4000-8000-000000000000", errors: []};
  const client = createHttpAromaCartClient({fetch: async () => new Response(JSON.stringify(body), {status: 404, headers: {"content-type": "application/problem+json"}})});
  const result = await client.setQuantity(offerRef, setBody, context, "signed-set");
  assert.equal(result.status, 404);
  assert.equal(result.body.code, "AROMA_CART_ITEM_NOT_FOUND");
});

async function runtime(t, state) {
  const app = await createRuntime({name: "gateway-operations-http-test", host: "127.0.0.1", port: 0, shutdownGraceMs: 500, deadlineMs: 15_000, deadlineProfiles: {defaultMs: 15_000}});
  app.addHook("preHandler", async request => {
    request.runtimeContext.transportIdentity = {runtime: "aroma-convergence", environment: "test", san: "spiffe://test/aroma-convergence"};
  });
  registerInternalRoutes(app, {
    verifyTransport: (_request, expected) => expected === "aroma-convergence",
    verifyCallerDelegation: () => { throw new Error("caller delegation must not be used by cart mutation"); },
    signDelegation: ({originalCaller, operationId}) => `signed:${originalCaller}:${operationId}`,
    customer: {orderInput: async () => { throw new Error("not used"); }},
    binding: {register: async () => { throw new Error("not used"); }},
    catalog: {export: async () => { throw new Error("not used"); }},
    cart: {
      read: async () => { throw new Error("not used"); },
      setQuantity: async (receivedOfferRef, body, _context, delegation) => { state.calls.push({kind: "set", receivedOfferRef, body, delegation}); return {status: 200, body: ack}; },
      remove: async (receivedOfferRef, body, _context, delegation) => { state.calls.push({kind: "remove", receivedOfferRef, body, delegation}); return {status: 200, body: ack}; },
    },
  });
  await app.runtimeController.start();
  t.after(() => app.runtimeController.closeRuntime("SIGTERM"));
  return app;
}

void test("internal cart routes forward valid mutations and reject caller identity spoofing before adapter work", async t => {
  const state = {calls: []};
  const app = await runtime(t, state);
  const setResponse = await app.inject({method: "POST", url: `/api/internal-v1/aroma/cart-lines/${offerRef}:set-quantity`, payload: setBody, headers: {"x-correlation-id": "corr-set"}});
  assert.equal(setResponse.statusCode, 200);
  assert.deepEqual(state.calls[0], {kind: "set", receivedOfferRef: offerRef, body: setBody, delegation: "signed:aroma-convergence:setAromaCartLineQuantity"});

  const removeResponse = await app.inject({method: "POST", url: `/api/internal-v1/aroma/cart-lines/${offerRef}:remove`, payload: removeBody});
  assert.equal(removeResponse.statusCode, 200);
  assert.equal(state.calls[1].kind, "remove");
  assert.equal(state.calls.length, 2);

  const decimal = {...setBody, quantity: "0.001234567890123456789"};
  const decimalResponse = await app.inject({method: "POST", url: `/api/internal-v1/aroma/cart-lines/${offerRef}:set-quantity`, payload: decimal});
  assert.equal(decimalResponse.statusCode, 200);
  assert.deepEqual(state.calls[2].body, decimal);

  for (const [url, payload] of [
    [`/api/internal-v1/aroma/cart-lines/${offerRef}:set-quantity`, {...setBody, quantity: 2}],
    [`/api/internal-v1/aroma/cart-lines/${offerRef}:set-quantity`, {...setBody, extra: true}],
    [`/api/internal-v1/aroma/cart-lines/${offerRef}:remove`, {...removeBody, quantity: "1"}],
  ]) {
    const response = await app.inject({method: "POST", url, payload});
    assert.equal(response.statusCode, 400);
  }
  assert.equal(state.calls.length, 3);

  const spoofed = await app.inject({method: "POST", url: `/api/internal-v1/aroma/cart-lines/${offerRef}:set-quantity`, headers: {"x-original-caller": "orders-service"}, payload: setBody});
  assert.equal(spoofed.statusCode, 403);
  assert.equal(spoofed.json().code, "SERVICE_DELEGATION_INVALID");
  assert.equal(state.calls.length, 3);
});

void test("Gateway matches literal-colon mutation URLs and extracts only the public offerRef", async t => {
  const {privateKey, publicKey} = generateKeyPairSync("ed25519");
  const publicPem = publicKey.export({type: "spki", format: "pem"}).toString();
  const app = await createRuntime({name: "gateway-literal-colon-route-test", host: "127.0.0.1", port: 0, shutdownGraceMs: 500, deadlineMs: 15_000, deadlineProfiles: {mutationMs: 15_000}});
  app.addHook("preHandler", async request => {
    request.runtimeContext.transportIdentity = {runtime: "api-internal", environment: "test", san: "spiffe://test/api-internal"};
  });
  const calls = [];
  registerAromaMutationRoutes(app, {execute: async (body, delegation) => {
    calls.push({body, delegation});
    return {state: "Acknowledged", statusCode: 200, responseBodyBytes: Buffer.from(JSON.stringify({...ack, operationRef: body.operationRef, ...(body.sourceGrindKeyHash === undefined ? {} : {sourceGrindKeyHash: body.sourceGrindKeyHash})}))};
  }}, {secrets: {security: {delegationVerificationKeys: {"api-internal": {active: publicPem, previous: publicPem}}}}});
  await app.runtimeController.start();
  t.after(() => app.runtimeController.closeRuntime("SIGTERM"));
  const signed = operationId => {
    const iat = Math.floor(Date.now() / 1000);
    return signServiceDelegation({iss: "api-internal", aud: "aroma-gateway", originalCaller: "aroma-convergence", operationId, correlationId: "corr-gateway-route", traceparent: "00-00000000000000000000000000000000-0000000000000000-00", iat, exp: iat + 60, jti: `jti-${operationId}`, kid: "test"}, privateKey);
  };
  const setResponse = await app.inject({method: "POST", url: `/api/internal-v1/aroma/cart-lines/${offerRef}:set-quantity`, headers: {"x-service-delegation": signed("setAromaCartLineQuantity")}, payload: {...setBody, sourceGrindKeyHash: selectedGrindKeyHash}});
  assert.equal(setResponse.statusCode, 200);
  assert.equal(calls[0].body.offerRef, offerRef);
  assert.equal(calls[0].body.operationKind, "SetLineQuantity");
  assert.equal(calls[0].body.sourceGrindKeyHash, selectedGrindKeyHash);
  const removeResponse = await app.inject({method: "POST", url: `/api/internal-v1/aroma/cart-lines/${offerRef}:remove`, headers: {"x-service-delegation": signed("removeAromaCartLine")}, payload: removeBody});
  assert.equal(removeResponse.statusCode, 200);
  assert.equal(calls[1].body.offerRef, offerRef);
  assert.equal(calls[1].body.operationKind, "RemoveLine");
  const selectedRemove = await app.inject({method: "POST", url: `/api/internal-v1/aroma/cart-lines/${offerRef}:remove`, headers: {"x-service-delegation": signed("removeAromaCartLine")}, payload: {...removeBody, operationRef: "op_01ARZ3NDEKTSV4RRFFQ69G5FAA", sourceGrindKeyHash: selectedGrindKeyHash}});
  assert.equal(selectedRemove.statusCode, 200);
  assert.equal(calls[2].body.sourceGrindKeyHash, selectedGrindKeyHash);
  const beforeInvalid = calls.length;
  const invalidGrind = await app.inject({method: "POST", url: `/api/internal-v1/aroma/cart-lines/${offerRef}:set-quantity`, headers: {"x-service-delegation": signed("setAromaCartLineQuantity")}, payload: {...setBody, sourceGrindKeyHash: "G".repeat(64)}});
  assert.equal(invalidGrind.statusCode, 400);
  assert.equal(calls.length, beforeInvalid);
  for (const payload of [{...setBody, quantity: "2.5"}, {...setBody, quantity: 2}, {...setBody, extra: true}, {...removeBody, quantity: "1"}]) {
    const target = "quantity" in payload && !("extra" in payload) && payload.quantity === "1" ? "remove" : "set-quantity";
    const response = await app.inject({method: "POST", url: `/api/internal-v1/aroma/cart-lines/${offerRef}:${target}`, headers: {"x-service-delegation": signed(target === "remove" ? "removeAromaCartLine" : "setAromaCartLineQuantity")}, payload});
    assert.equal(response.statusCode, 400);
  }
  assert.equal(calls.length, 3);
});
