import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import {
  canonicalJson,
  canonicalRequestHash,
} from "../../packages/platform-idempotency/dist/index.js";
import { createSqlOutboxStore } from "../../packages/platform-outbox/dist/index.js";
import { processKafkaRecord } from "../../packages/platform-kafka-runtime/dist/index.js";
import { Client } from "pg";
import {
  createDatabase,
  withTransaction,
} from "../../packages/platform-database/dist/index.js";
import { defineStatement } from "../../packages/platform-database/dist/owner.js";
import { withCatalogPostgres } from "../../scripts/catalog-live-harness.mjs";
import { openBlackholeProxy } from "../../scripts/db-live-proof.mjs";

void test("preparation has an executable owner-local store and bundled decoder", async () => {
  const store =
    await import("../../apps/orders-aroma-preparation/dist/infrastructure/preparation-store.js");
  const messages =
    await import("../../apps/orders-aroma-preparation/dist/application/messages.js");
  assert.equal(typeof store.createAromaPreparationStore, "function");
  assert.equal(typeof messages.decodeAromaPreparationEnvelope, "function");
});

void test("all three AROMA worker composition roots are importable without runtime boot or secret access", async () => {
  for (const [runtime, name] of [
    ["orders-aroma-preparation", "createAromaPreparationComposition"],
    ["aroma-observer", "createAromaObserverComposition"],
    ["aroma-convergence", "createAromaConvergenceComposition"],
  ]) {
    const module = await import(
      `../../apps/${runtime}/dist/runtime-composition.js`
    );
    assert.equal(typeof module[name], "function");
    const composition = module[name]();
    assert.equal(typeof composition.configure, "function");
    assert.equal(composition.resources.length, 1);
    assert.equal(composition.readinessChecks[0].check(), false);
    assert.equal(typeof composition.resources[0].stop, "function");
    assert.equal(typeof composition.resources[0].destroy, "function");
  }
});

import {
  DATABASE,
  ROLE,
  ROLES,
  MIGRATIONS,
  pool,
  ref,
  customer,
  mapping,
  product,
  trace,
  live,
  fixture,
} from "../observability/orders-fixture.mjs";

// A prerequisite gate, not a substitute for the preparation-store behavioral proofs.
// Keep the required SELECT positive: expecting a denial would hide the broken contract.
void test(
  "preparation projection prerequisites: real runtime login on frozen Orders migrations",
  {
    timeout: 180_000,
    skip:
      process.env.COFFEE_DB_LIVE_PROOF !== "1"
        ? "disposable PostgreSQL required"
        : false,
  },
  async (t) => {
    const receipt = await withCatalogPostgres(async ({ adminClient, port }) => {
      const passwords = new Map();
      for (const role of ROLES) {
        const password = randomBytes(24).toString("hex");
        passwords.set(role, password);
        await adminClient.query(
          `CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`,
        );
      }
      await adminClient.query(
        `CREATE DATABASE ${DATABASE} OWNER coffee_orders_migrator`,
      );
      await adminClient.query(`REVOKE ALL ON DATABASE ${DATABASE} FROM PUBLIC`);
      await adminClient.query(
        `GRANT CONNECT ON DATABASE ${DATABASE} TO ${ROLE}`,
      );
      const migrator = new Client({
        host: "127.0.0.1",
        port,
        database: DATABASE,
        user: "coffee_orders_migrator",
        password: passwords.get("coffee_orders_migrator"),
        connectionTimeoutMillis: 2_000,
        ssl: false,
      });
      let database;
      try {
        await migrator.connect();
        await migrator.query("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
        for (const id of MIGRATIONS) {
          await migrator.query(
            await readFile(
              new URL(
                `../../apps/orders-service/migrations/${id}.sql`,
                import.meta.url,
              ),
              "utf8",
            ),
          );
        }
        database = createDatabase({
          owner: "orders-aroma-preparation",
          database: DATABASE,
          allowedDatabase: DATABASE,
          host: "127.0.0.1",
          port,
          user: ROLE,
          password: passwords.get(ROLE),
          ssl: false,
          pool,
          shutdownGraceMs: 40_000,
        });
        await database.resource.start(new AbortController().signal);
        const tx = (callback) =>
          withTransaction(database, { mode: "background" }, callback);
        const identity = defineStatement(
          database,
          "SELECT current_user AS role, rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user",
        );
        const desired = defineStatement(
          database,
          "SELECT * FROM orders.cart_desired_revisions LIMIT 0",
        );
        const observed = defineStatement(
          database,
          "SELECT * FROM orders.cart_observed_revisions LIMIT 0",
        );
        const attempts = defineStatement(
          database,
          "SELECT * FROM orders.convergence_attempts LIMIT 0",
        );
        const coreWrite = defineStatement(
          database,
          "UPDATE orders.orders SET version=version WHERE false",
        );
        const barrier = defineStatement(
          database,
          `SELECT NOT EXISTS (
        SELECT 1 FROM orders.mutation_reservations WHERE cart_scope_ref = $1
          AND state IN ('Reserved','Dispatched','Acknowledged','UnknownOutcome')
      ) AS clear`,
        );
        await t.test(
          "login is preparation role, not migration/admin/bypass role; persisted D/O/Attempt readable",
          async () => {
            await tx(async (transaction) => {
              assert.deepEqual((await identity(transaction, [])).rows, [
                { role: ROLE, rolsuper: false, rolbypassrls: false },
              ]);
              for (const statement of [desired, observed, attempts]) {
                assert.equal((await statement(transaction, [])).rowCount, 0);
              }
            });
          },
        );
        await t.test(
          "preparation runtime cannot UPDATE core Order",
          async () => {
            await assert.rejects(
              tx((transaction) => coreWrite(transaction, [])),
              (error) =>
                error.code === "DB_QUERY_FAILED" && error.sqlState === "42501",
            );
          },
        );
        await t.test(
          "projection can inspect unresolved reservation barrier before claiming InSync",
          async () => {
            try {
              const result = await tx((transaction) =>
                barrier(transaction, ["aroma-primary"]),
              );
              assert.deepEqual(result.rows, [{ clear: true }]);
            } catch (error) {
              t.diagnostic(
                `BLOCKER: role=${ROLE}; query=unresolved reservation barrier; code=${error.code}; sqlState=${error.sqlState}`,
              );
              throw error;
            }
          },
        );
        return { migrationCount: MIGRATIONS.length, runtimeRole: ROLE };
      } finally {
        if (database) await database.resource.stop(AbortSignal.timeout(5_000));
        await migrator.end();
      }
    });
    assert.equal(receipt.cleanup.containerRemoved, true);
    t.diagnostic(
      "Disposable PostgreSQL removed; no production/provider access",
    );
  },
);

void test(
  "preparation Desired/mapping/Inbox semantics on real runtime role",
  live,
  async (t) => {
    await fixture(async (f) => {
      const a = product();
      const b = { ...product(), offer: a.offer };
      const grind = "b".repeat(64);
      const firstMapping = mapping(a);
      await t.test(
        "mapping may precede Confirm without inventing an empty/zero Desired",
        async () => {
          await f.deliver(firstMapping);
          await f.deliver(mapping(b));
          assert.equal(await f.current(), undefined);
          assert.equal(
            (await f.read("SELECT * FROM orders.convergence_work")).length,
            0,
          );
        },
      );
      const one = await f.seed([{ ...a, quantity: "2000" }]);
      const two = await f.seed([
        { ...b, quantity: "3000" },
        { ...b, quantity: "1000", grind },
      ]);
      await t.test(
        "all Current contributions add by frozen offer plus NULL-sensitive grind",
        async () => {
          await f.deliver(one.confirmed);
          assert.deepEqual(
            await f.read(
              "SELECT offer_ref,source_grind_key_hash,quantity_milli::text FROM orders.cart_desired_lines ORDER BY source_grind_key_hash NULLS FIRST",
            ),
            [
              {
                offer_ref: a.offer,
                source_grind_key_hash: null,
                quantity_milli: "5000",
              },
              {
                offer_ref: a.offer,
                source_grind_key_hash: grind,
                quantity_milli: "1000",
              },
            ],
          );
          assert.equal(
            (await f.read("SELECT * FROM orders.cart_desired_order_facts"))
              .length,
            2,
          );
          assert.equal((await f.card(one.order)).state, "PendingObservation");
          assert.equal((await f.card(one.order)).business_version, "2");
          assert.equal((await f.card(one.order)).card_version, "3");
          const bytes = await f.read(
            "SELECT envelope_bytes,envelope_hash,envelope FROM orders.outbox_messages",
          );
          for (const row of bytes) {
            assert.deepEqual(
              JSON.parse(Buffer.from(row.envelope_bytes).toString("utf8")),
              row.envelope,
            );
            assert.equal(
              createHash("sha256").update(row.envelope_bytes).digest("hex"),
              row.envelope_hash,
            );
          }
        },
      );
      const before = await f.current();
      const counts = async () =>
        (
          await f.read(
            "SELECT (SELECT count(*) FROM orders.outbox_messages)::int AS outbox,(SELECT count(*) FROM orders.order_aroma_projection_history)::int AS history",
          )
        )[0];
      const baseline = await counts();
      await t.test(
        "duplicate, restart, concurrent recompute and same semantic mapping do not bump Card or Desired",
        async () => {
          await f.deliver(one.confirmed);
          await f.deliver(two.confirmed);
          await f.restart();
          await Promise.all([
            f.store.recover(new AbortController().signal),
            f.store.runOnce(new AbortController().signal),
          ]);
          await f.deliver(mapping(a, "2"));
          assert.deepEqual(await f.current(), before);
          assert.deepEqual(await counts(), baseline);
        },
      );
      await t.test(
        "same message ID with changed payload is durably quarantined by real consumer-keyed Inbox",
        async () => {
          const conflict = {
            ...firstMapping,
            payload: { ...firstMapping.payload, availability: "Unavailable" },
          };
          await f.deliver(conflict);
          assert.deepEqual(
            await f.read(
              "SELECT reason FROM orders.inbox_quarantine WHERE message_id=$1",
              [firstMapping.messageId],
            ),
            [{ reason: "MESSAGE_ID_PAYLOAD_CONFLICT" }],
          );
          assert.deepEqual(await f.current(), before);
        },
      );
      await t.test(
        "bundled-invalid message is quarantined before owner effects or Inbox processing",
        async () => {
          const bad = { ...mapping(a, "3"), producer: "orders-service" };
          const record = await f.deliver(bad);
          assert.deepEqual(
            await f.read(
              'SELECT reason FROM orders.inbox_quarantine WHERE "offset"=$1',
              [record.offset],
            ),
            [{ reason: "KAFKA_ENVELOPE_INVALID" }],
          );
          assert.equal(
            (
              await f.read(
                "SELECT * FROM orders.inbox_messages WHERE message_id=$1",
                [bad.messageId],
              )
            ).length,
            0,
          );
          assert.deepEqual(await f.current(), before);
        },
      );
      await t.test(
        "lower mapping revision is terminally ignored; equal revision conflict is durably quarantined before offset commit",
        async () => {
          const stale = mapping(a, "1", { offerRef: ref("off") });
          await f.deliver(stale);
          assert.equal(
            (
              await f.read(
                "SELECT offer_ref FROM orders.catalog_mapping_projection WHERE product_ref=$1",
                [a.product],
              )
            )[0].offer_ref,
            a.offer,
          );
          const conflict = mapping(a, "2", { availability: "Unavailable" });
          const beforeCommits = f.commits();
          await f.deliver(conflict, {
            commit: async () => {
              assert.deepEqual(
                await f.read(
                  "SELECT state,quarantine_reason FROM orders.inbox_messages WHERE message_id=$1",
                  [conflict.messageId],
                ),
                [
                  {
                    state: "Quarantined",
                    quarantine_reason: "AROMA_MAPPING_REVISION_CONFLICT",
                  },
                ],
              );
              assert.deepEqual(
                await f.read(
                  "SELECT reason,envelope FROM orders.inbox_quarantine WHERE message_id=$1",
                  [conflict.messageId],
                ),
                [
                  {
                    reason: "AROMA_MAPPING_REVISION_CONFLICT",
                    envelope: conflict,
                  },
                ],
              );
              assert.deepEqual(await f.current(), before);
            },
          });
          assert.equal(f.commits(), beforeCommits + 1);
          await f.deliver(conflict);
          assert.equal(f.commits(), beforeCommits + 2);
          assert.equal(
            (
              await f.read(
                "SELECT * FROM orders.inbox_quarantine WHERE message_id=$1",
                [conflict.messageId],
              )
            ).length,
            1,
          );
          assert.deepEqual(await f.current(), before);
        },
      );
      await t.test(
        "key mismatch is durably quarantined with no owner effects",
        async () => {
          const wrong = mapping(a, "3");
          const beforeCommits = f.commits();
          await f.deliver(wrong, { record: { key: ref("prd") } });
          assert.equal(f.commits(), beforeCommits + 1);
          assert.deepEqual(
            await f.read(
              "SELECT state,quarantine_reason FROM orders.inbox_messages WHERE message_id=$1",
              [wrong.messageId],
            ),
            [
              {
                state: "Quarantined",
                quarantine_reason: "AROMA_PREPARATION_KEY_INVALID",
              },
            ],
          );
          assert.deepEqual(await f.current(), before);
        },
      );
      await t.test(
        "remap never rewrites frozen quote/contribution: exclude old physical key and retain impacted Order facts",
        async () => {
          const replacement = ref("off");
          await f.deliver(mapping(a, "3", { offerRef: replacement }));
          const now = await f.current();
          assert.equal(
            BigInt(now.desired_revision),
            BigInt(before.desired_revision) + 1n,
          );
          assert.deepEqual(
            await f.read(
              "SELECT offer_ref,quantity_milli::text FROM orders.cart_desired_lines WHERE desired_revision=$1 ORDER BY source_grind_key_hash NULLS FIRST",
              [now.desired_revision],
            ),
            [
              { offer_ref: b.offer, quantity_milli: "3000" },
              { offer_ref: b.offer, quantity_milli: "1000" },
            ],
          );
          assert.equal(
            (
              await f.read(
                "SELECT * FROM orders.cart_desired_order_facts WHERE desired_revision=$1",
                [now.desired_revision],
              )
            ).length,
            2,
          );
          assert.deepEqual((await f.card(one.order)).blocker_codes, [
            "MAPPING_CHANGED",
          ]);
          assert.equal(
            (await f.card(one.order)).desired_revision,
            now.desired_revision,
          );
          assert.equal(
            (
              await f.read(
                "SELECT offer_ref FROM orders.order_items WHERE order_ref=$1",
                [one.order],
              )
            )[0].offer_ref,
            a.offer,
          );
        },
      );
      await t.test(
        "Missing, Stopped, Unavailable and fractional quantity block positive Desired",
        async () => {
          for (const [state, availability, code] of [
            ["Missing", "Available", "MAPPING_MISSING"],
            ["Stopped", "Stopped", "MAPPING_STOPPED"],
            ["Active", "Unavailable", "PRODUCT_UNAVAILABLE"],
          ]) {
            await f.deliver(
              mapping(
                b,
                String(
                  4 +
                    [["Missing"], ["Stopped"], ["Active"]].findIndex(
                      (x) => x[0] === state,
                    ),
                ),
                {
                  mappingState: state,
                  availability,
                  offerRef: state === "Active" ? b.offer : null,
                },
              ),
            );
            const now = await f.current();
            assert.equal(
              (
                await f.read(
                  "SELECT * FROM orders.cart_desired_lines WHERE desired_revision=$1",
                  [now.desired_revision],
                )
              ).length,
              0,
            );
            assert.ok((await f.card(two.order)).blocker_codes.includes(code));
          }
          const fractional = product();
          await f.deliver(mapping(fractional));
          const bad = await f.seed([{ ...fractional, quantity: "1500" }]);
          await f.deliver(bad.confirmed);
          assert.ok(
            (await f.card(bad.order)).blocker_codes.includes(
              "AROMA_QUANTITY_NOT_SUPPORTED",
            ),
          );
          assert.equal(
            (
              await f.read(
                "SELECT * FROM orders.cart_desired_lines WHERE desired_revision=$1 AND offer_ref=$2",
                [(await f.current()).desired_revision, fractional.offer],
              )
            ).length,
            0,
          );
        },
      );
    });
  },
);

void test(
  "Confirm, preparation Realtime and repeated public reconciliation share one Order Outbox sequence",
  live,
  async () => {
    await fixture(async (f) => {
      const { OrderStore, customerSnapshotProofHash } =
        await import("../../apps/orders-service/dist/infrastructure/database/order-store.js");
      const { createRuntime } =
        await import("../../packages/platform-runtime/dist/index.js");
      const { registerOrdersRoutes } =
        await import("../../apps/orders-service/dist/http/index.js");
      const actorRef = "sequence-regression-actor";
      const orderRef = ref("ord"),
        itemRef = ref("itm"),
        item = product();
      const orders = new OrderStore(f.core, { maxSnapshotAgeMs: 60_000 });
      const customerProof = customerSnapshotProofHash({
        customerRef: customer,
        customerVersion: "1",
        displayName: "fixture",
        state: "Active",
      });
      await f.query(
        `INSERT INTO orders.orders(order_ref,status,version,projection_version,customer_ref,customer_version,customer_display_name,customer_state,customer_state_proof_hash,currency,created_by_actor_ref,last_modified_by_actor_ref)
      VALUES($1,'Draft',2,2,$2,1,'fixture','Active',$3,'RUB',$4,$4)`,
        [orderRef, customer, customerProof, actorRef],
      );
      const quoteRef = ref("prq");
      const quoteHash = canonicalRequestHash({ quoteRef });
      await f.query(
        `INSERT INTO orders.order_items(order_ref,item_ref,line_position,product_ref,variant_ref,product_display_name,unit,quantity_milli,quote_ref,quote_line_number,quote_hash,internal_proof_hash,quote_expires_at,policy_version_ref,catalog_snapshot_revision,mapping_revision,offer_ref,unit_minor,line_total_minor,currency)
      VALUES($1,$2,1,$3,$4,'fixture','piece',1000,$5,1,$6,$6,clock_timestamp()+interval '1 hour',$7,1,1,$8,100,100,'RUB')`,
        [
          orderRef,
          itemRef,
          item.product,
          item.variant,
          quoteRef,
          quoteHash,
          ref("pvr"),
          item.offer,
        ],
      );
      // Deterministic sub-millisecond DB facts; the real OrderStore still serializes its own events.
      await f.query(`CREATE FUNCTION orders.fixture_source_time() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_TABLE_NAME='orders' THEN
          NEW.confirmed_at='2026-10-04T12:00:00.123456Z'::timestamptz;
          NEW.updated_at=NEW.confirmed_at;
        ELSE NEW.occurred_at='2026-10-04T12:00:00.123456Z'::timestamptz;
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER fixture_order_source_time BEFORE UPDATE ON orders.orders
        FOR EACH ROW WHEN (NEW.status='Confirmed') EXECUTE FUNCTION orders.fixture_source_time();
      CREATE TRIGGER fixture_history_source_time BEFORE INSERT ON orders.order_history
        FOR EACH ROW EXECUTE FUNCTION orders.fixture_source_time()`);
      const confirmed = await orders.confirm({
        actorRef,
        identity: { actorRef, scope: "a".repeat(64), key: randomUUID() },
        correlationId: randomUUID(),
        cardPermissions: ["orders:confirm:any"],
        orderRef,
        expectedVersion: "2",
      });
      assert.equal(confirmed.body.version, "3");
      const confirmedEnvelope = (
        await f.read(
          "SELECT envelope FROM orders.outbox_messages WHERE message_type='OrderConfirmed.v1' AND aggregate_ref=$1",
          [orderRef],
        )
      )[0].envelope;
      assert.equal(
        confirmedEnvelope.payload.confirmedAt,
        "2026-10-04T12:00:00.123Z",
      );
      assert.deepEqual(
        await f.read(
          "SELECT confirmed_at <> $2::timestamptz AS sub_millisecond FROM orders.orders WHERE order_ref=$1",
          [orderRef, confirmedEnvelope.payload.confirmedAt],
        ),
        [{ sub_millisecond: true }],
      );
      await f.deliver(confirmedEnvelope);
      assert.deepEqual(
        await f.read(
          "SELECT state FROM orders.inbox_messages WHERE message_id=$1",
          [confirmedEnvelope.messageId],
        ),
        [{ state: "Processed" }],
      );
      const wrongConfirmedAt = {
        ...confirmedEnvelope,
        messageId: ref("msg"),
        payload: {
          ...confirmedEnvelope.payload,
          confirmedAt: "2026-10-04T12:00:00.124Z",
        },
      };
      await f.deliver(wrongConfirmedAt);
      assert.deepEqual(
        await f.read(
          "SELECT state,quarantine_reason FROM orders.inbox_messages WHERE message_id=$1",
          [wrongConfirmedAt.messageId],
        ),
        [
          {
            state: "Quarantined",
            quarantine_reason: "AROMA_CONFIRMATION_SOURCE_INVALID",
          },
        ],
      );
      await f.deliver(mapping(item, "1"));
      await f.observe();
      await f.deliver(
        mapping(item, "2", {
          mappingState: "Missing",
          availability: "Available",
          offerRef: null,
        }),
      );
      assert.equal((await f.card(orderRef)).state, "Blocked");
      const realtime = await f.read(
        "SELECT aggregate_sequence::text,owner_version FROM orders.outbox_messages WHERE aggregate_ref=$1 AND message_type='RealtimeInvalidated.v1' ORDER BY aggregate_sequence",
        [orderRef],
      );
      assert.ok(
        realtime.length >= 2,
        "projection changes must emit multiple RealtimeInvalidated records",
      );

      const app = await createRuntime({
        name: "orders-outbox-sequence-regression",
        host: "127.0.0.1",
        port: 0,
        shutdownGraceMs: 5_000,
        deadlineMs: 10_000,
        deadlineProfiles: { defaultMs: 10_000 },
      });
      registerOrdersRoutes(app, {
        verifyTransport: () => true,
        verifyPublicDelegation: async (_token, operationId, correlationId) => ({
          iss: "api-public",
          aud: "orders-service",
          originalIssuer: "edge-gateway",
          sub: actorRef,
          permissions: ["orders:reconcile:any"],
          operationId,
          correlationId,
          traceparent: trace,
        }),
        signInternalDelegation: () => {
          throw new Error("unexpected upstream call");
        },
        owner: {
          store: orders,
          customer: {
            getOrderInput: async () => {
              throw new Error("unexpected Customer call");
            },
          },
          pricing: {
            verify: async () => {
              throw new Error("unexpected Pricing call");
            },
          },
        },
      });
      await app.runtimeController.start();
      try {
        const url = `/api/client-v1/orders/${orderRef}/commands/request-aroma-reconciliation`;
        const request = (key, expectedVersion) => ({
          method: "POST",
          url,
          headers: {
            "x-correlation-id": randomUUID(),
            traceparent: trace,
            "x-actor-context": "trusted-test",
            "idempotency-key": key,
          },
          payload: { expectedVersion, reason: "operator retry" },
        });
        const firstKey = randomUUID();
        const first = await app.inject(
          request(firstKey, confirmed.body.version),
        );
        assert.equal(first.statusCode, 202, first.body);
        assert.equal(first.json().orderVersion, "4");
        assert.equal(first.json().requestedAt, "2026-10-04T12:00:00.123Z");
        const firstIntent = (
          await f.read(
            "SELECT envelope FROM orders.outbox_messages WHERE aggregate_ref=$1 AND message_type='OrderReconciliationRequested.v1'",
            [orderRef],
          )
        )[0].envelope;
        assert.deepEqual(
          await f.read(
            "SELECT occurred_at <> $2::timestamptz AS sub_millisecond FROM orders.order_history WHERE order_ref=$1 AND event_type='ReconciliationRequested'",
            [orderRef, firstIntent.payload.requestedAt],
          ),
          [{ sub_millisecond: true }],
        );
        const previousCard = await f.card(orderRef);
        const { decodePreparationWrittenRow } =
          await import("../../apps/orders-aroma-preparation/dist/infrastructure/row-schemas.js");
        const snapshot = {
          ...previousCard,
          updated_at: previousCard.updated_at.toISOString(),
          last_observed_at:
            previousCard.last_observed_at?.toISOString() ?? null,
        };
        delete snapshot.business_version;
        delete snapshot.card_version;
        const unchanged = {
          projection_version: previousCard.card_version,
          material_change: false,
          snapshot,
        };
        assert.ok(
          BigInt(snapshot.projection_version) <
            BigInt(unchanged.projection_version),
        );
        assert.strictEqual(decodePreparationWrittenRow(unchanged), unchanged);
        assert.throws(
          () =>
            decodePreparationWrittenRow({
              ...unchanged,
              material_change: true,
            }),
          /AROMA_PREPARATION_DATABASE_ROW_INVALID/u,
        );
        assert.throws(
          () =>
            decodePreparationWrittenRow({
              ...unchanged,
              snapshot: {
                ...snapshot,
                projection_version: (
                  BigInt(unchanged.projection_version) + 1n
                ).toString(),
              },
            }),
          /AROMA_PREPARATION_DATABASE_ROW_INVALID/u,
        );
        await f.deliver(firstIntent);
        assert.deepEqual(
          await f.read(
            "SELECT state FROM orders.inbox_messages WHERE message_id=$1",
            [firstIntent.messageId],
          ),
          [{ state: "Processed" }],
        );
        const replay = await app.inject(
          request(firstKey, confirmed.body.version),
        );
        assert.equal(replay.statusCode, 202, replay.body);
        assert.deepEqual(replay.json(), first.json());
        assert.equal(replay.headers["idempotency-replayed"], "true");
        const second = await app.inject(
          request(randomUUID(), first.json().orderVersion),
        );
        assert.equal(second.statusCode, 202, second.body);
        assert.equal(second.json().orderVersion, "5");
        const sourceFacts = await f.read(
          "SELECT history_ref,occurred_at::text,facts FROM orders.order_history WHERE order_ref=$1 ORDER BY order_version",
          [orderRef],
        );
        const sourceOutbox = await f.read(
          "SELECT message_id,envelope_bytes,envelope_hash FROM orders.outbox_messages WHERE aggregate_ref=$1 AND message_type IN ('OrderConfirmed.v1','OrderReconciliationRequested.v1') ORDER BY aggregate_sequence",
          [orderRef],
        );
        await f.restart();
        await f.store.recover(new AbortController().signal);
        const recoveredIntent = (
          await f.read(
            "SELECT envelope FROM orders.outbox_messages WHERE aggregate_ref=$1 AND message_type='OrderReconciliationRequested.v1' AND owner_version='5'",
            [orderRef],
          )
        )[0].envelope;
        await f.deliver(recoveredIntent);
        await f.store.runOnce(new AbortController().signal);
        assert.deepEqual(
          await f.read(
            "SELECT causation_id,count(*)::int AS n FROM orders.outbox_messages WHERE message_type='AromaConvergenceRequested.v1' AND causation_id=ANY($1::text[]) GROUP BY causation_id ORDER BY causation_id",
            [[firstIntent.messageId, recoveredIntent.messageId]],
          ),
          [firstIntent.messageId, recoveredIntent.messageId]
            .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
            .map((causation_id) => ({ causation_id, n: 1 })),
        );
        assert.deepEqual(
          await f.read(
            "SELECT state FROM orders.inbox_messages WHERE message_id=ANY($1::text[]) ORDER BY message_id",
            [[firstIntent.messageId, recoveredIntent.messageId]],
          ),
          [{ state: "Processed" }, { state: "Processed" }],
        );
        assert.equal(
          (
            await f.read(
              "SELECT count(*)::int AS n FROM orders.inbox_quarantine WHERE message_id=ANY($1::text[])",
              [
                [
                  confirmedEnvelope.messageId,
                  firstIntent.messageId,
                  recoveredIntent.messageId,
                ],
              ],
            )
          )[0].n,
          0,
        );
        assert.deepEqual(
          await f.read(
            "SELECT history_ref,occurred_at::text,facts FROM orders.order_history WHERE order_ref=$1 ORDER BY order_version",
            [orderRef],
          ),
          sourceFacts,
        );
        assert.deepEqual(
          await f.read(
            "SELECT message_id,envelope_bytes,envelope_hash FROM orders.outbox_messages WHERE aggregate_ref=$1 AND message_type IN ('OrderConfirmed.v1','OrderReconciliationRequested.v1') ORDER BY aggregate_sequence",
            [orderRef],
          ),
          sourceOutbox,
        );
        const messages = await f.read(
          "SELECT message_type,aggregate_sequence::text,owner_version,envelope FROM orders.outbox_messages WHERE aggregate_ref=$1 ORDER BY aggregate_sequence",
          [orderRef],
        );
        assert.equal(
          new Set(messages.map((message) => message.aggregate_sequence)).size,
          messages.length,
        );
        assert.deepEqual(
          messages.map((message) => message.aggregate_sequence),
          messages.map((_, index) => String(index + 1)),
        );
        const reconcile = messages.filter(
          (message) =>
            message.message_type === "OrderReconciliationRequested.v1",
        );
        assert.deepEqual(
          reconcile.map((message) => message.owner_version),
          ["4", "5"],
        );
        assert.deepEqual(
          reconcile.map((message) => message.envelope.aggregate.version),
          ["4", "5"],
        );
        assert.equal(
          messages.filter(
            (message) => message.message_type === "OrderConfirmed.v1",
          )[0].owner_version,
          "3",
        );
      } finally {
        await app.runtimeController.closeRuntime("SIGTERM");
      }
    });
  },
);

void test("bundled preparation decoder rejects forged consumed envelopes", async () => {
  const { decodeAromaPreparationEnvelope: decode } =
    await import("../../apps/orders-aroma-preparation/dist/application/messages.js");
  const good = mapping(product(), "1");
  good.aggregate.version = "17"; // independent Catalog sequence; not mappingRevision
  assert.equal(decode(good), good);
  for (const bad of [
    { ...good, unexpected: true },
    { ...good, producer: "orders-service" },
    { ...good, payload: { ...good.payload, providerQuantity: "1" } },
    { ...good, payload: { ...good.payload, offerRef: ref("var") } },
    { ...good, payload: { ...good.payload, mappingRevision: "01" } },
    {
      ...good,
      payload: { ...good.payload, mappingRevision: "9223372036854775808" },
    },
    { ...good, payload: { ...good.payload, effectiveAt: "not-time" } },
    { ...good, payload: { ...good.payload, mappingState: "Missing" } },
    { ...good, aggregate: { ...good.aggregate, ref: ref("prd") } },
    { ...good, aggregate: { ...good.aggregate, type: "Order" } },
  ])
    assert.throws(() => decode(bad), /AROMA_PREPARATION_ENVELOPE_INVALID/u);
});

void test(
  "preparation sole Card writer uses persisted terminal proof, not Kafka hint",
  live,
  async (t) => {
    await fixture(async (f) => {
      const { OrderStore } =
        await import("../../apps/orders-service/dist/infrastructure/database/order-store.js");
      const api = new OrderStore(f.core, { maxSnapshotAgeMs: 60_000 });
      const publicCard = (ref) =>
        api.getCard(ref, {
          correlationId: randomUUID(),
          permissions: ["orders:reconcile:any"],
        });
      const p = product();
      await f.deliver(mapping(p));
      const order = await f.seed([p]);
      await f.deliver(order.confirmed);
      const obs = await f.observe();
      await t.test(
        "fresh equal numeric Desired/Observed without Attempt is OutOfSync",
        async () => {
          await f.deliver(obs.changed);
          const card = await f.card(order.order);
          assert.equal(card.desired_revision, card.observed_revision);
          assert.equal(card.state, "OutOfSync");
          assert.equal(card.verified_attempt_ref, null);
        },
      );
      const proof = await f.proof(obs);
      await t.test(
        "terminal current NoOp proof with released same epoch is InSync; Inbox+history+Realtime are atomic",
        async () => {
          await f.deliver(proof.changed);
          const card = await f.card(order.order);
          assert.equal(card.state, "InSync");
          assert.equal(card.verified_attempt_ref, proof.attempt);
          assert.equal(card.business_version, "2");
          const exposed = await publicCard(order.order);
          assert.equal(exposed.aroma.state, "InSync");
          assert.equal(exposed.projectionVersion, card.card_version);
          assert.deepEqual(exposed.allowedActions, []);
          assert.equal(JSON.stringify(exposed).includes(proof.attempt), false);
          const closedConfig = new OrderStore(f.core);
          assert.equal(
            (
              await closedConfig.getCard(order.order, {
                correlationId: randomUUID(),
              })
            ).aroma.state,
            "OutOfSync",
          );
          const inbox = (
            await f.read(
              "SELECT state FROM orders.inbox_messages WHERE message_id=$1",
              [proof.changed.messageId],
            )
          )[0];
          assert.equal(inbox.state, "Processed");
          const history = (
            await f.read(
              "SELECT projection FROM orders.order_aroma_projection_history WHERE order_ref=$1 AND projection_version=$2",
              [order.order, card.card_version],
            )
          )[0];
          assert.equal(
            String(history.projection.projection_version),
            card.card_version,
          );
          const realtime = await f.read(
            "SELECT owner_version,payload,envelope,topic,partition_key,message_id FROM orders.outbox_messages WHERE message_type='RealtimeInvalidated.v1' AND aggregate_ref=$1 AND owner_version=$2",
            [order.order, card.card_version],
          );
          assert.equal(realtime.length, 1);
          assert.equal(realtime[0].payload.ownerVersion, card.card_version);
          assert.equal(realtime[0].payload.subjectRef, order.order);
          // Actual persisted owner output, not a hand-authored transport fixture.
          const { decodeRealtimeEnvelope, RealtimeHub } =
            await import("../../apps/realtime-gateway/dist/index.js");
          const { config } = await import("../realtime/helpers.mjs");
          const owner = realtime[0];
          assert.equal(owner.envelope.aggregate.type, "Order");
          assert.equal(owner.envelope.aggregate.version, card.card_version);
          assert.equal(
            owner.envelope.payload.ownerVersion,
            exposed.projectionVersion,
          );
          assert.notEqual(
            owner.envelope.payload.ownerVersion,
            exposed.version,
            "projection hint version must not become command expectedVersion",
          );
          const record = {
            topic: owner.topic,
            key: owner.partition_key,
            value: JSON.stringify(owner.envelope),
            headers: { messageId: owner.message_id },
            partition: 0,
            offset: "0",
          };
          assert.deepEqual(
            decodeRealtimeEnvelope(
              owner.envelope,
              record,
              config.maxEventDataBytes,
            ),
            owner.envelope,
          );
          const hub = new RealtimeHub(config),
            effects = [];
          try {
            await processKafkaRecord(record, {
              runtime: "realtime-gateway",
              groupId: "realtime-gateway-v1",
              topics: [owner.topic],
              leaseMs: 30000,
              maxMessageBytes: 1048576,
              signal: new AbortController().signal,
              binding: hub.binding,
              quarantine: async () => effects.push("quarantine"),
              commit: async () => effects.push("offset"),
            });
            assert.deepEqual(effects, ["offset"]);
            assert.equal(hub.stats().ringRecords, 1);
          } finally {
            await hub.shutdown();
          }
        },
      );
      await t.test(
        "same terminal duplicate and recreated process are material no-ops",
        async () => {
          const before = await f.card(order.order);
          await f.deliver(proof.changed);
          await f.restart();
          await f.store.recover(new AbortController().signal);
          assert.deepEqual(await f.card(order.order), before);
        },
      );
      await t.test(
        "preparation role cannot bypass sole SQL writer or update immutable Order",
        async () => {
          for (const statement of [
            "UPDATE orders.order_aroma_projections SET state='InSync' WHERE order_ref=$1",
            "UPDATE orders.orders SET projection_version=projection_version+1 WHERE order_ref=$1",
          ]) {
            await assert.rejects(
              f.tx((tx) =>
                defineStatement(f.database(), statement)(tx, [order.order]),
              ),
              (error) => error.sqlState === "42501",
            );
          }
        },
      );
      const newer = await f.observe();
      await t.test(
        "current fresh observation invalidates old terminal proof and delayed old event cannot resurrect InSync",
        async () => {
          assert.equal((await f.card(order.order)).state, "InSync");
          const exposed = await publicCard(order.order);
          assert.equal(exposed.aroma.state, "OutOfSync");
          assert.deepEqual(exposed.allowedActions, [
            "request-aroma-reconciliation",
          ]);
          await f.deliver(newer.changed);
          assert.equal((await f.card(order.order)).state, "OutOfSync");
          const delayed = { ...proof.changed, messageId: ref("msg") };
          await f.deliver(delayed);
          assert.equal((await f.card(order.order)).state, "OutOfSync");
          assert.equal(
            (await f.card(order.order)).observed_revision,
            newer.revision,
          );
        },
      );
      const second = await f.proof(newer, { epoch: "2" });
      await f.deliver(second.changed);
      await t.test(
        "lease release alone preserves fence proof; takeover without new Attempt invalidates it",
        async () => {
          assert.equal((await f.card(order.order)).state, "InSync");
          const before = await f.card(order.order);
          const cardAtFreshRead = await publicCard(order.order);
          assert.equal(cardAtFreshRead.aroma.state, "InSync");
          assert.equal(cardAtFreshRead.projectionVersion, before.card_version);
          await f.query(
            "UPDATE orders.convergence_leases SET expires_at=clock_timestamp()-interval '1 second',heartbeat_at=clock_timestamp() WHERE cart_scope_ref='aroma-primary'",
          );
          await f.store.runOnce(new AbortController().signal);
          assert.deepEqual(await f.card(order.order), before);
          const cardAfterRelease = await publicCard(order.order);
          assert.equal(cardAfterRelease.aroma.state, "InSync");
          assert.equal(
            cardAfterRelease.projectionVersion,
            cardAtFreshRead.projectionVersion,
            "release alone leaves the accepted fence proof current",
          );

          const takeoverOwner = randomUUID();
          await f.query(
            "UPDATE orders.convergence_leases SET fence_epoch=3,owner_instance_id=$1,expires_at=clock_timestamp()+interval '60 seconds',heartbeat_at=clock_timestamp() WHERE cart_scope_ref='aroma-primary'",
            [takeoverOwner],
          );
          const cardWithNewFence = await publicCard(order.order);
          assert.equal(cardWithNewFence.aroma.state, "Converging");
          assert.equal(
            cardWithNewFence.projectionVersion,
            cardAtFreshRead.projectionVersion,
            "a new active fence is computed at read time",
          );
          assert.deepEqual(
            await f.card(order.order),
            before,
            "the lease takeover has not written the persisted Card",
          );

          await f.query(
            "UPDATE orders.convergence_leases SET expires_at=clock_timestamp()-interval '1 second',heartbeat_at=clock_timestamp() WHERE cart_scope_ref='aroma-primary'",
          );
          const cardAfterExpiry = await publicCard(order.order);
          assert.equal(cardAfterExpiry.aroma.state, "OutOfSync");
          assert.equal(
            cardAfterExpiry.projectionVersion,
            cardAtFreshRead.projectionVersion,
            "expiry of the new fence is still read-time only",
          );
          assert.deepEqual(
            await f.card(order.order),
            before,
            "both read-time lease changes preserve the stored InSync projection",
          );
          await f.store.runOnce(new AbortController().signal);
          assert.equal((await f.card(order.order)).state, "OutOfSync");
        },
      );
      const stale = await f.observe({ stale: true });
      const staleProof = await f.proof(stale, { epoch: "4" });
      await t.test(
        "stale complete snapshot plus success Attempt cannot claim InSync",
        async () => {
          await f.deliver(staleProof.changed);
          assert.equal((await f.card(order.order)).state, "OutOfSync");
        },
      );
      const unequal = await f.observe({
        lines: [
          {
            offer_ref: p.offer,
            source_grind_key_hash: null,
            quantity_milli: "2000",
          },
        ],
      });
      await t.test(
        "SQL terminal guard rejects unequal-line success; valid success hint cannot override persisted OutOfSync",
        async () => {
          await assert.rejects(
            f.proof(unequal, { epoch: "5" }),
            (error) => error.code === "23514",
          );
          const unequalProof = await f.proof(unequal, {
            epoch: "6",
            state: "OutOfSync",
          });
          unequalProof.changed.payload.attemptState = "NoOpInSync";
          await f.deliver(unequalProof.changed);
          assert.equal((await f.card(order.order)).state, "OutOfSync");
        },
      );
      const correct = await f.observe();
      const successful = await f.proof(correct, { epoch: "7" });
      await f.deliver(successful.changed);
      await t.test(
        "shared core/preparation counter remains monotonic under concurrent writer entry",
        async () => {
          const before = await f.card(order.order);
          const advance = defineStatement(
            f.core,
            "SELECT projection_version::text FROM orders.write_card_projection($1)",
          );
          const observation = await f.observe();
          await Promise.all([
            withTransaction(f.core, { mode: "background" }, (tx) =>
              advance(tx, [order.order]),
            ),
            f.deliver(observation.changed),
          ]);
          const card = await f.card(order.order);
          assert.equal(
            BigInt(card.card_version),
            BigInt(before.card_version) + 2n,
          );
          assert.equal(card.business_version, "2");
          assert.equal(card.state, "OutOfSync");
          const versions = await f.read(
            "SELECT projection_version::text FROM orders.order_aroma_projection_history WHERE order_ref=$1 ORDER BY projection_version",
            [order.order],
          );
          assert.equal(
            new Set(versions.map((row) => row.projection_version)).size,
            versions.length,
          );
        },
      );
      await t.test(
        "Failed terminal proof maps to Blocked, never to provider success",
        async () => {
          const current = await f.observe();
          const failed = await f.proof(current, {
            epoch: "8",
            state: "Failed",
          });
          await f.deliver(failed.changed);
          const card = await f.card(order.order);
          assert.equal(card.state, "Blocked");
          assert.deepEqual(card.blocker_codes, ["AROMA_GET_FAILED"]);
          assert.equal(card.verified_attempt_ref, null);
        },
      );
      await t.test(
        "recovery never invokes HTTP/provider under the owner transaction",
        async () => {
          const previousFetch = globalThis.fetch;
          let calls = 0;
          globalThis.fetch = async () => {
            calls++;
            throw new Error("unexpected HTTP under preparation");
          };
          try {
            await f.store.runOnce(new AbortController().signal);
            assert.equal(calls, 0);
          } finally {
            globalThis.fetch = previousFetch;
          }
        },
      );
    });
  },
);

void test(
  "preparation unresolved mutation barrier and Card precedence survive restart",
  live,
  async (t) => {
    await fixture(async (f) => {
      const p = product();
      await f.deliver(mapping(p));
      const order = await f.seed([p]);
      await f.deliver(order.confirmed);
      const obs = await f.observe();
      await f.deliver(obs.changed);
      const reserved = await f.proof(obs, { reserve: true, active: true });
      await t.test(
        "active persisted lease/Attempt is Converging, not a successful hinted result",
        async () => {
          await f.store.runOnce(new AbortController().signal);
          assert.equal((await f.card(order.order)).state, "Converging");
        },
      );
      await t.test(
        "Reserved, Dispatched, Acknowledged block InSync scope-wide",
        async () => {
          for (const state of ["Reserved", "Dispatched", "Acknowledged"]) {
            if (state !== "Reserved")
              await f.query(
                "UPDATE orders.mutation_reservations SET state=$1,dispatched_at=COALESCE(dispatched_at,clock_timestamp()) WHERE operation_ref=$2",
                [state, reserved.operation],
              );
            await f.store.runOnce(new AbortController().signal);
            assert.notEqual((await f.card(order.order)).state, "InSync");
          }
        },
      );
      await t.test(
        "UnknownOutcome takes precedence over per-Order blocker and active lease",
        async () => {
          await f.query(
            "UPDATE orders.mutation_reservations SET state='UnknownOutcome' WHERE operation_ref=$1",
            [reserved.operation],
          );
          await f.query(
            "UPDATE orders.convergence_attempts SET state='UnknownOutcome',ended_at=clock_timestamp(),failure_code='AROMA_UNKNOWN_OUTCOME' WHERE attempt_ref=$1",
            [reserved.attempt],
          );
          await f.deliver(
            mapping(p, "2", {
              mappingState: "Stopped",
              offerRef: null,
              availability: "Stopped",
            }),
          );
          assert.equal((await f.card(order.order)).state, "UnknownOutcome");
          await f.restart();
          await f.store.recover(new AbortController().signal);
          assert.equal((await f.card(order.order)).state, "UnknownOutcome");
        },
      );
      await t.test(
        "resolved Unknown barrier restores per-Order Blocked without erasing Observed",
        async () => {
          await f.query(
            "UPDATE orders.mutation_reservations SET state='RecoveredApplied',resolved_at=clock_timestamp() WHERE operation_ref=$1",
            [reserved.operation],
          );
          await f.query(
            "UPDATE orders.convergence_leases SET expires_at=clock_timestamp()-interval '1 second',heartbeat_at=clock_timestamp() WHERE cart_scope_ref='aroma-primary'",
          );
          await f.store.runOnce(new AbortController().signal);
          const card = await f.card(order.order);
          assert.equal(card.state, "Blocked");
          assert.ok(card.blocker_codes.includes("MAPPING_STOPPED"));
          assert.equal(card.observed_revision, obs.revision);
        },
      );
    });
  },
);

void test(
  "preparation owner GET overlays and clears UnknownOutcome without a projection write",
  live,
  async () => {
    await fixture(async (f) => {
      const { OrderStore } =
        await import("../../apps/orders-service/dist/infrastructure/database/order-store.js");
      const api = new OrderStore(f.core, { maxSnapshotAgeMs: 60_000 });
      const readOwnerCard = (orderRef) =>
        api.getCard(orderRef, {
          correlationId: randomUUID(),
          permissions: ["orders:reconcile:any"],
        });
      const p = product();
      await f.deliver(mapping(p));
      const order = await f.seed([p]);
      await f.deliver(order.confirmed);
      const observation = await f.observe();
      await f.deliver(observation.changed);
      const reserved = await f.proof(observation, {
        reserve: true,
        active: true,
      });
      await f.store.runOnce(new AbortController().signal);
      const stored = await f.card(order.order);
      const active = await readOwnerCard(order.order);
      assert.equal(stored.state, "Converging");
      assert.equal(active.aroma.state, "Converging");
      assert.equal(active.projectionVersion, stored.card_version);
      const outboxBefore = await f.read(
        "SELECT message_id,message_type,owner_version,envelope_bytes,envelope_hash FROM orders.outbox_messages WHERE aggregate_ref=$1 ORDER BY message_id",
        [order.order],
      );

      await f.query(
        "UPDATE orders.mutation_reservations SET state='UnknownOutcome' WHERE operation_ref=$1",
        [reserved.operation],
      );
      await f.query(
        "UPDATE orders.convergence_attempts SET state='UnknownOutcome',ended_at=clock_timestamp(),failure_code='AROMA_UNKNOWN_OUTCOME' WHERE attempt_ref=$1",
        [reserved.attempt],
      );
      const overlay = await readOwnerCard(order.order);
      assert.equal(overlay.aroma.state, "UnknownOutcome");
      assert.deepEqual(
        overlay.aroma.blockers.map((blocker) => blocker.code),
        ["AROMA_UNKNOWN_OUTCOME"],
      );
      assert.equal(
        overlay.projectionVersion,
        active.projectionVersion,
        "the active reservation overlay is evaluated at GET time",
      );
      assert.deepEqual(
        await f.card(order.order),
        stored,
        "the UnknownOutcome overlay does not rewrite the stored Card row",
      );
      assert.deepEqual(
        await f.read(
          "SELECT message_id,message_type,owner_version,envelope_bytes,envelope_hash FROM orders.outbox_messages WHERE aggregate_ref=$1 ORDER BY message_id",
          [order.order],
        ),
        outboxBefore,
      );

      await f.query(
        "UPDATE orders.mutation_reservations SET state='RecoveredApplied',resolved_at=clock_timestamp() WHERE operation_ref=$1",
        [reserved.operation],
      );
      await f.query(
        "UPDATE orders.convergence_leases SET expires_at=clock_timestamp()-interval '1 second',heartbeat_at=clock_timestamp() WHERE cart_scope_ref='aroma-primary'",
      );
      const recovered = await readOwnerCard(order.order);
      assert.equal(recovered.aroma.state, "OutOfSync");
      assert.equal(
        recovered.projectionVersion,
        active.projectionVersion,
        "overlay recovery and lease expiry remain read-time only",
      );
      assert.equal(recovered.version, active.version);
      assert.equal(
        recovered.aroma.desiredRevision,
        active.aroma.desiredRevision,
      );
      assert.equal(
        recovered.aroma.observedRevision,
        active.aroma.observedRevision,
      );
      assert.equal(recovered.aroma.lastObservedAt, active.aroma.lastObservedAt);
      assert.deepEqual(recovered.aroma.blockers, active.aroma.blockers);
      assert.deepEqual(recovered.items, active.items);
      assert.deepEqual(recovered.customer, active.customer);
      assert.deepEqual(recovered.pricing, active.pricing);
      assert.deepEqual(recovered.allowedActions, [
        "request-aroma-reconciliation",
      ]);
      assert.deepEqual(
        await f.card(order.order),
        stored,
        "overlay recovery leaves the stored Card row unchanged",
      );
      assert.deepEqual(
        await f.read(
          "SELECT message_id,message_type,owner_version,envelope_bytes,envelope_hash FROM orders.outbox_messages WHERE aggregate_ref=$1 ORDER BY message_id",
          [order.order],
        ),
        outboxBefore,
      );
    });
  },
);

void test(
  "preparation durable operator intent recovers with Kafka retention/restart",
  live,
  async (t) => {
    await fixture(async (f) => {
      const p = product();
      await f.deliver(mapping(p));
      const order = await f.seed([p]);
      const intent = await f.acceptIntent(order.order);
      const requestCount = async (id) =>
        (
          await f.read(
            "SELECT count(*)::int AS n FROM orders.outbox_messages WHERE message_type='AromaConvergenceRequested.v1' AND causation_id=$1",
            [id],
          )
        )[0].n;
      await t.test(
        "accepted reconciliation without cart facts stays retryable without Inbox success or offset commit",
        async () => {
          const commits = f.commits();
          await assert.rejects(
            f.deliver(intent),
            (error) =>
              error.failure?.kind === "transient" &&
              error.failure.reason === "AROMA_RECONCILIATION_FACTS_PENDING",
          );
          assert.equal(f.commits(), commits);
          assert.equal(await f.current(), undefined);
          assert.equal(await requestCount(intent.messageId), 0);
          assert.deepEqual(
            await f.read(
              "SELECT state FROM orders.inbox_messages WHERE message_id=$1",
              [intent.messageId],
            ),
            [],
          );
          assert.deepEqual(
            await f.read(
              "SELECT desired_revision,dirty,reason FROM orders.convergence_work",
            ),
            [],
          );
        },
      );
      await t.test(
        "restart without source Kafka delivery reconstructs real Desired and retained pending intent",
        async () => {
          await f.restart();
          await f.store.recover(new AbortController().signal);
          assert.ok(await f.current());
          assert.equal(await requestCount(intent.messageId), 1);
        },
      );
      await t.test(
        "recovery retains its operator wake and repeated same-Desired intents use distinct stream versions",
        async () => {
          await f.deliver(order.confirmed);
          await f.store.recover(new AbortController().signal);
          assert.equal(await requestCount(intent.messageId), 1);
          const current = await f.current();
          const requests = await f.read(
            "SELECT payload FROM orders.outbox_messages WHERE causation_id=$1 AND message_type='AromaConvergenceRequested.v1'",
            [intent.messageId],
          );
          assert.equal(
            requests[0].payload.desiredRevision,
            current.desired_revision,
          );
          assert.equal(requests[0].payload.reason, "OperatorRequested");
          assert.equal(requests[0].payload.orderRef, order.order);

          const observation = await f.observe();
          const observationEnvelope = observation.changed;
          const aggregateSequence = (
            await f.read(
              "SELECT (COALESCE(max(aggregate_sequence),0)+1)::text AS sequence FROM orders.outbox_messages WHERE aggregate_ref='aroma-primary'",
            )
          ).at(0).sequence;
          const outbox = createSqlOutboxStore(f.database(), {
            schema: "orders",
            envelopeBytes: true,
          });
          await f.tx((transaction) =>
            outbox.enqueue(transaction, {
              messageId: observationEnvelope.messageId,
              messageType: observationEnvelope.messageType,
              topic: "coffee.aroma.cart.events.v1",
              aggregateRef: "aroma-primary",
              aggregateSequence: BigInt(aggregateSequence),
              ownerVersion: observationEnvelope.aggregate.version,
              partitionKey: "aroma-primary",
              schemaVersion: "1",
              envelope: observationEnvelope,
              payload: observationEnvelope.payload,
              occurredAt: observationEnvelope.occurredAt,
              correlationId: observationEnvelope.correlationId,
              traceparent: observationEnvelope.traceparent,
            }),
          );
          const repeated = [
            await f.acceptIntent(order.order),
            await f.acceptIntent(order.order),
          ];
          for (const event of repeated) await f.deliver(event);
          const { decodeAromaConvergenceEnvelope } =
            await import("../../apps/aroma-convergence/dist/application/messages.js");
          const emitted = await f.read(
            `SELECT aggregate_sequence::text,owner_version,envelope,correlation_id,causation_id
        FROM orders.outbox_messages WHERE message_type='AromaConvergenceRequested.v1' AND causation_id=ANY($1::text[])
        ORDER BY aggregate_sequence`,
            [repeated.map((event) => event.messageId)],
          );
          assert.equal(emitted.length, 2);
          assert.deepEqual(await f.current(), current);
          for (const row of emitted) {
            assert.equal(
              row.envelope.aggregate.version,
              row.aggregate_sequence,
            );
            assert.equal(row.owner_version, row.aggregate_sequence);
            assert.notEqual(row.owner_version, current.desired_revision);
            assert.ok(
              BigInt(row.aggregate_sequence) > BigInt(current.desired_revision),
            );
            assert.equal(
              row.envelope.payload.desiredRevision,
              current.desired_revision,
            );
            assert.equal(row.envelope.payload.reason, "OperatorRequested");
            assert.strictEqual(
              decodeAromaConvergenceEnvelope(row.envelope),
              row.envelope,
            );
          }
          assert.deepEqual(
            emitted.map((row) => row.causation_id),
            repeated.map((event) => event.messageId),
          );
          assert.deepEqual(
            emitted.map((row) => row.correlation_id),
            repeated.map((event) => event.correlationId),
          );
          assert.deepEqual(
            await f.read(
              "SELECT state FROM orders.inbox_messages WHERE consumer_name='orders-aroma-preparation-v1' AND message_id=ANY($1::text[]) ORDER BY message_id",
              [repeated.map((event) => event.messageId)],
            ),
            [{ state: "Processed" }, { state: "Processed" }],
          );
          assert.equal(
            (
              await f.read(
                "SELECT count(*)::int AS n FROM orders.inbox_quarantine WHERE consumer_name='orders-aroma-preparation-v1' AND message_id=ANY($1::text[])",
                [repeated.map((event) => event.messageId)],
              )
            )[0].n,
            0,
          );
        },
      );
      await t.test(
        "durable Inbox rejects deletion; duplicate, fresh process and repeated recovery never duplicate an intent wake",
        async () => {
          await f.deliver(intent);
          await assert.rejects(
            f.query("DELETE FROM orders.inbox_messages WHERE message_id=$1", [
              intent.messageId,
            ]),
            (error) => error.code === "23514",
          );
          await f.restart();
          await f.store.recover(new AbortController().signal);
          await f.deliver(intent);
          await f.store.runOnce(new AbortController().signal);
          assert.equal(await requestCount(intent.messageId), 1);
        },
      );
      await t.test(
        "source core Outbox/history recover a never-delivered accepted intent",
        async () => {
          const next = await f.acceptIntent(order.order);
          await f.restart();
          await f.store.recover(new AbortController().signal);
          assert.equal(await requestCount(next.messageId), 1);
        },
      );
      await t.test(
        "forged structurally-valid Order intent cannot create cart effect",
        async () => {
          const forged = { ...intent, messageId: ref("msg") };
          await f.deliver(forged);
          assert.equal(await requestCount(forged.messageId), 0);
          assert.deepEqual(
            await f.read(
              "SELECT state,quarantine_reason FROM orders.inbox_messages WHERE message_id=$1",
              [forged.messageId],
            ),
            [
              {
                state: "Quarantined",
                quarantine_reason: "AROMA_RECONCILIATION_SOURCE_INVALID",
              },
            ],
          );
        },
      );
    });
  },
);

void test(
  "preparation runtime composition binds actual configured consumer groups, recovers durable state and drains one bounded loop",
  live,
  async () => {
    await fixture(async (f) => {
      const { load } = await import("js-yaml");
      const { parsePlatformConfig } =
        await import("../../packages/platform-config/dist/index.js");
      const config = parsePlatformConfig(
        load(
          await readFile(
            new URL("../../config/platform.yaml", import.meta.url),
            "utf8",
          ),
        ),
      );
      const { createAromaPreparationComposition } =
        await import("../../apps/orders-aroma-preparation/dist/runtime-composition.js");
      const bindings = new Map();
      let relays = 0;
      let signalSeen;
      let relayDone;
      const firstRelay = new Promise((resolve) => {
        relayDone = resolve;
      });
      const kafka = {
        bind: (groupId, binding) => {
          assert.equal(bindings.has(groupId), false);
          bindings.set(groupId, binding);
        },
        relay: async (outbox, database, signal) => {
          assert.strictEqual(database, f.database());
          signalSeen = signal;
          relays++;
          relayDone();
        },
      };
      const errors = [];
      const composition = createAromaPreparationComposition();
      const processSignal = new AbortController();
      await composition.configure(
        { log: { error: (entry) => errors.push(entry) } },
        processSignal.signal,
        f.database(),
        kafka,
        { config, secrets: {} },
      );
      assert.deepEqual(
        [...bindings.keys()],
        config.services["orders-aroma-preparation"].kafka.consumers.map(
          (entry) => entry.groupId,
        ),
      );
      const p = product();
      const order = await f.seed([p]);
      const mappingEvent = mapping(p);
      const catalogGroup = config.services[
        "orders-aroma-preparation"
      ].kafka.consumers.find((entry) =>
        entry.topics.includes("coffee.catalog.mapping.v2"),
      );
      let offsets = 0;
      await processKafkaRecord(
        {
          topic: catalogGroup.topics[0],
          partition: 0,
          offset: "1",
          key: mappingEvent.aggregate.ref,
          value: canonicalJson(mappingEvent),
          headers: {},
        },
        {
          runtime: "orders-aroma-preparation",
          groupId: catalogGroup.groupId,
          topics: catalogGroup.topics,
          binding: bindings.get(catalogGroup.groupId),
          leaseMs: 60_000,
          maxMessageBytes: 1_048_576,
          signal: processSignal.signal,
          commit: async () => {
            offsets++;
          },
        },
      );
      assert.equal(offsets, 1);
      assert.ok(await f.current());
      assert.equal((await f.card(order.order)).state, "PendingObservation");
      assert.deepEqual(
        await f.read(
          "SELECT consumer_name,state FROM orders.inbox_messages WHERE message_id=$1",
          [mappingEvent.messageId],
        ),
        [{ consumer_name: catalogGroup.groupId, state: "Processed" }],
      );
      const resource = composition.resources[0];
      try {
        await resource.start(processSignal.signal);
        await firstRelay;
        assert.equal(composition.readinessChecks[0].check(), true);
        assert.equal(relays, 1);
        assert.deepEqual(errors, []);
      } finally {
        await resource.stop(AbortSignal.timeout(5000));
      }
      assert.equal(signalSeen.aborted, true);
      assert.equal(composition.readinessChecks[0].check(), false);
    });
  },
);

void test(
  "preparation transaction failure leaves Inbox/projection/history/Outbox atomic and replayable",
  live,
  async (t) => {
    await fixture(async (f) => {
      const p = product();
      await f.deliver(mapping(p));
      const order = await f.seed([p]);
      await f.deliver(order.confirmed);
      const obs = await f.observe();
      const before = await f.card(order.order);
      const counts = async () =>
        (
          await f.read(
            "SELECT (SELECT count(*) FROM orders.order_aroma_projection_history)::int AS history,(SELECT count(*) FROM orders.outbox_messages)::int AS outbox",
          )
        )[0];
      const baseline = await counts();
      await t.test(
        "owner effects rolled back on history insert failure; offset uncommitted",
        async () => {
          await f.query(
            "REVOKE INSERT ON orders.order_aroma_projection_history FROM coffee_orders_prepare_rw",
          );
          const commits = f.commits();
          await assert.rejects(
            f.deliver(obs.changed),
            (error) => error.sqlState === "42501",
          );
          assert.equal(f.commits(), commits);
          assert.deepEqual(await f.card(order.order), before);
          assert.deepEqual(await counts(), baseline);
          assert.equal(
            (
              await f.read(
                "SELECT * FROM orders.inbox_messages WHERE message_id=$1",
                [obs.changed.messageId],
              )
            ).length,
            0,
          );
          await f.query(
            "GRANT INSERT ON orders.order_aroma_projection_history TO coffee_orders_prepare_rw",
          );
          await f.deliver(obs.changed);
          assert.equal((await f.card(order.order)).state, "OutOfSync");
        },
      );
      await t.test(
        "lost offset-commit response replays terminal Inbox without double invalidation",
        async () => {
          const success = await f.proof(obs);
          const commits = f.commits();
          await assert.rejects(
            f.deliver(success.changed, {
              commit: async () => {
                throw new Error("injected offset response loss");
              },
            }),
            (error) => error.code === "OFFSET_COMMIT_OUTCOME_UNKNOWN",
          );
          assert.equal(f.commits(), commits + 1);
          const durable = await f.card(order.order);
          assert.equal(durable.state, "InSync");
          const countsAtCommit = await counts();
          await f.restart();
          await f.deliver(success.changed);
          assert.deepEqual(await f.card(order.order), durable);
          assert.deepEqual(await counts(), countsAtCommit);
        },
      );
      await t.test(
        "PostgreSQL COMMIT response loss preserves terminal atomic facts and offset replay is exactly once",
        async () => {
          const nextObserved = await f.observe();
          const successful = await f.proof(nextObserved, { epoch: "2" });
          const proxy = await openBlackholeProxy(f.port, "COMMIT");
          const commits = f.commits();
          try {
            await f.restart(proxy.port);
            await assert.rejects(
              f.deliver(successful.changed),
              (error) => error.code === "TRANSACTION_OUTCOME_UNKNOWN",
            );
            assert.equal(
              (await proxy.waitForReplyDropped(5_000)).command,
              "COMMIT",
            );
            assert.equal(f.commits(), commits);
            assert.equal(
              (
                await f.read(
                  "SELECT state FROM orders.inbox_messages WHERE message_id=$1",
                  [successful.changed.messageId],
                )
              )[0].state,
              "Processed",
            );
            const durable = await f.card(order.order);
            assert.equal(durable.state, "InSync");
            const committedCounts = await counts();
            await f.restart();
            await f.deliver(successful.changed);
            assert.deepEqual(await f.card(order.order), durable);
            assert.deepEqual(await counts(), committedCounts);
          } finally {
            await proxy.close();
          }
        },
      );
      await t.test(
        "failed quarantine transaction keeps offset uncommitted and no partial terminal Inbox; retry is safe",
        async () => {
          const conflict = mapping(p, "1", { availability: "Unavailable" });
          const currentCard = await f.card(order.order);
          const currentDesired = await f.current();
          const currentCounts = await counts();
          const commits = f.commits();
          await f.query(
            "REVOKE INSERT ON orders.inbox_quarantine FROM coffee_orders_prepare_rw",
          );
          try {
            await assert.rejects(
              f.deliver(conflict),
              (error) => error.sqlState === "42501",
            );
            assert.equal(f.commits(), commits);
            assert.equal(
              (
                await f.read(
                  "SELECT * FROM orders.inbox_messages WHERE message_id=$1",
                  [conflict.messageId],
                )
              ).length,
              0,
            );
            assert.equal(
              (
                await f.read(
                  "SELECT * FROM orders.inbox_quarantine WHERE message_id=$1",
                  [conflict.messageId],
                )
              ).length,
              0,
            );
            assert.deepEqual(await f.card(order.order), currentCard);
            assert.deepEqual(await f.current(), currentDesired);
            assert.deepEqual(await counts(), currentCounts);
          } finally {
            await f.query(
              "GRANT INSERT ON orders.inbox_quarantine TO coffee_orders_prepare_rw",
            );
          }
          await f.deliver(conflict);
          assert.equal(
            (
              await f.read(
                "SELECT state FROM orders.inbox_messages WHERE message_id=$1",
                [conflict.messageId],
              )
            )[0].state,
            "Quarantined",
          );
          assert.deepEqual(await counts(), currentCounts);
        },
      );
      await t.test(
        "quarantine COMMIT reply loss is unknown: no offset commit, restart replays terminal rejection without owner effects",
        async () => {
          const conflict = mapping(p, "1", { availability: "Stopped" });
          const currentCard = await f.card(order.order);
          const currentDesired = await f.current();
          const currentCounts = await counts();
          const proxy = await openBlackholeProxy(f.port, "COMMIT");
          const commits = f.commits();
          try {
            await f.restart(proxy.port);
            await assert.rejects(
              f.deliver(conflict),
              (error) => error.code === "TRANSACTION_OUTCOME_UNKNOWN",
            );
            assert.equal(
              (await proxy.waitForReplyDropped(5_000)).command,
              "COMMIT",
            );
            assert.equal(f.commits(), commits);
            assert.equal(
              (
                await f.read(
                  "SELECT state FROM orders.inbox_messages WHERE message_id=$1",
                  [conflict.messageId],
                )
              )[0].state,
              "Quarantined",
            );
            assert.equal(
              (
                await f.read(
                  "SELECT reason FROM orders.inbox_quarantine WHERE message_id=$1",
                  [conflict.messageId],
                )
              )[0].reason,
              "AROMA_MAPPING_REVISION_CONFLICT",
            );
            await f.restart();
            await f.deliver(conflict);
            assert.equal(f.commits(), commits + 1);
            assert.equal(
              (
                await f.read(
                  "SELECT * FROM orders.inbox_quarantine WHERE message_id=$1",
                  [conflict.messageId],
                )
              ).length,
              1,
            );
            assert.deepEqual(await f.card(order.order), currentCard);
            assert.deepEqual(await f.current(), currentDesired);
            assert.deepEqual(await counts(), currentCounts);
          } finally {
            await proxy.close();
          }
        },
      );
      await t.test(
        "pre-aborted callback is rejected without clearing physical facts",
        async () => {
          const signal = AbortSignal.abort(new Error("revoked assignment"));
          const current = await f.card(order.order);
          await assert.rejects(f.store.runOnce(signal));
          assert.deepEqual(await f.card(order.order), current);
        },
      );
    });
  },
);

for (const positions of [10, 100])
  void test(
    `capacity: preparation recomputes 100 contributions and ${100 * positions} cart lines within 2.5 seconds on real owner DB`,
    { ...live, timeout: 240_000 },
    async (t) => {
      await fixture(
        async (f) => {
          const products = Array.from({ length: 100 * positions }, () =>
            product(),
          );
          await f.query(
            `INSERT INTO orders.catalog_mapping_projection(product_ref,variant_ref,offer_ref,mapping_revision,catalog_snapshot_revision,mapping_state,availability,effective_at,source_message_id,payload_hash)
      SELECT x.product,x.variant,x.offer,1,1,'Active','Available',clock_timestamp(),'capacity-fixture',$2
      FROM jsonb_to_recordset($1::jsonb) AS x(product text,variant text,offer text)`,
            [JSON.stringify(products), "a".repeat(64)],
          );
          for (let order = 0; order < 100; order++)
            await f.seed(
              products.slice(order * positions, (order + 1) * positions),
            );
          const heapBefore = process.memoryUsage().heapUsed;
          const peakBefore = process.resourceUsage().maxRSS;
          const started = performance.now();
          assert.equal(
            await f.store.runOnce(new AbortController().signal),
            "prepared",
          );
          const elapsed = performance.now() - started;
          const counts = (
            await f.read(
              "SELECT (SELECT count(*) FROM orders.cart_desired_lines)::int AS lines,(SELECT count(*) FROM orders.cart_desired_order_facts)::int AS contributions,(SELECT count(*) FROM orders.order_aroma_projections)::int AS cards,(SELECT count(*) FROM orders.cart_desired_blockers)::int AS blockers",
            )
          )[0];
          assert.deepEqual(counts, {
            lines: 100 * positions,
            contributions: 100,
            cards: 100,
            blockers: 0,
          });
          t.diagnostic(
            JSON.stringify({
              desiredRecomputeMs: elapsed,
              limitMs: 2500,
              heapGrowthBytes: process.memoryUsage().heapUsed - heapBefore,
              peakRssGrowthKiB: process.resourceUsage().maxRSS - peakBefore,
              cardinality: counts,
            }),
          );
          // 2500 ms даёт 25% запас над измеренными на текущем хосте
          // 2031/2055 ms; состав проверки и 10 000 строк не меняются.
          assert.ok(
            elapsed <= 2500,
            `real preparation recompute ${elapsed}ms exceeds 2500ms`,
          );
          const current = await f.current();
          const next = performance.now();
          assert.equal(
            await f.store.runOnce(new AbortController().signal),
            "idle",
          );
          assert.deepEqual(await f.current(), current);
          t.diagnostic(`same-hash recovery ms=${performance.now() - next}`);
        },
        { maxOrders: 100, maxLines: 100 * positions },
      );
    },
  );

void test(
  "preparation set-based item proofs preserve grouped NULL/selected keys, canonical hash and missing-item rejection",
  live,
  async (t) => {
    await t.test(
      "multiple refs per physical line keep exact quantities, mapping blockers and stable recovery",
      async () => {
        await fixture(async (f) => {
          const { buildDesired } =
            await import("../../apps/orders-aroma-preparation/dist/domain/desired.js");
          const a = product();
          const b = { ...product(), offer: a.offer };
          const missing = { ...product(), offer: a.offer };
          const grind = "c".repeat(64);
          await f.deliver(mapping(a));
          await f.deliver(mapping(b));
          const items = [
            { ...a, quantity: "1000" },
            { ...b, quantity: "2000" },
            { ...missing, quantity: "7000" },
            { ...a, quantity: "4000", grind },
            { ...b, quantity: "5000", grind },
          ];
          const grouped = await f.seed(items, { contribute: false });
          const other = await f.seed([{ ...a, quantity: "6000" }]);
          await f.query(
            "INSERT INTO orders.order_desired_contributions(order_ref,contribution_revision,order_version) VALUES($1,1,2)",
            [grouped.order],
          );
          const lines = [];
          for (const selected of [null, grind]) {
            const rows = grouped.rows.filter((row) => row.grind === selected);
            const quantity = rows
              .reduce((sum, row) => sum + BigInt(row.quantity), 0n)
              .toString();
            const hash = canonicalRequestHash(rows.map((row) => row.hash));
            const refs = rows
              .map((row) => row.itemRef)
              .sort()
              .reverse();
            await f.query(
              `INSERT INTO orders.order_desired_contribution_lines(order_ref,contribution_revision,offer_ref,source_grind_key_hash,quantity_milli,contribution_hash,item_refs)
          VALUES($1,1,$2,$3,$4,$5,$6)`,
              [grouped.order, a.offer, selected, quantity, hash, refs],
            );
            lines.push({
              order_ref: grouped.order,
              contribution_revision: "1",
              offer_ref: a.offer,
              source_grind_key_hash: selected,
              quantity_milli: quantity,
              contribution_hash: hash,
              item_refs: refs,
              items: rows
                .map((row) => {
                  const item = items[grouped.rows.indexOf(row)];
                  return {
                    itemRef: row.itemRef,
                    found: true,
                    productRef: item.product,
                    variantRef: item.variant,
                    offerRef: a.offer,
                    grind: selected,
                    quantity: row.quantity,
                    mappingOffer: item === items[2] ? null : a.offer,
                    mappingRevision: item === items[2] ? null : "1",
                    mappingState: item === items[2] ? null : "Active",
                    availability: item === items[2] ? null : "Available",
                  };
                })
                .sort((left, right) => (left.itemRef < right.itemRef ? -1 : 1)),
            });
          }
          const row = other.rows[0];
          lines.push({
            order_ref: other.order,
            contribution_revision: "1",
            offer_ref: a.offer,
            source_grind_key_hash: null,
            quantity_milli: row.quantity,
            contribution_hash: row.hash,
            item_refs: [row.itemRef],
            items: [
              {
                itemRef: row.itemRef,
                found: true,
                productRef: a.product,
                variantRef: a.variant,
                offerRef: a.offer,
                grind: null,
                quantity: row.quantity,
                mappingOffer: a.offer,
                mappingRevision: "1",
                mappingState: "Active",
                availability: "Available",
              },
            ],
          });
          const plan = buildDesired(
            [grouped, other].map((order) => ({
              order_ref: order.order,
              contribution_revision: "1",
              order_version: "2",
            })),
            lines,
            100,
            1000,
          );
          assert.equal(
            await f.store.runOnce(new AbortController().signal),
            "prepared",
          );
          const current = await f.current();
          assert.equal(current.desired_hash, plan.hash);
          assert.deepEqual(
            await f.read(
              "SELECT source_grind_key_hash,quantity_milli::text FROM orders.cart_desired_lines ORDER BY source_grind_key_hash NULLS FIRST",
            ),
            [
              { source_grind_key_hash: null, quantity_milli: "9000" },
              { source_grind_key_hash: grind, quantity_milli: "9000" },
            ],
          );
          assert.deepEqual((await f.card(grouped.order)).blocker_codes, [
            "MAPPING_MISSING",
          ]);
          assert.deepEqual(
            await f.read(
              "SELECT order_ref,contribution_hash FROM orders.cart_desired_order_facts ORDER BY order_ref",
            ),
            plan.orders.map((order) => ({
              order_ref: order.orderRef,
              contribution_hash: order.contributionHash,
            })),
          );
          const counts = await f.read(
            "SELECT (SELECT count(*) FROM orders.outbox_messages)::int AS outbox,(SELECT count(*) FROM orders.order_aroma_projection_history)::int AS history",
          );
          await f.restart();
          assert.equal(
            await f.store.runOnce(new AbortController().signal),
            "idle",
          );
          assert.deepEqual(await f.current(), current);
          assert.deepEqual(
            await f.read(
              "SELECT (SELECT count(*) FROM orders.outbox_messages)::int AS outbox,(SELECT count(*) FROM orders.order_aroma_projection_history)::int AS history",
            ),
            counts,
          );
        });
      },
    );
    await t.test(
      "an item ref belonging only to another order stays found=false and fails closed atomically",
      async () => {
        await fixture(async (f) => {
          const p = product();
          await f.deliver(mapping(p));
          const target = await f.seed([p], { contribute: false });
          const donor = await f.seed([p]);
          await f.query(
            "INSERT INTO orders.order_desired_contributions(order_ref,contribution_revision,order_version) VALUES($1,1,2)",
            [target.order],
          );
          await f.query(
            `INSERT INTO orders.order_desired_contribution_lines(order_ref,contribution_revision,offer_ref,quantity_milli,contribution_hash,item_refs)
        VALUES($1,1,$2,1000,$3,$4)`,
            [target.order, p.offer, "a".repeat(64), [donor.rows[0].itemRef]],
          );
          await assert.rejects(
            f.store.runOnce(new AbortController().signal),
            (error) => error.code === "AROMA_CONTRIBUTION_INVALID",
          );
          assert.equal(await f.current(), undefined);
          assert.deepEqual(
            await f.read(
              "SELECT (SELECT count(*) FROM orders.outbox_messages)::int AS outbox,(SELECT count(*) FROM orders.order_aroma_projections)::int AS cards",
            ),
            [{ outbox: 0, cards: 0 }],
          );
        });
      },
    );
  },
);

void test(
  "preparation configured cardinality limits fail closed on real DB",
  live,
  async () => {
    await fixture(
      async (f) => {
        const p = product();
        await f.deliver(mapping(p));
        const one = await f.seed([p]);
        await f.deliver(one.confirmed);
        const before = await f.current();
        const two = await f.seed([p]);
        await assert.rejects(
          f.deliver(two.confirmed),
          (error) => error.code === "AROMA_PREPARATION_CARDINALITY",
        );
        assert.deepEqual(await f.current(), before);
        assert.equal(await f.card(two.order), undefined);
        await assert.rejects(
          f.tx((tx) =>
            defineStatement(f.database(), "SELECT $1::bigint")(tx, [
              "9223372036854775808",
            ]),
          ),
          (error) => error.sqlState === "22003",
        );
      },
      { maxOrders: 1 },
    );
    await fixture(
      async (f) => {
        const p = product();
        await f.deliver(mapping(p));
        const one = await f.seed([
          { ...p, grind: "a".repeat(64) },
          { ...p, grind: "b".repeat(64) },
        ]);
        await assert.rejects(
          f.deliver(one.confirmed),
          (error) => error.code === "AROMA_PREPARATION_CARDINALITY",
        );
        assert.equal(await f.current(), undefined);
      },
      { maxLines: 1 },
    );
  },
);

void test(
  "preparation VerifiedInSync uses post-mutation Observed, resolved reservation and current epoch",
  live,
  async () => {
    await fixture(async (f) => {
      const p = product();
      await f.deliver(mapping(p));
      const order = await f.seed([{ ...p, quantity: "2000" }]);
      await f.deliver(order.confirmed);
      const before = await f.observe({
        lines: [
          {
            offer_ref: p.offer,
            source_grind_key_hash: null,
            quantity_milli: "1000",
          },
        ],
      });
      await f.deliver(before.changed);
      const attempt = await f.proof(before, { reserve: true });
      await f.query(
        "UPDATE orders.mutation_reservations SET state='Dispatched',dispatched_at=clock_timestamp() WHERE operation_ref=$1",
        [attempt.operation],
      );
      await f.query(
        "UPDATE orders.convergence_attempts SET state='MutationDispatched' WHERE attempt_ref=$1",
        [attempt.attempt],
      );
      // Fake provider effect/read fixture only; no real Gateway or supplier call.
      const after = await f.observe();
      await f.query("BEGIN");
      try {
        await f.query(
          "UPDATE orders.mutation_reservations SET state='Verified',resolved_at=clock_timestamp() WHERE operation_ref=$1",
          [attempt.operation],
        );
        await f.query(
          "UPDATE orders.convergence_attempts SET state='VerifiedInSync',observed_end_revision=$1,ended_at=clock_timestamp() WHERE attempt_ref=$2",
          [after.revision, attempt.attempt],
        );
        await f.query("COMMIT");
      } catch (error) {
        await f.query("ROLLBACK");
        throw error;
      }
      const event = {
        ...attempt.changed,
        payload: {
          ...attempt.changed.payload,
          attemptState: "VerifiedInSync",
          observedRevision: after.revision,
        },
      };
      await f.deliver(event);
      const card = await f.card(order.order);
      assert.equal(card.state, "InSync");
      assert.equal(card.verified_observed_revision, after.revision);
      assert.notEqual(card.verified_observed_revision, before.revision);
      assert.equal(card.verified_attempt_ref, attempt.attempt);
      assert.equal(card.business_version, "2");
      await f.restart();
      await f.store.recover(new AbortController().signal);
      assert.deepEqual(await f.card(order.order), card);
    });
  },
);

void test("Desired arithmetic never rounds physical units or overflows int64", async () => {
  const { buildDesired } =
    await import("../../apps/orders-aroma-preparation/dist/domain/desired.js");
  const p = product();
  const pair = (quantity) => {
    const order = ref("ord");
    const itemRef = ref("itm");
    return {
      contribution: {
        order_ref: order,
        contribution_revision: "1",
        order_version: "2",
      },
      line: {
        order_ref: order,
        contribution_revision: "1",
        offer_ref: p.offer,
        source_grind_key_hash: null,
        quantity_milli: quantity,
        contribution_hash: "a".repeat(64),
        item_refs: [itemRef],
        items: [
          {
            itemRef,
            found: true,
            productRef: p.product,
            variantRef: p.variant,
            offerRef: p.offer,
            grind: null,
            quantity,
            mappingOffer: p.offer,
            mappingRevision: "1",
            mappingState: "Active",
            availability: "Available",
          },
        ],
      },
    };
  };
  const aboveInt64 = pair("9223372036854775808");
  assert.throws(
    () => buildDesired([aboveInt64.contribution], [aboveInt64.line], 2, 2),
    (error) => error.code === "AROMA_DESIRED_OVERFLOW",
  );
  const large = pair((BigInt(Number.MAX_SAFE_INTEGER) * 1000n).toString());
  const other = pair((BigInt(Number.MAX_SAFE_INTEGER) * 1000n).toString());
  assert.throws(
    () =>
      buildDesired(
        [large.contribution, other.contribution],
        [large.line, other.line],
        2,
        2,
      ),
    (error) => error.code === "AROMA_DESIRED_OVERFLOW",
  );
  const aggregateUnits = BigInt(Number.MAX_SAFE_INTEGER) / 2n + 1n;
  const aggregateLeft = pair((aggregateUnits * 1000n).toString());
  const aggregateRight = pair((aggregateUnits * 1000n).toString());
  assert.throws(
    () =>
      buildDesired(
        [aggregateLeft.contribution, aggregateRight.contribution],
        [aggregateLeft.line, aggregateRight.line],
        2,
        2,
      ),
    (error) => error.code === "AROMA_QUANTITY_NOT_SUPPORTED",
  );
  const unsupported = pair(
    ((BigInt(Number.MAX_SAFE_INTEGER) + 1n) * 1000n).toString(),
  );
  const plan = buildDesired(
    [unsupported.contribution],
    [unsupported.line],
    1,
    1,
  );
  assert.equal(plan.lines.length, 0);
  assert.equal(plan.blockers[0].code, "AROMA_QUANTITY_NOT_SUPPORTED");
  const exact = pair("1000");
  assert.equal(
    buildDesired([exact.contribution], [exact.line], 1, 1).lines[0]
      .quantityMilli,
    "1000",
  );
});
