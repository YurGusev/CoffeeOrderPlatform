import {randomBytes} from "node:crypto";
import {CatalogTelemetry} from "./observability.js";
import {isAromaCatalogExportRecord, type AromaCatalogExportRecord} from "@coffee-platform/contracts-aroma-v1";
import type {CatalogExportContext} from "./internal-api-client.js";
import {CatalogImportError, type CatalogImportStore} from "./catalog-import-store.js";
import {CatalogOutcomeUnknown, reconcileBatch, reconcileCompleted, reconcileCreate, reconcileRejected, reconcileStarted, runReconciled} from "./reconcile-imports.js";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function encodeUlid(bytes: Uint8Array): string {
  let value = BigInt(`0x${Buffer.from(bytes).toString("hex")}`);
  let result = "";
  for (let index = 0; index < 26; index += 1) { result = `${CROCKFORD[Number(value & 31n)]}${result}`; value >>= 5n; }
  return result;
}
export function newSnapshotRef(): string { return `snp_${encodeUlid(randomBytes(16))}`; }

type Exporter = (request: Readonly<{snapshotRef: string; supplierRef: string}>, context: CatalogExportContext) => AsyncIterable<unknown>;
function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const value = Reflect.get(error, "code");
  return typeof value === "string" ? value : undefined;
}
function isBatchConflict(error: unknown): boolean {
  const code = errorCode(error);
  return code === "BATCH_HASH_CONFLICT" || code === "BATCH_REPLAY_CONFLICT" ||
    (error instanceof Error && /(?:^|:)BATCH_(?:HASH|REPLAY)_CONFLICT(?:$|:)/u.test(error.message));
}
export type CatalogImportOptions = Readonly<{
  store: CatalogImportStore;
  exportCatalog: Exporter;
  supplierRef: string;
  context: Omit<CatalogExportContext, "signal">;
  signal: AbortSignal;
  deadlineMs?: number;
  snapshotRef?: string;
  telemetry?: CatalogTelemetry;
}>;

export async function runCatalogImport(options: CatalogImportOptions): Promise<string> {
  const telemetry = options.telemetry ?? new CatalogTelemetry();
  const snapshotRef = options.snapshotRef ?? newSnapshotRef();
  return telemetry.withIdentity({snapshotRef, correlationId: options.context.correlationId},
    () => telemetry.generation(() => importGeneration(options, telemetry, snapshotRef), options.signal));
}

async function importGeneration(options: CatalogImportOptions, telemetry: CatalogTelemetry, snapshotRef: string): Promise<string> {
  const {store} = options;
  if (options.deadlineMs !== undefined && (!Number.isSafeInteger(options.deadlineMs) || options.deadlineMs <= 0)) {
    throw new RangeError("deadlineMs must be positive");
  }
  const deadlineSignal = options.deadlineMs === undefined ? undefined : AbortSignal.timeout(options.deadlineMs);
  const signal = deadlineSignal === undefined ? options.signal : AbortSignal.any([options.signal, deadlineSignal]);
  let created = false;
  let started = false;
  let terminalSeen = false;
  let terminalPersisted = false;
  let pendingCompleted: Extract<AromaCatalogExportRecord, {recordType: "snapshot-completed"}> | undefined;
  let pendingFailed: Extract<AromaCatalogExportRecord, {recordType: "snapshot-failed"}> | undefined;
  let expectedBatch = 0;
  try {
    await runReconciled("create", () => store.create(snapshotRef, options.supplierRef, signal),
      () => reconcileCreate(store, snapshotRef, options.supplierRef, signal));
    created = true;
    await telemetry.observe("stream", async () => {
      const records = options.exportCatalog({snapshotRef, supplierRef: options.supplierRef}, {...options.context, signal});
      for await (const candidate of telemetry.consume(records)) {
        signal.throwIfAborted();
        const record = telemetry.validate(() => {
          if (!isAromaCatalogExportRecord(candidate)) throw new Error("INVALID_STREAM_SCHEMA");
          return candidate;
        });
        if (record.snapshotRef !== snapshotRef || terminalSeen) throw new Error("INVALID_STREAM_SEQUENCE");
        if (record.recordType === "snapshot-started") {
          if (started || expectedBatch !== 0 || record.supplierRef !== options.supplierRef) throw new Error("INVALID_STREAM_SEQUENCE");
          await runReconciled("started", () => store.acceptStarted(record, signal),
            () => reconcileStarted(store, snapshotRef, record.providerSnapshotRef, signal));
          started = true;
        } else if (record.recordType === "snapshot-batch") {
          if (!started || record.batchNumber > expectedBatch) throw new Error("INVALID_STREAM_SEQUENCE");
          await telemetry.measureBatch(record.batchNumber, record.uncompressedBytes,
            () => runReconciled("batch", () => store.recordBatch(record, signal), () => reconcileBatch(store, record, signal)), signal);
          if (record.batchNumber === expectedBatch) expectedBatch += 1;
        } else if (record.recordType === "snapshot-completed") {
          if (!started || record.batchCount !== expectedBatch) throw new Error("INVALID_STREAM_SEQUENCE");
          pendingCompleted = record;
          terminalSeen = true;
        } else {
          pendingFailed = record;
          terminalSeen = true;
        }
      }
      if (!terminalSeen) throw new Error("INVALID_STREAM_MISSING_TERMINAL");
    });
    if (pendingCompleted !== undefined) {
      await runReconciled("terminal", () => store.complete(pendingCompleted!, signal),
        () => reconcileCompleted(store, pendingCompleted!, signal));
      terminalPersisted = true;
    }
    if (pendingFailed !== undefined) {
      await runReconciled("reject", () => store.reject(snapshotRef, pendingFailed!.code, signal),
        () => reconcileRejected(store, snapshotRef, pendingFailed!.code, signal));
      terminalPersisted = true;
      throw new CatalogImportError(`SNAPSHOT_FAILED_${pendingFailed.code}`);
    }
    return snapshotRef;
  } catch (error) {
    if (error instanceof CatalogOutcomeUnknown || options.signal.aborted || terminalPersisted || !created) throw error;
    if (deadlineSignal?.aborted === true) {
      const cleanupSignal = AbortSignal.any([options.signal, AbortSignal.timeout(2_000)]);
      await runReconciled("reject", () => store.reject(snapshotRef, "IMPORT_DEADLINE_EXCEEDED", cleanupSignal),
        () => reconcileRejected(store, snapshotRef, "IMPORT_DEADLINE_EXCEEDED", cleanupSignal));
      throw error;
    }
    const code = isBatchConflict(error)
      ? "BATCH_HASH_CONFLICT"
      : started ? "INVALID_STREAM" : "HTTP_BEFORE_STARTED";
    await runReconciled("reject", () => store.reject(snapshotRef, code, signal), () => reconcileRejected(store, snapshotRef, code, signal));
    throw error;
  }
}
