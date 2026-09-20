ALTER TABLE integration.provider_source_offers
  ADD COLUMN IF NOT EXISTS source_product_key_hash char(64),
  ADD COLUMN IF NOT EXISTS source_variant_key_hash char(64);

ALTER TABLE integration.provider_source_offers
  DROP CONSTRAINT IF EXISTS provider_source_offers_source_product_key_hash_check,
  DROP CONSTRAINT IF EXISTS provider_source_offers_source_variant_key_hash_check,
  ADD CONSTRAINT provider_source_offers_source_product_key_hash_check
    CHECK (source_product_key_hash IS NULL OR source_product_key_hash ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT provider_source_offers_source_variant_key_hash_check
    CHECK (source_variant_key_hash IS NULL OR source_variant_key_hash ~ '^[a-f0-9]{64}$');

ALTER TABLE integration.provider_catalog_exports
  ADD COLUMN IF NOT EXISTS batch_count integer NOT NULL DEFAULT 0 CHECK (batch_count >= 0),
  ADD COLUMN IF NOT EXISTS product_count integer NOT NULL DEFAULT 0 CHECK (product_count >= 0),
  ADD COLUMN IF NOT EXISTS variant_count integer NOT NULL DEFAULT 0 CHECK (variant_count >= 0),
  ADD COLUMN IF NOT EXISTS offer_count integer NOT NULL DEFAULT 0 CHECK (offer_count >= 0),
  ADD COLUMN IF NOT EXISTS next_batch_number integer NOT NULL DEFAULT 0 CHECK (next_batch_number >= 0),
  ADD COLUMN IF NOT EXISTS last_batch_hash char(64)
    CHECK (last_batch_hash IS NULL OR last_batch_hash ~ '^[a-f0-9]{64}$');

CREATE TABLE integration.provider_export_batches (
  snapshot_ref varchar(30) NOT NULL,
  batch_number integer NOT NULL CHECK (batch_number >= 0),
  offer_count integer NOT NULL CHECK (offer_count > 0 AND offer_count <= 500),
  uncompressed_bytes integer NOT NULL CHECK (uncompressed_bytes >= 2 AND uncompressed_bytes <= 2097152),
  batch_hash char(64) NOT NULL CHECK (batch_hash ~ '^[a-f0-9]{64}$'),
  previous_batch_hash char(64)
    CHECK (previous_batch_hash IS NULL OR previous_batch_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (snapshot_ref, batch_number),
  FOREIGN KEY (snapshot_ref) REFERENCES integration.provider_catalog_exports(snapshot_ref) ON DELETE CASCADE
);

CREATE TABLE integration.provider_export_batch_offers (
  snapshot_ref varchar(30) NOT NULL,
  batch_number integer NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0 AND ordinal < 500),
  supplier_ref varchar(30) NOT NULL,
  source_identity_scheme varchar(32) NOT NULL,
  source_offer_key_hash char(64) NOT NULL CHECK (source_offer_key_hash ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY (snapshot_ref, batch_number, ordinal),
  UNIQUE (snapshot_ref, source_offer_key_hash),
  FOREIGN KEY (snapshot_ref, batch_number)
    REFERENCES integration.provider_export_batches(snapshot_ref, batch_number) ON DELETE CASCADE,
  FOREIGN KEY (supplier_ref, source_identity_scheme, source_offer_key_hash)
    REFERENCES integration.provider_source_offers(supplier_ref, source_identity_scheme, source_offer_key_hash)
    ON DELETE RESTRICT
);

CREATE INDEX provider_export_batch_offers_source_idx
  ON integration.provider_export_batch_offers (supplier_ref, source_identity_scheme, source_offer_key_hash);

GRANT SELECT, INSERT ON TABLE integration.provider_source_offers,
  integration.provider_catalog_exports TO coffee_aroma_gateway_rw;
GRANT SELECT, INSERT, DELETE ON TABLE integration.provider_export_batches,
  integration.provider_export_batch_offers TO coffee_aroma_gateway_rw;
