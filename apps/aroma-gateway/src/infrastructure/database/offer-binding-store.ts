import { createHash } from "node:crypto";
import {
  DatabaseTransactionError,
  withTransaction,
  type Database,
  type SqlScalar,
  type Transaction,
} from "@coffee-platform/database";
import {
  defineStatement,
  type OwnerStatement,
} from "@coffee-platform/database/owner";
import {
  canonicalCatalogJson,
  isAromaOfferBindingRequest,
  type AromaOfferBindingRequest,
  type AromaOfferBindingResponse,
} from "@coffee-platform/contracts-aroma-v1";
import {
  CATALOG_SOURCE_IDENTITY_SCHEME,
  sha256CatalogHash,
  type CatalogBatchRecord,
  type CatalogExportSummary,
} from "../../domain/catalog-export-contract.js";

const SCHEME = CATALOG_SOURCE_IDENTITY_SCHEME;
const MAX_BATCH = 500;
const MAX_BULK_IDENTITIES = 10_000;
const EXPORT_OUTCOME_REREAD_TIMEOUT_MS = 1_000;
const EXPLICIT_NULL_PROVIDER_FACT = "";

function isUnknownCommit(error: unknown): boolean {
  return (
    error instanceof DatabaseTransactionError &&
    error.code === "TRANSACTION_OUTCOME_UNKNOWN"
  );
}

type OfferBindingRequest = AromaOfferBindingRequest;
type OfferBindingResponse = AromaOfferBindingResponse;
export type { OfferBindingRequest, OfferBindingResponse };

export type ProviderOfferIdentity = Readonly<{
  supplierRef: string;
  sourceIdentityScheme: typeof SCHEME;
  sourceProductKeyHash?: string;
  sourceVariantKeyHash?: string;
  sourceOfferKeyHash: string;
  rawProviderOfferId: string;
  rawProviderProductId: string;
  rawProviderVariantId: string;
  packing?: string | null;
  grindId?: string | null;
}>;

export type ResolvedProviderOffer = Readonly<
  ProviderOfferIdentity & { offerRef: string; cartLineId: string | null }
>;
export type CartProviderIdentity = Readonly<{
  offerId: string;
  packing: string | null;
  grindId: string | null;
}>;
export type CartBinding = OfferBindingResponse & {
  providerIdentity: CartProviderIdentity;
};

export class OfferBindingStoreError extends Error {
  public readonly code:
    | "AROMA_BINDING_CONFLICT"
    | "AROMA_BINDING_SOURCE_NOT_FOUND"
    | "AROMA_BINDING_SNAPSHOT_INCOMPLETE";
  public constructor(
    code:
      | "AROMA_BINDING_CONFLICT"
      | "AROMA_BINDING_SOURCE_NOT_FOUND"
      | "AROMA_BINDING_SNAPSHOT_INCOMPLETE",
  ) {
    super(code);
    this.name = "OfferBindingStoreError";
    this.code = code;
  }
}

type BindingRow = Readonly<{
  offer_ref: unknown;
  supplier_ref: unknown;
  source_identity_scheme: unknown;
  source_offer_key_hash: unknown;
  first_snapshot_ref: unknown;
  state: unknown;
}>;
type MembershipRow = Readonly<{
  source_exists: unknown;
  snapshot_state: unknown;
  member: unknown;
}>;
type SourceRow = Readonly<{
  supplier_ref: unknown;
  source_identity_scheme: unknown;
  source_offer_key_hash: unknown;
  source_product_key_hash: unknown;
  source_variant_key_hash: unknown;
  raw_provider_offer_id: unknown;
  raw_provider_product_id: unknown;
  raw_provider_variant_id: unknown;
  provider_packing: unknown;
  provider_grind_id: unknown;
}>;
type ExportRow = Readonly<{
  snapshot_ref: unknown;
  supplier_ref: unknown;
  source_identity_scheme: unknown;
  state: unknown;
  content_hash: unknown;
  batch_count: unknown;
  product_count: unknown;
  variant_count: unknown;
  offer_count: unknown;
  next_batch_number: unknown;
  last_batch_hash: unknown;
}>;
type BatchRow = Readonly<{
  batch_number: unknown;
  offer_count: unknown;
  uncompressed_bytes: unknown;
  batch_hash: unknown;
  previous_batch_hash: unknown;
}>;
type BulkBindingRow = BindingRow & Readonly<{ ordinal: unknown }>;
type ProviderOfferRow = Readonly<{
  offer_ref: unknown;
  supplier_ref: unknown;
  source_identity_scheme: unknown;
  source_offer_key_hash: unknown;
  raw_provider_offer_id: unknown;
  raw_provider_product_id: unknown;
  raw_provider_variant_id: unknown;
  provider_packing: unknown;
  provider_grind_id: unknown;
}>;

function row(value: BindingRow): OfferBindingResponse {
  if (
    typeof value.offer_ref !== "string" ||
    typeof value.supplier_ref !== "string" ||
    value.source_identity_scheme !== SCHEME ||
    typeof value.source_offer_key_hash !== "string" ||
    typeof value.first_snapshot_ref !== "string" ||
    value.state !== "Bound"
  )
    throw new OfferBindingStoreError("AROMA_BINDING_CONFLICT");
  return {
    offerRef: value.offer_ref,
    supplierRef: value.supplier_ref,
    sourceIdentityScheme: SCHEME,
    sourceOfferKeyHash: value.source_offer_key_hash,
    firstSnapshotRef: value.first_snapshot_ref,
    state: "Bound",
  };
}
function scalar(value: string): SqlScalar {
  return value;
}
function encodeProviderFact(value: string | null | undefined): string | null {
  return value === undefined
    ? null
    : value === null
      ? EXPLICIT_NULL_PROVIDER_FACT
      : value;
}
function decodeProviderFact(value: unknown): string | null | undefined {
  if (value === null) return undefined;
  if (typeof value === "string")
    return value === EXPLICIT_NULL_PROVIDER_FACT ? null : value;
  throw new OfferBindingStoreError("AROMA_BINDING_CONFLICT");
}
function sourceRowMatchesIdentity(
  source: SourceRow,
  identity: ProviderOfferIdentity,
): boolean {
  return (
    source.supplier_ref === identity.supplierRef &&
    source.source_identity_scheme === SCHEME &&
    source.source_offer_key_hash === identity.sourceOfferKeyHash &&
    (identity.sourceProductKeyHash === undefined ||
      source.source_product_key_hash === identity.sourceProductKeyHash) &&
    (identity.sourceVariantKeyHash === undefined ||
      source.source_variant_key_hash === identity.sourceVariantKeyHash) &&
    source.raw_provider_offer_id === identity.rawProviderOfferId &&
    source.raw_provider_product_id === identity.rawProviderProductId &&
    source.raw_provider_variant_id === identity.rawProviderVariantId &&
    decodeProviderFact(source.provider_packing) === identity.packing &&
    decodeProviderFact(source.provider_grind_id) === identity.grindId
  );
}
function integer(value: unknown): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^[0-9]+$/u.test(value)
        ? Number(value)
        : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0)
    throw new OfferBindingStoreError("AROMA_BINDING_CONFLICT");
  return parsed;
}
function text(value: unknown): string {
  if (typeof value !== "string")
    throw new OfferBindingStoreError("AROMA_BINDING_CONFLICT");
  return value;
}
function hashContent(rows: readonly BatchRow[]): string {
  const digest = createHash("sha256");
  for (const batch of rows)
    digest.update(Buffer.from(text(batch.batch_hash), "hex"));
  return digest.digest("hex");
}
function legacyBatchRecord(
  snapshotRef: string,
  identities: readonly ProviderOfferIdentity[],
): CatalogBatchRecord {
  return {
    streamVersion: "1",
    recordType: "snapshot-batch",
    snapshotRef,
    batchNumber: 0,
    offerCount: identities.length,
    uncompressedBytes: 2,
    batchHash: createHash("sha256")
      .update(JSON.stringify(identities))
      .digest("hex"),
    previousBatchHash: null,
    items: identities.map((identity) => ({
      sourceProductKeyHash:
        identity.sourceProductKeyHash ?? identity.sourceOfferKeyHash,
      sourceVariantKeyHash:
        identity.sourceVariantKeyHash ?? identity.sourceOfferKeyHash,
      sourceOfferKeyHash: identity.sourceOfferKeyHash,
      displayName: "legacy",
      unit: "piece",
      supplierUnitMinor: "1",
      currency: "RUB",
      availability: "Available",
      imageUrl: "",
      supplierPromotions: [],
      sourceIdentityScheme: SCHEME,
    })),
  };
}

export class OfferBindingRepository {
  private readonly insertExport: OwnerStatement<
    ExportRow,
    readonly SqlScalar[]
  >;
  private readonly readExport: OwnerStatement<ExportRow, readonly SqlScalar[]>;
  private readonly resetExport: OwnerStatement<
    Record<string, unknown>,
    readonly SqlScalar[]
  >;
  private readonly insertSource: OwnerStatement<
    Record<string, unknown>,
    readonly SqlScalar[]
  >;
  private readonly readSourceByRaw: OwnerStatement<
    SourceRow,
    readonly SqlScalar[]
  >;
  private readonly readSourceByHash: OwnerStatement<
    SourceRow,
    readonly SqlScalar[]
  >;
  private readonly insertExportOffer: OwnerStatement<
    Record<string, unknown>,
    readonly SqlScalar[]
  >;
  private readonly insertBatch: OwnerStatement<BatchRow, readonly SqlScalar[]>;
  private readonly readBatch: OwnerStatement<BatchRow, readonly SqlScalar[]>;
  private readonly readBatches: OwnerStatement<BatchRow, readonly SqlScalar[]>;
  private readonly insertBatchOffer: OwnerStatement<
    Record<string, unknown>,
    readonly SqlScalar[]
  >;
  private readonly readBatchOffers: OwnerStatement<
    Readonly<{ ordinal: unknown; source_offer_key_hash: unknown }>,
    readonly SqlScalar[]
  >;
  private readonly countMembership: OwnerStatement<
    Readonly<{
      membership_count: unknown;
      batch_membership_count: unknown;
      product_count: unknown;
      variant_count: unknown;
    }>,
    readonly SqlScalar[]
  >;
  private readonly completeExportStatement: OwnerStatement<
    ExportRow,
    readonly SqlScalar[]
  >;
  private readonly readMembership: OwnerStatement<
    MembershipRow,
    readonly SqlScalar[]
  >;
  private readonly insertBinding: OwnerStatement<
    BindingRow,
    readonly SqlScalar[]
  >;
  private readonly readBindingByOffer: OwnerStatement<
    BindingRow,
    readonly SqlScalar[]
  >;
  private readonly readBindingBySource: OwnerStatement<
    BindingRow,
    readonly SqlScalar[]
  >;
  private readonly resolveBinding: OwnerStatement<
    BindingRow,
    readonly SqlScalar[]
  >;
  private readonly resolveBindingByRaw: OwnerStatement<
    BindingRow,
    readonly SqlScalar[]
  >;
  private readonly resolveProviderOfferStatement: OwnerStatement<
    ProviderOfferRow,
    readonly SqlScalar[]
  >;
  private readonly resolveBindingByIdentityStatement: OwnerStatement<
    BindingRow,
    readonly SqlScalar[]
  >;
  private readonly resolveBindingBulkStatement: OwnerStatement<
    BulkBindingRow,
    readonly SqlScalar[]
  >;
  private readonly failExportStatement: OwnerStatement<
    Record<string, unknown>,
    readonly SqlScalar[]
  >;
  private readonly abortExportStatement: OwnerStatement<
    Record<string, unknown>,
    readonly SqlScalar[]
  >;
  private readonly deleteExportBatches: OwnerStatement<
    Record<string, unknown>,
    readonly SqlScalar[]
  >;
  private readonly updateExportCounters: OwnerStatement<
    Record<string, unknown>,
    readonly SqlScalar[]
  >;

  public constructor(database: Database) {
    this.insertExport = defineStatement(
      database,
      `INSERT INTO integration.provider_catalog_exports (snapshot_ref, supplier_ref, source_identity_scheme, state) VALUES ($1, $2, $3, 'Exporting') ON CONFLICT DO NOTHING RETURNING snapshot_ref, supplier_ref, source_identity_scheme, state, content_hash, batch_count, product_count, variant_count, offer_count, next_batch_number, last_batch_hash`,
    );
    this.readExport = defineStatement(
      database,
      `SELECT snapshot_ref, supplier_ref, source_identity_scheme, state, content_hash, batch_count, product_count, variant_count, offer_count, next_batch_number, last_batch_hash FROM integration.provider_catalog_exports WHERE snapshot_ref = $1 FOR UPDATE`,
    );
    this.resetExport = defineStatement(
      database,
      `UPDATE integration.provider_catalog_exports SET state = 'Exporting', content_hash = NULL, batch_count = 0, product_count = 0, variant_count = 0, offer_count = 0, next_batch_number = 0, last_batch_hash = NULL, updated_at = clock_timestamp() WHERE snapshot_ref = $1`,
    );
    this.insertSource = defineStatement(
      database,
      `INSERT INTO integration.provider_source_offers (supplier_ref, source_identity_scheme, source_offer_key_hash, source_product_key_hash, source_variant_key_hash, raw_provider_offer_id, raw_provider_product_id, raw_provider_variant_id, provider_packing, provider_grind_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT DO NOTHING RETURNING source_offer_key_hash`,
    );
    this.readSourceByRaw = defineStatement(
      database,
      `SELECT supplier_ref, source_identity_scheme, source_offer_key_hash, source_product_key_hash, source_variant_key_hash, raw_provider_offer_id, raw_provider_product_id, raw_provider_variant_id, provider_packing, provider_grind_id FROM integration.provider_source_offers WHERE supplier_ref = $1 AND source_identity_scheme = $2 AND raw_provider_offer_id = $3`,
    );
    this.readSourceByHash = defineStatement(
      database,
      `SELECT supplier_ref, source_identity_scheme, source_offer_key_hash, source_product_key_hash, source_variant_key_hash, raw_provider_offer_id, raw_provider_product_id, raw_provider_variant_id, provider_packing, provider_grind_id FROM integration.provider_source_offers WHERE supplier_ref = $1 AND source_identity_scheme = $2 AND source_offer_key_hash = $3`,
    );
    this.insertExportOffer = defineStatement(
      database,
      `INSERT INTO integration.provider_export_offers (snapshot_ref, supplier_ref, source_identity_scheme, source_offer_key_hash) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING source_offer_key_hash`,
    );
    this.insertBatch = defineStatement(
      database,
      `INSERT INTO integration.provider_export_batches (snapshot_ref, batch_number, offer_count, uncompressed_bytes, batch_hash, previous_batch_hash) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING RETURNING batch_number, offer_count, uncompressed_bytes, batch_hash, previous_batch_hash`,
    );
    this.readBatch = defineStatement(
      database,
      `SELECT batch_number, offer_count, uncompressed_bytes, batch_hash, previous_batch_hash FROM integration.provider_export_batches WHERE snapshot_ref = $1 AND batch_number = $2`,
    );
    this.readBatches = defineStatement(
      database,
      `SELECT batch_number, offer_count, uncompressed_bytes, batch_hash, previous_batch_hash FROM integration.provider_export_batches WHERE snapshot_ref = $1 ORDER BY batch_number`,
    );
    this.insertBatchOffer = defineStatement(
      database,
      `INSERT INTO integration.provider_export_batch_offers (snapshot_ref, batch_number, ordinal, supplier_ref, source_identity_scheme, source_offer_key_hash) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING RETURNING ordinal`,
    );
    this.readBatchOffers = defineStatement(
      database,
      `SELECT ordinal, source_offer_key_hash FROM integration.provider_export_batch_offers WHERE snapshot_ref = $1 AND batch_number = $2 ORDER BY ordinal`,
    );
    this.countMembership = defineStatement(
      database,
      `SELECT (SELECT count(*) FROM integration.provider_export_batch_offers WHERE snapshot_ref = $1 AND supplier_ref = $2 AND source_identity_scheme = $3) AS membership_count, (SELECT count(*) FROM integration.provider_export_batch_offers WHERE snapshot_ref = $1 AND supplier_ref = $2 AND source_identity_scheme = $3) AS batch_membership_count, (SELECT count(DISTINCT s.source_product_key_hash) FROM integration.provider_export_batch_offers m JOIN integration.provider_source_offers s ON s.supplier_ref = m.supplier_ref AND s.source_identity_scheme = m.source_identity_scheme AND s.source_offer_key_hash = m.source_offer_key_hash WHERE m.snapshot_ref = $1 AND m.supplier_ref = $2 AND m.source_identity_scheme = $3) AS product_count, (SELECT count(DISTINCT s.source_variant_key_hash) FROM integration.provider_export_batch_offers m JOIN integration.provider_source_offers s ON s.supplier_ref = m.supplier_ref AND s.source_identity_scheme = m.source_identity_scheme AND s.source_offer_key_hash = m.source_offer_key_hash WHERE m.snapshot_ref = $1 AND m.supplier_ref = $2 AND m.source_identity_scheme = $3) AS variant_count`,
    );
    this.completeExportStatement = defineStatement(
      database,
      `UPDATE integration.provider_catalog_exports SET state = 'Completed', content_hash = $2, batch_count = $3, product_count = $4, variant_count = $5, offer_count = $6, updated_at = clock_timestamp() WHERE snapshot_ref = $1 AND state = 'Exporting' RETURNING snapshot_ref, supplier_ref, source_identity_scheme, state, content_hash, batch_count, product_count, variant_count, offer_count, next_batch_number, last_batch_hash`,
    );
    this.readMembership = defineStatement(
      database,
      `SELECT EXISTS (SELECT 1 FROM integration.provider_source_offers WHERE supplier_ref = $1 AND source_identity_scheme = $2 AND source_offer_key_hash = $3) AS source_exists, COALESCE((SELECT state FROM integration.provider_catalog_exports WHERE snapshot_ref = $4 AND supplier_ref = $1 AND source_identity_scheme = $2), '') AS snapshot_state, EXISTS (SELECT 1 FROM integration.provider_export_batch_offers WHERE snapshot_ref = $4 AND supplier_ref = $1 AND source_identity_scheme = $2 AND source_offer_key_hash = $3) AS member`,
    );
    this.insertBinding = defineStatement(
      database,
      `INSERT INTO integration.provider_offer_bindings (offer_ref, supplier_ref, source_identity_scheme, source_offer_key_hash, first_snapshot_ref) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING RETURNING offer_ref, supplier_ref, source_identity_scheme, source_offer_key_hash, first_snapshot_ref, state`,
    );
    this.readBindingByOffer = defineStatement(
      database,
      `SELECT offer_ref, supplier_ref, source_identity_scheme, source_offer_key_hash, first_snapshot_ref, state FROM integration.provider_offer_bindings WHERE offer_ref = $1`,
    );
    this.readBindingBySource = defineStatement(
      database,
      `SELECT offer_ref, supplier_ref, source_identity_scheme, source_offer_key_hash, first_snapshot_ref, state FROM integration.provider_offer_bindings WHERE supplier_ref = $1 AND source_identity_scheme = $2 AND source_offer_key_hash = $3`,
    );
    this.resolveBinding = defineStatement(
      database,
      `SELECT offer_ref, supplier_ref, source_identity_scheme, source_offer_key_hash, first_snapshot_ref, state FROM integration.provider_offer_bindings WHERE supplier_ref = $1 AND source_identity_scheme = $2 AND source_offer_key_hash = $3`,
    );
    this.resolveBindingByRaw = defineStatement(
      database,
      `SELECT b.offer_ref, b.supplier_ref, b.source_identity_scheme, b.source_offer_key_hash, b.first_snapshot_ref, b.state FROM integration.provider_offer_bindings b JOIN integration.provider_source_offers s ON s.supplier_ref = b.supplier_ref AND s.source_identity_scheme = b.source_identity_scheme AND s.source_offer_key_hash = b.source_offer_key_hash WHERE b.source_identity_scheme = $1 AND b.supplier_ref = $2 AND s.raw_provider_offer_id = $3`,
    );
    this.resolveProviderOfferStatement = defineStatement(
      database,
      `SELECT b.offer_ref, s.supplier_ref, s.source_identity_scheme, s.source_offer_key_hash, s.raw_provider_offer_id, s.raw_provider_product_id, s.raw_provider_variant_id, s.provider_packing, s.provider_grind_id FROM integration.provider_offer_bindings b JOIN integration.provider_source_offers s ON s.supplier_ref = b.supplier_ref AND s.source_identity_scheme = b.source_identity_scheme AND s.source_offer_key_hash = b.source_offer_key_hash WHERE b.offer_ref = $1 AND b.supplier_ref = $2`,
    );
    this.resolveBindingByIdentityStatement = defineStatement(
      database,
      `SELECT b.offer_ref, b.supplier_ref, b.source_identity_scheme, b.source_offer_key_hash, b.first_snapshot_ref, b.state FROM integration.provider_offer_bindings b JOIN integration.provider_source_offers s ON s.supplier_ref = b.supplier_ref AND s.source_identity_scheme = b.source_identity_scheme AND s.source_offer_key_hash = b.source_offer_key_hash WHERE b.supplier_ref = $1 AND s.raw_provider_offer_id = $2 AND s.provider_packing IS NOT DISTINCT FROM $3 AND s.provider_grind_id IS NOT DISTINCT FROM $4`,
    );
    this.resolveBindingBulkStatement = defineStatement(
      database,
      `WITH requested AS (SELECT (r.ordinality - 1)::integer AS ordinal, r.value ->> 'offer_id' AS offer_id, r.value ->> 'packing' AS packing, r.value ->> 'grind_id' AS grind_id FROM jsonb_array_elements($3::jsonb) WITH ORDINALITY AS r(value, ordinality)) SELECT r.ordinal, b.offer_ref, b.supplier_ref, b.source_identity_scheme, b.source_offer_key_hash, b.first_snapshot_ref, b.state FROM requested r JOIN integration.provider_source_offers s ON s.supplier_ref = $1 AND s.source_identity_scheme = $2 AND s.raw_provider_offer_id = r.offer_id AND s.provider_packing IS NOT DISTINCT FROM r.packing AND s.provider_grind_id IS NOT DISTINCT FROM r.grind_id JOIN integration.provider_offer_bindings b ON b.supplier_ref = $1 AND b.supplier_ref = s.supplier_ref AND b.source_identity_scheme = $2 AND b.source_identity_scheme = s.source_identity_scheme AND b.source_offer_key_hash = s.source_offer_key_hash ORDER BY r.ordinal`,
    );
    this.failExportStatement = defineStatement(
      database,
      `UPDATE integration.provider_catalog_exports SET state = 'Failed', updated_at = clock_timestamp() WHERE snapshot_ref = $1 AND state = 'Exporting'`,
    );
    this.abortExportStatement = defineStatement(
      database,
      `UPDATE integration.provider_catalog_exports SET state = 'Failed', content_hash = NULL, batch_count = 0, product_count = 0, variant_count = 0, offer_count = 0, next_batch_number = 0, last_batch_hash = NULL, updated_at = clock_timestamp() WHERE snapshot_ref = $1 AND state = 'Exporting'`,
    );
    this.deleteExportBatches = defineStatement(
      database,
      `DELETE FROM integration.provider_export_batches WHERE snapshot_ref = $1`,
    );
    this.updateExportCounters = defineStatement(
      database,
      `UPDATE integration.provider_catalog_exports SET batch_count = batch_count + 1, product_count = (SELECT count(DISTINCT s.source_product_key_hash) FROM integration.provider_export_batch_offers m JOIN integration.provider_source_offers s ON s.supplier_ref = m.supplier_ref AND s.source_identity_scheme = m.source_identity_scheme AND s.source_offer_key_hash = m.source_offer_key_hash WHERE m.snapshot_ref = $1), variant_count = (SELECT count(DISTINCT s.source_variant_key_hash) FROM integration.provider_export_batch_offers m JOIN integration.provider_source_offers s ON s.supplier_ref = m.supplier_ref AND s.source_identity_scheme = m.source_identity_scheme AND s.source_offer_key_hash = m.source_offer_key_hash WHERE m.snapshot_ref = $1), offer_count = (SELECT count(*) FROM integration.provider_export_batch_offers WHERE snapshot_ref = $1), next_batch_number = $2, last_batch_hash = $3, updated_at = clock_timestamp() WHERE snapshot_ref = $1`,
    );
  }

  public async beginExport(
    transaction: Transaction,
    snapshotRef: string,
    supplierRef: string,
  ): Promise<void> {
    const inserted = await this.insertExport(transaction, [
      scalar(snapshotRef),
      scalar(supplierRef),
      SCHEME,
    ]);
    if (inserted.rowCount === 1) return;
    const existing = (await this.readExport(transaction, [scalar(snapshotRef)]))
      .rows[0];
    if (
      existing?.supplier_ref !== supplierRef ||
      existing.source_identity_scheme !== SCHEME
    )
      throw new OfferBindingStoreError("AROMA_BINDING_CONFLICT");
    if (existing.state === "Exporting")
      throw new OfferBindingStoreError("AROMA_BINDING_CONFLICT");
    if (existing.state === "Completed")
      throw new OfferBindingStoreError("AROMA_BINDING_CONFLICT");
    await this.deleteExportBatches(transaction, [scalar(snapshotRef)]);
    await this.resetExport(transaction, [scalar(snapshotRef)]);
  }

  public async recordBatch(
    transaction: Transaction,
    snapshotRef: string,
    supplierRef: string,
    recordOrIdentities: CatalogBatchRecord | readonly ProviderOfferIdentity[],
    identitiesArg?: readonly ProviderOfferIdentity[],
  ): Promise<void> {
    const legacy = Array.isArray(recordOrIdentities);
    const identities = (legacy ? recordOrIdentities : identitiesArg) ?? [];
    const record: CatalogBatchRecord = legacy
      ? legacyBatchRecord(snapshotRef, identities)
      : (recordOrIdentities as CatalogBatchRecord);
    if (!legacy) {
      const canonicalItems = Buffer.from(
        canonicalCatalogJson(record.items as never),
        "utf8",
      );
      if (
        record.snapshotRef !== snapshotRef ||
        record.recordType !== "snapshot-batch" ||
        record.streamVersion !== "1" ||
        record.items.length !== record.offerCount ||
        record.offerCount <= 0 ||
        record.offerCount > MAX_BATCH ||
        record.uncompressedBytes !== canonicalItems.byteLength ||
        sha256CatalogHash(canonicalItems, "batch") !== record.batchHash
      )
        throw new OfferBindingStoreError("AROMA_BINDING_CONFLICT");
    }
    const exportRow = (
      await this.readExport(transaction, [scalar(snapshotRef)])
    ).rows[0];
    if (
      exportRow?.supplier_ref !== supplierRef ||
      exportRow.source_identity_scheme !== SCHEME ||
      exportRow.state !== "Exporting"
    )
      throw new OfferBindingStoreError("AROMA_BINDING_SNAPSHOT_INCOMPLETE");
    const nextBatch = integer(exportRow.next_batch_number);
    const existing = (
      await this.readBatch(transaction, [
        scalar(snapshotRef),
        record.batchNumber,
      ])
    ).rows[0];
    if (existing !== undefined) {
      const stored = (
        await this.readBatchOffers(transaction, [
          scalar(snapshotRef),
          record.batchNumber,
        ])
      ).rows;
      if (
        integer(existing.offer_count) !== record.offerCount ||
        integer(existing.uncompressed_bytes) !== record.uncompressedBytes ||
        text(existing.batch_hash) !== record.batchHash ||
        (existing.previous_batch_hash ?? null) !== record.previousBatchHash ||
        stored.length !== identities.length ||
        stored.some(
          (value, index) =>
            value.ordinal !== index ||
            value.source_offer_key_hash !==
              identities[index]?.sourceOfferKeyHash,
        )
      )
        throw new OfferBindingStoreError("AROMA_BINDING_CONFLICT");
      for (const identity of identities) {
        const saved = (
          await this.readSourceByHash(transaction, [
            scalar(identity.supplierRef),
            SCHEME,
            scalar(identity.sourceOfferKeyHash),
          ])
        ).rows[0];
        if (saved === undefined || !sourceRowMatchesIdentity(saved, identity))
          throw new OfferBindingStoreError("AROMA_BINDING_CONFLICT");
      }
      return;
    }
    if (
      record.batchNumber !== nextBatch ||
      (record.batchNumber === 0
        ? record.previousBatchHash !== null
        : record.previousBatchHash !== text(exportRow.last_batch_hash))
    )
      throw new OfferBindingStoreError("AROMA_BINDING_CONFLICT");
    for (const [index, identity] of identities.entries()) {
      if (
        identity.supplierRef !== supplierRef ||
        identity.sourceIdentityScheme !== SCHEME ||
        record.items[index]?.sourceOfferKeyHash !==
          identity.sourceOfferKeyHash ||
        record.items[index]?.sourceProductKeyHash !==
          (identity.sourceProductKeyHash ??
            record.items[index]?.sourceProductKeyHash) ||
        record.items[index]?.sourceVariantKeyHash !==
          (identity.sourceVariantKeyHash ??
            record.items[index]?.sourceVariantKeyHash)
      )
        throw new OfferBindingStoreError("AROMA_BINDING_CONFLICT");
      const inserted = await this.insertSource(transaction, [
        scalar(supplierRef),
        SCHEME,
        scalar(identity.sourceOfferKeyHash),
        scalar(
          identity.sourceProductKeyHash ??
            record.items[index]!.sourceProductKeyHash,
        ),
        scalar(
          identity.sourceVariantKeyHash ??
            record.items[index]!.sourceVariantKeyHash,
        ),
        scalar(identity.rawProviderOfferId),
        scalar(identity.rawProviderProductId),
        scalar(identity.rawProviderVariantId),
        encodeProviderFact(identity.packing),
        encodeProviderFact(identity.grindId),
      ]);
      if (inserted.rowCount === 0) {
        const existingRaw = (
          await this.readSourceByRaw(transaction, [
            scalar(supplierRef),
            SCHEME,
            scalar(identity.rawProviderOfferId),
          ])
        ).rows[0];
        const existingHash = (
          await this.readSourceByHash(transaction, [
            scalar(supplierRef),
            SCHEME,
            scalar(identity.sourceOfferKeyHash),
          ])
        ).rows[0];
        if (
          existingRaw === undefined ||
          existingHash === undefined ||
          !sourceRowMatchesIdentity(existingRaw, identity) ||
          !sourceRowMatchesIdentity(existingHash, identity)
        )
          throw new OfferBindingStoreError("AROMA_BINDING_CONFLICT");
      }
      await this.insertExportOffer(transaction, [
        scalar(snapshotRef),
        scalar(supplierRef),
        SCHEME,
        scalar(identity.sourceOfferKeyHash),
      ]);
    }
    await this.insertBatch(transaction, [
      scalar(snapshotRef),
      scalar(record.batchNumber.toString()),
      scalar(record.offerCount.toString()),
      scalar(record.uncompressedBytes.toString()),
      scalar(record.batchHash),
      record.previousBatchHash === null
        ? null
        : scalar(record.previousBatchHash),
    ]);
    for (const [ordinal, identity] of identities.entries())
      await this.insertBatchOffer(transaction, [
        scalar(snapshotRef),
        scalar(record.batchNumber.toString()),
        scalar(ordinal.toString()),
        scalar(supplierRef),
        SCHEME,
        scalar(identity.sourceOfferKeyHash),
      ]);
    await this.updateExportCounters(transaction, [
      snapshotRef,
      record.batchNumber + 1,
      record.batchHash,
    ]);
  }

  public async isBatchRecorded(
    transaction: Transaction,
    snapshotRef: string,
    supplierRef: string,
    record: CatalogBatchRecord,
    identities: readonly ProviderOfferIdentity[],
  ): Promise<boolean> {
    const exportRow = (
      await this.readExport(transaction, [scalar(snapshotRef)])
    ).rows[0];
    if (
      exportRow?.supplier_ref !== supplierRef ||
      exportRow.source_identity_scheme !== SCHEME ||
      !["Exporting", "Completed"].includes(String(exportRow.state))
    )
      return false;
    if (
      integer(exportRow.next_batch_number) < record.batchNumber + 1 ||
      text(exportRow.last_batch_hash) !== record.batchHash
    )
      return false;
    const existing = (
      await this.readBatch(transaction, [
        scalar(snapshotRef),
        record.batchNumber,
      ])
    ).rows[0];
    if (
      existing === undefined ||
      integer(existing.offer_count) !== record.offerCount ||
      integer(existing.uncompressed_bytes) !== record.uncompressedBytes ||
      text(existing.batch_hash) !== record.batchHash ||
      (existing.previous_batch_hash ?? null) !== record.previousBatchHash
    )
      return false;
    const stored = (
      await this.readBatchOffers(transaction, [
        scalar(snapshotRef),
        record.batchNumber,
      ])
    ).rows;
    if (
      stored.length !== identities.length ||
      stored.some(
        (value, index) =>
          value.ordinal !== index ||
          value.source_offer_key_hash !== identities[index]?.sourceOfferKeyHash,
      )
    )
      return false;
    for (const [index, identity] of identities.entries()) {
      const item = record.items[index];
      if (
        identity.supplierRef !== supplierRef ||
        identity.sourceIdentityScheme !== SCHEME ||
        item?.sourceOfferKeyHash !== identity.sourceOfferKeyHash ||
        item?.sourceProductKeyHash !==
          (identity.sourceProductKeyHash ?? item?.sourceProductKeyHash) ||
        item?.sourceVariantKeyHash !==
          (identity.sourceVariantKeyHash ?? item?.sourceVariantKeyHash)
      )
        return false;
      const saved = (
        await this.readSourceByHash(transaction, [
          scalar(identity.supplierRef),
          SCHEME,
          scalar(identity.sourceOfferKeyHash),
        ])
      ).rows[0];
      if (saved === undefined || !sourceRowMatchesIdentity(saved, identity))
        return false;
    }
    return true;
  }

  public async isExportCompleted(
    transaction: Transaction,
    snapshotRef: string,
    expected: CatalogExportSummary | string,
  ): Promise<boolean> {
    const existing = (await this.readExport(transaction, [scalar(snapshotRef)]))
      .rows[0];
    if (existing?.state !== "Completed") return false;
    if (typeof expected === "string") return existing.content_hash === expected;
    return (
      existing.supplier_ref === expected.supplierRef &&
      existing.source_identity_scheme === SCHEME &&
      existing.content_hash === expected.contentHash &&
      integer(existing.batch_count) === expected.batchCount &&
      integer(existing.product_count) === expected.productCount &&
      integer(existing.variant_count) === expected.variantCount &&
      integer(existing.offer_count) === expected.offerCount
    );
  }

  public async completeExport(
    transaction: Transaction,
    snapshotRef: string,
    summaryOrHash: CatalogExportSummary | string,
  ): Promise<void> {
    if (typeof summaryOrHash === "string") {
      const existing = (
        await this.readExport(transaction, [scalar(snapshotRef)])
      ).rows[0];
      if (existing?.state === "Completed") {
        if (existing.content_hash === summaryOrHash) return;
        throw new OfferBindingStoreError("AROMA_BINDING_SNAPSHOT_INCOMPLETE");
      }
      if (existing?.state !== "Exporting")
        throw new OfferBindingStoreError("AROMA_BINDING_SNAPSHOT_INCOMPLETE");
      const updatedLegacy = await this.completeExportStatement(transaction, [
        scalar(snapshotRef),
        scalar(summaryOrHash),
        scalar(integer(existing.batch_count).toString()),
        scalar(integer(existing.product_count).toString()),
        scalar(integer(existing.variant_count).toString()),
        scalar(integer(existing.offer_count).toString()),
      ]);
      if (updatedLegacy.rowCount !== 1)
        throw new OfferBindingStoreError("AROMA_BINDING_SNAPSHOT_INCOMPLETE");
      return;
    }
    const summary = summaryOrHash;
    const exportRow = (
      await this.readExport(transaction, [scalar(snapshotRef)])
    ).rows[0];
    if (exportRow === undefined || exportRow.source_identity_scheme !== SCHEME)
      throw new OfferBindingStoreError("AROMA_BINDING_SNAPSHOT_INCOMPLETE");
    if (exportRow.state === "Completed") {
      if (
        exportRow.content_hash === summary.contentHash &&
        integer(exportRow.batch_count) === summary.batchCount &&
        integer(exportRow.product_count) === summary.productCount &&
        integer(exportRow.variant_count) === summary.variantCount &&
        integer(exportRow.offer_count) === summary.offerCount
      )
        return;
      throw new OfferBindingStoreError("AROMA_BINDING_CONFLICT");
    }
    if (
      exportRow.state !== "Exporting" ||
      exportRow.supplier_ref !== summary.supplierRef
    )
      throw new OfferBindingStoreError("AROMA_BINDING_SNAPSHOT_INCOMPLETE");
    const batches = (await this.readBatches(transaction, [scalar(snapshotRef)]))
      .rows;
    if (
      batches.length !== summary.batchCount ||
      batches.length !== integer(exportRow.batch_count) ||
      integer(exportRow.next_batch_number) !== summary.batchCount
    )
      throw new OfferBindingStoreError("AROMA_BINDING_SNAPSHOT_INCOMPLETE");
    let previous: string | null = null;
    for (const [number, batch] of batches.entries()) {
      if (
        integer(batch.batch_number) !== number ||
        (batch.previous_batch_hash ?? null) !== previous
      )
        throw new OfferBindingStoreError("AROMA_BINDING_CONFLICT");
      previous = text(batch.batch_hash);
    }
    const counts = (
      await this.countMembership(transaction, [
        scalar(snapshotRef),
        scalar(summary.supplierRef),
        SCHEME,
      ])
    ).rows[0];
    if (
      counts === undefined ||
      integer(counts.membership_count) !==
        integer(counts.batch_membership_count) ||
      integer(counts.batch_membership_count) !== summary.offerCount ||
      integer(counts.product_count) !== summary.productCount ||
      integer(counts.variant_count) !== summary.variantCount ||
      integer(exportRow.offer_count) !== summary.offerCount ||
      integer(exportRow.product_count) !== summary.productCount ||
      integer(exportRow.variant_count) !== summary.variantCount ||
      hashContent(batches) !== summary.contentHash
    )
      throw new OfferBindingStoreError("AROMA_BINDING_SNAPSHOT_INCOMPLETE");
    const updated = await this.completeExportStatement(transaction, [
      scalar(snapshotRef),
      scalar(summary.contentHash),
      scalar(summary.batchCount.toString()),
      scalar(summary.productCount.toString()),
      scalar(summary.variantCount.toString()),
      scalar(summary.offerCount.toString()),
    ]);
    if (updated.rowCount !== 1)
      throw new OfferBindingStoreError("AROMA_BINDING_SNAPSHOT_INCOMPLETE");
  }

  public async failExport(
    transaction: Transaction,
    snapshotRef: string,
  ): Promise<void> {
    await this.failExportStatement(transaction, [scalar(snapshotRef)]);
  }
  public async abortExport(
    transaction: Transaction,
    snapshotRef: string,
  ): Promise<void> {
    const current = (await this.readExport(transaction, [scalar(snapshotRef)]))
      .rows[0];
    if (current?.state !== "Exporting") return;
    await this.deleteExportBatches(transaction, [scalar(snapshotRef)]);
    await this.abortExportStatement(transaction, [scalar(snapshotRef)]);
  }

  public async register(
    transaction: Transaction,
    request: OfferBindingRequest,
  ): Promise<OfferBindingResponse> {
    if (
      !isAromaOfferBindingRequest(request) ||
      request.sourceIdentityScheme !== SCHEME
    )
      throw new OfferBindingStoreError("AROMA_BINDING_CONFLICT");
    const membership = (
      await this.readMembership(transaction, [
        scalar(request.supplierRef),
        SCHEME,
        scalar(request.sourceOfferKeyHash),
        scalar(request.snapshotRef),
      ])
    ).rows[0];
    if (membership?.source_exists !== true)
      throw new OfferBindingStoreError("AROMA_BINDING_SOURCE_NOT_FOUND");
    if (membership.snapshot_state !== "Completed" || membership.member !== true)
      throw new OfferBindingStoreError("AROMA_BINDING_SNAPSHOT_INCOMPLETE");
    const inserted = await this.insertBinding(transaction, [
      scalar(request.offerRef),
      scalar(request.supplierRef),
      SCHEME,
      scalar(request.sourceOfferKeyHash),
      scalar(request.snapshotRef),
    ]);
    if (inserted.rowCount === 1) return row(inserted.rows[0]!);
    const existingOffer = (
      await this.readBindingByOffer(transaction, [scalar(request.offerRef)])
    ).rows[0];
    if (existingOffer !== undefined) {
      const existing = row(existingOffer);
      if (
        existing.supplierRef === request.supplierRef &&
        existing.sourceIdentityScheme === SCHEME &&
        existing.sourceOfferKeyHash === request.sourceOfferKeyHash
      )
        return existing;
    }
    throw new OfferBindingStoreError("AROMA_BINDING_CONFLICT");
  }
  public async resolve(
    transaction: Transaction,
    supplierRef: string,
    sourceOfferKeyHash: string,
  ): Promise<OfferBindingResponse | undefined> {
    const existing = (
      await this.resolveBinding(transaction, [
        scalar(supplierRef),
        SCHEME,
        scalar(sourceOfferKeyHash),
      ])
    ).rows[0];
    return existing === undefined ? undefined : row(existing);
  }
  public async resolveByRawProviderOfferId(
    transaction: Transaction,
    rawProviderOfferId: string,
    supplierRef: string,
  ): Promise<OfferBindingResponse | undefined> {
    if (
      rawProviderOfferId.length === 0 ||
      rawProviderOfferId.includes("\u0000")
    )
      throw new OfferBindingStoreError("AROMA_BINDING_CONFLICT");
    const matches = (
      await this.resolveBindingByRaw(transaction, [
        SCHEME,
        scalar(supplierRef),
        scalar(rawProviderOfferId),
      ])
    ).rows;
    if (matches.length > 1)
      throw new OfferBindingStoreError("AROMA_BINDING_CONFLICT");
    return matches[0] === undefined ? undefined : row(matches[0]);
  }
  public async resolveProviderOffer(
    transaction: Transaction,
    offerRef: string,
    supplierRef: string,
  ): Promise<ResolvedProviderOffer | undefined> {
    const matches = (
      await this.resolveProviderOfferStatement(transaction, [
        scalar(offerRef),
        scalar(supplierRef),
      ])
    ).rows;
    if (matches.length > 1)
      throw new OfferBindingStoreError("AROMA_BINDING_CONFLICT");
    const value = matches[0];
    if (
      value === undefined ||
      typeof value.offer_ref !== "string" ||
      typeof value.supplier_ref !== "string" ||
      typeof value.source_offer_key_hash !== "string" ||
      typeof value.raw_provider_offer_id !== "string" ||
      typeof value.raw_provider_product_id !== "string" ||
      typeof value.raw_provider_variant_id !== "string"
    ) {
      if (value === undefined) return undefined;
      throw new OfferBindingStoreError("AROMA_BINDING_CONFLICT");
    }
    const packing = decodeProviderFact(value.provider_packing);
    const grindId = decodeProviderFact(value.provider_grind_id);
    return {
      offerRef: value.offer_ref,
      supplierRef: value.supplier_ref,
      sourceIdentityScheme: SCHEME,
      sourceOfferKeyHash: value.source_offer_key_hash,
      rawProviderOfferId: value.raw_provider_offer_id,
      rawProviderProductId: value.raw_provider_product_id,
      rawProviderVariantId: value.raw_provider_variant_id,
      ...(packing === undefined ? {} : { packing }),
      ...(grindId === undefined ? {} : { grindId }),
      cartLineId: null,
    };
  }
  public async resolveByProviderIdentity(
    transaction: Transaction,
    identity: CartProviderIdentity,
    supplierRef: string,
  ): Promise<CartBinding | undefined> {
    const matches = (
      await this.resolveBindingByIdentityStatement(transaction, [
        scalar(supplierRef),
        scalar(identity.offerId),
        encodeProviderFact(identity.packing),
        encodeProviderFact(identity.grindId),
      ])
    ).rows;
    if (matches.length > 1)
      throw new OfferBindingStoreError("AROMA_BINDING_CONFLICT");
    return matches[0] === undefined
      ? undefined
      : { ...row(matches[0]), providerIdentity: identity };
  }
  public async resolveByProviderIdentities(
    transaction: Transaction,
    identities: readonly CartProviderIdentity[],
    supplierRef: string,
  ): Promise<readonly (CartBinding | undefined)[]> {
    if (identities.length > MAX_BULK_IDENTITIES)
      throw new OfferBindingStoreError("AROMA_BINDING_CONFLICT");
    const payload = JSON.stringify(
      identities.map((identity) => ({
        offer_id: identity.offerId,
        packing: encodeProviderFact(identity.packing),
        grind_id: encodeProviderFact(identity.grindId),
      })),
    );
    const rows = (
      await this.resolveBindingBulkStatement(transaction, [
        scalar(supplierRef),
        SCHEME,
        scalar(payload),
      ])
    ).rows;
    const result: Array<CartBinding | undefined> = identities.map(
      () => undefined,
    );
    for (const match of rows) {
      const index = integer(match.ordinal);
      if (index >= result.length || result[index] !== undefined)
        throw new OfferBindingStoreError("AROMA_BINDING_CONFLICT");
      result[index] = { ...row(match), providerIdentity: identities[index]! };
    }
    return result;
  }
}

export class OfferBindingStore {
  private readonly repository: OfferBindingRepository;
  private readonly database: Database;
  public constructor(database: Database) {
    this.database = database;
    this.repository = new OfferBindingRepository(database);
  }
  private async runExportWriteWithReread(
    operation: () => Promise<void>,
    reread: (transaction: Transaction) => Promise<boolean>,
  ): Promise<void> {
    try {
      await operation();
      return;
    } catch (error) {
      if (!isUnknownCommit(error)) throw error;
      try {
        const recovered = await withTransaction(
          this.database,
          {
            mode: "interactive",
            signal: AbortSignal.timeout(EXPORT_OUTCOME_REREAD_TIMEOUT_MS),
          },
          reread,
        );
        if (recovered) return;
      } catch {
        // A failed reread cannot prove the commit; retain the safe unknown outcome.
      }
      throw error;
    }
  }
  public beginExport(
    snapshotRef: string,
    supplierRef: string,
    signal?: AbortSignal,
  ): Promise<void> {
    return withTransaction(
      this.database,
      { mode: "interactive", ...(signal === undefined ? {} : { signal }) },
      (transaction) =>
        this.repository.beginExport(transaction, snapshotRef, supplierRef),
    );
  }
  public recordBatch(
    snapshotRef: string,
    supplierRef: string,
    recordOrIdentities: CatalogBatchRecord | readonly ProviderOfferIdentity[],
    identitiesOrSignal?: readonly ProviderOfferIdentity[] | AbortSignal,
    signal?: AbortSignal,
  ): Promise<void> {
    const legacy = Array.isArray(recordOrIdentities);
    const identities = legacy
      ? recordOrIdentities
      : Array.isArray(identitiesOrSignal)
        ? identitiesOrSignal
        : [];
    const record = legacy
      ? legacyBatchRecord(snapshotRef, identities)
      : (recordOrIdentities as CatalogBatchRecord);
    const actualSignal =
      signal ??
      (identitiesOrSignal instanceof AbortSignal
        ? identitiesOrSignal
        : undefined);
    return this.runExportWriteWithReread(
      () =>
        withTransaction(
          this.database,
          {
            mode: "interactive",
            ...(actualSignal === undefined ? {} : { signal: actualSignal }),
          },
          (transaction) =>
            legacy
              ? this.repository.recordBatch(
                  transaction,
                  snapshotRef,
                  supplierRef,
                  identities,
                )
              : this.repository.recordBatch(
                  transaction,
                  snapshotRef,
                  supplierRef,
                  record,
                  identities,
                ),
        ),
      (transaction) =>
        this.repository.isBatchRecorded(
          transaction,
          snapshotRef,
          supplierRef,
          record,
          identities,
        ),
    );
  }
  public completeExport(
    summaryOrSnapshot: CatalogExportSummary | string,
    hashOrSignal?: string | AbortSignal,
    signal?: AbortSignal,
  ): Promise<void> {
    const summary =
      typeof summaryOrSnapshot === "string" ? undefined : summaryOrSnapshot;
    const snapshotRef =
      typeof summaryOrSnapshot === "string"
        ? summaryOrSnapshot
        : summaryOrSnapshot.snapshotRef;
    const legacyHash =
      typeof summaryOrSnapshot === "string"
        ? (hashOrSignal as string)
        : undefined;
    const expected = summary ?? legacyHash!;
    const actualSignal =
      signal ??
      (hashOrSignal instanceof AbortSignal ? hashOrSignal : undefined);
    return this.runExportWriteWithReread(
      () =>
        withTransaction(
          this.database,
          {
            mode: "interactive",
            ...(actualSignal === undefined ? {} : { signal: actualSignal }),
          },
          (transaction) =>
            summary === undefined
              ? this.repository.completeExport(
                  transaction,
                  snapshotRef,
                  legacyHash!,
                )
              : this.repository.completeExport(
                  transaction,
                  snapshotRef,
                  summary,
                ),
        ),
      (transaction) =>
        this.repository.isExportCompleted(transaction, snapshotRef, expected),
    );
  }
  public failExport(snapshotRef: string, signal?: AbortSignal): Promise<void> {
    return withTransaction(
      this.database,
      { mode: "interactive", ...(signal === undefined ? {} : { signal }) },
      (transaction) => this.repository.failExport(transaction, snapshotRef),
    );
  }
  public abortExport(snapshotRef: string, signal?: AbortSignal): Promise<void> {
    return withTransaction(
      this.database,
      { mode: "interactive", ...(signal === undefined ? {} : { signal }) },
      (transaction) => this.repository.abortExport(transaction, snapshotRef),
    );
  }
  public register(
    request: OfferBindingRequest,
    signal?: AbortSignal,
  ): Promise<OfferBindingResponse> {
    return withTransaction(
      this.database,
      { mode: "interactive", ...(signal === undefined ? {} : { signal }) },
      (transaction) => this.repository.register(transaction, request),
    );
  }
  public resolve(
    supplierRef: string,
    sourceOfferKeyHash: string,
    signal?: AbortSignal,
  ): Promise<OfferBindingResponse | undefined> {
    return withTransaction(
      this.database,
      { mode: "interactive", ...(signal === undefined ? {} : { signal }) },
      (transaction) =>
        this.repository.resolve(transaction, supplierRef, sourceOfferKeyHash),
    );
  }
  public resolveByRawProviderOfferId(
    rawProviderOfferId: string,
    supplierRef: string,
    signal?: AbortSignal,
  ): Promise<OfferBindingResponse | undefined> {
    return withTransaction(
      this.database,
      { mode: "interactive", ...(signal === undefined ? {} : { signal }) },
      (transaction) =>
        this.repository.resolveByRawProviderOfferId(
          transaction,
          rawProviderOfferId,
          supplierRef,
        ),
    );
  }
  public resolveProviderOffer(
    offerRef: string,
    supplierRef: string,
    signal?: AbortSignal,
  ): Promise<ResolvedProviderOffer | undefined> {
    return withTransaction(
      this.database,
      { mode: "interactive", ...(signal === undefined ? {} : { signal }) },
      (transaction) =>
        this.repository.resolveProviderOffer(
          transaction,
          offerRef,
          supplierRef,
        ),
    );
  }
  public resolveByProviderIdentity(
    identity: CartProviderIdentity,
    supplierRef: string,
    signal?: AbortSignal,
  ): Promise<CartBinding | undefined> {
    return withTransaction(
      this.database,
      { mode: "interactive", ...(signal === undefined ? {} : { signal }) },
      (transaction) =>
        this.repository.resolveByProviderIdentity(
          transaction,
          identity,
          supplierRef,
        ),
    );
  }
  public resolveByProviderIdentities(
    identities: readonly CartProviderIdentity[],
    supplierRef: string,
    signal?: AbortSignal,
  ): Promise<readonly (CartBinding | undefined)[]> {
    return withTransaction(
      this.database,
      { mode: "interactive", ...(signal === undefined ? {} : { signal }) },
      (transaction) =>
        this.repository.resolveByProviderIdentities(
          transaction,
          identities,
          supplierRef,
        ),
    );
  }
}
