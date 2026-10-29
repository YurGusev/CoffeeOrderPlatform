import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { createDatabase } from "../../packages/platform-database/dist/index.js";
import { PricingStore } from "../../apps/pricing-service/dist/infrastructure/database/pricing-store.js";
import { withCatalogPostgres } from "../../scripts/catalog-live-harness.mjs";
import { openBlackholeProxy } from "../../scripts/db-live-proof.mjs";

const root = resolve(import.meta.dirname, "../..");
const pool = Object.freeze({
  max: 4,
  checkoutTimeoutMs: 2_000,
  lockTimeoutMs: 1_000,
  interactiveStatementTimeoutMs: 5_000,
  backgroundStatementTimeoutMs: 10_000,
  terminalTimeoutMs: 3_000,
  transactionTimeoutMs: 20_000,
  idleTimeoutMs: 30_000,
  maxLifetimeMs: 1_800_000,
});
const migrationNames = [
  "0001_create_pricing_policy_versions.sql",
  "0002_create_pricing_quotes.sql",
  "0003_create_pricing_idempotency.sql",
  "0004_create_pricing_audit.sql",
  "0005_quote_grind_selection.sql",
];
const scope = createHash("sha256")
  .update("POST\n/api/client-v1/pricing/quotes", "utf8")
  .digest("hex");
const actorRef = "pricing-live-recovery-actor";
const customerRef = "cus_00000000000000000000000001";
const productRef = "prd_00000000000000000000000001";
const variantRef = "var_00000000000000000000000001";
const offerRef = "off_00000000000000000000000001";

function identity(key, actor = actorRef, commandScope = scope) {
  return { actorRef: actor, scope: commandScope, key };
}
function requestHash(key) {
  return createHash("sha256")
    .update(
      JSON.stringify({ key, customerRef, productRef, variantRef }),
      "utf8",
    )
    .digest("hex");
}
function correlationId() {
  return randomBytes(16)
    .toString("hex")
    .replace(/^(........)(....)(....)(....)(............)$/u, "$1-$2-$3-$4-$5");
}

async function installPricingSchema(admin) {
  const runtimePassword = randomBytes(24).toString("hex");
  await admin.query(
    `CREATE ROLE coffee_pricing_rw LOGIN PASSWORD '${runtimePassword}'`,
  );
  for (const name of migrationNames) {
    const sql = await readFile(
      resolve(root, `apps/pricing-service/migrations/${name}`),
      "utf8",
    );
    await admin.query(sql);
  }
  return runtimePassword;
}

async function inspectRows(admin, keyIdentity) {
  const [quotes, lines, audits, idempotency] = await Promise.all([
    admin.query(
      "SELECT quote_ref FROM pricing.pricing_quotes WHERE actor_ref=$1 AND request_hash=$2",
      [keyIdentity.actorRef, requestHash(keyIdentity.key)],
    ),
    admin.query(
      "SELECT l.quote_ref FROM pricing.pricing_quote_lines l JOIN pricing.pricing_quotes q USING (quote_ref) WHERE q.actor_ref=$1 AND q.request_hash=$2",
      [keyIdentity.actorRef, requestHash(keyIdentity.key)],
    ),
    admin.query(
      "SELECT a.audit_ref FROM pricing.pricing_audit_records a WHERE a.actor_ref=$1 AND a.correlation_id IN (SELECT correlation_id FROM pricing.pricing_quotes WHERE actor_ref=$1 AND request_hash=$2)",
      [keyIdentity.actorRef, requestHash(keyIdentity.key)],
    ),
    admin.query(
      "SELECT state FROM pricing.pricing_idempotency_records WHERE actor_ref=$1 AND scope=$2 AND idempotency_key=$3",
      [keyIdentity.actorRef, keyIdentity.scope, keyIdentity.key],
    ),
  ]);
  return {
    quotes: quotes.rowCount,
    lines: lines.rowCount,
    audits: audits.rowCount,
    completed: idempotency.rows.filter((row) => row.state === "Completed")
      .length,
    idempotencyStates: idempotency.rows.map((row) => row.state),
  };
}

async function installFailure(admin, table, event, condition = "") {
  await admin.query(
    `CREATE OR REPLACE FUNCTION pricing.live_recovery_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'pricing live recovery injected failure'; END $$`,
  );
  await admin.query(
    `CREATE TRIGGER live_recovery_failure AFTER ${event} ON pricing.${table} FOR EACH ROW ${condition} EXECUTE FUNCTION pricing.live_recovery_failure()`,
  );
}
async function removeFailure(admin, table) {
  await admin.query(
    `DROP TRIGGER IF EXISTS live_recovery_failure ON pricing.${table}`,
  );
  await admin.query("DROP FUNCTION IF EXISTS pricing.live_recovery_failure()");
}

/** @type {Parameters<PricingStore["create"]>[0]} */
function createFacts(key, policy) {
  return {
    identity: identity(key),
    requestHash: requestHash(key),
    correlationId: correlationId(),
    policy,
    customerRef,
    catalogSnapshotRevision: "1",
    lines: [
      {
        productRef,
        variantRef,
        quantity: "1",
        productDisplayName: "Recovery fixture",
        unit: "piece",
        offerRef,
        mappingRevision: "1",
        supplierUnitMinor: "100",
        catalogSnapshotRevision: "1",
      },
    ],
    signal: AbortSignal.timeout(5_000),
  };
}

void test(
  "LIVE: PricingStore quote transaction rolls back at every persistence boundary and permits same-key retry",
  {
    timeout: 180_000,
    skip:
      process.env.COFFEE_DB_LIVE_PROOF !== "1"
        ? "disposable PostgreSQL required"
        : false,
  },
  async () => {
    const receipt = await withCatalogPostgres(
      async ({ adminClient: admin, port, databaseName }) => {
        const runtimePassword = await installPricingSchema(admin);
        const database = createDatabase({
          owner: "pricing-service",
          database: databaseName,
          allowedDatabase: databaseName,
          host: "127.0.0.1",
          port,
          user: "coffee_pricing_rw",
          password: runtimePassword,
          ssl: false,
          pool,
          shutdownGraceMs: 40_000,
        });
        try {
          await database.resource.start(AbortSignal.timeout(5_000));
          const store = new PricingStore(database);
          const policy = await store.readActivePolicy(
            AbortSignal.timeout(5_000),
          );
          const boundaries = [
            { name: "quote insert", table: "pricing_quotes", event: "INSERT" },
            {
              name: "first line insert",
              table: "pricing_quote_lines",
              event: "INSERT",
            },
            {
              name: "audit insert",
              table: "pricing_audit_records",
              event: "INSERT",
            },
            {
              name: "idempotency Completed",
              table: "pricing_idempotency_records",
              event: "INSERT OR UPDATE",
              condition: "WHEN (NEW.state = 'Completed')",
            },
          ];
          const failures = [];
          for (const [index, boundary] of boundaries.entries()) {
            const key = `70000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
            const facts = createFacts(key, policy);
            await installFailure(
              admin,
              boundary.table,
              boundary.event,
              boundary.condition,
            );
            let failure;
            try {
              await store.create(facts);
            } catch (error) {
              failure = error;
            } finally {
              await removeFailure(admin, boundary.table);
            }
            assert.ok(
              failure,
              `${boundary.name}: injected PostgreSQL failure must reject create`,
            );
            const afterFailure = await inspectRows(admin, facts.identity);
            assert.deepEqual(
              afterFailure,
              {
                quotes: 0,
                lines: 0,
                audits: 0,
                completed: 0,
                idempotencyStates: [],
              },
              `${boundary.name}: transaction left durable partial state`,
            );
            const retry = await store.create({
              ...facts,
              signal: AbortSignal.timeout(5_000),
            });
            assert.equal(
              retry.status,
              201,
              `${boundary.name}: same-key retry did not succeed`,
            );
            assert.equal(
              (await inspectRows(admin, facts.identity)).completed,
              1,
              `${boundary.name}: retry did not complete idempotency`,
            );
            failures.push(boundary.name);
          }
          const replayKey = "70000000-0000-4000-8000-000000000099";
          const replayIdentity = identity(replayKey);
          const replayFacts = createFacts(replayKey, policy);
          await store.create(replayFacts);
          const beforeReplay = await inspectRows(admin, replayIdentity);
          const replay = await store.precheck(
            replayIdentity,
            undefined,
            AbortSignal.timeout(5_000),
          );
          assert.equal(
            replay.kind,
            "completed",
            "read-only recovery lookup did not replay the completed result",
          );
          assert.equal(replay.replayed, true);
          assert.deepEqual(
            await inspectRows(admin, replayIdentity),
            beforeReplay,
            "read-only replay mutated persisted state",
          );
          for (const mismatch of [
            identity(replayKey, `${actorRef}-other`, scope),
            identity(
              replayKey,
              actorRef,
              createHash("sha256").update("other-scope").digest("hex"),
            ),
            identity("70000000-0000-4000-8000-000000000098", actorRef, scope),
          ]) {
            assert.equal(
              (
                await store.precheck(
                  mismatch,
                  undefined,
                  AbortSignal.timeout(5_000),
                )
              ).kind,
              "not_retained",
              "read-only lookup crossed actor/scope/key boundary",
            );
          }
          assert.equal(
            (
              await store.precheck(
                replayIdentity,
                createHash("sha256").update("different request").digest("hex"),
                AbortSignal.timeout(5_000),
              )
            ).kind,
            "conflict",
          );
          assert.deepEqual(
            await inspectRows(admin, replayIdentity),
            beforeReplay,
            "mismatched read-only lookups mutated persisted state",
          );

          const expiredKey = "70000000-0000-4000-8000-000000000097";
          const expiredIdentity = identity(expiredKey);
          await admin.query(
            `INSERT INTO pricing.pricing_idempotency_records
          (actor_ref, scope, idempotency_key, request_hash, state, lease_owner, lease_until, created_at, expires_at)
         VALUES ($1,$2,$3,$4,'Acquired',$5::uuid,now()-interval '2 minutes',now()-interval '3 minutes',now()+interval '1 day')`,
            [
              expiredIdentity.actorRef,
              expiredIdentity.scope,
              expiredIdentity.key,
              requestHash(expiredKey),
              "70000000-0000-4000-8000-000000000096",
            ],
          );
          assert.equal(
            (
              await store.precheck(
                expiredIdentity,
                requestHash(expiredKey),
                AbortSignal.timeout(5_000),
              )
            ).kind,
            "in_progress",
            "expired Acquired lease was not retained as in-progress",
          );
          assert.deepEqual(await inspectRows(admin, expiredIdentity), {
            quotes: 0,
            lines: 0,
            audits: 0,
            completed: 0,
            idempotencyStates: ["Acquired"],
          });
          return {
            failures,
            sameKeyRetries: failures.length,
            replay: replay.kind,
            expiredAcquired: "in_progress",
          };
        } finally {
          await database.resource
            .stop(AbortSignal.timeout(5_000))
            .catch(() => undefined);
        }
      },
    );
    assert.equal(receipt.cleanup.containerRemoved, true);
    assert.deepEqual(receipt.failures, [
      "quote insert",
      "first line insert",
      "audit insert",
      "idempotency Completed",
    ]);
    assert.equal(receipt.sameKeyRetries, 4);
    assert.equal(receipt.replay, "completed");
    assert.equal(receipt.expiredAcquired, "in_progress");
  },
);

void test(
  "LIVE: потерянное подтверждение COMMIT не повторяет quote и после restart отдаёт исходный ответ",
  {
    timeout: 180_000,
    skip:
      process.env.COFFEE_DB_LIVE_PROOF !== "1"
        ? "disposable PostgreSQL required"
        : false,
  },
  async () => {
    const receipt = await withCatalogPostgres(
      async ({ adminClient: admin, port, databaseName }) => {
        const runtimePassword = await installPricingSchema(admin);
        const options = {
          owner: "pricing-service",
          database: databaseName,
          allowedDatabase: databaseName,
          host: "127.0.0.1",
          user: "coffee_pricing_rw",
          password: runtimePassword,
          ssl: false,
          pool,
          shutdownGraceMs: 40_000,
        };
        const initial = createDatabase({ ...options, port });
        let policy;
        try {
          await initial.resource.start(AbortSignal.timeout(5_000));
          policy = await new PricingStore(initial).readActivePolicy(
            AbortSignal.timeout(5_000),
          );
        } finally {
          await initial.resource.stop(AbortSignal.timeout(5_000));
        }
        const key = "70000000-0000-4000-8000-000000000077";
        const facts = createFacts(key, policy);
        const proxy = await openBlackholeProxy(port, "COMMIT", {
          dropOnce: true,
        });
        const ambiguous = createDatabase({ ...options, port: proxy.port });
        try {
          await ambiguous.resource.start(AbortSignal.timeout(5_000));
          await assert.rejects(new PricingStore(ambiguous).create(facts), {
            code: "TRANSACTION_OUTCOME_UNKNOWN",
          });
          assert.equal((await proxy.waitForReplyDropped()).tag, "COMMIT");
          assert.ok(proxy.observed.includes("COMMIT"));
          assert.equal(proxy.observed.includes("ROLLBACK"), false);
        } finally {
          await ambiguous.resource
            .stop(AbortSignal.timeout(5_000))
            .catch(() => undefined);
          await proxy.close();
        }
        const persisted = await inspectRows(admin, facts.identity);
        assert.deepEqual(persisted, {
          quotes: 1,
          lines: 1,
          audits: 1,
          completed: 1,
          idempotencyStates: ["Completed"],
        });
        const completed = await admin.query(
          "SELECT resource_ref,response_body FROM pricing.pricing_idempotency_records WHERE actor_ref=$1 AND scope=$2 AND idempotency_key=$3",
          [facts.identity.actorRef, facts.identity.scope, facts.identity.key],
        );
        assert.equal(completed.rowCount, 1);
        const restarted = createDatabase({ ...options, port });
        try {
          await restarted.resource.start(AbortSignal.timeout(5_000));
          const store = new PricingStore(restarted);
          const readOnly = await store.precheck(
            facts.identity,
            undefined,
            AbortSignal.timeout(5_000),
          );
          assert.equal(readOnly.kind, "completed");
          assert.equal(readOnly.status, 201);
          assert.equal(readOnly.body.quoteRef, completed.rows[0].resource_ref);
          assert.deepEqual(readOnly.body, completed.rows[0].response_body);
          const replayed = await store.create({
            ...facts,
            signal: AbortSignal.timeout(5_000),
          });
          assert.equal(replayed.replayed, true);
          assert.deepEqual(replayed.body, readOnly.body);
          assert.deepEqual(await inspectRows(admin, facts.identity), persisted);
          return { quoteRef: readOnly.body.quoteRef };
        } finally {
          await restarted.resource.stop(AbortSignal.timeout(5_000));
        }
      },
    );
    assert.equal(receipt.cleanup.containerRemoved, true);
    assert.match(receipt.quoteRef, /^prq_/u);
  },
);
