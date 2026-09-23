import {Readable} from "node:stream";
import {CatalogTelemetry} from "../observability.js";
import {CATALOG_MAX_BATCH_BYTES, CATALOG_MAX_ITEM_BYTES, CATALOG_MAX_OFFERS_PER_BATCH, canonicalCatalogJson, catalogBatchBytes, catalogBatchHash, createCatalogContentHash, type AromaCatalogExportRecord} from "@coffee-platform/contracts-aroma-v1";
import {DatabaseTransactionError, withTransaction, type Database, type SqlScalar, type Transaction} from "@coffee-platform/database";
import {defineCopy, defineStatement, defineTemporaryTable} from "@coffee-platform/database/owner";
import {toInstant} from "@coffee-platform/platform-time";

type Started = Extract<AromaCatalogExportRecord, {recordType: "snapshot-started"}>;
type Batch = Extract<AromaCatalogExportRecord, {recordType: "snapshot-batch"}>;
type Completed = Extract<AromaCatalogExportRecord, {recordType: "snapshot-completed"}>;
const FAILURE_CODES = [
  "PROVIDER_UNAVAILABLE", "PROVIDER_TIMEOUT", "INVALID_STREAM", "HTTP_BEFORE_STARTED", "RECOVERY_INCOMPLETE", "IMPORT_DEADLINE_EXCEEDED",
  "INVALID_STREAM_SCHEMA", "INVALID_STREAM_SEQUENCE", "INVALID_STREAM_MISSING_TERMINAL",
  "CATALOG_STREAM_LINE_TOO_LARGE", "CATALOG_STREAM_EMPTY_LINE", "CATALOG_STREAM_INVALID_UTF8", "CATALOG_STREAM_INVALID_JSON", "CATALOG_STREAM_INCOMPLETE",
  "BATCH_OFFER_COUNT_MISMATCH", "BATCH_OFFER_LIMIT", "BATCH_BYTE_LIMIT", "ITEM_BYTE_LIMIT", "BATCH_BYTE_COUNT_MISMATCH",
  "BATCH_HASH_CONFLICT", "BATCH_SEQUENCE_CONFLICT", "BATCH_CHAIN_CONFLICT", "SOURCE_IDENTITY_COLLISION",
  "BATCH_DURABLE_ORDINAL_MISMATCH", "BATCH_DURABLE_HASH_MISMATCH",
  "TERMINAL_COUNT_MISMATCH", "TERMINAL_CHAIN_MISMATCH", "TERMINAL_CONTENT_HASH_MISMATCH", "IMPORT_DB_ROLLED_BACK",
] as const;
export type CatalogFailureCode = typeof FAILURE_CODES[number];
export function catalogFailureCode(code: unknown): CatalogFailureCode | undefined {
  if (code === "BATCH_REPLAY_CONFLICT") return "BATCH_HASH_CONFLICT";
  return FAILURE_CODES.find(candidate => candidate === code);
}
export type CatalogItem = Batch["items"][number];
export type SnapshotState = "Created" | "Receiving" | "Received" | "Rejected";
export type SnapshotRow = Readonly<{
  snapshot_ref: string; supplier_ref: string; provider_snapshot_ref: string | null; state: SnapshotState;
  next_batch_number: number; declared_batch_count: number | null; declared_product_count: number | null;
  declared_variant_count: number | null; declared_offer_count: number | null; received_batch_count: number;
  received_product_count: number; received_variant_count: number; received_offer_count: number;
  content_hash: string | null; failure_code: string | null; received_at: Date | null;
}>;
type ManifestRow = Readonly<{batch_number: number; offer_count: number; uncompressed_bytes: number; batch_hash: string; previous_batch_hash: string | null}>;
type DurableCounts = Readonly<{batch_count: number; product_count: number; variant_count: number; offer_count: number; availability_count: number}>;
type ItemRow = Readonly<{
  item_index: number; source_product_key_hash: string; source_variant_key_hash: string; source_offer_key_hash: string;
  display_name: string; unit: CatalogItem["unit"]; supplier_unit_minor: string; currency: "RUB";
  availability: CatalogItem["availability"]; image_url: string | null; supplier_promotions: Exclude<CatalogItem["supplierPromotions"], undefined> | null;
  grind_options: Exclude<CatalogItem["grindOptions"], undefined> | null; source_identity_scheme: "hmac-sha256-v1";
}>;

export class CatalogImportError extends Error {
  public readonly code: string;
  public constructor(code: string) { super(code); this.name = "CatalogImportError"; this.code = code; }
}

const TEMP_COLUMNS = [
  {name:"item_index", type:"integer"}, {name:"source_product_key_hash", type:"text"},
  {name:"source_variant_key_hash", type:"text"}, {name:"source_offer_key_hash", type:"text"},
  {name:"display_name", type:"text"}, {name:"unit", type:"text"}, {name:"supplier_unit_minor", type:"text"},
  {name:"currency", type:"text"}, {name:"availability", type:"text"}, {name:"image_url", type:"text", nullable:true},
  {name:"supplier_promotions", type:"jsonb", nullable:true}, {name:"grind_options", type:"jsonb", nullable:true},
  {name:"source_identity_scheme", type:"text"},
] as const;
const TEMP_COLUMN_NAMES = TEMP_COLUMNS.map(column => column.name);

function copyField(value: string | null): string {
  if (value === null) return "\\N";
  return value.replaceAll("\\", "\\\\").replaceAll("\t", "\\t").replaceAll("\n", "\\n").replaceAll("\r", "\\r");
}
function copySource(items: readonly CatalogItem[]): Readable {
  return Readable.from(items.map((item, index) => [
    String(index), item.sourceProductKeyHash, item.sourceVariantKeyHash, item.sourceOfferKeyHash,
    item.displayName, item.unit, item.supplierUnitMinor, item.currency, item.availability, item.imageUrl,
    item.supplierPromotions === undefined ? null : JSON.stringify(item.supplierPromotions),
    item.grindOptions === undefined ? null : JSON.stringify(item.grindOptions), item.sourceIdentityScheme,
  ].map(value => copyField(value)).join("\t") + "\n"));
}
function itemFromRow(row: ItemRow): CatalogItem {
  return {
    sourceProductKeyHash: row.source_product_key_hash,
    sourceVariantKeyHash: row.source_variant_key_hash,
    sourceOfferKeyHash: row.source_offer_key_hash,
    displayName: row.display_name,
    unit: row.unit,
    supplierUnitMinor: row.supplier_unit_minor,
    currency: row.currency,
    availability: row.availability,
    imageUrl: row.image_url,
    ...(row.supplier_promotions === null ? {} : {supplierPromotions: row.supplier_promotions}),
    ...(row.grind_options === null ? {} : {grindOptions: row.grind_options}),
    sourceIdentityScheme: row.source_identity_scheme,
  };
}

function transactionOptions(signal?: AbortSignal): Readonly<{mode: "background"; signal?: AbortSignal}> {
  return {mode: "background", ...(signal === undefined ? {} : {signal})};
}
function assertBatchShape(record: Batch): void {
  if (record.items.some(item => typeof item.supplierUnitMinor !== "string" || !/^(0|[1-9][0-9]*)$/u.test(item.supplierUnitMinor))) {
    throw new CatalogImportError("INVALID_STREAM_SCHEMA");
  }
  if (record.offerCount !== record.items.length) throw new CatalogImportError("BATCH_OFFER_COUNT_MISMATCH");
  if (record.items.length > CATALOG_MAX_OFFERS_PER_BATCH) throw new CatalogImportError("BATCH_OFFER_LIMIT");
  const bytes = catalogBatchBytes(record.items);
  if (bytes > CATALOG_MAX_BATCH_BYTES) throw new CatalogImportError("BATCH_BYTE_LIMIT");
  for (const item of record.items) {
    if (Buffer.byteLength(canonicalCatalogJson(item), "utf8") > CATALOG_MAX_ITEM_BYTES) throw new CatalogImportError("ITEM_BYTE_LIMIT");
  }
  if (record.uncompressedBytes !== bytes) throw new CatalogImportError("BATCH_BYTE_COUNT_MISMATCH");
  if (record.batchHash !== catalogBatchHash(record.items)) throw new CatalogImportError("BATCH_HASH_CONFLICT");
}
function sameTerminal(row: SnapshotRow, record: Completed): boolean {
  const completedAt = toInstant(record.completedAt).epochMilliseconds;
  return row.state === "Received" && row.declared_batch_count === record.batchCount && row.declared_product_count === record.productCount &&
    row.declared_variant_count === record.variantCount && row.declared_offer_count === record.offerCount && row.content_hash === record.contentHash &&
    row.received_batch_count === record.batchCount && row.received_product_count === record.productCount &&
    row.received_variant_count === record.variantCount && row.received_offer_count === record.offerCount &&
    row.received_at !== null && row.received_at.getTime() === completedAt;
}

export type CatalogImportStore = ReturnType<typeof createCatalogImportStore>;
export function createCatalogImportStore(database: Database, telemetry: CatalogTelemetry = new CatalogTelemetry()) {
  const transact = <T>(signal: AbortSignal | undefined, work: (transaction: Transaction) => Promise<T>): Promise<T> =>
    telemetry.observe("transaction", async () => {
      let observed: Transaction | undefined;
      try {
        return await withTransaction(database, transactionOptions(signal), transaction => { observed = transaction; return work(transaction); });
      } catch (error) {
        // Only an observed rollback of a known SQL failure is a rejection candidate.
        // Lost connections, cancelled COPY and unknown COMMIT/ROLLBACK keep their DB classification.
        if (error instanceof DatabaseTransactionError && error.code === "DB_QUERY_FAILED" && observed?.state() === "RolledBack") {
          throw new CatalogImportError("IMPORT_DB_ROLLED_BACK");
        }
        throw error;
      }
    });
  const statement = <Row>(sql: string) => defineStatement<Row, readonly SqlScalar[]>(database, sql);
  const createTemp = defineTemporaryTable(database, "catalog_import_batch", TEMP_COLUMNS);
  const copyTemp = defineCopy(database, "catalog_import_batch", TEMP_COLUMN_NAMES, "pg_temp");
  const selectSnapshot = statement<SnapshotRow>(`SELECT snapshot_ref, supplier_ref, provider_snapshot_ref, state, next_batch_number,
    declared_batch_count, declared_product_count, declared_variant_count, declared_offer_count,
    received_batch_count, received_product_count, received_variant_count, received_offer_count,
    content_hash, failure_code, received_at FROM catalog.supplier_snapshots WHERE snapshot_ref=$1`);
  const lockSnapshot = statement<SnapshotRow>(`SELECT snapshot_ref, supplier_ref, provider_snapshot_ref, state, next_batch_number,
    declared_batch_count, declared_product_count, declared_variant_count, declared_offer_count,
    received_batch_count, received_product_count, received_variant_count, received_offer_count,
    content_hash, failure_code, received_at FROM catalog.supplier_snapshots WHERE snapshot_ref=$1 FOR UPDATE`);
  const insertSnapshot = statement<never>(`INSERT INTO catalog.supplier_snapshots(snapshot_ref,supplier_ref,state) VALUES($1,$2,'Created') ON CONFLICT DO NOTHING`);
  const startSnapshot = statement<never>(`UPDATE catalog.supplier_snapshots SET provider_snapshot_ref=$2,state='Receiving'
    WHERE snapshot_ref=$1 AND state='Created'`);
  const selectManifest = statement<ManifestRow>(`SELECT batch_number,offer_count,uncompressed_bytes,batch_hash,previous_batch_hash
    FROM catalog.snapshot_batches WHERE snapshot_ref=$1 AND batch_number=$2`);
  const durableCounts = statement<DurableCounts>(`SELECT
    (SELECT count(*)::int FROM catalog.snapshot_batches WHERE snapshot_ref=$1) batch_count,
    (SELECT count(*)::int FROM catalog.snapshot_products WHERE snapshot_ref=$1) product_count,
    (SELECT count(*)::int FROM catalog.snapshot_variants WHERE snapshot_ref=$1) variant_count,
    (SELECT count(*)::int FROM catalog.snapshot_offers WHERE snapshot_ref=$1) offer_count,
    (SELECT count(*)::int FROM catalog.snapshot_availability WHERE snapshot_ref=$1) availability_count`);
  const reconstruct = statement<ItemRow>(`SELECT o.item_index,o.source_offer_key_hash,o.source_variant_key_hash,v.source_product_key_hash,
    v.display_name,v.unit,o.supplier_unit_minor,o.currency,a.availability,p.image_url,o.supplier_promotions,o.grind_options,o.source_identity_scheme
    FROM catalog.snapshot_offers o JOIN catalog.snapshot_variants v USING(snapshot_ref,source_variant_key_hash)
    JOIN catalog.snapshot_products p USING(snapshot_ref,source_product_key_hash)
    JOIN catalog.snapshot_availability a USING(snapshot_ref,source_offer_key_hash)
    WHERE o.snapshot_ref=$1 AND o.batch_number=$2 ORDER BY o.item_index`);
  const collision = statement<{collision: boolean}>(`SELECT EXISTS(
    SELECT 1 FROM pg_temp.catalog_import_batch GROUP BY source_product_key_hash HAVING count(DISTINCT jsonb_build_array(image_url))>1
    UNION ALL SELECT 1 FROM pg_temp.catalog_import_batch GROUP BY source_variant_key_hash HAVING count(DISTINCT jsonb_build_array(source_product_key_hash,display_name,unit))>1
    UNION ALL SELECT 1 FROM pg_temp.catalog_import_batch GROUP BY source_offer_key_hash HAVING count(*)>1
    UNION ALL SELECT 1 FROM (SELECT element->>'sourceGrindKeyHash' key, element->>'displayName' name FROM pg_temp.catalog_import_batch,
      LATERAL jsonb_array_elements(COALESCE(grind_options,'[]'::jsonb)) element) grinds GROUP BY key HAVING count(DISTINCT name)>1
  ) AS collision`);
  const mergeProducts = statement<never>(`INSERT INTO catalog.snapshot_products(snapshot_ref,source_product_key_hash,image_url)
    SELECT DISTINCT ON (source_product_key_hash) $1,source_product_key_hash,image_url FROM pg_temp.catalog_import_batch
    ON CONFLICT DO NOTHING`);
  const productConflict = statement<{collision: boolean}>(`SELECT EXISTS(SELECT 1 FROM pg_temp.catalog_import_batch t JOIN catalog.snapshot_products p
    ON p.snapshot_ref=$1 AND p.source_product_key_hash=t.source_product_key_hash WHERE p.image_url IS DISTINCT FROM t.image_url) AS collision`);
  const mergeVariants = statement<never>(`INSERT INTO catalog.snapshot_variants(snapshot_ref,source_variant_key_hash,source_product_key_hash,display_name,unit)
    SELECT DISTINCT ON (source_variant_key_hash) $1,source_variant_key_hash,source_product_key_hash,display_name,unit FROM pg_temp.catalog_import_batch
    ON CONFLICT DO NOTHING`);
  const variantConflict = statement<{collision: boolean}>(`SELECT EXISTS(SELECT 1 FROM pg_temp.catalog_import_batch t JOIN catalog.snapshot_variants v
    ON v.snapshot_ref=$1 AND v.source_variant_key_hash=t.source_variant_key_hash WHERE
    v.source_product_key_hash IS DISTINCT FROM t.source_product_key_hash OR v.display_name IS DISTINCT FROM t.display_name OR v.unit IS DISTINCT FROM t.unit) AS collision`);
  const offerConflict = statement<{collision: boolean}>(`SELECT EXISTS(SELECT 1 FROM pg_temp.catalog_import_batch t JOIN catalog.snapshot_offers o
    ON o.snapshot_ref=$1 AND o.source_offer_key_hash=t.source_offer_key_hash) AS collision`);
  const grindConflict = statement<{collision: boolean}>(`SELECT EXISTS(
    SELECT 1 FROM (
      SELECT element->>'sourceGrindKeyHash' key, element->>'displayName' name
      FROM pg_temp.catalog_import_batch, LATERAL jsonb_array_elements(COALESCE(grind_options,'[]'::jsonb)) element
      UNION ALL
      SELECT element->>'sourceGrindKeyHash', element->>'displayName'
      FROM catalog.snapshot_offers o, LATERAL jsonb_array_elements(COALESCE(o.grind_options,'[]'::jsonb)) element
      WHERE o.snapshot_ref=$1
    ) generation_grinds GROUP BY key HAVING count(DISTINCT name)>1
  ) AS collision`);
  const insertOffers = statement<never>(`INSERT INTO catalog.snapshot_offers(snapshot_ref,source_offer_key_hash,source_variant_key_hash,batch_number,item_index,
    supplier_unit_minor,currency,supplier_promotions,grind_options,source_identity_scheme)
    SELECT $1,source_offer_key_hash,source_variant_key_hash,$2,item_index,supplier_unit_minor,currency,supplier_promotions,grind_options,source_identity_scheme
    FROM pg_temp.catalog_import_batch`);
  const insertAvailability = statement<never>(`INSERT INTO catalog.snapshot_availability(snapshot_ref,source_offer_key_hash,availability)
    SELECT $1,source_offer_key_hash,availability FROM pg_temp.catalog_import_batch`);
  const insertManifest = statement<never>(`INSERT INTO catalog.snapshot_batches(snapshot_ref,batch_number,offer_count,uncompressed_bytes,batch_hash,previous_batch_hash)
    VALUES($1,$2,$3,$4,$5,$6)`);
  const updateCounters = statement<never>(`UPDATE catalog.supplier_snapshots s SET next_batch_number=$2+1,
    received_batch_count=(SELECT count(*) FROM catalog.snapshot_batches b WHERE b.snapshot_ref=s.snapshot_ref),
    received_product_count=(SELECT count(*) FROM catalog.snapshot_products p WHERE p.snapshot_ref=s.snapshot_ref),
    received_variant_count=(SELECT count(*) FROM catalog.snapshot_variants v WHERE v.snapshot_ref=s.snapshot_ref),
    received_offer_count=(SELECT count(*) FROM catalog.snapshot_offers o WHERE o.snapshot_ref=s.snapshot_ref)
    WHERE snapshot_ref=$1`);
  const completeSnapshot = statement<never>(`UPDATE catalog.supplier_snapshots SET state='Received',declared_batch_count=$2,
    declared_product_count=$3,declared_variant_count=$4,declared_offer_count=$5,content_hash=$6,received_at=$7
    WHERE snapshot_ref=$1 AND state='Receiving'`);
  const rejectSnapshot = statement<never>(`UPDATE catalog.supplier_snapshots SET state='Rejected',failure_code=$2 WHERE snapshot_ref=$1 AND state IN ('Created','Receiving')`);
  const incomplete = statement<SnapshotRow>(`SELECT snapshot_ref, supplier_ref, provider_snapshot_ref, state, next_batch_number,
    declared_batch_count, declared_product_count, declared_variant_count, declared_offer_count,
    received_batch_count, received_product_count, received_variant_count, received_offer_count,
    content_hash, failure_code, received_at FROM catalog.supplier_snapshots WHERE state IN ('Created','Receiving') ORDER BY created_at`);

  async function readBatchRows(transaction: Transaction, snapshotRef: string, batchNumber: number): Promise<readonly ItemRow[]> {
    return (await reconstruct(transaction, [snapshotRef, batchNumber])).rows;
  }
  async function readBatch(transaction: Transaction, snapshotRef: string, batchNumber: number): Promise<readonly CatalogItem[]> {
    return (await readBatchRows(transaction, snapshotRef, batchNumber)).map(itemFromRow);
  }
  async function verifyManifest(transaction: Transaction, snapshotRef: string, manifest: ManifestRow): Promise<readonly CatalogItem[]> {
    const rows = await readBatchRows(transaction, snapshotRef, manifest.batch_number);
    if (rows.some((row, index) => row.item_index !== index)) throw new CatalogImportError("BATCH_DURABLE_ORDINAL_MISMATCH");
    const items = rows.map(itemFromRow);
    if (items.length !== manifest.offer_count || catalogBatchBytes(items) !== manifest.uncompressed_bytes || catalogBatchHash(items) !== manifest.batch_hash) {
      throw new CatalogImportError("BATCH_DURABLE_HASH_MISMATCH");
    }
    return items;
  }

  return Object.freeze({
    async getSnapshot(snapshotRef: string, signal?: AbortSignal): Promise<SnapshotRow | null> {
      return transact(signal, async transaction => (await selectSnapshot(transaction, [snapshotRef])).rows[0] ?? null);
    },
    async listIncomplete(signal?: AbortSignal): Promise<readonly SnapshotRow[]> {
      return transact(signal, async transaction => (await incomplete(transaction, [])).rows);
    },
    async create(snapshotRef: string, supplierRef: string, signal?: AbortSignal): Promise<void> {
      await transact(signal, async transaction => {
        await insertSnapshot(transaction, [snapshotRef, supplierRef]);
        const row = (await lockSnapshot(transaction, [snapshotRef])).rows[0];
        if (row === undefined || row.supplier_ref !== supplierRef || row.state !== "Created" || row.provider_snapshot_ref !== null) throw new CatalogImportError("SNAPSHOT_REF_CONFLICT");
      });
    },
    async acceptStarted(record: Started, signal?: AbortSignal): Promise<void> {
      await transact(signal, async transaction => {
        const row = (await lockSnapshot(transaction, [record.snapshotRef])).rows[0];
        if (row === undefined || row.supplier_ref !== record.supplierRef) throw new CatalogImportError("SNAPSHOT_STARTED_CONFLICT");
        if (row.state === "Receiving" && row.provider_snapshot_ref === record.providerSnapshotRef) return;
        if (row.state !== "Created" || row.provider_snapshot_ref !== null) throw new CatalogImportError("SNAPSHOT_STARTED_CONFLICT");
        await startSnapshot(transaction, [record.snapshotRef, record.providerSnapshotRef]);
      });
    },
    async recordBatch(record: Batch, signal?: AbortSignal): Promise<"stored" | "replay"> {
      telemetry.validate(() => assertBatchShape(record));
      return transact(signal, async transaction => {
        const row = (await lockSnapshot(transaction, [record.snapshotRef])).rows[0];
        if (row === undefined) throw new CatalogImportError("SNAPSHOT_NOT_FOUND");
        const existing = (await selectManifest(transaction, [record.snapshotRef, record.batchNumber])).rows[0];
        if (existing !== undefined) {
          if (row.state === "Rejected") throw new CatalogImportError("BATCH_REPLAY_CONFLICT");
          if (existing.offer_count !== record.offerCount || existing.uncompressed_bytes !== record.uncompressedBytes || existing.batch_hash !== record.batchHash || existing.previous_batch_hash !== record.previousBatchHash) throw new CatalogImportError("BATCH_REPLAY_CONFLICT");
          const persisted = await verifyManifest(transaction, record.snapshotRef, existing);
          if (catalogBatchHash(persisted) !== record.batchHash) throw new CatalogImportError("BATCH_REPLAY_CONFLICT");
          return "replay";
        }
        if (row.state !== "Receiving" || row.next_batch_number !== record.batchNumber) throw new CatalogImportError("BATCH_SEQUENCE_CONFLICT");
        const previous = record.batchNumber === 0 ? null : (await selectManifest(transaction, [record.snapshotRef, record.batchNumber - 1])).rows[0]?.batch_hash;
        if ((previous ?? null) !== record.previousBatchHash) throw new CatalogImportError("BATCH_CHAIN_CONFLICT");
        await createTemp(transaction);
        const source = copySource(record.items);
        await telemetry.copy(source, () => copyTemp(transaction, source));
        if ((await collision(transaction, [])).rows[0]?.collision === true) throw new CatalogImportError("SOURCE_IDENTITY_COLLISION");
        await mergeProducts(transaction, [record.snapshotRef]);
        if ((await productConflict(transaction, [record.snapshotRef])).rows[0]?.collision === true) throw new CatalogImportError("SOURCE_IDENTITY_COLLISION");
        await mergeVariants(transaction, [record.snapshotRef]);
        if ((await variantConflict(transaction, [record.snapshotRef])).rows[0]?.collision === true) throw new CatalogImportError("SOURCE_IDENTITY_COLLISION");
        if ((await offerConflict(transaction, [record.snapshotRef])).rows[0]?.collision === true) throw new CatalogImportError("SOURCE_IDENTITY_COLLISION");
        if ((await grindConflict(transaction, [record.snapshotRef])).rows[0]?.collision === true) throw new CatalogImportError("SOURCE_IDENTITY_COLLISION");
        await insertOffers(transaction, [record.snapshotRef, record.batchNumber]);
        await insertAvailability(transaction, [record.snapshotRef]);
        const persisted = await readBatch(transaction, record.snapshotRef, record.batchNumber);
        if (catalogBatchHash(persisted) !== record.batchHash) throw new CatalogImportError("BATCH_DURABLE_HASH_MISMATCH");
        await insertManifest(transaction, [record.snapshotRef, record.batchNumber, record.offerCount, record.uncompressedBytes, record.batchHash, record.previousBatchHash]);
        await updateCounters(transaction, [record.snapshotRef, record.batchNumber]);
        return "stored";
      });
    },
    async complete(record: Completed, signal?: AbortSignal): Promise<"stored" | "replay"> {
      const before = await transact(signal, async transaction =>
        (await selectSnapshot(transaction, [record.snapshotRef])).rows[0]);
      if (before === undefined) throw new CatalogImportError("SNAPSHOT_NOT_FOUND");
      if (sameTerminal(before, record)) return "replay";
      if (before.state !== "Receiving") throw new CatalogImportError("TERMINAL_REPLAY_CONFLICT");

      const contentHash = createCatalogContentHash();
      let previous: string | null = null;
      for (let batchNumber = 0; batchNumber < record.batchCount; batchNumber += 1) {
        const manifest = await transact(signal, async transaction => {
          const found = (await selectManifest(transaction, [record.snapshotRef, batchNumber])).rows[0];
          if (found === undefined) throw new CatalogImportError("TERMINAL_COUNT_MISMATCH");
          if (found.batch_number !== batchNumber || found.previous_batch_hash !== previous) throw new CatalogImportError("TERMINAL_CHAIN_MISMATCH");
          await verifyManifest(transaction, record.snapshotRef, found);
          return found;
        });
        contentHash.update(manifest.batch_hash);
        previous = manifest.batch_hash;
      }
      if (contentHash.digest() !== record.contentHash) throw new CatalogImportError("TERMINAL_CONTENT_HASH_MISMATCH");

      const counts = await transact(signal, async transaction =>
        (await durableCounts(transaction, [record.snapshotRef])).rows[0]);
      if (counts === undefined || counts.batch_count !== record.batchCount || counts.product_count !== record.productCount ||
        counts.variant_count !== record.variantCount || counts.offer_count !== record.offerCount ||
        counts.availability_count !== record.offerCount) throw new CatalogImportError("TERMINAL_COUNT_MISMATCH");

      return transact(signal, async transaction => {
        const row = (await lockSnapshot(transaction, [record.snapshotRef])).rows[0];
        if (row === undefined) throw new CatalogImportError("SNAPSHOT_NOT_FOUND");
        if (sameTerminal(row, record)) return "replay";
        if (row.state !== "Receiving") throw new CatalogImportError("TERMINAL_REPLAY_CONFLICT");
        if (row.next_batch_number !== record.batchCount || row.received_batch_count !== record.batchCount ||
          row.received_product_count !== record.productCount || row.received_variant_count !== record.variantCount ||
          row.received_offer_count !== record.offerCount) throw new CatalogImportError("TERMINAL_COUNT_MISMATCH");
        const finalCounts = (await durableCounts(transaction, [record.snapshotRef])).rows[0];
        if (finalCounts === undefined || finalCounts.batch_count !== record.batchCount || finalCounts.product_count !== record.productCount ||
          finalCounts.variant_count !== record.variantCount || finalCounts.offer_count !== record.offerCount ||
          finalCounts.availability_count !== record.offerCount) throw new CatalogImportError("TERMINAL_COUNT_MISMATCH");
        await completeSnapshot(transaction, [record.snapshotRef, record.batchCount, record.productCount, record.variantCount, record.offerCount, record.contentHash, record.completedAt]);
        return "stored";
      });
    },
    async reject(snapshotRef: string, code: CatalogFailureCode, signal?: AbortSignal): Promise<"stored" | "replay"> {
      if (catalogFailureCode(code) !== code) throw new CatalogImportError("INVALID_FAILURE_CODE");
      return transact(signal, async transaction => {
        const row = (await lockSnapshot(transaction, [snapshotRef])).rows[0];
        if (row === undefined) throw new CatalogImportError("SNAPSHOT_NOT_FOUND");
        if (row.state === "Rejected" && row.failure_code === code) return "replay";
        if (row.state === "Received" || row.state === "Rejected") throw new CatalogImportError("TERMINAL_REPLAY_CONFLICT");
        await rejectSnapshot(transaction, [snapshotRef, code]);
        return "stored";
      });
    },
    async reconstructBatch(snapshotRef: string, batchNumber: number, signal?: AbortSignal): Promise<readonly CatalogItem[]> {
      return transact(signal, transaction => readBatch(transaction, snapshotRef, batchNumber));
    },
    async verifyBatchReplay(record: Batch, signal?: AbortSignal): Promise<boolean> {
      return transact(signal, async transaction => {
        const row = (await lockSnapshot(transaction, [record.snapshotRef])).rows[0];
        const manifest = (await selectManifest(transaction, [record.snapshotRef, record.batchNumber])).rows[0];
        if (manifest === undefined || manifest.offer_count !== record.offerCount || manifest.uncompressed_bytes !== record.uncompressedBytes || manifest.batch_hash !== record.batchHash || manifest.previous_batch_hash !== record.previousBatchHash) return false;
        const counts = (await durableCounts(transaction, [record.snapshotRef])).rows[0];
        if (row === undefined || counts === undefined || !["Receiving", "Received"].includes(row.state) ||
          row.next_batch_number <= record.batchNumber || row.next_batch_number !== row.received_batch_count ||
          row.received_batch_count !== counts.batch_count || row.received_product_count !== counts.product_count ||
          row.received_variant_count !== counts.variant_count || row.received_offer_count !== counts.offer_count ||
          counts.availability_count !== counts.offer_count) return false;
        try { await verifyManifest(transaction, record.snapshotRef, manifest); return true; }
        catch { return false; }
      });
    },
  });
}

export function isOutcomeUnknown(error: unknown): boolean {
  return error instanceof DatabaseTransactionError && error.code === "TRANSACTION_OUTCOME_UNKNOWN";
}
