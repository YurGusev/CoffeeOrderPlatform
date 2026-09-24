-- Forward-only addition: preserve the published 0004 checksum for existing ledgers.
ALTER TABLE catalog.variants
  ADD COLUMN grind_options jsonb CHECK (grind_options IS NULL OR jsonb_typeof(grind_options) = 'array');

CREATE OR REPLACE VIEW catalog.active_variants AS
  SELECT variant.snapshot_ref, variant.variant_ref, variant.product_ref, variant.unit,
         variant.image_url, variant.grind_options
    FROM catalog.catalog_state AS state
    JOIN catalog.variants AS variant ON variant.snapshot_ref = state.active_snapshot_ref
   WHERE state.id = true;

-- One row even when the active generation has no products or is not yet set.
-- API readers join this pointer to active rows within one consistent read transaction.
CREATE VIEW catalog.active_snapshot_metadata AS
  SELECT active_snapshot_ref AS snapshot_ref, active_snapshot_revision::text AS snapshot_revision
    FROM catalog.catalog_state WHERE id = true;

REVOKE ALL ON TABLE catalog.active_snapshot_metadata FROM PUBLIC;
GRANT SELECT ON TABLE catalog.active_snapshot_metadata TO coffee_catalog_api_ro;
