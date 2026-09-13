ALTER TABLE integration.provider_source_offers
  ADD COLUMN IF NOT EXISTS raw_provider_product_id varchar(256),
  ADD COLUMN IF NOT EXISTS raw_provider_variant_id varchar(256),
  ADD COLUMN IF NOT EXISTS provider_packing varchar(256),
  ADD COLUMN IF NOT EXISTS provider_grind_id varchar(256);

ALTER TABLE integration.provider_source_offers
  DROP CONSTRAINT IF EXISTS provider_source_offers_raw_provider_product_id_check,
  DROP CONSTRAINT IF EXISTS provider_source_offers_raw_provider_variant_id_check,
  ADD CONSTRAINT provider_source_offers_raw_provider_product_id_check
    CHECK (raw_provider_product_id IS NULL OR raw_provider_product_id <> ''),
  ADD CONSTRAINT provider_source_offers_raw_provider_variant_id_check
    CHECK (raw_provider_variant_id IS NULL OR raw_provider_variant_id <> '');

CREATE INDEX IF NOT EXISTS provider_source_offers_identity_idx
  ON integration.provider_source_offers (raw_provider_offer_id, provider_packing, provider_grind_id);
