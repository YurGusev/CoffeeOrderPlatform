CREATE TABLE orders.order_items (
  order_ref varchar(30) NOT NULL
    REFERENCES orders.orders(order_ref) ON DELETE RESTRICT,
  item_ref varchar(30) NOT NULL
    CHECK (item_ref ~ '^itm_[0-9A-HJKMNP-TV-Z]{26}$'),
  line_position integer NOT NULL CHECK (line_position BETWEEN 1 AND 100),
  product_ref varchar(30) NOT NULL
    CHECK (product_ref ~ '^prd_[0-9A-HJKMNP-TV-Z]{26}$'),
  variant_ref varchar(30) NOT NULL
    CHECK (variant_ref ~ '^var_[0-9A-HJKMNP-TV-Z]{26}$'),
  product_display_name text NOT NULL CHECK (product_display_name <> ''),
  unit varchar(16) NOT NULL CHECK (unit IN ('piece', 'gram', 'kilogram')),
  quantity_milli bigint NOT NULL CHECK (quantity_milli BETWEEN 1 AND 999999999),
  quote_ref varchar(30) NOT NULL
    CHECK (quote_ref ~ '^prq_[0-9A-HJKMNP-TV-Z]{26}$'),
  quote_line_number integer NOT NULL CHECK (quote_line_number BETWEEN 1 AND 100),
  quote_hash char(64) NOT NULL CHECK (quote_hash ~ '^[0-9a-f]{64}$'),
  internal_proof_hash char(64) NOT NULL
    CHECK (internal_proof_hash ~ '^[0-9a-f]{64}$'),
  quote_expires_at timestamptz NOT NULL,
  policy_version_ref varchar(30) NOT NULL
    CHECK (policy_version_ref ~ '^pvr_[0-9A-HJKMNP-TV-Z]{26}$'),
  catalog_snapshot_revision bigint NOT NULL CHECK (catalog_snapshot_revision >= 0),
  mapping_revision bigint NOT NULL CHECK (mapping_revision >= 0),
  offer_ref varchar(30) NOT NULL
    CHECK (offer_ref ~ '^off_[0-9A-HJKMNP-TV-Z]{26}$'),
  unit_minor bigint NOT NULL CHECK (unit_minor >= 0),
  line_total_minor bigint NOT NULL CHECK (line_total_minor >= 0),
  currency char(3) NOT NULL CHECK (currency = 'RUB'),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (order_ref, item_ref),
  UNIQUE (order_ref, line_position),
  CONSTRAINT order_items_quote_line_unique UNIQUE (order_ref, quote_ref, quote_line_number),
  CHECK (line_total_minor::numeric = ceil(unit_minor::numeric * quantity_milli / 1000))
);

CREATE INDEX order_items_order_position_idx
  ON orders.order_items (order_ref, line_position);
CREATE INDEX order_items_quote_idx ON orders.order_items (quote_ref, quote_line_number);

CREATE FUNCTION orders.enforce_draft_item_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target_order_ref varchar(30);
  target_status varchar(16);
BEGIN
  target_order_ref := CASE WHEN TG_OP = 'DELETE' THEN OLD.order_ref ELSE NEW.order_ref END;
  SELECT status INTO target_status
    FROM orders.orders WHERE order_ref = target_order_ref FOR UPDATE;
  IF target_status IS DISTINCT FROM 'Draft' THEN
    RAISE EXCEPTION 'order items may only be mutated while parent order is Draft'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.order_ref IS DISTINCT FROM OLD.order_ref THEN
      RAISE EXCEPTION 'order item cannot move between orders' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER order_items_draft_guard
  BEFORE INSERT OR UPDATE OR DELETE ON orders.order_items
  FOR EACH ROW EXECUTE FUNCTION orders.enforce_draft_item_mutation();

REVOKE ALL ON TABLE orders.order_items FROM coffee_orders_service_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE orders.order_items TO coffee_orders_service_rw;
REVOKE ALL ON FUNCTION orders.enforce_draft_item_mutation() FROM PUBLIC;
