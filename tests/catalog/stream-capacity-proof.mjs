import assert from "node:assert/strict";
import {Readable} from "node:stream";
import {setTimeout as delay} from "node:timers/promises";
import {readNdjson} from "../../apps/catalog-supplier-sync/dist/ndjson-reader.js";
import {runCatalogImport} from "../../apps/catalog-supplier-sync/dist/run-catalog-import.js";
import {catalogBatchHash, catalogBatchBytes, catalogContentHash} from "../../packages/contracts/aroma-v1/dist/index.js";

const snapshotRef = "snp_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const supplierRef = "sup_00000000000000000000000001";
const count = 3072;
const items = Array.from({length:64}, (_, i) => ({sourceProductKeyHash:i.toString(16).padStart(64,"0"),
  sourceVariantKeyHash:i.toString(16).padStart(64,"0"), sourceOfferKeyHash:i.toString(16).padStart(64,"0"),
  displayName:"Кофе".repeat(50), unit:"piece", supplierUnitMinor:"10", currency:"RUB", availability:"Available", imageUrl:null,
  supplierPromotions:[], sourceIdentityScheme:"hmac-sha256-v1"}));
const batchHash = catalogBatchHash(items);
const uncompressedBytes = catalogBatchBytes(items);
let wireBytes = 0;
let fragmentsProduced = 0;
let committed = 0;
let entered;
let release;
const holding = new Promise(resolve => {entered=resolve;});
const persistence = new Promise(resolve => {release=resolve;});
let peakHeap = 0;
let peakRss = 0;
let peakExternal = 0;
function sample() {
  const memory = process.memoryUsage();
  peakHeap=Math.max(peakHeap,memory.heapUsed); peakRss=Math.max(peakRss,memory.rss); peakExternal=Math.max(peakExternal,memory.external);
}
async function* records() {
  yield {streamVersion:"1", recordType:"snapshot-started", snapshotRef, supplierRef, providerSnapshotRef:"fixture", startedAt:"2026-09-21T00:00:00Z"};
  for (let batchNumber=0;batchNumber<count;batchNumber++) yield {streamVersion:"1", recordType:"snapshot-batch", snapshotRef, batchNumber,
    offerCount:items.length, uncompressedBytes, batchHash, previousBatchHash:batchNumber === 0 ? null : batchHash, items};
  yield {streamVersion:"1", recordType:"snapshot-completed", snapshotRef, batchCount:count, productCount:items.length,
    variantCount:items.length, offerCount:count*items.length, contentHash:catalogContentHash(Array(count).fill(batchHash)), completedAt:"2026-09-21T01:00:00Z"};
}
async function* fragmented() {
  for await (const record of records()) {
    const bytes = Buffer.from(JSON.stringify(record)+"\n");
    wireBytes += bytes.length;
    for (let offset=0;offset<bytes.length;offset+=257) {
      fragmentsProduced++;
      if (fragmentsProduced % 4096 === 0) sample();
      yield bytes.subarray(offset,offset+257);
    }
  }
}
globalThis.gc();
const baseline = process.memoryUsage();
const source = Readable.from(fragmented(), {highWaterMark:1});
const run = runCatalogImport({snapshotRef, supplierRef, deadlineMs:120_000, signal:new AbortController().signal,
  context:{correlationId:"11111111-1111-4111-8111-111111111111"},
  store:{create:async()=>{}, acceptStarted:async()=>{}, recordBatch:async()=>{
    if (committed === 0) {entered(); await persistence;}
    committed++; sample(); return "stored";
  }, complete:async()=>{assert.equal(committed,count);}, reject:async()=>{}},
  exportCatalog:() => readNdjson(source),
});
await holding;
await delay(25);
const pausedAt = fragmentsProduced;
await delay(100);
assert.equal(committed,0);
assert.equal(fragmentsProduced,pausedAt,"upstream demand must stop during pending persistence");
release();
await run;
sample();
assert.equal(committed,count);
assert.ok(wireBytes>128*1024*1024,`large fixture too small: ${wireBytes}`);
assert.ok(peakHeap-baseline.heapUsed < 48*1024*1024,`heap growth ${peakHeap-baseline.heapUsed}`);
assert.ok(peakRss-baseline.rss < 96*1024*1024,`RSS growth ${peakRss-baseline.rss}`);
assert.ok(peakExternal-baseline.external < 16*1024*1024,`external growth ${peakExternal-baseline.external}`);
console.log(JSON.stringify({wireBytes,batches:committed,fragmentBytes:257,fragmentsProduced,persistenceDelayMs:125,
  upstreamPaused:true,peakHeapGrowth:peakHeap-baseline.heapUsed,peakRssGrowth:peakRss-baseline.rss,peakExternalGrowth:peakExternal-baseline.external}));
