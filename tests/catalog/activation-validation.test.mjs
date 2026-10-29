import assert from "node:assert/strict";
import { test } from "node:test";
import {
  catalogBatchBytes,
  catalogBatchHash,
  catalogContentHash,
} from "../../packages/contracts/aroma-v1/dist/index.js";
import { verifyReceivedGeneration } from "../../apps/catalog-activation-worker/dist/verify-generation.js";

const P = "1".repeat(64);
const V = "2".repeat(64);
const O = "3".repeat(64);
const S = `snp_${"0".repeat(26)}`;
const SUP = `sup_${"0".repeat(26)}`;

function fixture() {
  const product = { source_product_key_hash: P, image_url: null };
  const variant = {
    source_variant_key_hash: V,
    source_product_key_hash: P,
    display_name: "Кофе",
    unit: "piece",
  };
  const offer = {
    source_offer_key_hash: O,
    source_variant_key_hash: V,
    batch_number: 0,
    item_index: 0,
    supplier_unit_minor: "12345",
    currency: "RUB",
    supplier_promotions: [],
    grind_options: [],
    source_identity_scheme: "hmac-sha256-v1",
  };
  const availability = { source_offer_key_hash: O, availability: "Available" };
  const items = [
    {
      sourceProductKeyHash: P,
      sourceVariantKeyHash: V,
      sourceOfferKeyHash: O,
      displayName: "Кофе",
      unit: "piece",
      supplierUnitMinor: "12345",
      currency: "RUB",
      availability: "Available",
      imageUrl: null,
      supplierPromotions: [],
      grindOptions: [],
      sourceIdentityScheme: "hmac-sha256-v1",
    },
  ];
  const batchHash = catalogBatchHash(items);
  return {
    snapshot: {
      snapshot_ref: S,
      supplier_ref: SUP,
      state: "Received",
      next_batch_number: 1,
      declared_batch_count: 1,
      declared_product_count: 1,
      declared_variant_count: 1,
      declared_offer_count: 1,
      received_batch_count: 1,
      received_product_count: 1,
      received_variant_count: 1,
      received_offer_count: 1,
      content_hash: catalogContentHash([batchHash]),
    },
    batches: [
      {
        batch_number: 0,
        offer_count: 1,
        uncompressed_bytes: catalogBatchBytes(items),
        batch_hash: batchHash,
        previous_batch_hash: null,
      },
    ],
    products: [product],
    variants: [variant],
    offers: [offer],
    availability: [availability],
  };
}

function fails(generation, code) {
  assert.throws(
    () => verifyReceivedGeneration(generation),
    (error) => error.code === code,
    code,
  );
}

void test("reconstitutes canonical items and validates all durable hashes/counts", () => {
  const input = fixture();
  const result = verifyReceivedGeneration(input);
  assert.equal(result.snapshot.snapshot_ref, S);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].sourceOfferKeyHash, O);
});

void test("missing or out-of-order batch fails closed", () => {
  const generation = fixture();
  generation.batches = [];
  fails(generation, "ACTIVATION_BATCH_SEQUENCE_MISMATCH");
  const other = fixture();
  other.batches[0].batch_number = 1;
  fails(other, "ACTIVATION_BATCH_SEQUENCE_MISMATCH");
});

void test("durable batch bytes/hash or terminal content hash cannot be trusted", () => {
  const bytes = fixture();
  bytes.batches[0].uncompressed_bytes++;
  fails(bytes, "ACTIVATION_BATCH_HASH_MISMATCH");
  const hash = fixture();
  hash.batches[0].batch_hash = "0".repeat(64);
  fails(hash, "ACTIVATION_BATCH_HASH_MISMATCH");
  const terminal = fixture();
  terminal.snapshot.content_hash = "0".repeat(64);
  fails(terminal, "ACTIVATION_CONTENT_HASH_MISMATCH");
});

void test("counts, orphan references and duplicate source identities reject generation", () => {
  const counts = fixture();
  counts.snapshot.declared_variant_count = 2;
  fails(counts, "ACTIVATION_COUNT_MISMATCH");
  const orphan = fixture();
  orphan.variants[0].source_product_key_hash = "4".repeat(64);
  fails(orphan, "ACTIVATION_INVALID_REFERENCE");
  const duplicate = fixture();
  duplicate.offers.push({ ...duplicate.offers[0] });
  duplicate.availability.push({ ...duplicate.availability[0] });
  duplicate.snapshot.declared_offer_count = 2;
  duplicate.snapshot.received_offer_count = 2;
  fails(duplicate, "SOURCE_IDENTITY_COLLISION");
});

void test("invalid enums, money and currency reject even when SQL checks were bypassed", () => {
  const money = fixture();
  money.offers[0].supplier_unit_minor = "-1";
  fails(money, "ACTIVATION_INVALID_MONEY");
  const currency = fixture();
  currency.offers[0].currency = "USD";
  fails(currency, "ACTIVATION_INVALID_CURRENCY");
  const availability = fixture();
  availability.availability[0].availability = "UNKNOWN";
  fails(availability, "ACTIVATION_INVALID_ENUM");
});

void test("unreferenced entities and multiple offers for one variant fail closed", () => {
  const product = fixture();
  product.products.push({
    source_product_key_hash: "4".repeat(64),
    image_url: null,
  });
  product.snapshot.declared_product_count =
    product.snapshot.received_product_count = 2;
  fails(product, "ACTIVATION_INVALID_REFERENCE");
  const variant = fixture();
  variant.variants.push({
    ...variant.variants[0],
    source_variant_key_hash: "5".repeat(64),
  });
  variant.snapshot.declared_variant_count =
    variant.snapshot.received_variant_count = 2;
  fails(variant, "ACTIVATION_INVALID_REFERENCE");
  const ambiguous = fixture();
  ambiguous.offers.push({
    ...ambiguous.offers[0],
    source_offer_key_hash: "6".repeat(64),
    item_index: 1,
  });
  ambiguous.availability.push({
    ...ambiguous.availability[0],
    source_offer_key_hash: "6".repeat(64),
  });
  ambiguous.snapshot.declared_offer_count =
    ambiguous.snapshot.received_offer_count = 2;
  fails(ambiguous, "ACTIVATION_AMBIGUOUS_MAPPING");
});
