-- Forward migration: Order FK сохраняется отдельно от фиксированного cart aggregate.
-- Исходная 0006 и существующие immutable Outbox facts не переписываются.
ALTER TABLE orders.outbox_messages
  DROP CONSTRAINT outbox_messages_aggregate_ref_fkey,
  ADD COLUMN order_ref varchar(30) GENERATED ALWAYS AS
    (CASE WHEN envelope #>> '{aggregate,type}' = 'Order' THEN aggregate_ref ELSE NULL END) STORED,
  ADD CONSTRAINT orders_outbox_order_ref_fkey FOREIGN KEY (order_ref)
    REFERENCES orders.orders(order_ref) ON DELETE RESTRICT,
  ADD CONSTRAINT orders_outbox_owned_aggregate CHECK (
    envelope #>> '{aggregate,type}' IS NOT NULL AND (
      (envelope #>> '{aggregate,type}' = 'Order'
        AND order_ref IS NOT NULL AND aggregate_ref ~ '^ord_[0-9A-HJKMNP-TV-Z]{26}$')
      OR (envelope #>> '{aggregate,type}' = 'AromaCart'
        AND aggregate_ref = 'aroma-primary' AND partition_key = 'aroma-primary'
        AND (
          (message_type = 'AromaConvergenceRequested.v1' AND topic = 'coffee.aroma.cart.commands.v1')
          OR (message_type IN ('AromaObservationChanged.v1','AromaConvergenceChanged.v1')
            AND topic = 'coffee.aroma.cart.events.v1')
        ))
    )
  ),
  ADD CONSTRAINT orders_outbox_exact_envelope_bytes CHECK (
    envelope_hash = encode(sha256(envelope_bytes),'hex')
    AND convert_from(envelope_bytes,'UTF8')::jsonb = envelope
  );
