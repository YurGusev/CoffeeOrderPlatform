import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {createHash, randomUUID} from "node:crypto";
import test from "node:test";
import {metrics, trace} from "@opentelemetry/api";
import {createRuntime} from "../../packages/platform-runtime/src/index.ts";
import {createDatabase} from "../../packages/platform-database/dist/index.js";
import {registerOrdersRoutes} from "../../apps/orders-service/dist/http/index.js";
import {OrderStore} from "../../apps/orders-service/dist/infrastructure/database/order-store.js";
import {withCatalogPostgres} from "../../scripts/catalog-live-harness.mjs";

const root = new URL("../../", import.meta.url);
const migrations = [
  "0001_create_orders.sql",
  "0002_create_order_items.sql",
  "0003_create_order_history.sql",
  "0004_create_order_contributions.sql",
  "0005_create_orders_idempotency.sql",
  "0006_create_orders_outbox.sql",
];
const pool = {
  max: 4,
  checkoutTimeoutMs: 2_000,
  lockTimeoutMs: 1_000,
  interactiveStatementTimeoutMs: 5_000,
  backgroundStatementTimeoutMs: 10_000,
  terminalTimeoutMs: 3_000,
  transactionTimeoutMs: 20_000,
  idleTimeoutMs: 30_000,
  maxLifetimeMs: 1_800_000,
};
const ref = prefix => `${prefix}_01ARZ3NDEKTSV4RRFFQ69G5FAV`;
const hash = character => character.repeat(64);
const customerRef = ref("cus");
const productRef = ref("prd");
const variantRef = ref("var");
const quoteRef = ref("prq");
const offerRef = ref("off");
const policyVersionRef = ref("pvr");
const correlationId = randomUUID();
const traceparent = "00-11111111111111111111111111111111-2222222222222222-01";
const confirmKey = randomUUID();
const orderPath = orderRef => `/api/client-v1/orders/${orderRef}`;
const confirmPath = orderRef => `${orderPath(orderRef)}/commands/confirm`;
const selectedLine = Object.freeze({
  lineNumber: 2,
  productRef,
  variantRef,
  productDisplayName: "Live lifecycle coffee",
  offerRef,
  mappingRevision: "7",
  quantity: "1.5",
  unit: "kilogram",
  supplierUnitMinor: "900",
  unitMinor: "1200",
  lineTotalMinor: "1800",
  currency: "RUB",
  internalProofHash: hash("b"),
});

function tokenActor(token) {
  if (token === "synthetic-api-public-actor-a") return {sub: "live-owner-actor-a", permissions: [
    "orders:create", "orders:edit:any", "orders:read:any", "orders:confirm:any", "orders:reconcile:any",
  ]};
  if (token === "synthetic-api-public-actor-b") return {sub: "live-owner-actor-b", permissions: ["orders:confirm:any"]};
  if (token === "synthetic-api-public-actor-b-all") return {sub: "live-owner-actor-b", permissions: [
    "orders:create", "orders:edit:any", "orders:read:any", "orders:confirm:any", "orders:reconcile:any",
  ]};
  if (token === "synthetic-api-public-no-confirm") return {sub: "live-owner-actor-a", permissions: ["orders:read:any"]};
  if (token === "synthetic-api-public-edit-only") return {sub: "live-owner-actor-a", permissions: ["orders:edit:any"]};
  return undefined;
}

async function createOwnerApp(database, counters, options = {}) {
  const store = new OrderStore(database, options.projection === undefined ? undefined : {testOnlyReconciliationProjection: options.projection});
  let replayLookups = 0;
  const countedStore = new Proxy(store, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property === "replay") return (...args) => {
        replayLookups += 1;
        return value.apply(target, args);
      };
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const app = await createRuntime({
    name: "orders-owner-live-proof",
    host: "127.0.0.1",
    port: 0,
    shutdownGraceMs: 5_000,
    deadlineMs: 10_000,
    deadlineProfiles: {defaultMs: 10_000},
  });
  registerOrdersRoutes(app, {
    // Synthetic trusted api-public fixture for this isolated test only; it is not an IdP.
    verifyTransport: (_request, caller) => caller === "api-public",
    verifyPublicDelegation: async (token, operation, requestCorrelationId) => {
      const actor = tokenActor(token);
      if (!actor) throw new Error("SYNTHETIC_ACTOR_NOT_FOUND");
      return {
        iss: "api-public",
        aud: "orders-service",
        originalIssuer: "edge-gateway",
        sub: actor.sub,
        permissions: actor.permissions,
        operationId: operation,
        correlationId: requestCorrelationId,
        traceparent,
      };
    },
    signInternalDelegation: request => {
      options.onSign?.();
      return `synthetic-internal:${request.operationId}`;
    },
    owner: {
      store: countedStore,
      customer: {
        async getOrderInput(request) {
          counters.customer += 1;
          assert.equal(request.customerRef, customerRef);
          return {customerRef, customerVersion: "3", displayName: options.customerDisplayName ?? "Live owner customer", state: "Active"};
        },
      },
      pricing: {
        async verify(request) {
          counters.pricing += 1;
          assert.deepEqual({
            quoteRef: request.quoteRef,
            hash: request.hash,
            customerRef: request.customerRef,
            quoteLineNumber: request.quoteLineNumber,
            productRef: request.productRef,
            variantRef: request.variantRef,
            quantity: request.quantity,
          }, {
            quoteRef,
            hash: hash("a"),
            customerRef,
            quoteLineNumber: selectedLine.lineNumber,
            productRef,
            variantRef,
            quantity: selectedLine.quantity,
          }, "fake Pricing must verify only the exactly selected persisted quote line");
          return {
            valid: true,
            quoteRef,
            policyVersionRef,
            catalogSnapshotRevision: "11",
            customerRef,
            expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
            currency: "RUB",
            line: selectedLine,
          };
        },
      },
    },
  });
  await app.runtimeController.start();
  return {app, getReplayLookups: () => replayLookups};
}

function requestHeaders(token, key = randomUUID()) {
  return {
    "x-correlation-id": correlationId,
    traceparent,
    "x-actor-context": token,
    "idempotency-key": key,
  };
}

void test("live owner HTTP lifecycle and durable confirm replay after response loss and app restart", {
  timeout: 180_000,
  skip: process.env.COFFEE_DB_LIVE_PROOF !== "1" ? "set COFFEE_DB_LIVE_PROOF=1 to run isolated PostgreSQL owner proof" : false,
}, async () => {
  await withCatalogPostgres(async ({adminClient, port, databaseName}) => {
    const password = `orders-live-${randomUUID().replaceAll("-", "")}`;
    await adminClient.query(`CREATE ROLE coffee_orders_service_rw LOGIN PASSWORD '${password}'`);
    for (const migration of migrations) {
      await adminClient.query(await readFile(new URL(`apps/orders-service/migrations/${migration}`, root), "utf8"));
    }
    const database = createDatabase({
      owner: "orders-owner-live-proof",
      database: databaseName,
      allowedDatabase: databaseName,
      host: "127.0.0.1",
      port,
      user: "coffee_orders_service_rw",
      password,
      ssl: false,
      pool,
      shutdownGraceMs: 40_000,
    });
    await database.resource.start(AbortSignal.timeout(5_000));
    const counters = {customer: 0, pricing: 0};
    let runtime;
    try {
      runtime = await createOwnerApp(database, counters);
      const {app} = runtime;
      const createResponse = await app.inject({
        method: "POST",
        url: "/api/client-v1/orders/drafts",
        headers: requestHeaders("synthetic-api-public-actor-a"),
        payload: {customerRef},
      });
      assert.equal(createResponse.statusCode, 201);
      const draft = createResponse.json();
      const orderRef = draft.orderRef;
      assert.equal(draft.status, "Draft");
      assert.equal(draft.version, "1");
      assert.deepEqual(draft.allowedActions, ["edit-items"], "saved Draft card reflects verified edit permission");

      const emptyConfirm = await app.inject({
        method: "POST",
        url: confirmPath(orderRef),
        headers: requestHeaders("synthetic-api-public-actor-a"),
        payload: {expectedVersion: "1"},
      });
      assert.equal(emptyConfirm.statusCode, 422);
      assert.equal(emptyConfirm.json().code, "ORDER_EMPTY");
      assert.equal(emptyConfirm.headers["idempotency-replayed"], undefined);
      const unchangedDraft = await adminClient.query("SELECT status, version::text AS version FROM orders.orders WHERE order_ref = $1", [orderRef]);
      assert.deepEqual(unchangedDraft.rows[0], {status: "Draft", version: "1"});
      assert.deepEqual(counters, {customer: 1, pricing: 0}, "empty Confirm must not call upstream owners");

      const itemRef = ref("itm");
      const putResponse = await app.inject({
        method: "PUT",
        url: `${orderPath(orderRef)}/items/${itemRef}`,
        headers: requestHeaders("synthetic-api-public-actor-a"),
        payload: {
          expectedVersion: "1",
          productRef,
          variantRef,
          quantity: selectedLine.quantity,
          quoteRef,
          quoteLineNumber: selectedLine.lineNumber,
          quoteHash: hash("a"),
        },
      });
      assert.equal(putResponse.statusCode, 200);
      assert.equal(putResponse.json().status, "Draft");
      assert.equal(putResponse.json().version, "2");
      assert.deepEqual(putResponse.json().allowedActions, ["edit-items", "confirm"], "saved item card reflects verified permissions");
      assert.equal(counters.customer, 1);
      assert.equal(counters.pricing, 1);

      // Corrupt only this disposable database to prove the owner validates persisted rows,
      // rather than assuming every selected item remains consistent with its money facts.
      const itemTotalCheck = await adminClient.query(`SELECT conname FROM pg_constraint
        WHERE conrelid = 'orders.order_items'::regclass AND contype = 'c'
          AND pg_get_constraintdef(oid) LIKE '%ceil%'`);
      assert.equal(itemTotalCheck.rowCount, 1);
      const constraintName = itemTotalCheck.rows[0].conname;
      assert.match(constraintName, /^[a-z][a-z0-9_]*$/u);
      await adminClient.query(`ALTER TABLE orders.order_items DROP CONSTRAINT ${constraintName}`);
      await adminClient.query("UPDATE orders.order_items SET line_total_minor = line_total_minor + 1 WHERE order_ref = $1", [orderRef]);
      const invalidCard = await app.inject({method: "GET", url: orderPath(orderRef), headers: requestHeaders("synthetic-api-public-actor-a")});
      assert.equal(invalidCard.statusCode, 500, "inconsistent persisted item money must not become a successful Card");
      assert.equal(invalidCard.json().code, "INTERNAL_ERROR");
      await adminClient.query("UPDATE orders.order_items SET line_total_minor = 1800 WHERE order_ref = $1", [orderRef]);

      const confirmRequest = {
        method: "POST",
        url: confirmPath(orderRef),
        headers: requestHeaders("synthetic-api-public-actor-a", confirmKey),
        payload: {expectedVersion: "2"},
      };
      const firstConfirm = await app.inject(confirmRequest);
      assert.equal(firstConfirm.statusCode, 200);
      assert.deepEqual(counters, {customer: 1, pricing: 1}, "Confirm must use only frozen persisted snapshots");

      // Read durable owner state before discarding the first HTTP response and restarting the route process.
      const durable = await adminClient.query(`SELECT
        (SELECT count(*)::int FROM orders.order_history WHERE order_ref = $1 AND event_type = 'OrderConfirmed') AS confirmed_history,
        (SELECT count(*)::int FROM orders.order_desired_contributions WHERE order_ref = $1) AS desired,
        (SELECT count(*)::int FROM orders.order_desired_contribution_lines WHERE order_ref = $1) AS desired_lines,
        (SELECT count(*)::int FROM orders.outbox_messages WHERE aggregate_ref = $1 AND message_type = 'OrderConfirmed.v1') AS outbox`, [orderRef]);
      assert.deepEqual(durable.rows[0], {confirmed_history: 1, desired: 1, desired_lines: 1, outbox: 1});

      // Intentionally do not consume the committed response body, modeling a lost reply before restarting.
      void firstConfirm;
      await app.runtimeController.closeRuntime("SIGTERM");
      runtime = undefined;
      runtime = await createOwnerApp(database, counters);
      const restarted = runtime;
      const replayHeaders = {
        ...requestHeaders("synthetic-api-public-actor-a", confirmKey),
        "idempotency-replay-only": "true",
      };

      const lookupsBeforeDenied = restarted.getReplayLookups();
      const deniedReplay = await restarted.app.inject({
        method: "POST",
        url: confirmPath(orderRef),
        headers: {...replayHeaders, "x-actor-context": "synthetic-api-public-no-confirm"},
      });
      assert.equal(deniedReplay.statusCode, 403);
      assert.equal(restarted.getReplayLookups(), lookupsBeforeDenied, "authorization must precede durable replay lookup");

      const otherActorReplay = await restarted.app.inject({
        method: "POST",
        url: confirmPath(orderRef),
        headers: {...replayHeaders, "x-actor-context": "synthetic-api-public-actor-b"},
      });
      assert.equal(otherActorReplay.statusCode, 410, "idempotency identity is actor scoped");
      const otherPathReplay = await restarted.app.inject({
        method: "POST",
        url: confirmPath(ref("ord")),
        headers: replayHeaders,
      });
      assert.equal(otherPathReplay.statusCode, 410, "idempotency identity is exact HTTP-path scoped");
      const replay = await restarted.app.inject({
        method: "POST",
        url: confirmPath(orderRef),
        headers: replayHeaders,
      });
      assert.equal(replay.statusCode, 200);
      assert.equal(replay.headers["idempotency-replayed"], "true");
      assert.deepEqual(counters, {customer: 1, pricing: 1}, "Confirm replay must not call Customer or Pricing");

      const read = await restarted.app.inject({
        method: "GET",
        url: orderPath(orderRef),
        headers: requestHeaders("synthetic-api-public-actor-a"),
      });
      assert.equal(read.statusCode, 200);
      const persistedCard = read.json();
      assert.equal(persistedCard.status, "Confirmed");
      assert.equal(persistedCard.version, "3");
      assert.equal(persistedCard.items.length, 1);
      assert.deepEqual(replay.json(), persistedCard, "bodyless replay returns the durable confirmed response");

      // Exercise DELETE through the real HTTP handler and durable Store, not by calling deleteItem directly.
      const deleteDraftResponse = await restarted.app.inject({
        method: "POST", url: "/api/client-v1/orders/drafts",
        headers: requestHeaders("synthetic-api-public-actor-a"), payload: {customerRef},
      });
      assert.equal(deleteDraftResponse.statusCode, 201);
      const deleteOrderRef = deleteDraftResponse.json().orderRef;
      assert.deepEqual(deleteDraftResponse.json().allowedActions, ["edit-items"]);
      const deleteItemRef = ref("itm");
      const deleteUrl = `${orderPath(deleteOrderRef)}/items/${deleteItemRef}`;
      const deletePut = await restarted.app.inject({
        method: "PUT", url: deleteUrl, headers: requestHeaders("synthetic-api-public-actor-a"),
        payload: {expectedVersion:"1",productRef,variantRef,quantity:selectedLine.quantity,quoteRef,quoteLineNumber:selectedLine.lineNumber,quoteHash:hash("a")},
      });
      assert.equal(deletePut.statusCode, 200);
      assert.deepEqual(deletePut.json().allowedActions, ["edit-items","confirm"]);
      const deleteKey = randomUUID();
      const deleteHeaders = requestHeaders("synthetic-api-public-actor-a", deleteKey);
      const lookupsBeforeInvalid = restarted.getReplayLookups();
      const missingVersion = await restarted.app.inject({method:"DELETE",url:deleteUrl,headers:deleteHeaders});
      assert.equal(missingVersion.statusCode,400);
      const replayWithVersion = await restarted.app.inject({method:"DELETE",url:deleteUrl,
        headers:{...deleteHeaders,"idempotency-replay-only":"true","if-match-version":"2"}});
      assert.equal(replayWithVersion.statusCode,400);
      assert.equal(restarted.getReplayLookups(),lookupsBeforeInvalid,"invalid DELETE must not look up durable replay");
      const firstDelete = await restarted.app.inject({method:"DELETE",url:deleteUrl,headers:{...deleteHeaders,"if-match-version":"2"}});
      assert.equal(firstDelete.statusCode,200);
      assert.equal(firstDelete.json().version,"3");
      assert.deepEqual(firstDelete.json().allowedActions,["edit-items"]);
      const deleteRowsBeforeReplay = await adminClient.query("SELECT count(*)::int AS total FROM orders.order_history WHERE order_ref = $1",[deleteOrderRef]);
      const deniedDeleteReplay = await restarted.app.inject({method:"DELETE",url:deleteUrl,
        headers:{...deleteHeaders,"idempotency-replay-only":"true","x-actor-context":"synthetic-api-public-no-confirm"}});
      assert.equal(deniedDeleteReplay.statusCode,403);
      assert.equal(restarted.getReplayLookups(),lookupsBeforeInvalid,"current auth denial must precede replay lookup");
      const exactDeleteReplay = await restarted.app.inject({method:"DELETE",url:deleteUrl,
        headers:{...deleteHeaders,"idempotency-replay-only":"true","x-actor-context":"synthetic-api-public-edit-only"}});
      assert.equal(exactDeleteReplay.statusCode,200);
      assert.equal(exactDeleteReplay.headers["idempotency-replayed"],"true");
      assert.deepEqual(exactDeleteReplay.json(),firstDelete.json(),"replay returns saved body, not a recalculated card");
      const deleteRowsAfterReplay = await adminClient.query("SELECT count(*)::int AS total FROM orders.order_history WHERE order_ref = $1",[deleteOrderRef]);
      assert.deepEqual(deleteRowsAfterReplay.rows,deleteRowsBeforeReplay.rows,"replay must not duplicate history");
      const currentRead = await restarted.app.inject({method:"GET",url:orderPath(deleteOrderRef),
        headers:requestHeaders("synthetic-api-public-no-confirm")});
      assert.equal(currentRead.statusCode,200);
      assert.deepEqual(currentRead.json().allowedActions,[],"GET recomputes current permissions; replay does not");

      const reconciliation = await restarted.app.inject({
        method: "POST",
        url: `${orderPath(orderRef)}/commands/request-aroma-reconciliation`,
        headers: requestHeaders("synthetic-api-public-actor-a"),
        payload: {expectedVersion: "3", reason: "operator-request"},
      });
      assert.equal(reconciliation.statusCode, 409);
      assert.equal(reconciliation.json().code, "AROMA_RECONCILIATION_NOT_ALLOWED");
      assert.notEqual(reconciliation.statusCode, 202, "pre-#11 reconciliation must not claim acceptance");
    } finally {
      if (runtime !== undefined) await runtime.app.runtimeController.closeRuntime("SIGTERM").catch(() => undefined);
      await database.resource.stop(AbortSignal.timeout(5_000)).catch(() => database.resource.destroy());
    }
  });
});

void test("live owner replay-only matrix preserves five command results and rejects unresolved lookups without effects or leaks", {
  timeout: 180_000,
  skip: process.env.COFFEE_DB_LIVE_PROOF !== "1" ? "set COFFEE_DB_LIVE_PROOF=1 to run isolated PostgreSQL owner proof" : false,
}, async () => {
  const piiCanary = "orders-private-customer-canary";
  const logChunks = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = function (chunk, ...args) {
    logChunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
    return originalWrite(chunk, ...args);
  };
  const spans = [];
  const measurements = [];
  assert.equal(trace.setGlobalTracerProvider({getTracer: () => ({startSpan(name) {
    const span = {name, attributes: {}, setAttribute(key, value) {this.attributes[key] = value;},
      setStatus(value) {this.status = value;}, end() {this.ended = true;},
      spanContext: () => ({traceId: "1".repeat(32), spanId: "2".repeat(16), traceFlags: 1})};
    spans.push(span);
    return span;
  }})}), true);
  assert.equal(metrics.setGlobalMeterProvider({getMeter: () => ({
    createCounter: name => ({add: (value, attributes) => measurements.push({name, value, attributes})}),
    createHistogram: name => ({record: (value, attributes) => measurements.push({name, value, attributes})}),
  })}), true);
  const tables = ["orders", "order_items", "order_history", "order_desired_contributions",
    "order_desired_contribution_lines", "idempotency_records", "outbox_messages"];
  try {
    await withCatalogPostgres(async ({adminClient, port, databaseName}) => {
      const password = `orders-live-${randomUUID().replaceAll("-", "")}`;
      await adminClient.query(`CREATE ROLE coffee_orders_service_rw LOGIN PASSWORD '${password}'`);
      for (const migration of migrations) {
        await adminClient.query(await readFile(new URL(`apps/orders-service/migrations/${migration}`, root), "utf8"));
      }
      const database = createDatabase({owner: "orders-replay-live-proof", database: databaseName,
        allowedDatabase: databaseName, host: "127.0.0.1", port, user: "coffee_orders_service_rw", password,
        ssl: false, pool, shutdownGraceMs: 40_000});
      await database.resource.start(AbortSignal.timeout(5_000));
      const counters = {customer: 0, pricing: 0};
      const projection = new Map();
      let signs = 0;
      let runtime;
      const snapshot = async () => {
        const rows = [];
        for (const table of tables) {
          rows.push([table, (await adminClient.query(`SELECT to_jsonb(t) AS value FROM orders.${table} AS t ORDER BY to_jsonb(t)::text`)).rows]);
        }
        return Object.fromEntries(rows);
      };
      try {
        runtime = await createOwnerApp(database, counters, {projection, customerDisplayName: piiCanary,
          onSign: () => {signs += 1;}});
        const {app} = runtime;
        const actor = "synthetic-api-public-actor-a";
        const createUrl = "/api/client-v1/orders/drafts";
        const createKey = randomUUID();
        const created = await app.inject({method: "POST", url: createUrl, headers: requestHeaders(actor, createKey), payload: {customerRef}});
        assert.equal(created.statusCode, 201, created.body);
        const orderRef = created.json().orderRef;
        const itemRef = ref("itm");
        const itemUrl = `${orderPath(orderRef)}/items/${itemRef}`;
        const putBody = expectedVersion => ({expectedVersion, productRef, variantRef,
          quantity: selectedLine.quantity, quoteRef, quoteLineNumber: selectedLine.lineNumber, quoteHash: hash("a")});
        const put = async (version, key = randomUUID()) => app.inject({method: "PUT", url: itemUrl,
          headers: requestHeaders(actor, key), payload: putBody(version)});
        const putKey = randomUUID();
        const firstPut = await put("1", putKey);
        assert.equal(firstPut.statusCode, 200, firstPut.body);
        const deleteKey = randomUUID();
        const removed = await app.inject({method: "DELETE", url: itemUrl,
          headers: {...requestHeaders(actor, deleteKey), "if-match-version": "2"}});
        assert.equal(removed.statusCode, 200, removed.body);
        assert.equal((await put("3")).statusCode, 200);
        const confirmKey = randomUUID();
        const confirmed = await app.inject({method: "POST", url: confirmPath(orderRef),
          headers: requestHeaders(actor, confirmKey), payload: {expectedVersion: "4"}});
        assert.equal(confirmed.statusCode, 200, confirmed.body);
        projection.set(orderRef, {orderVersion: "5", state: "OutOfSync"});
        const reconcileUrl = `${orderPath(orderRef)}/commands/request-aroma-reconciliation`;
        const reconcileKey = randomUUID();
        const reconciled = await app.inject({method: "POST", url: reconcileUrl,
          headers: requestHeaders(actor, reconcileKey), payload: {expectedVersion: "5", reason: "operator request"}});
        assert.equal(reconciled.statusCode, 202, reconciled.body);
        projection.clear();
        // Model lost replies: every operation was committed by the first process,
        // while all bodyless lookups run against a fresh owner process/store.
        await app.runtimeController.closeRuntime("SIGTERM");
        runtime = await createOwnerApp(database, counters, {projection, customerDisplayName: piiCanary,
          onSign: () => {signs += 1;}});
        const replayApp = runtime.app;

        // Read-only lookup must return the historical result, not the current Order Card.
        const cases = [
          {name: "Draft", method: "POST", url: createUrl, key: createKey, original: created, otherUrl: confirmPath(orderRef)},
          {name: "PUT", method: "PUT", url: itemUrl, key: putKey, original: firstPut, otherUrl: `${orderPath(orderRef)}/items/${ref("itm").slice(0, -1)}W`},
          {name: "DELETE", method: "DELETE", url: itemUrl, key: deleteKey, original: removed, otherUrl: `${orderPath(orderRef)}/items/${ref("itm").slice(0, -1)}W`},
          {name: "Confirm", method: "POST", url: confirmPath(orderRef), key: confirmKey, original: confirmed, otherUrl: confirmPath(ref("ord"))},
          {name: "Reconcile", method: "POST", url: reconcileUrl, key: reconcileKey, original: reconciled, otherUrl: `${orderPath(ref("ord"))}/commands/request-aroma-reconciliation`},
        ];
        // Use the command's actual idempotency key: no alternate key can imply its effect.
        for (const entry of cases) {
          assert.notEqual(entry.otherUrl, entry.url, `${entry.name}: alternate path must be distinct`);
          entry.scope = createHash("sha256").update(`${entry.method}\n${entry.url}`).digest("hex");
          const stored = await adminClient.query("SELECT resource_ref, response_status FROM orders.idempotency_records WHERE actor_ref=$1 AND scope=$2 AND idempotency_key=$3",
            ["live-owner-actor-a", entry.scope, entry.key]);
          assert.deepEqual(stored.rows, [{resource_ref: orderRef, response_status: entry.original.statusCode}], entry.name);
        }
        const lookupKeys = new Set(cases.map(entry => entry.key));
        const check = async (entry, expectedStatus, expectedCode, {key = entry.key, token = actor,
          url = entry.url, method = entry.method, replayOnly = true, payload, extraHeaders = {}} = {}) => {
          lookupKeys.add(key);
          const before = await snapshot();
          const beforeCalls = {...counters, signs};
          const beforeLookups = runtime.getReplayLookups();
          const beforeSignals = {spans: spans.length, metrics: measurements.length, logs: logChunks.length};
          const currentCorrelation = randomUUID();
          const response = await replayApp.inject({method, url, headers: {
            ...requestHeaders(token, key), "x-correlation-id": currentCorrelation,
            ...(replayOnly ? {"idempotency-replay-only": "true"} : {}), ...extraHeaders,
          }, ...(payload === undefined ? {} : {payload})});
          assert.equal(response.statusCode, expectedStatus, `${entry.name}: ${expectedCode ?? "Completed"}: ${response.body}`);
          assert.equal(response.headers["cache-control"], "no-store", entry.name);
          assert.equal(response.headers["x-correlation-id"], currentCorrelation, entry.name);
          assert.equal(response.headers["idempotency-replayed"], expectedCode === undefined ? "true" : undefined, entry.name);
          if (expectedCode === undefined) assert.deepEqual(response.json(), entry.original.json(), entry.name);
          else {
            assert.equal(response.json().code, expectedCode, entry.name);
            assert.ok(!response.body.includes(piiCanary) && !response.body.includes(key), `${entry.name}: error body must not expose canaries`);
          }
          assert.deepEqual(await snapshot(), before, `${entry.name}: lookup must not write owner/History/Outbox/idempotency rows`);
          assert.deepEqual({...counters, signs}, beforeCalls, `${entry.name}: lookup must not call Customer/Pricing or sign a business request`);
          assert.equal(runtime.getReplayLookups() - beforeLookups, expectedCode === "ACTOR_CONTEXT_INVALID" || expectedCode === "VALIDATION_FAILED" ? 0 : 1);
          const recentSpans = spans.slice(beforeSignals.spans);
          const recentMetrics = measurements.slice(beforeSignals.metrics);
          const recentLogs = logChunks.slice(beforeSignals.logs);
          assert.ok(recentSpans.some(span => span.name.startsWith("orders.http.") && span.ended), `${entry.name}: missing HTTP span`);
          if (replayOnly && expectedCode !== "ACTOR_CONTEXT_INVALID" && expectedCode !== "VALIDATION_FAILED") {
            assert.ok(recentSpans.some(span => span.name === "orders.transaction.replay" && span.ended), `${entry.name}: missing lookup span`);
            assert.ok(recentMetrics.some(row => row.name === "orders.operation.total" && row.attributes["orders.operation"] === "orders.transaction.replay"), `${entry.name}: missing lookup metric`);
          }
          assert.ok(recentLogs.some(chunk => chunk.includes('"msg":"incoming request"') && chunk.includes(currentCorrelation)), `${entry.name}: missing correlated request log`);
          const emitted = JSON.stringify({spans: recentSpans, metrics: recentMetrics, logs: recentLogs});
          for (const canary of [piiCanary, ...lookupKeys]) assert.ok(!emitted.includes(canary), `${entry.name}: telemetry/logs leaked a canary`);
        };
        for (const entry of cases) {
          await check(entry, entry.original.statusCode);
          await check(entry, entry.original.statusCode);
          for (const expired of [false, true]) {
            const key = randomUUID();
            await adminClient.query(`INSERT INTO orders.idempotency_records
              (actor_ref,scope,idempotency_key,request_hash,state,lease_owner,lease_until,created_at,expires_at)
              VALUES ('live-owner-actor-a',$1,$2,$3,'Acquired',$4,
                clock_timestamp() + CASE WHEN $5::boolean THEN interval '-1 hour' ELSE interval '1 hour' END,
                clock_timestamp() - interval '2 hours',clock_timestamp() + interval '2 hours')`,
            [entry.scope, key, hash("a"), randomUUID(), expired]);
            await check(entry, 409, "IDEMPOTENCY_REQUEST_IN_PROGRESS", {key});
          }
          await check(entry, 410, "IDEMPOTENCY_RESULT_NOT_RETAINED", {key: randomUUID()});
          for (const variant of ["expired", "invalid-body", "invalid-expiry"]) {
            const key = randomUUID();
            await adminClient.query(`INSERT INTO orders.idempotency_records
              (actor_ref,scope,idempotency_key,request_hash,state,lease_owner,lease_until,created_at,expires_at,
                completed_at,response_status,response_body,resource_ref)
              SELECT actor_ref,scope,$2,request_hash,state,lease_owner,lease_until,created_at,expires_at,
                completed_at,response_status,response_body,resource_ref
              FROM orders.idempotency_records WHERE idempotency_key=$1`, [entry.key, key]);
            if (variant === "invalid-body") await adminClient.query("UPDATE orders.idempotency_records SET response_body=$2::jsonb WHERE idempotency_key=$1", [key, JSON.stringify({corrupt: piiCanary, key})]);
            else if (variant === "invalid-expiry") await adminClient.query("UPDATE orders.idempotency_records SET lease_until='infinity'::timestamptz,expires_at='infinity'::timestamptz WHERE idempotency_key=$1", [key]);
            else await adminClient.query(`UPDATE orders.idempotency_records SET created_at=clock_timestamp()-interval '3 hours',
              lease_until=clock_timestamp()-interval '2 hours',expires_at=clock_timestamp()-interval '1 hour'
              WHERE idempotency_key=$1`, [key]);
            await check(entry, variant === "expired" ? 410 : 500, variant === "expired" ? "IDEMPOTENCY_RESULT_NOT_RETAINED" : "IDEMPOTENCY_RESULT_INVALID", {key});
          }
          await check(entry, 410, "IDEMPOTENCY_RESULT_NOT_RETAINED", {token: "synthetic-api-public-actor-b-all"});
          await check(entry, 410, "IDEMPOTENCY_RESULT_NOT_RETAINED", {url: entry.otherUrl});
          if (entry.name === "PUT" || entry.name === "DELETE") {
            await check(entry, 410, "IDEMPOTENCY_RESULT_NOT_RETAINED", {method: entry.name === "PUT" ? "DELETE" : "PUT"});
          }
          // Denial precedes the lookup and leaves the owner completely unchanged.
          await check(entry, 403, "ACTOR_CONTEXT_INVALID", {token: "synthetic-api-public-no-confirm"});
          await check(entry, 400, "VALIDATION_FAILED", {payload: {expectedVersion: "1"}});
          await check(entry, 400, "VALIDATION_FAILED", {extraHeaders: {"if-match-version": "1"}});
          await check(entry, 400, "VALIDATION_FAILED", {replayOnly: false});
        }
        await adminClient.query("REVOKE SELECT ON orders.idempotency_records FROM coffee_orders_service_rw");
        try {
          for (const entry of cases) await check(entry, 503, "IDEMPOTENCY_LOOKUP_UNAVAILABLE");
        } finally {
          await adminClient.query("GRANT SELECT ON orders.idempotency_records TO coffee_orders_service_rw");
        }
        assert.ok(spans.some(span => span.name === "orders.transaction.replay" && span.ended));
        assert.ok(measurements.some(row => row.name === "orders.operation.total" && row.attributes["orders.operation"] === "orders.transaction.replay"));
        assert.ok(logChunks.some(chunk => chunk.includes('"msg":"incoming request"')), "must capture actual Fastify logs");
        const telemetry = JSON.stringify({spans: spans.map(({name, attributes, status}) => ({name, attributes, status})), measurements});
        const logs = logChunks.join("");
        for (const canary of [piiCanary, ...lookupKeys]) {
          assert.ok(!telemetry.includes(canary), "lookup telemetry must not contain private facts or idempotency key");
          assert.ok(!logs.includes(canary), "lookup logs must not contain private facts or idempotency key");
        }
        // Key storage in orders.idempotency_records is normative, not a redaction failure.
        for (const table of ["order_history", "outbox_messages"]) {
          const rows = JSON.stringify((await snapshot())[table]);
          assert.ok(cases.every(entry => !rows.includes(entry.key)), `${table} must not copy an idempotency key`);
          assert.ok(!rows.includes(piiCanary), `${table} must not copy customer PII`);
        }
      } finally {
        if (runtime !== undefined) await runtime.app.runtimeController.closeRuntime("SIGTERM");
        await database.resource.stop(AbortSignal.timeout(5_000));
      }
    });
  } finally {
    process.stdout.write = originalWrite;
  }
});
