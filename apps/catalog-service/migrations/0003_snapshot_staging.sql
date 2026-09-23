CREATE TABLE catalog.snapshot_products (
  snapshot_ref varchar(30) NOT NULL REFERENCES catalog.supplier_snapshots(snapshot_ref) ON DELETE RESTRICT,
  source_product_key_hash char(64) NOT NULL CHECK (source_product_key_hash ~ '^[0-9a-f]{64}$'),
  image_url text,
  PRIMARY KEY (snapshot_ref, source_product_key_hash)
);

CREATE TABLE catalog.snapshot_variants (
  snapshot_ref varchar(30) NOT NULL,
  source_variant_key_hash char(64) NOT NULL CHECK (source_variant_key_hash ~ '^[0-9a-f]{64}$'),
  source_product_key_hash char(64) NOT NULL CHECK (source_product_key_hash ~ '^[0-9a-f]{64}$'),
  display_name text NOT NULL CHECK (display_name <> ''),
  unit varchar(16) NOT NULL CHECK (unit IN ('piece', 'gram', 'kilogram')),
  PRIMARY KEY (snapshot_ref, source_variant_key_hash),
  FOREIGN KEY (snapshot_ref, source_product_key_hash)
    REFERENCES catalog.snapshot_products(snapshot_ref, source_product_key_hash) ON DELETE RESTRICT
);

CREATE TABLE catalog.snapshot_offers (
  snapshot_ref varchar(30) NOT NULL,
  source_offer_key_hash char(64) NOT NULL CHECK (source_offer_key_hash ~ '^[0-9a-f]{64}$'),
  source_variant_key_hash char(64) NOT NULL CHECK (source_variant_key_hash ~ '^[0-9a-f]{64}$'),
  batch_number integer NOT NULL CHECK (batch_number >= 0),
  item_index integer NOT NULL CHECK (item_index >= 0),
  supplier_unit_minor text NOT NULL CHECK (supplier_unit_minor ~ '^(0|[1-9][0-9]*)$'),
  currency char(3) NOT NULL CHECK (currency = 'RUB'),
  supplier_promotions jsonb,
  grind_options jsonb,
  source_identity_scheme varchar(32) NOT NULL CHECK (source_identity_scheme = 'hmac-sha256-v1'),
  PRIMARY KEY (snapshot_ref, source_offer_key_hash),
  UNIQUE (snapshot_ref, batch_number, item_index),
  FOREIGN KEY (snapshot_ref, source_variant_key_hash)
    REFERENCES catalog.snapshot_variants(snapshot_ref, source_variant_key_hash) ON DELETE RESTRICT,
  FOREIGN KEY (snapshot_ref, batch_number)
    REFERENCES catalog.snapshot_batches(snapshot_ref, batch_number) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE catalog.snapshot_availability (
  snapshot_ref varchar(30) NOT NULL,
  source_offer_key_hash char(64) NOT NULL CHECK (source_offer_key_hash ~ '^[0-9a-f]{64}$'),
  availability varchar(16) NOT NULL CHECK (availability IN ('Available', 'Unavailable', 'Stopped')),
  PRIMARY KEY (snapshot_ref, source_offer_key_hash),
  FOREIGN KEY (snapshot_ref, source_offer_key_hash)
    REFERENCES catalog.snapshot_offers(snapshot_ref, source_offer_key_hash) ON DELETE RESTRICT
);

REVOKE ALL ON TABLE catalog.snapshot_products, catalog.snapshot_variants,
  catalog.snapshot_offers, catalog.snapshot_availability FROM coffee_catalog_import_rw;
GRANT SELECT, INSERT ON TABLE catalog.snapshot_products, catalog.snapshot_variants,
  catalog.snapshot_offers, catalog.snapshot_availability TO coffee_catalog_import_rw;
