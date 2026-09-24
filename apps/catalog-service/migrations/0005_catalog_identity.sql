CREATE TABLE catalog.source_identities (
  supplier_ref varchar(30) NOT NULL CHECK (supplier_ref ~ '^sup_[0-9A-HJKMNP-TV-Z]{26}$'),
  entity_type varchar(16) NOT NULL CHECK (entity_type IN ('product', 'variant', 'offer')),
  source_identity_scheme varchar(32) NOT NULL CHECK (source_identity_scheme = 'hmac-sha256-v1'),
  source_identity_hash char(64) NOT NULL CHECK (source_identity_hash ~ '^[0-9a-f]{64}$'),
  stable_ref varchar(30) NOT NULL CHECK (
    stable_ref ~ '^(prd_[0-9A-HJKMNP-TV-Z]{26}|var_[0-9A-HJKMNP-TV-Z]{26}|off_[0-9A-HJKMNP-TV-Z]{26})$'
  ),
  semantic_fingerprint char(64) NOT NULL CHECK (semantic_fingerprint ~ '^[0-9a-f]{64}$'),
  first_seen_snapshot_ref varchar(30) NOT NULL REFERENCES catalog.supplier_snapshots(snapshot_ref) ON DELETE RESTRICT,
  last_seen_snapshot_ref varchar(30) NOT NULL REFERENCES catalog.supplier_snapshots(snapshot_ref) ON DELETE RESTRICT,
  state varchar(16) NOT NULL CHECK (state IN ('Present', 'Missing', 'Stopped')),
  PRIMARY KEY (supplier_ref, entity_type, source_identity_scheme, source_identity_hash),
  UNIQUE (entity_type, stable_ref),
  CHECK (
    (entity_type = 'product' AND stable_ref ~ '^prd_[0-9A-HJKMNP-TV-Z]{26}$') OR
    (entity_type = 'variant' AND stable_ref ~ '^var_[0-9A-HJKMNP-TV-Z]{26}$') OR
    (entity_type = 'offer' AND stable_ref ~ '^off_[0-9A-HJKMNP-TV-Z]{26}$')
  )
);

CREATE TABLE catalog.offer_binding_acks (
  snapshot_ref varchar(30) NOT NULL,
  source_offer_key_hash char(64) NOT NULL CHECK (source_offer_key_hash ~ '^[0-9a-f]{64}$'),
  offer_ref varchar(30) NOT NULL CHECK (offer_ref ~ '^off_[0-9A-HJKMNP-TV-Z]{26}$'),
  state varchar(16) NOT NULL CHECK (state = 'Bound'),
  first_snapshot_ref varchar(30) NOT NULL REFERENCES catalog.supplier_snapshots(snapshot_ref) ON DELETE RESTRICT,
  acked_at timestamptz NOT NULL,
  PRIMARY KEY (snapshot_ref, source_offer_key_hash),
  FOREIGN KEY (snapshot_ref, source_offer_key_hash)
    REFERENCES catalog.snapshot_offers(snapshot_ref, source_offer_key_hash) ON DELETE RESTRICT
);
