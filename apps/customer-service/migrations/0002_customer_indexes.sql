CREATE UNIQUE INDEX customers_active_phone_uq
  ON customer.customers (phone_e164)
  WHERE status = 'Active' AND phone_e164 IS NOT NULL;

CREATE UNIQUE INDEX customers_active_email_uq
  ON customer.customers (email_normalized)
  WHERE status = 'Active' AND email_normalized IS NOT NULL;

CREATE UNIQUE INDEX channel_links_active_subject_uq
  ON customer.channel_links (provider, external_subject_hash)
  WHERE status = 'Active';

CREATE UNIQUE INDEX addresses_active_delivery_customer_uq
  ON customer.addresses (customer_ref)
  WHERE kind = 'Delivery' AND is_active;

CREATE INDEX customers_display_name_search_idx
  ON customer.customers (display_name_search text_pattern_ops, customer_ref);

CREATE INDEX customers_phone_idx
  ON customer.customers (phone_e164, customer_ref);

CREATE INDEX customers_email_idx
  ON customer.customers (email_normalized, customer_ref);

CREATE INDEX idempotency_records_expires_at_idx
  ON customer.idempotency_records (expires_at);
