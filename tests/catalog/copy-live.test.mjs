import test from "node:test";
import assert from "node:assert/strict";
import {catalogBatchHash, catalogContentHash} from "../../packages/contracts/aroma-v1/dist/index.js";
import {runCatalogCopyProof} from "../../scripts/catalog-copy-live-proof.mjs";

void test("disposable PostgreSQL proves migrations, TEMP COPY, reconstruction, tamper, rollback, and grants", {timeout: 300_000}, async t => {
  const result = await runCatalogCopyProof();
  assert.equal(result.skipped, false);
  assert.equal(result.migrations, "idempotent");
  assert.equal(result.copy, "bounded-temp-copy");
  assert.equal(result.migrationProof.ledger,"catalog.platform_schema_migrations");
  assert.equal(result.postMergeRollback.sqlstate,"42501");
  assert.equal(result.noActiveCopyOrTransaction,true);
  const httpCopyShutdown=result.httpCopyShutdown;
  assert.equal(httpCopyShutdown.readerCancelled,true);
  assert.equal(httpCopyShutdown.copyCancelled,true);
  assert.equal(httpCopyShutdown.sourceDestroyed,true);
  assert.equal(httpCopyShutdown.sixTablesRolledBack,true);
  assert.equal(httpCopyShutdown.connectionReleased,true);
  assert.equal(httpCopyShutdown.shutdownAborted,true);
  assert.ok(httpCopyShutdown.shutdownMs<40_000);
  assert.deepEqual(result.migrationProof.preservedStates,["Created","Received","Receiving","Rejected"]);
  assert.equal(result.migrationProof.repeatNoop,true);
  assert.equal(result.migrationProof.driftCode,"MIGRATION_CHECKSUM_DRIFT");
  assert.equal(result.migrationProof.recomputedChecksum,true);
  assert.equal(result.migrationProof.ledgerUnchanged,true);
  for (const key of ["midCopyAbort","copySourceFailure","postMergeRollback"]) {
    const proof=result[key];
    assert.equal(proof.sixTablesUnchanged,true,key);
    assert.equal(proof.poolUsable,true,key);
    assert.deepEqual(proof.after,proof.before,key);
    assert.equal(Object.keys(proof.before).length,6,key);
    if (key !== "postMergeRollback") {
      assert.ok(proof.consumedChunks >= 1,key);
      assert.ok(proof.consumedBytes > 0,key);
      assert.equal(proof.sourceDestroyed,true,key);
    } else assert.equal(proof.allFourMergesObserved,true);
  }
  assert.equal(result.knownRollback.failureCode,"IMPORT_DB_ROLLED_BACK");
  assert.equal(result.knownRollback.safeText,true);
  assert.equal(result.acl.role,"coffee_catalog_import_rw");
  assert.equal(result.acl.tempRoundTrip,true);
  assert.equal(result.acl.roleMapMatchesMigrations,true);
  assert.equal(result.acl.denials.length,9);
  for (const denial of result.acl.denials) assert.equal(denial.sqlstate,"42501",denial.operation);
  assert.equal(result.foreignConnect.runtime,"catalog-supplier-sync");
  assert.equal(result.foreignConnect.role,"coffee_catalog_import_rw");
  assert.equal(result.foreignConnect.route,"existing-live-foundation");
  assert.equal(result.foreignConnect.denials.length,4);
  for (const denial of result.foreignConnect.denials) assert.equal(denial.sqlstate,"42501");
  assert.equal(result.foreignConnect.cleanup,true);
  assert.equal(result.cleanup.containerRemoved,true);
  assert.ok(result.cleanup.teardownMs<result.cleanup.shutdownBudgetMs);
  assert.ok(result.stateMatrix.length >= 30);
  assert.equal(result.stateMatrix.every(row => row.passed),true);
  t.diagnostic(JSON.stringify({httpCopyShutdown:{readerCancelled:httpCopyShutdown.readerCancelled,copyCancelled:httpCopyShutdown.copyCancelled,
    sourceDestroyed:httpCopyShutdown.sourceDestroyed,sixTablesRolledBack:httpCopyShutdown.sixTablesRolledBack,
    connectionReleased:httpCopyShutdown.connectionReleased,shutdownMs:httpCopyShutdown.shutdownMs},
    migration:result.migrationProof,midCopyAbort:result.midCopyAbort,copySourceFailure:result.copySourceFailure,
    postMergeRollback:result.postMergeRollback,knownRollback:result.knownRollback,acl:result.acl,foreignConnect:result.foreignConnect,cleanup:result.cleanup,stateMatrix:result.stateMatrix}));
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
