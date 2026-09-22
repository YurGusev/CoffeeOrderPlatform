import test from "node:test";
import assert from "node:assert/strict";
import {catalogBatchHash, catalogContentHash} from "../../packages/contracts/aroma-v1/dist/index.js";
import {runCatalogCopyProof} from "../../scripts/catalog-copy-live-proof.mjs";

void test("disposable PostgreSQL proves migrations, TEMP COPY, reconstruction, tamper, rollback, and grants", {timeout: 120_000}, async () => {
  const result = await runCatalogCopyProof();
  assert.equal(result.skipped, false);
  assert.equal(result.migrations, "idempotent");
  assert.equal(result.copy, "bounded-temp-copy");
  for (const name of ["validation","copy","transaction"]) {
    const phase=result.telemetry.spans[`catalog.import.${name}`];
    assert.ok(phase.started>0);
    assert.equal(phase.started,phase.ended);
  }
  assert.match(result.telemetry.metrics.join("\n"),/coffee_catalog_import_batches_total [1-9]/u);
  assert.match(result.telemetry.metrics.join("\n"),/coffee_catalog_import_batch_bytes_total [1-9]/u);
  assert.equal(result.reconstruction.batchHash, catalogBatchHash(result.reconstruction.items));
  assert.equal(result.reconstruction.contentHash, catalogContentHash([result.reconstruction.batchHash]));
  assert.equal(result.tamperRejected, true);
  assert.equal(result.ordinalTamperRejected, true);
  assert.equal(result.durableCountTamperRejected, true);
  assert.equal(result.replayConflictRejected, true);
  assert.equal(result.receivingReplayConflictRejected, true);
  assert.equal(result.terminalConflictRejected, true);
  assert.equal(result.terminalTimestampConflictRejected, true);
  assert.equal(result.semanticDriftRejected, true);
  assert.equal(result.grindDriftRejected, true);
  assert.equal(result.rollbackAtomic, true);
  assert.equal(result.grantsLeastPrivilege, true);
});
