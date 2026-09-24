CREATE TABLE catalog.outbox_messages (
  message_id text PRIMARY KEY CHECK (message_id <> ''),
  message_type text NOT NULL CHECK (message_type <> ''),
  topic text NOT NULL CHECK (topic <> ''),
  aggregate_ref text NOT NULL CHECK (aggregate_ref <> ''),
  aggregate_sequence bigint NOT NULL CHECK (aggregate_sequence > 0),
  owner_version text NOT NULL CHECK (owner_version <> ''),
  partition_key text NOT NULL CHECK (partition_key <> ''),
  schema_version text NOT NULL CHECK (schema_version <> ''),
  envelope jsonb NOT NULL,
  payload jsonb NOT NULL,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  occurred_at timestamptz NOT NULL,
  correlation_id text NOT NULL CHECK (correlation_id <> ''),
  causation_id text,
  traceparent text NOT NULL CHECK (traceparent <> ''),
  state text NOT NULL CHECK (state IN ('Pending', 'Publishing', 'Published', 'Quarantined')),
  lease_owner text NOT NULL,
  lease_token bigint NOT NULL CHECK (lease_token >= 0),
  lease_until timestamptz NOT NULL,
  attempt integer NOT NULL CHECK (attempt >= 0),
  next_attempt_at timestamptz NOT NULL,
  last_error text CHECK (last_error IS NULL OR length(last_error) <= 512),
  published_at timestamptz,
  quarantined_at timestamptz,
  UNIQUE (aggregate_ref, aggregate_sequence),
  CHECK (envelope ->> 'envelopeVersion' = '1'),
  CHECK (envelope ->> 'messageId' = message_id),
  CHECK (envelope ->> 'messageType' = message_type),
  CHECK (envelope ->> 'occurredAt' IS NOT NULL),
  CHECK (envelope ->> 'correlationId' = correlation_id),
  CHECK (envelope ->> 'traceparent' = traceparent),
  CHECK (envelope -> 'payload' = payload),
  CHECK (envelope #>> '{aggregate,ref}' = aggregate_ref),
  CHECK (envelope #>> '{aggregate,version}' = owner_version),
  CHECK (
    (state IN ('Pending', 'Publishing') AND published_at IS NULL AND quarantined_at IS NULL)
    OR (state = 'Published' AND published_at IS NOT NULL AND quarantined_at IS NULL)
    OR (state = 'Quarantined' AND published_at IS NULL AND quarantined_at IS NOT NULL)
  ),
  CHECK (
    (state = 'Pending' AND lease_owner = '')
    OR (state IN ('Publishing', 'Published', 'Quarantined'))
  )
);

CREATE INDEX outbox_messages_claim_idx
  ON catalog.outbox_messages (next_attempt_at, aggregate_ref, aggregate_sequence, message_id)
  WHERE state IN ('Pending', 'Publishing');

CREATE INDEX outbox_messages_unpublished_aggregate_idx
  ON catalog.outbox_messages (aggregate_ref, aggregate_sequence)
  WHERE state <> 'Published';
