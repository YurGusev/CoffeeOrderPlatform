import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { canonicalJson } from "../../../../packages/platform-idempotency/dist/index.js";
import { withTransaction } from "../../../../packages/platform-database/dist/index.js";
import { defineStatement } from "../../../../packages/platform-database/dist/owner.js";
import { createSqlInboxStore } from "../../../../packages/platform-inbox/dist/index.js";
import { processKafkaRecord } from "../../../../packages/platform-kafka-runtime/dist/index.js";
import { createCatalogActivationStore } from "../../../../apps/catalog-activation-worker/dist/infrastructure/activation-store.js";
import { createCatalogImportStore } from "../../../../apps/catalog-supplier-sync/dist/infrastructure/catalog-import-store.js";
import { readNdjson } from "../../../../apps/catalog-supplier-sync/dist/ndjson-reader.js";
import {
  runCatalogImport,
  newSnapshotRef,
} from "../../../../apps/catalog-supplier-sync/dist/run-catalog-import.js";
import { decodeAromaPreparationEnvelope } from "../../../../apps/orders-aroma-preparation/dist/application/messages.js";
import { createAromaPreparationStore } from "../../../../apps/orders-aroma-preparation/dist/infrastructure/preparation-store.js";

function fail(code) {
  const error = new Error("AROMA_SANDBOX_CATALOG_CHECK_FAILED");
  error.code = "AROMA_SANDBOX_CATALOG_CHECK_FAILED";
  error.safeDiagnostic = { causeCode: code };
  throw error;
}

const COMPONENT_ERROR_NAMES = new Set([
  "CatalogExportError",
  "CatalogImportError",
  "CatalogStreamError",
  "CatalogActivationError",
  "DatabaseTransactionError",
  "AromaPreparationError",
  "InboxProcessingError",
  "KafkaRuntimeError",
]);
const CATALOG_STAGES = new Set([
  "catalog-import",
  "catalog-activation",
  "selection",
  "catalog-outbox",
  "orders-inbox",
]);
const CATALOG_CHECK_CODES = new Set([
  "ENVIRONMENT_DENIED",
  "DATABASE_OWNER_MISSING",
  "GATEWAY_ADAPTER_MISSING",
  "RUN_ID_INVALID",
  "SIGNAL_INVALID",
  "APPROVED_OFFER_REF_INVALID",
  "CONFIG_INVALID",
  "IMPORT_SNAPSHOT_MISMATCH",
  "ACTIVATION_FAILED",
  "NO_ACTIVE_AVAILABLE_WHOLE_BEAN_OFFER",
  "APPROVED_OFFER_NOT_ACTIVE_AVAILABLE_WHOLE_BEAN",
  "REAL_MAPPING_OUTBOX_EVENT_MISSING_OR_AMBIGUOUS",
  "REAL_MAPPING_OUTBOX_EVENT_INVALID",
  "INBOX_RECORD_MISMATCH",
  "ORDERS_MAPPING_INBOX_NOT_PROCESSED",
  "ACTIVATION_AMBIGUOUS_MAPPING",
  "ACTIVATION_BATCH_HASH_MISMATCH",
  "ACTIVATION_BATCH_SEQUENCE_MISMATCH",
  "ACTIVATION_BINDING_MISMATCH",
  "ACTIVATION_CONTENT_HASH_MISMATCH",
  "ACTIVATION_COUNT_MISMATCH",
  "ACTIVATION_INVALID_CURRENCY",
  "ACTIVATION_INVALID_ENUM",
  "ACTIVATION_INVALID_MONEY",
  "ACTIVATION_INVALID_REFERENCE",
  "ACTIVATION_INVALID_SNAPSHOT",
  "ACTIVATION_OUTBOX_SEQUENCE_MISSING",
  "ACTIVATION_POINTER_MISSING",
  "SOURCE_IDENTITY_COLLISION",
]);

export function aromaCatalogErrorFacts(error) {
  let node = error;
  let ownerCode;
  let causeCode;
  let sqlState;
  const seen = new Set();
  for (
    let depth = 0;
    node && typeof node === "object" && depth < 5 && !seen.has(node);
    depth += 1
  ) {
    seen.add(node);
    const code = typeof node.code === "string" ? node.code : "";
    const namedCode =
      COMPONENT_ERROR_NAMES.has(node.name) &&
      /^[A-Z][A-Z0-9_]{1,79}$/u.test(code)
        ? code
        : node.name === "InboxProcessingError" &&
            /^[A-Z][A-Z0-9_]{1,79}$/u.test(node.failure?.reason ?? "")
          ? node.failure.reason
          : null;
    if (!sqlState && /^[0-9A-Z]{5}$/u.test(node.sqlState ?? ""))
      sqlState = node.sqlState;
    if (!sqlState && /^[0-9A-Z]{5}$/u.test(code)) sqlState = code;
    if (namedCode) {
      if (!ownerCode) ownerCode = namedCode;
      else if (!causeCode) causeCode = namedCode;
    }
    node = node.cause;
  }
  return {
    ...(ownerCode ? { ownerCode } : {}),
    ...(sqlState ? { sqlState } : {}),
    ...(causeCode ? { causeCode } : {}),
  };
}

export function createAromaCatalogStageFailure(stage, error, primaryFacts) {
  if (!CATALOG_STAGES.has(stage))
    throw new Error("AROMA_CATALOG_STAGE_INVALID");
  const safe =
    error?.safeDiagnostic && typeof error.safeDiagnostic === "object"
      ? error.safeDiagnostic
      : {};
  const details = aromaCatalogErrorFacts(error);
  const diagnostic = {
    substage: stage,
    ...(details.ownerCode ? { ownerCode: details.ownerCode } : {}),
    ...(primaryFacts?.sqlState
      ? { sqlState: primaryFacts.sqlState }
      : details.sqlState
        ? { sqlState: details.sqlState }
        : {}),
    ...(primaryFacts?.causeCode
      ? { causeCode: primaryFacts.causeCode }
      : primaryFacts?.ownerCode
        ? { causeCode: primaryFacts.ownerCode }
        : details.causeCode
          ? { causeCode: details.causeCode }
          : undefined),
    ...(CATALOG_CHECK_CODES.has(safe.causeCode)
      ? { causeCode: safe.causeCode }
      : {}),
  };
  const failure = new Error("AROMA_CATALOG_STAGE_FAILED");
  failure.code = "AROMA_CATALOG_STAGE_FAILED";
  failure.safeDiagnostic = diagnostic;
  return failure;
}

function validateInput({
  config,
  catalogImportDb,
  catalogActivationDb,
  ordersPreparationDb,
  gateway,
  runId,
  signal,
  approvedOfferRef,
}) {
  if (!config || config.environment === "production")
    fail("ENVIRONMENT_DENIED");
  if (!catalogImportDb || !catalogActivationDb || !ordersPreparationDb)
    fail("DATABASE_OWNER_MISSING");
  if (
    typeof gateway?.exportCatalog !== "function" ||
    typeof gateway?.registerBinding !== "function" ||
    typeof gateway?.resolveByRawProviderOfferId !== "function" ||
    typeof gateway?.resolveProviderOffer !== "function"
  )
    fail("GATEWAY_ADAPTER_MISSING");
  if (
    typeof runId !== "string" ||
    !/^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{7}$/u.test(runId)
  )
    fail("RUN_ID_INVALID");
  if (!(signal instanceof AbortSignal)) fail("SIGNAL_INVALID");
  if (
    approvedOfferRef !== undefined &&
    (typeof approvedOfferRef !== "string" ||
      !/^off_[0-9A-HJKMNP-TV-Z]{26}$/u.test(approvedOfferRef))
  )
    fail("APPROVED_OFFER_REF_INVALID");
}

export function freshOfferRefForProviderId(
  binding,
  sourceIdentity,
  supplierRef,
  approvedOfferRef,
) {
  if (
    !binding ||
    binding.state !== "Bound" ||
    binding.supplierRef !== supplierRef ||
    binding.sourceIdentityScheme !== "hmac-sha256-v1" ||
    !/^off_[0-9A-HJKMNP-TV-Z]{26}$/u.test(binding.offerRef ?? "") ||
    !/^[a-f0-9]{64}$/u.test(binding.sourceOfferKeyHash ?? "")
  ) {
    fail("APPROVED_OFFER_NOT_ACTIVE_AVAILABLE_WHOLE_BEAN");
  }
  if (
    !sourceIdentity ||
    sourceIdentity.offerRef !== binding.offerRef ||
    sourceIdentity.supplierRef !== supplierRef ||
    sourceIdentity.sourceOfferKeyHash !== binding.sourceOfferKeyHash ||
    sourceIdentity.rawProviderOfferId !== "445"
  ) {
    fail("APPROVED_OFFER_NOT_ACTIVE_AVAILABLE_WHOLE_BEAN");
  }
  if (approvedOfferRef !== undefined && approvedOfferRef !== binding.offerRef)
    fail("APPROVED_OFFER_REF_INVALID");
  return binding.offerRef;
}

async function readRows(database, sql, parameters, signal) {
  const statement = defineStatement(database, sql);
  return withTransaction(
    database,
    { mode: "background", signal },
    async (transaction) => (await statement(transaction, parameters)).rows,
  );
}

export async function prepareAromaSandboxCatalog({
  config,
  catalogImportDb,
  catalogActivationDb,
  ordersPreparationDb,
  gateway,
  runId,
  signal,
  approvedOfferRef,
}) {
  validateInput({
    config,
    catalogImportDb,
    catalogActivationDb,
    ordersPreparationDb,
    gateway,
    runId,
    signal,
    approvedOfferRef,
  });
  signal.throwIfAborted();
  const at = async (substage, work, primaryFacts) => {
    try {
      return await work();
    } catch (error) {
      if (
        error?.code === "AROMA_CATALOG_STAGE_FAILED" &&
        CATALOG_STAGES.has(error.safeDiagnostic?.substage)
      )
        throw error;
      throw createAromaCatalogStageFailure(substage, error, primaryFacts?.());
    }
  };

  const supplierRef = config.aroma?.supplierRef;
  const catalogService = config.services?.["catalog-supplier-sync"];
  const preparationService = config.services?.["orders-aroma-preparation"];
  const preparationSettings = preparationService?.aromaPreparation;
  const maxSnapshotAgeMs =
    config.services?.["aroma-convergence"]?.aromaConvergence?.maxSnapshotAgeMs;
  const importDeadlineMs = catalogService?.deadlineMs;
  const consumer = preparationService?.kafka?.consumers?.find(
    (value) =>
      value.groupId === "orders-catalog-mapping-v2" &&
      value.processing === "durable" &&
      value.topics?.length === 1,
  );
  if (
    !supplierRef ||
    !catalogService ||
    !preparationSettings ||
    !Number.isSafeInteger(importDeadlineMs) ||
    importDeadlineMs <= 0 ||
    !Number.isSafeInteger(maxSnapshotAgeMs) ||
    consumer?.topics?.[0] !== config.kafka?.topics?.catalogMapping?.name
  )
    fail("CONFIG_INVALID");

  const snapshotRef = newSnapshotRef();
  const correlationId = randomUUID();
  let exportCauseFacts;
  await at(
    "catalog-import",
    async () => {
      const imported = await runCatalogImport({
        store: createCatalogImportStore(catalogImportDb),
        supplierRef,
        snapshotRef,
        signal,
        deadlineMs: importDeadlineMs,
        context: { correlationId },
        exportCatalog: async function* (
          {
            snapshotRef: requestedSnapshotRef,
            supplierRef: requestedSupplierRef,
          },
          exportContext,
        ) {
          try {
            const bytes = await gateway.exportCatalog({
              snapshotRef: requestedSnapshotRef,
              supplierRef: requestedSupplierRef,
              signal: exportContext.signal,
            });
            yield* readNdjson(Readable.from(bytes), {
              signal: exportContext.signal,
            });
          } catch (error) {
            exportCauseFacts ??= aromaCatalogErrorFacts(error);
            throw error;
          }
        },
      });
      if (imported !== snapshotRef) fail("IMPORT_SNAPSHOT_MISMATCH");
    },
    () => exportCauseFacts ?? gateway.catalogExportFailureFacts?.(),
  );

  const activation = await at("catalog-activation", async () => {
    const result = await createCatalogActivationStore(
      catalogActivationDb,
    ).runSnapshot(
      snapshotRef,
      (request) => gateway.registerBinding(request, signal),
      signal,
    );
    if (result.kind !== "activated" || result.snapshotRef !== snapshotRef) {
      fail(
        result.kind === "rejected" && CATALOG_CHECK_CODES.has(result.code)
          ? result.code
          : "ACTIVATION_FAILED",
      );
    }
    return result;
  });

  const rawOfferBinding = await at("selection", () =>
    gateway.resolveByRawProviderOfferId("445", supplierRef, signal),
  );
  if (!/^off_[0-9A-HJKMNP-TV-Z]{26}$/u.test(rawOfferBinding?.offerRef ?? ""))
    fail("APPROVED_OFFER_NOT_ACTIVE_AVAILABLE_WHOLE_BEAN");
  const sourceIdentity = await at("selection", () =>
    gateway.resolveProviderOffer(rawOfferBinding.offerRef, supplierRef, signal),
  );
  const candidateOfferRef = freshOfferRefForProviderId(
    rawOfferBinding,
    sourceIdentity,
    supplierRef,
    approvedOfferRef,
  );

  const mappings = await at("selection", async () => {
    const rows = await readRows(
      catalogActivationDb,
      `SELECT p.product_ref,v.variant_ref,m.offer_ref,m.mapping_revision::text
    FROM catalog.catalog_state s
    JOIN catalog.products p ON p.snapshot_ref=s.active_snapshot_ref
    JOIN catalog.variants v ON v.snapshot_ref=p.snapshot_ref AND v.product_ref=p.product_ref
    JOIN catalog.offer_mappings m ON m.snapshot_ref=v.snapshot_ref AND m.variant_ref=v.variant_ref
    JOIN catalog.availability a ON a.snapshot_ref=m.snapshot_ref AND a.variant_ref=m.variant_ref
    WHERE s.id=true AND s.active_snapshot_ref=$1 AND m.offer_ref=$2
      AND m.offer_ref IS NOT NULL AND m.mapping_state='Active' AND a.state='Available'
      AND COALESCE(jsonb_array_length(v.grind_options),0)=0
    ORDER BY p.product_ref,v.variant_ref,m.offer_ref`,
      [snapshotRef, candidateOfferRef],
      signal,
    );
    if (rows.length !== 1)
      fail(
        approvedOfferRef === undefined
          ? "NO_ACTIVE_AVAILABLE_WHOLE_BEAN_OFFER"
          : "APPROVED_OFFER_NOT_ACTIVE_AVAILABLE_WHOLE_BEAN",
      );
    return rows;
  });
  const mapping = mappings[0];
  const selectedOfferRef = mapping.offer_ref;
  const outboxRows = await at("catalog-outbox", async () => {
    const rows = await readRows(
      catalogActivationDb,
      `SELECT message_id,envelope FROM catalog.outbox_messages
    WHERE message_type='CatalogMappingChanged.v2' AND envelope->'payload'->>'offerRef'=$1
      AND envelope->'payload'->>'catalogSnapshotRevision'=$2`,
      [selectedOfferRef, activation.snapshotRevision],
      signal,
    );
    if (rows.length !== 1)
      fail("REAL_MAPPING_OUTBOX_EVENT_MISSING_OR_AMBIGUOUS");
    return rows;
  });
  const outboxEvent = outboxRows[0].envelope;
  await at("catalog-outbox", async () => {
    if (
      outboxEvent?.messageId !== outboxRows[0].message_id ||
      outboxEvent?.producer !== "catalog-activation-worker" ||
      outboxEvent?.messageType !== "CatalogMappingChanged.v2" ||
      outboxEvent?.payload?.productRef !== mapping.product_ref ||
      outboxEvent?.payload?.variantRef !== mapping.variant_ref ||
      outboxEvent?.payload?.offerRef !== selectedOfferRef ||
      outboxEvent?.payload?.mappingRevision !== mapping.mapping_revision ||
      outboxEvent?.payload?.availability !== "Available" ||
      outboxEvent?.payload?.mappingState !== "Active"
    )
      fail("REAL_MAPPING_OUTBOX_EVENT_INVALID");
  });

  const preparationStore = createAromaPreparationStore(ordersPreparationDb, {
    ...preparationSettings,
    maxSnapshotAgeMs,
  });
  const topic = consumer.topics[0];
  const record = {
    topic,
    partition: 0,
    offset: "0",
    key: outboxEvent.aggregate.ref,
    value: canonicalJson(outboxEvent),
    headers: {},
  };
  const inboxRows = await at("orders-inbox", async () => {
    await processKafkaRecord(record, {
      runtime: "orders-aroma-preparation",
      groupId: consumer.groupId,
      topics: consumer.topics,
      leaseMs: 60_000,
      maxMessageBytes: 1_048_576,
      signal,
      commit: async () => {},
      binding: {
        processing: "durable",
        database: ordersPreparationDb,
        inbox: createSqlInboxStore(ordersPreparationDb, {
          schema: "orders",
          consumerName: consumer.groupId,
        }),
        decode: decodeAromaPreparationEnvelope,
        handle: (transaction, envelope, actualRecord, handlerSignal) => {
          if (
            actualRecord.topic !== topic ||
            actualRecord.key !== outboxEvent.aggregate.ref
          )
            fail("INBOX_RECORD_MISMATCH");
          return preparationStore.handle(
            transaction,
            envelope,
            actualRecord,
            handlerSignal,
          );
        },
      },
    });

    const rows = await readRows(
      ordersPreparationDb,
      `SELECT state FROM orders.inbox_messages
      WHERE consumer_name=$1 AND message_id=$2`,
      [consumer.groupId, outboxRows[0].message_id],
      signal,
    );
    if (rows.length !== 1 || rows[0].state !== "Processed")
      fail("ORDERS_MAPPING_INBOX_NOT_PROCESSED");
    return rows;
  });

  return Object.freeze({
    selected: Object.freeze({
      productRef: mapping.product_ref,
      variantRef: mapping.variant_ref,
      offerRef: selectedOfferRef,
    }),
    catalog: Object.freeze({
      snapshotRef,
      snapshotRevision: activation.snapshotRevision,
      mappingRevision: mapping.mapping_revision,
      mappingEventRef: outboxRows[0].message_id,
    }),
    orders: Object.freeze({
      consumerGroup: consumer.groupId,
      inboxMessageRef: outboxRows[0].message_id,
      inboxState: inboxRows[0].state,
    }),
    proof: Object.freeze({
      providerCatalogExport: true,
      catalogImport: true,
      catalogActivation: true,
      catalogOwnerOutbox: true,
      productionOrdersDecoderAndHandler: true,
      ordersInboxProcessed: true,
      catalogStatisticsPrepared: false,
      coldDatabasePlannerProof: false,
      offerSelection: "provider-id-445-exact-current-mapping",
      delivery: "in-process-owner-envelope",
      kafkaBrokerTransport: false,
    }),
  });
}
