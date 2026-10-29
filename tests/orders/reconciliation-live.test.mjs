import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createRuntime } from "../../packages/platform-runtime/src/index.ts";
import { createDatabase } from "../../packages/platform-database/dist/index.js";
import {
  canonicalJson,
  canonicalRequestHash,
} from "../../packages/platform-idempotency/dist/index.js";
import { registerOrdersRoutes } from "../../apps/orders-service/dist/http/index.js";
import { OrderStore } from "../../apps/orders-service/dist/infrastructure/database/order-store.js";
import { withCatalogPostgres } from "../../scripts/catalog-live-harness.mjs";

const root = new URL("../../", import.meta.url);
const migrations = [
  "0001_create_orders.sql",
  "0002_create_order_items.sql",
  "0003_create_order_history.sql",
  "0004_create_order_contributions.sql",
  "0005_create_orders_idempotency.sql",
  "0006_create_orders_outbox.sql",
  "0007_order_grind_selection.sql",
  "0008_create_orders_inbox.sql",
  "0009_create_catalog_mapping_projection.sql",
  "0010_create_cart_desired.sql",
  "0011_create_cart_observed.sql",
  "0012_create_convergence_attempts.sql",
  "0013_create_convergence_leases.sql",
  "0014_create_mutation_reservations.sql",
  "0015_create_order_aroma_projections.sql",
  "0016_create_aroma_work_schedules.sql",
  "0017_allow_cart_outbox.sql",
  "0018_guard_order_card_projection.sql",
  "0019_read_guarded_aroma_card.sql",
  "0020_guard_cart_fact_batches.sql",
  "0021_optimize_observed_format_checks.sql",
  "0022_terminal_cart_item_rejection.sql",
  "0023_ascii_observed_identity.sql",
];
const pool = {
  max: 4,
  checkoutTimeoutMs: 2000,
  lockTimeoutMs: 1000,
  interactiveStatementTimeoutMs: 5000,
  backgroundStatementTimeoutMs: 10000,
  terminalTimeoutMs: 3000,
  transactionTimeoutMs: 20000,
  idleTimeoutMs: 30000,
  maxLifetimeMs: 1800000,
};
const cid = randomUUID();
const traceparent = "00-11111111111111111111111111111111-2222222222222222-01";
const customer = "cus_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const path = (ref) =>
  `/api/client-v1/orders/${ref}/commands/request-aroma-reconciliation`;
const headers = (key = randomUUID(), actor = "a") => ({
  "x-correlation-id": cid,
  traceparent,
  "x-actor-context": actor,
  "idempotency-key": key,
});
const request = (
  ref,
  key,
  expectedVersion = "2",
  actor = "a",
  reason = "operator request",
) => ({
  method: "POST",
  url: path(ref),
  headers: headers(key, actor),
  payload: { expectedVersion, reason },
});
const poolFactory = (databaseName, port, password) =>
  createDatabase({
    owner: "orders-reconciliation-test",
    database: databaseName,
    allowedDatabase: databaseName,
    host: "127.0.0.1",
    port,
    user: "coffee_orders_service_rw",
    password,
    ssl: false,
    pool,
    shutdownGraceMs: 40000,
  });

async function startApp(database, network) {
  const store = new OrderStore(database, { maxSnapshotAgeMs: 15000 });
  const app = await createRuntime({
    name: "orders-reconciliation-test",
    host: "127.0.0.1",
    port: 0,
    shutdownGraceMs: 5000,
    deadlineMs: 10000,
    deadlineProfiles: { defaultMs: 10000 },
  });
  registerOrdersRoutes(app, {
    verifyTransport: () => true,
    verifyPublicDelegation: async (token, operation, correlationId) => ({
      iss: "api-public",
      aud: "orders-service",
      originalIssuer: "edge-gateway",
      sub: token === "b" ? "actor-b" : "actor-a",
      permissions: token === "revoked" ? [] : ["orders:reconcile:any"],
      operationId: operation,
      correlationId,
      traceparent,
    }),
    signInternalDelegation: () => {
      network.calls++;
      throw new Error("network under lock");
    },
    owner: {
      store,
      customer: {
        getOrderInput: async () => {
          network.calls++;
          throw new Error("Customer under lock");
        },
      },
      pricing: {
        verify: async () => {
          network.calls++;
          throw new Error("Pricing under lock");
        },
      },
    },
  });
  await app.runtimeController.start();
  return app;
}

async function fixture(run) {
  await withCatalogPostgres(async ({ adminClient, port, databaseName }) => {
    const password = `orders-${randomUUID().replaceAll("-", "")}`;
    await adminClient.query(
      `CREATE ROLE coffee_orders_service_rw LOGIN PASSWORD '${password}'`,
    );
    for (const role of [
      "coffee_orders_prepare_rw",
      "coffee_orders_observer_rw",
      "coffee_orders_convergence_rw",
    ])
      await adminClient.query(`CREATE ROLE ${role} NOLOGIN`);
    for (const name of migrations)
      await adminClient.query(
        await readFile(
          new URL(`apps/orders-service/migrations/${name}`, root),
          "utf8",
        ),
      );
    const database = poolFactory(databaseName, port, password);
    await database.resource.start(AbortSignal.timeout(5000));
    const project = async (ref, state) => {
      await adminClient.query(
        "SELECT * FROM orders.write_card_projection($1,$2::jsonb)",
        [
          ref,
          JSON.stringify({
            order_ref: ref,
            cart_scope_ref: "aroma-primary",
            desired_revision: "0",
            desired_hash: null,
            observed_revision: "0",
            observed_cart_fingerprint: null,
            verified_desired_revision: null,
            verified_desired_hash: null,
            verified_observed_revision: null,
            verified_cart_fingerprint: null,
            attempt_ref: null,
            verified_attempt_ref: null,
            fence_epoch: null,
            state,
            blocker_codes:
              state === "UnknownOutcome" ? ["AROMA_UNKNOWN_OUTCOME"] : [],
            last_observed_at: null,
            source_message_id: "persisted-card-fixture",
          }),
        ],
      );
    };
    const network = { calls: 0 };
    const apps = [];
    const seed = async (version = "2") => {
      const ref = `ord_${randomUUID()
        .replaceAll("-", "")
        .slice(0, 26)
        .toUpperCase()
        .replaceAll(/[ILOU]/gu, "A")}`;
      await adminClient.query(
        `INSERT INTO orders.orders(order_ref,status,version,projection_version,customer_ref,customer_version,customer_display_name,customer_state,customer_state_proof_hash,currency,confirmed_at,created_by_actor_ref,last_modified_by_actor_ref) VALUES($1,'Confirmed',$2,$2,$3,1,'Ada','Active',$4,'RUB',transaction_timestamp(),'actor-a','actor-a')`,
        [ref, version, customer, "a".repeat(64)],
      );
      return ref;
    };
    const start = async () => {
      const app = await startApp(database, network);
      apps.push(app);
      return app;
    };
    const stop = async (app) => {
      await app.runtimeController.closeRuntime("SIGTERM");
      apps.splice(apps.indexOf(app), 1);
    };
    try {
      await run({ adminClient, database, project, network, seed, start, stop });
    } finally {
      for (const app of apps.reverse())
        await app.runtimeController.closeRuntime("SIGTERM");
      await database.resource.stop(AbortSignal.timeout(40000));
    }
  });
}

const live = {
  timeout: 180000,
  skip:
    process.env.COFFEE_DB_LIVE_PROOF !== "1"
      ? "set COFFEE_DB_LIVE_PROOF=1"
      : false,
};

void test(
  "live reconciliation accepts persisted owner-local OutOfSync atomically and replays exact 202 across restart",
  live,
  async () =>
    fixture(async ({ adminClient, project, network, seed, start, stop }) => {
      const ref = await seed();
      await project(ref, "OutOfSync");
      const app = await start();
      const key = randomUUID();
      const accepted = await app.inject(request(ref, key));
      assert.equal(accepted.statusCode, 202, accepted.body);
      assert.equal(accepted.headers["idempotency-replayed"], undefined);
      const body = accepted.json();
      assert.deepEqual(
        Object.keys(body).sort(),
        ["aromaState", "orderRef", "orderVersion", "requestedAt"].sort(),
      );
      assert.deepEqual(
        {
          orderRef: body.orderRef,
          orderVersion: body.orderVersion,
          aromaState: body.aromaState,
        },
        { orderRef: ref, orderVersion: "3", aromaState: "OutOfSync" },
      );
      const saved = await adminClient.query(
        `SELECT o.version::text AS version,o.projection_version::text AS projection_version,h.event_type,h.facts,m.* FROM orders.orders o JOIN orders.order_history h USING(order_ref) JOIN orders.outbox_messages m ON m.aggregate_ref=o.order_ref WHERE o.order_ref=$1`,
        [ref],
      );
      assert.equal(saved.rows.length, 1);
      const row = saved.rows[0];
      assert.equal(row.version, "3");
      assert.equal(row.projection_version, "4");
      assert.equal(row.event_type, "ReconciliationRequested");
      assert.deepEqual(row.facts, { requestKind: "OperatorRequested" });
      assert.equal(row.topic, "coffee.orders.lifecycle.v1");
      assert.equal(row.partition_key, ref);
      assert.equal(row.message_type, "OrderReconciliationRequested.v1");
      assert.equal(row.aggregate_sequence, "1");
      assert.deepEqual(row.payload, {
        orderRef: ref,
        orderVersion: "3",
        requestedAt: body.requestedAt,
      });
      assert.equal(row.envelope.producer, "orders-service");
      assert.equal(row.envelope.messageId, row.message_id);
      assert.equal(row.envelope.aggregate.version, "3");
      assert.equal(
        row.envelope_bytes.toString("utf8"),
        canonicalJson(row.envelope),
      );
      assert.equal(
        row.envelope_hash,
        createHash("sha256").update(row.envelope_bytes).digest("hex"),
      );
      assert.equal(row.payload_hash, canonicalRequestHash(row.envelope));
      assert.equal(network.calls, 0);
      const ordinary = await app.inject(request(ref, key));
      assert.equal(ordinary.statusCode, 202);
      assert.deepEqual(ordinary.json(), body);
      assert.equal(ordinary.headers["idempotency-replayed"], "true");
      await stop(app);
      const restarted = await start();
      const replay = await restarted.inject({
        method: "POST",
        url: path(ref),
        headers: { ...headers(key), "idempotency-replay-only": "true" },
      });
      assert.equal(replay.statusCode, 202, replay.body);
      assert.deepEqual(replay.json(), body);
      assert.equal(replay.headers["idempotency-replayed"], "true");
      const mismatched = await restarted.inject(
        request(ref, key, "2", "a", "different reason"),
      );
      assert.equal(mismatched.statusCode, 409);
      assert.equal(mismatched.json().code, "IDEMPOTENCY_CONFLICT");
      const wrongActor = await restarted.inject({
        method: "POST",
        url: path(ref),
        headers: { ...headers(key, "b"), "idempotency-replay-only": "true" },
      });
      assert.equal(wrongActor.statusCode, 410);
      const revoked = await restarted.inject({
        method: "POST",
        url: path(ref),
        headers: {
          ...headers(key, "revoked"),
          "idempotency-replay-only": "true",
        },
      });
      assert.equal(revoked.statusCode, 403);
      assert.equal(network.calls, 0);
    }),
);

void test(
  "pending observation and absent projection refuse 202 without history, outbox or idempotency effects",
  live,
  async () =>
    fixture(async ({ adminClient, project, seed, start }) => {
      const ref = await seed();
      const pending = await seed();
      await project(pending, "PendingObservation");
      const app = await start();
      for (const order of [ref, pending]) {
        const response = await app.inject(request(order, randomUUID()));
        assert.equal(response.statusCode, 409, response.body);
        assert.equal(response.json().code, "AROMA_RECONCILIATION_NOT_ALLOWED");
      }
      const count = await adminClient.query(
        `SELECT (SELECT version FROM orders.orders WHERE order_ref=$1)::text AS version,(SELECT count(*) FROM orders.order_history WHERE order_ref=$1)::int AS history,(SELECT count(*) FROM orders.outbox_messages WHERE aggregate_ref=$1)::int AS outbox,(SELECT count(*) FROM orders.idempotency_records WHERE resource_ref=$1)::int AS completed`,
        [ref],
      );
      assert.deepEqual(count.rows[0], {
        version: "2",
        history: 0,
        outbox: 0,
        completed: 0,
      });
    }),
);

void test(
  "confirmed status, expectedVersion and persisted Card state must agree before any write",
  live,
  async () =>
    fixture(async ({ adminClient, project, seed, start }) => {
      const ref = await seed();
      await project(ref, "OutOfSync");
      const app = await start();
      const stale = await app.inject(request(ref, randomUUID(), "1"));
      assert.equal(stale.statusCode, 409);
      assert.equal(stale.json().code, "ORDER_VERSION_CONFLICT");
      await project(ref, "PendingObservation");
      const drift = await app.inject(request(ref, randomUUID()));
      assert.equal(drift.statusCode, 409);
      assert.equal(drift.json().code, "AROMA_RECONCILIATION_NOT_ALLOWED");
      const draft = `ord_${randomUUID()
        .replaceAll("-", "")
        .slice(0, 26)
        .toUpperCase()
        .replaceAll(/[ILOU]/gu, "A")}`;
      await adminClient.query(
        `INSERT INTO orders.orders(order_ref,customer_ref,customer_version,customer_display_name,customer_state,customer_state_proof_hash,created_by_actor_ref,last_modified_by_actor_ref) VALUES($1,$2,1,'Ada','Active',$3,'actor-a','actor-a')`,
        [draft, customer, "a".repeat(64)],
      );
      const notConfirmed = await app.inject(request(draft, randomUUID(), "1"));
      assert.equal(notConfirmed.statusCode, 409);
      assert.equal(
        notConfirmed.json().code,
        "AROMA_RECONCILIATION_NOT_ALLOWED",
      );
      const counts = await adminClient.query(
        `SELECT (SELECT count(*) FROM orders.order_history)::int AS history,(SELECT count(*) FROM orders.outbox_messages)::int AS outbox,(SELECT count(*) FROM orders.idempotency_records)::int AS idempotency`,
      );
      assert.deepEqual(counts.rows[0], {
        history: 0,
        outbox: 0,
        idempotency: 0,
      });
    }),
);

void test(
  "corrupted completed reconciliation status or resource cannot be replayed as 202",
  live,
  async () =>
    fixture(async ({ adminClient, project, seed, start }) => {
      const ref = await seed();
      await project(ref, "OutOfSync");
      const app = await start();
      const key = randomUUID();
      assert.equal((await app.inject(request(ref, key))).statusCode, 202);
      const bodyless = () =>
        app.inject({
          method: "POST",
          url: path(ref),
          headers: { ...headers(key), "idempotency-replay-only": "true" },
        });
      await adminClient.query(
        `UPDATE orders.idempotency_records SET response_status=200 WHERE idempotency_key=$1`,
        [key],
      );
      assert.equal(
        (await app.inject(request(ref, key))).json().code,
        "IDEMPOTENCY_RESULT_INVALID",
      );
      assert.equal(
        (await bodyless()).json().code,
        "IDEMPOTENCY_RESULT_INVALID",
      );
      await adminClient.query(
        `UPDATE orders.idempotency_records SET response_status=202,resource_ref=$2 WHERE idempotency_key=$1`,
        [key, customer],
      );
      assert.equal(
        (await app.inject(request(ref, key))).json().code,
        "IDEMPOTENCY_RESULT_INVALID",
      );
      assert.equal(
        (await bodyless()).json().code,
        "IDEMPOTENCY_RESULT_INVALID",
      );
      const rows = await adminClient.query(
        `SELECT count(*)::int AS count FROM orders.outbox_messages`,
      );
      assert.equal(rows.rows[0].count, 1);
    }),
);

void test(
  "concurrent fresh keys on the same expected version have one durable winner",
  live,
  async () =>
    fixture(async ({ adminClient, project, seed, start }) => {
      const ref = await seed();
      await project(ref, "Blocked");
      const app = await start();
      const responses = await Promise.all([
        app.inject(request(ref, randomUUID())),
        app.inject(request(ref, randomUUID())),
      ]);
      assert.deepEqual(
        responses.map((r) => r.statusCode).sort((a, b) => a - b),
        [202, 409],
      );
      assert.equal(
        responses.find((r) => r.statusCode === 409).json().code,
        "ORDER_VERSION_CONFLICT",
      );
      const rows = await adminClient.query(
        "SELECT count(*)::int AS count FROM orders.outbox_messages WHERE aggregate_ref=$1",
        [ref],
      );
      assert.equal(rows.rows[0].count, 1);
    }),
);

void test(
  "outbox insert failure rolls back order, history, and acquired idempotency",
  live,
  async () =>
    fixture(async ({ adminClient, project, seed, start }) => {
      const ref = await seed();
      await project(ref, "UnknownOutcome");
      await adminClient.query(
        `CREATE FUNCTION orders.test_reject_reconciliation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.message_type='OrderReconciliationRequested.v1' THEN RAISE EXCEPTION 'fault injection'; END IF; RETURN NEW; END $$`,
      );
      await adminClient.query(
        `CREATE TRIGGER test_reject_reconciliation BEFORE INSERT ON orders.outbox_messages FOR EACH ROW EXECUTE FUNCTION orders.test_reject_reconciliation()`,
      );
      const app = await start();
      const failed = await app.inject(request(ref, randomUUID()));
      assert.equal(failed.statusCode, 500);
      const count = await adminClient.query(
        `SELECT (SELECT version FROM orders.orders WHERE order_ref=$1)::text AS version,(SELECT count(*) FROM orders.order_history WHERE order_ref=$1)::int AS history,(SELECT count(*) FROM orders.outbox_messages WHERE aggregate_ref=$1)::int AS outbox,(SELECT count(*) FROM orders.idempotency_records)::int AS idempotency`,
        [ref],
      );
      assert.deepEqual(count.rows[0], {
        version: "2",
        history: 0,
        outbox: 0,
        idempotency: 0,
      });
    }),
);
