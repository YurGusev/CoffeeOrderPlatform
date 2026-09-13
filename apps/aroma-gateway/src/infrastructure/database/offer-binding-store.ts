import {withTransaction, type Database, type SqlScalar, type Transaction} from "@coffee-platform/database";
import {defineStatement, type OwnerStatement} from "@coffee-platform/database/owner";
import {isAromaOfferBindingRequest, type AromaOfferBindingRequest, type AromaOfferBindingResponse} from "@coffee-platform/contracts-aroma-v1";

const SCHEME = "hmac-sha256-v1" as const;
const MAX_BATCH = 500;
// Existing nullable columns can represent absent (SQL NULL) and explicit null
// (empty string) without a migration. Provider/source strings are validated as
// non-empty, so the marker cannot collide with a real identity value.
const EXPLICIT_NULL_PROVIDER_FACT = "";

type OfferBindingRequest = AromaOfferBindingRequest;
type OfferBindingResponse = AromaOfferBindingResponse;
export type {OfferBindingRequest, OfferBindingResponse};

export type ProviderOfferIdentity = Readonly<{
  supplierRef: string;
  sourceIdentityScheme: typeof SCHEME;
  sourceOfferKeyHash: string;
  rawProviderOfferId: string;
  rawProviderProductId: string;
  rawProviderVariantId: string;
  packing?: string | null;
  grindId?: string | null;
}>;

export type ResolvedProviderOffer = Readonly<ProviderOfferIdentity & {offerRef: string; cartLineId: string | null}>;

export class OfferBindingStoreError extends Error {
  public readonly code: "AROMA_BINDING_CONFLICT" | "AROMA_BINDING_SOURCE_NOT_FOUND" | "AROMA_BINDING_SNAPSHOT_INCOMPLETE";
  public constructor(code: "AROMA_BINDING_CONFLICT" | "AROMA_BINDING_SOURCE_NOT_FOUND" | "AROMA_BINDING_SNAPSHOT_INCOMPLETE") {
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

type MembershipRow = Readonly<{source_exists: unknown; snapshot_state: unknown; member: unknown}>;

type SourceRow = Readonly<{
  supplier_ref: unknown;
  source_identity_scheme: unknown;
  source_offer_key_hash: unknown;
  raw_provider_offer_id: unknown;
  raw_provider_product_id: unknown;
  raw_provider_variant_id: unknown;
  provider_packing: unknown;
  provider_grind_id: unknown;
}>;

function row(row: BindingRow): OfferBindingResponse {
  if (typeof row.offer_ref !== "string" || typeof row.supplier_ref !== "string" ||
    row.source_identity_scheme !== SCHEME || typeof row.source_offer_key_hash !== "string" ||
    typeof row.first_snapshot_ref !== "string" || row.state !== "Bound") {
    throw new OfferBindingStoreError("AROMA_BINDING_CONFLICT");
  }
  return {
    offerRef: row.offer_ref,
    supplierRef: row.supplier_ref,
    sourceIdentityScheme: SCHEME,
    sourceOfferKeyHash: row.source_offer_key_hash,
    firstSnapshotRef: row.first_snapshot_ref,
    state: "Bound",
  };
}

function scalar(value: string): SqlScalar { return value; }

function encodeProviderFact(value: string | null | undefined): string | null {
  return value === undefined ? null : value === null ? EXPLICIT_NULL_PROVIDER_FACT : value;
}

function decodeProviderFact(value: unknown): string | null | undefined {
  if (value === null) return undefined;
  if (typeof value === "string") return value === EXPLICIT_NULL_PROVIDER_FACT ? null : value;
  throw new OfferBindingStoreError("AROMA_BINDING_CONFLICT");
}

function sourceRowMatchesIdentity(source: SourceRow, identity: ProviderOfferIdentity): boolean {
  return source.supplier_ref === identity.supplierRef &&
    source.source_identity_scheme === SCHEME &&
    source.source_offer_key_hash === identity.sourceOfferKeyHash &&
    source.raw_provider_offer_id === identity.rawProviderOfferId &&
    source.raw_provider_product_id === identity.rawProviderProductId &&
    source.raw_provider_variant_id === identity.rawProviderVariantId &&
    decodeProviderFact(source.provider_packing) === identity.packing &&
    decodeProviderFact(source.provider_grind_id) === identity.grindId;
}

export class OfferBindingRepository {
  private readonly insertExport: OwnerStatement<Readonly<{snapshot_ref: string}>, readonly SqlScalar[]>;
  private readonly readExport: OwnerStatement<Readonly<{snapshot_ref: string; supplier_ref: string; source_identity_scheme: string; state: string; content_hash: string | null}>, readonly SqlScalar[]>;
  private readonly insertSource: OwnerStatement<Readonly<{source_offer_key_hash: string}>, readonly SqlScalar[]>;
  private readonly readSourceByRaw: OwnerStatement<SourceRow, readonly SqlScalar[]>;
  private readonly readSourceByHash: OwnerStatement<SourceRow, readonly SqlScalar[]>;
  private readonly insertExportOffer: OwnerStatement<Readonly<{source_offer_key_hash: string}>, readonly SqlScalar[]>;
  private readonly completeExportStatement: OwnerStatement<Readonly<{snapshot_ref: string}>, readonly SqlScalar[]>;
  private readonly readMembership: OwnerStatement<MembershipRow, readonly SqlScalar[]>;
  private readonly insertBinding: OwnerStatement<BindingRow, readonly SqlScalar[]>;
  private readonly readBindingByOffer: OwnerStatement<BindingRow, readonly SqlScalar[]>;
  private readonly readBindingBySource: OwnerStatement<BindingRow, readonly SqlScalar[]>;
  private readonly resolveBinding: OwnerStatement<BindingRow, readonly SqlScalar[]>;
  private readonly resolveBindingByRaw: OwnerStatement<BindingRow, readonly SqlScalar[]>;
  private readonly resolveProviderOfferStatement: OwnerStatement<Record<string, unknown>, readonly SqlScalar[]>;
  private readonly resolveBindingByIdentityStatement: OwnerStatement<BindingRow, readonly SqlScalar[]>;

  private readonly failExportStatement: OwnerStatement<Record<string, unknown>, readonly SqlScalar[]>;

  public constructor(database: Database) {
    this.insertExport = defineStatement(database, `
      INSERT INTO integration.provider_catalog_exports
        (snapshot_ref, supplier_ref, source_identity_scheme, state)
      VALUES ($1, $2, $3, 'Exporting')
      ON CONFLICT DO NOTHING
      RETURNING snapshot_ref`);
    this.readExport = defineStatement(database, `
      SELECT snapshot_ref, supplier_ref, source_identity_scheme, state, content_hash
      FROM integration.provider_catalog_exports WHERE snapshot_ref = $1 FOR UPDATE`);
    this.insertSource = defineStatement(database, `
      INSERT INTO integration.provider_source_offers
        (supplier_ref, source_identity_scheme, source_offer_key_hash, raw_provider_offer_id,
         raw_provider_product_id, raw_provider_variant_id, provider_packing, provider_grind_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING
      RETURNING source_offer_key_hash`);
    this.readSourceByRaw = defineStatement(database, `
      SELECT supplier_ref, source_identity_scheme, source_offer_key_hash, raw_provider_offer_id,
        raw_provider_product_id, raw_provider_variant_id, provider_packing, provider_grind_id
      FROM integration.provider_source_offers
      WHERE supplier_ref = $1 AND source_identity_scheme = $2 AND raw_provider_offer_id = $3`);
    this.readSourceByHash = defineStatement(database, `
      SELECT supplier_ref, source_identity_scheme, source_offer_key_hash, raw_provider_offer_id,
        raw_provider_product_id, raw_provider_variant_id, provider_packing, provider_grind_id
      FROM integration.provider_source_offers
      WHERE supplier_ref = $1 AND source_identity_scheme = $2 AND source_offer_key_hash = $3`);
    this.insertExportOffer = defineStatement(database, `
      INSERT INTO integration.provider_export_offers
        (snapshot_ref, supplier_ref, source_identity_scheme, source_offer_key_hash)
      VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING
      RETURNING source_offer_key_hash`);
    this.completeExportStatement = defineStatement(database, `
      UPDATE integration.provider_catalog_exports
      SET state = 'Completed', content_hash = $2, updated_at = clock_timestamp()
      WHERE snapshot_ref = $1 AND state = 'Exporting'
      RETURNING snapshot_ref`);
    this.readMembership = defineStatement(database, `
      SELECT EXISTS (SELECT 1 FROM integration.provider_source_offers
        WHERE supplier_ref = $1 AND source_identity_scheme = $2 AND source_offer_key_hash = $3) AS source_exists,
        COALESCE((SELECT state FROM integration.provider_catalog_exports
          WHERE snapshot_ref = $4 AND supplier_ref = $1 AND source_identity_scheme = $2), '') AS snapshot_state,
        EXISTS (SELECT 1 FROM integration.provider_export_offers
          WHERE snapshot_ref = $4 AND supplier_ref = $1 AND source_identity_scheme = $2 AND source_offer_key_hash = $3) AS member`);
    this.insertBinding = defineStatement(database, `
      INSERT INTO integration.provider_offer_bindings
        (offer_ref, supplier_ref, source_identity_scheme, source_offer_key_hash, first_snapshot_ref)
      VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING
      RETURNING offer_ref, supplier_ref, source_identity_scheme, source_offer_key_hash, first_snapshot_ref, state`);
    this.readBindingByOffer = defineStatement(database, `
      SELECT offer_ref, supplier_ref, source_identity_scheme, source_offer_key_hash, first_snapshot_ref, state
      FROM integration.provider_offer_bindings WHERE offer_ref = $1`);
    this.readBindingBySource = defineStatement(database, `
      SELECT offer_ref, supplier_ref, source_identity_scheme, source_offer_key_hash, first_snapshot_ref, state
      FROM integration.provider_offer_bindings
      WHERE supplier_ref = $1 AND source_identity_scheme = $2 AND source_offer_key_hash = $3`);
    this.resolveBinding = defineStatement(database, `
      SELECT offer_ref, supplier_ref, source_identity_scheme, source_offer_key_hash, first_snapshot_ref, state
      FROM integration.provider_offer_bindings
      WHERE supplier_ref = $1 AND source_identity_scheme = $2 AND source_offer_key_hash = $3`);
    this.resolveBindingByRaw = defineStatement(database, `
      SELECT b.offer_ref, b.supplier_ref, b.source_identity_scheme, b.source_offer_key_hash, b.first_snapshot_ref, b.state
      FROM integration.provider_offer_bindings b
      JOIN integration.provider_source_offers s
        ON s.supplier_ref = b.supplier_ref
       AND s.source_identity_scheme = b.source_identity_scheme
       AND s.source_offer_key_hash = b.source_offer_key_hash
      WHERE b.source_identity_scheme = $1 AND b.supplier_ref = $2 AND s.raw_provider_offer_id = $3`);
    this.resolveProviderOfferStatement = defineStatement(database, `
      SELECT b.offer_ref, s.supplier_ref, s.source_identity_scheme, s.source_offer_key_hash,
        s.raw_provider_offer_id, s.raw_provider_product_id, s.raw_provider_variant_id,
        s.provider_packing, s.provider_grind_id
      FROM integration.provider_offer_bindings b
      JOIN integration.provider_source_offers s ON s.supplier_ref = b.supplier_ref
        AND s.source_identity_scheme = b.source_identity_scheme AND s.source_offer_key_hash = b.source_offer_key_hash
      WHERE b.offer_ref = $1 AND b.supplier_ref = $2`);
    this.resolveBindingByIdentityStatement = defineStatement(database, `
      SELECT b.offer_ref, b.supplier_ref, b.source_identity_scheme, b.source_offer_key_hash, b.first_snapshot_ref, b.state
      FROM integration.provider_offer_bindings b
      JOIN integration.provider_source_offers s ON s.supplier_ref = b.supplier_ref
        AND s.source_identity_scheme = b.source_identity_scheme AND s.source_offer_key_hash = b.source_offer_key_hash
      WHERE b.supplier_ref = $1 AND s.raw_provider_offer_id = $2 AND s.provider_packing IS NOT DISTINCT FROM $3
        AND s.provider_grind_id IS NOT DISTINCT FROM $4`);

    this.failExportStatement = defineStatement(database, `UPDATE integration.provider_catalog_exports SET state = 'Failed', updated_at = clock_timestamp() WHERE snapshot_ref = $1 AND state = 'Exporting'`);
  }

  public async beginExport(transaction: Transaction, snapshotRef: string, supplierRef: string): Promise<void> {
    const result = await this.insertExport(transaction, [scalar(snapshotRef), scalar(supplierRef), SCHEME]);
    if (result.rowCount === 1) return;
    const existing = (await this.readExport(transaction, [scalar(snapshotRef)])).rows[0];
    if (existing?.supplier_ref === supplierRef && existing.source_identity_scheme === SCHEME && existing.state === "Exporting") return;
    throw new OfferBindingStoreError("AROMA_BINDING_CONFLICT");
  }

  public async recordBatch(transaction: Transaction, snapshotRef: string, supplierRef: string, identities: readonly ProviderOfferIdentity[]): Promise<void> {
    if (identities.length > MAX_BATCH) throw new OfferBindingStoreError("AROMA_BINDING_CONFLICT");
    const exportRow = (await this.readExport(transaction, [scalar(snapshotRef)])).rows[0];
    if (exportRow?.supplier_ref !== supplierRef || exportRow.source_identity_scheme !== SCHEME || exportRow.state !== "Exporting") {
      throw new OfferBindingStoreError("AROMA_BINDING_SNAPSHOT_INCOMPLETE");
    }
    for (const identity of identities) {
      if (identity.supplierRef !== supplierRef || identity.sourceIdentityScheme !== SCHEME) throw new OfferBindingStoreError("AROMA_BINDING_CONFLICT");
      const inserted = await this.insertSource(transaction, [scalar(supplierRef), SCHEME, scalar(identity.sourceOfferKeyHash), scalar(identity.rawProviderOfferId), scalar(identity.rawProviderProductId), scalar(identity.rawProviderVariantId), encodeProviderFact(identity.packing), encodeProviderFact(identity.grindId)]);
      if (inserted.rowCount === 0) {
        const existing = (await this.readSourceByRaw(transaction, [scalar(supplierRef), SCHEME, scalar(identity.rawProviderOfferId)])).rows[0];
        const byHash = (await this.readSourceByHash(transaction, [scalar(supplierRef), SCHEME, scalar(identity.sourceOfferKeyHash)])).rows[0];
        if (existing === undefined || byHash === undefined || !sourceRowMatchesIdentity(existing, identity) || !sourceRowMatchesIdentity(byHash, identity)) throw new OfferBindingStoreError("AROMA_BINDING_CONFLICT");
      }
      await this.insertExportOffer(transaction, [scalar(snapshotRef), scalar(supplierRef), SCHEME, scalar(identity.sourceOfferKeyHash)]);
    }
  }

  public async completeExport(transaction: Transaction, snapshotRef: string, contentHash: string): Promise<void> {
    if ((await this.completeExportStatement(transaction, [scalar(snapshotRef), scalar(contentHash)])).rowCount === 1) return;
    const existing = (await this.readExport(transaction, [scalar(snapshotRef)])).rows[0];
    if (existing?.state === "Completed" && existing.content_hash === contentHash) return;
    throw new OfferBindingStoreError("AROMA_BINDING_SNAPSHOT_INCOMPLETE");
  }

  public async failExport(transaction: Transaction, snapshotRef: string): Promise<void> { await this.failExportStatement(transaction, [scalar(snapshotRef)]); }

  public async register(transaction: Transaction, request: OfferBindingRequest): Promise<OfferBindingResponse> {
    if (!isAromaOfferBindingRequest(request) || request.sourceIdentityScheme !== SCHEME) throw new OfferBindingStoreError("AROMA_BINDING_CONFLICT");
    const membership = (await this.readMembership(transaction, [scalar(request.supplierRef), SCHEME, scalar(request.sourceOfferKeyHash), scalar(request.snapshotRef)])).rows[0];
    if (membership?.source_exists !== true) throw new OfferBindingStoreError("AROMA_BINDING_SOURCE_NOT_FOUND");
    if (membership.snapshot_state !== "Completed" || membership.member !== true) throw new OfferBindingStoreError("AROMA_BINDING_SNAPSHOT_INCOMPLETE");
    const inserted = await this.insertBinding(transaction, [scalar(request.offerRef), scalar(request.supplierRef), SCHEME, scalar(request.sourceOfferKeyHash), scalar(request.snapshotRef)]);
    if (inserted.rowCount === 1) return row(inserted.rows[0]!);
    const existingOffer = (await this.readBindingByOffer(transaction, [scalar(request.offerRef)])).rows[0];
    if (existingOffer !== undefined) {
      const existing = row(existingOffer);
      if (existing.supplierRef === request.supplierRef && existing.sourceIdentityScheme === SCHEME && existing.sourceOfferKeyHash === request.sourceOfferKeyHash) return existing;
      throw new OfferBindingStoreError("AROMA_BINDING_CONFLICT");
    }
    const existingSource = (await this.readBindingBySource(transaction, [scalar(request.supplierRef), SCHEME, scalar(request.sourceOfferKeyHash)])).rows[0];
    if (existingSource !== undefined) throw new OfferBindingStoreError("AROMA_BINDING_CONFLICT");
    throw new OfferBindingStoreError("AROMA_BINDING_CONFLICT");
  }

  public async resolve(transaction: Transaction, supplierRef: string, sourceOfferKeyHash: string): Promise<OfferBindingResponse | undefined> {
    const existing = (await this.resolveBinding(transaction, [scalar(supplierRef), SCHEME, scalar(sourceOfferKeyHash)])).rows[0];
    return existing === undefined ? undefined : row(existing);
  }

  public async resolveByRawProviderOfferId(transaction: Transaction, rawProviderOfferId: string, supplierRef: string): Promise<OfferBindingResponse | undefined> {
    if (rawProviderOfferId.length === 0 || rawProviderOfferId.includes("\u0000")) throw new OfferBindingStoreError("AROMA_BINDING_CONFLICT");
    const matches = (await this.resolveBindingByRaw(transaction, [SCHEME, scalar(supplierRef), scalar(rawProviderOfferId)])).rows;
    if (matches.length > 1) throw new OfferBindingStoreError("AROMA_BINDING_CONFLICT");
    const existing = matches[0];
    return existing === undefined ? undefined : row(existing);
  }

  public async resolveProviderOffer(transaction: Transaction, offerRef: string, supplierRef: string): Promise<ResolvedProviderOffer | undefined> {
    const matches = (await this.resolveProviderOfferStatement(transaction, [scalar(offerRef), scalar(supplierRef)])).rows;
    if (matches.length > 1) throw new OfferBindingStoreError("AROMA_BINDING_CONFLICT");
    const value = matches[0];
    if (value === undefined) return undefined;
    if (typeof value["offer_ref"] !== "string" || typeof value["supplier_ref"] !== "string" || typeof value["source_offer_key_hash"] !== "string" || typeof value["raw_provider_offer_id"] !== "string" || typeof value["raw_provider_product_id"] !== "string" || typeof value["raw_provider_variant_id"] !== "string") throw new OfferBindingStoreError("AROMA_BINDING_CONFLICT");
    const packing = decodeProviderFact(value["provider_packing"]);
    const grindId = decodeProviderFact(value["provider_grind_id"]);
    return {offerRef: value["offer_ref"], supplierRef: value["supplier_ref"], sourceIdentityScheme: SCHEME, sourceOfferKeyHash: value["source_offer_key_hash"], rawProviderOfferId: value["raw_provider_offer_id"], rawProviderProductId: value["raw_provider_product_id"], rawProviderVariantId: value["raw_provider_variant_id"], ...(packing === undefined ? {} : {packing}), ...(grindId === undefined ? {} : {grindId}), cartLineId: null};
  }

  public async resolveByProviderIdentity(transaction: Transaction, identity: Readonly<{offerId: string; packing: string | null; grindId: string | null}>, supplierRef: string): Promise<(OfferBindingResponse & {providerIdentity: Readonly<{offerId: string; packing: string | null; grindId: string | null}>}) | undefined> {
    const matches = (await this.resolveBindingByIdentityStatement(transaction, [scalar(supplierRef), scalar(identity.offerId), encodeProviderFact(identity.packing), encodeProviderFact(identity.grindId)])).rows;
    if (matches.length > 1) throw new OfferBindingStoreError("AROMA_BINDING_CONFLICT");
    return matches[0] === undefined ? undefined : {...row(matches[0]), providerIdentity: identity};
  }


}

export class OfferBindingStore {
  private readonly repository: OfferBindingRepository;
  private readonly database: Database;
  public constructor(database: Database) { this.database = database; this.repository = new OfferBindingRepository(database); }
  public beginExport(snapshotRef: string, supplierRef: string, signal?: AbortSignal): Promise<void> {
    return withTransaction(this.database, {mode: "interactive", ...(signal === undefined ? {} : {signal})}, transaction => this.repository.beginExport(transaction, snapshotRef, supplierRef));
  }
  public recordBatch(snapshotRef: string, supplierRef: string, identities: readonly ProviderOfferIdentity[], signal?: AbortSignal): Promise<void> {
    return withTransaction(this.database, {mode: "interactive", ...(signal === undefined ? {} : {signal})}, transaction => this.repository.recordBatch(transaction, snapshotRef, supplierRef, identities));
  }
  public completeExport(snapshotRef: string, contentHash: string, signal?: AbortSignal): Promise<void> {
    return withTransaction(this.database, {mode: "interactive", ...(signal === undefined ? {} : {signal})}, transaction => this.repository.completeExport(transaction, snapshotRef, contentHash));
  }
  public failExport(snapshotRef: string, signal?: AbortSignal): Promise<void> { return withTransaction(this.database, {mode: "interactive", ...(signal === undefined ? {} : {signal})}, transaction => this.repository.failExport(transaction, snapshotRef)); }
  public register(request: OfferBindingRequest, signal?: AbortSignal): Promise<OfferBindingResponse> {
    return withTransaction(this.database, {mode: "interactive", ...(signal === undefined ? {} : {signal})}, transaction => this.repository.register(transaction, request));
  }
  public resolve(supplierRef: string, sourceOfferKeyHash: string, signal?: AbortSignal): Promise<OfferBindingResponse | undefined> {
    return withTransaction(this.database, {mode: "interactive", ...(signal === undefined ? {} : {signal})}, transaction => this.repository.resolve(transaction, supplierRef, sourceOfferKeyHash));
  }
  public resolveByRawProviderOfferId(rawProviderOfferId: string, supplierRef: string, signal?: AbortSignal): Promise<OfferBindingResponse | undefined> {
    return withTransaction(this.database, {mode: "interactive", ...(signal === undefined ? {} : {signal})}, transaction => this.repository.resolveByRawProviderOfferId(transaction, rawProviderOfferId, supplierRef));
  }
  public resolveProviderOffer(offerRef: string, supplierRef: string, signal?: AbortSignal): Promise<ResolvedProviderOffer | undefined> { return withTransaction(this.database, {mode: "interactive", ...(signal === undefined ? {} : {signal})}, transaction => this.repository.resolveProviderOffer(transaction, offerRef, supplierRef)); }
  public resolveByProviderIdentity(identity: Readonly<{offerId: string; packing: string | null; grindId: string | null}>, supplierRef: string, signal?: AbortSignal): Promise<(OfferBindingResponse & {providerIdentity: Readonly<{offerId: string; packing: string | null; grindId: string | null}>}) | undefined> { return withTransaction(this.database, {mode: "interactive", ...(signal === undefined ? {} : {signal})}, transaction => this.repository.resolveByProviderIdentity(transaction, identity, supplierRef)); }

}
