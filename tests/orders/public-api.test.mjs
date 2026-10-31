import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";
import { context as otelContext, trace } from "@opentelemetry/api";
import { createRuntime } from "../../packages/platform-runtime/dist/index.js";
import {
  signActorContext,
  verifyActorContextWithKeySet,
} from "../../packages/platform-security/dist/index.js";
import {
  configuredOrdersOrigin,
  createConfiguredPublicAdapters,
  createHttpOrdersClient,
  registerPublicRoutes,
} from "../../apps/api-public/dist/index.js";
import { registerOrdersRoutes } from "../../apps/orders-service/dist/http/index.js";

const orderRef = "ord_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const itemRef = "itm_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const customerRef = "cus_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const productRef = "prd_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const variantRef = "var_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const quoteRef = "prq_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const card = {
  orderRef,
  version: "1",
  projectionVersion: "1",
  status: "Draft",
  customer: { customerRef, displayName: "Ada" },
  items: [],
  pricing: null,
  aroma: {
    state: "NotRequested",
    desiredRevision: "0",
    observedRevision: "0",
    blockers: [],
  },
  allowedActions: ["edit-items", "confirm"],
};
const reconciliation = {
  orderRef,
  orderVersion: "1",
  requestedAt: "2026-09-26T10:00:00Z",
  aromaState: "PendingObservation",
};
const orderBody = { customerRef };
const itemBody = {
  expectedVersion: "1",
  productRef,
  variantRef,
  quantity: "2",
  quoteRef,
  quoteLineNumber: 1,
  quoteHash: "a".repeat(64),
};
const commandBody = { expectedVersion: "1" };
const reconciliationBody = {
  expectedVersion: "1",
  reason: "operator requested",
};

async function runtime(t, adapters) {
  const app = await createRuntime({
    name: "orders-public-test",
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
function fakeAdapters(calls, override = {}) {
  return {
    verifyTransport: () => true,
    verifyActor: (_token, operationId, _signal, correlationId) => ({
      iss: "edge-gateway",
      aud: "api-public",
      originalIssuer: "edge-gateway",
      sub: "usr_test",
      permissions:
        {
          createOrderDraft: ["orders:create"],
          getOrderCard: ["orders:read:any"],
          upsertOrderItem: ["orders:edit:any"],
          removeOrderItem: ["orders:edit:any"],
          confirmOrder: ["orders:confirm:any"],
          requestAromaReconciliation: ["orders:reconcile:any"],
        }[operationId] ?? [],
      operationId,
      correlationId,
      traceparent: "00-00000000000000000000000000000000-0000000000000000-00",
      iat: 1_000,
      exp: 1_010,
      jti: randomUUID(),
      kid: "edge-test",
    }),
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
    orders: {
      forward: async (...args) => {
        calls.push(args);
        return {
          status:
            args[0] === "createOrderDraft"
              ? 201
              : args[0] === "requestAromaReconciliation"
                ? 202
                : 200,
          body:
            args[0] === "requestAromaReconciliation" ? reconciliation : card,
        };
      },
    },
    ...override,
  };
}
function commandHeaders(extra = {}) {
  return {
    "x-actor-context": "edge-signed",
    "idempotency-key": randomUUID(),
    ...extra,
  };
}

void test("forwards all six client-v1 Orders operations with operation-bound signed actor context", async (t) => {
  const calls = [];
  const app = await runtime(t, fakeAdapters(calls));
  const inputs = [
    {
      method: "POST",
      url: "/api/client-v1/orders/drafts",
      headers: commandHeaders(),
      payload: orderBody,
      operation: "createOrderDraft",
      body: orderBody,
    },
    {
      method: "PUT",
      url: `/api/client-v1/orders/${orderRef}/items/${itemRef}`,
      headers: commandHeaders(),
      payload: itemBody,
      operation: "upsertOrderItem",
      body: itemBody,
    },
    {
      method: "DELETE",
      url: `/api/client-v1/orders/${orderRef}/items/${itemRef}`,
      headers: commandHeaders({ "if-match-version": "1" }),
      operation: "removeOrderItem",
    },
    {
      method: "POST",
      url: `/api/client-v1/orders/${orderRef}/commands/confirm`,
      headers: commandHeaders(),
      payload: commandBody,
      operation: "confirmOrder",
      body: commandBody,
    },
    {
      method: "POST",
      url: `/api/client-v1/orders/${orderRef}/commands/request-aroma-reconciliation`,
      headers: commandHeaders(),
      payload: reconciliationBody,
      operation: "requestAromaReconciliation",
      body: reconciliationBody,
    },
    {
      method: "GET",
      url: `/api/client-v1/orders/${orderRef}`,
      headers: { "x-actor-context": "edge-signed" },
      operation: "getOrderCard",
    },
  ];
  for (const input of inputs) {
    const { operation, body: _body, ...request } = input;
    const response = await app.inject(request);
    assert.equal(
      response.statusCode,
      operation === "createOrderDraft"
        ? 201
        : operation === "requestAromaReconciliation"
          ? 202
          : 200,
      `${operation}: ${String(response.body)}`,
    );
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(response.headers["x-correlation-id"] !== undefined, true);
  }
  assert.deepEqual(
    calls.map(([operation]) => operation),
    inputs.map(({ operation }) => operation),
  );
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
    {
      method: "POST",
      url: "/api/client-v1/orders/drafts",
      operation: "createOrderDraft",
      payload: orderBody,
    },
    {
      method: "GET",
      url: `/api/client-v1/orders/${orderRef}`,
      operation: "getOrderCard",
    },
    {
      method: "PUT",
      url: `/api/client-v1/orders/${orderRef}/items/${itemRef}`,
      operation: "upsertOrderItem",
      payload: itemBody,
    },
    {
      method: "DELETE",
      url: `/api/client-v1/orders/${orderRef}/items/${itemRef}`,
      operation: "removeOrderItem",
    },
    {
      method: "POST",
      url: `/api/client-v1/orders/${orderRef}/commands/confirm`,
      operation: "confirmOrder",
      payload: commandBody,
    },
    {
      method: "POST",
      url: `/api/client-v1/orders/${orderRef}/commands/request-aroma-reconciliation`,
      operation: "requestAromaReconciliation",
      payload: reconciliationBody,
    },
  ];
  for (const input of cases) {
    for (const permissions of [[], ["pricing:create"]]) {
      const calls = [];
      const app = await runtime(
        t,
        fakeAdapters(calls, {
          verifyActor: (_token, operationId, _signal, correlationId) => ({
            iss: "edge-gateway",
            aud: "api-public",
            originalIssuer: "edge-gateway",
            sub: "usr_test",
            permissions,
            operationId,
            correlationId,
            traceparent:
              "00-00000000000000000000000000000000-0000000000000000-00",
            iat: 1_000,
            exp: 1_010,
            jti: randomUUID(),
            kid: "edge-test",
          }),
        }),
      );
      const baseHeaders =
        input.method === "GET"
          ? { "x-actor-context": "edge-signed" }
          : commandHeaders(
              input.operation === "removeOrderItem"
                ? { "if-match-version": "1" }
                : {},
            );
      const denied = await app.inject({
        method: input.method,
        url: input.url,
        headers: baseHeaders,
        ...(input.payload === undefined ? {} : { payload: input.payload }),
      });
      assert.equal(
        denied.statusCode,
        403,
        `${input.operation} must reject unrelated or absent permission`,
      );
      if (input.method !== "GET") {
        const replay = await app.inject({
          method: input.method,
          url: input.url,
          headers: commandHeaders({ "idempotency-replay-only": "true" }),
        });
        assert.equal(
          replay.statusCode,
          403,
          `${input.operation} replay-only must require current permission`,
        );
      }
      assert.equal(
        calls.length,
        0,
        `${input.operation} must fail before the owner call`,
      );
    }
  }
});

void test("requires transport and signed operation/correlation actor; rejects malformed refs, keys and replay requests", async (t) => {
  const calls = [];
  const verifyCalls = [];
  const adapters = fakeAdapters(calls);
  const verifyActor = adapters.verifyActor;
  adapters.verifyActor = (...args) => {
    verifyCalls.push(args[0]);
    return verifyActor(...args);
  };
  const app = await runtime(t, adapters);
  const url = `/api/client-v1/orders/${orderRef}/commands/confirm`;
  const valid = await app.inject({
    method: "POST",
    url,
    headers: commandHeaders(),
    payload: commandBody,
  });
  assert.equal(valid.statusCode, 200);
  assert.equal(verifyCalls.length, 1);
  assert.equal(calls.length, 1);
  calls.length = 0;
  verifyCalls.length = 0;

  for (const spoofedHeader of ["x-actor-ref", "x-actor-role"]) {
    const denied = await app.inject({
      method: "POST",
      url,
      headers: commandHeaders({ [spoofedHeader]: "attacker" }),
      payload: commandBody,
    });
    assert.equal(denied.statusCode, 403, spoofedHeader);
    assert.equal(denied.json().code, "ACTOR_CONTEXT_INVALID", spoofedHeader);
    assert.equal(denied.headers["cache-control"], "no-store", spoofedHeader);
    assert.equal(verifyCalls.length, 0, spoofedHeader);
    assert.equal(calls.length, 0, spoofedHeader);
  }
  const noTransport = await runtime(
    t,
    fakeAdapters(calls, { verifyTransport: () => false }),
  );
  assert.equal(
    (
      await noTransport.inject({
        method: "POST",
        url,
        headers: commandHeaders(),
        payload: commandBody,
      })
    ).statusCode,
    401,
  );
  const noActor = await app.inject({
    method: "POST",
    url,
    headers: { "idempotency-key": randomUUID() },
    payload: commandBody,
  });
  assert.equal(noActor.statusCode, 401);
  const mismatch = await runtime(
    t,
    fakeAdapters(calls, {
      verifyActor: (_token, operationId, _signal, correlationId) => ({
        iss: "edge-gateway",
        aud: "api-public",
        originalIssuer: "edge-gateway",
        sub: "usr_test",
        permissions: [],
        operationId: "getOrderCard",
        correlationId,
        iat: 1_000,
        exp: 1_010,
        jti: randomUUID(),
        kid: "test",
        traceparent: "00-00000000000000000000000000000000-0000000000000000-00",
      }),
    }),
  );
  assert.equal(
    (
      await mismatch.inject({
        method: "POST",
        url,
        headers: commandHeaders(),
        payload: commandBody,
      })
    ).statusCode,
    403,
  );
  const invalids = [
    {
      url: "/api/client-v1/orders/drafts",
      method: "POST",
      headers: { ...commandHeaders(), "idempotency-key": "not-a-uuid" },
      payload: orderBody,
    },
    {
      url: "/api/client-v1/orders/ord_invalid",
      method: "GET",
      headers: { "x-actor-context": "edge-signed" },
    },
    {
      url,
      method: "POST",
      headers: commandHeaders({ "idempotency-replay-only": "false" }),
    },
    {
      url,
      method: "POST",
      headers: commandHeaders({ "idempotency-replay-only": "true" }),
      payload: commandBody,
    },
    {
      url: `/api/client-v1/orders/${orderRef}/items/${itemRef}`,
      method: "DELETE",
      headers: commandHeaders({
        "if-match-version": "01",
        "idempotency-replay-only": "true",
      }),
    },
  ];
  for (const request of invalids)
    assert.equal((await app.inject(request)).statusCode, 400);
  assert.equal(calls.length, 0);
});

void test("replay-only forwards no body and invalid owner payloads or failures become bounded public problems", async (t) => {
  const calls = [];
  const replayApp = await runtime(t, fakeAdapters(calls));
  const replay = await replayApp.inject({
    method: "POST",
    url: "/api/client-v1/orders/drafts",
    headers: commandHeaders({ "idempotency-replay-only": "true" }),
  });
  assert.equal(replay.statusCode, 201);
  assert.equal(calls[0][3], undefined);
  assert.equal(calls[0][4].replayOnly, true);

  const privateCard = { ...card, privateProof: "owner-secret" };
  const invalid = await runtime(
    t,
    fakeAdapters([], {
      orders: { forward: async () => ({ status: 201, body: privateCard }) },
    }),
  );
  const invalidResponse = await invalid.inject({
    method: "POST",
    url: "/api/client-v1/orders/drafts",
    headers: commandHeaders(),
    payload: orderBody,
  });
  assert.equal(invalidResponse.statusCode, 503);
  assert.equal(invalidResponse.body.includes("owner-secret"), false);

  const wrongCustomer = await runtime(
    t,
    fakeAdapters([], {
      orders: {
        forward: async () => ({
          status: 201,
          replayed: true,
          body: {
            ...card,
            customer: {
              ...card.customer,
              customerRef: "cus_00000000000000000000000000",
            },
          },
        }),
      },
    }),
  );
  const wrongCustomerResponse = await wrongCustomer.inject({
    method: "POST",
    url: "/api/client-v1/orders/drafts",
    headers: commandHeaders(),
    payload: orderBody,
  });
  assert.equal(
    wrongCustomerResponse.statusCode,
    503,
    "a valid card for another customer must never be forwarded",
  );
  assert.equal(wrongCustomerResponse.json().code, "ORDERS_UNAVAILABLE");
  assert.equal(
    wrongCustomerResponse.headers["idempotency-replayed"],
    undefined,
  );

  const wrongOrder = await runtime(
    t,
    fakeAdapters([], {
      orders: {
        forward: async () => ({
          status: 200,
          body: { ...card, orderRef: "ord_00000000000000000000000000" },
        }),
      },
    }),
  );
  const mismatched = await wrongOrder.inject({
    method: "GET",
    url: `/api/client-v1/orders/${orderRef}`,
    headers: { "x-actor-context": "edge-signed" },
  });
  assert.equal(
    mismatched.statusCode,
    503,
    "a valid card from another order must never be forwarded",
  );

  const failed = await runtime(
    t,
    fakeAdapters([], {
      orders: {
        forward: async () => {
          throw new Error("orders-private-upstream-detail");
        },
      },
    }),
  );
  const failure = await failed.inject({
    method: "POST",
    url: "/api/client-v1/orders/drafts",
    headers: commandHeaders(),
    payload: orderBody,
  });
  assert.equal(failure.statusCode, 503);
  assert.equal(failure.body.includes("orders-private-upstream-detail"), false);
});

void test("mTLS Orders client scopes signed delegation to the exact operation and only forwards allowed headers", async () => {
  const correlationId = randomUUID();
  let observed;
  const client = createHttpOrdersClient(
    {
      fetch: async (path, options) => {
        observed = { path, options };
        return new Response(JSON.stringify(card), {
          status: 201,
          headers: {
            "content-type": "application/json",
            "cache-control": "no-store",
            "x-correlation-id": correlationId,
            "idempotency-replayed": "true",
          },
        });
      },
    },
    (actor, owner, operationId, _context) => {
      assert.equal(owner, "orders-service");
      assert.equal(operationId, "createOrderDraft");
      assert.equal(actor.sub, "usr_test");
      return "scoped-delegation";
    },
  );
  const result = await client.forward(
    "createOrderDraft",
    "POST",
    "/api/client-v1/orders/drafts",
    orderBody,
    {
      actor: {
        iss: "edge-gateway",
        aud: "api-public",
        originalIssuer: "edge-gateway",
        sub: "usr_test",
        permissions: [],
        operationId: "createOrderDraft",
        correlationId,
        traceparent: "00-00000000000000000000000000000000-0000000000000000-00",
        iat: 1_000,
        exp: 1_010,
        jti: randomUUID(),
        kid: "test",
      },
      context: { correlationId, signal: new AbortController().signal },
      idempotencyKey: randomUUID(),
      replayOnly: false,
    },
  );
  assert.equal(result.status, 201);
  assert.equal(result.replayed, true);
  assert.equal(
    observed.options.headers["x-actor-context"],
    "scoped-delegation",
  );
  assert.equal(observed.options.headers["x-correlation-id"], correlationId);
  assert.equal(observed.options.headers["idempotency-key"].length, 36);
});

void test("configured public Orders route signs a scoped owner request and validates its response", async (t) => {
  const apiKeys = generateKeyPairSync("ed25519");
  const edgeKeys = generateKeyPairSync("ed25519");
  const edgePublicKey = edgeKeys.publicKey.export({
    type: "spki",
    format: "pem",
  });
  const context = {
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
        apiPublicDelegationSigningPrivateKey: apiKeys.privateKey.export({
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
  let ownerPayload = card;
  let ownerStatus = 201;
  let ownerContentType = "application/json";
  let ownerReplay = true;
  let ownerResponseHeaders = {};
  let ownerResponse;
  const configured = createConfiguredPublicAdapters(context, {
    fetch: async (path, options) => {
      captures.push({ path, options });
      ownerResponse = new Response(JSON.stringify(ownerPayload), {
        status: ownerStatus,
        headers: {
          "content-type": ownerContentType,
          "cache-control": "no-store",
          "x-correlation-id": options.headers["x-correlation-id"],
          ...(ownerReplay ? { "idempotency-replayed": "true" } : {}),
          ...ownerResponseHeaders,
        },
      });
      return ownerResponse;
    },
  });
  assert.equal(configuredOrdersOrigin(context), "https://orders-service:4104");
  const app = await runtime(t, {
    ...configured,
    verifyTransport: () => true,
  });
  const correlationId = randomUUID();
  const idempotencyKey = randomUUID();
  const traceparent = `00-${randomUUID().replaceAll("-", "")}-${randomUUID().replaceAll("-", "").slice(0, 16)}-01`;
  const now = Math.floor(Date.now() / 1_000);
  const actorToken = signActorContext(
    {
      iss: "edge-gateway",
      aud: "api-public",
      originalIssuer: "edge-gateway",
      sub: "usr_configured_orders",
      permissions: ["orders:create"],
      operationId: "createOrderDraft",
      correlationId,
      traceparent,
      iat: now,
      exp: now + 45,
      jti: randomUUID(),
      kid: "edge-test",
    },
    edgeKeys.privateKey,
  );
  const response = await app.inject({
    method: "POST",
    url: "/api/client-v1/orders/drafts",
    headers: {
      "x-actor-context": actorToken,
      "x-correlation-id": correlationId,
      traceparent,
      "idempotency-key": idempotencyKey,
    },
    payload: orderBody,
  });

  assert.equal(response.statusCode, 201, response.body);
  assert.deepEqual(response.json(), card);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.headers["x-correlation-id"], correlationId);
  assert.equal(response.headers["idempotency-replayed"], "true");
  assert.equal(captures.length, 1);
  assert.equal(captures[0].path, "/api/client-v1/orders/drafts");
  assert.equal(captures[0].options.method, "POST");
  assert.equal(captures[0].options.headers["content-type"], "application/json");
  assert.equal(captures[0].options.headers["x-correlation-id"], correlationId);
  assert.equal(captures[0].options.headers["traceparent"], traceparent);
  assert.equal(captures[0].options.headers["idempotency-key"], idempotencyKey);
  assert.deepEqual(JSON.parse(captures[0].options.body), orderBody);
  const delegated = verifyActorContextWithKeySet(
    captures[0].options.headers["x-actor-context"],
    {
      publicKeys: [apiKeys.publicKey],
      issuer: "api-public",
      audience: "orders-service",
      nowEpochSeconds: Math.floor(Date.now() / 1_000),
      clockSkewSeconds: 5,
    },
  );
  assert.equal(delegated.originalIssuer, "edge-gateway");
  assert.equal(delegated.sub, "usr_configured_orders");
  assert.equal(delegated.operationId, "createOrderDraft");
  assert.equal(delegated.correlationId, correlationId);
  assert.deepEqual(delegated.permissions, ["orders:create"]);

  ownerPayload = reconciliation;
  ownerStatus = 202;
  ownerReplay = false;
  const reconciliationCorrelationId = randomUUID();
  const reconciliationIdempotencyKey = randomUUID();
  const reconciliationActorToken = signActorContext(
    {
      iss: "edge-gateway",
      aud: "api-public",
      originalIssuer: "edge-gateway",
      sub: "usr_configured_orders",
      permissions: ["orders:reconcile:any"],
      operationId: "requestAromaReconciliation",
      correlationId: reconciliationCorrelationId,
      traceparent,
      iat: now,
      exp: now + 45,
      jti: randomUUID(),
      kid: "edge-test",
    },
    edgeKeys.privateKey,
  );
  const reconciliationPath = `/api/client-v1/orders/${orderRef}/commands/request-aroma-reconciliation`;
  const accepted = await app.inject({
    method: "POST",
    url: reconciliationPath,
    headers: {
      "x-actor-context": reconciliationActorToken,
      "x-correlation-id": reconciliationCorrelationId,
      traceparent,
      "idempotency-key": reconciliationIdempotencyKey,
    },
    payload: reconciliationBody,
  });
  assert.equal(accepted.statusCode, 202, accepted.body);
  assert.deepEqual(accepted.json(), reconciliation);
  assert.equal(accepted.headers["cache-control"], "no-store");
  assert.equal(
    accepted.headers["x-correlation-id"],
    reconciliationCorrelationId,
  );
  assert.equal(accepted.headers["idempotency-replayed"], undefined);
  assert.equal(captures.length, 2);
  const acceptedCall = captures[1];
  assert.equal(acceptedCall.path, reconciliationPath);
  assert.equal(acceptedCall.options.method, "POST");
  assert.equal(
    acceptedCall.options.headers["content-type"],
    "application/json",
  );
  assert.equal(
    acceptedCall.options.headers["x-correlation-id"],
    reconciliationCorrelationId,
  );
  assert.equal(acceptedCall.options.headers.traceparent, traceparent);
  assert.equal(
    acceptedCall.options.headers["idempotency-key"],
    reconciliationIdempotencyKey,
  );
  assert.deepEqual(JSON.parse(acceptedCall.options.body), reconciliationBody);
  const reconciliationDelegation = verifyActorContextWithKeySet(
    acceptedCall.options.headers["x-actor-context"],
    {
      publicKeys: [apiKeys.publicKey],
      issuer: "api-public",
      audience: "orders-service",
      nowEpochSeconds: Math.floor(Date.now() / 1_000),
      clockSkewSeconds: 5,
    },
  );
  assert.equal(reconciliationDelegation.originalIssuer, "edge-gateway");
  assert.equal(reconciliationDelegation.sub, "usr_configured_orders");
  assert.equal(
    reconciliationDelegation.operationId,
    "requestAromaReconciliation",
  );
  assert.equal(
    reconciliationDelegation.correlationId,
    reconciliationCorrelationId,
  );
  assert.deepEqual(reconciliationDelegation.permissions, [
    "orders:reconcile:any",
  ]);

  ownerReplay = true;
  const replayed = await app.inject({
    method: "POST",
    url: reconciliationPath,
    headers: {
      "x-actor-context": reconciliationActorToken,
      "x-correlation-id": reconciliationCorrelationId,
      traceparent,
      "idempotency-key": reconciliationIdempotencyKey,
      "idempotency-replay-only": "true",
    },
  });
  assert.equal(replayed.statusCode, 202, replayed.body);
  assert.deepEqual(replayed.json(), reconciliation);
  assert.equal(replayed.headers["idempotency-replayed"], "true");
  assert.equal(captures.length, 3);
  assert.equal(captures[2].path, reconciliationPath);
  assert.equal(captures[2].options.method, "POST");
  assert.equal(
    captures[2].options.headers["idempotency-key"],
    reconciliationIdempotencyKey,
  );
  assert.equal(captures[2].options.headers["idempotency-replay-only"], "true");
  assert.equal(captures[2].options.headers["content-type"], undefined);
  assert.equal(captures[2].options.body, undefined);

  ownerPayload = {
    ...reconciliation,
    orderRef: "ord_01ARZ3NDEKTSV4RRFFQ69G5FAW",
  };
  ownerReplay = false;
  const mismatched = await app.inject({
    method: "POST",
    url: reconciliationPath,
    headers: {
      "x-actor-context": reconciliationActorToken,
      "x-correlation-id": reconciliationCorrelationId,
      traceparent,
      "idempotency-key": reconciliationIdempotencyKey,
    },
    payload: reconciliationBody,
  });
  assert.equal(mismatched.statusCode, 503);
  assert.equal(
    mismatched.headers["content-type"].split(";", 1)[0],
    "application/problem+json",
  );
  assert.equal(mismatched.headers["cache-control"], "no-store");
  assert.deepEqual(mismatched.json(), {
    type: "about:blank",
    title: "ORDERS_UNAVAILABLE",
    status: 503,
    code: "ORDERS_UNAVAILABLE",
    detail: "orders owner returned an invalid response",
    instance:
      "/api/client-v1/orders/:orderRef/commands/request-aroma-reconciliation",
    correlationId: reconciliationCorrelationId,
    errors: [],
  });
  assert.equal(
    mismatched.body.includes("ord_01ARZ3NDEKTSV4RRFFQ69G5FAW"),
    false,
  );
  assert.equal(captures.length, 4);

  ownerStatus = 409;
  ownerContentType = "application/problem+json";
  ownerPayload = {
    type: "about:blank",
    title: "ORDER_VERSION_CONFLICT",
    status: 422,
    code: "ORDER_VERSION_CONFLICT",
    detail: "private owner problem canary",
    instance: "/internal/orders/private-order",
    correlationId: reconciliationCorrelationId,
    errors: [],
  };
  const invalidProblem = await app.inject({
    method: "POST",
    url: reconciliationPath,
    headers: {
      "x-actor-context": reconciliationActorToken,
      "x-correlation-id": reconciliationCorrelationId,
      traceparent,
      "idempotency-key": reconciliationIdempotencyKey,
    },
    payload: reconciliationBody,
  });
  assert.equal(invalidProblem.statusCode, 503);
  assert.equal(invalidProblem.headers["cache-control"], "no-store");
  assert.equal(
    invalidProblem.headers["x-correlation-id"],
    reconciliationCorrelationId,
  );
  assert.deepEqual(invalidProblem.json(), {
    type: "about:blank",
    title: "ORDERS_UNAVAILABLE",
    status: 503,
    code: "ORDERS_UNAVAILABLE",
    detail: "orders service is unavailable",
    instance:
      "/api/client-v1/orders/:orderRef/commands/request-aroma-reconciliation",
    correlationId: reconciliationCorrelationId,
    errors: [],
  });
  assert.doesNotMatch(
    invalidProblem.body,
    /private owner problem canary|private-order/u,
  );
  assert.equal(captures.length, 5);

  const malformedJson = await app.inject({
    method: "POST",
    url: "/api/client-v1/orders/drafts",
    headers: {
      "content-type": "application/json",
      "x-actor-context": actorToken,
      "x-correlation-id": correlationId,
      traceparent,
      "idempotency-key": randomUUID(),
    },
    payload: '{"private-parser-canary":',
  });
  assert.equal(malformedJson.statusCode, 400);
  assert.equal(
    malformedJson.headers["content-type"].split(";", 1)[0],
    "application/problem+json",
  );
  assert.equal(malformedJson.headers["cache-control"], "no-store");
  assert.equal(malformedJson.headers["x-correlation-id"], correlationId);
  assert.deepEqual(malformedJson.json(), {
    type: "about:blank",
    title: "VALIDATION_FAILED",
    status: 400,
    code: "VALIDATION_FAILED",
    detail: "Request validation failed",
    instance: "/api/client-v1/orders/drafts",
    correlationId,
    errors: [],
  });
  assert.doesNotMatch(
    malformedJson.body,
    /private-parser-canary|JSON|Unexpected/u,
  );
  assert.equal(captures.length, 5);

  for (const invalidOwnerResponse of [
    {
      name: "mismatched correlation",
      status: 202,
      contentType: "application/json",
      headers: { "x-correlation-id": "private-owner-correlation-canary" },
    },
    {
      name: "cacheable owner response",
      status: 202,
      contentType: "application/json",
      headers: { "cache-control": "private, max-age=60" },
    },
    {
      name: "invalid replay marker",
      status: 202,
      contentType: "application/json",
      headers: { "idempotency-replayed": "false" },
    },
    {
      name: "unsupported owner status",
      status: 418,
      contentType: "application/problem+json",
      headers: {},
    },
    {
      name: "unsupported owner media type",
      status: 202,
      contentType: "text/plain",
      headers: {},
    },
  ]) {
    ownerPayload = reconciliation;
    ownerStatus = invalidOwnerResponse.status;
    ownerContentType = invalidOwnerResponse.contentType;
    ownerReplay = false;
    ownerResponseHeaders = {
      "x-private-proof": "private-owner-header-canary",
      ...invalidOwnerResponse.headers,
    };
    const rejected = await app.inject({
      method: "POST",
      url: reconciliationPath,
      headers: {
        "x-actor-context": reconciliationActorToken,
        "x-correlation-id": reconciliationCorrelationId,
        traceparent,
        "idempotency-key": reconciliationIdempotencyKey,
      },
      payload: reconciliationBody,
    });
    assert.equal(rejected.statusCode, 503, invalidOwnerResponse.name);
    assert.equal(
      rejected.headers["content-type"].split(";", 1)[0],
      "application/problem+json",
      invalidOwnerResponse.name,
    );
    assert.equal(rejected.headers["cache-control"], "no-store");
    assert.equal(
      rejected.headers["x-correlation-id"],
      reconciliationCorrelationId,
    );
    assert.equal(rejected.headers["idempotency-replayed"], undefined);
    assert.deepEqual(rejected.json(), {
      type: "about:blank",
      title: "ORDERS_UNAVAILABLE",
      status: 503,
      code: "ORDERS_UNAVAILABLE",
      detail: "orders service is unavailable",
      instance:
        "/api/client-v1/orders/:orderRef/commands/request-aroma-reconciliation",
      correlationId: reconciliationCorrelationId,
      errors: [],
    });
    assert.equal(ownerResponse.bodyUsed, false, invalidOwnerResponse.name);
    assert.doesNotMatch(
      rejected.body,
      /private-owner-(?:correlation|header)-canary/u,
    );
  }
  assert.equal(captures.length, 10);
});

async function ownerErrorProxy(t, code) {
  const observed = [];
  let confirmCalls = 0;
  const owner = await createRuntime({
    name: "orders-owner-errors",
    host: "127.0.0.1",
    port: 0,
    shutdownGraceMs: 500,
    deadlineMs: 5_000,
    deadlineProfiles: { defaultMs: 5_000 },
  });
  registerOrdersRoutes(owner, {
    verifyTransport: () => true,
    verifyPublicDelegation: (_token, operationId, correlationId) => ({
      iss: "api-public",
      aud: "orders-service",
      originalIssuer: "edge-gateway",
      sub: "usr_test",
      permissions: [
        operationId === "confirmOrder"
          ? "orders:confirm:any"
          : "orders:edit:any",
      ],
      operationId,
      correlationId,
    }),
    signInternalDelegation: () => "fixture-delegation",
    owner: {
      store: {
        precheck: async () => ({ kind: "proceed" }),
        preflightPut: async () => ({ kind: "proceed", customerRef }),
        getCard: async () => card,
        putItem: async () => {
          throw Object.assign(new Error("private owner cause"), { code });
        },
        confirm: async () => {
          confirmCalls++;
          throw Object.assign(new Error("private owner cause"), { code });
        },
      },
      pricing: {
        verify: async () => ({
          valid: true,
          quoteRef,
          policyVersionRef: "pvr_01ARZ3NDEKTSV4RRFFQ69G5FAV",
          catalogSnapshotRevision: "1",
          customerRef,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          currency: "RUB",
          line: {
            lineNumber: 1,
            productRef,
            variantRef,
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
          },
        }),
      },
    },
  });
  await owner.runtimeController.start();
  t.after(() => owner.runtimeController.closeRuntime("SIGTERM"));
  const client = createHttpOrdersClient(
    {
      fetch: async (path, options) => {
        const response = await owner.inject({
          method: options.method,
          url: path,
          headers: options.headers,
          payload: options.body,
        });
        observed.push({
          status: response.statusCode,
          code: response.json().code,
        });
        return new Response(response.body, {
          status: response.statusCode,
          headers: {
            "content-type": String(response.headers["content-type"] ?? ""),
            "cache-control": String(response.headers["cache-control"] ?? ""),
            "x-correlation-id": String(
              response.headers["x-correlation-id"] ?? "",
            ),
          },
        });
      },
    },
    () => "fixture-delegation",
  );
  return {
    observed,
    forward: client.forward,
    runtime: owner,
    get confirmCalls() {
      return confirmCalls;
    },
  };
}

void test("Orders route sanitizes malformed JSON before calling the owner", async (t) => {
  const owner = await ownerErrorProxy(t, "ORDER_EMPTY");
  const correlationId = "11111111-1111-4111-8111-111111111111";
  const response = await owner.runtime.inject({
    method: "POST",
    url: `/api/client-v1/orders/${orderRef}/commands/confirm`,
    headers: {
      "content-type": "application/json",
      "x-actor-context": "fixture-delegation",
      "x-correlation-id": correlationId,
      "idempotency-key": randomUUID(),
    },
    payload: '{"expectedVersion": "private-parser-canary"',
  });

  assert.equal(response.statusCode, 400);
  assert.match(response.headers["content-type"], /application\/problem\+json/u);
  assert.deepEqual(response.json(), {
    type: "about:blank",
    title: "VALIDATION_FAILED",
    status: 400,
    code: "VALIDATION_FAILED",
    detail: "Request could not be completed",
    instance: "/api/client-v1/orders/:orderRef/commands/confirm",
    correlationId,
    errors: [],
  });
  assert.equal(response.body.includes("private-parser-canary"), false);
  assert.equal(response.body.includes("JSON"), false);
  assert.equal(owner.confirmCalls, 0);
});

void test("four typed owner failures cross api-public with exact HTTP status/code pairs", async (t) => {
  const cases = [
    {
      code: "ORDER_EMPTY",
      status: 422,
      method: "POST",
      url: `/api/client-v1/orders/${orderRef}/commands/confirm`,
      payload: commandBody,
    },
    {
      code: "ORDER_DESIRED_OVERFLOW",
      status: 422,
      method: "POST",
      url: `/api/client-v1/orders/${orderRef}/commands/confirm`,
      payload: commandBody,
    },
    {
      code: "ORDER_ITEM_LIMIT_EXCEEDED",
      status: 409,
      method: "PUT",
      url: `/api/client-v1/orders/${orderRef}/items/${itemRef}`,
      payload: itemBody,
    },
    {
      code: "ORDER_QUOTE_SCOPE_MISMATCH",
      status: 409,
      method: "PUT",
      url: `/api/client-v1/orders/${orderRef}/items/${itemRef}`,
      payload: itemBody,
    },
  ];
  for (const scenario of cases) {
    const owner = await ownerErrorProxy(t, scenario.code);
    const app = await runtime(t, fakeAdapters([], { orders: owner }));
    const response = await app.inject({
      method: scenario.method,
      url: scenario.url,
      headers: commandHeaders(),
      payload: scenario.payload,
    });
    assert.deepEqual(
      owner.observed.at(-1),
      { status: scenario.status, code: scenario.code },
      `${scenario.code}: owner status/code`,
    );
    assert.equal(
      response.statusCode,
      scenario.status,
      `${scenario.code}: public status`,
    );
    assert.equal(
      response.json().code,
      scenario.code,
      `${scenario.code}: public code`,
    );
    assert.equal(response.headers["idempotency-replayed"], undefined);
    assert.equal(response.body.includes("private owner cause"), false);
  }
});

void test("api-public rejects typed Orders errors with an invalid status or operation", async (t) => {
  const cases = [
    {
      code: "ORDER_EMPTY",
      status: 409,
      method: "POST",
      url: `/api/client-v1/orders/${orderRef}/commands/confirm`,
      payload: commandBody,
    },
    {
      code: "ORDER_DESIRED_OVERFLOW",
      status: 409,
      method: "POST",
      url: `/api/client-v1/orders/${orderRef}/commands/confirm`,
      payload: commandBody,
    },
    {
      code: "ORDER_ITEM_LIMIT_EXCEEDED",
      status: 422,
      method: "PUT",
      url: `/api/client-v1/orders/${orderRef}/items/${itemRef}`,
      payload: itemBody,
    },
    {
      code: "ORDER_QUOTE_SCOPE_MISMATCH",
      status: 422,
      method: "PUT",
      url: `/api/client-v1/orders/${orderRef}/items/${itemRef}`,
      payload: itemBody,
    },
    {
      code: "ORDER_ITEM_LIMIT_EXCEEDED",
      status: 409,
      method: "POST",
      url: `/api/client-v1/orders/${orderRef}/commands/confirm`,
      payload: commandBody,
    },
  ];
  for (const scenario of cases) {
    const body = {
      type: "about:blank",
      title: scenario.code,
      status: scenario.status,
      code: scenario.code,
      detail: "private owner cause",
      instance: "/api/client-v1/orders",
      correlationId: randomUUID(),
      errors: [],
    };
    const app = await runtime(
      t,
      fakeAdapters([], {
        orders: {
          forward: async () => ({
            status: scenario.status,
            body,
            replayed: true,
          }),
        },
      }),
    );
    const response = await app.inject({
      method: scenario.method,
      url: scenario.url,
      headers: commandHeaders(),
      payload: scenario.payload,
    });
    assert.equal(
      response.statusCode,
      503,
      `${scenario.code}: wrong owner response must fail closed`,
    );
    assert.equal(response.json().code, "ORDERS_UNAVAILABLE");
    assert.equal(response.headers["idempotency-replayed"], undefined);
    assert.equal(response.body.includes("private owner cause"), false);
  }
});

void test("Orders delegation carries the active API span only when incoming traceparent is absent", async (t) => {
  const observabilityRequire = createRequire(
    new URL(
      "../../packages/platform-observability/package.json",
      import.meta.url,
    ),
  );
  const { AsyncLocalStorageContextManager } = observabilityRequire(
    "@opentelemetry/context-async-hooks",
  );
  const { BasicTracerProvider } = observabilityRequire(
    "@opentelemetry/sdk-trace-base",
  );
  const manager = new AsyncLocalStorageContextManager().enable();
  const provider = new BasicTracerProvider();
  assert.equal(otelContext.setGlobalContextManager(manager), true);
  assert.equal(trace.setGlobalTracerProvider(provider), true);
  t.after(async () => {
    trace.disable();
    otelContext.disable();
    manager.disable();
    await provider.shutdown();
  });

  const apiKeys = generateKeyPairSync("ed25519");
  const edgeKeys = generateKeyPairSync("ed25519");
  const edgePublicKey = edgeKeys.publicKey.export({
    type: "spki",
    format: "pem",
  });
  const captures = [];
  const adapters = createConfiguredPublicAdapters(
    {
      config: {
        environment: "development",
        services: { "api-public": { outbound: ["orders-service:4104"] } },
      },
      secrets: {
        security: {
          apiPublicDelegationSigningPrivateKey: apiKeys.privateKey.export({
            type: "pkcs8",
            format: "pem",
          }),
          actorContextEdgeVerificationPublicKeys: {
            active: edgePublicKey,
            previous: edgePublicKey,
          },
        },
      },
    },
    {
      fetch: async (_path, options) => {
        captures.push({ options, span: trace.getActiveSpan()?.spanContext() });
        return new Response(JSON.stringify(card), {
          status: 201,
          headers: {
            "content-type": "application/json",
            "cache-control": "no-store",
            "x-correlation-id": options.headers["x-correlation-id"],
          },
        });
      },
    },
  );
  const authenticatedSpans = new Map();
  const app = await runtime(t, {
    ...adapters,
    verifyTransport: () => true,
    verifyActor: (...args) => {
      const claims = adapters.verifyActor(...args);
      authenticatedSpans.set(args[3], trace.getActiveSpan()?.spanContext());
      return claims;
    },
  });
  const token = (correlationId, traceparent) => {
    const now = Math.floor(Date.now() / 1_000);
    return signActorContext(
      {
        iss: "edge-gateway",
        aud: "api-public",
        originalIssuer: "edge-gateway",
        sub: "usr_test",
        permissions: ["orders:create"],
        operationId: "createOrderDraft",
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
  const incoming = `00-${"1".repeat(32)}-${"2".repeat(16)}-01`;
  const inject = (correlationId, claimTrace, incomingTrace) =>
    app.inject({
      method: "POST",
      url: "/api/client-v1/orders/drafts",
      headers: {
        "x-actor-context": token(correlationId, claimTrace),
        "x-correlation-id": correlationId,
        "idempotency-key": randomUUID(),
        ...(incomingTrace === undefined ? {} : { traceparent: incomingTrace }),
      },
      payload: orderBody,
    });
  const signedTrace = (capture) =>
    verifyActorContextWithKeySet(capture.options.headers["x-actor-context"], {
      publicKeys: [apiKeys.publicKey],
      issuer: "api-public",
      audience: "orders-service",
      nowEpochSeconds: Math.floor(Date.now() / 1_000),
      clockSkewSeconds: 5,
    }).traceparent;

  const correlationIds = [randomUUID(), randomUUID()];
  const responses = await Promise.all(
    correlationIds.map((id) => inject(id, incoming)),
  );
  for (const response of responses) assert.equal(response.statusCode, 201);
  assert.equal(captures.length, 2);
  assert.notEqual(captures[0].span.traceId, captures[1].span.traceId);
  for (const capture of captures) {
    const { span, options } = capture;
    const expected = `00-${span.traceId}-${span.spanId}-${span.traceFlags.toString(16).padStart(2, "0")}`;
    assert.deepEqual(
      authenticatedSpans.get(options.headers["x-correlation-id"]),
      span,
    );
    assert.equal(options.headers.traceparent, expected);
    assert.equal(signedTrace(capture), expected);
    assert.ok(correlationIds.includes(options.headers["x-correlation-id"]));
  }

  const preserved = await inject(randomUUID(), incoming, incoming);
  assert.equal(preserved.statusCode, 201);
  assert.equal(captures[2].options.headers.traceparent, incoming);
  assert.equal(signedTrace(captures[2]), incoming);
  const other = `00-${"3".repeat(32)}-${"4".repeat(16)}-01`;
  const rejected = await inject(randomUUID(), other, incoming);
  assert.equal(rejected.statusCode, 403);
  assert.equal(captures.length, 3);

  trace.disable();
  const noActive = await inject(randomUUID(), incoming);
  assert.equal(noActive.statusCode, 201);
  assert.equal(captures[3].options.headers.traceparent, undefined);
  assert.equal(
    signedTrace(captures[3]),
    "00-00000000000000000000000000000000-0000000000000000-00",
  );
});
