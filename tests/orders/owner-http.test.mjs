import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createRuntime } from "../../packages/platform-runtime/dist/index.js";
import { registerOrdersRoutes } from "../../apps/orders-service/dist/http/index.js";
import { createDraft } from "../../apps/orders-service/dist/application/create-draft.js";
import { upsertItem } from "../../apps/orders-service/dist/application/upsert-item.js";
import { deleteItem } from "../../apps/orders-service/dist/application/delete-item.js";
import { confirmOrder } from "../../apps/orders-service/dist/application/confirm-order.js";
import { getOrderCard } from "../../apps/orders-service/dist/application/get-order-card.js";
import { requestAromaReconciliation } from "../../apps/orders-service/dist/application/request-aroma-reconciliation.js";
import { checkInternalApiReady } from "../../apps/orders-service/dist/infrastructure/internal-api-readiness.js";

const orderRef = "ord_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const itemRef = "itm_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const cid = randomUUID();
const card = {
  orderRef,
  version: "1",
  projectionVersion: "1",
  status: "Draft",
  customer: {
    customerRef: "cus_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    displayName: "Ada",
  },
  items: [],
  pricing: null,
  aroma: {
    state: "NotRequested",
    desiredRevision: "1",
    observedRevision: "1",
    blockers: [],
  },
  allowedActions: [],
};
function setup(t, permission = "orders:create", overrides = {}) {
  const calls = [];
  const appPromise = createRuntime({
    name: "orders-http-test",
    host: "127.0.0.1",
    port: 0,
    shutdownGraceMs: 500,
    deadlineMs: 5000,
    deadlineProfiles: { defaultMs: 500 },
  });
  return appPromise.then(async (app) => {
    registerOrdersRoutes(app, {
      verifyTransport:
        overrides.verifyTransport ?? ((_r, c) => c === "api-public"),
      verifyPublicDelegation:
        overrides.verifyPublicDelegation ??
        ((_token, operation) => ({
          iss: "api-public",
          aud: "orders-service",
          originalIssuer: "edge-gateway",
          sub: "actor-a",
          permissions: Array.isArray(permission) ? permission : [permission],
          operationId: operation,
          correlationId: cid,
        })),
      signInternalDelegation: () => "fixture-delegation",
      owner: {
        store: {
          async precheck(...args) {
            calls.push(["precheck", ...args]);
            return overrides.precheckResult ?? { kind: "proceed" };
          },
          async preflightPut(...args) {
            calls.push(["preflightPut", ...args]);
            if (overrides.preflightPutError) throw overrides.preflightPutError;
            return (
              overrides.preflightResult ?? {
                kind: "proceed",
                customerRef: card.customer.customerRef,
              }
            );
          },
          async replay(...args) {
            calls.push(["replay", ...args]);
            return overrides.replayResult ?? { kind: "not_retained" };
          },
          async getCard(...args) {
            calls.push(["getCard", ...args]);
            if (overrides.getCardError) throw overrides.getCardError;
            return overrides.getCardResult ?? card;
          },
          async createDraft(...args) {
            calls.push(["createDraft", ...args]);
            return { status: 201, body: card, replayed: false };
          },
          async putItem(...args) {
            calls.push(["putItem", ...args]);
            return { status: 200, body: card, replayed: false };
          },
          async deleteItem(...args) {
            calls.push(["deleteItem", ...args]);
            if (overrides.deleteItemError) throw overrides.deleteItemError;
            return { status: 200, body: card, replayed: false };
          },
          async confirm(...args) {
            calls.push(["confirm", ...args]);
            if (overrides.confirmError) throw overrides.confirmError;
            return (
              overrides.confirmResult ?? {
                status: 200,
                body: card,
                replayed: false,
              }
            );
          },
          async requestReconciliation(...args) {
            calls.push(["requestReconciliation", ...args]);
            if (overrides.requestReconciliationResult)
              return overrides.requestReconciliationResult;
            throw Object.assign(new Error("no owner-local projection"), {
              code: "AROMA_RECONCILIATION_NOT_ALLOWED",
            });
          },
        },
        customer: {
          async getOrderInput(...args) {
            calls.push(["customer", ...args]);
            if (overrides.customerError) throw overrides.customerError;
            return {
              customerRef: card.customer.customerRef,
              customerVersion: "1",
              displayName: "Ada",
              state: overrides.customerState ?? "Active",
            };
          },
        },
        pricing: {
          async verify(...args) {
            calls.push(["pricing", ...args]);
            if (overrides.pricingResult) return overrides.pricingResult;
            throw new Error("unexpected");
          },
        },
      },
    });
    await app.runtimeController.start();
    t.after(() => app.runtimeController.closeRuntime("SIGTERM"));
    return { app, calls };
  });
}
const headers = () => ({
  "x-correlation-id": cid,
  "x-actor-context": "signed",
  "idempotency-key": randomUUID(),
});
void test("Orders readiness fails closed when required InternalApi is down and recovers", async (t) => {
  let reachable = false;
  let status = 503;
  const requests = [];
  const client = {
    async fetch(path, options) {
      requests.push({
        path,
        method: options.method,
        signal: options.signal,
        redirect: options.redirect,
      });
      if (!reachable) throw new Error("INTERNAL_API_DOWN");
      return new Response("ok", { status });
    },
  };
  const app = await createRuntime({
    name: "orders-internal-api-readiness",
    host: "127.0.0.1",
    port: 0,
    shutdownGraceMs: 500,
    deadlineMs: 5000,
    readinessChecks: [
      {
        name: "orders-internal-api",
        check: (signal) => checkInternalApiReady(client, signal),
      },
    ],
  });
  await app.runtimeController.start();
  t.after(() => app.runtimeController.closeRuntime("SIGTERM"));
  assert.equal((await app.inject("/health/ready")).statusCode, 503);
  reachable = true;
  assert.equal((await app.inject("/health/ready")).statusCode, 503);
  status = 200;
  assert.equal((await app.inject("/health/ready")).statusCode, 200);
  assert.ok(requests.length >= 3);
  assert.ok(
    requests.every(
      (request) =>
        request.path === "/health/ready" &&
        request.method === "GET" &&
        request.redirect === "error" &&
        request.signal instanceof AbortSignal,
    ),
  );
});
void test("six application workflows run without Fastify and preserve the owner call boundary", async () => {
  const calls = [];
  const context = {
    actorRef: "actor-a",
    permissions: ["orders:create", "orders:edit:any", "orders:confirm:any"],
    identity: { actorRef: "actor-a", scope: "a".repeat(64), key: randomUUID() },
    correlationId: cid,
    signal: new AbortController().signal,
    deadlineUtc: null,
    replayOnly: false,
  };
  const store = {
    async precheck() {
      calls.push("precheck");
      return { kind: "proceed" };
    },
    async preflightPut() {
      calls.push("preflightPut");
      return { kind: "proceed", customerRef: card.customer.customerRef };
    },
    async replay() {
      calls.push("replay");
      return { kind: "not_retained" };
    },
    async getCard() {
      calls.push("getCard");
      return card;
    },
    async createDraft() {
      calls.push("createDraft");
      return { status: 201, body: card, replayed: false };
    },
    async putItem() {
      calls.push("putItem");
      return { status: 200, body: card, replayed: false };
    },
    async deleteItem() {
      calls.push("deleteItem");
      return { status: 200, body: card, replayed: false };
    },
    async confirm() {
      calls.push("confirm");
      return { status: 200, body: card, replayed: false };
    },
    async requestReconciliation() {
      calls.push("requestReconciliation");
      return {
        status: 202,
        body: {
          orderRef,
          orderVersion: "2",
          requestedAt: "2026-09-27T00:00:00Z",
          aromaState: "PendingObservation",
        },
        replayed: false,
      };
    },
  };
  const customer = {
    async getOrderInput() {
      calls.push("customer");
      return {
        customerRef: card.customer.customerRef,
        customerVersion: "1",
        displayName: "Ada",
        state: "Active",
      };
    },
  };
  const line = {
    lineNumber: 1,
    productRef: "prd_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    variantRef: "var_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    productDisplayName: "Coffee",
    offerRef: "off_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    mappingRevision: "1",
    quantity: "2",
    unit: "piece",
    supplierUnitMinor: "100",
    unitMinor: "150",
    lineTotalMinor: "300",
    currency: "RUB",
    internalProofHash: "b".repeat(64),
  };
  const quoteRef = "prq_01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const pricing = {
    async verify() {
      calls.push("pricing");
      return {
        valid: true,
        quoteRef,
        policyVersionRef: "pvr_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        catalogSnapshotRevision: "1",
        customerRef: card.customer.customerRef,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        currency: "RUB",
        line,
      };
    },
  };
  const signInternalDelegation = () => "fixture-delegation";
  assert.equal(
    (
      await createDraft(
        { store, customer, signInternalDelegation },
        { ...context, customerRef: card.customer.customerRef },
      )
    ).status,
    201,
  );
  assert.deepEqual(calls, ["precheck", "customer", "createDraft"]);
  calls.length = 0;
  const request = {
    expectedVersion: "1",
    productRef: line.productRef,
    variantRef: line.variantRef,
    quantity: line.quantity,
    quoteRef,
    quoteLineNumber: 1,
    quoteHash: "a".repeat(64),
  };
  assert.equal(
    (
      await upsertItem(
        { store, pricing, signInternalDelegation },
        { ...context, orderRef, itemRef, request },
      )
    ).status,
    200,
  );
  assert.deepEqual(calls, ["preflightPut", "pricing", "putItem"]);
  calls.length = 0;
  assert.equal(
    (
      await deleteItem(store, {
        ...context,
        orderRef,
        itemRef,
        expectedVersion: "1",
      })
    ).status,
    200,
  );
  assert.deepEqual(calls, ["precheck", "deleteItem"]);
  calls.length = 0;
  assert.equal(
    (await confirmOrder(store, { ...context, orderRef, expectedVersion: "1" }))
      .status,
    200,
  );
  assert.deepEqual(calls, ["precheck", "confirm"]);
  calls.length = 0;
  assert.equal(
    (
      await getOrderCard(store, {
        orderRef,
        permissions: context.permissions,
        correlationId: cid,
        signal: context.signal,
      })
    ).orderRef,
    orderRef,
  );
  assert.deepEqual(calls, ["getCard"]);
  calls.length = 0;
  assert.equal(
    (
      await requestAromaReconciliation(store, {
        ...context,
        orderRef,
        expectedVersion: "1",
        reason: "operator-request",
      })
    ).status,
    202,
  );
  assert.deepEqual(calls, ["precheck", "requestReconciliation"]);
  calls.length = 0;
  assert.equal(
    (
      await confirmOrder(store, {
        ...context,
        replayOnly: true,
        orderRef,
        expectedVersion: undefined,
      })
    ).kind,
    "not_retained",
  );
  assert.deepEqual(calls, ["replay"]);
});
void test("orders owner independently authorizes before create precheck and Customer read", async (t) => {
  const rejectedPermission = await setup(t, "orders:read:any");
  const rejected = await rejectedPermission.app.inject({
    method: "POST",
    url: "/api/client-v1/orders/drafts",
    headers: headers(),
    payload: { customerRef: "cus_01ARZ3NDEKTSV4RRFFQ69G5FAV" },
  });
  assert.equal(rejected.statusCode, 403);
  assert.equal(rejectedPermission.calls.length, 0);

  const allowed = await setup(t);
  const request = {
    method: "POST",
    url: "/api/client-v1/orders/drafts",
    payload: { customerRef: "cus_01ARZ3NDEKTSV4RRFFQ69G5FAV" },
  };
  const accepted = await allowed.app.inject({ ...request, headers: headers() });
  assert.equal(accepted.statusCode, 201);
  const callsBeforeSpoofing = allowed.calls.map(([operation]) => operation);
  assert.deepEqual(callsBeforeSpoofing, [
    "precheck",
    "customer",
    "createDraft",
  ]);

  let verifierCalls = 0;
  const invalidDelegation = await setup(t, "orders:create", {
    verifyPublicDelegation() {
      verifierCalls += 1;
      throw new Error("private-verifier-canary");
    },
  });
  const invalid = await invalidDelegation.app.inject({
    ...request,
    headers: headers(),
  });
  assert.equal(invalid.statusCode, 403);
  assert.equal(invalid.json().code, "ACTOR_CONTEXT_INVALID");
  assert.equal(invalid.headers["cache-control"], "no-store");
  assert.doesNotMatch(invalid.body, /private-verifier-canary/);
  assert.equal(verifierCalls, 1);
  assert.deepEqual(invalidDelegation.calls, []);

  for (const [name, value] of [
    ["x-actor-ref", "attacker-actor"],
    ["x-original-caller", "attacker-caller"],
    ["x-service-delegation", "forged-delegation"],
  ]) {
    const response = await allowed.app.inject({
      ...request,
      headers: { ...headers(), [name]: value },
    });
    assert.equal(response.statusCode, 403, name);
    assert.equal(response.json().code, "ACTOR_CONTEXT_INVALID", name);
    assert.equal(response.headers["cache-control"], "no-store", name);
    assert.deepEqual(
      allowed.calls.map(([operation]) => operation),
      callsBeforeSpoofing,
      `${name} must be rejected before owner or upstream work`,
    );
  }
});

void test("owner rejects untrusted transport and missing actor context before any lookup", async (t) => {
  const untrusted = await setup(t, "orders:create", {
    verifyTransport: () => false,
  });
  const request = {
    method: "POST",
    url: "/api/client-v1/orders/drafts",
    payload: { customerRef: card.customer.customerRef },
  };
  const rejected = await untrusted.app.inject({
    ...request,
    headers: headers(),
  });
  assert.equal(rejected.statusCode, 401);
  assert.equal(rejected.json().code, "AUTHENTICATION_REQUIRED");
  assert.deepEqual(untrusted.calls, []);

  const trusted = await setup(t);
  for (const [actor, status, code] of [
    [undefined, 401, "AUTHENTICATION_REQUIRED"],
    ["", 403, "ACTOR_CONTEXT_INVALID"],
  ]) {
    const { "x-actor-context": _, ...rest } = headers();
    const response = await trusted.app.inject({
      ...request,
      headers:
        actor === undefined ? rest : { ...rest, "x-actor-context": actor },
    });
    assert.equal(response.statusCode, status);
    assert.equal(response.json().code, code);
    assert.deepEqual(trusted.calls, []);
  }
});

void test("owner rejects invalid command identity, payload and replay mode before work", async (t) => {
  const { app, calls } = await setup(t, [
    "orders:create",
    "orders:edit:any",
    "orders:confirm:any",
    "orders:reconcile:any",
  ]);
  const routes = [
    {
      method: "POST",
      url: "/api/client-v1/orders/drafts",
      payload: { customerRef: card.customer.customerRef },
    },
    {
      method: "PUT",
      url: `/api/client-v1/orders/${orderRef}/items/${itemRef}`,
      payload: {},
    },
    {
      method: "DELETE",
      url: `/api/client-v1/orders/${orderRef}/items/${itemRef}`,
    },
    {
      method: "POST",
      url: `/api/client-v1/orders/${orderRef}/commands/confirm`,
      payload: { expectedVersion: "1" },
    },
    {
      method: "POST",
      url: `/api/client-v1/orders/${orderRef}/commands/request-aroma-reconciliation`,
      payload: { expectedVersion: "1", reason: "operator-request" },
    },
  ];
  for (const route of routes) {
    const cases = [
      { ...route, headers: { ...headers(), "idempotency-key": "invalid" } },
      {
        ...route,
        headers: { ...headers(), "idempotency-replay-only": "false" },
      },
      { ...route, headers: headers(), payload: {} },
    ];
    if (route.url.includes(orderRef)) {
      cases.push({
        ...route,
        url: route.url.replace(orderRef, "invalid"),
        headers: headers(),
      });
    }
    if (route.url.includes(itemRef)) {
      cases.push({
        ...route,
        url: route.url.replace(itemRef, "invalid"),
        headers: headers(),
      });
    }
    for (const request of cases) {
      const response = await app.inject(request);
      assert.equal(
        response.statusCode,
        400,
        `${request.method} ${request.url}`,
      );
      assert.equal(response.json().code, "VALIDATION_FAILED");
      assert.deepEqual(calls, []);
    }
  }
});

void test("replay-only commands report retained-result failures without mutations", async (t) => {
  for (const [kind, status, code] of [
    ["not_retained", 410, "IDEMPOTENCY_RESULT_NOT_RETAINED"],
    ["in_progress", 409, "IDEMPOTENCY_REQUEST_IN_PROGRESS"],
    ["conflict", 409, "IDEMPOTENCY_CONFLICT"],
    ["invalid", 500, "IDEMPOTENCY_RESULT_INVALID"],
  ]) {
    const { app, calls } = await setup(
      t,
      ["orders:create", "orders:reconcile:any"],
      {
        replayResult: { kind },
      },
    );
    for (const url of [
      "/api/client-v1/orders/drafts",
      `/api/client-v1/orders/${orderRef}/commands/request-aroma-reconciliation`,
    ]) {
      const response = await app.inject({
        method: "POST",
        url,
        headers: { ...headers(), "idempotency-replay-only": "true" },
      });
      assert.equal(response.statusCode, status, kind);
      assert.equal(response.json().code, code);
      assert.equal(response.headers["cache-control"], "no-store");
    }
    assert.deepEqual(
      calls.map(([operation]) => operation),
      ["replay", "replay"],
    );
  }
});

void test("DELETE reports concurrent version conflicts without returning a card", async (t) => {
  const { app, calls } = await setup(t, "orders:edit:any", {
    deleteItemError: Object.assign(new Error("stale"), {
      code: "ORDER_VERSION_CONFLICT",
    }),
  });
  const response = await app.inject({
    method: "DELETE",
    url: `/api/client-v1/orders/${orderRef}/items/${itemRef}`,
    headers: { ...headers(), "if-match-version": "1" },
  });
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().code, "ORDER_VERSION_CONFLICT");
  assert.deepEqual(
    calls.map(([operation]) => operation),
    ["precheck", "deleteItem"],
  );
});
void test("bodyless create replay authorizes first and never calls Customer or command", async (t) => {
  const { app, calls } = await setup(t);
  const response = await app.inject({
    method: "POST",
    url: "/api/client-v1/orders/drafts",
    headers: { ...headers(), "idempotency-replay-only": "true" },
  });
  assert.equal(response.statusCode, 410);
  assert.deepEqual(
    calls.map((x) => x[0]),
    ["replay"],
  );
});
void test("reconciliation returns and replays only the validated stored 202", async (t) => {
  const key = randomUUID();
  const accepted = {
    orderRef,
    orderVersion: "2",
    requestedAt: "2026-10-26T10:00:00Z",
    aromaState: "PendingObservation",
  };
  const initial = await setup(t, "orders:reconcile:any", {
    requestReconciliationResult: {
      status: 202,
      body: accepted,
      replayed: false,
    },
  });
  const command = await initial.app.inject({
    method: "POST",
    url: `/api/client-v1/orders/${orderRef}/commands/request-aroma-reconciliation`,
    headers: { ...headers(), "idempotency-key": key },
    payload: { expectedVersion: "1", reason: "operator-request" },
  });
  assert.equal(command.statusCode, 202);
  assert.deepEqual(command.json(), accepted);
  assert.equal(command.headers["cache-control"], "no-store");
  assert.equal(command.headers["idempotency-replayed"], undefined);
  assert.deepEqual(
    initial.calls.map((x) => x[0]),
    ["precheck", "requestReconciliation"],
  );
  assert.equal(initial.calls[0][1].key, key);
  assert.equal(initial.calls[1][1].identity.key, key);
  assert.equal(initial.calls[1][1].orderRef, orderRef);

  const replay = await setup(t, "orders:reconcile:any", {
    replayResult: {
      kind: "completed",
      response: { status: 202, resourceRef: orderRef, body: accepted },
    },
  });
  const saved = await replay.app.inject({
    method: "POST",
    url: `/api/client-v1/orders/${orderRef}/commands/request-aroma-reconciliation`,
    headers: {
      ...headers(),
      "idempotency-key": key,
      "idempotency-replay-only": "true",
    },
  });
  assert.equal(saved.statusCode, 202);
  assert.deepEqual(saved.json(), accepted);
  assert.equal(saved.headers["cache-control"], "no-store");
  assert.equal(saved.headers["idempotency-replayed"], "true");
  assert.deepEqual(
    replay.calls.map((x) => x[0]),
    ["replay"],
  );
  assert.equal(replay.calls[0][1].key, key);

  for (const invalidCommandResult of [
    {
      status: 200,
      body: accepted,
      replayed: false,
    },
    {
      status: 202,
      body: {
        ...accepted,
        orderRef: "ord_01ARZ3NDEKTSV4RRFFQ69G5FAW",
      },
      replayed: true,
    },
  ]) {
    const invalidCommand = await setup(t, "orders:reconcile:any", {
      requestReconciliationResult: invalidCommandResult,
    });
    const rejectedCommand = await invalidCommand.app.inject({
      method: "POST",
      url: `/api/client-v1/orders/${orderRef}/commands/request-aroma-reconciliation`,
      headers: { ...headers(), "idempotency-key": key },
      payload: { expectedVersion: "1", reason: "operator-request" },
    });
    assert.equal(rejectedCommand.statusCode, 500);
    assert.equal(rejectedCommand.json().code, "INTERNAL_ERROR");
    assert.equal(rejectedCommand.headers["cache-control"], "no-store");
    assert.equal(rejectedCommand.headers["idempotency-replayed"], undefined);
    assert.doesNotMatch(rejectedCommand.body, /FAW|PendingObservation/u);
    assert.deepEqual(
      invalidCommand.calls.map((x) => x[0]),
      ["precheck", "requestReconciliation"],
    );
  }

  for (const response of [
    { status: 200, resourceRef: orderRef, body: accepted },
    {
      status: 202,
      resourceRef: "ord_01ARZ3NDEKTSV4RRFFQ69G5FAW",
      body: accepted,
    },
  ]) {
    const invalid = await setup(t, "orders:reconcile:any", {
      replayResult: { kind: "completed", response },
    });
    const rejected = await invalid.app.inject({
      method: "POST",
      url: `/api/client-v1/orders/${orderRef}/commands/request-aroma-reconciliation`,
      headers: {
        ...headers(),
        "idempotency-key": key,
        "idempotency-replay-only": "true",
      },
    });
    assert.equal(rejected.statusCode, 500);
    assert.equal(rejected.json().code, "IDEMPOTENCY_RESULT_INVALID");
    assert.deepEqual(
      invalid.calls.map((x) => x[0]),
      ["replay"],
    );
  }
});
void test("bodyless DELETE replays the exact stored card without If-Match-Version", async (t) => {
  const saved = { ...card, allowedActions: ["edit-items"] };
  const { app, calls } = await setup(t, "orders:edit:any", {
    replayResult: { kind: "completed", response: { status: 200, body: saved } },
  });
  const response = await app.inject({
    method: "DELETE",
    url: `/api/client-v1/orders/${orderRef}/items/${itemRef}`,
    headers: { ...headers(), "idempotency-replay-only": "true" },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["idempotency-replayed"], "true");
  assert.deepEqual(response.json(), saved);
  assert.deepEqual(
    calls.map((x) => x[0]),
    ["replay"],
  );
});
void test("Card replay rejects a stored status from another command before responding", async (t) => {
  for (const { method, url, permission, wrongStatus } of [
    {
      method: "POST",
      url: "/api/client-v1/orders/drafts",
      permission: "orders:create",
      wrongStatus: 200,
    },
    {
      method: "PUT",
      url: `/api/client-v1/orders/${orderRef}/items/${itemRef}`,
      permission: "orders:edit:any",
      wrongStatus: 201,
    },
    {
      method: "DELETE",
      url: `/api/client-v1/orders/${orderRef}/items/${itemRef}`,
      permission: "orders:edit:any",
      wrongStatus: 201,
    },
    {
      method: "POST",
      url: `/api/client-v1/orders/${orderRef}/commands/confirm`,
      permission: "orders:confirm:any",
      wrongStatus: 201,
    },
  ]) {
    const { app, calls } = await setup(t, permission, {
      replayResult: {
        kind: "completed",
        response: { status: wrongStatus, body: card },
      },
    });
    const response = await app.inject({
      method,
      url,
      headers: { ...headers(), "idempotency-replay-only": "true" },
    });
    assert.equal(response.statusCode, 500, `${method} ${url}`);
    assert.equal(
      response.json().code,
      "IDEMPOTENCY_RESULT_INVALID",
      `${method} ${url}`,
    );
    assert.deepEqual(
      calls.map((x) => x[0]),
      ["replay"],
    );
  }
});
void test("DELETE validates version only for normal commands and rejects replay-only version", async (t) => {
  const { app, calls } = await setup(t, "orders:edit:any");
  const url = `/api/client-v1/orders/${orderRef}/items/${itemRef}`;
  const missing = await app.inject({
    method: "DELETE",
    url,
    headers: headers(),
  });
  assert.equal(missing.statusCode, 400);
  assert.deepEqual(calls, []);
  const replayWithVersion = await app.inject({
    method: "DELETE",
    url,
    headers: {
      ...headers(),
      "idempotency-replay-only": "true",
      "if-match-version": "1",
    },
  });
  assert.equal(replayWithVersion.statusCode, 400);
  assert.deepEqual(calls, []);
  const normal = await app.inject({
    method: "DELETE",
    url,
    headers: { ...headers(), "if-match-version": "1" },
  });
  assert.equal(normal.statusCode, 200);
  assert.deepEqual(
    calls.map((x) => x[0]),
    ["precheck", "deleteItem"],
  );
  assert.equal(calls[1][1].expectedVersion, "1");
});
void test("different actor permission failure cannot reach bodyless replay lookup", async (t) => {
  const { app, calls } = await setup(t, "orders:read:any");
  const response = await app.inject({
    method: "POST",
    url: "/api/client-v1/orders/drafts",
    headers: { ...headers(), "idempotency-replay-only": "true" },
  });
  assert.equal(response.statusCode, 403);
  assert.equal(calls.length, 0);
});

void test("all mutating routes reject missing permission before bodyless replay", async (t) => {
  const { app, calls } = await setup(t, "orders:read:any");
  const base = { ...headers(), "idempotency-replay-only": "true" };
  const requests = [
    { method: "POST", url: "/api/client-v1/orders/drafts", headers: base },
    {
      method: "PUT",
      url: `/api/client-v1/orders/${orderRef}/items/${itemRef}`,
      headers: base,
    },
    {
      method: "DELETE",
      url: `/api/client-v1/orders/${orderRef}/items/${itemRef}`,
      headers: base,
    },
    {
      method: "POST",
      url: `/api/client-v1/orders/${orderRef}/commands/confirm`,
      headers: base,
    },
    {
      method: "POST",
      url: `/api/client-v1/orders/${orderRef}/commands/request-aroma-reconciliation`,
      headers: base,
    },
  ];
  for (const request of requests)
    assert.equal((await app.inject(request)).statusCode, 403, request.url);
  assert.equal(calls.length, 0);
});

void test("draft hash precheck conflict stops before Customer network read", async (t) => {
  const { app, calls } = await setup(t, "orders:create", {
    precheckResult: { kind: "conflict" },
  });
  const response = await app.inject({
    method: "POST",
    url: "/api/client-v1/orders/drafts",
    headers: headers(),
    payload: { customerRef: "cus_01ARZ3NDEKTSV4RRFFQ69G5FAV" },
  });
  assert.equal(response.statusCode, 409);
  assert.deepEqual(
    calls.map((x) => x[0]),
    ["precheck"],
  );
});

void test("inactive and unavailable Customer outcomes stop before the owner command", async (t) => {
  const customerRef = card.customer.customerRef;
  const { app, calls } = await setup(t, "orders:create", {
    customerState: "Inactive",
  });
  const response = await app.inject({
    method: "POST",
    url: "/api/client-v1/orders/drafts",
    headers: headers(),
    payload: { customerRef },
  });

  assert.equal(response.statusCode, 409);
  assert.equal(response.json().code, "CUSTOMER_NOT_ACTIVE");
  assert.deepEqual(
    calls.map(([operation]) => operation),
    ["precheck", "customer"],
  );
  assert.equal(calls[1][1].customerRef, customerRef);
  assert.ok(!calls.some(([operation]) => operation === "createDraft"));

  const unavailable = await setup(t, "orders:create", {
    customerError: Object.assign(new Error("customer-private-canary"), {
      code: "CUSTOMER_UNAVAILABLE",
    }),
  });
  const unavailableResponse = await unavailable.app.inject({
    method: "POST",
    url: "/api/client-v1/orders/drafts",
    headers: headers(),
    payload: { customerRef },
  });
  assert.equal(unavailableResponse.statusCode, 503);
  assert.equal(unavailableResponse.json().code, "CUSTOMER_UNAVAILABLE");
  assert.equal(unavailableResponse.headers["cache-control"], "no-store");
  assert.doesNotMatch(unavailableResponse.body, /customer-private-canary/u);
  assert.deepEqual(
    unavailable.calls.map(([operation]) => operation),
    ["precheck", "customer"],
  );
});

void test("item hash precheck conflict stops before full card read and Pricing network read", async (t) => {
  const { app, calls } = await setup(t, "orders:edit:any", {
    preflightResult: { kind: "conflict" },
  });
  const response = await app.inject({
    method: "PUT",
    url: `/api/client-v1/orders/${orderRef}/items/${itemRef}`,
    headers: headers(),
    payload: {
      expectedVersion: "1",
      productRef: "prd_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      variantRef: "var_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      quantity: "2",
      quoteRef: "prq_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      quoteLineNumber: 1,
      quoteHash: "a".repeat(64),
    },
  });
  assert.equal(response.statusCode, 409);
  assert.deepEqual(
    calls.map((x) => x[0]),
    ["preflightPut"],
  );
});
void test("completed and in-progress PUT preflight stop before Pricing", async (t) => {
  const request = {
    expectedVersion: "1",
    productRef: "prd_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    variantRef: "var_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    quantity: "2",
    quoteRef: "prq_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    quoteLineNumber: 1,
    quoteHash: "a".repeat(64),
  };
  const completed = await setup(t, "orders:edit:any", {
    preflightResult: {
      kind: "completed",
      response: { status: 200, body: card, resourceRef: orderRef },
    },
  });
  const completedResponse = await completed.app.inject({
    method: "PUT",
    url: `/api/client-v1/orders/${orderRef}/items/${itemRef}`,
    headers: headers(),
    payload: request,
  });
  assert.equal(completedResponse.statusCode, 200);
  assert.equal(completedResponse.headers["idempotency-replayed"], "true");
  assert.deepEqual(
    completed.calls.map((x) => x[0]),
    ["preflightPut"],
  );
  const inProgress = await setup(t, "orders:edit:any", {
    preflightResult: { kind: "in_progress" },
  });
  const inProgressResponse = await inProgress.app.inject({
    method: "PUT",
    url: `/api/client-v1/orders/${orderRef}/items/${itemRef}`,
    headers: headers(),
    payload: request,
  });
  assert.equal(inProgressResponse.statusCode, 409);
  assert.equal(
    inProgressResponse.json().code,
    "IDEMPOTENCY_REQUEST_IN_PROGRESS",
  );
  assert.deepEqual(
    inProgress.calls.map((x) => x[0]),
    ["preflightPut"],
  );
});

void test("GET independently requires read permission and performs only the owner read", async (t) => {
  const denied = await setup(t, "orders:create");
  const deniedResponse = await denied.app.inject({
    method: "GET",
    url: `/api/client-v1/orders/${orderRef}`,
    headers: headers(),
  });
  assert.equal(deniedResponse.statusCode, 403);
  assert.equal(denied.calls.length, 0);
  const allowed = await setup(t, "orders:read:any");
  const response = await allowed.app.inject({
    method: "GET",
    url: `/api/client-v1/orders/${orderRef}`,
    headers: headers(),
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(
    allowed.calls.map((x) => x[0]),
    ["getCard"],
  );

  const foreignOrderRef = "ord_01ARZ3NDEKTSV4RRFFQ69G5FAW";
  const foreign = await setup(t, "orders:read:any", {
    getCardResult: { ...card, orderRef: foreignOrderRef },
  });
  const rejected = await foreign.app.inject({
    method: "GET",
    url: `/api/client-v1/orders/${orderRef}`,
    headers: headers(),
  });
  assert.equal(rejected.statusCode, 500);
  assert.equal(rejected.json().code, "INTERNAL_ERROR");
  assert.equal(rejected.headers["cache-control"], "no-store");
  assert.doesNotMatch(rejected.body, new RegExp(foreignOrderRef, "u"));
  assert.deepEqual(
    foreign.calls.map((x) => x[0]),
    ["getCard"],
  );
});

void test("Confirm uses persisted store facts only and makes no Customer or Pricing call", async (t) => {
  const { app, calls } = await setup(t, "orders:confirm:any");
  const response = await app.inject({
    method: "POST",
    url: `/api/client-v1/orders/${orderRef}/commands/confirm`,
    headers: headers(),
    payload: { expectedVersion: "1" },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(
    calls.map((x) => x[0]),
    ["precheck", "confirm"],
  );
});

void test("four owner mutations forward verified current card permissions", async (t) => {
  const granted = ["orders:create", "orders:edit:any", "orders:confirm:any"];
  const line = {
    lineNumber: 1,
    productRef: "prd_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    variantRef: "var_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    productDisplayName: "Coffee",
    offerRef: "off_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    mappingRevision: "1",
    quantity: "2",
    unit: "piece",
    supplierUnitMinor: "100",
    unitMinor: "150",
    lineTotalMinor: "300",
    currency: "RUB",
    internalProofHash: "b".repeat(64),
  };
  const pricingResult = {
    valid: true,
    quoteRef: "prq_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    policyVersionRef: "pvr_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    catalogSnapshotRevision: "1",
    customerRef: card.customer.customerRef,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    currency: "RUB",
    line,
  };
  const { app, calls } = await setup(t, granted, { pricingResult });
  const requests = [
    {
      method: "POST",
      url: "/api/client-v1/orders/drafts",
      headers: headers(),
      payload: { customerRef: card.customer.customerRef },
      command: "createDraft",
    },
    {
      method: "PUT",
      url: `/api/client-v1/orders/${orderRef}/items/${itemRef}`,
      headers: headers(),
      payload: {
        expectedVersion: "1",
        productRef: line.productRef,
        variantRef: line.variantRef,
        quantity: line.quantity,
        quoteRef: pricingResult.quoteRef,
        quoteLineNumber: line.lineNumber,
        quoteHash: "a".repeat(64),
      },
      command: "putItem",
    },
    {
      method: "DELETE",
      url: `/api/client-v1/orders/${orderRef}/items/${itemRef}`,
      headers: { ...headers(), "if-match-version": "1" },
      command: "deleteItem",
    },
    {
      method: "POST",
      url: `/api/client-v1/orders/${orderRef}/commands/confirm`,
      headers: headers(),
      payload: { expectedVersion: "1" },
      command: "confirm",
    },
  ];
  for (const { command, ...request } of requests) {
    const response = await app.inject(request);
    assert.equal(
      response.statusCode,
      command === "createDraft" ? 201 : 200,
      command,
    );
    const call = calls.findLast((x) => x[0] === command);
    assert.ok(call, `${command} must reach owner`);
    assert.deepEqual(call[1].cardPermissions, granted, command);
  }
});
void test("pre-#11 reconciliation refuses without claiming a durable 202", async (t) => {
  const { app, calls } = await setup(t, "orders:reconcile:any");
  const response = await app.inject({
    method: "POST",
    url: `/api/client-v1/orders/${orderRef}/commands/request-aroma-reconciliation`,
    headers: headers(),
    payload: { expectedVersion: "1", reason: "operator-request" },
  });
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().code, "AROMA_RECONCILIATION_NOT_ALLOWED");
  assert.deepEqual(
    calls.map((x) => x[0]),
    ["precheck", "requestReconciliation"],
  );

  const conflicted = await setup(t, "orders:reconcile:any", {
    precheckResult: { kind: "conflict" },
  });
  const conflict = await conflicted.app.inject({
    method: "POST",
    url: `/api/client-v1/orders/${orderRef}/commands/request-aroma-reconciliation`,
    headers: headers(),
    payload: { expectedVersion: "1", reason: "operator-request" },
  });
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().code, "IDEMPOTENCY_CONFLICT");
  assert.deepEqual(
    conflicted.calls.map((x) => x[0]),
    ["precheck"],
    "a conflicting key must stop before the durable reconciliation request",
  );
});

void test("owner errors preserve public Order not-found and optimistic conflict codes", async (t) => {
  const missing = await setup(t, "orders:read:any", {
    getCardError: Object.assign(new Error("missing"), {
      code: "ORDER_NOT_FOUND",
    }),
  });
  const get = await missing.app.inject({
    method: "GET",
    url: `/api/client-v1/orders/${orderRef}`,
    headers: headers(),
  });
  assert.equal(get.statusCode, 404);
  assert.equal(get.json().code, "ORDER_NOT_FOUND");
  const conflict = await setup(t, "orders:confirm:any", {
    confirmError: Object.assign(new Error("stale"), {
      code: "ORDER_VERSION_CONFLICT",
    }),
  });
  const confirm = await conflict.app.inject({
    method: "POST",
    url: `/api/client-v1/orders/${orderRef}/commands/confirm`,
    headers: headers(),
    payload: { expectedVersion: "1" },
  });
  assert.equal(confirm.statusCode, 409);
  assert.equal(confirm.json().code, "ORDER_VERSION_CONFLICT");

  const foreignOrderRef = "ord_01ARZ3NDEKTSV4RRFFQ69G5FAW";
  const mismatched = await setup(t, "orders:confirm:any", {
    confirmResult: {
      status: 200,
      body: {
        ...card,
        orderRef: foreignOrderRef,
        customer: { ...card.customer, displayName: "foreign-card-canary" },
      },
      replayed: false,
    },
  });
  const rejected = await mismatched.app.inject({
    method: "POST",
    url: `/api/client-v1/orders/${orderRef}/commands/confirm`,
    headers: headers(),
    payload: { expectedVersion: "1" },
  });
  assert.equal(rejected.statusCode, 500);
  assert.equal(rejected.json().code, "INTERNAL_ERROR");
  assert.equal(rejected.headers["cache-control"], "no-store");
  assert.doesNotMatch(rejected.body, /foreign-card-canary|G5FAW/u);
  assert.deepEqual(
    mismatched.calls.map(([operation]) => operation),
    ["precheck", "confirm"],
  );
});

void test("selected Pricing line scope mismatch returns the exact code before item persistence", async (t) => {
  const wrongLine = {
    lineNumber: 1,
    productRef: "prd_01ARZ3NDEKTSV4RRFFQ69G5FAY",
    variantRef: "var_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    productDisplayName: "Coffee",
    offerRef: "off_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    mappingRevision: "1",
    quantity: "2",
    unit: "piece",
    supplierUnitMinor: "100",
    unitMinor: "150",
    lineTotalMinor: "300",
    currency: "RUB",
    internalProofHash: "b".repeat(64),
  };
  const pricingResult = {
    valid: true,
    quoteRef: "prq_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    policyVersionRef: "pvr_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    catalogSnapshotRevision: "1",
    customerRef: card.customer.customerRef,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    currency: "RUB",
    line: wrongLine,
  };
  const { app, calls } = await setup(t, "orders:edit:any", { pricingResult });
  const body = {
    expectedVersion: "1",
    productRef: "prd_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    variantRef: wrongLine.variantRef,
    quantity: "2",
    quoteRef: pricingResult.quoteRef,
    quoteLineNumber: 1,
    quoteHash: "a".repeat(64),
  };
  const response = await app.inject({
    method: "PUT",
    url: `/api/client-v1/orders/${orderRef}/items/${itemRef}`,
    headers: headers(),
    payload: body,
  });
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().code, "ORDER_QUOTE_SCOPE_MISMATCH");
  assert.deepEqual(
    calls.map((x) => x[0]),
    ["preflightPut", "pricing"],
  );

  for (const mismatchedIdentity of [
    { customerRef: "cus_01ARZ3NDEKTSV4RRFFQ69G5FAW" },
    { quoteRef: "prq_01ARZ3NDEKTSV4RRFFQ69G5FAW" },
  ]) {
    const foreignPricing = await setup(t, "orders:edit:any", {
      pricingResult: { ...pricingResult, ...mismatchedIdentity },
    });
    const unavailable = await foreignPricing.app.inject({
      method: "PUT",
      url: `/api/client-v1/orders/${orderRef}/items/${itemRef}`,
      headers: headers(),
      payload: body,
    });
    assert.equal(unavailable.statusCode, 503);
    assert.equal(unavailable.json().code, "PRICING_UNAVAILABLE");
    assert.deepEqual(
      foreignPricing.calls.map((x) => x[0]),
      ["preflightPut", "pricing"],
    );
  }
});

void test("aborted PUT preflight maps lookup failure without Pricing or write, while full-card not-found remains 404", async (t) => {
  const request = {
    expectedVersion: "1",
    productRef: "prd_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    variantRef: "var_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    quantity: "2",
    quoteRef: "prq_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    quoteLineNumber: 1,
    quoteHash: "a".repeat(64),
  };
  const lookup = await setup(t, "orders:edit:any", {
    preflightResult: { kind: "lookup_unavailable" },
  });
  const lookupResponse = await lookup.app.inject({
    method: "PUT",
    url: `/api/client-v1/orders/${orderRef}/items/${itemRef}`,
    headers: headers(),
    payload: request,
  });
  assert.equal(lookupResponse.statusCode, 503);
  assert.equal(lookupResponse.json().code, "IDEMPOTENCY_LOOKUP_UNAVAILABLE");
  assert.deepEqual(
    lookup.calls.map((x) => x[0]),
    ["preflightPut"],
  );
  const missing = await setup(t, "orders:edit:any", {
    preflightPutError: Object.assign(new Error("missing"), {
      code: "ORDER_NOT_FOUND",
    }),
  });
  const missingResponse = await missing.app.inject({
    method: "PUT",
    url: `/api/client-v1/orders/${orderRef}/items/${itemRef}`,
    headers: headers(),
    payload: request,
  });
  assert.equal(missingResponse.statusCode, 404);
  assert.equal(missingResponse.json().code, "ORDER_NOT_FOUND");
  assert.deepEqual(
    missing.calls.map((x) => x[0]),
    ["preflightPut"],
  );
});
void test("PUT full-card decode and database failures keep post-proceed mapping", async (t) => {
  const request = {
    expectedVersion: "1",
    productRef: "prd_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    variantRef: "var_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    quantity: "2",
    quoteRef: "prq_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    quoteLineNumber: 1,
    quoteHash: "a".repeat(64),
  };
  for (const code of [
    "ORDER_DATABASE_DECODE_ERROR",
    "DB_QUERY_FAILED",
    "TRANSACTION_OUTCOME_UNKNOWN",
  ]) {
    const failed = await setup(t, "orders:edit:any", {
      preflightPutError: Object.assign(new Error(code), { code }),
    });
    const response = await failed.app.inject({
      method: "PUT",
      url: `/api/client-v1/orders/${orderRef}/items/${itemRef}`,
      headers: headers(),
      payload: request,
    });
    assert.equal(response.statusCode, 500, code);
    assert.equal(response.json().code, "INTERNAL_ERROR", code);
    assert.deepEqual(
      failed.calls.map((x) => x[0]),
      ["preflightPut"],
      code,
    );
  }
});
