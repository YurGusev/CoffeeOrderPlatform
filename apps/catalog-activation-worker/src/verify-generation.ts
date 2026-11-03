import {
  catalogBatchBytes,
  catalogBatchHash,
  createCatalogContentHash,
  type AromaCatalogExportRecord,
} from "@coffee-platform/contracts-aroma-v1";

type CatalogItem = Extract<
  AromaCatalogExportRecord,
  { recordType: "snapshot-batch" }
>["items"][number];
type Snapshot = Readonly<{
  snapshot_ref: string;
  supplier_ref: string;
  state: string;
  next_batch_number: number;
  declared_batch_count: number | null;
  declared_product_count: number | null;
  declared_variant_count: number | null;
  declared_offer_count: number | null;
  received_batch_count: number;
  received_product_count: number;
  received_variant_count: number;
  received_offer_count: number;
  content_hash: string | null;
}>;
type Batch = Readonly<{
  batch_number: number;
  offer_count: number;
  uncompressed_bytes: number;
  batch_hash: string;
  previous_batch_hash: string | null;
}>;
type Product = Readonly<{
  source_product_key_hash: string;
  image_url: string | null;
  category_name: string | null;
}>;
type Variant = Readonly<{
  source_variant_key_hash: string;
  source_product_key_hash: string;
  display_name: string;
  unit: string;
}>;
type Offer = Readonly<{
  source_offer_key_hash: string;
  source_variant_key_hash: string;
  batch_number: number;
  item_index: number;
  supplier_unit_minor: string;
  currency: string;
  supplier_promotions: NonNullable<CatalogItem["supplierPromotions"]> | null;
  grind_options: NonNullable<CatalogItem["grindOptions"]> | null;
  source_identity_scheme: string;
}>;
type Availability = Readonly<{
  source_offer_key_hash: string;
  availability: string;
}>;
export type ReceivedGeneration = Readonly<{
  snapshot: Snapshot;
  batches: readonly Batch[];
  products: readonly Product[];
  variants: readonly Variant[];
  offers: readonly Offer[];
  availability: readonly Availability[];
}>;
export type VerifiedGeneration = Readonly<
  ReceivedGeneration & { items: readonly CatalogItem[] }
>;

export class CatalogActivationError extends Error {
  public readonly code: string;
  public constructor(code: string) {
    super(code);
    this.name = "CatalogActivationError";
    this.code = code;
  }
}
function reject(code: string): never {
  throw new CatalogActivationError(code);
}
const sha256 = /^[a-f0-9]{64}$/u;
const money = /^(0|[1-9][0-9]*)$/u;
function unique<T>(
  rows: readonly T[],
  keyOf: (row: T) => string,
): Map<string, T> {
  const result = new Map<string, T>();
  for (const row of rows) {
    const key = keyOf(row);
    if (!sha256.test(key) || result.has(key))
      reject("SOURCE_IDENTITY_COLLISION");
    result.set(key, row);
  }
  return result;
}

/** Verify stored, reconstructed facts rather than trusting the importer terminal record. */
export function verifyReceivedGeneration(
  input: ReceivedGeneration,
): VerifiedGeneration {
  const { snapshot, batches, products, variants, offers, availability } = input;
  if (
    snapshot.state !== "Received" ||
    snapshot.content_hash === null ||
    !sha256.test(snapshot.content_hash)
  )
    reject("ACTIVATION_INVALID_SNAPSHOT");
  const count = (
    declared: number | null,
    received: number,
    actual: number,
  ): boolean => declared !== null && declared === actual && received === actual;
  if (
    !count(
      snapshot.declared_batch_count,
      snapshot.received_batch_count,
      batches.length,
    ) ||
    snapshot.next_batch_number !== batches.length
  )
    reject("ACTIVATION_BATCH_SEQUENCE_MISMATCH");
  for (const [index, batch] of batches.entries()) {
    if (
      batch.batch_number !== index ||
      (index === 0
        ? batch.previous_batch_hash !== null
        : batch.previous_batch_hash !== batches[index - 1]!.batch_hash)
    ) {
      reject("ACTIVATION_BATCH_SEQUENCE_MISMATCH");
    }
  }
  if (
    !count(
      snapshot.declared_product_count,
      snapshot.received_product_count,
      products.length,
    ) ||
    !count(
      snapshot.declared_variant_count,
      snapshot.received_variant_count,
      variants.length,
    ) ||
    !count(
      snapshot.declared_offer_count,
      snapshot.received_offer_count,
      offers.length,
    ) ||
    availability.length !== offers.length
  )
    reject("ACTIVATION_COUNT_MISMATCH");

  const productByHash = unique(products, (row) => row.source_product_key_hash);
  const variantByHash = unique(variants, (row) => row.source_variant_key_hash);
  const offerByHash = unique(offers, (row) => row.source_offer_key_hash);
  const availabilityByHash = unique(
    availability,
    (row) => row.source_offer_key_hash,
  );
  for (const row of variants) {
    if (!productByHash.has(row.source_product_key_hash))
      reject("ACTIVATION_INVALID_REFERENCE");
    if (
      row.display_name.length === 0 ||
      !["piece", "gram", "kilogram"].includes(row.unit)
    )
      reject("ACTIVATION_INVALID_ENUM");
  }
  const referencedProducts = new Set(
    variants.map((row) => row.source_product_key_hash),
  );
  if (
    products.some((row) => !referencedProducts.has(row.source_product_key_hash))
  )
    reject("ACTIVATION_INVALID_REFERENCE");
  const variantsWithOffers = new Set<string>();
  for (const row of offers) {
    if (
      !variantByHash.has(row.source_variant_key_hash) ||
      row.batch_number < 0 ||
      row.batch_number >= batches.length
    )
      reject("ACTIVATION_INVALID_REFERENCE");
    // The owner model permits exactly one active offer mapping per variant.
    if (variantsWithOffers.has(row.source_variant_key_hash))
      reject("ACTIVATION_AMBIGUOUS_MAPPING");
    variantsWithOffers.add(row.source_variant_key_hash);
    if (row.source_identity_scheme !== "hmac-sha256-v1")
      reject("ACTIVATION_INVALID_ENUM");
    if (
      !money.test(row.supplier_unit_minor) ||
      BigInt(row.supplier_unit_minor) > 9_223_372_036_854_775_807n
    )
      reject("ACTIVATION_INVALID_MONEY");
    if (row.currency !== "RUB") reject("ACTIVATION_INVALID_CURRENCY");
    if (!availabilityByHash.has(row.source_offer_key_hash))
      reject("ACTIVATION_INVALID_REFERENCE");
  }
  if (
    variants.some((row) => !variantsWithOffers.has(row.source_variant_key_hash))
  )
    reject("ACTIVATION_INVALID_REFERENCE");
  for (const row of availability) {
    if (!offerByHash.has(row.source_offer_key_hash))
      reject("ACTIVATION_INVALID_REFERENCE");
    if (!["Available", "Unavailable", "Stopped"].includes(row.availability))
      reject("ACTIVATION_INVALID_ENUM");
  }

  const items: CatalogItem[] = [];
  const accumulator = createCatalogContentHash();
  for (const batch of batches) {
    const batchOffers = offers
      .filter((row) => row.batch_number === batch.batch_number)
      .sort((a, b) => a.item_index - b.item_index);
    if (
      batchOffers.length !== batch.offer_count ||
      batchOffers.some((row, index) => row.item_index !== index)
    ) {
      reject("ACTIVATION_BATCH_SEQUENCE_MISMATCH");
    }
    const reconstructed: CatalogItem[] = batchOffers.map((row) => {
      const variant = variantByHash.get(row.source_variant_key_hash)!;
      const product = productByHash.get(variant.source_product_key_hash)!;
      const present = availabilityByHash.get(row.source_offer_key_hash)!;
      return {
        sourceProductKeyHash: product.source_product_key_hash,
        sourceVariantKeyHash: variant.source_variant_key_hash,
        sourceOfferKeyHash: row.source_offer_key_hash,
        displayName: variant.display_name,
        unit: variant.unit as CatalogItem["unit"],
        supplierUnitMinor: row.supplier_unit_minor,
        currency: "RUB",
        availability: present.availability as CatalogItem["availability"],
        imageUrl: product.image_url,
        ...(product.category_name
          ? { categoryName: product.category_name }
          : {}),
        ...(row.supplier_promotions === null
          ? {}
          : { supplierPromotions: row.supplier_promotions }),
        ...(row.grind_options === null
          ? {}
          : { grindOptions: row.grind_options }),
        sourceIdentityScheme: "hmac-sha256-v1",
      };
    });
    if (
      catalogBatchBytes(reconstructed) !== batch.uncompressed_bytes ||
      catalogBatchHash(reconstructed) !== batch.batch_hash
    ) {
      reject("ACTIVATION_BATCH_HASH_MISMATCH");
    }
    accumulator.update(batch.batch_hash);
    items.push(...reconstructed);
  }
  if (accumulator.digest() !== snapshot.content_hash)
    reject("ACTIVATION_CONTENT_HASH_MISMATCH");
  return { ...input, items };
}
