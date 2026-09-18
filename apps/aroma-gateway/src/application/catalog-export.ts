import { createHash } from "node:crypto";
import { nowInstant, toInstant } from "@coffee-platform/platform-time";
import {finishGatewaySpan, type GatewayTelemetry} from "../infrastructure/observability.js";

export const CATALOG_EXPORT_STREAM_VERSION = "1" as const;
export const CATALOG_SOURCE_IDENTITY_SCHEME = "hmac-sha256-v1" as const;
export const CATALOG_MAX_OFFERS_PER_BATCH = 500;
export const CATALOG_MAX_BATCH_BYTES = 2_097_152;

export type Sha256Hash = string;
export type CatalogUnit = "piece" | "gram" | "kilogram";
export type CatalogAvailability = "Available" | "Unavailable" | "Stopped";
export type SupplierPromotion = Readonly<{
  discountBasisPoints: number;
  minimumWeightRaw: string;
  providerCreatedAt: string;
  providerUpdatedAt: string;
}>;
export type CatalogExportFailureCode =
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_TIMEOUT"
  | "INVALID_STREAM"
  | "BATCH_HASH_CONFLICT"
  | "SOURCE_IDENTITY_COLLISION";

/** The source boundary supplies these facts; it never supplies a provider response. */
export type NormalizedCatalogOffer = Readonly<{
  displayName: string;
  unit: CatalogUnit;
  supplierUnitMinor: string;
  currency: "RUB";
  availability: CatalogAvailability;
  imageUrl: string;
  supplierPromotions: readonly SupplierPromotion[];
  /** Gateway-only source facts consumed by the persistence identity boundary. */
  providerIdentity?: Readonly<{
    rawProviderProductId: string;
    rawProviderVariantId: string;
    rawProviderOfferId: string;
    /** Omitted means the provider/source did not supply this fact; null is explicit. */
    packing?: string | null;
    /** Omitted means the provider/source did not supply this fact; null is explicit. */
    grindId?: string | null;
  }>;
}>;

/** Raw identifiers are retained only in the Integration persistence handoff. */
export type CatalogOfferIdentity = Readonly<{
  supplierRef: string;
  sourceIdentityScheme: typeof CATALOG_SOURCE_IDENTITY_SCHEME;
  sourceProductKeyHash: Sha256Hash;
  sourceVariantKeyHash: Sha256Hash;
  sourceOfferKeyHash: Sha256Hash;
  rawProviderProductId: string;
  rawProviderVariantId: string;
  rawProviderOfferId: string;
  packing?: string | null;
  grindId?: string | null;
}>;

export type CatalogExportRequest = Readonly<{
  snapshotRef: string;
  supplierRef: string;
  providerSnapshotRef: string;
}>;

export type CatalogExportClock = Readonly<{
  now: () => string;
}>;

export type CatalogIdentityContext = Readonly<{
  snapshotRef: string;
  supplierRef: string;
  signal: AbortSignal;
}>;

export type CatalogIdentityResolver = (
  offer: NormalizedCatalogOffer,
  context: CatalogIdentityContext,
) => CatalogOfferIdentity | Promise<CatalogOfferIdentity>;

export type CatalogIdentityBoundary =
  CatalogIdentityResolver | Readonly<{ resolve: CatalogIdentityResolver }>;

export type CatalogHashKind = "batch" | "content";
export type CatalogHashResolver = (
  bytes: Uint8Array,
  kind: CatalogHashKind,
) => string | Promise<string>;
export type CatalogHashBoundary =
  | CatalogHashResolver
  | Readonly<{ sha256: CatalogHashResolver }>
  | Readonly<{ hash: CatalogHashResolver }>;

export type CatalogStartedRecord = Readonly<{
  streamVersion: typeof CATALOG_EXPORT_STREAM_VERSION;
  recordType: "snapshot-started";
  snapshotRef: string;
  supplierRef: string;
  providerSnapshotRef: string;
  startedAt: string;
}>;

export type CatalogItem = Readonly<{
  sourceProductKeyHash: Sha256Hash;
  sourceVariantKeyHash: Sha256Hash;
  sourceOfferKeyHash: Sha256Hash;
  displayName: string;
  unit: CatalogUnit;
  supplierUnitMinor: string;
  currency: "RUB";
  availability: CatalogAvailability;
  imageUrl: string;
  supplierPromotions: readonly SupplierPromotion[];
  sourceIdentityScheme: typeof CATALOG_SOURCE_IDENTITY_SCHEME;
}>;

export type CatalogBatchRecord = Readonly<{
  streamVersion: typeof CATALOG_EXPORT_STREAM_VERSION;
  recordType: "snapshot-batch";
  snapshotRef: string;
  batchNumber: number;
  offerCount: number;
  uncompressedBytes: number;
  batchHash: Sha256Hash;
  previousBatchHash: Sha256Hash | null;
  items: readonly CatalogItem[];
}>;

export type CatalogCompletedRecord = Readonly<{
  streamVersion: typeof CATALOG_EXPORT_STREAM_VERSION;
  recordType: "snapshot-completed";
  snapshotRef: string;
  batchCount: number;
  productCount: number;
  variantCount: number;
  offerCount: number;
  contentHash: Sha256Hash;
  completedAt: string;
}>;

export type CatalogFailedRecord = Readonly<{
  streamVersion: typeof CATALOG_EXPORT_STREAM_VERSION;
  recordType: "snapshot-failed";
  snapshotRef: string;
  code: CatalogExportFailureCode;
  failedAt: string;
}>;

export type CatalogExportRecord =
  | CatalogStartedRecord
  | CatalogBatchRecord
  | CatalogCompletedRecord
  | CatalogFailedRecord;

export type CatalogExportSummary = Readonly<{
  snapshotRef: string;
  supplierRef: string;
  batchCount: number;
  productCount: number;
  variantCount: number;
  offerCount: number;
  contentHash: Sha256Hash;
}>;

export type CatalogExportBatchPersistenceInput = Readonly<{
  record: CatalogBatchRecord;
  identities: readonly CatalogOfferIdentity[];
}>;

export type CatalogExportFailurePersistenceInput = Readonly<{
  record: CatalogFailedRecord;
  errorCode: CatalogExportFailureCode;
}>;

export type CatalogExportPersistence = Readonly<{
  beginExport: (
    record: CatalogStartedRecord,
    signal: AbortSignal,
  ) => void | Promise<void>;
  recordBatch: (
    input: CatalogExportBatchPersistenceInput,
    signal: AbortSignal,
  ) =>
    | void
    | Readonly<{
        batchHash?: string;
        offerCount?: number;
        uncompressedBytes?: number;
      }>
    | Promise<void | Readonly<{
        batchHash?: string;
        offerCount?: number;
        uncompressedBytes?: number;
      }>>;
  completeExport: (
    summary: CatalogExportSummary,
    signal: AbortSignal,
  ) =>
    | void
    | Readonly<Partial<CatalogExportSummary>>
    | Promise<void | Readonly<Partial<CatalogExportSummary>>>;
  failExport?: (
    input: CatalogExportFailurePersistenceInput,
    signal: AbortSignal,
  ) => void | Promise<void>;
  /** Discard an interrupted traversal without touching immutable source identities. */
  abortExport?: (snapshotRef: string, signal: AbortSignal) => void | Promise<void>;
}>;

export type CatalogExportBoundary = Readonly<{
  identity: CatalogIdentityBoundary;
  hash: CatalogHashBoundary;
  persistence: CatalogExportPersistence;
}>;

export type CatalogExportLimits = Readonly<{
  maxItemBytes: number;
  maxOffersPerBatch: number;
  maxBatchBytes: number;
  maxTotalOffers: number;
  maxTotalBytes: number;
  maxTotalBatches: number;
  totalTimeoutMs: number;
  idleTimeoutMs: number;
}>;

export type CatalogExportOptions = Readonly<{
  source:
    | AsyncIterable<NormalizedCatalogOffer>
    | AsyncIterator<NormalizedCatalogOffer>;
  request: CatalogExportRequest;
  boundary: CatalogExportBoundary;
  telemetry?: GatewayTelemetry;
  signal?: AbortSignal;
  clock?: CatalogExportClock;
  limits?: Partial<CatalogExportLimits> &
    Readonly<{
      maxItemsPerBatch?: number;
      maxBytesPerBatch?: number;
      maxOffers?: number;
      maxBytes?: number;
      maxDurationMs?: number;
      maxIdleMs?: number;
    }>;
}>;

export const DEFAULT_CATALOG_EXPORT_LIMITS: CatalogExportLimits = Object.freeze(
  {
    maxItemBytes: 131_072,
    maxOffersPerBatch: CATALOG_MAX_OFFERS_PER_BATCH,
    maxBatchBytes: CATALOG_MAX_BATCH_BYTES,
    maxTotalOffers: 100_000,
    maxTotalBytes: 512 * 1024 * 1024,
    maxTotalBatches: 10_000,
    totalTimeoutMs: 15 * 60 * 1000,
    idleTimeoutMs: 30 * 1000,
  },
);

export class CatalogExportError extends Error {
  public readonly code: CatalogExportFailureCode;

  public constructor(
    code: CatalogExportFailureCode,
    message: string = code,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "CatalogExportError";
    this.code = code;
  }
}

type JsonPrimitive = string | number | boolean | null;
type JsonValue =
  JsonPrimitive | readonly JsonValue[] | { [key: string]: JsonValue };
type MaybePromise<T> = T | Promise<T>;
type SourceIterator = AsyncIterator<NormalizedCatalogOffer>;

type RuntimeState = {
  readonly externalSignal: AbortSignal;
  readonly internalController: AbortController;
  readonly combinedSignal: AbortSignal;
  totalTimedOut: boolean;
  operationTimedOut: boolean;
};

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const REF_PATTERNS = Object.freeze({
  snapshot: /^snp_[0-9A-HJKMNP-TV-Z]{26}$/,
  supplier: /^sup_[0-9A-HJKMNP-TV-Z]{26}$/,
});
const MONEY_MINOR_PATTERN = /^-?(0|[1-9][0-9]*)$/;
const TIMESTAMP_PATTERN =
  /^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\.[0-9]+)?Z$/;
const DEFAULT_CLOCK: CatalogExportClock = Object.freeze({
  now: () => nowInstant().toString(),
});

function invalid(message: string, cause?: unknown): CatalogExportError {
  return new CatalogExportError("INVALID_STREAM", message, cause);
}

function identityCollision(
  message: string,
  cause?: unknown,
): CatalogExportError {
  return new CatalogExportError("SOURCE_IDENTITY_COLLISION", message, cause);
}

function hashConflict(message: string, cause?: unknown): CatalogExportError {
  return new CatalogExportError("BATCH_HASH_CONFLICT", message, cause);
}

function timeoutError(message: string): CatalogExportError {
  return new CatalogExportError("PROVIDER_TIMEOUT", message);
}

function providerUnavailable(
  message: string,
  cause?: unknown,
): CatalogExportError {
  return new CatalogExportError("PROVIDER_UNAVAILABLE", message, cause);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalize(
  value: JsonValue,
  stack = new WeakSet<object>(),
): JsonValue {
  if (Array.isArray(value)) {
    if (stack.has(value))
      throw new TypeError("canonical JSON does not permit cycles");
    stack.add(value);
    const result: JsonValue[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value))
        throw new TypeError("canonical JSON does not permit sparse arrays");
      result.push(canonicalize(value[index]!, stack));
    }
    stack.delete(value);
    return result;
  }
  if (value !== null && typeof value === "object") {
    if (!isPlainObject(value))
      throw new TypeError("canonical JSON permits only plain objects");
    if (stack.has(value))
      throw new TypeError("canonical JSON does not permit cycles");
    stack.add(value);
    const sorted: Record<string, JsonValue> = Object.create(null) as Record<
      string,
      JsonValue
    >;
    for (const key of Object.keys(value).sort()) {
      const child = value[key];
      if (child === undefined)
        throw new TypeError("canonical JSON does not permit undefined values");
      sorted[key] = canonicalize(child as JsonValue, stack);
    }
    stack.delete(value);
    return sorted;
  }
  if (typeof value === "number" && !Number.isFinite(value))
    throw new TypeError("canonical JSON requires finite numbers");
  if (
    value === undefined ||
    typeof value === "function" ||
    typeof value === "symbol" ||
    typeof value === "bigint"
  ) {
    throw new TypeError("canonical JSON does not permit this value");
  }
  return value;
}

/** Compact canonical JSON with recursively lexicographic object keys. */
export function canonicalCatalogJson(value: JsonValue): string {
  const encoded = JSON.stringify(canonicalize(value));
  if (encoded === undefined)
    throw new TypeError("value cannot be represented as canonical JSON");
  return encoded;
}

function utf8(value: string): Uint8Array {
  return Buffer.from(value, "utf8");
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validateLimits(
  input: CatalogExportOptions["limits"],
): CatalogExportLimits {
  const source = input === undefined ? {} : input;
  const aliases = source as Record<string, unknown>;
  const read = (
    name: keyof CatalogExportLimits,
    ...aliasNames: string[]
  ): number | undefined => {
    const value =
      source[name] ??
      aliasNames
        .map((alias) => aliases[alias])
        .find((candidate) => candidate !== undefined);
    return value as number | undefined;
  };
  const result: CatalogExportLimits = {
    maxItemBytes:
      read("maxItemBytes") ?? DEFAULT_CATALOG_EXPORT_LIMITS.maxItemBytes,
    maxOffersPerBatch:
      read("maxOffersPerBatch", "maxItemsPerBatch") ??
      DEFAULT_CATALOG_EXPORT_LIMITS.maxOffersPerBatch,
    maxBatchBytes:
      read("maxBatchBytes", "maxBytesPerBatch") ??
      DEFAULT_CATALOG_EXPORT_LIMITS.maxBatchBytes,
    maxTotalOffers:
      read("maxTotalOffers", "maxOffers") ??
      DEFAULT_CATALOG_EXPORT_LIMITS.maxTotalOffers,
    maxTotalBytes:
      read("maxTotalBytes", "maxBytes") ??
      DEFAULT_CATALOG_EXPORT_LIMITS.maxTotalBytes,
    maxTotalBatches:
      read("maxTotalBatches") ?? DEFAULT_CATALOG_EXPORT_LIMITS.maxTotalBatches,
    totalTimeoutMs:
      read("totalTimeoutMs", "maxDurationMs") ??
      DEFAULT_CATALOG_EXPORT_LIMITS.totalTimeoutMs,
    idleTimeoutMs:
      read("idleTimeoutMs", "maxIdleMs") ??
      DEFAULT_CATALOG_EXPORT_LIMITS.idleTimeoutMs,
  };
  if (
    !positiveSafeInteger(result.maxItemBytes) ||
    !positiveSafeInteger(result.maxOffersPerBatch) ||
    !positiveSafeInteger(result.maxBatchBytes) ||
    !nonNegativeSafeInteger(result.maxTotalOffers) ||
    !positiveSafeInteger(result.maxTotalBytes) ||
    !positiveSafeInteger(result.maxTotalBatches) ||
    !positiveSafeInteger(result.totalTimeoutMs) ||
    !positiveSafeInteger(result.idleTimeoutMs)
  ) {
    throw invalid("export limits are invalid");
  }
  if (
    result.maxOffersPerBatch > CATALOG_MAX_OFFERS_PER_BATCH ||
    result.maxBatchBytes > CATALOG_MAX_BATCH_BYTES
  ) {
    throw invalid("export limits exceed the catalog contract");
  }
  return Object.freeze(result);
}

function validateRequest(request: CatalogExportRequest): void {
  if (
    !isPlainObject(request) ||
    typeof request.snapshotRef !== "string" ||
    !REF_PATTERNS.snapshot.test(request.snapshotRef)
  ) {
    throw invalid("snapshotRef is invalid");
  }
  if (
    typeof request.supplierRef !== "string" ||
    !REF_PATTERNS.supplier.test(request.supplierRef)
  ) {
    throw invalid("supplierRef is invalid");
  }
  if (
    typeof request.providerSnapshotRef !== "string" ||
    request.providerSnapshotRef.length < 1 ||
    request.providerSnapshotRef.length > 256
  ) {
    throw invalid("providerSnapshotRef is invalid");
  }
}

function validateTimestamp(value: string, field: string): void {
  if (!TIMESTAMP_PATTERN.test(value))
    throw invalid(`${field} is not a UTC timestamp`);
  try { toInstant(value); } catch { throw invalid(`${field} is not a UTC timestamp`); }
}

const CANONICAL_NON_NEGATIVE_DECIMAL_PATTERN = /^(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?$/u;

function validateSupplierPromotions(value: unknown): asserts value is readonly SupplierPromotion[] {
  if (!Array.isArray(value)) throw invalid("normalized offer supplierPromotions is invalid");
  for (const promotion of value) {
    if (!isPlainObject(promotion)) throw invalid("normalized supplier promotion is invalid");
    if (typeof promotion["discountBasisPoints"] !== "number" || !Number.isSafeInteger(promotion["discountBasisPoints"]) || promotion["discountBasisPoints"] <= 0 || promotion["discountBasisPoints"] > 10_000) {
      throw invalid("normalized supplier promotion discountBasisPoints is invalid");
    }
    if (typeof promotion["minimumWeightRaw"] !== "string" || !CANONICAL_NON_NEGATIVE_DECIMAL_PATTERN.test(promotion["minimumWeightRaw"])) {
      throw invalid("normalized supplier promotion minimumWeightRaw is invalid");
    }
    if (typeof promotion["providerCreatedAt"] !== "string") throw invalid("normalized supplier promotion providerCreatedAt is invalid");
    validateTimestamp(promotion["providerCreatedAt"], "providerCreatedAt");
    if (typeof promotion["providerUpdatedAt"] !== "string") throw invalid("normalized supplier promotion providerUpdatedAt is invalid");
    validateTimestamp(promotion["providerUpdatedAt"], "providerUpdatedAt");
  }
}

function validateNormalizedOffer(
  value: unknown,
): asserts value is NormalizedCatalogOffer {
  if (!isPlainObject(value))
    throw invalid("source item is not a normalized offer");
  if (
    typeof value["displayName"] !== "string" ||
    value["displayName"].length < 1 ||
    value["displayName"].length > 200
  ) {
    throw invalid("normalized offer displayName is invalid");
  }
  if (
    value["unit"] !== "piece" &&
    value["unit"] !== "gram" &&
    value["unit"] !== "kilogram"
  )
    throw invalid("normalized offer unit is invalid");
  if (
    typeof value["supplierUnitMinor"] !== "string" ||
    !MONEY_MINOR_PATTERN.test(value["supplierUnitMinor"])
  ) {
    throw invalid("normalized offer supplierUnitMinor is invalid");
  }
  if (value["currency"] !== "RUB")
    throw invalid("normalized offer currency is invalid");
  if (
    value["availability"] !== "Available" &&
    value["availability"] !== "Unavailable" &&
    value["availability"] !== "Stopped"
  ) {
    throw invalid("normalized offer availability is invalid");
  }
  if (
    typeof value["imageUrl"] !== "string" ||
    value["imageUrl"].length > 2048 ||
    !URL.canParse(value["imageUrl"])
  ) {
    throw invalid("normalized offer imageUrl is invalid");
  }
  validateSupplierPromotions(value["supplierPromotions"]);
}

function validateRawProviderId(
  value: unknown,
  field: string,
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.includes("\u0000") ||
    !value.isWellFormed()
  )
    throw identityCollision(`${field} is invalid`);
}


function validateOptionalProviderIdentity(value: unknown, field: string): void {
  if (value === undefined || value === null) return;
  validateRawProviderId(value, field);
}


function validateHash(
  value: unknown,
  field: string,
): asserts value is Sha256Hash {
  if (typeof value !== "string" || !HASH_PATTERN.test(value))
    throw identityCollision(`${field} is not a lowercase SHA-256 hash`);
}

function validateIdentity(
  value: unknown,
  supplierRef: string,
): asserts value is CatalogOfferIdentity {
  if (!isPlainObject(value))
    throw identityCollision("identity boundary returned an invalid value");
  if (
    value["supplierRef"] !== supplierRef ||
    value["sourceIdentityScheme"] !== CATALOG_SOURCE_IDENTITY_SCHEME
  ) {
    throw identityCollision(
      "identity supplier or scheme does not match the export",
    );
  }
  validateHash(value["sourceProductKeyHash"], "sourceProductKeyHash");
  validateHash(value["sourceVariantKeyHash"], "sourceVariantKeyHash");
  validateHash(value["sourceOfferKeyHash"], "sourceOfferKeyHash");
  validateRawProviderId(value["rawProviderProductId"], "rawProviderProductId");
  validateRawProviderId(value["rawProviderVariantId"], "rawProviderVariantId");
  validateRawProviderId(value["rawProviderOfferId"], "rawProviderOfferId");
  validateOptionalProviderIdentity(value["packing"], "packing");
  validateOptionalProviderIdentity(value["grindId"], "grindId");
}

type SeenIdentityRawIds = Readonly<{
  product: Map<Sha256Hash, string>;
  productHashesByRawId: Map<string, Sha256Hash>;
  variant: Map<Sha256Hash, string>;
  variantHashesByRawId: Map<string, Sha256Hash>;
  offer: Map<Sha256Hash, string>;
  offerHashesByRawId: Map<string, Sha256Hash>;
}>;

function rememberIdentityRawId(
  seenByHash: Map<Sha256Hash, string>,
  seenByRawId: Map<string, Sha256Hash>,
  hash: Sha256Hash,
  rawProviderId: string,
  entityType: "product" | "variant" | "offer",
): void {
  const normalizedRawProviderId = rawProviderId.normalize("NFC");
  const previousRawProviderId = seenByHash.get(hash);
  if (
    previousRawProviderId !== undefined &&
    previousRawProviderId !== normalizedRawProviderId
  ) {
    throw identityCollision(
      `${entityType} source identity hash maps to different provider identifiers`,
    );
  }
  const previousHash = seenByRawId.get(normalizedRawProviderId);
  if (previousHash !== undefined && previousHash !== hash) {
    throw identityCollision(
      `${entityType} source identity provider identifier maps to different hashes`,
    );
  }
  seenByHash.set(hash, normalizedRawProviderId);
  seenByRawId.set(normalizedRawProviderId, hash);
}

function assertIdentityCollisionFree(
  identity: CatalogOfferIdentity,
  seen: SeenIdentityRawIds,
): void {
  rememberIdentityRawId(
    seen.product,
    seen.productHashesByRawId,
    identity.sourceProductKeyHash,
    identity.rawProviderProductId,
    "product",
  );
  rememberIdentityRawId(
    seen.variant,
    seen.variantHashesByRawId,
    identity.sourceVariantKeyHash,
    identity.rawProviderVariantId,
    "variant",
  );
  rememberIdentityRawId(
    seen.offer,
    seen.offerHashesByRawId,
    identity.sourceOfferKeyHash,
    identity.rawProviderOfferId,
    "offer",
  );
}

function outputItem(
  offer: NormalizedCatalogOffer,
  identity: CatalogOfferIdentity,
): CatalogItem {
  // Pick fields explicitly. Never spread either the offer or identity: raw provider
  // identifiers are an Integration-only persistence concern.
  return Object.freeze({
    sourceProductKeyHash: identity.sourceProductKeyHash,
    sourceVariantKeyHash: identity.sourceVariantKeyHash,
    sourceOfferKeyHash: identity.sourceOfferKeyHash,
    displayName: offer.displayName,
    unit: offer.unit,
    supplierUnitMinor: offer.supplierUnitMinor,
    currency: offer.currency,
    availability: offer.availability,
    imageUrl: offer.imageUrl,
    supplierPromotions: Object.freeze(offer.supplierPromotions.map((promotion) => Object.freeze({
      discountBasisPoints: promotion.discountBasisPoints,
      minimumWeightRaw: promotion.minimumWeightRaw,
      providerCreatedAt: promotion.providerCreatedAt,
      providerUpdatedAt: promotion.providerUpdatedAt,
    }))),
    sourceIdentityScheme: CATALOG_SOURCE_IDENTITY_SCHEME,
  });
}

function validateHashResult(
  value: unknown,
  kind: CatalogHashKind,
): asserts value is Sha256Hash {
  if (typeof value !== "string" || !HASH_PATTERN.test(value))
    throw hashConflict(`${kind} hash is not a lowercase SHA-256 hash`);
}

function resolveIdentity(
  boundary: CatalogIdentityBoundary,
): CatalogIdentityResolver {
  if (typeof boundary === "function") return boundary;
  if (isPlainObject(boundary) && typeof boundary.resolve === "function")
    return boundary.resolve.bind(boundary);
  throw invalid("identity boundary is missing");
}

function resolveHash(boundary: CatalogHashBoundary): CatalogHashResolver {
  if (typeof boundary === "function") return boundary;
  if (
    isPlainObject(boundary) &&
    typeof (boundary as Record<string, unknown>)["sha256"] === "function"
  )
    return (
      (boundary as Record<string, unknown>)["sha256"] as CatalogHashResolver
    ).bind(boundary);
  if (
    isPlainObject(boundary) &&
    typeof (boundary as Record<string, unknown>)["hash"] === "function"
  )
    return (
      (boundary as Record<string, unknown>)["hash"] as CatalogHashResolver
    ).bind(boundary);
  throw invalid("hash boundary is missing");
}

function validatePersistence(boundary: CatalogExportPersistence): void {
  if (
    !isPlainObject(boundary) ||
    typeof boundary.beginExport !== "function" ||
    typeof boundary.recordBatch !== "function" ||
    typeof boundary.completeExport !== "function"
  ) {
    throw invalid("persistence boundary is incomplete");
  }
  if (
    boundary.failExport !== undefined &&
    typeof boundary.failExport !== "function"
  )
    throw invalid("failExport is invalid");
  if (
    boundary.abortExport !== undefined &&
    typeof boundary.abortExport !== "function"
  )
    throw invalid("abortExport is invalid");
}

function sourceIterator(
  source: CatalogExportOptions["source"],
): SourceIterator {
  if (
    source === null ||
    source === undefined ||
    (typeof source !== "object" && typeof source !== "function")
  ) {
    throw invalid("an explicit async source is required");
  }
  const candidate = source as {
    readonly [Symbol.asyncIterator]?: () => AsyncIterator<NormalizedCatalogOffer>;
    readonly next?: AsyncIterator<NormalizedCatalogOffer>["next"];
  };
  const asyncIterator = candidate[Symbol.asyncIterator];
  if (typeof asyncIterator === "function") {
    const iterator = asyncIterator.call(source);
    if (
      iterator === null ||
      typeof iterator !== "object" ||
      typeof iterator.next !== "function"
    )
      throw invalid("source async iterator is invalid");
    return iterator;
  }
  if (typeof candidate.next === "function") return source as SourceIterator;
  throw invalid("source must be an AsyncIterable or AsyncIterator");
}

function cancellableSourceIterator(
  iterator: SourceIterator,
  signal: AbortSignal,
): SourceIterator {
  let returnPromise: Promise<IteratorResult<NormalizedCatalogOffer>> | undefined;
  const close = (): Promise<IteratorResult<NormalizedCatalogOffer>> => {
    returnPromise ??= Promise.resolve(iterator.return?.()).then(
      result => result ?? ({done: true, value: undefined} as IteratorReturnResult<undefined>),
    );
    return returnPromise;
  };
  const next = (): Promise<IteratorResult<NormalizedCatalogOffer>> => {
    const nextPromise = Promise.resolve().then(() => iterator.next());
    if (signal.aborted) {
      void close().catch(() => undefined);
      return Promise.reject(asAbortError(signal.reason));
    }
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        signal.removeEventListener("abort", onAbort);
        void close().catch(() => undefined);
        reject(asAbortError(signal.reason));
      };
      signal.addEventListener("abort", onAbort, {once: true});
      nextPromise.then(
        value => {
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        error => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });
  };
  return {
    next,
    return: () => close(),
  };
}

function timestamp(clock: CatalogExportClock, field: string): string {
  let value: string;
  try {
    value = clock.now();
  } catch (error) {
    throw providerUnavailable(`${field} clock failed`, error);
  }
  if (typeof value !== "string") throw invalid(`${field} is invalid`);
  validateTimestamp(value, field);
  return value;
}

function asAbortError(reason: unknown): Error {
  if (reason instanceof Error && reason.name === "AbortError") return reason;
  const error =
    reason instanceof Error ? reason : new Error("catalog export aborted");
  error.name = "AbortError";
  return error;
}

function isExternalCancellation(error: unknown, state: RuntimeState): boolean {
  return (
    state.externalSignal.aborted ||
    (error instanceof Error && error.name === "AbortError")
  );
}

function throwIfAborted(state: RuntimeState): void {
  if (!state.combinedSignal.aborted) return;
  if (state.externalSignal.aborted)
    throw asAbortError(state.externalSignal.reason);
  if (state.totalTimedOut || state.operationTimedOut)
    throw timeoutError("catalog export deadline exceeded");
  throw asAbortError(state.combinedSignal.reason);
}

function failureCode(
  error: unknown,
  state: RuntimeState,
): CatalogExportFailureCode {
  if (error instanceof CatalogExportError) return error.code;
  if (state.totalTimedOut || state.operationTimedOut) return "PROVIDER_TIMEOUT";
  if (error instanceof Error && error.name === "AbortError")
    return "PROVIDER_TIMEOUT";
  return "PROVIDER_UNAVAILABLE";
}

function canonicalRecord(record: CatalogExportRecord): Uint8Array {
  return utf8(`${canonicalCatalogJson(record as unknown as JsonValue)}\n`);
}

function freezeIdentity(identity: CatalogOfferIdentity): CatalogOfferIdentity {
  return Object.freeze({
    supplierRef: identity.supplierRef,
    sourceIdentityScheme: identity.sourceIdentityScheme,
    sourceProductKeyHash: identity.sourceProductKeyHash,
    sourceVariantKeyHash: identity.sourceVariantKeyHash,
    sourceOfferKeyHash: identity.sourceOfferKeyHash,
    rawProviderProductId: identity.rawProviderProductId,
    rawProviderVariantId: identity.rawProviderVariantId,
    rawProviderOfferId: identity.rawProviderOfferId,
    ...(identity.packing === undefined ? {} : {packing: identity.packing}),
    ...(identity.grindId === undefined ? {} : {grindId: identity.grindId}),
  });
}

function compareOptionalAck(ack: unknown, expected: CatalogBatchRecord): void {
  if (ack === undefined) return;
  if (!isPlainObject(ack))
    throw invalid("recordBatch acknowledgement is invalid");
  if (ack["batchHash"] !== undefined && ack["batchHash"] !== expected.batchHash)
    throw hashConflict("recordBatch batchHash acknowledgement mismatches");
  if (
    ack["offerCount"] !== undefined &&
    ack["offerCount"] !== expected.offerCount
  )
    throw invalid("recordBatch offerCount acknowledgement mismatches");
  if (
    ack["uncompressedBytes"] !== undefined &&
    ack["uncompressedBytes"] !== expected.uncompressedBytes
  )
    throw invalid("recordBatch byte acknowledgement mismatches");
}

function compareCompletionAck(
  ack: unknown,
  expected: CatalogExportSummary,
): void {
  if (ack === undefined) return;
  if (!isPlainObject(ack))
    throw invalid("completeExport acknowledgement is invalid");
  for (const field of [
    "batchCount",
    "productCount",
    "variantCount",
    "offerCount",
    "contentHash",
  ] as const) {
    if (ack[field] !== undefined && ack[field] !== expected[field]) {
      throw field === "contentHash"
        ? hashConflict(`completeExport ${field} acknowledgement mismatches`)
        : invalid(`completeExport ${field} acknowledgement mismatches`);
    }
  }
}

function combineSignals(
  externalSignal: AbortSignal,
  internalController: AbortController,
): AbortSignal {
  return AbortSignal.any([externalSignal, internalController.signal]);
}

function makeRuntimeState(signal: AbortSignal): RuntimeState {
  const internalController = new AbortController();
  return {
    externalSignal: signal,
    internalController,
    combinedSignal: combineSignals(signal, internalController),
    totalTimedOut: false,
    operationTimedOut: false,
  };
}

async function runWithLimits<T>(
  operation: () => MaybePromise<T>,
  state: RuntimeState,
  limits: CatalogExportLimits,
): Promise<T> {
  throwIfAborted(state);
  let timer: NodeJS.Timeout | undefined;
  let abortListener: (() => void) | undefined;
  let timedOut = false;
  const operationPromise = Promise.resolve().then(operation);
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      state.operationTimedOut = true;
      const error = timeoutError("catalog export idle timeout exceeded");
      state.internalController.abort(error);
      reject(error);
    }, limits.idleTimeoutMs);
    timer.unref?.();
  });
  const aborted = new Promise<never>((_resolve, reject) => {
    if (state.combinedSignal.aborted) {
      reject(
        state.externalSignal.aborted
          ? asAbortError(state.externalSignal.reason)
          : timeoutError("catalog export deadline exceeded"),
      );
      return;
    }
    abortListener = () =>
      reject(
        state.externalSignal.aborted
          ? asAbortError(state.externalSignal.reason)
          : timeoutError("catalog export deadline exceeded"),
      );
    state.combinedSignal.addEventListener("abort", abortListener, {
      once: true,
    });
  });
  try {
    const result = await Promise.race([operationPromise, timeout, aborted]);
    return result as T;
  } catch (error) {
    if (timedOut) throw timeoutError("catalog export idle timeout exceeded");
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (abortListener !== undefined)
      state.combinedSignal.removeEventListener("abort", abortListener);
  }
}

async function closeIterator(
  iterator: SourceIterator | undefined,
  limits: CatalogExportLimits,
): Promise<void> {
  if (iterator === undefined || typeof iterator.return !== "function") return;
  let timer: NodeJS.Timeout | undefined;
  try {
    const returnPromise = Promise.resolve(iterator.return());
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(timeoutError("source iterator cleanup timed out")),
        limits.idleTimeoutMs,
      );
      timer.unref?.();
    });
    await Promise.race([returnPromise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function* emitLine(
  bytes: Uint8Array,
  state: RuntimeState,
  limits: CatalogExportLimits,
  enforceSignal: boolean,
): AsyncGenerator<Uint8Array> {
  if (enforceSignal) throwIfAborted(state);
  let timer: NodeJS.Timeout | undefined;
  let timedOut = false;
  try {
    if (enforceSignal) {
      timer = setTimeout(() => {
        timedOut = true;
        state.operationTimedOut = true;
        state.internalController.abort(
          timeoutError("catalog export idle timeout exceeded"),
        );
      }, limits.idleTimeoutMs);
      timer.unref?.();
    }
    yield bytes;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  if (timedOut) throw timeoutError("catalog export idle timeout exceeded");
  if (enforceSignal) throwIfAborted(state);
}

function resolveOptions(
  sourceOrOptions: CatalogExportOptions | CatalogExportOptions["source"],
  request?: CatalogExportRequest,
  boundary?: CatalogExportBoundary,
  extra?: Readonly<{
    signal?: AbortSignal;
    clock?: CatalogExportClock;
    limits?: CatalogExportOptions["limits"];
  }>,
): Required<Pick<CatalogExportOptions, "source" | "request" | "boundary">> &
  Readonly<{
    signal: AbortSignal;
    clock: CatalogExportClock;
    limits: CatalogExportLimits;
    telemetry: GatewayTelemetry | undefined;
  }> {
  const options: CatalogExportOptions =
    isPlainObject(sourceOrOptions) &&
    "source" in sourceOrOptions &&
    "request" in sourceOrOptions &&
    "boundary" in sourceOrOptions
      ? (sourceOrOptions as CatalogExportOptions)
      : ({
          source: sourceOrOptions as CatalogExportOptions["source"],
          request: request as CatalogExportRequest,
          boundary: boundary as CatalogExportBoundary,
          ...(extra?.signal === undefined ? {} : { signal: extra.signal }),
          ...(extra?.clock === undefined ? {} : { clock: extra.clock }),
          ...(extra?.limits === undefined ? {} : { limits: extra.limits }),
        } as CatalogExportOptions);
  if (options.source === null || options.source === undefined)
    throw invalid("an explicit async source is required");
  validateRequest(options.request);
  if (!isPlainObject(options.boundary))
    throw invalid("export boundary is missing");
  resolveIdentity(options.boundary.identity);
  resolveHash(options.boundary.hash);
  validatePersistence(options.boundary.persistence);
  const signal = options.signal ?? new AbortController().signal;
  if (
    typeof signal !== "object" ||
    typeof signal.addEventListener !== "function"
  )
    throw invalid("signal is invalid");
  const clock = options.clock ?? DEFAULT_CLOCK;
  if (!isPlainObject(clock) || typeof clock.now !== "function")
    throw invalid("clock is invalid");
  return {
    source: options.source,
    request: options.request,
    boundary: options.boundary,
    signal,
    clock,
    limits: validateLimits(options.limits),
    telemetry: options.telemetry,
  };
}

/**
 * Create the Gateway-owned export stream. The source is deliberately required;
 * this function has no provider adapter, synthetic source, or fallback catalog.
 * Each yielded chunk is exactly one UTF-8 NDJSON record including its newline.
 */
export function createCatalogExportStream(
  options: CatalogExportOptions,
): AsyncGenerator<Uint8Array>;
export function createCatalogExportStream(
  source: CatalogExportOptions["source"],
  request: CatalogExportRequest,
  boundary: CatalogExportBoundary,
  options?: Readonly<{
    signal?: AbortSignal;
    clock?: CatalogExportClock;
    limits?: CatalogExportOptions["limits"];
  }>,
): AsyncGenerator<Uint8Array>;
export function createCatalogExportStream(
  sourceOrOptions: CatalogExportOptions | CatalogExportOptions["source"],
  request?: CatalogExportRequest,
  boundary?: CatalogExportBoundary,
  options?: Readonly<{
    signal?: AbortSignal;
    clock?: CatalogExportClock;
    limits?: CatalogExportOptions["limits"];
  }>,
): AsyncGenerator<Uint8Array> {
  const config = resolveOptions(sourceOrOptions, request, boundary, options);
  return runExport(config);
}

export const streamCatalogExport = createCatalogExportStream;

async function* runExport(
  config: Required<
    Pick<CatalogExportOptions, "source" | "request" | "boundary">
  > &
    Readonly<{
      signal: AbortSignal;
      clock: CatalogExportClock;
      limits: CatalogExportLimits;
      telemetry: GatewayTelemetry | undefined;
    }>,
): AsyncGenerator<Uint8Array> {
  const { request, boundary, clock, limits, telemetry } = config;
  const state = makeRuntimeState(config.signal);
  const identity = resolveIdentity(boundary.identity);
  const hash = resolveHash(boundary.hash);
  const iterator = cancellableSourceIterator(
    sourceIterator(config.source),
    state.combinedSignal,
  );
  let iteratorClosed = false;
  let streamStarted = false;
  let terminal = false;
  let failure: unknown;
  let totalTimer: NodeJS.Timeout | undefined;
  let batchNumber = 0;
  let previousBatchHash: Sha256Hash | null = null;
  let totalOfferCount = 0;
  let totalByteCount = 0;
  let batchCount = 0;
  const productHashes = new Set<Sha256Hash>();
  const variantHashes = new Set<Sha256Hash>();
  const offerHashes = new Set<Sha256Hash>();
  const seenOfferItems = new Set<Sha256Hash>();
  const seenIdentityRawIds: SeenIdentityRawIds = {
    product: new Map(),
    productHashesByRawId: new Map(),
    variant: new Map(),
    variantHashesByRawId: new Map(),
    offer: new Map(),
    offerHashesByRawId: new Map(),
  };
  const binaryBatchHashes: Uint8Array[] = [];
  let batchItems: CatalogItem[] = [];
  let batchItemJson: string[] = [];
  let batchIdentities: CatalogOfferIdentity[] = [];
  let batchBytes = 2;

  const close = async (): Promise<void> => {
    if (iteratorClosed) return;
    iteratorClosed = true;
    await closeIterator(iterator, limits);
  };

  const computeHash = async (
    bytes: Uint8Array,
    kind: CatalogHashKind,
  ): Promise<Sha256Hash> => {
    let result: unknown;
    try {
      result = await runWithLimits(() => hash(bytes, kind), state, limits);
    } catch (error) {
      if (isExternalCancellation(error, state)) throw error;
      if (error instanceof CatalogExportError) throw error;
      throw hashConflict(`${kind} hash boundary failed`, error);
    }
    validateHashResult(result, kind);
    const expected = createHash("sha256").update(bytes).digest("hex");
    if (result !== expected)
      throw hashConflict(`${kind} hash does not match canonical bytes`);
    return result;
  };

  const persistFailure = async (
    record: CatalogFailedRecord,
    errorCode: CatalogExportFailureCode,
  ): Promise<void> => {
    if (
      boundary.persistence.failExport === undefined ||
      state.externalSignal.aborted
    )
      return;
    const failureState = makeRuntimeState(state.externalSignal);
    try {
      await runWithLimits(
        () =>
          boundary.persistence.failExport!(
            { record, errorCode },
            state.externalSignal,
          ),
        failureState,
        limits,
      );
    } catch {
      // Failure persistence cannot turn a failed stream into a successful one, and
      // its error must never leak provider details into the NDJSON contract.
    }
  };

  const emit = async function* (
    record: CatalogExportRecord,
    enforceSignal = true,
  ): AsyncGenerator<Uint8Array> {
    yield* emitLine(canonicalRecord(record), state, limits, enforceSignal);
  };

  const emitBatch = async function* (): AsyncGenerator<Uint8Array> {
    if (batchItems.length === 0) return;
    if (batchCount >= limits.maxTotalBatches)
      throw invalid("total batch limit exceeded");
    const itemsJson = `[${batchItemJson.join(",")}]`;
    const itemBytes = utf8(itemsJson);
    if (itemBytes.byteLength !== batchBytes)
      throw invalid("batch byte accounting mismatch");
    if (itemBytes.byteLength > limits.maxBatchBytes)
      throw invalid("batch byte limit exceeded");
    const batchHash = await computeHash(itemBytes, "batch");
    const record: CatalogBatchRecord = Object.freeze({
      streamVersion: CATALOG_EXPORT_STREAM_VERSION,
      recordType: "snapshot-batch",
      snapshotRef: request.snapshotRef,
      batchNumber,
      offerCount: batchItems.length,
      uncompressedBytes: itemBytes.byteLength,
      batchHash,
      previousBatchHash,
      items: Object.freeze(batchItems.slice()),
    });
    const input: CatalogExportBatchPersistenceInput = Object.freeze({
      record,
      identities: Object.freeze(batchIdentities.slice()),
    });
    const span = telemetry?.startSpan("aroma.gateway.catalog_batch", {
      batchNumber,
      offerCount: record.offerCount,
      batchBytes: record.uncompressedBytes,
    });
    let spanError: unknown;
    let spanCompleted = false;
    let acknowledgement: unknown;
    try {
      try {
        acknowledgement = await runWithLimits(
          () => boundary.persistence.recordBatch(input, state.combinedSignal),
          state,
          limits,
        );
      } catch (error) {
        if (isExternalCancellation(error, state)) throw error;
        if (error instanceof CatalogExportError) throw error;
        throw invalid("recordBatch persistence failed", error);
      }
      compareOptionalAck(acknowledgement, record);
      binaryBatchHashes.push(Buffer.from(batchHash, "hex"));
      batchCount += 1;
      totalByteCount += itemBytes.byteLength;
      previousBatchHash = batchHash;
      for await (const line of emit(record)) yield line;
      spanCompleted = true;
      telemetry?.metrics.increment("catalogBatches");
      telemetry?.metrics.increment("catalogBatchBytes", itemBytes.byteLength);
      span?.setAttribute("result", "success");
      batchNumber += 1;
      batchItems = [];
      batchItemJson = [];
      batchIdentities = [];
      batchBytes = 2;
    } catch (error) {
      spanError = error;
      span?.setAttribute("result", isExternalCancellation(error, state) ? "cancelled" : "error");
      throw error;
    } finally {
      if (!spanCompleted && spanError === undefined) {
        span?.setAttribute("result", "cancelled");
        spanError = new Error("catalog batch cancelled");
      }
      if (span !== undefined) finishGatewaySpan(span, spanError);
    }
  };

  try {
    totalTimer = setTimeout(() => {
      state.totalTimedOut = true;
      state.internalController.abort(
        timeoutError("catalog export total deadline exceeded"),
      );
    }, limits.totalTimeoutMs);
    totalTimer.unref?.();
    throwIfAborted(state);
    const startedAt = timestamp(clock, "startedAt");
    const started: CatalogStartedRecord = Object.freeze({
      streamVersion: CATALOG_EXPORT_STREAM_VERSION,
      recordType: "snapshot-started",
      snapshotRef: request.snapshotRef,
      supplierRef: request.supplierRef,
      providerSnapshotRef: request.providerSnapshotRef,
      startedAt,
    });
    await runWithLimits(
      () => boundary.persistence.beginExport(started, state.combinedSignal),
      state,
      limits,
    );
    streamStarted = true;
    for await (const line of emit(started)) yield line;

    while (true) {
      throwIfAborted(state);
      let next: IteratorResult<NormalizedCatalogOffer>;
      try {
        next = await runWithLimits(() => iterator.next(), state, limits);
      } catch (error) {
        if (isExternalCancellation(error, state)) throw error;
        if (error instanceof CatalogExportError) throw error;
        throw providerUnavailable("source iterator failed", error);
      }
      if (
        next === null ||
        typeof next !== "object" ||
        typeof next.done !== "boolean"
      )
        throw invalid("source iterator returned an invalid result");
      if (next.done) {
        await close();
        break;
      }
      validateNormalizedOffer(next.value);
      if (totalOfferCount >= limits.maxTotalOffers)
        throw invalid("total offer limit exceeded");
      const offer = next.value;
      let resolved: CatalogOfferIdentity;
      try {
        resolved = await runWithLimits(
          () =>
            identity(offer, {
              snapshotRef: request.snapshotRef,
              supplierRef: request.supplierRef,
              signal: state.combinedSignal,
            }),
          state,
          limits,
        );
      } catch (error) {
        if (isExternalCancellation(error, state)) throw error;
        if (error instanceof CatalogExportError) throw error;
        throw identityCollision("identity boundary failed", error);
      }
      validateIdentity(resolved, request.supplierRef);
      const safeIdentity = freezeIdentity(resolved);
      assertIdentityCollisionFree(safeIdentity, seenIdentityRawIds);
      const item = outputItem(offer, safeIdentity);
      const itemJson = canonicalCatalogJson(item as unknown as JsonValue);
      const itemByteCount = utf8Bytes(itemJson);
      if (itemByteCount > limits.maxItemBytes)
        throw invalid("item byte limit exceeded");
      if (itemByteCount + 2 > limits.maxBatchBytes)
        throw invalid("item cannot fit in a batch");

      const requiredBatchBytes =
        batchItems.length === 0
          ? itemByteCount + 2
          : batchBytes + 1 + itemByteCount;
      if (
        batchItems.length > 0 &&
        (batchItems.length >= limits.maxOffersPerBatch ||
          requiredBatchBytes > limits.maxBatchBytes)
      ) {
        for await (const line of emitBatch()) yield line;
      }
      const newBatchBytes =
        batchItems.length === 0
          ? itemByteCount + 2
          : batchBytes + 1 + itemByteCount;
      if (newBatchBytes > limits.maxBatchBytes)
        throw invalid("batch byte limit exceeded");
      if (totalByteCount + newBatchBytes > limits.maxTotalBytes)
        throw invalid("total byte limit exceeded");
      if (seenOfferItems.has(safeIdentity.sourceOfferKeyHash))
        throw identityCollision("duplicate source offer identity");
      seenOfferItems.add(safeIdentity.sourceOfferKeyHash);
      productHashes.add(safeIdentity.sourceProductKeyHash);
      variantHashes.add(safeIdentity.sourceVariantKeyHash);
      offerHashes.add(safeIdentity.sourceOfferKeyHash);
      batchItems.push(item);
      batchItemJson.push(itemJson);
      batchIdentities.push(safeIdentity);
      batchBytes = newBatchBytes;
      totalOfferCount += 1;
      if (
        batchItems.length >= limits.maxOffersPerBatch ||
        batchBytes >= limits.maxBatchBytes
      ) {
        for await (const line of emitBatch()) yield line;
      }
    }

    if (batchItems.length > 0) {
      for await (const line of emitBatch()) yield line;
    }
    throwIfAborted(state);
    const contentBytes = Buffer.concat(
      binaryBatchHashes.map((hashBytes) => Buffer.from(hashBytes)),
    );
    const contentHash = await computeHash(contentBytes, "content");
    const summary: CatalogExportSummary = Object.freeze({
      snapshotRef: request.snapshotRef,
      supplierRef: request.supplierRef,
      batchCount,
      productCount: productHashes.size,
      variantCount: variantHashes.size,
      offerCount: offerHashes.size,
      contentHash,
    });
    const completedAt = timestamp(clock, "completedAt");
    let acknowledgement: unknown;
    try {
      acknowledgement = await runWithLimits(
        () =>
          boundary.persistence.completeExport(summary, state.combinedSignal),
        state,
        limits,
      );
    } catch (error) {
      if (isExternalCancellation(error, state)) throw error;
      if (error instanceof CatalogExportError) throw error;
      throw invalid("completeExport persistence failed", error);
    }
    compareCompletionAck(acknowledgement, summary);
    const completed: CatalogCompletedRecord = Object.freeze({
      streamVersion: CATALOG_EXPORT_STREAM_VERSION,
      recordType: "snapshot-completed",
      snapshotRef: request.snapshotRef,
      batchCount: summary.batchCount,
      productCount: summary.productCount,
      variantCount: summary.variantCount,
      offerCount: summary.offerCount,
      contentHash: summary.contentHash,
      completedAt,
    });
    terminal = true;
    if (totalTimer !== undefined) {
      clearTimeout(totalTimer);
      totalTimer = undefined;
    }
    for await (const line of emit(completed, false)) yield line;
    telemetry?.metrics.result("catalogResult", "success");
  } catch (error) {
    failure = error;
    // The completed record has already committed. A later idle/cleanup error
    // must never append a second terminal record or rewrite that result.
    if (terminal) return;
    if (!streamStarted || isExternalCancellation(error, state)) throw error;
    try {
      await close();
    } catch {
      /* preserve the source/persistence failure */
    }
    const code = failureCode(error, state);
    const failedAt = timestamp(clock, "failedAt");
    const failed: CatalogFailedRecord = Object.freeze({
      streamVersion: CATALOG_EXPORT_STREAM_VERSION,
      recordType: "snapshot-failed",
      snapshotRef: request.snapshotRef,
      code,
      failedAt,
    });
    await persistFailure(failed, code);
    terminal = true;
    if (totalTimer !== undefined) {
      clearTimeout(totalTimer);
      totalTimer = undefined;
    }
    for await (const line of emit(failed, false)) yield line;
    telemetry?.metrics.increment("catalogFailures");
    telemetry?.metrics.result("catalogResult", "failure");
  } finally {
    if (totalTimer !== undefined) clearTimeout(totalTimer);
    if (!state.internalController.signal.aborted)
      state.internalController.abort(asAbortError(new Error("catalog export closed")));
    if (streamStarted && !terminal && boundary.persistence.abortExport !== undefined) {
      try {
        // External cancellation may already be aborted; cleanup is durable work
        // and therefore receives its own bounded, non-aborted signal.
        await boundary.persistence.abortExport(request.snapshotRef, new AbortController().signal);
      } catch {
        // Preserve the original cancellation/consumer-close outcome.
      }
    }
    if (!iteratorClosed) {
      try {
        await close();
      } catch (cleanupError) {
        if (failure === undefined && !terminal) void cleanupError;
      }
    }
  }
}

/** The default SHA-256 boundary is injectable so tests and adapters can observe it. */
export const sha256CatalogHash: CatalogHashResolver = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
