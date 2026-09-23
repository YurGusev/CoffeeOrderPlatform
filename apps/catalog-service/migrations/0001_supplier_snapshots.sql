CREATE SCHEMA IF NOT EXISTS catalog;

CREATE TABLE catalog.supplier_snapshots (
  snapshot_ref varchar(30) PRIMARY KEY CHECK (snapshot_ref ~ '^snp_[0-9A-HJKMNP-TV-Z]{26}$'),
  supplier_ref varchar(30) NOT NULL CHECK (supplier_ref ~ '^sup_[0-9A-HJKMNP-TV-Z]{26}$'),
  provider_snapshot_ref text,
  state varchar(16) NOT NULL CHECK (state IN ('Created', 'Receiving', 'Received', 'Rejected')),
  next_batch_number integer NOT NULL DEFAULT 0 CHECK (next_batch_number >= 0),
  declared_batch_count integer CHECK (declared_batch_count >= 0),
  declared_product_count integer CHECK (declared_product_count >= 0),
  declared_variant_count integer CHECK (declared_variant_count >= 0),
  declared_offer_count integer CHECK (declared_offer_count >= 0),
  received_batch_count integer NOT NULL DEFAULT 0 CHECK (received_batch_count >= 0),
  received_product_count integer NOT NULL DEFAULT 0 CHECK (received_product_count >= 0),
  received_variant_count integer NOT NULL DEFAULT 0 CHECK (received_variant_count >= 0),
  received_offer_count integer NOT NULL DEFAULT 0 CHECK (received_offer_count >= 0),
  content_hash char(64) CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  failure_code varchar(64),
  received_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (provider_snapshot_ref IS NULL OR provider_snapshot_ref <> ''),
  CHECK (state NOT IN ('Receiving', 'Received') OR provider_snapshot_ref IS NOT NULL),
  CHECK (
    (state = 'Received' AND declared_batch_count IS NOT NULL AND declared_product_count IS NOT NULL
      AND declared_variant_count IS NOT NULL AND declared_offer_count IS NOT NULL
      AND content_hash IS NOT NULL AND received_at IS NOT NULL AND failure_code IS NULL)
    OR
    (state <> 'Received' AND declared_batch_count IS NULL AND declared_product_count IS NULL
      AND declared_variant_count IS NULL AND declared_offer_count IS NULL
      AND content_hash IS NULL AND received_at IS NULL)
  ),
  CHECK ((state = 'Rejected' AND failure_code IS NOT NULL) OR (state <> 'Rejected' AND failure_code IS NULL))
);

REVOKE ALL ON SCHEMA catalog FROM PUBLIC;
GRANT USAGE ON SCHEMA catalog TO coffee_catalog_import_rw;
REVOKE ALL ON TABLE catalog.supplier_snapshots FROM coffee_catalog_import_rw;
GRANT SELECT, INSERT, UPDATE ON TABLE catalog.supplier_snapshots TO coffee_catalog_import_rw;
