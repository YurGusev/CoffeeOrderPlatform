import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {once} from "node:events";
import {readFile} from "node:fs/promises";
import {resolve} from "node:path";
import test from "node:test";
import {createDatabase, withTransaction} from "../../packages/platform-database/dist/index.js";
import {createSqlOutboxStore} from "../../packages/platform-outbox/dist/index.js";
import {withCatalogPostgres} from "../../scripts/catalog-live-harness.mjs";

const root = resolve(import.meta.dirname, "../..");
const childFile = resolve(root, "tests/catalog-pipeline/publisher-child.mjs");
const messageId = "msg_issue18_publisher_restart_0001";
const password = "publisher-proof-pass";
const pool = {max: 3, checkoutTimeoutMs: 2_000, lockTimeoutMs: 20_000,
  interactiveStatementTimeoutMs: 5_000, backgroundStatementTimeoutMs: 15_000,
  terminalTimeoutMs: 3_000, transactionTimeoutMs: 25_000,
  idleTimeoutMs: 30_000, maxLifetimeMs: 1_800_000};

function launch({port, databaseName, leaseOwner, hold = false, blockSender = false}) {
  const child = spawn(process.execPath, [childFile], {cwd: root, env: {...process.env,
    DB_PORT: String(port), DB_NAME: databaseName, DB_USER: "coffee_catalog_activate_rw",
    DB_PASSWORD: password, LEASE_OWNER: leaseOwner, LEASE_MS: "6000",
    HOLD_AFTER_RETURNED: hold ? "1" : "0", BLOCK_SENDER: blockSender ? "1" : "0"}, stdio: ["pipe", "pipe", "pipe"]});
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", chunk => {stdout += chunk;});
  child.stderr.setEncoding("utf8").on("data", chunk => {stderr += chunk;});
  const waitFor = async phase => {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      for (const line of stdout.split("\n")) {
        let record;
        try { record = JSON.parse(line); } catch { continue; }
        if (record.phase === "error") throw new Error(`publisher child failed: ${record.message}\\n${stderr}`);
        if (record.phase === phase) return record;
      }
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(`publisher child exited before ${phase} (code=${child.exitCode}, signal=${child.signalCode}): ${stderr}`);
      await new Promise(resolveWait => setTimeout(resolveWait, 20));
    }
    throw new Error(`publisher child timed out waiting for ${phase}: ${stdout}\\n${stderr}`);
  };
  return {child, waitFor, get stdout() {return stdout;}, get stderr() {return stderr;}};
}

async function killWithSigkill(child) {
  if (child.exitCode !== null || child.signalCode !== null) return {signal: child.signalCode};
  const exited = once(child, "exit");
  assert.equal(child.kill("SIGKILL"), true, "child must accept SIGKILL");
  const exit = await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error("child SIGKILL exit timed out")), 5_000))]);
  return {code: exit[0], signal: exit[1]};
}

async function waitForFinalizeBlocked(admin, databaseName, childPid) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    await admin.query("SELECT pg_stat_clear_snapshot()");
    const result = await admin.query(`SELECT a.pid FROM pg_stat_activity a
      JOIN pg_locks l ON l.pid = a.pid
      WHERE a.datname = $1 AND a.application_name = $2 AND a.wait_event_type = 'Lock'
        AND a.query ILIKE '%UPDATE%outbox_messages%' AND l.relation = 'catalog.outbox_messages'::regclass
        AND NOT l.granted`, [databaseName, childPid]);
    if (result.rowCount === 1) return;
    await new Promise(resolveWait => setTimeout(resolveWait, 25));
  }
  const observed = await admin.query(`SELECT a.state, a.wait_event_type, a.wait_event, a.query, l.locktype, l.mode, l.granted, l.relation::regclass::text AS relation
    FROM pg_stat_activity a LEFT JOIN pg_locks l ON l.pid = a.pid WHERE a.datname = $1 AND a.application_name = $2`, [databaseName, childPid]);
  throw new Error(`publisher did not reach blocked finalize UPDATE; pre-COMMIT kill barrier was not proven: ${JSON.stringify(observed.rows)}`);
}

async function waitForLeaseExpiry(admin) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await admin.query("SELECT lease_until <= clock_timestamp() AS expired FROM catalog.outbox_messages WHERE message_id = $1", [messageId]);
    if (result.rows[0]?.expired) return;
    await new Promise(resolveWait => setTimeout(resolveWait, 25));
  }
  throw new Error("claimed lease did not expire within bounded recovery window");
}

async function baseline(admin) {
  const result = await admin.query(`SELECT
    (SELECT count(*)::int FROM catalog.supplier_snapshots) AS snapshots,
    (SELECT count(*)::int FROM catalog.products) AS products,
    (SELECT count(*)::int FROM catalog.variants) AS variants,
    (SELECT count(*)::int FROM catalog.offer_mappings) AS mappings,
    (SELECT count(*)::int FROM catalog.availability) AS availability,
    (SELECT count(*)::int FROM catalog.source_identities) AS identities,
    (SELECT count(*)::int FROM catalog.offer_binding_acks) AS binding_acks,
    (SELECT active_snapshot_revision::text FROM catalog.catalog_state WHERE id = true) AS revision`);
  return result.rows[0];
}

void test("Outbox publisher restart before finalize COMMIT and after Published COMMIT", {
  timeout: 180_000,
  skip: process.env.COFFEE_DB_LIVE_PROOF !== "1" ? "set COFFEE_DB_LIVE_PROOF=1 to run disposable PostgreSQL and OS-process proof" : false,
}, async () => {
  await withCatalogPostgres(async ({adminClient, port, databaseName}) => {
    const children = [];
    let publisherDatabase;
    try {
      await adminClient.query("CREATE ROLE coffee_catalog_activate_rw LOGIN PASSWORD 'publisher-proof-pass'");
      await adminClient.query("CREATE ROLE coffee_catalog_api_ro LOGIN PASSWORD 'api-proof-pass'");
      for (const name of ["0004_catalog_active", "0005_catalog_identity", "0006_catalog_outbox", "0007_catalog_grants", "0008_catalog_active_read", "0009_active_snapshot_freshness"])
        await adminClient.query(await readFile(resolve(root, "apps/catalog-service/migrations", `${name}.sql`), "utf8"));

      publisherDatabase = createDatabase({owner: "catalog-outbox-publisher-parent", database: databaseName,
        allowedDatabase: databaseName, host: "127.0.0.1", port, user: "coffee_catalog_activate_rw",
        password, ssl: false, pool, shutdownGraceMs: 40_000});
      await publisherDatabase.resource.start(new AbortController().signal);
      const store = createSqlOutboxStore(publisherDatabase, {schema: "catalog"});
      const occurredAt = new Date().toISOString();
      const payload = {proof: "publisher restart", sequence: 1};
      const traceparent = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01";
      const message = {messageId, messageType: "CatalogPublisherRestartProof.v1", topic: "coffee.catalog.proof.v1",
        aggregateRef: "catalog-publisher-proof", aggregateSequence: 1, ownerVersion: "1",
        partitionKey: "catalog-publisher-proof", schemaVersion: "1", occurredAt,
        correlationId: "corr_issue18_publisher_restart", traceparent, payload,
        envelope: {envelopeVersion: "1", messageId, messageType: "CatalogPublisherRestartProof.v1", occurredAt,
          producer: "issue18-publisher-proof", correlationId: "corr_issue18_publisher_restart", causationId: null,
          traceparent, aggregate: {type: "Catalog", ref: "catalog-publisher-proof", version: "1"}, payload}};
      assert.equal(await withTransaction(publisherDatabase, {mode: "background"}, tx => store.enqueue(tx, message)), "created");
      const before = await baseline(adminClient);
      assert.equal((await adminClient.query("SELECT count(*)::int AS n FROM catalog.outbox_messages WHERE message_id=$1", [messageId])).rows[0].n, 1);

      // The ACCESS EXCLUSIVE lock forces finalize UPDATE to wait after sender ack.
      const preCommit = launch({port, databaseName, leaseOwner: "publisher-before-commit", blockSender: true});
      children.push(preCommit.child);
      const ack = await preCommit.waitFor("sender_ack");
      assert.equal(ack.messageId, messageId);
      await adminClient.query("BEGIN");
      await adminClient.query("LOCK TABLE catalog.outbox_messages IN ACCESS EXCLUSIVE MODE");
      preCommit.child.stdin.write("continue\n");
      await waitForFinalizeBlocked(adminClient, databaseName, "publisher-before-commit");
      const killedBeforeCommit = await killWithSigkill(preCommit.child);
      assert.equal(killedBeforeCommit.signal, "SIGKILL");
      await adminClient.query("ROLLBACK");
      assert.deepEqual((await adminClient.query("SELECT state, attempt FROM catalog.outbox_messages WHERE message_id=$1", [messageId])).rows[0],
        {state: "Publishing", attempt: 1});
      await waitForLeaseExpiry(adminClient);

      const recovery = launch({port, databaseName, leaseOwner: "publisher-after-restart"});
      children.push(recovery.child);
      const recoveredAck = await recovery.waitFor("sender_ack");
      assert.notEqual(recoveredAck.pid, ack.pid);
      assert.equal(recoveredAck.messageId, messageId);
      const recovered = await recovery.waitFor("relay_returned");
      assert.equal(recovered.pid, recoveredAck.pid);
      assert.equal(recovered.messageId, messageId);
      assert.deepEqual(recovered.result, {claimed: 1, published: 1, failed: 0, unknown: 0, quarantined: 0});
      assert.equal((await Promise.race([once(recovery.child, "exit"), new Promise((_, reject) => setTimeout(() => reject(new Error("recovery child exit timed out")), 5_000))]))[0], 0);

      const afterCommit = launch({port, databaseName, leaseOwner: "publisher-after-commit", hold: true});
      children.push(afterCommit.child);
      const idle = await afterCommit.waitFor("relay_returned");
      assert.notEqual(idle.pid, recovered.pid);
      assert.equal(idle.messageId, null, "Published row must not be sent again after restart");
      assert.deepEqual(idle.result, {claimed: 0, published: 0, failed: 0, unknown: 0, quarantined: 0});
      const killedAfterCommit = await killWithSigkill(afterCommit.child);
      assert.equal(killedAfterCommit.signal, "SIGKILL", "second child is killed only after relay returned beyond finalize COMMIT");

      const finalRows = await adminClient.query(`SELECT message_id, state, attempt, published_at,
        (SELECT count(*)::int FROM catalog.outbox_messages WHERE message_id=$1) AS durable_rows
        FROM catalog.outbox_messages WHERE message_id=$1`, [messageId]);
      assert.equal(finalRows.rowCount, 1);
      assert.equal(finalRows.rows[0].durable_rows, 1);
      assert.equal(finalRows.rows[0].message_id, messageId);
      assert.equal(finalRows.rows[0].state, "Published");
      assert.equal(finalRows.rows[0].attempt, 2);
      assert.ok(finalRows.rows[0].published_at);
      assert.deepEqual(await baseline(adminClient), before, "recovery must not create catalog refs, revisions, or events");
      assert.equal((await adminClient.query("SELECT count(*)::int AS n FROM catalog.outbox_messages WHERE state='Published' AND message_id=$1", [messageId])).rows[0].n, 1);
    } finally {
      for (const child of children) if (child.exitCode === null && child.signalCode === null) await killWithSigkill(child).catch(() => {});
      if (publisherDatabase !== undefined) await publisherDatabase.resource.stop(AbortSignal.timeout(5_000)).catch(() => {});
    }
  });
});
