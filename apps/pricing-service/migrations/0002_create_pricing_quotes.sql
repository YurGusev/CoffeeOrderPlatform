CREATE TABLE pricing.pricing_quotes (
  quote_ref varchar(30) PRIMARY KEY CHECK (quote_ref ~ '^prq_[0-9A-HJKMNP-TV-Z]{26}$'),
  customer_ref varchar(30) NOT NULL CHECK (customer_ref ~ '^cus_[0-9A-HJKMNP-TV-Z]{26}$'),
  policy_version_ref varchar(30) NOT NULL
    REFERENCES pricing.pricing_policy_versions(policy_version_ref) ON DELETE RESTRICT,
  catalog_snapshot_revision bigint NOT NULL CHECK (catalog_snapshot_revision >= 0),
  currency char(3) NOT NULL CHECK (currency = 'RUB'),
  total_minor bigint NOT NULL CHECK (total_minor >= 0),
  canonical_hash char(64) NOT NULL CHECK (canonical_hash ~ '^[0-9a-f]{64}$'),
  internal_proof_hash char(64) NOT NULL CHECK (internal_proof_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  expires_at timestamptz NOT NULL,
  actor_ref varchar(128) NOT NULL CHECK (actor_ref <> ''),
  correlation_id uuid NOT NULL,
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CHECK (expires_at > created_at)
);

CREATE INDEX pricing_quotes_customer_created_idx
  ON pricing.pricing_quotes (customer_ref, created_at DESC);
CREATE INDEX pricing_quotes_expires_at_idx ON pricing.pricing_quotes (expires_at);

CREATE TABLE pricing.pricing_quote_lines (
  quote_ref varchar(30) NOT NULL
    REFERENCES pricing.pricing_quotes(quote_ref) ON DELETE RESTRICT,
  line_number integer NOT NULL CHECK (line_number BETWEEN 1 AND 100),
  product_ref varchar(30) NOT NULL CHECK (product_ref ~ '^prd_[0-9A-HJKMNP-TV-Z]{26}$'),
  variant_ref varchar(30) NOT NULL CHECK (variant_ref ~ '^var_[0-9A-HJKMNP-TV-Z]{26}$'),
  product_display_name text NOT NULL CHECK (product_display_name <> ''),
  offer_ref varchar(30) NOT NULL CHECK (offer_ref ~ '^off_[0-9A-HJKMNP-TV-Z]{26}$'),
  catalog_snapshot_revision bigint NOT NULL CHECK (catalog_snapshot_revision >= 0),
  mapping_revision bigint NOT NULL CHECK (mapping_revision >= 0),
  unit varchar(16) NOT NULL CHECK (unit IN ('piece', 'gram', 'kilogram')),
  quantity_milli bigint NOT NULL CHECK (quantity_milli BETWEEN 1 AND 999999999),
  supplier_unit_minor bigint NOT NULL CHECK (supplier_unit_minor >= 0),
  markup_basis_points integer NOT NULL CHECK (markup_basis_points BETWEEN 0 AND 100000),
  minimum_margin_minor bigint NOT NULL CHECK (minimum_margin_minor >= 0),
  unit_minor bigint NOT NULL CHECK (unit_minor >= 0),
  line_total_minor bigint NOT NULL CHECK (line_total_minor >= 0),
  currency char(3) NOT NULL CHECK (currency = 'RUB'),
  PRIMARY KEY (quote_ref, line_number),
  UNIQUE (quote_ref, product_ref, variant_ref),
  CHECK (unit_minor::numeric = greatest(
    ceil(supplier_unit_minor::numeric * (10000 + markup_basis_points) / 10000),
    supplier_unit_minor::numeric + minimum_margin_minor
  )),
  CHECK (line_total_minor::numeric = ceil(unit_minor::numeric * quantity_milli / 1000))
);

REVOKE ALL ON TABLE pricing.pricing_quotes, pricing.pricing_quote_lines FROM coffee_pricing_rw;
GRANT SELECT, INSERT ON TABLE pricing.pricing_quotes, pricing.pricing_quote_lines TO coffee_pricing_rw;
