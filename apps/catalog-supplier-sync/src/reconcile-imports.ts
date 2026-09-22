import type {AromaCatalogExportRecord} from "@coffee-platform/contracts-aroma-v1";
import {toInstant} from "@coffee-platform/platform-time";
import {CatalogImportError, isOutcomeUnknown, type CatalogImportStore, type SnapshotRow} from "./catalog-import-store.js";

type Batch = Extract<AromaCatalogExportRecord, {recordType: "snapshot-batch"}>;
type Completed = Extract<AromaCatalogExportRecord, {recordType: "snapshot-completed"}>;

export class CatalogOutcomeUnknown extends Error {
  public readonly code = "OutcomeUnknown";
  public readonly operation: string;
  public constructor(operation: string, cause?: unknown) { super(`OutcomeUnknown:${operation}`, {cause}); this.name = "CatalogOutcomeUnknown"; this.operation = operation; }
}
export class CatalogReconciledFailure extends Error {
  public readonly operation: string;
  public constructor(operation: string, detail: string) {
    super(`ReconciledFailure:${operation}:${detail}`);
    this.name = "CatalogReconciledFailure";
    this.operation = operation;
  }
}

async function readSnapshot(store: CatalogImportStore, snapshotRef: string, signal: AbortSignal): Promise<SnapshotRow> {
  try {
    const row = await store.getSnapshot(snapshotRef, signal);
    if (row === null) throw new CatalogReconciledFailure("durable-reread", "SNAPSHOT_NOT_FOUND");
    return row;
  } catch (error) {
    if (error instanceof CatalogOutcomeUnknown || error instanceof CatalogReconciledFailure) throw error;
    throw new CatalogOutcomeUnknown("durable-reread", error);
  }
}

export async function runReconciled(
  operation: string,
  mutate: () => Promise<unknown>,
  reconcile: () => Promise<boolean>,
): Promise<void> {
  try { await mutate(); }
  catch (error) {
    if (!isOutcomeUnknown(error)) throw error;
    let durable: boolean;
    try { durable = await reconcile(); }
    catch (readError) {
      if (readError instanceof CatalogReconciledFailure || readError instanceof CatalogImportError) throw readError;
      throw new CatalogOutcomeUnknown(operation, readError);
    }
    if (!durable) throw new CatalogReconciledFailure(operation, "DURABLE_POSTCONDITION_FAILED");
  }
}

export async function reconcileCreate(store: CatalogImportStore, snapshotRef: string, supplierRef: string, signal: AbortSignal): Promise<boolean> {
  let row: SnapshotRow | null;
  try { row = await store.getSnapshot(snapshotRef, signal); }
  catch (error) { throw new CatalogOutcomeUnknown("durable-reread", error); }
  if (row === null) {
    await store.create(snapshotRef, supplierRef, signal);
    return true;
  }
  const exact = row.supplier_ref === supplierRef && row.state === "Created" && row.provider_snapshot_ref === null && row.next_batch_number === 0 &&
    row.declared_batch_count === null && row.declared_product_count === null && row.declared_variant_count === null && row.declared_offer_count === null &&
    row.received_batch_count === 0 && row.received_product_count === 0 && row.received_variant_count === 0 && row.received_offer_count === 0 &&
    row.content_hash === null && row.failure_code === null && row.received_at === null;
  if (!exact) throw new CatalogReconciledFailure("create", "CONFLICTING_DURABLE_STATE");
  return true;
}
export async function reconcileStarted(store: CatalogImportStore, snapshotRef: string, providerSnapshotRef: string, signal: AbortSignal): Promise<boolean> {
  const row = await readSnapshot(store, snapshotRef, signal);
  const exact = row.state === "Receiving" && row.provider_snapshot_ref === providerSnapshotRef && row.next_batch_number === 0 &&
    row.declared_batch_count === null && row.declared_product_count === null && row.declared_variant_count === null && row.declared_offer_count === null &&
    row.received_batch_count === 0 && row.received_product_count === 0 && row.received_variant_count === 0 && row.received_offer_count === 0 &&
    row.content_hash === null && row.failure_code === null && row.received_at === null;
  if (exact) return true;
  if (row.state === "Created") {
    await store.reject(snapshotRef, "RECOVERY_INCOMPLETE", signal);
    throw new CatalogReconciledFailure("started", "KNOWN_NOT_COMMITTED");
  }
  throw new CatalogReconciledFailure("started", "CONFLICTING_DURABLE_STATE");
}
export async function reconcileBatch(store: CatalogImportStore, record: Batch, signal: AbortSignal): Promise<boolean> {
  if (await store.verifyBatchReplay(record, signal)) return true;
  const row = await readSnapshot(store, record.snapshotRef, signal);
  if (row.state === "Receiving" && row.next_batch_number === record.batchNumber) {
    await store.reject(record.snapshotRef, "RECOVERY_INCOMPLETE", signal);
    throw new CatalogReconciledFailure("batch", "KNOWN_NOT_COMMITTED");
  }
  throw new CatalogReconciledFailure("batch", "CONFLICTING_DURABLE_STATE");
}
export async function reconcileCompleted(store: CatalogImportStore, record: Completed, signal: AbortSignal): Promise<boolean> {
  const row = await readSnapshot(store, record.snapshotRef, signal);
  if (row.state === "Received") {
    const completedAt = toInstant(record.completedAt).epochMilliseconds;
    return row.declared_batch_count === record.batchCount && row.declared_product_count === record.productCount &&
      row.declared_variant_count === record.variantCount && row.declared_offer_count === record.offerCount && row.content_hash === record.contentHash &&
      row.received_batch_count === record.batchCount && row.received_product_count === record.productCount &&
      row.received_variant_count === record.variantCount && row.received_offer_count === record.offerCount &&
      row.received_at !== null && row.received_at.getTime() === completedAt;
  }
  if (row.state !== "Receiving") throw new CatalogReconciledFailure("terminal", "CONFLICTING_DURABLE_STATE");
  await store.complete(record, signal);
  return true;
}
export async function reconcileRejected(store: CatalogImportStore, snapshotRef: string, code: Parameters<CatalogImportStore["reject"]>[1], signal: AbortSignal): Promise<boolean> {
  const row = await readSnapshot(store, snapshotRef, signal);
  if (row.state === "Rejected") {
    if (row.failure_code !== code) throw new CatalogReconciledFailure("reject", "CONFLICTING_DURABLE_STATE");
    return true;
  }
  if (row.state !== "Created" && row.state !== "Receiving") throw new CatalogReconciledFailure("reject", "CONFLICTING_DURABLE_STATE");
  await store.reject(snapshotRef, code, signal);
  return true;
}

export async function recoverIncompleteImports(store: CatalogImportStore, signal: AbortSignal): Promise<number> {
  const rows = await store.listIncomplete(signal);
  for (const row of rows) {
    await runReconciled("reject", () => store.reject(row.snapshot_ref, "RECOVERY_INCOMPLETE", signal),
      () => reconcileRejected(store, row.snapshot_ref, "RECOVERY_INCOMPLETE", signal));
  }
  return rows.length;
}
