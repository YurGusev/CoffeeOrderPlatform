import assert from "node:assert/strict";
import {readFileSync, readdirSync} from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {defineMigration} from "../../packages/platform-database/dist/owner.js";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SCRIPT = join(ROOT, "scripts/db-live-proof.mjs");

void test("migration guard accepts PostgreSQL quoted function bodies and every Orders migration", () => {
  const allowed = [
    "CREATE FUNCTION f() RETURNS void AS $$ BEGIN PERFORM 'COMMIT'; END; $$ LANGUAGE plpgsql;",
    "CREATE FUNCTION f() RETURNS void AS $func$ BEGIN PERFORM $inner$START TRANSACTION$inner$; END; $func$ LANGUAGE plpgsql;",
    `CREATE TABLE "COMMIT" (note text DEFAULT E'escaped\\' ABORT;');`,
    `CREATE TABLE t (note text DEFAULT 'doubled '' ROLLBACK;');`,
    `CREATE TABLE U&"b\\0065gin" (note text); /* outer /* BEGIN; */ COMMIT; */`,
    `CREATE TABLE t (n integer CHECK (CASE WHEN n > 0 THEN 1 ELSE 0 END = 1)); -- ROLLBACK`,
  ];
  for (const sql of allowed) assert.doesNotThrow(() => defineMigration({}, sql), sql);
  const migrations = join(ROOT, "apps/orders-service/migrations");
  for (const name of readdirSync(migrations).filter(name => name.endsWith(".sql"))) {
    assert.doesNotThrow(() => defineMigration({}, readFileSync(join(migrations, name), "utf8")), name);
  }
});

void test("migration guard rejects transaction commands at statement boundaries", () => {
  const body = "CREATE FUNCTION f() RETURNS void AS $body$ BEGIN NULL; END; $body$ LANGUAGE plpgsql;";
  const forbidden = [
    `BEGIN; ${body}`, `${body} COMMIT;`, `${body} /* outer /* END */ */ StArT TRANSACTION;`,
    `${body} -- safe text\nAbOrT;`, `SELECT 1; ROLLBACK TO SAVEPOINT s;`,
    `SELECT 1; SAVEPOINT s;`, `SELECT 1; RELEASE SAVEPOINT s;`,
    `SELECT 1; PREPARE TRANSACTION 'x';`, `SELECT 1; END WORK;`,
    `SELECT 1; SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;`,
    `SELECT 1; SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL READ COMMITTED;`,
  ];
  for (const sql of forbidden) {
    assert.throws(() => defineMigration({}, sql), error => error?.code === "DB_INVALID_CONFIGURATION", sql);
  }
});

void test("migration guard rejects unterminated SQL lexemes", () => {
  for (const sql of ["SELECT 'unterminated", `SELECT E'escaped\\'`, 'SELECT "identifier',
    "SELECT /* outer /* inner */", "SELECT $tag$body$$", "SELECT $$body$other$"]) {
    assert.throws(() => defineMigration({}, sql), error => error?.code === "DB_INVALID_CONFIGURATION", sql);
  }
});

void test("GREEN: live PostgreSQL proof is opt-in and uses the pinned isolated harness", () => {
  const result = spawnSync(process.execPath, [SCRIPT, "--run-id", "bad"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /run id/);
});

void test(
  "LIVE: PostgreSQL transaction/idempotency failures, bootstrap and role isolation",
  { skip: process.env.COFFEE_DB_LIVE_PROOF !== "1" },
  async () => {
    const { runLiveProof } = await import("../../scripts/db-live-proof.mjs");
    const result = await runLiveProof({ runId: "issue3proof" });
    assert.deepEqual(result.bootstrap, {
      firstCreatedDatabaseCount: 5,
      secondExistingDatabaseCount: 5,
      idempotent: true,
    });
    assert.deepEqual(result.roles, {
      migratorCount: 5,
      runtimeCount: 10,
      hardenedRoleCount: 15,
    });
    assert.deepEqual(result.permissions, {
      ownWriteCount: 10,
      foreignSelectDeniedCount: 40,
      foreignInsertDeniedCount: 40,
    });
    assert.equal(result.legacy.unchanged, true);
    assert.equal(result.foundation.transaction.code, "TRANSACTION_OUTCOME_UNKNOWN");
    assert.equal(result.foundation.transaction.durableCommit, true);
    assert.equal(result.foundation.transaction.durableReplayAfterRestart, true);
    assert.equal(result.foundation.transaction.rollbackAfterCommit, false);
    assert.ok(
      result.foundation.transaction.wallClockMs <
        result.foundation.transaction.boundedByMs,
    );
    assert.deepEqual(result.foundation.transaction.metricsBeforeStop, {
      active: 0,
      idle: 0,
      waiting: 0,
      saturationTotal: 0,
      pending: 0,
    });
    assert.ok(result.foundation.transaction.closedPeersBeforeStop > 0);
    assert.equal(result.foundation.rollback.code, "DB_ROLLBACK_FAILED");
    assert.equal(result.foundation.rollback.destroyed, true);
    assert.ok(
      result.foundation.rollback.wallClockMs <
        result.foundation.rollback.boundedByMs,
    );
    assert.ok(result.foundation.rollback.closedPeersBeforeStop > 0);
    assert.deepEqual(result.foundation.rollback.metricsBeforeStop, {
      active: 0,
      idle: 0,
      waiting: 0,
      saturationTotal: 0,
      pending: 0,
    });
    assert.equal(result.foundation.caughtSqlRollback.code, "DB_TRANSACTION_ROLLED_BACK");
    assert.equal(result.foundation.caughtSqlRollback.nextCall, "acquired");
    assert.equal(result.foundation.caughtSqlRollback.falseReplay, false);
    assert.equal(result.foundation.idempotency.acquiredCount, 1);
    assert.equal(result.foundation.idempotency.replayable, true);
    assert.equal(result.foundation.idempotency.conflict, true);
    assert.equal(result.foundation.idempotency.expiredLeaseRequiresRecovery, true);
    assert.equal(result.foundation.idempotency.atomicOwnerMutation, true);
    assert.deepEqual(result.foundation.idempotency.terminalReplayBodies, [null, "plain-string"]);
    assert.equal(result.foundation.migration.driftRejected, true);
    assert.equal(result.foundation.copy.rowsAfterRollback, 0);
    assert.equal(result.foundation.copy.code, "DB_INTERRUPTED");
    assert.equal(result.foundation.copy.sourceDestroyed, true);
    assert.ok(result.foundation.copy.sourceYielded > 0);
    assert.equal(result.foundation.readiness.secondCode, "DB_POOL_EXHAUSTED");
    assert.ok(result.foundation.readiness.saturationTotal > 0);
    assert.equal(result.foundation.readiness.activeAfter, 0);
    assert.equal(result.foundation.readiness.readyAfterDestroy, false);
    assert.equal(result.foundation.readiness.transientSaturationSeparate, true);
    assert.equal(result.delivery.transport, "postgresql-only");
    assert.equal(result.delivery.realKafka, false);
    assert.equal(result.delivery.structural.kind, "owner-local-sql-contract");
    assert.equal(result.delivery.structural.source, "exportedSQLContract");
    assert.equal(result.delivery.structural.liveDatabase, false);
    assert.equal(result.delivery.structural.realKafka, false);
    assert.equal(
      result.delivery.structural.checks.includes(
        "outbox-aggregate-sequence-independent-of-message-type",
      ),
      true,
    );
    assert.equal(result.delivery.brokerAckProof, "not-run");
    assert.equal(result.delivery.offsetCommitProof, "not-run");
    assert.equal(result.delivery.atomicity.committedInboxOwnerOutbox, true);
    assert.equal(result.delivery.atomicity.rollbackCode, "DB_QUERY_FAILED");
    assert.equal(result.delivery.atomicity.rollbackLeftNoPartialRows, true);
    assert.equal(result.delivery.atomicity.redeliveryProcessed, true);
    assert.equal(result.delivery.duplicateConflict.inboxDuplicate, true);
    assert.equal(result.delivery.duplicateConflict.inboxConflict, true);
    assert.equal(result.delivery.duplicateConflict.quarantine, "created");
    assert.equal(result.delivery.duplicateConflict.outboxDuplicate, true);
    assert.equal(result.delivery.duplicateConflict.outboxConflict, true);
    assert.equal(result.delivery.payloadHash.inboxValidated, true);
    assert.equal(result.delivery.payloadHash.outboxValidated, true);
    assert.equal(result.delivery.payloadHash.conflictQuarantined, true);
    assert.equal(result.delivery.payloadHash.recoveredClaimValidated, true);
    assert.equal(result.delivery.differentMessageTypeSequence.concurrent, true);
    assert.equal(result.delivery.differentMessageTypeSequence.accepted, 1);
    assert.equal(result.delivery.differentMessageTypeSequence.conflicts, 1);
    assert.equal(result.delivery.differentMessageTypeSequence.durableRows, 1);
    assert.deepEqual(result.delivery.aggregateOrdering.sameAggregate, ["1", "2"]);
    assert.equal(result.delivery.aggregateOrdering.sequenceBarrier, true);
    assert.equal(result.delivery.aggregateOrdering.otherAggregateIndependent, true);
    assert.equal(result.delivery.crashAfterClaimBeforeFinalize.stableMessageId, true);
    assert.equal(result.delivery.crashAfterClaimBeforeFinalize.recovered, true);
    assert.equal(result.delivery.crashAfterClaimBeforeFinalize.staleFenceCode, "OUTBOX_LEASE_INVALID");
    assert.equal(result.delivery.crashAfterClaimBeforeFinalize.brokerAckProof, "not-run");
    assert.equal(result.delivery.dbUnknown.code, "TRANSACTION_OUTCOME_UNKNOWN");
    assert.equal(result.delivery.dbUnknown.durableInboxState, "Processed");
    assert.equal(result.delivery.dbUnknown.durableOutboxState, "Pending");
    assert.equal(result.delivery.dbUnknown.replay, "duplicate");
    assert.equal(result.delivery.dbUnknown.stableMessageId, true);
    assert.equal(result.cleanup.containerRemoved, true);
  },
);
