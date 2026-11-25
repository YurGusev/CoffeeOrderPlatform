import { catalogSha256 } from "@coffee-platform/contracts-aroma-v1";
import { SOURCE_IDENTITY_SCHEME } from "./source-identity.js";

export const CATALOG_EXPORT_STREAM_VERSION = "1" as const;
export const CATALOG_SOURCE_IDENTITY_SCHEME = SOURCE_IDENTITY_SCHEME;

export type Sha256Hash = string;
export type CatalogUnit = "piece" | "gram" | "kilogram";
export type CatalogAvailability = "Available" | "Unavailable" | "Stopped";
export type SupplierPromotion = Readonly<{
  discountBasisPoints: number;
  minimumWeightRaw: string;
  providerCreatedAt: string;
  providerUpdatedAt: string;
}>;
export type CatalogGrindOption = Readonly<{
  sourceGrindKeyHash: Sha256Hash;
  displayName: string;
}>;

export type CatalogItem = Readonly<{
  sourceProductKeyHash: Sha256Hash;
  sourceVariantKeyHash: Sha256Hash;
  sourceOfferKeyHash: Sha256Hash;
  displayName: string;
  categoryName?: string;
  unit: CatalogUnit;
  supplierUnitMinor: string;
  currency: "RUB";
  availability: CatalogAvailability;
  imageUrl: string | null;
  supplierPromotions: readonly SupplierPromotion[];
  grindOptions?: readonly CatalogGrindOption[];
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

export type CatalogExportSummary = Readonly<{
  snapshotRef: string;
  supplierRef: string;
  batchCount: number;
  productCount: number;
  variantCount: number;
  offerCount: number;
  contentHash: Sha256Hash;
}>;

export type CatalogHashKind = "batch" | "content";
export type CatalogHashResolver = (
  bytes: Uint8Array,
  kind: CatalogHashKind,
) => string | Promise<string>;

/** The default SHA-256 boundary is injectable so tests and adapters can observe it. */
export const sha256CatalogHash: CatalogHashResolver = (bytes) =>
  catalogSha256(bytes);
