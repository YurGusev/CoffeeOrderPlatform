import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  CATALOG_SOURCE_IDENTITY_SCHEME,
  CatalogExportError,
  canonicalCatalogJson,
  createCatalogExportStream,
  sha256CatalogHash,
} from "../../apps/aroma-gateway/dist/application/catalog-export.js";

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
  product,
  variant,
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

void test("100k offers consume in bounded batches without whole-catalog buffering", async () => {
  const total = 100_000;
  let consumed = 0;
  let persistedOffers = 0;
  let maxUnpersisted = 0;
  let returned = false;
  const source = {
    async next() {
      if (consumed === total) return { done: true, value: undefined };
      consumed += 1;
      maxUnpersisted = Math.max(maxUnpersisted, consumed - persistedOffers);
      return {
        done: false,
        value: offer(consumed - 1, consumed % 20, consumed % 100),
      };
    },
    async return() {
      returned = true;
      return { done: true, value: undefined };
    },
  };
  let batches = 0;
  const lines = await collect(
    makeStream([], {
      source,
      limits: { maxTotalOffers: total, maxTotalBatches: 300 },
      boundary: boundary({
        persistence: {
          recordBatch: ({ record }) => {
            batches += 1;
            persistedOffers += record.offerCount;
          },
        },
      }),
    }),
  );
  assert.equal(consumed, total);
  assert.equal(batches, 200);
  assert.equal(maxUnpersisted <= 500, true);
  assert.equal(returned, true);
  assert.equal(parse(lines).at(-1).recordType, "snapshot-completed");
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
  const stream = makeStream([], {limits: {idleTimeoutMs: 10}});
  const started = await stream.next();
  const completed = await stream.next();
  assert.equal(JSON.parse(Buffer.from(started.value).toString()).recordType, "snapshot-started");
  assert.equal(JSON.parse(Buffer.from(completed.value).toString()).recordType, "snapshot-completed");
  await new Promise(resolve => setTimeout(resolve, 30));
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
  assert.deepEqual(records.map((record) => record.recordType), ["snapshot-started", "snapshot-batch", "snapshot-failed"]);
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
  for (const field of ["rawProviderProductId", "rawProviderVariantId", "rawProviderOfferId"]) {
    for (const rawId of ["id-\ud800", "\udc00", "\ud800x", "id-😀", "id-�"]) {
      let persisted = 0;
      const records = parse(await collect(makeStream([offer(0)], {
        boundary: boundary({
          identity: (input, context) => ({...identityFor(input, context), [field]: rawId}),
          persistence: {recordBatch: () => { persisted += 1; }},
        }),
      })));
      if (rawId === "id-😀" || rawId === "id-�") {
        assert.equal(records.at(-1).recordType, "snapshot-completed", field);
        assert.equal(persisted, 1, field);
      } else {
        assert.deepEqual(records.map((record) => record.recordType), ["snapshot-started", "snapshot-failed"], field);
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
