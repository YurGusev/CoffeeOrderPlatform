import {ProviderError} from "../domain/provider-errors.js";
import {toInstant} from "@coffee-platform/platform-time";
import {createSourceIdentity, type SourceIdentityKey} from "../domain/source-identity.js";
import {decodeCatalogPage, type ProviderCatalogOffer, type ProviderCatalogPage, type ProviderCatalogProduct} from "../infrastructure/provider/decoder.js";
import {readProviderSafely, type ProviderCredentialScope, type ProviderSessionManager} from "../infrastructure/provider/session.js";
import type {NormalizedCatalogOffer, SupplierPromotion} from "./catalog-export.js";

export type ProviderCatalogSourceOptions = Readonly<{
  sessions: ProviderSessionManager;
  credentials: ProviderCredentialScope;
  sourceIdentityKey: SourceIdentityKey;
  pageSize?: number;
  signal?: AbortSignal;
  /** Test seam; production uses normalizeProviderCatalogOffer when this is omitted. */
  normalize?: (product: ProviderCatalogProduct, offer: ProviderCatalogOffer) => NormalizedCatalogOffer;
}>;

function providerIdentity(normalized: NormalizedCatalogOffer["providerIdentity"]): NonNullable<NormalizedCatalogOffer["providerIdentity"]> {
  if (normalized === undefined || typeof normalized.rawProviderProductId !== "string" || normalized.rawProviderProductId.length === 0 || typeof normalized.rawProviderVariantId !== "string" || normalized.rawProviderVariantId.length === 0 || typeof normalized.rawProviderOfferId !== "string" || normalized.rawProviderOfferId.length === 0) throw new ProviderError("ProviderProtocolViolation");
  return normalized;
}

const PROVIDER_DECIMAL = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u;
const CANONICAL_NON_NEGATIVE_DECIMAL = /^(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?$/u;
const UTC_TIMESTAMP = /^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\.[0-9]+)?Z$/u;

function failNormalization(): never {
  throw new ProviderError("ProviderProtocolViolation");
}

function exactMinorUnits(priceRaw: string): string {
  if (!PROVIDER_DECIMAL.test(priceRaw)) return failNormalization();
  const parts = priceRaw.split(".");
  const integerPart = parts[0];
  const fractionPart = (parts[1] ?? "").replace(/0+$/u, "");
  if (integerPart === undefined || fractionPart.length > 2) return failNormalization();
  const minor = BigInt(integerPart) * 100n + BigInt(fractionPart.padEnd(2, "0") || "0");
  if (minor <= 0n) return failNormalization();
  return minor.toString();
}

function basisPoints(discountRaw: string): number {
  if (!PROVIDER_DECIMAL.test(discountRaw)) return failNormalization();
  const parts = discountRaw.split(".");
  const integerPart = parts[0];
  const fractionPart = (parts[1] ?? "").replace(/0+$/u, "");
  if (integerPart === undefined || fractionPart.length > 2) return failNormalization();
  const result = BigInt(integerPart) * 100n + BigInt(fractionPart.padEnd(2, "0") || "0");
  if (result <= 0n || result > 10_000n) return failNormalization();
  return Number(result);
}

function promotionFromProviderDiscount(discount: ProviderCatalogProduct["discounts"][number]): SupplierPromotion {
  if (!CANONICAL_NON_NEGATIVE_DECIMAL.test(discount.minimumWeightRaw) || !UTC_TIMESTAMP.test(discount.providerCreatedAt) || !UTC_TIMESTAMP.test(discount.providerUpdatedAt)) return failNormalization();
  try { toInstant(discount.providerCreatedAt); toInstant(discount.providerUpdatedAt); } catch { return failNormalization(); }
  return Object.freeze({
    discountBasisPoints: basisPoints(discount.discountRaw),
    minimumWeightRaw: discount.minimumWeightRaw,
    providerCreatedAt: discount.providerCreatedAt,
    providerUpdatedAt: discount.providerUpdatedAt,
  });
}

export function normalizeProviderPriceToMinor(priceRaw: string): string {
  return exactMinorUnits(priceRaw);
}

export function normalizeProviderCatalogPromotions(product: ProviderCatalogProduct): readonly SupplierPromotion[] {
  if (!Array.isArray(product.discounts)) return failNormalization();
  return Object.freeze(product.discounts.map(promotionFromProviderDiscount));
}

export function normalizeProviderCatalogMoneyAndPromotions(product: ProviderCatalogProduct, offer: ProviderCatalogOffer): Readonly<{
  supplierUnitMinor: string;
  currency: "RUB";
  supplierPromotions: readonly SupplierPromotion[];
}> {
  return Object.freeze({
    supplierUnitMinor: exactMinorUnits(offer.priceRaw),
    currency: "RUB",
    supplierPromotions: normalizeProviderCatalogPromotions(product),
  });
}

const MAX_PAGE_SIZE = 500;
const MAX_PAGE_BYTES = 2 * 1024 * 1024;

async function collectPage(source: AsyncIterable<Uint8Array>, signal: AbortSignal): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of source) {
    signal.throwIfAborted();
    if (!(chunk instanceof Uint8Array) || chunk.byteLength === 0) throw new ProviderError("ProviderReadIncomplete", size > 0);
    size += chunk.byteLength;
    if (size > MAX_PAGE_BYTES) throw new ProviderError("ProviderResponseTooLarge", true);
    chunks.push(chunk);
  }
  if (size === 0) throw new ProviderError("ProviderReadIncomplete");
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

function requiredImageUrl(product: ProviderCatalogProduct): string {
  const candidates: string[] = [];
  if (product.previewPath !== undefined && product.previewPath !== null) candidates.push(product.previewPath);
  if (product.photoPaths !== undefined) candidates.push(...product.photoPaths);
  const imageUrl = candidates[0];
  if (imageUrl === undefined || imageUrl.length === 0 || !URL.canParse(imageUrl)) return failNormalization();
  const protocol = new URL(imageUrl).protocol;
  if (protocol !== "http:" && protocol !== "https:") return failNormalization();
  return imageUrl;
}

function normalizeProviderUnit(product: ProviderCatalogProduct): "piece" {
  // `weight` describes an offer/packing observation. Policy explicitly forbids
  // turning the package price into a per-gram price or inferring a quantity unit.
  if (product.soldByPiece === true) return "piece";
  return failNormalization();
}

function normalizeProviderAvailability(product: ProviderCatalogProduct): "Available" | "Unavailable" | "Stopped" {
  if (typeof product.productOnStop !== "boolean" || typeof product.showOnWholesale !== "boolean") return failNormalization();
  if (product.productOnStop) return "Stopped";
  return product.showOnWholesale ? "Available" : "Unavailable";
}

function providerIdentityForOffer(product: ProviderCatalogProduct, offer: ProviderCatalogOffer): NonNullable<NormalizedCatalogOffer["providerIdentity"]> {
  if (!/^[0-9]+$/u.test(product.productId) || product.productId === "0" || !/^[0-9]+$/u.test(offer.offerId) || offer.offerId === "0") return failNormalization();
  // Captures prove product.id and offer.id only. The downstream identity
  // contract also requires an independent variant identifier, so duplicating
  // offer.id into that field would invent a provider fact.
  return failNormalization();
}

/** Production normalization is limited to facts proven by the observed catalog captures and policy. */
export function normalizeProviderCatalogOffer(product: ProviderCatalogProduct, offer: ProviderCatalogOffer): NormalizedCatalogOffer {
  if (typeof product.name !== "string" || product.name.length === 0 || typeof offer.name !== "string" || offer.name.length === 0 || typeof offer.vendorCode !== "string" || offer.vendorCode.length === 0) return failNormalization();
  const money = normalizeProviderCatalogMoneyAndPromotions(product, offer);
  return Object.freeze({
    displayName: offer.name,
    unit: normalizeProviderUnit(product),
    supplierUnitMinor: money.supplierUnitMinor,
    currency: money.currency,
    availability: normalizeProviderAvailability(product),
    imageUrl: requiredImageUrl(product),
    supplierPromotions: money.supplierPromotions,
    providerIdentity: providerIdentityForOffer(product, offer),
  });
}

function checkedPage(page: ProviderCatalogPage, requested: number, expected: ProviderCatalogPage | undefined): void {
  if (page.currentPage !== requested || page.lastPage < requested || page.perPage <= 0 || page.total < 0) throw new ProviderError("ProviderProtocolViolation");
  if (expected !== undefined && (page.lastPage !== expected.lastPage || page.perPage !== expected.perPage || page.total !== expected.total)) throw new ProviderError("ProviderProtocolViolation");
  if (requested < page.lastPage && page.products.length === 0) throw new ProviderError("ProviderReadIncomplete");
  if (page.products.length > page.perPage) throw new ProviderError("ProviderProtocolViolation");
}

/**
 * Sequential, bounded provider catalog source. It holds one decoded page at a
 * time, only requests the next page after the consumer asks for the next item,
 * and closes the provider iterator on cancellation/consumer return.
 */
export async function* createProviderCatalogSource(options: ProviderCatalogSourceOptions): AsyncGenerator<NormalizedCatalogOffer> {
  const pageSize = options.pageSize ?? 10;
  if (!Number.isSafeInteger(pageSize) || pageSize <= 0 || pageSize > MAX_PAGE_SIZE) throw new ProviderError("ProviderProtocolViolation");
  const signal = options.signal ?? new AbortController().signal;
  const normalize = options.normalize ?? normalizeProviderCatalogOffer;
  let page = 1;
  let expected: ProviderCatalogPage | undefined;
  let productCount = 0;
  let offerCount = 0;
  try {
    while (expected === undefined || page <= expected.lastPage) {
      signal.throwIfAborted();
      const body = await collectPage(readProviderSafely(options.sessions, options.credentials, {kind: "catalog-page", page, pageSize}, signal), signal);
      const decoded = decodeCatalogPage(body);
      checkedPage(decoded, page, expected);
      expected ??= decoded;
      productCount += decoded.products.length;
      for (const product of decoded.products) {
        signal.throwIfAborted();
        for (const offer of product.offers) {
          offerCount += 1;
          const normalized = normalize(product, offer);
          // Raw identifiers stay in this Gateway-local side-channel and are never
          // copied by createCatalogExportStream into NDJSON records.
          yield Object.freeze({...normalized, providerIdentity: providerIdentity(normalized.providerIdentity)});
        }
      }
      if (page === decoded.lastPage) break;
      page += 1;
    }
    if (expected === undefined || productCount !== expected.total) throw new ProviderError("ProviderProtocolViolation");
    void offerCount;
  } finally {
    // The session's read generator is closed by ProviderSessionManager; this
    // finally is intentionally present so consumer cancellation cannot advance pages.
  }
}

export function sourceIdentityForOffer(value: NormalizedCatalogOffer, supplierRef: string, key: SourceIdentityKey) {
  const identity = value.providerIdentity;
  if (identity === undefined) throw new ProviderError("ProviderProtocolViolation");
  return {
    supplierRef,
    sourceIdentityScheme: "hmac-sha256-v1" as const,
    sourceProductKeyHash: createSourceIdentity({supplierRef, entityType: "product", rawProviderIdentifier: identity.rawProviderProductId, sourceIdentityKey: key}).sourceIdentityHash,
    sourceVariantKeyHash: createSourceIdentity({supplierRef, entityType: "variant", rawProviderIdentifier: identity.rawProviderVariantId, sourceIdentityKey: key}).sourceIdentityHash,
    sourceOfferKeyHash: createSourceIdentity({supplierRef, entityType: "offer", rawProviderIdentifier: identity.rawProviderOfferId, sourceIdentityKey: key}).sourceIdentityHash,
    rawProviderProductId: identity.rawProviderProductId,
    rawProviderVariantId: identity.rawProviderVariantId,
    rawProviderOfferId: identity.rawProviderOfferId,
    ...(identity.packing === undefined ? {} : {packing: identity.packing}),
    ...(identity.grindId === undefined ? {} : {grindId: identity.grindId}),
  };
}
