import assert from "node:assert/strict";
import {Readable} from "node:stream";
import {setTimeout as delay} from "node:timers/promises";
import {createHash} from "node:crypto";
import {readNdjson} from "../../apps/catalog-supplier-sync/dist/ndjson-reader.js";
import {runCatalogImport} from "../../apps/catalog-supplier-sync/dist/run-catalog-import.js";
import {catalogBatchBytes, catalogBatchHash, createCatalogContentHash} from "../../packages/contracts/aroma-v1/dist/index.js";

const snapshotRef = "snp_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const supplierRef = "sup_00000000000000000000000001";
const offers = 100_000;
const batchSize = 500;
const batches = offers / batchSize;
const maxBatchBytes = 2 * 1024 * 1024;
let produced = 0;
let persisted = 0;
let bytesOnWire = 0;
let peakRss = 0;
let peakHeap = 0;
let maxObservedBatchBytes = 0;
let previousHash = null;
let releaseFirst;
let firstEntered;
const entered = new Promise(resolve => {firstEntered = resolve;});
const firstGate = new Promise(resolve => {releaseFirst = resolve;});
const contentHash = createCatalogContentHash();
const wireHash = createHash("sha256");

function sample() {
  const memory = process.memoryUsage();
  peakRss = Math.max(peakRss, memory.rss);
  peakHeap = Math.max(peakHeap, memory.heapUsed);
}
function item(index) {
  const key = index.toString(16).padStart(64, "0");
  return {sourceProductKeyHash:key, sourceVariantKeyHash:key, sourceOfferKeyHash:key,
    displayName:`Детерминированный кофе ${index}`, unit:"piece", supplierUnitMinor:"123", currency:"RUB",
    availability:"Available", imageUrl:null, supplierPromotions:[], grindOptions:[], sourceIdentityScheme:"hmac-sha256-v1"};
}
async function* provider() {
  yield {streamVersion:"1", recordType:"snapshot-started", snapshotRef, supplierRef,
    providerSnapshotRef:"deterministic-capacity", startedAt:"2026-09-21T00:00:00Z"};
  for (let batchNumber = 0; batchNumber < batches; batchNumber++) {
    const items = Array.from({length:batchSize}, (_, offset) => item(batchNumber * batchSize + offset));
    const uncompressedBytes = catalogBatchBytes(items);
    assert.ok(uncompressedBytes <= maxBatchBytes, `batch ${batchNumber} exceeds 2 MiB`);
    maxObservedBatchBytes = Math.max(maxObservedBatchBytes, uncompressedBytes);
    const batchHash = catalogBatchHash(items);
    const record = {streamVersion:"1", recordType:"snapshot-batch", snapshotRef, batchNumber,
      offerCount:items.length, uncompressedBytes, batchHash, previousBatchHash:previousHash, items};
    previousHash = batchHash;
    contentHash.update(batchHash);
    produced += items.length;
    if (batchNumber % 8 === 0) sample();
    yield record;
  }
  yield {streamVersion:"1", recordType:"snapshot-completed", snapshotRef, batchCount:batches,
    productCount:offers, variantCount:offers, offerCount:offers, contentHash:contentHash.digest(),
    completedAt:"2026-09-21T00:01:00Z"};
}
async function* ndjson() {
  for await (const record of provider()) {
    const bytes = Buffer.from(`${JSON.stringify(record)}\n`);
    wireHash.update(bytes);
    bytesOnWire += bytes.length;
    // Fragment at a bounded size; do not retain the snapshot or batches.
    for (let offset = 0; offset < bytes.length; offset += 4096) {
      yield bytes.subarray(offset, offset + 4096);
    }
  }
}

if (typeof globalThis.gc === "function") globalThis.gc();
const baseline = process.memoryUsage();
sample();
const source = Readable.from(ndjson(), {highWaterMark:1});
const task = runCatalogImport({snapshotRef,supplierRef,signal:new AbortController().signal,
  context:{correlationId:"11111111-1111-4111-8111-111111111111"},
  store:{
    create:async () => {}, acceptStarted:async () => {},
    recordBatch:async () => {
      if (persisted === 0) {firstEntered(); await firstGate;}
      persisted++;
      sample();
      return "stored";
    },
    complete:async record => {
      assert.equal(record.batchCount,batches);
      assert.equal(record.offerCount,offers);
      assert.equal(persisted,batches);
      return "stored";
    }, reject:async () => {throw new Error("capacity fixture must not reject");},
  },
  exportCatalog:() => readNdjson(source),
});
try {
  await entered;
  const producedAtGate = produced;
  await delay(100);
  assert.equal(produced,producedAtGate,"upstream read ahead while store was blocked");
  assert.equal(persisted,0);
  // Readable can prefetch the next record while the current batch is pending;
  // two batches are bounded, while reading all 200 would violate backpressure.
  assert.ok(producedAtGate <= 2 * batchSize,`unbounded prefetch while persistence blocked: ${producedAtGate}`);
  const bufferedOffersAtGate = producedAtGate;
  releaseFirst();
  assert.equal(await task,snapshotRef);
  assert.equal(produced,offers);
  assert.equal(persisted,batches);
  sample();
  const growth = peakRss - baseline.rss;
  // This new 100k-identity fixture measured 105820160 bytes of RSS growth on its
  // first run. Use a separate 128 MiB regression ceiling; do not alter the
  // existing 96 MiB limit for the 128 MiB-wire fixture in tests/catalog/stream.test.mjs.
  assert.ok(growth < 128 * 1024 * 1024,`RSS growth ${growth} exceeded fixed 128 MiB budget`);
  console.log(JSON.stringify({offers,uniqueIdentities:offers,batches,batchSize,maxObservedBatchBytes,
    maxAllowedBatchBytes:maxBatchBytes,bytesOnWire,wireSha256:wireHash.digest("hex"),
    baselineRssBytes:baseline.rss,peakRssBytes:peakRss,rssGrowthBytes:growth,
    peakHeapBytes:peakHeap,rssGrowthBudgetBytes:128 * 1024 * 1024,upstreamPaused:true,
    bufferedOffersAtGate,store:"bounded deterministic fixture; not PostgreSQL"}));
} finally {
  releaseFirst();
  source.destroy();
}
