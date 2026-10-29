import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  CATALOG_SOURCE_IDENTITY_SCHEME,
  CatalogExportError,
  canonicalCatalogJson,
  createCatalogExportStream,
  sha256CatalogHash,
} from "../../apps/aroma-gateway/dist/application/catalog-export.js";
import {
  createProviderCatalogSource,
  sourceIdentityForOffer,
} from "../../apps/aroma-gateway/dist/application/provider-catalog-source.js";
import { createSourceIdentity } from "../../apps/aroma-gateway/dist/domain/source-identity.js";
import { MemoryProviderSessionStore } from "../../apps/aroma-gateway/dist/infrastructure/database/provider-session-store.js";
import { GatewayMetrics } from "../../apps/aroma-gateway/dist/infrastructure/observability.js";
import { ProviderHttpClient } from "../../apps/aroma-gateway/dist/infrastructure/provider/http-client.js";
import { ProviderSessionManager } from "../../apps/aroma-gateway/dist/infrastructure/provider/session.js";
import { registerAromaCatalogExportRoute } from "../../apps/aroma-gateway/dist/transport/http/index.js";
import { createRuntime } from "../../packages/platform-runtime/dist/index.js";
import { signServiceDelegation } from "../../packages/platform-security/dist/index.js";

const request = Object.freeze({
  snapshotRef: "snp_01ARZ3NDEKTSV4RRFFQ69G5FAW",
  supplierRef: "sup_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  providerSnapshotRef: "provider-snapshot-1",
});
const clock = Object.freeze({ now: () => "2026-09-05T10:00:00.000Z" });
const hash = (value) => value.toString(16).padStart(64, "0");
const offer = (index, product = 0, variant = 0) => ({
  displayName: `Coffee ${index}`,
  unit: "piece",
  supplierUnitMinor: String(100 + index),
  currency: "RUB",
  availability: "Available",
  imageUrl: `https://images.example.test/${index}.jpg`,
  supplierPromotions: [],
  product,
  variant,
});
const providerPage = (currentPage, lastPage) => ({
  data: [
    {
      id: currentPage,
      name: `Coffee ${currentPage}`,
      discount: [],
      offers: [
        {
          id: String(currentPage),
          name: `Coffee ${currentPage}`,
          vendor_code: `C-${currentPage}`,
          price: 10,
          params: [],
        },
      ],
    },
  ],
  links: { first: null, last: null, prev: null, next: null },
  meta: {
    current_page: currentPage,
    from: currentPage,
    to: currentPage,
    last_page: lastPage,
    per_page: 1,
    total: lastPage,
  },
});

const identityFor = (input, { supplierRef }) => ({
  supplierRef,
  sourceIdentityScheme: CATALOG_SOURCE_IDENTITY_SCHEME,
  sourceProductKeyHash: hash(input.product),
  sourceVariantKeyHash: hash(input.variant),
  sourceOfferKeyHash: hash(
    input.product * 1_000_000 +
      input.variant * 10_000 +
      Number(input.displayName.replace("Coffee ", "")),
  ),
  rawProviderProductId: `product-${input.product}`,
  rawProviderVariantId: `variant-${input.variant}`,
  rawProviderOfferId: `offer-${input.displayName}`,
});

function sourceFrom(values, { onReturn } = {}) {
  return {
    async *[Symbol.asyncIterator]() {
      try {
        for (const value of values) yield value;
      } finally {
        onReturn?.();
      }
    },
  };
}

function boundary({
  identity = identityFor,
  hashResolver = sha256CatalogHash,
  persistence = {},
} = {}) {
  return {
    identity,
    hash: hashResolver,
    persistence: {
      beginExport: persistence.beginExport ?? (() => {}),
      recordBatch: persistence.recordBatch ?? (() => {}),
      completeExport: persistence.completeExport ?? (() => {}),
      ...(persistence.failExport === undefined
        ? {}
        : { failExport: persistence.failExport }),
      ...(persistence.abortExport === undefined
        ? {}
        : { abortExport: persistence.abortExport }),
    },
  };
}

async function collect(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return chunks.map((chunk) => chunk.toString("utf8"));
}

function parse(lines) {
  return lines.map((line) => {
    assert.equal(line.endsWith("\n"), true);
    return JSON.parse(line);
  });
}

function makeStream(values, options = {}) {
  return createCatalogExportStream({
    source: options.source ?? sourceFrom(values),
    request,
    boundary: options.boundary ?? boundary(),
    clock: options.clock ?? clock,
    signal: options.signal,
    limits: options.limits,
  });
}

function recordingTelemetry(events) {
  const metrics = new GatewayMetrics();
  const spans = [];
  return {
    metrics,
    spans,
    observeProviderLatency() {},
    startSpan(name, attributes = {}) {
      const span = {
        name,
        attributes: { ...attributes },
        endCount: 0,
        setAttribute(key, value) {
          this.attributes[key] = value;
          return this;
        },
        recordException(error) {
          this.exception = error;
        },
        setStatus() {
          return this;
        },
        end() {
          this.endCount += 1;
          events.push(`end:${name}`);
        },
      };
      spans.push(span);
      events.push(`start:${name}`);
      return span;
    },
  };
}

void test("catalog export emits exact canonical bytes, hashes, links, and distinct counts", async () => {
  const calls = [];
  const lines = await collect(
    makeStream([offer(0, 1, 7), offer(1, 1, 7)], {
      boundary: boundary({
        persistence: {
          beginExport: (record) => {
            calls.push(["begin", record.recordType]);
          },
          recordBatch: ({ record, identities }) => {
            calls.push([
              "batch",
              record.batchNumber,
              identities.map((item) => item.rawProviderOfferId),
            ]);
          },
          completeExport: (summary) => {
            calls.push(["complete", summary.offerCount]);
          },
        },
      }),
    }),
  );
  const records = parse(lines);
  assert.deepEqual(
    records.map((record) => record.recordType),
    ["snapshot-started", "snapshot-batch", "snapshot-completed"],
  );
  assert.equal(lines[0], `${canonicalCatalogJson(records[0])}\n`);
  assert.equal(lines[1], `${canonicalCatalogJson(records[1])}\n`);
  assert.equal(lines[2], `${canonicalCatalogJson(records[2])}\n`);
  assert.equal(records[1].previousBatchHash, null);
  assert.equal(records[1].offerCount, 2);
  assert.equal(records[2].productCount, 1);
  assert.equal(records[2].variantCount, 1);
  assert.equal(records[2].offerCount, 2);
  const itemBytes = Buffer.from(canonicalCatalogJson(records[1].items), "utf8");
  assert.equal(records[1].uncompressedBytes, itemBytes.byteLength);
  assert.equal(
    records[1].batchHash,
    createHash("sha256").update(itemBytes).digest("hex"),
  );
  assert.equal(
    records[2].contentHash,
    createHash("sha256")
      .update(Buffer.from(records[1].batchHash, "hex"))
      .digest("hex"),
  );
  assert.doesNotMatch(
    lines.join(""),
    /rawProvider|product-1|variant-7|offer-Coffee/,
  );
  assert.deepEqual(calls, [
    ["begin", "snapshot-started"],
    ["batch", 0, ["offer-Coffee 0", "offer-Coffee 1"]],
    ["complete", 2],
  ]);
});

void test("catalog telemetry spans one completed persistence/emission boundary per exported batch", async () => {
  const events = [];
  const telemetry = recordingTelemetry(events);
  const persistenceEvents = [];
  await collect(
    createCatalogExportStream({
      source: sourceFrom([offer(0, 1, 7), offer(1, 2, 8)]),
      request,
      telemetry,
      limits: { maxOffersPerBatch: 1 },
      boundary: boundary({
        persistence: {
          recordBatch: ({ record }) => {
            persistenceEvents.push(record.batchNumber);
          },
        },
      }),
    }),
  );
  assert.deepEqual(persistenceEvents, [0, 1]);
  assert.deepEqual(
    telemetry.spans.map((span) => span.name),
    ["aroma.gateway.catalog_batch", "aroma.gateway.catalog_batch"],
  );
  assert.deepEqual(
    telemetry.spans.map((span) => span.endCount),
    [1, 1],
  );
  assert.equal(
    events.filter((event) =>
      event.startsWith("start:aroma.gateway.catalog_batch"),
    ).length,
    2,
  );
  assert.equal(
    telemetry.metrics
      .render()
      .find((line) => line.startsWith("aroma_gateway_catalog_batches_total ")),
    "aroma_gateway_catalog_batches_total 2",
  );
});

void test("catalog export rejects zero-price Available and accepts local unavailable states", async () => {
  const zeroAvailable = { ...offer(0), supplierUnitMinor: "0" };
  const failed = parse(await collect(makeStream([zeroAvailable])));
  assert.deepEqual(
    failed.map((record) => record.recordType),
    ["snapshot-started", "snapshot-failed"],
  );
  assert.equal(failed.at(-1).code, "INVALID_STREAM");
  for (const availability of ["Unavailable", "Stopped"]) {
    const records = parse(
      await collect(makeStream([{ ...zeroAvailable, availability }])),
    );
    assert.equal(records[1].items[0].supplierUnitMinor, "0");
    assert.equal(records[1].items[0].availability, availability);
  }
  const negative = parse(
    await collect(makeStream([{ ...offer(0), supplierUnitMinor: "-1" }])),
  );
  assert.deepEqual(
    negative.map((record) => record.recordType),
    ["snapshot-started", "snapshot-failed"],
  );
  assert.equal(negative.at(-1).code, "INVALID_STREAM");
});

void test("catalog export keeps the real provider source demand-driven between persisted batches", async (t) => {
  const credentials = {
    scopeRef: "aroma-primary",
    email: "canonical@example.test",
    password: "test-only",
  };
  const sourceIdentityKey = Buffer.from("identity-key");
  const calls = [];
  const client = new ProviderHttpClient({
    origin: "https://provider.test",
    timeoutMs: 1_000,
    maxResponseBytes: 64 * 1024,
    connections: 1,
  });
  const manager = new ProviderSessionManager({
    transport: client,
    store: new MemoryProviderSessionStore(),
    encryptionKey: Buffer.alloc(32, 8),
  });
  t.after(() => manager.close());
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith("/api/v1/auth/login")) {
      return new Response(
        JSON.stringify({
          data: { email: credentials.email, wholesale: true, retail: false },
        }),
        {
          headers: {
            "content-type": "application/json",
            "set-cookie":
              "october_session=provider-session; Domain=provider.test; Path=/; HttpOnly",
          },
        },
      );
    }
    const pageNumber = Number(new URL(url).searchParams.get("page"));
    return new Response(JSON.stringify(providerPage(pageNumber, 2)), {
      headers: { "content-type": "application/json" },
    });
  });
  const source = createProviderCatalogSource({
    sessions: manager,
    credentials,
    sourceIdentityKey,
    pageSize: 1,
    normalize: (product, providerOffer) => ({
      displayName: providerOffer.name,
      unit: "piece",
      supplierUnitMinor: "1000",
      currency: "RUB",
      availability: "Available",
      imageUrl: "https://images.example.test/provider.jpg",
      supplierPromotions: [],
      providerIdentity: {
        rawProviderProductId: product.productId,
        rawProviderVariantId: providerOffer.offerId,
        rawProviderOfferId: providerOffer.offerId,
        packing: null,
        grindId: null,
      },
    }),
  });
  const stream = createCatalogExportStream({
    source,
    request,
    boundary: boundary({
      identity: (value) =>
        sourceIdentityForOffer(value, request.supplierRef, sourceIdentityKey),
      persistence: { recordBatch: () => {} },
    }),
    limits: { maxOffersPerBatch: 1 },
  });
  const started = await stream.next();
  assert.equal(
    JSON.parse(Buffer.from(started.value).toString()).recordType,
    "snapshot-started",
  );
  assert.equal(calls.length, 0);
  const firstBatch = await stream.next();
  assert.equal(
    JSON.parse(Buffer.from(firstBatch.value).toString()).recordType,
    "snapshot-batch",
  );
  assert.deepEqual(
    calls.map((call) => new URL(call.url).searchParams.get("page")),
    [null, "1"],
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 2);
  const secondBatch = await stream.next();
  assert.equal(
    JSON.parse(Buffer.from(secondBatch.value).toString()).recordType,
    "snapshot-batch",
  );
  assert.equal(new URL(calls[2].url).searchParams.get("page"), "2");
  await stream.return();
});

void test("real provider grind options are fetched once and never complete an incomplete batch", async (t) => {
  const credentials = {
    scopeRef: "aroma-primary",
    email: "canonical@example.test",
    password: "test-only",
  };
  const sourceIdentityKey = Buffer.from("identity-key");
  const calls = [];
  const groundOffers = ["101", "102"].map((id, index) => ({
    id,
    name: `Coffee ${id}`,
    vendor_code: `C-${id}`,
    price: 12 + index,
    params: [{ param: { slug: "is_grinded" }, param_value: { value: "1" } }],
  }));
  let rejectGrinds = false;
  const client = new ProviderHttpClient({
    origin: "https://provider.test",
    timeoutMs: 1_000,
    maxResponseBytes: 64 * 1024,
    connections: 1,
  });
  const manager = new ProviderSessionManager({
    transport: client,
    store: new MemoryProviderSessionStore(),
    encryptionKey: Buffer.alloc(32, 8),
  });
  t.after(() => manager.close());
  t.mock.method(globalThis, "fetch", async (url) => {
    const parsed = new URL(url);
    calls.push(parsed.pathname);
    if (parsed.pathname === "/api/v1/auth/login") {
      return new Response(
        JSON.stringify({
          data: { email: credentials.email, wholesale: true, retail: false },
        }),
        {
          headers: {
            "content-type": "application/json",
            "set-cookie":
              "october_session=provider-session; Domain=provider.test; Path=/; HttpOnly",
          },
        },
      );
    }
    if (parsed.pathname === "/api/v1/catalog/grinds") {
      if (rejectGrinds)
        return new Response("private provider failure", { status: 503 });
      return new Response(
        JSON.stringify([
          { id: "41", name: "Fine" },
          { id: "42", name: "Coarse" },
        ]),
        { headers: { "content-type": "application/json" } },
      );
    }
    assert.equal(parsed.pathname, "/api/v1/catalog/wholesale/products");
    return new Response(
      JSON.stringify({
        data: [
          {
            id: 1,
            name: "Coffee",
            discount: [],
            product_on_stop: false,
            show_on_wholesale: true,
            sold_by_piece: true,
            offers: groundOffers,
          },
        ],
        links: { first: null, last: null, prev: null, next: null },
        meta: { current_page: 1, last_page: 1, per_page: 1, total: 1 },
      }),
      { headers: { "content-type": "application/json" } },
    );
  });

  const runExport = (events) => {
    const source = createProviderCatalogSource({
      sessions: manager,
      credentials,
      supplierRef: request.supplierRef,
      sourceIdentityKey,
      pageSize: 1,
    });
    return collect(
      createCatalogExportStream({
        source,
        request,
        boundary: boundary({
          identity: (value) =>
            sourceIdentityForOffer(
              value,
              request.supplierRef,
              sourceIdentityKey,
            ),
          persistence: {
            recordBatch: ({ record }) => {
              events.batches.push(record);
            },
            completeExport: (summary) => {
              events.completed.push(summary);
            },
            failExport: ({ record }) => {
              events.failures.push(record);
            },
          },
        }),
        limits: { maxOffersPerBatch: 2 },
      }),
    );
  };

  const success = { batches: [], completed: [], failures: [] };
  const records = parse(await runExport(success));
  assert.deepEqual(calls, [
    "/api/v1/auth/login",
    "/api/v1/catalog/wholesale/products",
    "/api/v1/catalog/grinds",
  ]);
  assert.deepEqual(
    records.map((record) => record.recordType),
    ["snapshot-started", "snapshot-batch", "snapshot-completed"],
  );
  const batch = records[1];
  assert.equal(batch.items.length, 2);
  const expectedGrinds = [
    { id: "41", displayName: "Fine" },
    { id: "42", displayName: "Coarse" },
  ].map(({ id, displayName }) => ({
    sourceGrindKeyHash: createSourceIdentity({
      supplierRef: request.supplierRef,
      entityType: "grind",
      rawProviderIdentifier: id,
      sourceIdentityKey,
    }).sourceIdentityHash,
    displayName,
  }));
  for (const item of batch.items)
    assert.deepEqual(item.grindOptions, expectedGrinds);
  const itemBytes = Buffer.from(canonicalCatalogJson(batch.items), "utf8");
  assert.equal(batch.uncompressedBytes, itemBytes.byteLength);
  assert.equal(
    batch.batchHash,
    createHash("sha256").update(itemBytes).digest("hex"),
  );
  assert.equal(success.batches.length, 1);
  assert.equal(success.completed.length, 1);
  assert.deepEqual(success.failures, []);
  assert.doesNotMatch(JSON.stringify(batch), /"rawId"|"id":"4[12]"/u);

  calls.length = 0;
  rejectGrinds = true;
  const failure = { batches: [], completed: [], failures: [] };
  const failedRecords = parse(await runExport(failure));
  assert.deepEqual(calls, [
    "/api/v1/catalog/wholesale/products",
    "/api/v1/catalog/grinds",
  ]);
  assert.deepEqual(
    failedRecords.map((record) => record.recordType),
    ["snapshot-started", "snapshot-failed"],
  );
  assert.equal(failedRecords.at(-1).code, "PROVIDER_UNAVAILABLE");
  assert.equal(failure.batches.length, 0);
  assert.equal(failure.completed.length, 0);
  assert.equal(failure.failures.length, 1);
  assert.equal(failure.failures[0].code, "PROVIDER_UNAVAILABLE");
  assert.doesNotMatch(
    JSON.stringify(failedRecords),
    /private provider failure/u,
  );
});

void test("catalog export carries normalized supplier promotions and strips provider fields", async () => {
  const promotion = {
    discountBasisPoints: 1000,
    minimumWeightRaw: "0",
    providerCreatedAt: "2026-09-14T04:55:24.000000Z",
    providerUpdatedAt: "2026-09-14T04:55:24.000000Z",
    rawProviderDiscountId: "200083",
  };
  const records = parse(
    await collect(
      makeStream([{ ...offer(0), supplierPromotions: [promotion] }]),
    ),
  );
  assert.deepEqual(records[1].items[0].supplierPromotions, [
    {
      discountBasisPoints: 1000,
      minimumWeightRaw: "0",
      providerCreatedAt: "2026-09-14T04:55:24.000000Z",
      providerUpdatedAt: "2026-09-14T04:55:24.000000Z",
    },
  ]);
  assert.equal(
    JSON.stringify(records[1]).includes("rawProviderDiscountId"),
    false,
  );
  for (const invalidPromotion of [
    { ...promotion, discountBasisPoints: 10_001 },
    { ...promotion, providerUpdatedAt: "2026-02-30T00:00:00Z" },
  ]) {
    const failed = parse(
      await collect(
        makeStream([{ ...offer(0), supplierPromotions: [invalidPromotion] }]),
      ),
    );
    assert.deepEqual(
      failed.map((record) => record.recordType),
      ["snapshot-started", "snapshot-failed"],
    );
    assert.equal(failed.at(-1).code, "INVALID_STREAM");
  }
});

const catalogHeapProbe = String.raw`
import {
  CATALOG_SOURCE_IDENTITY_SCHEME,
  createCatalogExportStream,
  sha256CatalogHash,
} from "./apps/aroma-gateway/dist/application/catalog-export.js";

const total = 100_000;
const maxOffersPerBatch = 500;
const request = {
  snapshotRef: "snp_01ARZ3NDEKTSV4RRFFQ69G5FAW",
  supplierRef: "sup_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  providerSnapshotRef: "provider-snapshot-1",
};
const clock = {now: () => "2026-09-05T10:00:00.000Z"};
const hash = (value) => value.toString(16).padStart(64, "0");
const offer = (index, product = 0, variant = 0) => ({
  displayName: "Coffee " + index,
  unit: "piece",
  supplierUnitMinor: String(100 + index),
  currency: "RUB",
  availability: "Available",
  imageUrl: "https://images.example.test/" + index + ".jpg",
  supplierPromotions: [],
  product,
  variant,
});
const identity = (input, {supplierRef}) => ({
  supplierRef,
  sourceIdentityScheme: CATALOG_SOURCE_IDENTITY_SCHEME,
  sourceProductKeyHash: hash(input.product),
  sourceVariantKeyHash: hash(input.variant),
  sourceOfferKeyHash: hash(
    input.product * 1_000_000 +
      input.variant * 10_000 +
      Number(input.displayName.replace("Coffee ", "")),
  ),
  rawProviderProductId: "product-" + input.product,
  rawProviderVariantId: "variant-" + input.variant,
  rawProviderOfferId: "offer-" + input.displayName,
});
const forceGc = () => {
  if (typeof globalThis.gc !== "function")
    throw new Error("child process was not started with --expose-gc");
  globalThis.gc();
};

async function consumeExport(count, {measure = false} = {}) {
  let consumed = 0;
  let persistedOffers = 0;
  let maxUnpersisted = 0;
  let maxBatch = 0;
  let batches = 0;
  let chunks = 0;
  let completedRecords = 0;
  let peakHeapUsed = 0;
  const source = {
    async next() {
      if (consumed === count) return {done: true, value: undefined};
      consumed += 1;
      maxUnpersisted = Math.max(maxUnpersisted, consumed - persistedOffers);
      return {
        done: false,
        value: offer(consumed - 1, consumed % 20, consumed % 100),
      };
    },
    async return() {
      return {done: true, value: undefined};
    },
  };
  const stream = createCatalogExportStream({
    source,
    request,
    boundary: {
      identity,
      hash: sha256CatalogHash,
      persistence: {
        beginExport() {},
        recordBatch({record}) {
          batches += 1;
          maxBatch = Math.max(maxBatch, record.offerCount);
          persistedOffers += record.offerCount;
        },
        completeExport() {},
      },
    },
    clock,
    limits: {
      maxOffersPerBatch,
      maxTotalOffers: count,
      maxTotalBatches: 300,
    },
  });
  for await (const chunk of stream) {
    const line = Buffer.from(chunk).toString("utf8");
    chunks += 1;
    if (line.includes('"recordType":"snapshot-completed"'))
      completedRecords += 1;
    if (measure) {
      // Measure only after a full GC at each deterministic emitted-record boundary;
      // this tests retained heap, not scheduler-dependent transient samples.
      forceGc();
      peakHeapUsed = Math.max(peakHeapUsed, process.memoryUsage().heapUsed);
    }
  }
  return {
    completedRecords,
    consumed,
    chunks,
    batches,
    maxBatch,
    maxUnpersisted,
    peakHeapUsed,
  };
}

await consumeExport(16);
forceGc();
const baselineHeapUsed = process.memoryUsage().heapUsed;
const workload = await consumeExport(total, {measure: true});
forceGc();
const afterHeapUsed = process.memoryUsage().heapUsed;
if (workload.completedRecords !== 1 || workload.consumed !== total)
  throw new Error("100k catalog export did not complete exactly once");
process.stdout.write(JSON.stringify({
  afterHeapUsed,
  baselineHeapUsed,
  ...workload,
}));
`;

void test("100k production catalog export proves bounded retained heap in a child process", () => {
  const result = spawnSync(
    process.execPath,
    ["--expose-gc", "--input-type=module", "-e", catalogHeapProbe],
    {
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    },
  );
  assert.equal(
    result.status,
    0,
    `heap probe failed\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
  );
  const metrics = JSON.parse(result.stdout);
  const peakDelta = metrics.peakHeapUsed - metrics.baselineHeapUsed;
  const afterDelta = metrics.afterHeapUsed - metrics.baselineHeapUsed;
  // Warmed, forced-GC measurements observed ~26 MB peak and <1 MB after-run
  // retention here. 64 MiB peak and 16 MiB after-run budgets leave ample room
  // for V8 variance while staying below the ~76 MB peak/~50 MB retained heap
  // produced when all 202 output records are kept as strings.
  const peakBudgetBytes = 64 * 1024 * 1024;
  const afterBudgetBytes = 16 * 1024 * 1024;
  assert.ok(peakDelta > 0, JSON.stringify(metrics));
  assert.ok(
    peakDelta <= peakBudgetBytes,
    JSON.stringify({ metrics, peakDelta, peakBudgetBytes }),
  );
  assert.ok(
    afterDelta <= afterBudgetBytes,
    JSON.stringify({ metrics, afterDelta, afterBudgetBytes }),
  );
  assert.equal(metrics.batches, 200);
  assert.equal(metrics.maxBatch, 500);
  assert.equal(metrics.maxUnpersisted, 500);
  assert.equal(metrics.chunks, 202);
  assert.equal(metrics.completedRecords, 1);
  assert.equal(metrics.consumed, 100_000);
  process.stdout.write(
    `catalog heap probe: ${JSON.stringify({
      baselineHeapUsed: metrics.baselineHeapUsed,
      peakHeapUsed: metrics.peakHeapUsed,
      afterHeapUsed: metrics.afterHeapUsed,
      peakDelta,
      afterDelta,
      maxBatch: metrics.maxBatch,
      maxUnpersisted: metrics.maxUnpersisted,
    })}\n`,
  );
});

void test("consumer backpressure prevents source pulls while a batch is paused", async () => {
  let nextCalls = 0;
  let returned = false;
  const source = {
    async next() {
      nextCalls += 1;
      if (nextCalls > 3) return { done: true, value: undefined };
      return { done: false, value: offer(nextCalls - 1) };
    },
    async return() {
      returned = true;
      return { done: true, value: undefined };
    },
  };
  const stream = makeStream([], { source, limits: { maxOffersPerBatch: 2 } });
  const started = await stream.next();
  assert.equal(
    JSON.parse(Buffer.from(started.value).toString()).recordType,
    "snapshot-started",
  );
  assert.equal(nextCalls, 0);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(nextCalls, 0);
  const batch = await stream.next();
  assert.equal(
    JSON.parse(Buffer.from(batch.value).toString()).recordType,
    "snapshot-batch",
  );
  assert.equal(nextCalls, 2);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(nextCalls, 2);
  const secondBatch = await stream.next();
  const firstBatchRecord = JSON.parse(Buffer.from(batch.value).toString());
  const secondBatchRecord = JSON.parse(
    Buffer.from(secondBatch.value).toString(),
  );
  assert.equal(firstBatchRecord.recordType, "snapshot-batch");
  assert.equal(secondBatchRecord.recordType, "snapshot-batch");
  assert.equal(secondBatchRecord.batchNumber, 1);
  assert.equal(secondBatchRecord.previousBatchHash, firstBatchRecord.batchHash);
  assert.equal(nextCalls, 4);
  await stream.return();
  assert.equal(returned, true);
});

void test("external cancellation propagates and closes the injected iterator", async () => {
  const controller = new AbortController();
  let nextStarted = false;
  let returned = false;
  const source = {
    async next() {
      nextStarted = true;
      return new Promise(() => {});
    },
    async return() {
      returned = true;
      return { done: true, value: undefined };
    },
  };
  const stream = makeStream([], { source, signal: controller.signal });
  await stream.next();
  const pending = stream.next();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(nextStarted, true);
  controller.abort();
  await assert.rejects(pending, (error) => error.name === "AbortError");
  assert.equal(returned, true);
});

void test("completed terminal remains one-shot while the consumer pauses before next", async () => {
  const stream = makeStream([], { limits: { idleTimeoutMs: 10 } });
  const started = await stream.next();
  const completed = await stream.next();
  assert.equal(
    JSON.parse(Buffer.from(started.value).toString()).recordType,
    "snapshot-started",
  );
  assert.equal(
    JSON.parse(Buffer.from(completed.value).toString()).recordType,
    "snapshot-completed",
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  const done = await stream.next();
  assert.equal(done.done, true);
  await stream.return();
});

void test("oversized item/batch fails after start and never completes", async () => {
  const records = parse(
    await collect(
      makeStream([offer(0)], {
        limits: { maxItemBytes: 64, maxBatchBytes: 128 },
      }),
    ),
  );
  assert.deepEqual(
    records.map((record) => record.recordType),
    ["snapshot-started", "snapshot-failed"],
  );
  assert.equal(records[1].code, "INVALID_STREAM");
});

void test("total offer and idle limits fail closed", async () => {
  const totalLimited = parse(
    await collect(
      makeStream([offer(0), offer(1)], {
        limits: { maxTotalOffers: 1, maxOffersPerBatch: 1 },
      }),
    ),
  );
  assert.deepEqual(
    totalLimited.map((record) => record.recordType),
    ["snapshot-started", "snapshot-batch", "snapshot-failed"],
  );
  assert.equal(totalLimited.at(-1).code, "INVALID_STREAM");

  let returned = false;
  const idleSource = {
    async next() {
      return await new Promise(() => {});
    },
    async return() {
      returned = true;
      return { done: true, value: undefined };
    },
  };
  const idleRecords = parse(
    await collect(
      makeStream([], {
        source: idleSource,
        limits: { idleTimeoutMs: 10 },
      }),
    ),
  );
  assert.deepEqual(
    idleRecords.map((record) => record.recordType),
    ["snapshot-started", "snapshot-failed"],
  );
  assert.equal(idleRecords.at(-1).code, "PROVIDER_TIMEOUT");
  assert.equal(returned, true);

  let totalSignal;
  let totalSourceClosed = false;
  let totalCompleteCalls = 0;
  const totalTimeoutRecords = parse(
    await collect(
      makeStream([], {
        source: {
          async next() {
            return await new Promise(() => {});
          },
          async return() {
            totalSourceClosed = true;
            return { done: true, value: undefined };
          },
        },
        limits: { totalTimeoutMs: 25, idleTimeoutMs: 1_000 },
        boundary: boundary({
          persistence: {
            beginExport: (_record, signal) => {
              totalSignal = signal;
            },
            completeExport: () => {
              totalCompleteCalls += 1;
            },
          },
        }),
      }),
    ),
  );
  assert.deepEqual(
    totalTimeoutRecords.map((record) => record.recordType),
    ["snapshot-started", "snapshot-failed"],
  );
  assert.equal(totalTimeoutRecords.at(-1).code, "PROVIDER_TIMEOUT");
  assert.equal(
    totalSignal?.reason?.message,
    "catalog export total deadline exceeded",
  );
  assert.equal(totalSignal?.aborted, true);
  assert.equal(totalSourceClosed, true);
  assert.equal(totalCompleteCalls, 0);
});

void test("hash mismatch fails closed without a completed terminal record", async () => {
  const records = parse(
    await collect(
      makeStream([offer(0)], {
        boundary: boundary({ hashResolver: () => "0".repeat(64) }),
      }),
    ),
  );
  assert.deepEqual(
    records.map((record) => record.recordType),
    ["snapshot-started", "snapshot-failed"],
  );
  assert.equal(records[1].code, "BATCH_HASH_CONFLICT");
});

void test("persistence count acknowledgement mismatch fails closed", async () => {
  const events = [];
  const records = parse(
    await collect(
      makeStream([offer(0)], {
        boundary: boundary({
          persistence: {
            recordBatch: ({ record }) => ({
              offerCount: record.offerCount + 1,
            }),
            failExport: ({ record }) => events.push(record.code),
          },
        }),
      }),
    ),
  );
  assert.deepEqual(
    records.map((record) => record.recordType),
    ["snapshot-started", "snapshot-failed"],
  );
  assert.equal(records[1].code, "INVALID_STREAM");
  assert.deepEqual(events, ["INVALID_STREAM"]);

  const persistenceFailures = [];
  const rejectedBatch = parse(
    await collect(
      makeStream([offer(0)], {
        boundary: boundary({
          persistence: {
            recordBatch: () => {
              throw new Error("database endpoint secret must not escape");
            },
            failExport: ({ record, errorCode }) => {
              persistenceFailures.push([record.code, errorCode]);
            },
          },
        }),
      }),
    ),
  );
  assert.deepEqual(
    rejectedBatch.map((record) => record.recordType),
    ["snapshot-started", "snapshot-failed"],
  );
  assert.equal(rejectedBatch.at(-1).code, "INVALID_STREAM");
  assert.doesNotMatch(
    JSON.stringify(rejectedBatch),
    /database endpoint secret/,
  );
  assert.deepEqual(persistenceFailures, [["INVALID_STREAM", "INVALID_STREAM"]]);
});

void test("completed persistence is not called when terminal timestamp resolution fails", async () => {
  let clockCalls = 0;
  let completeCalls = 0;
  const failures = [];
  const records = parse(
    await collect(
      makeStream([offer(0)], {
        clock: {
          now: () => {
            clockCalls += 1;
            if (clockCalls === 2) throw new Error("clock unavailable");
            return "2026-09-05T10:00:00.000Z";
          },
        },
        boundary: boundary({
          persistence: {
            completeExport: () => {
              completeCalls += 1;
            },
            failExport: ({ record }) => {
              failures.push(record.code);
            },
          },
        }),
      }),
    ),
  );
  assert.deepEqual(
    records.map((record) => record.recordType),
    ["snapshot-started", "snapshot-batch", "snapshot-failed"],
  );
  assert.equal(records.at(-1).code, "PROVIDER_UNAVAILABLE");
  assert.equal(completeCalls, 0);
  assert.deepEqual(failures, ["PROVIDER_UNAVAILABLE"]);
});

void test("product and variant hash collisions with different raw IDs fail closed", async () => {
  for (const [field, rawField] of [
    ["sourceProductKeyHash", "rawProviderProductId"],
    ["sourceVariantKeyHash", "rawProviderVariantId"],
  ]) {
    let index = 0;
    const identity = (input, { supplierRef }) => ({
      ...identityFor(input, { supplierRef }),
      [field]: "f".repeat(64),
      [rawField]: `different-${index++}`,
    });
    const records = parse(
      await collect(
        makeStream([offer(0), offer(1)], {
          boundary: boundary({ identity }),
        }),
      ),
    );
    assert.deepEqual(
      records.map((record) => record.recordType),
      ["snapshot-started", "snapshot-failed"],
    );
    assert.equal(records.at(-1).code, "SOURCE_IDENTITY_COLLISION");
  }
});

void test("malformed Unicode identity fails before batch persistence in every entity domain", async () => {
  for (const field of [
    "rawProviderProductId",
    "rawProviderVariantId",
    "rawProviderOfferId",
  ]) {
    for (const rawId of ["id-\ud800", "\udc00", "\ud800x", "id-😀", "id-�"]) {
      let persisted = 0;
      const records = parse(
        await collect(
          makeStream([offer(0)], {
            boundary: boundary({
              identity: (input, context) => ({
                ...identityFor(input, context),
                [field]: rawId,
              }),
              persistence: {
                recordBatch: () => {
                  persisted += 1;
                },
              },
            }),
          }),
        ),
      );
      if (rawId === "id-😀" || rawId === "id-�") {
        assert.equal(records.at(-1).recordType, "snapshot-completed", field);
        assert.equal(persisted, 1, field);
      } else {
        assert.deepEqual(
          records.map((record) => record.recordType),
          ["snapshot-started", "snapshot-failed"],
          field,
        );
        assert.equal(records.at(-1).code, "SOURCE_IDENTITY_COLLISION", field);
        assert.equal(persisted, 0, field);
      }
    }
  }
});

void test("offer raw identity IDs mapping to different hashes fail closed", async () => {
  let identityCalls = 0;
  const identity = (input, { supplierRef }) => ({
    ...identityFor(input, { supplierRef }),
    sourceOfferKeyHash: hash(10 + identityCalls++),
    rawProviderOfferId: "same-offer",
  });
  const records = parse(
    await collect(
      makeStream([offer(0), offer(1)], {
        boundary: boundary({ identity }),
      }),
    ),
  );
  assert.deepEqual(
    records.map((record) => record.recordType),
    ["snapshot-started", "snapshot-failed"],
  );
  assert.equal(records.at(-1).code, "SOURCE_IDENTITY_COLLISION");
});

void test("source identity raw ID collisions remain rejected across flushed batches", async () => {
  for (const [entityType, hashField, rawField] of [
    ["product", "sourceProductKeyHash", "rawProviderProductId"],
    ["variant", "sourceVariantKeyHash", "rawProviderVariantId"],
    ["offer", "sourceOfferKeyHash", "rawProviderOfferId"],
  ]) {
    let identityCalls = 0;
    const identity = (input, { supplierRef }) => ({
      ...identityFor(input, { supplierRef }),
      [hashField]: hash(100 + identityCalls++),
      [rawField]: `same-${entityType}`,
    });
    const records = parse(
      await collect(
        makeStream([offer(0), offer(1)], {
          boundary: boundary({ identity }),
          limits: { maxOffersPerBatch: 1 },
        }),
      ),
    );
    assert.deepEqual(
      records.map((record) => record.recordType),
      ["snapshot-started", "snapshot-batch", "snapshot-failed"],
    );
    assert.equal(records[1].batchNumber, 0);
    assert.equal(records.at(-1).code, "SOURCE_IDENTITY_COLLISION");
  }
});

void test("empty source completes with zero counts and a hash of empty batch-hash bytes", async () => {
  const complete = [];
  const records = parse(
    await collect(
      makeStream([], {
        boundary: boundary({
          persistence: {
            completeExport: (summary) => {
              complete.push(summary);
            },
          },
        }),
      }),
    ),
  );
  assert.deepEqual(
    records.map((record) => record.recordType),
    ["snapshot-started", "snapshot-completed"],
  );
  assert.equal(records[1].batchCount, 0);
  assert.equal(records[1].productCount, 0);
  assert.equal(records[1].variantCount, 0);
  assert.equal(records[1].offerCount, 0);
  assert.equal(
    records[1].contentHash,
    createHash("sha256").update(Buffer.alloc(0)).digest("hex"),
  );
  assert.equal(complete.length, 1);
});

void test("partial source emits a failed terminal record after any committed batch", async () => {
  const source = {
    calls: 0,
    async next() {
      this.calls += 1;
      if (this.calls === 1) return { done: false, value: offer(0) };
      throw new Error("provider body secret must not escape");
    },
    async return() {
      return { done: true, value: undefined };
    },
  };
  const records = parse(
    await collect(
      makeStream([], {
        source,
        limits: { maxOffersPerBatch: 1 },
      }),
    ),
  );
  assert.deepEqual(
    records.map((record) => record.recordType),
    ["snapshot-started", "snapshot-batch", "snapshot-failed"],
  );
  assert.equal(records.at(-1).code, "PROVIDER_UNAVAILABLE");
  assert.doesNotMatch(JSON.stringify(records), /provider body secret/);
});

void test("terminal completed waits for iterator cleanup and persistence completion", async () => {
  const events = [];
  const source = {
    async next() {
      if (events.includes("source-next"))
        return { done: true, value: undefined };
      events.push("source-next");
      return { done: false, value: offer(0) };
    },
    async return() {
      events.push("source-return");
      return { done: true, value: undefined };
    },
  };
  const records = parse(
    await collect(
      makeStream([], {
        source,
        boundary: boundary({
          persistence: {
            recordBatch: () => {
              events.push("batch");
            },
            completeExport: () => {
              assert.equal(events.includes("source-return"), true);
              events.push("complete");
            },
          },
        }),
      }),
    ),
  );
  assert.equal(records.at(-1).recordType, "snapshot-completed");
  assert.deepEqual(events, [
    "source-next",
    "source-return",
    "batch",
    "complete",
  ]);
});

void test("source identity raw IDs stay in Integration persistence and never in NDJSON", async () => {
  const integration = [];
  const records = parse(
    await collect(
      makeStream([offer(0)], {
        boundary: boundary({
          persistence: {
            recordBatch: ({ identities }) => {
              integration.push(identities[0]);
            },
          },
        }),
      }),
    ),
  );
  assert.equal(integration[0].rawProviderOfferId, "offer-Coffee 0");
  assert.equal(Object.hasOwn(records[1].items[0], "rawProviderOfferId"), false);
  assert.equal(Object.hasOwn(records[1].items[0], "supplierRef"), false);
});

void test("production core requires an explicit source and has no synthetic fallback", () => {
  assert.throws(
    () =>
      createCatalogExportStream({
        request,
        boundary: boundary(),
        clock,
      }),
    (error) =>
      error instanceof CatalogExportError && error.code === "INVALID_STREAM",
  );
});

void test("live catalog export propagates paused downstream backpressure to provider pages", async (t) => {
  const credentials = {
    scopeRef: "aroma-primary",
    email: "canonical@example.test",
    password: "test-only",
  };
  const sourceIdentityKey = Buffer.from("identity-key");
  const providerOrigin = "https://provider.test";
  const providerCalls = [];
  const pageBodyPulls = { 1: 0, 2: 0 };
  const pageBodyDone = { 1: false, 2: false };
  const persistenceCalls = [];
  let sourceFactoryCalls = 0;
  const nativeFetch = globalThis.fetch.bind(globalThis);
  const largeImageUrl = `https://images.example.test/${"x".repeat(2_000)}`;
  let releasePage1Body = () => {};
  const page1MayFinish = new Promise((resolve) => {
    releasePage1Body = resolve;
  });
  let releaseDisconnectPage = () => {};
  const disconnectPageMayFinish = new Promise((resolve) => {
    releaseDisconnectPage = resolve;
  });
  let disconnectPageStarted = false;
  let pageOneResponses = 0;
  let disconnectPageBodyDone = false;
  let disconnectPageSignal;
  let sourceIteratorClosures = 0;
  async function waitFor(predicate, message) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    assert.fail(message);
  }

  function liveProviderPage(pageNumber) {
    const offerCount = pageNumber === 1 ? 5_000 : 1;
    return {
      data: [
        {
          id: pageNumber,
          name: `Coffee page ${pageNumber}`,
          discount: [],
          offers: Array.from({ length: offerCount }, (_, index) => ({
            id: String(pageNumber * 10_000 + index + 1),
            name: `Coffee ${pageNumber}-${index}`,
            vendor_code: `C-${pageNumber}-${index}`,
            price: 10,
            params: [],
          })),
        },
      ],
      links: { first: null, last: null, prev: null, next: null },
      meta: {
        current_page: pageNumber,
        from: 1,
        to: offerCount,
        last_page: 2,
        per_page: 1,
        total: 2,
      },
    };
  }

  function providerPageResponse(pageNumber) {
    const bytes = new TextEncoder().encode(
      JSON.stringify(liveProviderPage(pageNumber)),
    );
    let sent = false;
    const body = new ReadableStream({
      async pull(controller) {
        pageBodyPulls[pageNumber] += 1;
        if (sent) {
          controller.close();
          pageBodyDone[pageNumber] = true;
          return;
        }
        sent = true;
        controller.enqueue(bytes);
        if (pageNumber === 1 && pageOneResponses === 1) await page1MayFinish;
        if (pageNumber === 1 && pageOneResponses === 2) {
          disconnectPageStarted = true;
          await disconnectPageMayFinish;
          disconnectPageBodyDone = !disconnectPageSignal?.aborted;
        }
        controller.close();
        pageBodyDone[pageNumber] = true;
      },
    });
    return new Response(body, {
      headers: { "content-type": "application/json" },
    });
  }

  t.mock.method(globalThis, "fetch", async (url, init) => {
    const href = String(url);
    if (!href.startsWith(providerOrigin)) return nativeFetch(url, init);
    providerCalls.push({ url: href, init });
    if (href.endsWith("/api/v1/auth/login")) {
      return new Response(
        JSON.stringify({
          data: { email: credentials.email, wholesale: true, retail: false },
        }),
        {
          headers: {
            "content-type": "application/json",
            "set-cookie":
              "october_session=provider-session; Domain=provider.test; Path=/; HttpOnly",
          },
        },
      );
    }
    const pageNumber = Number(new URL(href).searchParams.get("page"));
    if (pageNumber === 1 && ++pageOneResponses === 2) {
      disconnectPageSignal = init.signal;
      init.signal.addEventListener("abort", releaseDisconnectPage, {
        once: true,
      });
    }
    return providerPageResponse(pageNumber);
  });

  const client = new ProviderHttpClient({
    origin: providerOrigin,
    timeoutMs: 2_000,
    maxResponseBytes: 4 * 1024 * 1024,
    connections: 1,
  });
  const manager = new ProviderSessionManager({
    transport: client,
    store: new MemoryProviderSessionStore(),
    encryptionKey: Buffer.alloc(32, 8),
  });
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicPem = publicKey
    .export({ type: "spki", format: "pem" })
    .toString();
  const routeContext = {
    secrets: {
      security: {
        delegationVerificationKeys: {
          "api-internal": { active: publicPem, previous: publicPem },
        },
      },
    },
  };
  const app = await createRuntime({
    name: "aroma-catalog-backpressure-test",
    host: "127.0.0.1",
    port: 0,
    shutdownGraceMs: 1_000,
    deadlineMs: 10_000,
    deadlineProfiles: { readMs: 10_000 },
  });
  app.addHook("preHandler", async (incoming) => {
    incoming.runtimeContext.transportIdentity = {
      runtime: "api-internal",
      environment: "test",
      san: "spiffe://test/api-internal",
    };
  });
  registerAromaCatalogExportRoute(
    app,
    (_supplierRef, signal) => {
      sourceFactoryCalls += 1;
      const source = createProviderCatalogSource({
        sessions: manager,
        credentials,
        sourceIdentityKey,
        pageSize: 1,
        signal,
        normalize: (product, providerOffer) => ({
          displayName: providerOffer.name,
          unit: "piece",
          supplierUnitMinor: "1000",
          currency: "RUB",
          availability: "Available",
          imageUrl: largeImageUrl,
          supplierPromotions: [],
          providerIdentity: {
            rawProviderProductId: product.productId,
            rawProviderVariantId: providerOffer.offerId,
            rawProviderOfferId: providerOffer.offerId,
            packing: null,
            grindId: null,
          },
        }),
      });
      return (async function* () {
        try {
          yield* source;
        } finally {
          sourceIteratorClosures++;
        }
      })();
    },
    boundary({
      identity: (value) =>
        sourceIdentityForOffer(value, request.supplierRef, sourceIdentityKey),
      persistence: {
        beginExport: () => {
          persistenceCalls.push("begin");
        },
        recordBatch: () => {
          persistenceCalls.push("batch");
        },
        completeExport: () => {
          persistenceCalls.push("complete");
        },
        abortExport: (snapshotRef, signal) => {
          persistenceCalls.push(["abort", snapshotRef, signal.aborted]);
        },
      },
    }),
    routeContext,
    request.supplierRef,
  );

  let reader;
  const disconnectController = new AbortController();
  try {
    await app.runtimeController.start();
    const address = app.server.address();
    assert.ok(address && typeof address === "object");
    const now = Math.floor(Date.now() / 1_000);
    const signCatalogDelegation = (
      originalCaller,
      operationId,
      correlationId,
    ) =>
      signServiceDelegation(
        {
          iss: "api-internal",
          aud: "aroma-gateway",
          originalCaller,
          operationId,
          correlationId,
          traceparent:
            "00-00000000000000000000000000000000-0000000000000000-01",
          iat: now,
          exp: now + 60,
          jti: randomUUID(),
          kid: "catalog-backpressure-test",
        },
        privateKey,
      );
    const delegation = signCatalogDelegation(
      "catalog-supplier-sync",
      "exportAromaCatalog",
      "corr_catalog_backpressure",
    );
    const invalidCorrelation = "00000000-0000-4000-8000-000000000042";
    const routeUrl = `http://127.0.0.1:${address.port}/api/internal-v1/aroma/catalog-exports`;
    const postExport = (token, supplierRef = request.supplierRef) =>
      nativeFetch(routeUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-service-delegation": token,
        },
        body: JSON.stringify({
          snapshotRef: request.snapshotRef,
          supplierRef,
        }),
      });

    const invalidBodies = [
      '{"privateProof":"CATALOG_BODY_CANARY"',
      JSON.stringify({
        snapshotRef: request.snapshotRef,
        supplierRef: request.supplierRef,
      }) + " ".repeat(64 * 1024),
    ];
    for (const body of invalidBodies) {
      const invalid = await nativeFetch(routeUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-correlation-id": invalidCorrelation,
          "x-service-delegation": delegation,
        },
        body,
      });
      assert.equal(invalid.status, 400);
      assert.equal(invalid.headers.get("cache-control"), "no-store");
      assert.equal(
        invalid.headers.get("content-type"),
        "application/problem+json; charset=utf-8",
      );
      assert.equal(invalid.headers.get("x-correlation-id"), invalidCorrelation);
      assert.deepEqual(await invalid.json(), {
        type: "about:blank",
        title: "VALIDATION_FAILED",
        status: 400,
        code: "VALIDATION_FAILED",
        detail: "Request validation failed",
        instance: "/api/internal-v1/aroma/catalog-exports",
        correlationId: invalidCorrelation,
        errors: [],
      });
      assert.equal(sourceFactoryCalls, 0);
      assert.deepEqual(persistenceCalls, []);
    }

    for (const [caller, operation] of [
      ["aroma-convergence", "exportAromaCatalog"],
      ["catalog-supplier-sync", "readAromaCartSnapshot"],
    ]) {
      const rejected = await postExport(
        signCatalogDelegation(caller, operation, `corr_rejected_${operation}`),
      );
      assert.equal(rejected.status, 403);
    }
    const wrongSupplier = await postExport(
      delegation,
      "sup_01ARZ3NDEKTSV4RRFFQ69G5FAX",
    );
    assert.equal(wrongSupplier.status, 400);
    assert.equal(sourceFactoryCalls, 0);
    assert.deepEqual(persistenceCalls, []);

    const response = await nativeFetch(routeUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-service-delegation": delegation,
      },
      body: JSON.stringify({
        snapshotRef: request.snapshotRef,
        supplierRef: request.supplierRef,
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/x-ndjson");
    assert.ok(response.body);
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let wire = "";
    while (!wire.includes("\n")) {
      const chunk = await reader.read();
      assert.equal(
        chunk.done,
        false,
        "catalog export ended before snapshot-started",
      );
      wire += decoder.decode(chunk.value, { stream: true });
    }
    assert.equal(
      JSON.parse(wire.slice(0, wire.indexOf("\n"))).recordType,
      "snapshot-started",
    );

    await waitFor(
      () => pageBodyPulls[1] > 0,
      "page 1 provider body was not pulled",
    );
    assert.equal(
      pageBodyDone[1],
      false,
      "the current source must collect the whole page before yielding its offer",
    );
    assert.equal(
      providerCalls.filter(
        (call) => new URL(call.url).searchParams.get("page") === "2",
      ).length,
      0,
      "paused downstream must not request page 2",
    );
    assert.equal(
      pageBodyPulls[2],
      0,
      "paused downstream must not pull page 2's provider body",
    );

    releasePage1Body();
    await waitFor(() => pageBodyDone[1], "page 1 provider body did not finish");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      providerCalls.filter(
        (call) => new URL(call.url).searchParams.get("page") === "2",
      ).length,
      0,
      "paused downstream must not request page 2 after page 1 collection",
    );
    assert.equal(
      pageBodyPulls[2],
      0,
      "paused downstream must not pull page 2's provider body after page 1 collection",
    );

    for (
      let chunk = await reader.read();
      !chunk.done;
      chunk = await reader.read()
    )
      wire += decoder.decode(chunk.value, { stream: true });
    wire += decoder.decode();
    const records = parse(
      wire
        .split("\n")
        .filter(Boolean)
        .map((line) => `${line}\n`),
    );
    assert.equal(records[0].recordType, "snapshot-started");
    assert.equal(records.at(-1).recordType, "snapshot-completed");
    assert.equal(
      records
        .slice(1, -1)
        .every((record) => record.recordType === "snapshot-batch"),
      true,
    );
    assert.equal(
      records
        .slice(1, -1)
        .reduce((total, record) => total + record.offerCount, 0),
      5_001,
    );
    assert.equal(records.at(-2).offerCount, 1);
    assert.equal(pageBodyDone[2], true);
    assert.ok(
      pageBodyPulls[2] > 0,
      "resuming downstream must pull page 2's provider body",
    );
    assert.deepEqual(
      providerCalls
        .filter((call) => new URL(call.url).searchParams.has("page"))
        .map((call) => new URL(call.url).searchParams.get("page")),
      ["1", "2"],
    );
    assert.equal(sourceIteratorClosures, 1);
    assert.equal(
      persistenceCalls.filter((call) => call === "complete").length,
      1,
    );

    const secondSnapshotRef = "snp_01ARZ3NDEKTSV4RRFFQ69G5FAX";
    const interruptedResponse = await nativeFetch(
      `http://127.0.0.1:${address.port}/api/internal-v1/aroma/catalog-exports`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-service-delegation": delegation,
        },
        body: JSON.stringify({
          snapshotRef: secondSnapshotRef,
          supplierRef: request.supplierRef,
        }),
        signal: disconnectController.signal,
      },
    );
    assert.equal(interruptedResponse.status, 200);
    assert.ok(interruptedResponse.body);
    reader = interruptedResponse.body.getReader();
    const startedLine = await reader.read();
    assert.equal(startedLine.done, false);
    assert.equal(
      JSON.parse(new TextDecoder().decode(startedLine.value)).recordType,
      "snapshot-started",
    );
    await waitFor(
      () => disconnectPageStarted,
      "provider page did not remain pending before the client disconnect",
    );
    assert.equal(disconnectPageBodyDone, false);
    assert.equal(disconnectPageSignal?.aborted, false);
    const batchesBeforeDisconnect = persistenceCalls.filter(
      (call) => call === "batch",
    ).length;

    disconnectController.abort(new Error("test client disconnected"));
    await reader.cancel().catch(() => {});
    await waitFor(
      () => disconnectPageSignal?.aborted === true,
      "HTTP disconnect did not abort the provider page request",
    );
    await waitFor(
      () => sourceIteratorClosures === 2,
      "HTTP disconnect did not close the provider source iterator",
    );
    await waitFor(
      () =>
        persistenceCalls.some(
          (call) => Array.isArray(call) && call[0] === "abort",
        ),
      "HTTP disconnect did not abort durable export state",
    );
    assert.equal(disconnectPageSignal?.aborted, true);
    assert.equal(
      disconnectPageSignal?.reason?.code,
      "RUNTIME_CLIENT_DISCONNECTED",
    );
    assert.equal(disconnectPageBodyDone, false);
    assert.equal(
      persistenceCalls.filter((call) => call === "complete").length,
      1,
    );
    assert.equal(
      persistenceCalls.filter((call) => call === "batch").length,
      batchesBeforeDisconnect,
    );
    assert.deepEqual(
      persistenceCalls.filter(
        (call) => Array.isArray(call) && call[0] === "abort",
      ),
      [["abort", secondSnapshotRef, false]],
    );
  } finally {
    releasePage1Body();
    disconnectController.abort(new Error("test cleanup"));
    releaseDisconnectPage();
    await reader?.cancel().catch(() => {});
    await app.runtimeController.closeRuntime("test");
    await manager.close();
  }
});

void test("catalog export rejects invalid source facts and identity without persisting a batch", async () => {
  const cases = [
    { item: { ...offer(0), displayName: "" }, code: "INVALID_STREAM" },
    { item: { ...offer(0), availability: "Unknown" }, code: "INVALID_STREAM" },
    { item: { ...offer(0), imageUrl: "not a URL" }, code: "INVALID_STREAM" },
    {
      item: {
        ...offer(0),
        supplierPromotions: [{ discountBasisPoints: 10001 }],
      },
      code: "INVALID_STREAM",
    },
    { item: { ...offer(0), grindOptions: [] }, code: "INVALID_STREAM" },
    {
      identity: (item, context) => ({
        ...identityFor(item, context),
        supplierRef: "wrong-supplier",
      }),
      code: "SOURCE_IDENTITY_COLLISION",
    },
    {
      identity: () => {
        throw new Error("identity-secret");
      },
      code: "SOURCE_IDENTITY_COLLISION",
    },
    {
      hashResolver: () => {
        throw new Error("hash-secret");
      },
      code: "BATCH_HASH_CONFLICT",
    },
  ];
  for (const entry of cases) {
    let batches = 0;
    let completed = 0;
    const records = parse(
      await collect(
        makeStream([entry.item ?? offer(0)], {
          boundary: boundary({
            identity: entry.identity,
            hashResolver: entry.hashResolver,
            persistence: {
              recordBatch: () => {
                batches += 1;
              },
              completeExport: () => {
                completed += 1;
              },
            },
          }),
        }),
      ),
    );
    assert.deepEqual(
      records.map((record) => record.recordType),
      ["snapshot-started", "snapshot-failed"],
    );
    assert.equal(records.at(-1).code, entry.code);
    assert.equal(batches, 0);
    assert.equal(completed, 0);
    assert.doesNotMatch(JSON.stringify(records), /identity-secret|hash-secret/);
  }
});

void test("catalog export fails closed on inconsistent persistence acknowledgements", async () => {
  const cases = [
    {
      stage: "batch",
      ack: { batchHash: "0".repeat(64) },
      code: "BATCH_HASH_CONFLICT",
    },
    { stage: "batch", ack: { uncompressedBytes: 0 }, code: "INVALID_STREAM" },
    { stage: "complete", ack: null, code: "INVALID_STREAM" },
    ...["batchCount", "productCount", "variantCount", "offerCount"].map(
      (field) => ({
        stage: "complete",
        ack: { [field]: 999 },
        code: "INVALID_STREAM",
      }),
    ),
    {
      stage: "complete",
      ack: { contentHash: "0".repeat(64) },
      code: "BATCH_HASH_CONFLICT",
    },
    { stage: "complete", error: true, code: "INVALID_STREAM" },
  ];
  for (const entry of cases) {
    const failures = [];
    const acknowledge = () => {
      if (entry.error) throw new Error("persistence-secret");
      return entry.ack;
    };
    const records = parse(
      await collect(
        makeStream([offer(0)], {
          boundary: boundary({
            persistence: {
              recordBatch: entry.stage === "batch" ? acknowledge : () => {},
              completeExport:
                entry.stage === "complete"
                  ? acknowledge
                  : () => {
                      throw new Error("unexpected completion");
                    },
              failExport: ({ errorCode }) => {
                failures.push(errorCode);
                throw new Error("failure-secret");
              },
            },
          }),
        }),
      ),
    );
    assert.deepEqual(
      records.map((record) => record.recordType),
      entry.stage === "batch"
        ? ["snapshot-started", "snapshot-failed"]
        : ["snapshot-started", "snapshot-batch", "snapshot-failed"],
    );
    assert.equal(records.at(-1).code, entry.code);
    assert.deepEqual(failures, [entry.code]);
    assert.doesNotMatch(
      JSON.stringify(records),
      /persistence-secret|failure-secret/,
    );
  }
});

void test("catalog export validates request and resource limits before starting persistence", () => {
  let begins = 0;
  const exportBoundary = boundary({
    persistence: {
      beginExport: () => {
        begins += 1;
      },
    },
  });
  const base = {
    source: sourceFrom([]),
    request,
    boundary: exportBoundary,
    clock,
  };
  for (const options of [
    { request: { ...request, supplierRef: "invalid" } },
    { request: { ...request, providerSnapshotRef: "" } },
    { limits: { maxItemBytes: 0 } },
    { limits: { maxTotalOffers: -1 } },
    { limits: { maxOffersPerBatch: 1_000_000 } },
    { limits: { maxBatchBytes: 1_000_000_000 } },
  ]) {
    assert.throws(() => createCatalogExportStream({ ...base, ...options }), {
      code: "INVALID_STREAM",
    });
  }
  assert.equal(begins, 0);
});
