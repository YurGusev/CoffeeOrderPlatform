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
  "LIVE: disposable PostgreSQL bootstrap, role grants and legacy sentinel proof",
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
    assert.equal(result.cleanup.containerRemoved, true);
  },
);
