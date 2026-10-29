import assert from "node:assert/strict";
import { mock } from "node:test";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { trace } from "@opentelemetry/api";
import {
  catalogBatchBytes,
  catalogBatchHash,
} from "../../packages/contracts/aroma-v1/dist/index.js";
import { CatalogTelemetry } from "../../apps/catalog-supplier-sync/dist/observability.js";

// Production importer/store/telemetry, with only SQL transport and COPY sink replaced.
const snapshotRef = "snp_01ARZ3NDEKTSV4RRFFQ69G5FBA";
const supplierRef = "sup_00000000000000000000000001";
const correlationId = "11111111-1111-4111-8111-111111111111";
const secret = "secret-authorization-Bearer-key-material-password";
const items = [1, 2].map((number) => ({
  sourceProductKeyHash: String(number).repeat(64),
  sourceVariantKeyHash: String(number).repeat(64),
  sourceOfferKeyHash: String(number).repeat(64),
  displayName: `RAW_CATALOG_PAYLOAD_${number}`,
  unit: "piece",
  supplierUnitMinor: "10",
  currency: "RUB",
  availability: "Available",
  imageUrl: null,
  sourceIdentityScheme: "hmac-sha256-v1",
}));
const batch = {
  streamVersion: "1",
  recordType: "snapshot-batch",
  snapshotRef,
  batchNumber: 0,
  offerCount: items.length,
  uncompressedBytes: catalogBatchBytes(items),
  batchHash: catalogBatchHash(items),
  previousBatchHash: null,
  items,
};
let now = 0;
let fail = false;
let copied = 0;
let lastSource;
const spans = [];
const diagnostics = [];
const telemetry = new CatalogTelemetry(
  (value) => diagnostics.push(value),
  () => now,
);
trace.setGlobalTracerProvider({
  getTracer: () => ({
    startSpan: (name, options) => {
      const row = { name, attributes: options?.attributes ?? {}, ended: false };
      spans.push(row);
      return {
        end: () => {
          row.ended = true;
        },
        setStatus: (status) => {
          row.status = status;
        },
        spanContext: () => ({
          traceId: "1".repeat(32),
          spanId: "2".repeat(16),
          traceFlags: 1,
        }),
      };
    },
  }),
});
mock.module("../../packages/platform-database/dist/index.js", {
  namedExports: {
    DatabaseTransactionError: class extends Error {},
    withTransaction: async (_database, _options, work) => work({}),
  },
});
mock.module("../../packages/platform-database/dist/owner.js", {
  namedExports: {
    defineTemporaryTable: () => async () => {},
    defineCopy: () => async (_transaction, source) => {
      lastSource = source;
      now += 80; // COPY setup is not downstream backpressure.
      await pipeline(
        source,
        new Writable({
          highWaterMark: 1,
          write(_chunk, _encoding, callback) {
            copied++;
            setImmediate(() => {
              now += 25;
              callback(fail ? new Error(secret) : undefined);
            });
          },
        }),
      );
      now += 90; // COPY settlement is not a source pause either.
    },
    defineStatement: (_database, sql) => async () => {
      if (sql.startsWith("SELECT snapshot_ref"))
        return { rows: [{ state: "Receiving", next_batch_number: 0 }] };
      if (sql.includes("FROM catalog.snapshot_batches WHERE"))
        return { rows: [] };
      if (sql.includes("AS collision")) return { rows: [{ collision: false }] };
      if (sql.includes("FROM catalog.snapshot_offers o JOIN"))
        return {
          rows: items.map((item, index) => ({
            item_index: index,
            source_product_key_hash: item.sourceProductKeyHash,
            source_variant_key_hash: item.sourceVariantKeyHash,
            source_offer_key_hash: item.sourceOfferKeyHash,
            display_name: item.displayName,
            unit: item.unit,
            supplier_unit_minor: item.supplierUnitMinor,
            currency: item.currency,
            availability: item.availability,
            image_url: null,
            supplier_promotions: null,
            grind_options: null,
            source_identity_scheme: item.sourceIdentityScheme,
          })),
        };
      if (sql.startsWith("INSERT ") || sql.startsWith("UPDATE "))
        return { rows: [] };
      throw new Error(`unexpected SQL fixture: ${sql}`);
    },
  },
});
try {
  const { createCatalogImportStore } =
    await import("../../apps/catalog-supplier-sync/dist/infrastructure/catalog-import-store.js");
  const { runCatalogImport } =
    await import("../../apps/catalog-supplier-sync/dist/run-catalog-import.js");
  const realStore = createCatalogImportStore({}, telemetry);
  const store = {
    ...realStore,
    create: async () => {},
    acceptStarted: async () => {},
    complete: async () => "stored",
    reject: async () => "stored",
  };
  const options = {
    store,
    telemetry,
    snapshotRef,
    supplierRef,
    signal: new AbortController().signal,
    context: {
      correlationId,
      authorization: secret,
      key: secret,
      payload: items,
    },
    exportCatalog: async function* () {
      now += 100; // Upstream wait must not count as consumer backpressure.
      yield {
        streamVersion: "1",
        recordType: "snapshot-started",
        snapshotRef,
        supplierRef,
        providerSnapshotRef: "raw-provider-id",
        startedAt: "2026-09-20T00:00:00Z",
      };
      now += 100;
      yield batch;
      assert.equal(copied, 2, "next upstream record must wait for persistence");
      now += 100;
      yield {
        streamVersion: "1",
        recordType: "snapshot-completed",
        snapshotRef,
        batchCount: 1,
        productCount: 2,
        variantCount: 2,
        offerCount: 2,
        contentHash: "0".repeat(64),
        completedAt: "2026-09-20T00:01:00Z",
      };
    },
  };
  await runCatalogImport(options);
  assert.ok(
    spans.some((span) => span.name === "catalog.import.stream"),
    "stream span missing",
  );
  for (const phase of [
    "generation",
    "stream",
    "validation",
    "copy",
    "transaction",
  ]) {
    const rows = spans.filter(
      (span) => span.name === `catalog.import.${phase}`,
    );
    assert.ok(rows.length > 0, `${phase} span missing`);
    for (const row of rows) {
      assert.equal(row.attributes.snapshotRef, snapshotRef);
      assert.equal(row.attributes.correlationId, correlationId);
      assert.equal(row.ended, true);
    }
  }
  for (const phase of ["validation", "copy", "transaction"]) {
    assert.ok(
      spans.some(
        (span) =>
          span.name === `catalog.import.${phase}` &&
          span.attributes.batchNumber === 0,
      ),
      `${phase} batch identity missing`,
    );
  }
  const batchDiagnostic = diagnostics.find(
    (value) => value.event === "catalog_batch",
  );
  assert.deepEqual(batchDiagnostic, {
    event: "catalog_batch",
    outcome: "success",
    snapshotRef,
    correlationId,
    batchNumber: 0,
    durationMs: 220,
  });
  assert.ok(
    diagnostics.some(
      (value) =>
        value.event === "catalog_import" &&
        value.snapshotRef === snapshotRef &&
        value.correlationId === correlationId,
    ),
  );
  const metric = (name) =>
    Number(
      telemetry
        .render()
        .find((line) => line.startsWith(`${name} `))
        ?.split(" ")
        .at(-1),
    );
  assert.equal(
    metric("coffee_catalog_import_batch_duration_seconds_sum"),
    0.22,
  );
  assert.equal(metric("coffee_catalog_import_batch_duration_seconds_count"), 1);
  assert.equal(
    metric('coffee_catalog_import_backpressure_seconds_sum{phase="stream"}'),
    0.22,
  );
  assert.ok(
    metric('coffee_catalog_import_backpressure_seconds_sum{phase="copy"}') > 0,
  );
  assert.ok(
    metric('coffee_catalog_import_backpressure_seconds_sum{phase="copy"}') <=
      0.05,
    "COPY pressure must exclude setup/settlement time",
  );
  assert.ok(
    metric('coffee_catalog_import_backpressure_seconds_count{phase="copy"}') >
      0,
  );
  assert.equal(lastSource.listenerCount("pause"), 0);
  assert.equal(lastSource.listenerCount("resume"), 0);

  fail = true;
  await assert.rejects(() => runCatalogImport(options));
  assert.deepEqual(
    diagnostics.find(
      (value) => value.event === "catalog_batch" && value.outcome === "failure",
    ),
    {
      event: "catalog_batch",
      outcome: "failure",
      snapshotRef,
      correlationId,
      batchNumber: 0,
      durationMs: 105,
    },
  );
  assert.ok(
    spans.every(
      (span) =>
        span.attributes.snapshotRef === snapshotRef &&
        span.attributes.correlationId === correlationId,
    ),
    "failure spans must retain generation identity",
  );
  assert.equal(lastSource.destroyed, true);
  assert.equal(metric("coffee_catalog_import_batch_duration_seconds_count"), 2);
  assert.equal(
    metric("coffee_catalog_import_batches_total"),
    1,
    "failed batches must not count as accepted",
  );
  assert.ok(
    spans.filter((span) => span.status?.code === 2).length >= 3,
    "stream/COPY/transaction failures must be marked",
  );
  assert.ok(
    spans.every((span) => span.ended),
    "failed spans must also end",
  );
  assert.equal(lastSource.listenerCount("pause"), 0);
  assert.equal(lastSource.listenerCount("resume"), 0);

  // No pause means no COPY pressure, even when COPY itself takes time.
  const idleSource = new Readable({ read() {} });
  const pressureBefore = metric(
    'coffee_catalog_import_backpressure_seconds_count{phase="copy"}',
  );
  await telemetry.copy(idleSource, async () => {
    now += 500;
  });
  assert.equal(
    metric('coffee_catalog_import_backpressure_seconds_count{phase="copy"}'),
    pressureBefore,
  );
  idleSource.destroy();

  // Concurrent scopes cannot cross-contaminate identity or retain arbitrary caller fields.
  const firstScopedSpan = spans.length;
  await Promise.all(
    [0, 1].map((batchNumber) =>
      telemetry.withIdentity(
        {
          snapshotRef: `scope-${batchNumber}`,
          correlationId: `correlation-${batchNumber}`,
          batchNumber,
          authorization: secret,
          payload: items,
        },
        async () => {
          await new Promise((resolve) => setImmediate(resolve));
          await telemetry.observe("transaction", async () => {});
        },
      ),
    ),
  );
  assert.deepEqual(
    spans.slice(firstScopedSpan).map((span) => span.attributes),
    [
      {
        snapshotRef: "scope-0",
        correlationId: "correlation-0",
        batchNumber: 0,
      },
      {
        snapshotRef: "scope-1",
        correlationId: "correlation-1",
        batchNumber: 1,
      },
    ],
  );
  await telemetry.observe("transaction", async () => {});
  assert.deepEqual(
    spans.at(-1).attributes,
    {},
    "identity must not survive its scope",
  );
  const rendered = telemetry.render().join("\n");
  assert.doesNotMatch(
    rendered,
    /snapshotRef|batchNumber|correlation|snp_|sup_|11111111/u,
  );
  for (const line of telemetry
    .render()
    .filter((line) => !line.startsWith("#"))) {
    const labels = line.match(/\{(.+)\}/u)?.[1];
    if (labels !== undefined)
      assert.match(
        labels,
        /^(?:outcome="(?:success|failure|unknown|aborted)"|phase="(?:stream|copy)")$/u,
      );
  }
  assert.doesNotMatch(
    JSON.stringify({ spans, diagnostics, rendered }),
    /RAW_CATALOG_PAYLOAD|raw-provider-id|authorization|Bearer|key-material|password|sourceProductKeyHash|sourceOfferKeyHash|supplierUnitMinor/u,
  );
  for (const item of items)
    assert.ok(
      !JSON.stringify({ spans, diagnostics, rendered }).includes(
        item.sourceOfferKeyHash,
      ),
    );
  console.log(
    "residual observability: production stream/store spans, identities, duration, backpressure, failure cleanup and redaction verified",
  );
} finally {
  trace.disable();
  mock.restoreAll();
}
