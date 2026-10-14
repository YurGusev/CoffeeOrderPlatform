import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import test from "node:test";
import {createRuntime} from "../../packages/platform-runtime/src/index.ts";
import {createHttpOrdersClient, registerPublicRoutes} from "../../apps/api-public/dist/index.js";
import {registerOrdersRoutes} from "../../apps/orders-service/dist/http/index.js";

const orderRef = "ord_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const itemRef = "itm_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const customerRef = "cus_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const productRef = "prd_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const variantRef = "var_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const quoteRef = "prq_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const card = {
  orderRef, version: "1", projectionVersion: "1", status: "Draft",
  customer: {customerRef, displayName: "Ada"}, items: [], pricing: null,
  aroma: {state: "NotRequested", desiredRevision: "0", observedRevision: "0", blockers: []},
  allowedActions: ["edit-items", "confirm"],
};
const reconciliation = {orderRef, orderVersion: "1", requestedAt: "2026-09-26T10:00:00Z", aromaState: "PendingObservation"};
const orderBody = {customerRef};
const itemBody = {expectedVersion: "1", productRef, variantRef, quantity: "2", quoteRef, quoteLineNumber: 1, quoteHash: "a".repeat(64)};
const commandBody = {expectedVersion: "1"};
const reconciliationBody = {expectedVersion: "1", reason: "operator requested"};

async function runtime(t, adapters) {
  const app = await createRuntime({name: "orders-public-test", host: "127.0.0.1", port: 0, shutdownGraceMs: 500, deadlineMs: 5_000, deadlineProfiles: {defaultMs: 5_000}});
  registerPublicRoutes(app, adapters);
  await app.runtimeController.start();
  t.after(() => app.runtimeController.closeRuntime("SIGTERM"));
  return app;
}
function fakeAdapters(calls, override = {}) {
  return {
    verifyTransport: () => true,
    verifyActor: (_token, operationId, _signal, correlationId) => ({
      iss: "edge-gateway", aud: "api-public", originalIssuer: "edge-gateway", sub: "usr_test",
      permissions: ({createOrderDraft: ["orders:create"], getOrderCard: ["orders:read:any"], upsertOrderItem: ["orders:edit:any"], removeOrderItem: ["orders:edit:any"], confirmOrder: ["orders:confirm:any"], requestAromaReconciliation: ["orders:reconcile:any"]})[operationId] ?? [], operationId, correlationId,
      traceparent: "00-00000000000000000000000000000000-0000000000000000-00", iat: 1_000, exp: 1_010,
      jti: randomUUID(), kid: "edge-test",
    }),
    customer: {create: async () => { throw new Error("unexpected customer call"); }, search: async () => { throw new Error("unexpected customer call"); }},
    catalog: {search: async () => { throw new Error("unexpected catalog call"); }},
    orders: {forward: async (...args) => { calls.push(args); return {status: args[0] === "createOrderDraft" ? 201 : args[0] === "requestAromaReconciliation" ? 202 : 200, body: args[0] === "requestAromaReconciliation" ? reconciliation : card}; }},
    ...override,
  };
}
function commandHeaders(extra = {}) { return {"x-actor-context": "edge-signed", "idempotency-key": randomUUID(), ...extra}; }

void test("forwards all six client-v1 Orders operations with operation-bound signed actor context", async (t) => {
  const calls = [];
  const app = await runtime(t, fakeAdapters(calls));
  const inputs = [
    {method: "POST", url: "/api/client-v1/orders/drafts", headers: commandHeaders(), payload: orderBody, operation: "createOrderDraft", body: orderBody},
    {method: "PUT", url: `/api/client-v1/orders/${orderRef}/items/${itemRef}`, headers: commandHeaders(), payload: itemBody, operation: "upsertOrderItem", body: itemBody},
    {method: "DELETE", url: `/api/client-v1/orders/${orderRef}/items/${itemRef}`, headers: commandHeaders({"if-match-version": "1"}), operation: "removeOrderItem"},
    {method: "POST", url: `/api/client-v1/orders/${orderRef}/commands/confirm`, headers: commandHeaders(), payload: commandBody, operation: "confirmOrder", body: commandBody},
    {method: "POST", url: `/api/client-v1/orders/${orderRef}/commands/request-aroma-reconciliation`, headers: commandHeaders(), payload: reconciliationBody, operation: "requestAromaReconciliation", body: reconciliationBody},
    {method: "GET", url: `/api/client-v1/orders/${orderRef}`, headers: {"x-actor-context": "edge-signed"}, operation: "getOrderCard"},
  ];
  for (const input of inputs) {
    const {operation, body: _body, ...request} = input;
    const response = await app.inject(request);
    assert.equal(response.statusCode, operation === "createOrderDraft" ? 201 : operation === "requestAromaReconciliation" ? 202 : 200, `${operation}: ${String(response.body)}`);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(response.headers["x-correlation-id"] !== undefined, true);
  }
  assert.deepEqual(calls.map(([operation]) => operation), inputs.map(({operation}) => operation));
  for (const [operation, method, path, body, context] of calls) {
    assert.equal(context.actor.operationId, operation);
    assert.equal(context.actor.permissions.length, 1);
    assert.equal(context.actor.correlationId, context.context.correlationId);
    assert.equal(typeof path, "string");
    assert.equal(typeof method, "string");
    if (operation === "createOrderDraft") assert.deepEqual(body, orderBody);
    if (operation === "upsertOrderItem") assert.deepEqual(body, itemBody);
  }
  assert.equal(calls[2][4].ifMatchVersion, "1");
});

void test("Orders operations require their exact permission before owner calls, including replay-only", async (t) => {
  const cases = [
    {method: "POST", url: "/api/client-v1/orders/drafts", operation: "createOrderDraft", payload: orderBody},
    {method: "GET", url: `/api/client-v1/orders/${orderRef}`, operation: "getOrderCard"},
    {method: "PUT", url: `/api/client-v1/orders/${orderRef}/items/${itemRef}`, operation: "upsertOrderItem", payload: itemBody},
    {method: "DELETE", url: `/api/client-v1/orders/${orderRef}/items/${itemRef}`, operation: "removeOrderItem"},
    {method: "POST", url: `/api/client-v1/orders/${orderRef}/commands/confirm`, operation: "confirmOrder", payload: commandBody},
    {method: "POST", url: `/api/client-v1/orders/${orderRef}/commands/request-aroma-reconciliation`, operation: "requestAromaReconciliation", payload: reconciliationBody},
  ];
  for (const input of cases) {
    for (const permissions of [[], ["pricing:create"]]) {
      const calls = [];
      const app = await runtime(t, fakeAdapters(calls, {verifyActor: (_token, operationId, _signal, correlationId) => ({
        iss: "edge-gateway", aud: "api-public", originalIssuer: "edge-gateway", sub: "usr_test", permissions,
        operationId, correlationId, traceparent: "00-00000000000000000000000000000000-0000000000000000-00",
        iat: 1_000, exp: 1_010, jti: randomUUID(), kid: "edge-test",
      })}));
      const baseHeaders = input.method === "GET" ? {"x-actor-context": "edge-signed"} : commandHeaders(input.operation === "removeOrderItem" ? {"if-match-version": "1"} : {});
      const denied = await app.inject({method: input.method, url: input.url, headers: baseHeaders, ...(input.payload === undefined ? {} : {payload: input.payload})});
      assert.equal(denied.statusCode, 403, `${input.operation} must reject unrelated or absent permission`);
      if (input.method !== "GET") {
        const replay = await app.inject({method: input.method, url: input.url, headers: commandHeaders({"idempotency-replay-only": "true"})});
        assert.equal(replay.statusCode, 403, `${input.operation} replay-only must require current permission`);
      }
      assert.equal(calls.length, 0, `${input.operation} must fail before the owner call`);
    }
  }
});

void test("requires transport and signed operation/correlation actor; rejects malformed refs, keys and replay requests", async (t) => {
  const calls = [];
  const app = await runtime(t, fakeAdapters(calls));
  const noTransport = await runtime(t, fakeAdapters(calls, {verifyTransport: () => false}));
  const url = `/api/client-v1/orders/${orderRef}/commands/confirm`;
  assert.equal((await noTransport.inject({method: "POST", url, headers: commandHeaders(), payload: commandBody})).statusCode, 401);
  const noActor = await app.inject({method: "POST", url, headers: {"idempotency-key": randomUUID()}, payload: commandBody});
  assert.equal(noActor.statusCode, 401);
  const mismatch = await runtime(t, fakeAdapters(calls, {verifyActor: (_token, operationId, _signal, correlationId) => ({iss: "edge-gateway", aud: "api-public", originalIssuer: "edge-gateway", sub: "usr_test", permissions: [], operationId: "getOrderCard", correlationId, iat: 1_000, exp: 1_010, jti: randomUUID(), kid: "test", traceparent: "00-00000000000000000000000000000000-0000000000000000-00"})}));
  assert.equal((await mismatch.inject({method: "POST", url, headers: commandHeaders(), payload: commandBody})).statusCode, 403);
  const invalids = [
    {url: "/api/client-v1/orders/drafts", method: "POST", headers: {...commandHeaders(), "idempotency-key": "not-a-uuid"}, payload: orderBody},
    {url: "/api/client-v1/orders/ord_invalid", method: "GET", headers: {"x-actor-context": "edge-signed"}},
    {url, method: "POST", headers: commandHeaders({"idempotency-replay-only": "false"})},
    {url, method: "POST", headers: commandHeaders({"idempotency-replay-only": "true"}), payload: commandBody},
    {url: `/api/client-v1/orders/${orderRef}/items/${itemRef}`, method: "DELETE", headers: commandHeaders({"if-match-version": "01", "idempotency-replay-only": "true"})},
  ];
  for (const request of invalids) assert.equal((await app.inject(request)).statusCode, 400);
  assert.equal(calls.length, 0);
});

void test("replay-only forwards no body and invalid owner payloads or failures become bounded public problems", async (t) => {
  const calls = [];
  const replayApp = await runtime(t, fakeAdapters(calls));
  const replay = await replayApp.inject({method: "POST", url: "/api/client-v1/orders/drafts", headers: commandHeaders({"idempotency-replay-only": "true"})});
  assert.equal(replay.statusCode, 201);
  assert.equal(calls[0][3], undefined);
  assert.equal(calls[0][4].replayOnly, true);

  const privateCard = {...card, privateProof: "owner-secret"};
  const invalid = await runtime(t, fakeAdapters([], {orders: {forward: async () => ({status: 201, body: privateCard})}}));
  const invalidResponse = await invalid.inject({method: "POST", url: "/api/client-v1/orders/drafts", headers: commandHeaders(), payload: orderBody});
  assert.equal(invalidResponse.statusCode, 503);
  assert.equal(invalidResponse.body.includes("owner-secret"), false);

  const wrongCustomer = await runtime(t, fakeAdapters([], {orders: {forward: async () => ({status: 201, replayed: true, body: {...card, customer: {...card.customer, customerRef: "cus_00000000000000000000000000"}}})}}));
  const wrongCustomerResponse = await wrongCustomer.inject({method: "POST", url: "/api/client-v1/orders/drafts", headers: commandHeaders(), payload: orderBody});
  assert.equal(wrongCustomerResponse.statusCode, 503, "a valid card for another customer must never be forwarded");
  assert.equal(wrongCustomerResponse.json().code, "ORDERS_UNAVAILABLE");
  assert.equal(wrongCustomerResponse.headers["idempotency-replayed"], undefined);

  const wrongOrder = await runtime(t, fakeAdapters([], {orders: {forward: async () => ({status: 200, body: {...card, orderRef: "ord_00000000000000000000000000"}})}}));
  const mismatched = await wrongOrder.inject({method: "GET", url: `/api/client-v1/orders/${orderRef}`, headers: {"x-actor-context": "edge-signed"}});
  assert.equal(mismatched.statusCode, 503, "a valid card from another order must never be forwarded");

  const failed = await runtime(t, fakeAdapters([], {orders: {forward: async () => { throw new Error("orders-private-upstream-detail"); }}}));
  const failure = await failed.inject({method: "POST", url: "/api/client-v1/orders/drafts", headers: commandHeaders(), payload: orderBody});
  assert.equal(failure.statusCode, 503);
  assert.equal(failure.body.includes("orders-private-upstream-detail"), false);
});

void test("mTLS Orders client scopes signed delegation to the exact operation and only forwards allowed headers", async () => {
  const correlationId = randomUUID();
  let observed;
  const client = createHttpOrdersClient({fetch: async (path, options) => {
    observed = {path, options};
    return new Response(JSON.stringify(card), {status: 201, headers: {"content-type": "application/json", "cache-control": "no-store", "x-correlation-id": correlationId, "idempotency-replayed": "true"}});
  }}, (actor, owner, operationId, _context) => {
    assert.equal(owner, "orders-service");
    assert.equal(operationId, "createOrderDraft");
    assert.equal(actor.sub, "usr_test");
    return "scoped-delegation";
  });
  const result = await client.forward("createOrderDraft", "POST", "/api/client-v1/orders/drafts", orderBody, {
    actor: {iss: "edge-gateway", aud: "api-public", originalIssuer: "edge-gateway", sub: "usr_test", permissions: [], operationId: "createOrderDraft", correlationId, traceparent: "00-00000000000000000000000000000000-0000000000000000-00", iat: 1_000, exp: 1_010, jti: randomUUID(), kid: "test"},
    context: {correlationId, signal: new AbortController().signal}, idempotencyKey: randomUUID(), replayOnly: false,
  });
  assert.equal(result.status, 201);
  assert.equal(result.replayed, true);
  assert.equal(observed.options.headers["x-actor-context"], "scoped-delegation");
  assert.equal(observed.options.headers["x-correlation-id"], correlationId);
  assert.equal(observed.options.headers["idempotency-key"].length, 36);
});

async function ownerErrorProxy(t, code) {
  const observed = [];
  const owner = await createRuntime({name: "orders-owner-errors", host: "127.0.0.1", port: 0, shutdownGraceMs: 500, deadlineMs: 5_000, deadlineProfiles: {defaultMs: 5_000}});
  registerOrdersRoutes(owner, {
    verifyTransport: () => true,
    verifyPublicDelegation: (_token, operationId, correlationId) => ({iss: "api-public", aud: "orders-service", originalIssuer: "edge-gateway", sub: "usr_test", permissions: [operationId === "confirmOrder" ? "orders:confirm:any" : "orders:edit:any"], operationId, correlationId}),
    signInternalDelegation: () => "fixture-delegation",
    owner: {
      store: {precheck: async () => ({kind: "proceed"}), getCard: async () => card,
        putItem: async () => { throw Object.assign(new Error("private owner cause"), {code}); },
        confirm: async () => { throw Object.assign(new Error("private owner cause"), {code}); }},
      pricing: {verify: async () => ({valid: true, quoteRef, policyVersionRef: "pvr_01ARZ3NDEKTSV4RRFFQ69G5FAV", catalogSnapshotRevision: "1", customerRef,
        expiresAt: new Date(Date.now() + 60_000).toISOString(), currency: "RUB",
        line: {lineNumber: 1, productRef, variantRef, productDisplayName: "Coffee", offerRef: "off_01ARZ3NDEKTSV4RRFFQ69G5FAV", mappingRevision: "1", quantity: "2", unit: "piece", supplierUnitMinor: "100", unitMinor: "150", lineTotalMinor: "300", currency: "RUB", internalProofHash: "b".repeat(64)}})},
    },
  });
  await owner.runtimeController.start();
  t.after(() => owner.runtimeController.closeRuntime("SIGTERM"));
  const client = createHttpOrdersClient({fetch: async (path, options) => {
    const response = await owner.inject({method: options.method, url: path, headers: options.headers, payload: options.body});
    observed.push({status: response.statusCode, code: response.json().code});
    return new Response(response.body, {status: response.statusCode, headers: {
      "content-type": String(response.headers["content-type"] ?? ""),
      "cache-control": String(response.headers["cache-control"] ?? ""),
      "x-correlation-id": String(response.headers["x-correlation-id"] ?? ""),
    }});
  }}, () => "fixture-delegation");
  return {observed, forward: client.forward};
}

void test("four typed owner failures cross api-public with exact HTTP status/code pairs", async (t) => {
  const cases = [
    {code: "ORDER_EMPTY", status: 422, method: "POST", url: `/api/client-v1/orders/${orderRef}/commands/confirm`, payload: commandBody},
    {code: "ORDER_DESIRED_OVERFLOW", status: 422, method: "POST", url: `/api/client-v1/orders/${orderRef}/commands/confirm`, payload: commandBody},
    {code: "ORDER_ITEM_LIMIT_EXCEEDED", status: 409, method: "PUT", url: `/api/client-v1/orders/${orderRef}/items/${itemRef}`, payload: itemBody},
    {code: "ORDER_QUOTE_SCOPE_MISMATCH", status: 409, method: "PUT", url: `/api/client-v1/orders/${orderRef}/items/${itemRef}`, payload: itemBody},
  ];
  for (const scenario of cases) {
    const owner = await ownerErrorProxy(t, scenario.code);
    const app = await runtime(t, fakeAdapters([], {orders: owner}));
    const response = await app.inject({method: scenario.method, url: scenario.url, headers: commandHeaders(), payload: scenario.payload});
    assert.deepEqual(owner.observed.at(-1), {status: scenario.status, code: scenario.code}, `${scenario.code}: owner status/code`);
    assert.equal(response.statusCode, scenario.status, `${scenario.code}: public status`);
    assert.equal(response.json().code, scenario.code, `${scenario.code}: public code`);
    assert.equal(response.headers["idempotency-replayed"], undefined);
    assert.equal(response.body.includes("private owner cause"), false);
  }
});

void test("api-public rejects typed Orders errors with an invalid status or operation", async (t) => {
  const cases = [
    {code: "ORDER_EMPTY", status: 409, method: "POST", url: `/api/client-v1/orders/${orderRef}/commands/confirm`, payload: commandBody},
    {code: "ORDER_DESIRED_OVERFLOW", status: 409, method: "POST", url: `/api/client-v1/orders/${orderRef}/commands/confirm`, payload: commandBody},
    {code: "ORDER_ITEM_LIMIT_EXCEEDED", status: 422, method: "PUT", url: `/api/client-v1/orders/${orderRef}/items/${itemRef}`, payload: itemBody},
    {code: "ORDER_QUOTE_SCOPE_MISMATCH", status: 422, method: "PUT", url: `/api/client-v1/orders/${orderRef}/items/${itemRef}`, payload: itemBody},
    {code: "ORDER_ITEM_LIMIT_EXCEEDED", status: 409, method: "POST", url: `/api/client-v1/orders/${orderRef}/commands/confirm`, payload: commandBody},
  ];
  for (const scenario of cases) {
    const body = {type: "about:blank", title: scenario.code, status: scenario.status, code: scenario.code, detail: "private owner cause", instance: "/api/client-v1/orders", correlationId: randomUUID(), errors: []};
    const app = await runtime(t, fakeAdapters([], {orders: {forward: async () => ({status: scenario.status, body, replayed: true})}}));
    const response = await app.inject({method: scenario.method, url: scenario.url, headers: commandHeaders(), payload: scenario.payload});
    assert.equal(response.statusCode, 503, `${scenario.code}: wrong owner response must fail closed`);
    assert.equal(response.json().code, "ORDERS_UNAVAILABLE");
    assert.equal(response.headers["idempotency-replayed"], undefined);
    assert.equal(response.body.includes("private owner cause"), false);
  }
});
