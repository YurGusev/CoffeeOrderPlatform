CREATE TABLE orders.idempotency_records (
  actor_ref varchar(128) NOT NULL CHECK (actor_ref <> ''),
  scope char(64) NOT NULL CHECK (scope ~ '^[0-9a-f]{64}$'),
  idempotency_key uuid NOT NULL,
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  state varchar(16) NOT NULL CHECK (state IN ('Acquired', 'Completed')),
  lease_owner uuid NOT NULL,
  lease_until timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  response_status smallint,
  response_body jsonb,
  resource_ref varchar(30),
  PRIMARY KEY (actor_ref, scope, idempotency_key),
  CHECK (lease_until > created_at),
  CHECK (expires_at >= lease_until),
  CHECK (
    (state = 'Acquired' AND response_status IS NULL AND response_body IS NULL
      AND completed_at IS NULL AND resource_ref IS NULL)
    OR
    (state = 'Completed' AND response_status BETWEEN 100 AND 599
      AND response_body IS NOT NULL AND completed_at IS NOT NULL)
  )
);

CREATE INDEX orders_idempotency_lease_idx
  ON orders.idempotency_records (lease_until) WHERE state = 'Acquired';
CREATE INDEX orders_idempotency_replay_expiry_idx
  ON orders.idempotency_records (expires_at) WHERE state = 'Completed';

REVOKE ALL ON TABLE orders.idempotency_records FROM coffee_orders_service_rw;
GRANT SELECT, INSERT, UPDATE ON TABLE orders.idempotency_records TO coffee_orders_service_rw;
