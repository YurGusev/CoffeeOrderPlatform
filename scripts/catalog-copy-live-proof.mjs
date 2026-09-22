import {canonicalCatalogJson, catalogBatchBytes, catalogBatchHash, catalogContentHash} from "../packages/contracts/aroma-v1/dist/index.js";
import {createCatalogImportStore} from "../apps/catalog-supplier-sync/dist/catalog-import-store.js";
import {runCatalogImport} from "../apps/catalog-supplier-sync/dist/run-catalog-import.js";
import {withCatalogPostgres} from "./catalog-live-harness.mjs";
import {trace} from "@opentelemetry/api";
import {CatalogTelemetry} from "../apps/catalog-supplier-sync/dist/observability.js";

const supplierRef = "sup_00000000000000000000000001";
const snapshotRef = "snp_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const hash = value => value.repeat(64);
const first = Object.freeze({
  sourceProductKeyHash:hash("1"), sourceVariantKeyHash:hash("2"), sourceOfferKeyHash:hash("3"),
  displayName:"Кофе ☕\tстрока\nвозврат\r\\' OR 1=1 --", unit:"piece", supplierUnitMinor:"12345", currency:"RUB", availability:"Available", imageUrl:null,
  supplierPromotions:[{discountBasisPoints:125, minimumWeightRaw:"0.250", providerCreatedAt:"2026-09-20T00:00:00Z", providerUpdatedAt:"2026-09-20T01:00:00Z"}],
  sourceIdentityScheme:"hmac-sha256-v1",
});
const second = Object.freeze({
  sourceProductKeyHash:hash("4"), sourceVariantKeyHash:hash("5"), sourceOfferKeyHash:hash("6"),
  displayName:"Empty optional arrays", unit:"gram", supplierUnitMinor:"0", currency:"RUB", availability:"Stopped", imageUrl:"https://example.invalid/a.png",
  supplierPromotions:[], grindOptions:[], sourceIdentityScheme:"hmac-sha256-v1",
});
function batch(snapshot, items, batchNumber = 0, previousBatchHash = null) {
  return {streamVersion:"1", recordType:"snapshot-batch", snapshotRef:snapshot, batchNumber, offerCount:items.length,
    uncompressedBytes:catalogBatchBytes(items), batchHash:catalogBatchHash(items), previousBatchHash, items};
}
function completed(snapshot, batches, items) {
  return {streamVersion:"1", recordType:"snapshot-completed", snapshotRef:snapshot, batchCount:batches.length,
    productCount:new Set(items.map(item => item.sourceProductKeyHash)).size, variantCount:new Set(items.map(item => item.sourceVariantKeyHash)).size,
    offerCount:items.length, contentHash:catalogContentHash(batches.map(value => value.batchHash)), completedAt:"2026-09-20T02:00:00Z"};
}
async function started(store, snapshot, provider = "provider-snapshot-1") {
  await store.create(snapshot, supplierRef);
  await store.acceptStarted({streamVersion:"1", recordType:"snapshot-started", snapshotRef:snapshot, supplierRef, providerSnapshotRef:provider, startedAt:"2026-09-20T00:00:00Z"});
}

export async function runCatalogCopyProof() {
  const spans = new Map();
  trace.setGlobalTracerProvider({getTracer:() => ({startSpan:name => {
    const row = spans.get(name) ?? {started:0,ended:0}; row.started++; spans.set(name,row);
    return {end:() => {row.ended++;}, setStatus:() => {}, spanContext:() => ({traceId:"1".repeat(32),spanId:"2".repeat(16),traceFlags:1})};
  }})});
  try { return await withCatalogPostgres(async ({database, adminClient, firstApply, secondApply}) => {
    const telemetry = new CatalogTelemetry();
    const store = createCatalogImportStore(database, telemetry);
    await started(store, snapshotRef);
    const record = batch(snapshotRef, [first, second]);
    if (await store.recordBatch(record) !== "stored") throw new Error("first batch was not stored");
    if (await store.recordBatch(record) !== "replay") throw new Error("exact replay was not a no-op");
    const terminal = completed(snapshotRef, [record], [first, second]);
    await store.complete(terminal);
    const reconstructed = await store.reconstructBatch(snapshotRef, 0);
    if (canonicalCatalogJson(reconstructed) !== canonicalCatalogJson([first, second])) throw new Error("persistent reconstruction changed payload or optionals");
    const row = await store.getSnapshot(snapshotRef);
    if (row?.state !== "Received" || row.provider_snapshot_ref !== "provider-snapshot-1") throw new Error("snapshot did not reach Received");
    let replayConflictRejected = false;
    const changedReplay = batch(snapshotRef, [{...first, sourceOfferKeyHash:"e".repeat(64)}, second]);
    try { await store.recordBatch(changedReplay); } catch { replayConflictRejected = true; }
    if (!replayConflictRejected) throw new Error("mismatched batch replay was accepted");
    let terminalConflictRejected = false;
    try { await store.complete({...terminal, contentHash:"0".repeat(64)}); } catch { terminalConflictRejected = true; }
    if (!terminalConflictRejected || (await store.getSnapshot(snapshotRef))?.state !== "Received") throw new Error("terminal conflict changed Received state");
    let terminalTimestampConflictRejected = false;
    try { await store.complete({...terminal, completedAt:"2026-09-20T02:00:01Z"}); } catch { terminalTimestampConflictRejected = true; }
    if (!terminalTimestampConflictRejected || (await store.getSnapshot(snapshotRef))?.state !== "Received") throw new Error("terminal timestamp conflict changed Received state");

    const conflictRef = "snp_01ARZ3NDEKTSV4RRFFQ69G5FBD";
    const conflictStarted = {streamVersion:"1", recordType:"snapshot-started", snapshotRef:conflictRef, supplierRef,
      providerSnapshotRef:"provider-replay-conflict", startedAt:"2026-09-20T00:00:00Z"};
    const conflictFirst = batch(conflictRef, [second]);
    const conflictChanged = batch(conflictRef, [{...second, displayName:"conflicting replay"}]);
    let conflictError;
    await runCatalogImport({store, supplierRef, snapshotRef:conflictRef, signal:new AbortController().signal,
      context:{correlationId:"66666666-6666-4666-8666-666666666666"},
      exportCatalog:async function* () { yield conflictStarted; yield conflictFirst; yield conflictChanged; }}).catch(error => { conflictError=error; });
    const conflictRow = await store.getSnapshot(conflictRef);
    const receivingReplayConflictRejected = conflictRow?.state === "Rejected" && conflictRow.failure_code === "BATCH_HASH_CONFLICT";
    if (!receivingReplayConflictRejected) throw new Error(`Receiving replay conflict was not durably rejected: ${conflictRow?.state ?? "missing"}/${conflictRow?.failure_code ?? "none"}; error=${conflictError?.name ?? "none"}/${conflictError?.code ?? "none"}/${conflictError?.message ?? "none"}; cause=${conflictError?.cause?.name ?? "none"}/${conflictError?.cause?.code ?? "none"}`);

    const tamperRef = "snp_01ARZ3NDEKTSV4RRFFQ69G5FAW";
    await started(store, tamperRef, "provider-tamper");
    const tamperBatch = batch(tamperRef, [first]);
    await store.recordBatch(tamperBatch);
    await adminClient.query("UPDATE catalog.snapshot_variants SET display_name='tampered' WHERE snapshot_ref=$1", [tamperRef]);
    let tamperDetected = false;
    try { await store.complete(completed(tamperRef, [tamperBatch], [first])); }
    catch (error) { tamperDetected = error instanceof Error && /BATCH_DURABLE_HASH_MISMATCH/u.test(error.message); }
    if (!tamperDetected) throw new Error("persistent tamper was not detected");

    const rollbackRef = "snp_01ARZ3NDEKTSV4RRFFQ69G5FAX";
    await started(store, rollbackRef, "provider-rollback");
    const duplicate = {...second, sourceOfferKeyHash:first.sourceOfferKeyHash};
    const bad = batch(rollbackRef, [first, duplicate]);
    await store.recordBatch(bad).then(() => { throw new Error("duplicate COPY batch was accepted"); }, () => undefined);
    const partial = await adminClient.query("SELECT count(*)::int count FROM catalog.snapshot_offers WHERE snapshot_ref=$1", [rollbackRef]);
    if (partial.rows[0].count !== 0) throw new Error("COPY failure left partial persistent rows");

    const driftRef = "snp_01ARZ3NDEKTSV4RRFFQ69G5FAY";
    await started(store, driftRef, "provider-drift");
    const driftFirst = batch(driftRef, [first]);
    await store.recordBatch(driftFirst);
    const driftItem = {...second, sourceProductKeyHash:first.sourceProductKeyHash, imageUrl:"https://example.invalid/drift.png"};
    const driftSecond = batch(driftRef, [driftItem], 1, driftFirst.batchHash);
    let semanticDriftRejected = false;
    try { await store.recordBatch(driftSecond); } catch { semanticDriftRejected = true; }
    const driftRow = await store.getSnapshot(driftRef);
    if (!semanticDriftRejected || driftRow?.next_batch_number !== 1) throw new Error("cross-batch semantic drift was not atomic");

    const grindRef = "snp_01ARZ3NDEKTSV4RRFFQ69G5FAZ";
    await started(store, grindRef, "provider-grind-drift");
    const grindHash = "9".repeat(64);
    const grindFirst = batch(grindRef, [{...first, grindOptions:[{sourceGrindKeyHash:grindHash, displayName:"Крупный"}]}]);
    await store.recordBatch(grindFirst);
    const grindSecond = batch(grindRef, [{...second, grindOptions:[{sourceGrindKeyHash:grindHash, displayName:"Мелкий"}]}], 1, grindFirst.batchHash);
    let grindDriftRejected = false;
    try { await store.recordBatch(grindSecond); } catch { grindDriftRejected = true; }
    if (!grindDriftRejected || (await store.getSnapshot(grindRef))?.next_batch_number !== 1) throw new Error("generation grind identity drift was not atomic");

    const ordinalRef = "snp_01ARZ3NDEKTSV4RRFFQ69G5FBB";
    await started(store, ordinalRef, "provider-ordinal-tamper");
    const ordinalBatch = batch(ordinalRef, [first]);
    await store.recordBatch(ordinalBatch);
    await adminClient.query("UPDATE catalog.snapshot_offers SET item_index=7 WHERE snapshot_ref=$1", [ordinalRef]);
    let ordinalTamperRejected = false;
    try { await store.complete(completed(ordinalRef, [ordinalBatch], [first])); }
    catch (error) { ordinalTamperRejected = error instanceof Error && /BATCH_DURABLE_ORDINAL_MISMATCH/u.test(error.message); }
    if (!ordinalTamperRejected) throw new Error("non-contiguous durable item ordinals were accepted");

    const countRef = "snp_01ARZ3NDEKTSV4RRFFQ69G5FBC";
    await started(store, countRef, "provider-count-tamper");
    const countBatch = batch(countRef, [first]);
    await store.recordBatch(countBatch);
    await adminClient.query("INSERT INTO catalog.snapshot_products(snapshot_ref,source_product_key_hash,image_url) VALUES($1,$2,NULL)", [countRef, "f".repeat(64)]);
    let durableCountTamperRejected = false;
    try { await store.complete(completed(countRef, [countBatch], [first])); }
    catch (error) { durableCountTamperRejected = error instanceof Error && /TERMINAL_COUNT_MISMATCH/u.test(error.message); }
    if (!durableCountTamperRejected) throw new Error("terminal trusted cached counters instead of durable rows");

    let permanentDdlDenied = false;
    await adminClient.query("SET ROLE coffee_catalog_import_rw");
    try { await adminClient.query("CREATE TABLE catalog.forbidden(value text)"); }
    catch { permanentDdlDenied = true; }
    finally { await adminClient.query("RESET ROLE"); }
    if (!permanentDdlDenied) throw new Error("import role acquired permanent DDL");

    // One full generation ties bounded counters to reconciled importer batches,
    // not direct store calls or failed COPY attempts.
    const metricsRef = "snp_01ARZ3NDEKTSV4RRFFQ69G5FBF";
    const metricsBatch = batch(metricsRef, [second]);
    await runCatalogImport({telemetry,store,supplierRef,snapshotRef:metricsRef,signal:new AbortController().signal,
      context:{correlationId:"11111111-1111-4111-8111-111111111111"},
      exportCatalog:async function* () {
        yield {streamVersion:"1",recordType:"snapshot-started",snapshotRef:metricsRef,supplierRef,providerSnapshotRef:"fixture-metrics",startedAt:"2026-09-21T00:00:00Z"};
        yield metricsBatch;
        yield completed(metricsRef,[metricsBatch],[second]);
      }});
    return {skipped:false, telemetry:{spans:Object.fromEntries(spans),metrics:telemetry.render()}, migrations:firstApply.length === 3 && secondApply.length === 0 ? "idempotent" : "invalid", copy:"bounded-temp-copy",
      reconstruction:{items:reconstructed, batchHash:record.batchHash, contentHash:terminal.contentHash},
      state:row.state, optionals:{missingGrinds:!("grindOptions" in reconstructed[0]), emptyGrinds:Array.isArray(reconstructed[1].grindOptions)},
      replayConflictRejected, receivingReplayConflictRejected, terminalConflictRejected, terminalTimestampConflictRejected,
      semanticDriftRejected, grindDriftRejected, tamperRejected:tamperDetected,
      ordinalTamperRejected, durableCountTamperRejected,
      rollbackAtomic:partial.rows[0].count === 0, grantsLeastPrivilege:permanentDdlDenied};
  }); } finally {trace.disable();}
}
