-- Дедупликация и результат принадлежат consumer в одной Orders transaction.
CREATE TABLE orders.inbox_messages (
  consumer_name varchar(64) NOT NULL CHECK (consumer_name <> ''),
  message_id text NOT NULL CHECK (message_id <> ''),
  message_type text NOT NULL CHECK (message_type <> ''),
  partition_key text NOT NULL CHECK (partition_key <> ''),
  schema_version text NOT NULL CHECK (schema_version <> ''),
  owner_version bigint NOT NULL CHECK (owner_version > 0),
  payload_hash char(64) NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  envelope_hash char(64) NOT NULL CHECK (envelope_hash ~ '^[0-9a-f]{64}$'),
  payload jsonb NOT NULL,
  envelope jsonb NOT NULL CHECK (jsonb_typeof(envelope) = 'object'),
  state varchar(16) NOT NULL DEFAULT 'Processing' CHECK (state IN ('Processing','Processed','Quarantined')),
  lease_owner varchar(128) NOT NULL,
  lease_until timestamptz NOT NULL,
  attempt integer NOT NULL DEFAULT 1 CHECK (attempt > 0),
  received_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  processed_at timestamptz,
  quarantined_at timestamptz,
  quarantine_reason text CHECK (quarantine_reason IS NULL OR length(quarantine_reason) BETWEEN 1 AND 512),
  outcome text CHECK (outcome IS NULL OR outcome <> ''),
  result jsonb,
  PRIMARY KEY (consumer_name, message_id),
  CHECK ((envelope ->> 'envelopeVersion' = schema_version
    AND envelope ->> 'messageId' = message_id AND envelope ->> 'messageType' = message_type
    AND envelope -> 'payload' = payload) IS TRUE),
  CHECK ((state = 'Processing' AND processed_at IS NULL AND quarantined_at IS NULL
      AND quarantine_reason IS NULL AND result IS NULL AND outcome IS NULL)
    OR (state = 'Processed' AND processed_at IS NOT NULL AND quarantined_at IS NULL
      AND quarantine_reason IS NULL AND result IS NOT NULL AND outcome IS NOT NULL AND lease_owner = '')
    OR (state = 'Quarantined' AND processed_at IS NULL AND quarantined_at IS NOT NULL
      AND quarantine_reason IS NOT NULL AND result IS NOT NULL AND outcome IS NOT NULL AND lease_owner = ''))
);
CREATE INDEX orders_inbox_unprocessed_idx
  ON orders.inbox_messages (consumer_name, received_at, message_id) WHERE state = 'Processing';
CREATE FUNCTION orders.guard_inbox_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'durable Inbox cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF OLD.state <> 'Processing' OR NEW.attempt < OLD.attempt OR
     (NEW.consumer_name,NEW.message_id,NEW.message_type,NEW.partition_key,NEW.schema_version,
      NEW.owner_version,NEW.payload_hash,NEW.envelope_hash,NEW.payload,NEW.envelope,NEW.received_at)
      IS DISTINCT FROM
     (OLD.consumer_name,OLD.message_id,OLD.message_type,OLD.partition_key,OLD.schema_version,
      OLD.owner_version,OLD.payload_hash,OLD.envelope_hash,OLD.payload,OLD.envelope,OLD.received_at) THEN
    RAISE EXCEPTION 'Inbox envelope and terminal outcome are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER orders_inbox_guard BEFORE UPDATE OR DELETE ON orders.inbox_messages
  FOR EACH ROW EXECUTE FUNCTION orders.guard_inbox_update();

-- Отдельный append-only факт конфликта: исходное terminal сообщение не переписывается.
CREATE TABLE orders.inbox_quarantine (
  consumer_name varchar(64) NOT NULL CHECK (consumer_name <> ''),
  topic text NOT NULL CHECK (topic <> ''),
  "partition" integer NOT NULL CHECK ("partition" >= 0),
  "offset" bigint NOT NULL CHECK ("offset" >= 0),
  message_id text,
  message_type text,
  partition_key text,
  schema_version text,
  payload_hash char(64) CHECK (payload_hash IS NULL OR payload_hash ~ '^[0-9a-f]{64}$'),
  envelope_hash char(64) CHECK (envelope_hash IS NULL OR envelope_hash ~ '^[0-9a-f]{64}$'),
  envelope jsonb,
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 512),
  quarantined_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (consumer_name,topic,"partition","offset")
);
CREATE FUNCTION orders.reject_inbox_quarantine_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Inbox quarantine is append-only' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER orders_inbox_quarantine_guard BEFORE UPDATE OR DELETE ON orders.inbox_quarantine
  FOR EACH ROW EXECUTE FUNCTION orders.reject_inbox_quarantine_mutation();
REVOKE ALL ON TABLE orders.inbox_messages,orders.inbox_quarantine FROM PUBLIC;
GRANT USAGE ON SCHEMA orders TO coffee_orders_prepare_rw,coffee_orders_observer_rw,coffee_orders_convergence_rw;
GRANT SELECT,INSERT,UPDATE ON TABLE orders.inbox_messages
  TO coffee_orders_prepare_rw,coffee_orders_observer_rw,coffee_orders_convergence_rw;
GRANT SELECT,INSERT ON TABLE orders.inbox_quarantine
  TO coffee_orders_prepare_rw,coffee_orders_observer_rw,coffee_orders_convergence_rw;
GRANT SELECT ON TABLE orders.orders,orders.order_items,orders.order_desired_contributions,
  orders.order_desired_contribution_lines,orders.order_history TO coffee_orders_prepare_rw;
GRANT SELECT,INSERT,UPDATE ON TABLE orders.outbox_messages
  TO coffee_orders_prepare_rw,coffee_orders_observer_rw,coffee_orders_convergence_rw;
REVOKE ALL ON FUNCTION orders.guard_inbox_update(),orders.reject_inbox_quarantine_mutation() FROM PUBLIC;
