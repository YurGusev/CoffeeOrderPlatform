import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  catalogBatchBytes,
  catalogBatchHash,
  catalogContentHash,
} from "../../packages/contracts/aroma-v1/dist/index.js";
import { createDatabase } from "../../packages/platform-database/dist/index.js";
import {
  createSqlOutboxStore,
  relayOutboxBatch,
} from "../../packages/platform-outbox/dist/index.js";
import { withCatalogPostgres } from "../../scripts/catalog-live-harness.mjs";

const SUPPLIER = "sup_00000000000000000000000001";
const P = "1".repeat(64);
const V = "2".repeat(64);
const O = "3".repeat(64);
const SNAPSHOT = "snp_00000000000000000000000021";
const pool = {
  max: 4,
  checkoutTimeoutMs: 2_000,
  lockTimeoutMs: 25_000,
  interactiveStatementTimeoutMs: 5_000,
  backgroundStatementTimeoutMs: 10_000,
  terminalTimeoutMs: 3_000,
  transactionTimeoutMs: 30_000,
  idleTimeoutMs: 30_000,
  maxLifetimeMs: 1_800_000,
};

async function stage(admin) {
  const item = {
    sourceProductKeyHash: P,
    sourceVariantKeyHash: V,
    sourceOfferKeyHash: O,
    displayName: "Кофе",
    unit: "piece",
    supplierUnitMinor: "123",
    currency: "RUB",
    availability: "Available",
    imageUrl: null,
    supplierPromotions: [],
    grindOptions: [],
    sourceIdentityScheme: "hmac-sha256-v1",
  };
  const batchHash = catalogBatchHash([item]);
  await admin.query(
    `INSERT INTO catalog.supplier_snapshots
    (snapshot_ref,supplier_ref,provider_snapshot_ref,state,next_batch_number,declared_batch_count,
     declared_product_count,declared_variant_count,declared_offer_count,received_batch_count,
     received_product_count,received_variant_count,received_offer_count,content_hash,received_at)
    VALUES ($1,$2,'provider-ref','Received',1,1,1,1,1,1,1,1,1,$3,clock_timestamp())`,
    [SNAPSHOT, SUPPLIER, catalogContentHash([batchHash])],
  );
  await admin.query(
    `INSERT INTO catalog.snapshot_batches
    (snapshot_ref,batch_number,offer_count,uncompressed_bytes,batch_hash) VALUES($1,0,1,$2,$3)`,
    [SNAPSHOT, catalogBatchBytes([item]), batchHash],
  );
  await admin.query(
    "INSERT INTO catalog.snapshot_products(snapshot_ref,source_product_key_hash,image_url) VALUES($1,$2,NULL)",
    [SNAPSHOT, P],
  );
  await admin.query(
    `INSERT INTO catalog.snapshot_variants(snapshot_ref,source_variant_key_hash,source_product_key_hash,display_name,unit)
    VALUES($1,$2,$3,'Кофе','piece')`,
    [SNAPSHOT, V, P],
  );
  await admin.query(
    `INSERT INTO catalog.snapshot_offers(snapshot_ref,source_offer_key_hash,source_variant_key_hash,batch_number,item_index,
    supplier_unit_minor,currency,supplier_promotions,grind_options,source_identity_scheme)
    VALUES($1,$2,$3,0,0,'123','RUB','[]','[]','hmac-sha256-v1')`,
    [SNAPSHOT, O, V],
  );
  await admin.query(
    "INSERT INTO catalog.snapshot_availability(snapshot_ref,source_offer_key_hash,availability) VALUES($1,$2,'Available')",
    [SNAPSHOT, O],
  );
}

function launchChild(mode, port, databaseName) {
  const child = spawn(
    process.execPath,
    [resolve("tests/catalog/activation-crash-child.mjs"), mode],
    {
      cwd: resolve("."),
      env: {
        ...process.env,
        CRASH_DB_PORT: String(port),
        CRASH_DB_NAME: databaseName,
        CRASH_DB_USER: "coffee_catalog_activate_rw",
        CRASH_DB_PASSWORD: "activate-proof",
        CRASH_SNAPSHOT: SNAPSHOT,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
  });
  const waitFor = async (type) => {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const lines = stdout.split("\n").filter(Boolean);
      for (const line of lines) {
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.type === "error")
          throw new Error(`child ${mode}: ${message.message}\n${stderr}`);
        if (message.type === type) return message;
      }
      if (child.exitCode !== null)
        throw new Error(`child ${mode} exited ${child.exitCode}: ${stderr}`);
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
    throw new Error(
      `child ${mode} did not report ${type}: ${stdout}\n${stderr}`,
    );
  };
  return {
    child,
    waitFor,
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
  };
}

async function kill(child) {
  if (child.exitCode !== null) return;
  const exited = once(child, "exit");
  if (!child.kill("SIGKILL")) return;
  const [code, signal] = await exited;
  return { code, signal };
}

async function waitForOutboxLock(admin, child, databaseName) {
  for (let attempt = 0; attempt < 200; attempt++) {
    await admin.query("SELECT pg_stat_clear_snapshot()");
    const blocked = await admin.query(
      `SELECT 1 FROM pg_stat_activity a JOIN pg_locks l ON l.pid=a.pid
      WHERE a.datname=$1 AND a.usename='coffee_catalog_activate_rw' AND a.wait_event_type='Lock'
      AND a.query LIKE '%outbox_messages%' AND l.relation='catalog.outbox_messages'::regclass AND NOT l.granted`,
      [databaseName],
    );
    if (blocked.rowCount > 0) return;
    if (child.exitCode !== null)
      throw new Error(
        "activation process exited before the Outbox lock barrier",
      );
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error(
    "activation did not reach the pre-COMMIT Outbox lock barrier",
  );
}

void test(
  "SIGKILL before and after activation COMMIT preserves atomic state and durable message IDs",
  {
    timeout: 180_000,
    skip:
      process.env.COFFEE_DB_LIVE_PROOF !== "1"
        ? "disposable PostgreSQL required"
        : false,
  },
  async () => {
    await withCatalogPostgres(async ({ adminClient, port, databaseName }) => {
      await adminClient.query(
        "CREATE ROLE coffee_catalog_activate_rw LOGIN PASSWORD 'activate-proof'",
      );
      await adminClient.query(
        "CREATE ROLE coffee_catalog_api_ro LOGIN PASSWORD 'api-proof'",
      );
      for (const name of [
        "0004_catalog_active",
        "0005_catalog_identity",
        "0006_catalog_outbox",
        "0007_catalog_grants",
        "0008_catalog_active_read",
        "0009_active_snapshot_freshness",
        "0011_active_catalog_category",
        "0012_active_supplier_promotions",
      ])
        await adminClient.query(
          await readFile(
            resolve("apps/catalog-service/migrations", `${name}.sql`),
            "utf8",
          ),
        );
      await stage(adminClient);

      assert.equal(
        (
          await adminClient.query(
            "SELECT active_snapshot_ref FROM catalog.catalog_state WHERE id=true",
          )
        ).rows[0].active_snapshot_ref,
        null,
      );
      assert.equal(
        (
          await adminClient.query(
            "SELECT state FROM catalog.supplier_snapshots WHERE snapshot_ref=$1",
            [SNAPSHOT],
          )
        ).rows[0].state,
        "Received",
      );
      assert.equal(
        (
          await adminClient.query(
            "SELECT count(*)::int AS n FROM catalog.outbox_messages",
          )
        ).rows[0].n,
        0,
      );

      await adminClient.query("BEGIN");
      let blockedChild;
      try {
        await adminClient.query(
          "LOCK TABLE catalog.outbox_messages IN ACCESS EXCLUSIVE MODE",
        );
        blockedChild = launchChild("activate-and-wait", port, databaseName);
        await blockedChild.waitFor("ready");
        await waitForOutboxLock(adminClient, blockedChild.child, databaseName);
        assert.equal(
          (
            await adminClient.query(
              "SELECT active_snapshot_ref FROM catalog.catalog_state WHERE id=true",
            )
          ).rows[0].active_snapshot_ref,
          null,
        );
        assert.equal((await kill(blockedChild.child))?.signal, "SIGKILL");
      } finally {
        if (blockedChild) await kill(blockedChild.child);
        await adminClient.query("ROLLBACK");
      }
      assert.equal(
        (
          await adminClient.query(
            "SELECT state FROM catalog.supplier_snapshots WHERE snapshot_ref=$1",
            [SNAPSHOT],
          )
        ).rows[0].state,
        "Received",
      );
      assert.equal(
        (
          await adminClient.query(
            "SELECT count(*)::int AS n FROM catalog.products WHERE snapshot_ref=$1",
            [SNAPSHOT],
          )
        ).rows[0].n,
        0,
      );
      assert.equal(
        (
          await adminClient.query(
            "SELECT count(*)::int AS n FROM catalog.outbox_messages",
          )
        ).rows[0].n,
        0,
      );

      const committed = launchChild("activate-and-wait", port, databaseName);
      const receipt = await committed.waitFor("committed");
      assert.deepEqual(
        {
          snapshotRef: receipt.snapshotRef,
          snapshotRevision: receipt.snapshotRevision,
        },
        { snapshotRef: SNAPSHOT, snapshotRevision: "1" },
      );
      assert.notEqual(receipt.pid, process.pid);
      const killed = await kill(committed.child);
      assert.equal(
        killed?.signal,
        "SIGKILL",
        "committed child must die from SIGKILL before relay",
      );

      const verified = launchChild("verify", port, databaseName);
      const verifiedExit = once(verified.child, "exit");
      const recovered = await verified.waitFor("verified");
      assert.notEqual(recovered.pid, receipt.pid);
      assert.deepEqual(
        {
          snapshotRef: recovered.snapshotRef,
          snapshotRevision: recovered.snapshotRevision,
        },
        { snapshotRef: SNAPSHOT, snapshotRevision: "1" },
      );
      assert.equal((await verifiedExit)[0], 0);

      const expected = (
        await adminClient.query(
          "SELECT message_id FROM catalog.outbox_messages ORDER BY message_id",
        )
      ).rows.map((row) => row.message_id);
      assert.equal(expected.length, 2);
      const database = createDatabase({
        owner: "catalog-activation-worker",
        database: databaseName,
        allowedDatabase: databaseName,
        host: "127.0.0.1",
        port,
        user: "coffee_catalog_activate_rw",
        password: "activate-proof",
        ssl: false,
        pool,
        shutdownGraceMs: 40_000,
      });
      await database.resource.start(new AbortController().signal);
      try {
        const relay = createSqlOutboxStore(database, { schema: "catalog" });
        const sent = [];
        for (let attempt = 0; attempt < 5; attempt++) {
          const result = await relayOutboxBatch(
            relay,
            database,
            async (claim) => {
              sent.push(claim.message.messageId);
              return { kind: "ack" };
            },
            {
              nowMs: Date.now(),
              leaseOwner: "post-sigkill-relay",
              policy: {
                leaseMs: 10_000,
                sendTimeoutMs: 2_000,
                maxInFlight: 1,
                retry: { baseMs: 100, maxMs: 1_000, maxAttempts: 3 },
              },
            },
          );
          if (result.claimed === 0) break;
        }
        assert.deepEqual(
          sent.sort((a, b) => a.localeCompare(b)),
          expected.sort((a, b) => a.localeCompare(b)),
        );
        assert.equal(
          (
            await adminClient.query(
              "SELECT count(*)::int AS n FROM catalog.outbox_messages WHERE state='Published'",
            )
          ).rows[0].n,
          2,
        );
      } finally {
        await database.resource.stop(AbortSignal.timeout(5_000));
      }
    });
  },
);

void test(
  "two independent workers claim one Received generation only once",
  {
    timeout: 180_000,
    skip:
      process.env.COFFEE_DB_LIVE_PROOF !== "1"
        ? "disposable PostgreSQL required"
        : false,
  },
  async () => {
    await withCatalogPostgres(async ({ adminClient, port, databaseName }) => {
      await adminClient.query(
        "CREATE ROLE coffee_catalog_activate_rw LOGIN PASSWORD 'activate-proof'",
      );
      await adminClient.query(
        "CREATE ROLE coffee_catalog_api_ro LOGIN PASSWORD 'api-proof'",
      );
      for (const name of [
        "0004_catalog_active",
        "0005_catalog_identity",
        "0006_catalog_outbox",
        "0007_catalog_grants",
        "0008_catalog_active_read",
        "0009_active_snapshot_freshness",
        "0011_active_catalog_category",
        "0012_active_supplier_promotions",
      ])
        await adminClient.query(
          await readFile(
            resolve("apps/catalog-service/migrations", `${name}.sql`),
            "utf8",
          ),
        );
      await stage(adminClient);
      await adminClient.query("BEGIN");
      let lockHeld = true;
      const workers = [];
      try {
        await adminClient.query(
          "LOCK TABLE catalog.supplier_snapshots IN ACCESS EXCLUSIVE MODE",
        );
        workers.push(
          launchChild("race-once", port, databaseName),
          launchChild("race-once", port, databaseName),
        );
        await Promise.all(workers.map((worker) => worker.waitFor("ready")));
        let waiting = false;
        for (let attempt = 0; attempt < 200; attempt++) {
          await adminClient.query("SELECT pg_stat_clear_snapshot()");
          const blocked = await adminClient.query(
            `SELECT count(DISTINCT l.pid)::int AS n FROM pg_locks l
          JOIN pg_stat_activity a ON a.pid=l.pid WHERE l.relation='catalog.supplier_snapshots'::regclass
          AND NOT l.granted AND a.datname=$1 AND a.usename='coffee_catalog_activate_rw'`,
            [databaseName],
          );
          if (blocked.rows[0].n === 2) {
            waiting = true;
            break;
          }
          await new Promise((resolveWait) => setTimeout(resolveWait, 25));
        }
        assert.ok(
          waiting,
          "both workers must contend on the Received table before release",
        );
        await adminClient.query("COMMIT");
        lockHeld = false;
        const receipts = await Promise.all(
          workers.map((worker) => worker.waitFor("finished")),
        );
        assert.notEqual(receipts[0].pid, receipts[1].pid);
        assert.deepEqual(
          receipts
            .map((receipt) => receipt.kind)
            .sort((left, right) => left.localeCompare(right)),
          ["activated", "idle"],
        );
        assert.equal(
          (
            await adminClient.query(
              "SELECT active_snapshot_revision FROM catalog.catalog_state WHERE id=true",
            )
          ).rows[0].active_snapshot_revision,
          "1",
        );
        assert.equal(
          (
            await adminClient.query(
              "SELECT count(*)::int AS n FROM catalog.outbox_messages",
            )
          ).rows[0].n,
          2,
        );
      } finally {
        await Promise.all(workers.map((worker) => kill(worker.child)));
        if (lockHeld) await adminClient.query("ROLLBACK");
      }
    });
  },
);
