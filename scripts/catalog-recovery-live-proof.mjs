import {createDatabase, DatabaseTransactionError} from "../packages/platform-database/dist/index.js";
import {catalogBatchBytes, catalogBatchHash, catalogContentHash} from "../packages/contracts/aroma-v1/dist/index.js";
import {createCatalogImportStore} from "../apps/catalog-supplier-sync/dist/catalog-import-store.js";
import {createHourlyScheduler} from "../apps/catalog-supplier-sync/dist/hourly-scheduler.js";
import {newSnapshotRef, runCatalogImport} from "../apps/catalog-supplier-sync/dist/run-catalog-import.js";
import {CatalogOutcomeUnknown, reconcileBatch, reconcileCompleted, reconcileCreate, reconcileRejected, reconcileStarted, recoverIncompleteImports, runReconciled} from "../apps/catalog-supplier-sync/dist/reconcile-imports.js";
import {withCatalogPostgres} from "./catalog-live-harness.mjs";
import {proveProcessRestart} from "./catalog-runtime-live-proof.mjs";
import {openBlackholeProxy} from "./db-live-proof.mjs";

const supplierRef = "sup_00000000000000000000000001";
const item = Object.freeze({sourceProductKeyHash:"a".repeat(64), sourceVariantKeyHash:"b".repeat(64), sourceOfferKeyHash:"c".repeat(64),
  displayName:"Recovery fixture", unit:"kilogram", supplierUnitMinor:"999", currency:"RUB", availability:"Unavailable", imageUrl:null,
  grindOptions:[{sourceGrindKeyHash:"d".repeat(64), displayName:"Эспрессо"}], sourceIdentityScheme:"hmac-sha256-v1"});
function records(snapshotRef, providerSnapshotRef = `provider-${snapshotRef}`) {
  const started = {streamVersion:"1", recordType:"snapshot-started", snapshotRef, supplierRef, providerSnapshotRef, startedAt:"2026-09-20T00:00:00Z"};
  const batch = {streamVersion:"1", recordType:"snapshot-batch", snapshotRef, batchNumber:0, offerCount:1, uncompressedBytes:catalogBatchBytes([item]), batchHash:catalogBatchHash([item]), previousBatchHash:null, items:[item]};
  const terminal = {streamVersion:"1", recordType:"snapshot-completed", snapshotRef, batchCount:1, productCount:1, variantCount:1, offerCount:1, contentHash:catalogContentHash([batch.batchHash]), completedAt:"2026-09-20T01:00:00Z"};
  return {started, batch, terminal};
}
function unknownAfter(store, method) {
  return async (...args) => { await store[method](...args); throw new DatabaseTransactionError("TRANSACTION_OUTCOME_UNKNOWN"); };
}

const proofPool = {max:2, checkoutTimeoutMs:2_000, lockTimeoutMs:2_000, interactiveStatementTimeoutMs:5_000,
  backgroundStatementTimeoutMs:10_000, terminalTimeoutMs:3_000, transactionTimeoutMs:20_000,
  idleTimeoutMs:10_000, maxLifetimeMs:60_000};

async function loseCommitAck(targetPort, runtimePassword, databaseName, operation, dropReplyAt = 1) {
  const proxy = await openBlackholeProxy(targetPort, "COMMIT", {dropReplyAt});
  const database = createDatabase({owner:"catalog-recovery-fault-proxy", database:databaseName, allowedDatabase:databaseName,
    host:"127.0.0.1", port:proxy.port, user:"coffee_catalog_import_rw", password:runtimePassword, ssl:false,
    pool:proofPool, shutdownGraceMs:40_000});
  let failure;
  try {
    await database.resource.start(AbortSignal.timeout(5_000));
    await operation(createCatalogImportStore(database));
  } catch (error) { failure=error; }
  finally {
    database.resource.destroy();
    await proxy.close();
  }
  if (failure?.code !== "TRANSACTION_OUTCOME_UNKNOWN") throw new Error(`fault proxy returned ${failure?.code ?? "no error"}`);
  throw failure;
}

export async function runCatalogRecoveryProof() {
  return withCatalogPostgres(async ({database, adminClient, port, runtimePassword, databaseName}) => {
    const store = createCatalogImportStore(database);
    const signal = new AbortController().signal;
    const reconciled = [];
    const snapshot = "snp_01ARZ3NDEKTSV4RRFFQ69G5FB0";
    const flow = records(snapshot);
    await runReconciled("create", () => loseCommitAck(port, runtimePassword, databaseName, proxied => proxied.create(snapshot, supplierRef)), () => reconcileCreate(store, snapshot, supplierRef, signal)); reconciled.push("create");
    await runReconciled("started", () => loseCommitAck(port, runtimePassword, databaseName, proxied => proxied.acceptStarted(flow.started)), () => reconcileStarted(store, snapshot, flow.started.providerSnapshotRef, signal)); reconciled.push("started");
    await runReconciled("batch", () => loseCommitAck(port, runtimePassword, databaseName, proxied => proxied.recordBatch(flow.batch)), () => reconcileBatch(store, flow.batch, signal)); reconciled.push("batch");
    let terminalDurableBeforeReconcile;
    await runReconciled("terminal", () => loseCommitAck(port, runtimePassword, databaseName, proxied => proxied.complete(flow.terminal), 4), async () => {
      terminalDurableBeforeReconcile=(await store.getSnapshot(snapshot, signal))?.state;
      return reconcileCompleted(store, flow.terminal, signal);
    }); reconciled.push("terminal");

    const rejectRef = "snp_01ARZ3NDEKTSV4RRFFQ69G5FB1";
    await store.create(rejectRef, supplierRef);
    await runReconciled("reject", () => loseCommitAck(port, runtimePassword, databaseName, proxied => proxied.reject(rejectRef, "HTTP_BEFORE_STARTED")), () => reconcileRejected(store, rejectRef, "HTTP_BEFORE_STARTED", signal)); reconciled.push("reject");

    const ackRef = "snp_01ARZ3NDEKTSV4RRFFQ69G5FB2";
    const ackFlow = records(ackRef, "provider-terminal-ack-loss");
    let exportCalls = 0;
    const terminalProxy = await openBlackholeProxy(port, "COMMIT", {dropReplyAt:4});
    const terminalDatabase = createDatabase({owner:"catalog-terminal-ack-loss", database:databaseName, allowedDatabase:databaseName,
      host:"127.0.0.1", port:terminalProxy.port, user:"coffee_catalog_import_rw", password:runtimePassword, ssl:false,
      pool:proofPool, shutdownGraceMs:40_000});
    let terminalStateBeforeReconcile;
    try {
      await terminalDatabase.resource.start(AbortSignal.timeout(5_000));
      const proxied = createCatalogImportStore(terminalDatabase);
      const terminalLossStore = Object.freeze({...store, complete:async (...args) => {
        try { return await proxied.complete(...args); }
        catch (error) { terminalStateBeforeReconcile=(await store.getSnapshot(ackRef, signal))?.state; throw error; }
      }});
      await runCatalogImport({store:terminalLossStore, supplierRef, snapshotRef:ackRef, context:{correlationId:"11111111-1111-4111-8111-111111111111"}, signal:new AbortController().signal,
        exportCatalog:async function* () { exportCalls++; yield ackFlow.started; yield ackFlow.batch; yield ackFlow.terminal; }});
    } finally {
      terminalDatabase.resource.destroy();
      await terminalProxy.close();
    }
    const terminalRow = await store.getSnapshot(ackRef);

    const replayRef = "snp_01ARZ3NDEKTSV4RRFFQ69G5FB5";
    const replayFlow = records(replayRef, "provider-early-replay");
    await store.create(replayRef, supplierRef, signal);
    await store.acceptStarted(replayFlow.started, signal);
    await store.recordBatch(replayFlow.batch, signal);
    const replayItem = {...item, sourceProductKeyHash:"e".repeat(64), sourceVariantKeyHash:"f".repeat(64), sourceOfferKeyHash:"1".repeat(64)};
    const replayBatchOne = {streamVersion:"1", recordType:"snapshot-batch", snapshotRef:replayRef, batchNumber:1, offerCount:1,
      uncompressedBytes:catalogBatchBytes([replayItem]), batchHash:catalogBatchHash([replayItem]), previousBatchHash:replayFlow.batch.batchHash, items:[replayItem]};
    await store.recordBatch(replayBatchOne, signal);
    await runReconciled("batch", () => unknownAfter(store, "recordBatch")(replayFlow.batch, signal), () => reconcileBatch(store, replayFlow.batch, signal));
    const replayRow = await store.getSnapshot(replayRef, signal);

    let unavailable = "not-tested";
    try {
      await runReconciled("create", async () => { throw new DatabaseTransactionError("TRANSACTION_OUTCOME_UNKNOWN"); }, async () => { throw new DatabaseTransactionError("DB_CONNECTION_LOST"); });
    } catch (error) { if (error instanceof CatalogOutcomeUnknown) unavailable = "OutcomeUnknown"; }

    const httpRef = "snp_01ARZ3NDEKTSV4RRFFQ69G5FB3";
    await runCatalogImport({store, supplierRef, snapshotRef:httpRef, context:{correlationId:"22222222-2222-4222-8222-222222222222"}, signal:new AbortController().signal,
      exportCatalog:async function* () { yield await Promise.reject(new Error("fixture transport failed before first record")); }}).catch(() => undefined);
    const httpRow = await store.getSnapshot(httpRef);

    const oldRef = "snp_01ARZ3NDEKTSV4RRFFQ69G5FB4";
    await store.create(oldRef, supplierRef);
    await recoverIncompleteImports(store, signal);
    const generatedA = newSnapshotRef();
    const generatedB = newSnapshotRef();
    if (generatedA === generatedB || generatedA === oldRef) throw new Error("snapshot identity was reused");
    const restart = await proveProcessRestart({adminClient,port,runtimePassword,databaseName});

    let now = 0;
    let concurrent = 0;
    let maxConcurrent = 0;
    const shutdown = new AbortController();
    const scheduler = createHourlyScheduler({intervalMs:3_600_000, now:() => now, wait:async () => {}});
    await scheduler.start(async () => { concurrent++; maxConcurrent=Math.max(maxConcurrent, concurrent); now=3_600_001; concurrent--; shutdown.abort(); }, shutdown.signal);

    return {skipped:false, reconciled, terminalAckLoss:{state:terminalRow?.state, stateBeforeReconcile:terminalStateBeforeReconcile,
      firstTerminalStateBeforeReconcile:terminalDurableBeforeReconcile, exportRetries:exportCalls - 1},
      earlyReplayAckLoss:{state:replayRow?.state, nextBatchNumber:replayRow?.next_batch_number}, databaseUnavailable:unavailable,
      httpBeforeStarted:{providerSnapshotRef:httpRow?.provider_snapshot_ref, state:httpRow?.state}, restart,
      scheduler:{maxConcurrent}, shutdown:{aborted:shutdown.signal.aborted}};
  });
}
