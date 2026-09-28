CREATE TABLE orders.outbox_messages (
  message_id text PRIMARY KEY CHECK (message_id <> ''),
  message_type text NOT NULL CHECK (message_type <> ''),
  topic text NOT NULL CHECK (topic <> ''),
  aggregate_ref varchar(30) NOT NULL
    REFERENCES orders.orders(order_ref) ON DELETE RESTRICT,
  aggregate_sequence bigint NOT NULL CHECK (aggregate_sequence > 0),
  owner_version text NOT NULL CHECK (owner_version <> ''),
  partition_key text NOT NULL CHECK (partition_key <> ''),
  schema_version text NOT NULL CHECK (schema_version <> ''),
  envelope_bytes bytea NOT NULL CHECK (octet_length(envelope_bytes) > 0),
  envelope_hash char(64) NOT NULL CHECK (envelope_hash ~ '^[0-9a-f]{64}$'),
  envelope jsonb NOT NULL,
  payload jsonb NOT NULL,
  payload_hash char(64) NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  occurred_at timestamptz NOT NULL,
  correlation_id text NOT NULL CHECK (correlation_id <> ''),
  causation_id text,
  traceparent text NOT NULL CHECK (traceparent <> ''),
  state varchar(16) NOT NULL DEFAULT 'Pending'
    CHECK (state IN ('Pending', 'Publishing', 'Published', 'Quarantined')),
  lease_owner varchar(128) NOT NULL DEFAULT '',
  lease_token bigint NOT NULL DEFAULT 0 CHECK (lease_token >= 0),
  lease_until timestamptz NOT NULL,
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  last_error text CHECK (last_error IS NULL OR length(last_error) <= 512),
  published_at timestamptz,
  quarantined_at timestamptz,
  UNIQUE (aggregate_ref, aggregate_sequence),
  UNIQUE (message_type, aggregate_ref, owner_version),
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
  CHECK ((state = 'Pending' AND lease_owner = '')
    OR (state IN ('Publishing', 'Published', 'Quarantined')))
);

CREATE INDEX orders_outbox_claim_idx
  ON orders.outbox_messages (next_attempt_at, aggregate_ref, aggregate_sequence, message_id)
  WHERE state IN ('Pending', 'Publishing');
CREATE INDEX orders_outbox_unpublished_aggregate_idx
  ON orders.outbox_messages (aggregate_ref, aggregate_sequence)
  WHERE state <> 'Published';

CREATE FUNCTION orders.guard_outbox_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'outbox messages cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF NEW.message_id IS DISTINCT FROM OLD.message_id
     OR NEW.message_type IS DISTINCT FROM OLD.message_type
     OR NEW.topic IS DISTINCT FROM OLD.topic
     OR NEW.aggregate_ref IS DISTINCT FROM OLD.aggregate_ref
     OR NEW.aggregate_sequence IS DISTINCT FROM OLD.aggregate_sequence
     OR NEW.owner_version IS DISTINCT FROM OLD.owner_version
     OR NEW.partition_key IS DISTINCT FROM OLD.partition_key
     OR NEW.schema_version IS DISTINCT FROM OLD.schema_version
     OR NEW.envelope_bytes IS DISTINCT FROM OLD.envelope_bytes
     OR NEW.envelope_hash IS DISTINCT FROM OLD.envelope_hash
     OR NEW.envelope IS DISTINCT FROM OLD.envelope
     OR NEW.payload IS DISTINCT FROM OLD.payload
     OR NEW.payload_hash IS DISTINCT FROM OLD.payload_hash
     OR NEW.occurred_at IS DISTINCT FROM OLD.occurred_at
     OR NEW.correlation_id IS DISTINCT FROM OLD.correlation_id
     OR NEW.causation_id IS DISTINCT FROM OLD.causation_id
     OR NEW.traceparent IS DISTINCT FROM OLD.traceparent THEN
    RAISE EXCEPTION 'outbox message envelope is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER orders_outbox_immutable_envelope
  BEFORE UPDATE OR DELETE ON orders.outbox_messages
  FOR EACH ROW EXECUTE FUNCTION orders.guard_outbox_update();

REVOKE ALL ON TABLE orders.outbox_messages FROM coffee_orders_service_rw;
GRANT SELECT, INSERT, UPDATE ON TABLE orders.outbox_messages TO coffee_orders_service_rw;
REVOKE ALL ON FUNCTION orders.guard_outbox_update() FROM PUBLIC;
