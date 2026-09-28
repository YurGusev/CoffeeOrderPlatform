CREATE SCHEMA IF NOT EXISTS orders;

CREATE TABLE orders.orders (
  order_ref varchar(30) PRIMARY KEY
    CHECK (order_ref ~ '^ord_[0-9A-HJKMNP-TV-Z]{26}$'),
  status varchar(16) NOT NULL DEFAULT 'Draft'
    CHECK (status IN ('Draft', 'Confirmed')),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  projection_version bigint NOT NULL DEFAULT 1 CHECK (projection_version > 0),
  customer_ref varchar(30) NOT NULL
    CHECK (customer_ref ~ '^cus_[0-9A-HJKMNP-TV-Z]{26}$'),
  customer_version bigint NOT NULL CHECK (customer_version > 0),
  customer_display_name varchar(200) NOT NULL CHECK (customer_display_name <> ''),
  customer_state varchar(16) NOT NULL CHECK (customer_state = 'Active'),
  customer_state_proof_hash char(64) NOT NULL
    CHECK (customer_state_proof_hash ~ '^[0-9a-f]{64}$'),
  currency char(3),
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  created_by_actor_ref varchar(128) NOT NULL CHECK (created_by_actor_ref <> ''),
  last_modified_by_actor_ref varchar(128) NOT NULL CHECK (last_modified_by_actor_ref <> ''),
  CHECK (currency IS NULL OR currency = 'RUB'),
  CHECK ((status = 'Draft' AND confirmed_at IS NULL)
      OR (status = 'Confirmed' AND confirmed_at IS NOT NULL))
);

CREATE INDEX orders_customer_created_idx
  ON orders.orders (customer_ref, created_at DESC);
CREATE INDEX orders_status_updated_idx
  ON orders.orders (status, updated_at DESC);

CREATE FUNCTION orders.guard_order_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'Draft' THEN
      RAISE EXCEPTION 'confirmed orders cannot be deleted' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status = 'Confirmed' THEN
    IF NEW.order_ref IS DISTINCT FROM OLD.order_ref
       OR NEW.status IS DISTINCT FROM OLD.status
       OR (NEW.version IS DISTINCT FROM OLD.version AND NEW.version <> OLD.version + 1)
       OR NEW.customer_ref IS DISTINCT FROM OLD.customer_ref
       OR NEW.customer_version IS DISTINCT FROM OLD.customer_version
       OR NEW.customer_display_name IS DISTINCT FROM OLD.customer_display_name
       OR NEW.customer_state IS DISTINCT FROM OLD.customer_state
       OR NEW.customer_state_proof_hash IS DISTINCT FROM OLD.customer_state_proof_hash
       OR NEW.currency IS DISTINCT FROM OLD.currency
       OR NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.created_by_actor_ref IS DISTINCT FROM OLD.created_by_actor_ref THEN
      RAISE EXCEPTION 'confirmed order snapshot is immutable' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.status NOT IN ('Draft', 'Confirmed') THEN
    RAISE EXCEPTION 'invalid order status transition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER orders_guard_mutation
  BEFORE UPDATE OR DELETE ON orders.orders
  FOR EACH ROW EXECUTE FUNCTION orders.guard_order_mutation();

GRANT USAGE ON SCHEMA orders TO coffee_orders_service_rw;
REVOKE ALL ON TABLE orders.orders FROM coffee_orders_service_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE orders.orders TO coffee_orders_service_rw;
REVOKE ALL ON FUNCTION orders.guard_order_mutation() FROM PUBLIC;
