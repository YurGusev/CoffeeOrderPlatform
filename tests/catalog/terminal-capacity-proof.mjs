import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mock} from "node:test";
import {catalogBatchBytes, catalogBatchHash} from "../../packages/contracts/aroma-v1/dist/index.js";

// Only the database transport is a lazy fixture. complete(), verifyManifest(),
// row reconstruction, canonicalization and content hashing are production code.
// No manifest/hash list is built by this fixture; every row is generated on demand.
const count = 131_072;
const snapshotRef = "snp_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const supplierRef = "sup_00000000000000000000000001";
function item(number) {
  const identity = number.toString(16).padStart(64, "0");
  return {sourceProductKeyHash:identity, sourceVariantKeyHash:identity, sourceOfferKeyHash:identity,
    displayName:`terminal fixture ${number}`, unit:"piece", supplierUnitMinor:"10", currency:"RUB",
    availability:"Available", imageUrl:null, sourceIdentityScheme:"hmac-sha256-v1"};
}
const batchHash = number => catalogBatchHash([item(number)]);
const expected = createHash("sha256");
for (let number = 0; number < count; number++) expected.update(Buffer.from(batchHash(number), "hex"));
const record = {streamVersion:"1", recordType:"snapshot-completed", snapshotRef, batchCount:count,
  productCount:count, variantCount:count, offerCount:count, contentHash:expected.digest("hex"), completedAt:"2026-09-21T01:00:00Z"};
let snapshot = {snapshot_ref:snapshotRef, supplier_ref:supplierRef, provider_snapshot_ref:"fixture", state:"Receiving",
  next_batch_number:count, received_batch_count:count, received_product_count:count, received_variant_count:count,
  received_offer_count:count, received_at:null};
let manifests = 0;
let reconstructions = 0;
let transitions = 0;
let recounts = 0;
let baseline;
let peakRetainedHeapGrowth = 0;
let peakRssGrowth = 0;
let samples = 0;
function sample() {
  globalThis.gc();
  const memory = process.memoryUsage();
  samples++;
  peakRetainedHeapGrowth = Math.max(peakRetainedHeapGrowth, memory.heapUsed - baseline.heapUsed);
  peakRssGrowth = Math.max(peakRssGrowth, memory.rss - baseline.rss);
  assert.ok(peakRetainedHeapGrowth < 4 * 1024 * 1024,
    `production complete retained heap grew ${peakRetainedHeapGrowth} bytes after ${manifests} manifests (limit 4194304)`);
  assert.ok(peakRssGrowth < 64 * 1024 * 1024, `production complete RSS growth ${peakRssGrowth}`);
}
mock.module("../../packages/platform-database/dist/index.js", {namedExports:{
  DatabaseTransactionError:class extends Error {},
  withTransaction:async (_database, _options, work) => work({}),
}});
mock.module("../../packages/platform-database/dist/owner.js", {namedExports:{
  defineTemporaryTable:() => () => {throw new Error("terminal must not create TEMP tables");},
  defineCopy:() => () => {throw new Error("terminal must not COPY");},
  defineStatement:(_database, sql) => async (_transaction, parameters) => {
    assert.equal(parameters[0], snapshotRef);
    if (sql.startsWith("SELECT snapshot_ref")) return {rows:[snapshot]};
    if (sql.includes("FROM catalog.snapshot_batches WHERE snapshot_ref=$1 AND batch_number=$2")) {
      const number = parameters[1];
      assert.equal(number, manifests++, "manifest reads must be serial and contiguous");
      if (number % 8192 === 0) sample();
      return {rows:[{batch_number:number, offer_count:1, uncompressed_bytes:catalogBatchBytes([item(number)]),
        batch_hash:batchHash(number), previous_batch_hash:number === 0 ? null : batchHash(number - 1)}]};
    }
    if (sql.includes("FROM catalog.snapshot_offers o JOIN")) {
      const number = parameters[1];
      assert.equal(number, reconstructions++, "every manifest must be durably reconstructed");
      const value = item(number);
      return {rows:[{item_index:0, source_product_key_hash:value.sourceProductKeyHash,
        source_variant_key_hash:value.sourceVariantKeyHash, source_offer_key_hash:value.sourceOfferKeyHash,
        display_name:value.displayName, unit:value.unit, supplier_unit_minor:value.supplierUnitMinor,
        currency:value.currency, availability:value.availability, image_url:null, supplier_promotions:null,
        grind_options:null, source_identity_scheme:value.sourceIdentityScheme}]};
    }
    if (sql.includes("(SELECT count(*)::int")) {
      recounts++;
      return {rows:[{batch_count:count, product_count:count, variant_count:count, offer_count:count, availability_count:count}]};
    }
    if (sql.startsWith("UPDATE catalog.supplier_snapshots SET state='Received'")) {
      assert.equal(manifests, count); assert.equal(reconstructions, count);
      assert.deepEqual(parameters, [snapshotRef, count, count, count, count, record.contentHash, record.completedAt]);
      transitions++;
      snapshot = {...snapshot, state:"Received", declared_batch_count:count, declared_product_count:count,
        declared_variant_count:count, declared_offer_count:count, content_hash:record.contentHash, received_at:new Date(record.completedAt)};
      return {rows:[]};
    }
    throw new Error(`unexpected terminal SQL: ${sql}`);
  },
}});
const {createCatalogImportStore} = await import("../../apps/catalog-supplier-sync/dist/infrastructure/catalog-import-store.js");
const store = createCatalogImportStore({});
globalThis.gc();
baseline = process.memoryUsage();
assert.equal(await store.complete(record), "stored");
sample();
assert.equal(manifests, count);
assert.equal(reconstructions, count);
assert.equal(transitions, 1);
assert.equal(recounts, 2);
assert.equal((await store.getSnapshot(snapshotRef)).state, "Received");
assert.equal(await store.complete(record), "replay");
await assert.rejects(() => store.complete({...record, contentHash:"0".repeat(64)}), /TERMINAL_REPLAY_CONFLICT/u);
assert.equal(transitions, 1);
assert.equal(manifests, count, "terminal replay must not rescan manifests");
console.log(JSON.stringify({productionComplete:true, database:"lazy SQL fixture (not PostgreSQL)", manifests,
  reconstructions, transitions, recounts, contentHash:record.contentHash, samples,
  heapLimitBytes:4 * 1024 * 1024, peakRetainedHeapGrowth, peakRssGrowth}));
mock.restoreAll();
