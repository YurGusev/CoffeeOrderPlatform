import test from "node:test";
import assert from "node:assert/strict";
import { runCatalogRecoveryProof } from "../../scripts/catalog-recovery-live-proof.mjs";

void test(
  "unknown COMMIT reconciliation is operation-specific and terminal ack loss regresses",
  { timeout: 120_000 },
  async () => {
    const result = await runCatalogRecoveryProof();
    assert.equal(result.skipped, false);
    assert.deepEqual(result.reconciled, [
      "create",
      "started",
      "batch",
      "terminal",
      "reject",
    ]);
    assert.equal(result.terminalAckLoss.state, "Received");
    assert.equal(result.terminalAckLoss.stateBeforeReconcile, "Received");
    assert.equal(
      result.terminalAckLoss.firstTerminalStateBeforeReconcile,
      "Received",
    );
    assert.equal(result.terminalAckLoss.exportRetries, 0);
    assert.deepEqual(result.earlyReplayAckLoss, {
      state: "Receiving",
      nextBatchNumber: 2,
    });
    assert.equal(result.databaseUnavailable, "OutcomeUnknown");
    assert.equal(result.httpBeforeStarted.providerSnapshotRef, null);
    assert.equal(result.httpBeforeStarted.state, "Rejected");
    assert.equal(result.restart.newSnapshotRef, true);
    assert.equal(
      result.restart.processKilled,
      "SIGKILL",
      "restart must kill a production-composed OS process",
    );
    assert.notEqual(result.restart.firstPid, result.restart.secondPid);
    assert.equal(result.restart.oldStateBeforeExport, "Rejected");
    assert.equal(result.restart.newState, "Received");
    assert.equal(result.restart.startupReadyStatus, 503);
    assert.equal(result.restart.recoveredReadyStatus, 200);
    assert.equal(result.restart.transport, "real-mtls-internal-client");
    assert.equal(result.scheduler.maxConcurrent, 1);
    assert.equal(result.shutdown.aborted, true);
  },
);
