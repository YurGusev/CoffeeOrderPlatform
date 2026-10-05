CREATE TABLE orders.cart_desired_revisions (
  cart_scope_ref varchar(32) NOT NULL CHECK (cart_scope_ref = 'aroma-primary'),
  desired_revision bigint NOT NULL CHECK (desired_revision > 0),
  state varchar(16) NOT NULL CHECK (state IN ('Current','Superseded')),
  desired_hash char(64) NOT NULL CHECK (desired_hash ~ '^[0-9a-f]{64}$'),
  source_max_order_version bigint NOT NULL CHECK (source_max_order_version >= 0),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (cart_scope_ref,desired_revision),
  UNIQUE (cart_scope_ref,desired_revision,desired_hash)
);
CREATE UNIQUE INDEX orders_cart_desired_one_current
  ON orders.cart_desired_revisions (cart_scope_ref) WHERE state = 'Current';
-- Только lifecycle Current -> Superseded изменяем; содержимое revision является фактом.
CREATE FUNCTION orders.guard_cart_revision_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'cart revision cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF OLD.state = 'Superseded' OR NEW.state <> 'Superseded' OR (to_jsonb(NEW) - 'state') IS DISTINCT FROM (to_jsonb(OLD) - 'state') THEN
    RAISE EXCEPTION 'cart revision facts are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE FUNCTION orders.reject_cart_fact_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'cart facts are append-only' USING ERRCODE = '23514';
END;
$$;
-- Полный snapshot/Desired собирается только в transaction создания revision.
-- xmin не добавляет business lifecycle state; после commit append изменил бы сохранённый факт.
CREATE FUNCTION orders.guard_cart_fact_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  creator xid;
  revision_state text;
BEGIN
  IF TG_TABLE_NAME IN ('cart_desired_lines','cart_desired_blockers','cart_desired_order_facts') THEN
    SELECT xmin,state INTO creator,revision_state FROM orders.cart_desired_revisions
      WHERE cart_scope_ref = NEW.cart_scope_ref AND desired_revision = NEW.desired_revision;
  ELSE
    SELECT xmin,state INTO creator,revision_state FROM orders.cart_observed_revisions
      WHERE cart_scope_ref = NEW.cart_scope_ref AND observed_revision = NEW.observed_revision;
  END IF;
  IF FOUND AND (creator IS DISTINCT FROM pg_current_xact_id()::xid OR revision_state <> 'Current') THEN
    RAISE EXCEPTION 'cart facts must be inserted atomically with a Current revision' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER orders_desired_revision_guard BEFORE UPDATE OR DELETE ON orders.cart_desired_revisions
  FOR EACH ROW EXECUTE FUNCTION orders.guard_cart_revision_update();
CREATE TABLE orders.cart_desired_lines (
  cart_scope_ref varchar(32) NOT NULL,
  desired_revision bigint NOT NULL,
  offer_ref varchar(30) NOT NULL CHECK (offer_ref ~ '^off_[0-9A-HJKMNP-TV-Z]{26}$'),
  source_grind_key_hash char(64) CHECK (source_grind_key_hash IS NULL OR source_grind_key_hash ~ '^[0-9a-f]{64}$'),
  quantity_milli bigint NOT NULL CHECK (quantity_milli > 0),
  contribution_hash char(64) NOT NULL CHECK (contribution_hash ~ '^[0-9a-f]{64}$'),
  contributing_order_refs jsonb NOT NULL CHECK (jsonb_typeof(contributing_order_refs) = 'array'),
  FOREIGN KEY (cart_scope_ref,desired_revision) REFERENCES orders.cart_desired_revisions ON DELETE RESTRICT,
  UNIQUE NULLS NOT DISTINCT (cart_scope_ref,desired_revision,offer_ref,source_grind_key_hash)
);
CREATE TABLE orders.cart_desired_blockers (
  cart_scope_ref varchar(32) NOT NULL,
  desired_revision bigint NOT NULL,
  order_ref varchar(30) NOT NULL REFERENCES orders.orders(order_ref) ON DELETE RESTRICT,
  product_ref varchar(30) NOT NULL CHECK (product_ref ~ '^prd_[0-9A-HJKMNP-TV-Z]{26}$'),
  variant_ref varchar(30) NOT NULL CHECK (variant_ref ~ '^var_[0-9A-HJKMNP-TV-Z]{26}$'),
  code varchar(32) NOT NULL CHECK (code IN ('MAPPING_CHANGED','MAPPING_MISSING','MAPPING_STOPPED','PRODUCT_UNAVAILABLE','AROMA_QUANTITY_NOT_SUPPORTED')),
  mapping_revision bigint CHECK (mapping_revision IS NULL OR mapping_revision >= 0),
  FOREIGN KEY (cart_scope_ref,desired_revision) REFERENCES orders.cart_desired_revisions ON DELETE RESTRICT,
  PRIMARY KEY (cart_scope_ref,desired_revision,order_ref,product_ref,variant_ref,code)
);
CREATE TRIGGER orders_desired_lines_insert_guard BEFORE INSERT ON orders.cart_desired_lines
  FOR EACH ROW EXECUTE FUNCTION orders.guard_cart_fact_insert();
CREATE TRIGGER orders_desired_blockers_insert_guard BEFORE INSERT ON orders.cart_desired_blockers
  FOR EACH ROW EXECUTE FUNCTION orders.guard_cart_fact_insert();
REVOKE ALL ON FUNCTION orders.guard_cart_fact_insert() FROM PUBLIC;
CREATE TRIGGER orders_desired_lines_guard BEFORE UPDATE OR DELETE ON orders.cart_desired_lines
  FOR EACH ROW EXECUTE FUNCTION orders.reject_cart_fact_mutation();
CREATE TRIGGER orders_desired_blockers_guard BEFORE UPDATE OR DELETE ON orders.cart_desired_blockers
  FOR EACH ROW EXECUTE FUNCTION orders.reject_cart_fact_mutation();
REVOKE ALL ON FUNCTION orders.guard_cart_revision_update(),orders.reject_cart_fact_mutation() FROM PUBLIC;
REVOKE ALL ON TABLE orders.cart_desired_revisions,orders.cart_desired_lines,orders.cart_desired_blockers FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON TABLE orders.cart_desired_revisions TO coffee_orders_prepare_rw;
GRANT SELECT,INSERT ON TABLE orders.cart_desired_lines,orders.cart_desired_blockers TO coffee_orders_prepare_rw;
GRANT SELECT ON TABLE orders.cart_desired_revisions,orders.cart_desired_lines TO coffee_orders_observer_rw;
GRANT SELECT ON TABLE orders.cart_desired_revisions,orders.cart_desired_lines,orders.cart_desired_blockers TO coffee_orders_convergence_rw;
