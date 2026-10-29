import { randomBytes } from "node:crypto";
import { CatalogTelemetry } from "./observability.js";
import {
  isAromaCatalogExportRecord,
  type AromaCatalogExportRecord,
} from "@coffee-platform/contracts-aroma-v1";
import type { CatalogExportContext } from "./internal-api-client.js";
import {
  CatalogImportError,
  catalogFailureCode,
  type CatalogFailureCode,
  type CatalogImportStore,
} from "./infrastructure/catalog-import-store.js";
import { DatabaseTransactionError } from "@coffee-platform/database";
import { CatalogStreamError } from "./ndjson-reader.js";
import {
  CatalogOutcomeUnknown,
  CatalogReconciledFailure,
  reconcileBatch,
  reconcileCompleted,
  reconcileCreate,
  reconcileRejected,
  reconcileStarted,
  runReconciled,
} from "./reconcile-imports.js";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function encodeUlid(bytes: Uint8Array): string {
  let value = BigInt(`0x${Buffer.from(bytes).toString("hex")}`);
  let result = "";
  for (let index = 0; index < 26; index += 1) {
    result = `${CROCKFORD[Number(value & 31n)]}${result}`;
    value >>= 5n;
  }
  return result;
}
export function newSnapshotRef(): string {
  return `snp_${encodeUlid(randomBytes(16))}`;
}

type Exporter = (
  request: Readonly<{ snapshotRef: string; supplierRef: string }>,
  context: CatalogExportContext,
) => AsyncIterable<unknown>;

function failureCode(
  error: unknown,
  started: boolean,
): CatalogFailureCode | undefined {
  if (
    error instanceof DatabaseTransactionError ||
    error instanceof CatalogOutcomeUnknown ||
    error instanceof CatalogReconciledFailure
  )
    return undefined;
  if (
    error instanceof CatalogStreamError &&
    (error.code === "CATALOG_EXPORT_INVALID_CONTENT_TYPE" ||
      /^CATALOG_EXPORT_HTTP_(?:[0-9]{1,3}|UNAVAILABLE)$/u.test(error.code))
  )
    return started ? "INVALID_STREAM" : "HTTP_BEFORE_STARTED";
  return (
    (error instanceof CatalogImportError || error instanceof CatalogStreamError
      ? catalogFailureCode(error.code)
      : undefined) ?? "INVALID_STREAM"
  );
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

export async function runCatalogImport(
  options: CatalogImportOptions,
): Promise<string> {
  const telemetry = options.telemetry ?? new CatalogTelemetry();
  const snapshotRef = options.snapshotRef ?? newSnapshotRef();
  return telemetry.withIdentity(
    { snapshotRef, correlationId: options.context.correlationId },
    () =>
      telemetry.generation(
        () => importGeneration(options, telemetry, snapshotRef),
        options.signal,
      ),
  );
}

async function importGeneration(
  options: CatalogImportOptions,
  telemetry: CatalogTelemetry,
  snapshotRef: string,
): Promise<string> {
  const { store } = options;
  if (
    options.deadlineMs !== undefined &&
    (!Number.isSafeInteger(options.deadlineMs) || options.deadlineMs <= 0)
  ) {
    throw new RangeError("deadlineMs must be positive");
  }
  const deadlineSignal =
    options.deadlineMs === undefined
      ? undefined
      : AbortSignal.timeout(options.deadlineMs);
  const signal =
    deadlineSignal === undefined
      ? options.signal
      : AbortSignal.any([options.signal, deadlineSignal]);
  let created = false;
  let started = false;
  let terminalSeen = false;
  let terminalPersisted = false;
  let pendingCompleted:
    | Extract<AromaCatalogExportRecord, { recordType: "snapshot-completed" }>
    | undefined;
  let pendingFailed:
    | Extract<AromaCatalogExportRecord, { recordType: "snapshot-failed" }>
    | undefined;
  let expectedBatch = 0;
  try {
    await runReconciled(
      "create",
      () => store.create(snapshotRef, options.supplierRef, signal),
      () => reconcileCreate(store, snapshotRef, options.supplierRef, signal),
    );
    created = true;
    await telemetry.observe("stream", async () => {
      const records = options.exportCatalog(
        { snapshotRef, supplierRef: options.supplierRef },
        { ...options.context, signal },
      );
      for await (const candidate of telemetry.consume(records)) {
        signal.throwIfAborted();
        const record = telemetry.validate(() => {
          if (!isAromaCatalogExportRecord(candidate))
            throw new CatalogImportError("INVALID_STREAM_SCHEMA");
          return candidate;
        });
        if (record.snapshotRef !== snapshotRef || terminalSeen)
          throw new CatalogImportError("INVALID_STREAM_SEQUENCE");
        if (record.recordType === "snapshot-started") {
          if (
            started ||
            expectedBatch !== 0 ||
            record.supplierRef !== options.supplierRef
          )
            throw new CatalogImportError("INVALID_STREAM_SEQUENCE");
          await runReconciled(
            "started",
            () => store.acceptStarted(record, signal),
            () =>
              reconcileStarted(
                store,
                snapshotRef,
                record.providerSnapshotRef,
                signal,
              ),
          );
          started = true;
        } else if (record.recordType === "snapshot-batch") {
          if (!started) throw new CatalogImportError("INVALID_STREAM_SEQUENCE");
          if (record.batchNumber > expectedBatch)
            throw new CatalogImportError("BATCH_SEQUENCE_CONFLICT");
          await telemetry.measureBatch(
            record.batchNumber,
            record.uncompressedBytes,
            () =>
              runReconciled(
                "batch",
                () => store.recordBatch(record, signal),
                () => reconcileBatch(store, record, signal),
              ),
            signal,
          );
          if (record.batchNumber === expectedBatch) expectedBatch += 1;
        } else if (record.recordType === "snapshot-completed") {
          if (!started) throw new CatalogImportError("INVALID_STREAM_SEQUENCE");
          if (record.batchCount !== expectedBatch)
            throw new CatalogImportError("TERMINAL_COUNT_MISMATCH");
          pendingCompleted = record;
          terminalSeen = true;
        } else {
          pendingFailed = record;
          terminalSeen = true;
        }
      }
      if (!terminalSeen)
        throw new CatalogImportError("INVALID_STREAM_MISSING_TERMINAL");
    });
    if (pendingCompleted !== undefined) {
      await runReconciled(
        "terminal",
        () => store.complete(pendingCompleted!, signal),
        () => reconcileCompleted(store, pendingCompleted!, signal),
      );
      terminalPersisted = true;
    }
    if (pendingFailed !== undefined) {
      await runReconciled(
        "reject",
        () => store.reject(snapshotRef, pendingFailed!.code, signal),
        () =>
          reconcileRejected(store, snapshotRef, pendingFailed!.code, signal),
      );
      terminalPersisted = true;
      throw new CatalogImportError(`SNAPSHOT_FAILED_${pendingFailed.code}`);
    }
    return snapshotRef;
  } catch (error) {
    if (
      error instanceof CatalogOutcomeUnknown ||
      error instanceof CatalogReconciledFailure ||
      options.signal.aborted ||
      terminalPersisted ||
      !created
    )
      throw error;
    // Only the store can prove a SQL failure rolled back. Raw DB failures must
    // never be reclassified from their message or from an upstream stream phase.
    const code = failureCode(error, started);
    if (code === undefined) throw error;
    if (deadlineSignal?.aborted === true) {
      const cleanupSignal = AbortSignal.any([
        options.signal,
        AbortSignal.timeout(2_000),
      ]);
      await runReconciled(
        "reject",
        () =>
          store.reject(snapshotRef, "IMPORT_DEADLINE_EXCEEDED", cleanupSignal),
        () =>
          reconcileRejected(
            store,
            snapshotRef,
            "IMPORT_DEADLINE_EXCEEDED",
            cleanupSignal,
          ),
      );
      throw error;
    }
    if (code === "IMPORT_DB_ROLLED_BACK") {
      let row;
      try {
        row = await store.getSnapshot(snapshotRef, signal);
      } catch (readError) {
        throw new CatalogOutcomeUnknown("durable-reread", readError);
      }
      if (
        row === null ||
        row.supplier_ref !== options.supplierRef ||
        !["Created", "Receiving"].includes(row.state)
      )
        throw error;
    }
    await runReconciled(
      "reject",
      () => store.reject(snapshotRef, code, signal),
      () => reconcileRejected(store, snapshotRef, code, signal),
    );
    throw error;
  }
}
