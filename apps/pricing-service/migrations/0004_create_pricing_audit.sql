CREATE TABLE pricing.pricing_audit_records (
  audit_ref varchar(30) PRIMARY KEY CHECK (audit_ref ~ '^aud_[0-9A-HJKMNP-TV-Z]{26}$'),
  action varchar(24) NOT NULL CHECK (action IN ('QuoteCreated', 'QuoteVerified', 'QuoteRejected')),
  quote_ref varchar(30) REFERENCES pricing.pricing_quotes(quote_ref) ON DELETE RESTRICT,
  actor_ref varchar(128) NOT NULL CHECK (actor_ref <> ''),
  correlation_id uuid NOT NULL,
  reason_code varchar(64),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CHECK (action = 'QuoteRejected' OR quote_ref IS NOT NULL),
  CHECK (reason_code IS NULL OR reason_code ~ '^[A-Z][A-Z0-9_]*$'),
  CHECK (action = 'QuoteRejected' OR reason_code IS NULL)
);

CREATE INDEX pricing_audit_quote_created_idx
  ON pricing.pricing_audit_records (quote_ref, created_at DESC);

REVOKE ALL ON TABLE pricing.pricing_audit_records FROM coffee_pricing_rw;
GRANT SELECT, INSERT ON TABLE pricing.pricing_audit_records TO coffee_pricing_rw;
