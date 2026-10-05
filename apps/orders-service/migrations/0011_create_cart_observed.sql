CREATE TABLE orders.cart_observed_revisions (
  cart_scope_ref varchar(32) NOT NULL CHECK (cart_scope_ref = 'aroma-primary'),
  observed_revision bigint NOT NULL CHECK (observed_revision > 0),
  state varchar(16) NOT NULL CHECK (state IN ('Current','Superseded')),
  provider_snapshot_ref varchar(256) NOT NULL CHECK (provider_snapshot_ref <> ''),
  cart_fingerprint char(64) NOT NULL CHECK (cart_fingerprint ~ '^[0-9a-f]{64}$'),
  captured_at timestamptz NOT NULL,
  saved_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  source_kind varchar(16) NOT NULL CHECK (source_kind IN ('Observer','Convergence')),
  source_attempt_ref varchar(30),
  fence_epoch bigint,
  complete boolean NOT NULL DEFAULT true CHECK (complete = true),
  PRIMARY KEY (cart_scope_ref,observed_revision),
  UNIQUE (cart_scope_ref,observed_revision,cart_fingerprint),
  CHECK ((source_kind = 'Observer' AND source_attempt_ref IS NULL AND fence_epoch IS NULL)
    OR (source_kind = 'Convergence' AND source_attempt_ref IS NOT NULL AND fence_epoch IS NOT NULL AND fence_epoch > 0))
);
CREATE UNIQUE INDEX orders_cart_observed_one_current
  ON orders.cart_observed_revisions (cart_scope_ref) WHERE state = 'Current';
CREATE TABLE orders.cart_observed_lines (
  cart_scope_ref varchar(32) NOT NULL,
  observed_revision bigint NOT NULL,
  offer_ref varchar(30) NOT NULL CHECK (offer_ref ~ '^off_[0-9A-HJKMNP-TV-Z]{26}$'),
  source_grind_key_hash char(64) CHECK (source_grind_key_hash IS NULL OR source_grind_key_hash ~ '^[0-9a-f]{64}$'),
  quantity_milli bigint NOT NULL CHECK (quantity_milli > 0),
  sanitized_line_hash char(64) NOT NULL CHECK (sanitized_line_hash ~ '^[0-9a-f]{64}$'),
  FOREIGN KEY (cart_scope_ref,observed_revision) REFERENCES orders.cart_observed_revisions ON DELETE RESTRICT,
  UNIQUE NULLS NOT DISTINCT (cart_scope_ref,observed_revision,offer_ref,source_grind_key_hash)
);
REVOKE ALL ON TABLE orders.cart_observed_revisions,orders.cart_observed_lines FROM PUBLIC;
CREATE TRIGGER orders_observed_revision_guard BEFORE UPDATE OR DELETE ON orders.cart_observed_revisions
  FOR EACH ROW EXECUTE FUNCTION orders.guard_cart_revision_update();
CREATE TRIGGER orders_observed_lines_insert_guard BEFORE INSERT ON orders.cart_observed_lines
  FOR EACH ROW EXECUTE FUNCTION orders.guard_cart_fact_insert();
CREATE TRIGGER orders_observed_lines_guard BEFORE UPDATE OR DELETE ON orders.cart_observed_lines
  FOR EACH ROW EXECUTE FUNCTION orders.reject_cart_fact_mutation();
GRANT SELECT,INSERT,UPDATE ON TABLE orders.cart_observed_revisions TO coffee_orders_observer_rw,coffee_orders_convergence_rw;
GRANT SELECT,INSERT ON TABLE orders.cart_observed_lines TO coffee_orders_observer_rw,coffee_orders_convergence_rw;
GRANT SELECT ON TABLE orders.cart_observed_revisions,orders.cart_observed_lines TO coffee_orders_prepare_rw;
