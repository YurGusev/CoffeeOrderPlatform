import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SCRIPT = join(ROOT, "scripts/db-live-proof.mjs");

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
    assert.equal(result.cleanup.containerRemoved, true);
  },
);
