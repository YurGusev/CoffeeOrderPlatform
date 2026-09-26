CREATE TABLE pricing.pricing_idempotency_records (
  actor_ref varchar(128) NOT NULL CHECK (actor_ref <> ''),
  scope char(64) NOT NULL CHECK (scope ~ '^[0-9a-f]{64}$'),
  idempotency_key uuid NOT NULL,
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  state varchar(16) NOT NULL CHECK (state IN ('Acquired', 'Completed')),
  lease_owner uuid NOT NULL,
  lease_until timestamptz NOT NULL,
  resource_ref varchar(30) REFERENCES pricing.pricing_quotes(quote_ref) ON DELETE RESTRICT,
  response_status smallint,
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  completed_at timestamptz,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (actor_ref, scope, idempotency_key),
  CHECK (lease_until > created_at),
  CHECK (expires_at >= lease_until),
  CHECK (
    (state = 'Acquired' AND resource_ref IS NULL AND response_status IS NULL
      AND response_body IS NULL AND completed_at IS NULL)
    OR
    (state = 'Completed' AND resource_ref IS NOT NULL AND response_status = 201
      AND response_body IS NOT NULL AND completed_at IS NOT NULL
      AND expires_at > completed_at)
  )
);

CREATE INDEX pricing_idempotency_lease_idx
  ON pricing.pricing_idempotency_records (lease_until)
  WHERE state = 'Acquired';
CREATE INDEX pricing_idempotency_replay_expiry_idx
  ON pricing.pricing_idempotency_records (expires_at)
  WHERE state = 'Completed';

REVOKE ALL ON TABLE pricing.pricing_idempotency_records FROM coffee_pricing_rw;
GRANT SELECT, INSERT, UPDATE ON TABLE pricing.pricing_idempotency_records TO coffee_pricing_rw;
