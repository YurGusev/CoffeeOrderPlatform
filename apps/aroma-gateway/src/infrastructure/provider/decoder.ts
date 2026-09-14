import {ProviderError} from "../../domain/provider-errors.js";
import {toInstant} from "@coffee-platform/platform-time";

const DECIMAL = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u;
const CANONICAL_NON_NEGATIVE_DECIMAL = /^(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?$/u;
const ID = /^[0-9]+$/u;
const RFC3339_UTC = /^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\.[0-9]+)?Z$/u;

export type ProviderCartLine = Readonly<{
  /** Provider cart line id (`products[].id`). */
  cartLineId: string;
  /** Provider offer id (`products[].offer.id`), deliberately not cartLineId. */
  offerId: string;
  quantity: number;
  packing: string | null;
  grindId: string | null;
  /** Raw provider decimal text; this is not a Money value. */
  offerPriceRaw: string;
}>;

export type ProviderCartSnapshot = Readonly<{
  kind: "empty" | "non-empty";
  lines: readonly ProviderCartLine[];
  totalDefaultRaw: string;
  totalPromoRaw: string;
}>;

export type ProviderCatalogOffer = Readonly<{
  offerId: string;
  name: string;
  vendorCode: string;
  priceRaw: string;
}>;

export type ProviderCatalogDiscount = Readonly<{
  discountRaw: string;
  minimumWeightRaw: string;
  providerCreatedAt: string;
  providerUpdatedAt: string;
}>;

export type ProviderCatalogProduct = Readonly<{
  productId: string;
  name: string;
  offers: readonly ProviderCatalogOffer[];
  discounts: readonly ProviderCatalogDiscount[];
}>;

export type ProviderCatalogPage = Readonly<{
  products: readonly ProviderCatalogProduct[];
  currentPage: number;
  lastPage: number;
  perPage: number;
  total: number;
}>;

export type ProviderUser = Readonly<{
  email: string;
  wholesale: boolean;
  retail: boolean;
}>;

export type ProviderRejection = Readonly<{
  statusCode: number;
  /** A stable classification: a 422 is not proof that a mutation had no effect. */
  effect: "unknown";
  errorFieldNames: readonly string[];
}>;

function invalid(incomplete = false): never {
  throw new ProviderError(incomplete ? "ProviderDecodeIncomplete" : "ProviderDecodeInvalid");
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function required<T>(source: Record<string, unknown>, key: string, check: (value: unknown) => value is T): T {
  if (!Object.hasOwn(source, key)) invalid(true);
  const value = source[key];
  if (!check(value)) invalid();
  return value;
}

function array(source: Record<string, unknown>, key: string): readonly unknown[] {
  return required(source, key, (value): value is readonly unknown[] => Array.isArray(value));
}

function providerId(value: unknown): string {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value <= 0) invalid();
    return String(value);
  }
  if (typeof value === "string" && ID.test(value) && value !== "0") return value;
  invalid();
}

function text(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || !value.isWellFormed() || value.includes("\u0000")) invalid();
  return value;
}

function nullableText(value: unknown): string | null {
  if (value === null) return null;
  return text(value);
}

function nonNegativeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) invalid();
  return value;
}

function decimalText(value: unknown): string {
  const normalized = typeof value === "number" && Number.isFinite(value) ? String(value) : value;
  if (typeof normalized !== "string" || !DECIMAL.test(normalized)) invalid();
  return normalized;
}

function catalogMoneyText(value: unknown): string {
  const normalized = typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? String(value) : value;
  if (typeof normalized !== "string" || !DECIMAL.test(normalized)) invalid();
  return normalized;
}

function canonicalNonNegativeDecimal(value: unknown): string {
  const normalized = typeof value === "number" && Number.isFinite(value) ? String(value) : value;
  if (typeof normalized !== "string" || !CANONICAL_NON_NEGATIVE_DECIMAL.test(normalized)) invalid();
  return normalized;
}

function rfc3339Utc(value: unknown): string {
  if (typeof value !== "string" || !RFC3339_UTC.test(value)) invalid();
  try { toInstant(value); } catch { invalid(); }
  return value;
}

function isZeroDecimal(value: string): boolean {
  return /^0(?:\.0+)?$/u.test(value);
}

function jsonBody(body: unknown): unknown {
  if (body instanceof Uint8Array) {
    let decoded: string;
    try { decoded = new TextDecoder("utf-8", {fatal: true}).decode(body); } catch { invalid(true); }
    if (decoded.length === 0) invalid(true);
    try { return JSON.parse(decoded) as unknown; } catch { invalid(); }
  }
  if (typeof body === "string") {
    if (body.length === 0) invalid(true);
    try { return JSON.parse(body) as unknown; } catch { invalid(); }
  }
  return body;
}

export function decodeCartSnapshot(body: unknown): ProviderCartSnapshot {
  const root = record(jsonBody(body));
  const products = array(root, "products");
  if (products.length > 10_000) invalid();
  const prices = record(required(root, "prices", (value): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)));
  const total = record(required(prices, "total", (value): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)));
  const totalDefaultRaw = decimalText(required(total, "default", (value): value is number | string => (typeof value === "number" || typeof value === "string")));
  const totalPromoRaw = decimalText(required(total, "promo", (value): value is number | string => (typeof value === "number" || typeof value === "string")));

  const lines = products.map((value): ProviderCartLine => {
    const product = record(value);
    const offer = record(required(product, "offer", (candidate): candidate is Record<string, unknown> => candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)));
    const quantity = nonNegativeInteger(required(product, "quantity", (candidate): candidate is number => typeof candidate === "number"));
    if (quantity <= 0) invalid();
    return {
      cartLineId: providerId(required(product, "id", (_value): _value is unknown => true)),
      offerId: providerId(required(offer, "id", (_value): _value is unknown => true)),
      quantity,
      packing: nullableText(required(product, "packing", (candidate): candidate is string | null => candidate === null || typeof candidate === "string")),
      grindId: nullableText(required(product, "grind_id", (candidate): candidate is string | null => candidate === null || typeof candidate === "string")),
      offerPriceRaw: decimalText(required(offer, "price", (candidate): candidate is number | string => typeof candidate === "number" || typeof candidate === "string")),
    };
  });
  const cartLineIds = new Set<string>();
  const offerIds = new Set<string>();
  for (const line of lines) {
    if (cartLineIds.has(line.cartLineId) || offerIds.has(line.offerId)) invalid();
    cartLineIds.add(line.cartLineId);
    offerIds.add(line.offerId);
  }

  // Empty is a semantic result only after the complete observed empty shape has
  // been checked. A missing/invalid prices field never becomes an empty cart.
  if (lines.length === 0) {
    for (const key of ["categories", "weights", "discounts", "prices"] as const) {
      if (array(prices, key).length !== 0) invalid();
    }
    if (!isZeroDecimal(totalDefaultRaw) || !isZeroDecimal(totalPromoRaw)) invalid();
  }
  return {kind: lines.length === 0 ? "empty" : "non-empty", lines, totalDefaultRaw, totalPromoRaw};
}

export function decodeCatalogPage(body: unknown): ProviderCatalogPage {
  const root = record(jsonBody(body));
  const data = array(root, "data");
  const links = record(required(root, "links", (value): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)));
  for (const key of ["first", "last", "prev", "next"] as const) {
    required(links, key, (value): value is string | null => value === null || typeof value === "string");
  }
  const meta = record(required(root, "meta", (value): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)));
  const currentPage = nonNegativeInteger(required(meta, "current_page", (value): value is number => typeof value === "number"));
  const lastPage = nonNegativeInteger(required(meta, "last_page", (value): value is number => typeof value === "number"));
  const perPage = nonNegativeInteger(required(meta, "per_page", (value): value is number => typeof value === "number"));
  const total = nonNegativeInteger(required(meta, "total", (value): value is number => typeof value === "number"));
  if (currentPage === 0 || lastPage === 0 || perPage === 0) invalid();
  const products = data.map((value): ProviderCatalogProduct => {
    const product = record(value);
    const productId = providerId(required(product, "id", (_value): _value is unknown => true));
    const offers = array(product, "offers").map((candidate): ProviderCatalogOffer => {
      const offer = record(candidate);
      return {
        offerId: providerId(required(offer, "id", (_value): _value is unknown => true)),
        name: text(required(offer, "name", (item): item is string => typeof item === "string")),
        vendorCode: text(required(offer, "vendor_code", (item): item is string => typeof item === "string")),
        priceRaw: catalogMoneyText(required(offer, "price", (item): item is number | string => typeof item === "number" || typeof item === "string")),
      };
    });
    const discounts = array(product, "discount").map((candidate): ProviderCatalogDiscount => {
      const discount = record(candidate);
      // Validate the provider identifier, but deliberately do not retain it in
      // the normalized supplier fact.
      providerId(required(discount, "id", (_value): _value is unknown => true));
      const productRef = discount["product_id"];
      if (productRef !== undefined && providerId(productRef) !== productId) invalid();
      if (discount["user_id"] !== undefined && discount["user_id"] !== null) invalid();
      const discountRaw = canonicalNonNegativeDecimal(required(discount, "discount", (item): item is number | string => typeof item === "number" || typeof item === "string"));
      if (isZeroDecimal(discountRaw)) invalid();
      const minimumWeightRaw = canonicalNonNegativeDecimal(required(discount, "min_weight", (item): item is number | string => typeof item === "number" || typeof item === "string"));
      return {
        discountRaw,
        minimumWeightRaw,
        providerCreatedAt: rfc3339Utc(required(discount, "created_at", (item): item is string => typeof item === "string")),
        providerUpdatedAt: rfc3339Utc(required(discount, "updated_at", (item): item is string => typeof item === "string")),
      };
    });
    return {
      productId,
      name: text(required(product, "name", (item): item is string => typeof item === "string")),
      offers,
      discounts,
    };
  });
  return {products, currentPage, lastPage, perPage, total};
}

export function decodeUser(body: unknown): ProviderUser {
  const root = record(jsonBody(body));
  const data = record(required(root, "data", (value): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)));
  return {
    email: text(required(data, "email", (value): value is string => typeof value === "string")),
    wholesale: required(data, "wholesale", (value): value is boolean => typeof value === "boolean"),
    retail: required(data, "retail", (value): value is boolean => typeof value === "boolean"),
  };
}

export function decodeLoginSuccess(body: unknown): ProviderUser {
  return decodeUser(body);
}

export function decodeProviderRejection(statusCode: number, body: unknown): ProviderRejection {
  if (!Number.isSafeInteger(statusCode) || statusCode < 400 || statusCode > 599) invalid();
  const root = record(jsonBody(body));
  const error = root["error"];
  if (typeof error !== "string" || error.length === 0 || !error.isWellFormed()) invalid();
  const errorsValue = root["errors"];
  const errorFieldNames: string[] = [];
  if (errorsValue !== undefined) {
    const errors = record(errorsValue);
    for (const [key, value] of Object.entries(errors)) {
      if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(key)) invalid();
      if (!(typeof value === "string" || (Array.isArray(value) && value.every(item => typeof item === "string" && item.isWellFormed())))) invalid();
      errorFieldNames.push(key);
    }
  }
  return {statusCode, effect: "unknown", errorFieldNames};
}
