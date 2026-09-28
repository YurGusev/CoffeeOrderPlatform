CREATE TABLE orders.order_history (
  history_ref varchar(30) PRIMARY KEY
    CHECK (history_ref ~ '^htr_[0-9A-HJKMNP-TV-Z]{26}$'),
  order_ref varchar(30) NOT NULL
    REFERENCES orders.orders(order_ref) ON DELETE RESTRICT,
  order_version bigint NOT NULL CHECK (order_version > 0),
  event_type varchar(24) NOT NULL
    CHECK (event_type IN ('DraftCreated', 'ItemUpserted', 'ItemRemoved', 'OrderConfirmed', 'ReconciliationRequested')),
  item_ref varchar(30)
    CHECK (item_ref IS NULL OR item_ref ~ '^itm_[0-9A-HJKMNP-TV-Z]{26}$'),
  actor_ref varchar(128) NOT NULL CHECK (actor_ref <> ''),
  correlation_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  facts jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(facts) = 'object'),
  CHECK ((event_type IN ('ItemUpserted', 'ItemRemoved') AND item_ref IS NOT NULL)
      OR (event_type NOT IN ('ItemUpserted', 'ItemRemoved') AND item_ref IS NULL))
);

CREATE UNIQUE INDEX order_history_command_event_uq
  ON orders.order_history (order_ref, order_version, event_type, coalesce(item_ref, ''));
CREATE INDEX order_history_order_version_idx
  ON orders.order_history (order_ref, order_version);

CREATE FUNCTION orders.reject_order_history_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'order history is append-only' USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER order_history_append_only
  BEFORE UPDATE OR DELETE ON orders.order_history
  FOR EACH ROW EXECUTE FUNCTION orders.reject_order_history_mutation();

REVOKE ALL ON TABLE orders.order_history FROM coffee_orders_service_rw;
GRANT SELECT, INSERT ON TABLE orders.order_history TO coffee_orders_service_rw;
REVOKE ALL ON FUNCTION orders.reject_order_history_mutation() FROM PUBLIC;
