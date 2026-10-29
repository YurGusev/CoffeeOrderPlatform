import {
  defineStatement,
  type OwnerStatement,
} from "@coffee-platform/database/owner";
import type { Database, Transaction } from "@coffee-platform/database";
import type {
  CatalogAvailability,
  CatalogCursorPosition,
  CatalogPricingInputRow,
  CatalogSearchRow,
} from "../../application/search-catalog.js";

export type CatalogPricingRow = CatalogPricingInputRow;
type SearchParameters = readonly [
  string,
  CatalogAvailability | null,
  string | null,
  string | null,
  string | null,
  number,
];
type PricingParameters = readonly [string, string, number | null];
type SearchDbRow = CatalogSearchRow & Readonly<{ cursorValid: boolean }>;
type PricingDbRow = CatalogPricingRow;

const SEARCH_SQL = `WITH metadata AS (
  SELECT snapshot_ref, snapshot_revision FROM catalog.active_snapshot_metadata
), position AS (
  SELECT product.display_name_sort_key AS sort_key,
         encode(sha256(convert_to(product.display_name_sort_key, 'UTF8')), 'hex') AS sort_key_hash
    FROM metadata
    JOIN catalog.active_products AS product ON product.snapshot_ref = metadata.snapshot_ref AND product.product_ref = $4
    JOIN catalog.active_variants AS variant ON variant.snapshot_ref = product.snapshot_ref AND variant.product_ref = product.product_ref AND variant.variant_ref = $5
), candidates AS (
  SELECT metadata.snapshot_revision AS "snapshotRevision", product.product_ref AS "productRef",
         variant.variant_ref AS "variantRef", product.display_name AS "displayName",
         product.display_name_sort_key AS "displayNameSortKey", variant.unit AS "unit",
         availability.state AS "availability",
         COALESCE(mapping.mapping_state = 'Active', false) AS "mappingAvailable", variant.image_url AS "imageUrl",
         variant.grind_options AS "grindOptions",
         mapping.offer_ref AS "offerRef", mapping.supplier_unit_minor::text AS "supplierUnitMinor",
         mapping.currency AS "currency", mapping.mapping_revision::text AS "mappingRevision"
    FROM metadata
    JOIN catalog.active_products AS product ON product.snapshot_ref = metadata.snapshot_ref
    JOIN catalog.active_variants AS variant ON variant.snapshot_ref = product.snapshot_ref AND variant.product_ref = product.product_ref
    JOIN catalog.active_availability AS availability ON availability.snapshot_ref = variant.snapshot_ref AND availability.variant_ref = variant.variant_ref
    LEFT JOIN catalog.active_offer_mappings AS mapping ON mapping.snapshot_ref = variant.snapshot_ref AND mapping.variant_ref = variant.variant_ref
   WHERE strpos(lower(normalize(product.display_name, NFKC)), $1) > 0
     AND ($2::text IS NULL OR availability.state = $2)
     AND ($3::text IS NULL OR EXISTS (
       SELECT 1 FROM position WHERE position.sort_key_hash = $3
         AND (product.display_name_sort_key, product.product_ref, variant.variant_ref) > (position.sort_key, $4, $5)
     ))
   ORDER BY product.display_name_sort_key, product.product_ref, variant.variant_ref
   LIMIT $6
)
SELECT metadata.snapshot_revision AS "snapshotRevision",
       ($3::text IS NULL OR EXISTS (SELECT 1 FROM position WHERE position.sort_key_hash = $3)) AS "cursorValid",
       candidates."productRef", candidates."variantRef",
       candidates."displayName", candidates."displayNameSortKey", candidates."unit", candidates."availability",
       candidates."mappingAvailable", candidates."imageUrl", candidates."offerRef", candidates."supplierUnitMinor",
       candidates."currency", candidates."mappingRevision", candidates."grindOptions"
  FROM metadata LEFT JOIN candidates ON true
 ORDER BY candidates."displayNameSortKey" NULLS LAST, candidates."productRef" NULLS LAST, candidates."variantRef" NULLS LAST`;

const PRICING_SQL = `WITH metadata AS (
  SELECT snapshot_ref, snapshot_revision, snapshot_created_at FROM catalog.active_snapshot_metadata
)
SELECT metadata.snapshot_revision AS "snapshotRevision", product.product_ref AS "productRef",
       variant.variant_ref AS "variantRef", product.display_name AS "displayName", variant.unit AS "unit",
       availability.state AS "availability", mapping.offer_ref AS "offerRef",
       mapping.supplier_unit_minor::text AS "supplierUnitMinor", mapping.currency AS "currency",
       mapping.mapping_revision::text AS "mappingRevision", variant.image_url AS "imageUrl",
       product.display_name_sort_key AS "displayNameSortKey", COALESCE(mapping.mapping_state = 'Active', false) AS "mappingAvailable",
       variant.grind_options AS "grindOptions",
       CASE WHEN $3::bigint IS NULL THEN true ELSE COALESCE(
         metadata.snapshot_created_at <= statement_timestamp() AND
         metadata.snapshot_created_at >= statement_timestamp() - ($3::bigint * interval '1 millisecond'), false
       ) END AS "snapshotFresh"
  FROM metadata
  LEFT JOIN catalog.active_products AS product ON product.snapshot_ref = metadata.snapshot_ref AND product.product_ref = $1
  LEFT JOIN catalog.active_variants AS variant ON variant.snapshot_ref = product.snapshot_ref AND variant.product_ref = product.product_ref AND variant.variant_ref = $2
  LEFT JOIN catalog.active_availability AS availability ON availability.snapshot_ref = variant.snapshot_ref AND availability.variant_ref = variant.variant_ref
  LEFT JOIN catalog.active_offer_mappings AS mapping ON mapping.snapshot_ref = variant.snapshot_ref AND mapping.variant_ref = variant.variant_ref`;

export class CatalogRepository {
  readonly #search: OwnerStatement<SearchDbRow, SearchParameters>;
  readonly #pricing: OwnerStatement<PricingDbRow, PricingParameters>;
  public constructor(database: Database) {
    this.#search = defineStatement<SearchDbRow, SearchParameters>(
      database,
      SEARCH_SQL,
    );
    this.#pricing = defineStatement<PricingDbRow, PricingParameters>(
      database,
      PRICING_SQL,
    );
  }
  public async search(
    transaction: Transaction,
    input: Readonly<{
      query: string;
      availability: CatalogAvailability | null;
      after: CatalogCursorPosition | null;
      limit: number;
    }>,
  ): Promise<readonly SearchDbRow[]> {
    const after = input.after;
    const result = await this.#search(transaction, [
      input.query,
      input.availability,
      after?.sortKeyHash ?? null,
      after?.productRef ?? null,
      after?.variantRef ?? null,
      input.limit,
    ] as SearchParameters);
    return result.rows;
  }
  public async pricingInput(
    transaction: Transaction,
    productRef: string,
    variantRef: string,
    maxSnapshotAgeMs?: number,
  ): Promise<PricingDbRow | undefined> {
    return (
      await this.#pricing(transaction, [
        productRef,
        variantRef,
        maxSnapshotAgeMs ?? null,
      ])
    ).rows[0];
  }
}
