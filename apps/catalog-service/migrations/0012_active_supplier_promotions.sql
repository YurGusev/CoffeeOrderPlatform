-- Правила принадлежат только полному активному snapshot; Missing не наследует старые акции.
CREATE OR REPLACE VIEW catalog.active_variants AS
  SELECT variant.snapshot_ref, variant.variant_ref, variant.product_ref, variant.unit,
         variant.image_url, variant.grind_options, offer.supplier_promotions
    FROM catalog.catalog_state AS state
    JOIN catalog.variants AS variant ON variant.snapshot_ref = state.active_snapshot_ref
    LEFT JOIN catalog.source_identities AS identity
      ON identity.entity_type = 'variant' AND identity.stable_ref = variant.variant_ref
    LEFT JOIN catalog.snapshot_offers AS offer
      ON offer.snapshot_ref = variant.snapshot_ref
     AND offer.source_variant_key_hash = identity.source_identity_hash
   WHERE state.id = true;
