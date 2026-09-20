CREATE SCHEMA IF NOT EXISTS integration;

CREATE TABLE integration.provider_mutation_journal (
  operation_ref varchar(30) PRIMARY KEY
    CHECK (operation_ref ~ '^op_[0-9A-HJKMNP-TV-Z]{26}$'),
  cart_scope_ref varchar(64) NOT NULL
    CHECK (cart_scope_ref = 'aroma-primary'),
  operation_kind varchar(32) NOT NULL
    CHECK (operation_kind IN ('SetLineQuantity', 'RemoveLine')),
  offer_ref varchar(30) NOT NULL
    CHECK (offer_ref ~ '^off_[0-9A-HJKMNP-TV-Z]{26}$'),
  quantity_milli bigint NULL
    CHECK (quantity_milli IS NULL OR quantity_milli > 0),
  request_hash char(64) NOT NULL
    CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  caller_identity varchar(64) NOT NULL
    CHECK (caller_identity ~ '^[a-z][a-z0-9-]{0,63}$'),
  original_caller varchar(64) NOT NULL
    CHECK (original_caller ~ '^[a-z][a-z0-9-]{0,63}$'),
  operation_id varchar(128) NOT NULL
    CHECK (operation_id ~ '^[A-Za-z][A-Za-z0-9]{0,127}$'),
  correlation_id uuid NOT NULL,
  traceparent varchar(128) NULL
    CHECK (traceparent IS NULL OR traceparent ~ '^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$'),
  state varchar(20) NOT NULL
    CHECK (state IN ('Reserved', 'Dispatched', 'Acknowledged', 'Rejected', 'UnknownOutcome')),
  reservation_owner uuid NOT NULL,
  lease_until timestamptz NOT NULL,
  provider_status_code integer NULL
    CHECK (provider_status_code IS NULL OR provider_status_code BETWEEN 100 AND 599),
  outcome_hash char(64) NULL
    CHECK (outcome_hash IS NULL OR outcome_hash ~ '^[a-f0-9]{64}$'),
  failure_code varchar(64) NULL
    CHECK (failure_code IS NULL OR failure_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  response_status smallint NULL
    CHECK (response_status IS NULL OR response_status BETWEEN 100 AND 599),
  response_body_bytes bytea NULL
    CHECK (response_body_bytes IS NULL OR octet_length(response_body_bytes) BETWEEN 1 AND 65536),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  dispatched_at timestamptz NULL,
  completed_at timestamptz NULL,
  last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((operation_kind = 'SetLineQuantity' AND quantity_milli IS NOT NULL)
    OR (operation_kind = 'RemoveLine' AND quantity_milli IS NULL)),
  CHECK (lease_until > created_at),
  CHECK ((state = 'Reserved' AND dispatched_at IS NULL)
    OR (state <> 'Reserved' AND dispatched_at IS NOT NULL)),
  CHECK (
    (state IN ('Reserved', 'Dispatched')
      AND provider_status_code IS NULL AND outcome_hash IS NULL AND failure_code IS NULL
      AND response_status IS NULL AND response_body_bytes IS NULL AND completed_at IS NULL)
    OR (state = 'Acknowledged'
      AND outcome_hash IS NOT NULL AND failure_code IS NULL
      AND response_status = 200 AND response_body_bytes IS NOT NULL AND completed_at IS NOT NULL)
    OR (state = 'Rejected'
      AND outcome_hash IS NOT NULL AND failure_code IS NOT NULL
      AND response_status BETWEEN 400 AND 599 AND response_body_bytes IS NOT NULL AND completed_at IS NOT NULL)
    OR (state = 'UnknownOutcome'
      AND provider_status_code IS NULL AND outcome_hash IS NULL AND failure_code IS NOT NULL
      AND response_status IS NULL AND response_body_bytes IS NULL AND completed_at IS NOT NULL)
  )
);

CREATE INDEX provider_mutation_journal_reservation_idx
  ON integration.provider_mutation_journal (state, lease_until);
CREATE INDEX provider_mutation_journal_dispatch_idx
  ON integration.provider_mutation_journal (state, dispatched_at)
  WHERE state = 'Dispatched';

GRANT USAGE ON SCHEMA integration TO coffee_aroma_gateway_rw;
GRANT SELECT, INSERT, UPDATE ON TABLE integration.provider_mutation_journal TO coffee_aroma_gateway_rw;
