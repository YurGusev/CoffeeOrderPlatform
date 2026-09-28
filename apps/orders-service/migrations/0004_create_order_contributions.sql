CREATE TABLE orders.order_desired_contributions (
  order_ref varchar(30) NOT NULL
    REFERENCES orders.orders(order_ref) ON DELETE RESTRICT,
  contribution_revision bigint NOT NULL CHECK (contribution_revision > 0),
  order_version bigint NOT NULL CHECK (order_version > 0),
  state varchar(16) NOT NULL DEFAULT 'Current' CHECK (state = 'Current'),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (order_ref, contribution_revision),
  UNIQUE (order_ref, contribution_revision, order_version)
);

CREATE UNIQUE INDEX order_desired_contributions_one_current_uq
  ON orders.order_desired_contributions (order_ref) WHERE state = 'Current';

CREATE TABLE orders.order_desired_contribution_lines (
  order_ref varchar(30) NOT NULL,
  contribution_revision bigint NOT NULL,
  offer_ref varchar(30) NOT NULL
    CHECK (offer_ref ~ '^off_[0-9A-HJKMNP-TV-Z]{26}$'),
  quantity_milli bigint NOT NULL CHECK (quantity_milli > 0),
  contribution_hash char(64) NOT NULL CHECK (contribution_hash ~ '^[0-9a-f]{64}$'),
  item_refs varchar(30)[] NOT NULL CHECK (cardinality(item_refs) BETWEEN 1 AND 100),
  PRIMARY KEY (order_ref, contribution_revision, offer_ref),
  FOREIGN KEY (order_ref, contribution_revision)
    REFERENCES orders.order_desired_contributions(order_ref, contribution_revision)
    ON DELETE RESTRICT,
  CHECK (array_position(item_refs, NULL) IS NULL)
);

CREATE FUNCTION orders.reject_contribution_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'confirmed order contribution is immutable' USING ERRCODE = '23514';
END;
$$;

CREATE FUNCTION orders.require_confirmed_contribution() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  current_status varchar(16);
  current_version bigint;
BEGIN
  SELECT status, version INTO current_status, current_version
    FROM orders.orders WHERE order_ref = NEW.order_ref FOR UPDATE;
  IF current_status IS DISTINCT FROM 'Confirmed'
     OR current_version IS DISTINCT FROM NEW.order_version THEN
    RAISE EXCEPTION 'contribution requires the matching confirmed order version'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER order_contributions_confirmed_guard
  BEFORE INSERT ON orders.order_desired_contributions
  FOR EACH ROW EXECUTE FUNCTION orders.require_confirmed_contribution();

CREATE TRIGGER order_contributions_append_only
  BEFORE UPDATE OR DELETE ON orders.order_desired_contributions
  FOR EACH ROW EXECUTE FUNCTION orders.reject_contribution_mutation();
CREATE TRIGGER order_contribution_lines_append_only
  BEFORE UPDATE OR DELETE ON orders.order_desired_contribution_lines
  FOR EACH ROW EXECUTE FUNCTION orders.reject_contribution_mutation();

REVOKE ALL ON TABLE orders.order_desired_contributions,
  orders.order_desired_contribution_lines FROM coffee_orders_service_rw;
GRANT SELECT, INSERT ON TABLE orders.order_desired_contributions,
  orders.order_desired_contribution_lines TO coffee_orders_service_rw;
REVOKE ALL ON FUNCTION orders.reject_contribution_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION orders.require_confirmed_contribution() FROM PUBLIC;
