CREATE SCHEMA IF NOT EXISTS pricing;
REVOKE ALL ON SCHEMA pricing FROM PUBLIC;
GRANT USAGE ON SCHEMA pricing TO coffee_pricing_rw;

CREATE TABLE pricing.pricing_policy_versions (
  policy_version_ref varchar(30) PRIMARY KEY
    CHECK (policy_version_ref ~ '^pvr_[0-9A-HJKMNP-TV-Z]{26}$'),
  version bigint NOT NULL UNIQUE CHECK (version > 0),
  currency char(3) NOT NULL CHECK (currency = 'RUB'),
  markup_basis_points integer NOT NULL CHECK (markup_basis_points BETWEEN 0 AND 100000),
  minimum_margin_minor bigint NOT NULL CHECK (minimum_margin_minor >= 0),
  quote_ttl_seconds integer NOT NULL CHECK (quote_ttl_seconds BETWEEN 60 AND 3600),
  quantity_scale integer NOT NULL CHECK (quantity_scale = 3),
  rounding_mode varchar(16) NOT NULL CHECK (rounding_mode = 'CEILING'),
  status varchar(16) NOT NULL CHECK (status IN ('Draft', 'Active', 'Retired')),
  valid_from timestamptz NOT NULL,
  valid_to timestamptz,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  created_by_actor_ref varchar(128) NOT NULL CHECK (created_by_actor_ref <> ''),
  CHECK (valid_to IS NULL OR valid_to > valid_from)
);

CREATE UNIQUE INDEX pricing_one_active_policy_per_currency
  ON pricing.pricing_policy_versions (currency) WHERE status = 'Active';

-- A new policy is a new version, not an UPDATE of the bootstrap policy.
INSERT INTO pricing.pricing_policy_versions
  (policy_version_ref, version, currency, markup_basis_points, minimum_margin_minor,
   quote_ttl_seconds, quantity_scale, rounding_mode, status, valid_from, created_by_actor_ref)
VALUES
  ('pvr_00000000000000000000000001', 1, 'RUB', 3000, 0,
   900, 3, 'CEILING', 'Active', transaction_timestamp(), 'pricing-bootstrap');

REVOKE ALL ON TABLE pricing.pricing_policy_versions FROM coffee_pricing_rw;
GRANT SELECT ON TABLE pricing.pricing_policy_versions TO coffee_pricing_rw;
