CREATE SCHEMA IF NOT EXISTS integration;

CREATE TABLE integration.provider_catalog_exports (
  snapshot_ref varchar(30) PRIMARY KEY
    CHECK (snapshot_ref ~ '^snp_[0-9A-HJKMNP-TV-Z]{26}$'),
  supplier_ref varchar(30) NOT NULL
    CHECK (supplier_ref ~ '^sup_[0-9A-HJKMNP-TV-Z]{26}$'),
  source_identity_scheme varchar(32) NOT NULL
    CHECK (source_identity_scheme = 'hmac-sha256-v1'),
  state varchar(16) NOT NULL
    CHECK (state IN ('Exporting', 'Completed', 'Failed')),
  content_hash char(64)
    CHECK (content_hash IS NULL OR content_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (snapshot_ref, supplier_ref, source_identity_scheme),
  CHECK (state <> 'Completed' OR content_hash IS NOT NULL)
);

CREATE TABLE integration.provider_source_offers (
  supplier_ref varchar(30) NOT NULL
    CHECK (supplier_ref ~ '^sup_[0-9A-HJKMNP-TV-Z]{26}$'),
  source_identity_scheme varchar(32) NOT NULL
    CHECK (source_identity_scheme = 'hmac-sha256-v1'),
  source_offer_key_hash char(64) NOT NULL
    CHECK (source_offer_key_hash ~ '^[a-f0-9]{64}$'),
  raw_provider_offer_id varchar(256) NOT NULL CHECK (raw_provider_offer_id <> ''),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (supplier_ref, source_identity_scheme, source_offer_key_hash),
  UNIQUE (supplier_ref, source_identity_scheme, raw_provider_offer_id)
);

CREATE TABLE integration.provider_export_offers (
  snapshot_ref varchar(30) NOT NULL,
  supplier_ref varchar(30) NOT NULL,
  source_identity_scheme varchar(32) NOT NULL,
  source_offer_key_hash char(64) NOT NULL,
  PRIMARY KEY (snapshot_ref, supplier_ref, source_identity_scheme, source_offer_key_hash),
  FOREIGN KEY (snapshot_ref, supplier_ref, source_identity_scheme)
    REFERENCES integration.provider_catalog_exports (snapshot_ref, supplier_ref, source_identity_scheme)
    ON DELETE RESTRICT,
  FOREIGN KEY (supplier_ref, source_identity_scheme, source_offer_key_hash)
    REFERENCES integration.provider_source_offers (supplier_ref, source_identity_scheme, source_offer_key_hash)
    ON DELETE RESTRICT
);

CREATE TABLE integration.provider_offer_bindings (
  offer_ref varchar(30) PRIMARY KEY
    CHECK (offer_ref ~ '^off_[0-9A-HJKMNP-TV-Z]{26}$'),
  supplier_ref varchar(30) NOT NULL
    CHECK (supplier_ref ~ '^sup_[0-9A-HJKMNP-TV-Z]{26}$'),
  source_identity_scheme varchar(32) NOT NULL
    CHECK (source_identity_scheme = 'hmac-sha256-v1'),
  source_offer_key_hash char(64) NOT NULL
    CHECK (source_offer_key_hash ~ '^[a-f0-9]{64}$'),
  first_snapshot_ref varchar(30) NOT NULL
    CHECK (first_snapshot_ref ~ '^snp_[0-9A-HJKMNP-TV-Z]{26}$'),
  state varchar(16) NOT NULL DEFAULT 'Bound' CHECK (state = 'Bound'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (supplier_ref, source_identity_scheme, source_offer_key_hash),
  FOREIGN KEY (supplier_ref, source_identity_scheme, source_offer_key_hash)
    REFERENCES integration.provider_source_offers (supplier_ref, source_identity_scheme, source_offer_key_hash)
    ON DELETE RESTRICT,
  FOREIGN KEY (first_snapshot_ref, supplier_ref, source_identity_scheme, source_offer_key_hash)
    REFERENCES integration.provider_export_offers (snapshot_ref, supplier_ref, source_identity_scheme, source_offer_key_hash)
    ON DELETE RESTRICT
);

GRANT USAGE ON SCHEMA integration TO coffee_aroma_gateway_rw;
GRANT SELECT, INSERT, UPDATE ON TABLE integration.provider_catalog_exports TO coffee_aroma_gateway_rw;
GRANT SELECT, INSERT ON TABLE integration.provider_source_offers,
  integration.provider_export_offers, integration.provider_offer_bindings TO coffee_aroma_gateway_rw;
