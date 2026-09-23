ALTER TABLE catalog.supplier_snapshots
  DROP CONSTRAINT supplier_snapshots_state_check,
  DROP CONSTRAINT supplier_snapshots_check,
  DROP CONSTRAINT supplier_snapshots_check1;

ALTER TABLE catalog.supplier_snapshots
  ADD CONSTRAINT supplier_snapshots_state_check
    CHECK (state IN ('Created', 'Receiving', 'Received', 'Rejected', 'Active', 'Superseded')),
  ADD CONSTRAINT supplier_snapshots_provider_required_check
    CHECK (state NOT IN ('Receiving', 'Received', 'Active', 'Superseded') OR provider_snapshot_ref IS NOT NULL),
  ADD CONSTRAINT supplier_snapshots_terminal_metadata_check CHECK (
    (state IN ('Received', 'Active', 'Superseded')
      AND declared_batch_count IS NOT NULL AND declared_product_count IS NOT NULL
      AND declared_variant_count IS NOT NULL AND declared_offer_count IS NOT NULL
      AND content_hash IS NOT NULL AND received_at IS NOT NULL AND failure_code IS NULL)
    OR
    (state IN ('Created', 'Receiving', 'Rejected')
      AND declared_batch_count IS NULL AND declared_product_count IS NULL
      AND declared_variant_count IS NULL AND declared_offer_count IS NULL
      AND content_hash IS NULL AND received_at IS NULL)
  );

CREATE TABLE catalog.catalog_state (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  active_snapshot_ref varchar(30) REFERENCES catalog.supplier_snapshots(snapshot_ref) ON DELETE RESTRICT,
  active_snapshot_revision bigint CHECK (active_snapshot_revision IS NULL OR active_snapshot_revision > 0),
  active_content_hash char(64) CHECK (active_content_hash IS NULL OR active_content_hash ~ '^[0-9a-f]{64}$'),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (
    (active_snapshot_ref IS NULL AND active_snapshot_revision IS NULL AND active_content_hash IS NULL)
    OR
    (active_snapshot_ref IS NOT NULL AND active_snapshot_revision IS NOT NULL AND active_content_hash IS NOT NULL)
  )
);

INSERT INTO catalog.catalog_state (id) VALUES (true);

CREATE TABLE catalog.products (
  snapshot_ref varchar(30) NOT NULL REFERENCES catalog.supplier_snapshots(snapshot_ref) ON DELETE RESTRICT,
  product_ref varchar(30) NOT NULL CHECK (product_ref ~ '^prd_[0-9A-HJKMNP-TV-Z]{26}$'),
  display_name text NOT NULL CHECK (display_name <> ''),
  display_name_sort_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (snapshot_ref, product_ref)
);

CREATE TABLE catalog.variants (
  snapshot_ref varchar(30) NOT NULL,
  variant_ref varchar(30) NOT NULL CHECK (variant_ref ~ '^var_[0-9A-HJKMNP-TV-Z]{26}$'),
  product_ref varchar(30) NOT NULL,
  unit varchar(16) NOT NULL CHECK (unit IN ('piece', 'gram', 'kilogram')),
  image_url text,
  grind_options jsonb CHECK (grind_options IS NULL OR jsonb_typeof(grind_options) = 'array'),
  PRIMARY KEY (snapshot_ref, variant_ref),
  FOREIGN KEY (snapshot_ref, product_ref)
    REFERENCES catalog.products(snapshot_ref, product_ref) ON DELETE RESTRICT
);

CREATE TABLE catalog.offer_mappings (
  snapshot_ref varchar(30) NOT NULL,
  variant_ref varchar(30) NOT NULL,
  offer_ref varchar(30) CHECK (offer_ref IS NULL OR offer_ref ~ '^off_[0-9A-HJKMNP-TV-Z]{26}$'),
  mapping_revision bigint NOT NULL CHECK (mapping_revision > 0),
  mapping_state varchar(16) NOT NULL CHECK (mapping_state IN ('Active', 'Missing', 'Stopped')),
  supplier_unit_minor bigint CHECK (supplier_unit_minor IS NULL OR supplier_unit_minor >= 0),
  currency char(3) CHECK (currency IS NULL OR currency = 'RUB'),
  effective_at timestamptz NOT NULL,
  PRIMARY KEY (snapshot_ref, variant_ref),
  UNIQUE (snapshot_ref, offer_ref),
  FOREIGN KEY (snapshot_ref, variant_ref)
    REFERENCES catalog.variants(snapshot_ref, variant_ref) ON DELETE RESTRICT,
  CHECK (
    (mapping_state = 'Active' AND offer_ref IS NOT NULL AND supplier_unit_minor IS NOT NULL AND currency = 'RUB')
    OR
    (mapping_state IN ('Missing', 'Stopped') AND offer_ref IS NULL AND supplier_unit_minor IS NULL AND currency IS NULL)
  )
);

CREATE TABLE catalog.availability (
  snapshot_ref varchar(30) NOT NULL,
  variant_ref varchar(30) NOT NULL,
  state varchar(16) NOT NULL CHECK (state IN ('Available', 'Unavailable', 'Stopped')),
  checked_at timestamptz NOT NULL,
  PRIMARY KEY (snapshot_ref, variant_ref),
  FOREIGN KEY (snapshot_ref, variant_ref)
    REFERENCES catalog.variants(snapshot_ref, variant_ref) ON DELETE RESTRICT
);

CREATE VIEW catalog.active_products AS
  SELECT product.snapshot_ref, product.product_ref, product.display_name, product.display_name_sort_key, product.created_at
    FROM catalog.catalog_state AS state
    JOIN catalog.products AS product ON product.snapshot_ref = state.active_snapshot_ref
   WHERE state.id = true;

CREATE VIEW catalog.active_variants AS
  SELECT variant.snapshot_ref, variant.variant_ref, variant.product_ref, variant.unit, variant.image_url, variant.grind_options
    FROM catalog.catalog_state AS state
    JOIN catalog.variants AS variant ON variant.snapshot_ref = state.active_snapshot_ref
   WHERE state.id = true;

CREATE VIEW catalog.active_offer_mappings AS
  SELECT mapping.snapshot_ref, mapping.variant_ref, mapping.offer_ref, mapping.mapping_revision,
         mapping.mapping_state, mapping.supplier_unit_minor, mapping.currency, mapping.effective_at
    FROM catalog.catalog_state AS state
    JOIN catalog.offer_mappings AS mapping ON mapping.snapshot_ref = state.active_snapshot_ref
   WHERE state.id = true;

CREATE VIEW catalog.active_availability AS
  SELECT availability.snapshot_ref, availability.variant_ref, availability.state, availability.checked_at
    FROM catalog.catalog_state AS state
    JOIN catalog.availability AS availability ON availability.snapshot_ref = state.active_snapshot_ref
   WHERE state.id = true;
