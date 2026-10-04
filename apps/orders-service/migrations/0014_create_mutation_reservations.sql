CREATE TABLE orders.mutation_reservations (
  operation_ref varchar(29) PRIMARY KEY CHECK (operation_ref ~ '^op_[0-9A-HJKMNP-TV-Z]{26}$'),
  attempt_ref varchar(30) NOT NULL UNIQUE,
  cart_scope_ref varchar(32) NOT NULL CHECK (cart_scope_ref = 'aroma-primary'),
  desired_revision bigint NOT NULL,
  fence_epoch bigint NOT NULL CHECK (fence_epoch > 0),
  observed_before_revision bigint NOT NULL CHECK (observed_before_revision > 0),
  action varchar(16) NOT NULL CHECK (action IN ('SetQuantity','Remove')),
  offer_ref varchar(30) NOT NULL CHECK (offer_ref ~ '^off_[0-9A-HJKMNP-TV-Z]{26}$'),
  source_grind_key_hash char(64) CHECK (source_grind_key_hash IS NULL OR source_grind_key_hash ~ '^[0-9a-f]{64}$'),
  observed_before_milli bigint NOT NULL CHECK (observed_before_milli >= 0),
  desired_milli bigint NOT NULL CHECK (desired_milli >= 0),
  target_provider_quantity bigint,
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  reserved_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  reserved_until timestamptz NOT NULL CHECK (isfinite(reserved_until)),
  provider_deadline_at timestamptz NOT NULL CHECK (isfinite(provider_deadline_at)),
  safety_margin_ms integer NOT NULL CHECK (safety_margin_ms >= 0),
  gateway_outcome_hash char(64) CHECK (gateway_outcome_hash IS NULL OR gateway_outcome_hash ~ '^[0-9a-f]{64}$'),
  dispatched_at timestamptz,
  resolved_at timestamptz,
  state varchar(24) NOT NULL CHECK (state IN ('Reserved','Dispatched','Acknowledged','Verified','UnknownOutcome','RecoveredApplied','RecoveredNotApplied')),
  FOREIGN KEY (attempt_ref,cart_scope_ref,desired_revision,fence_epoch,observed_before_revision)
    REFERENCES orders.convergence_attempts(attempt_ref,cart_scope_ref,desired_revision,fence_epoch,observed_start_revision),
  FOREIGN KEY (cart_scope_ref,observed_before_revision)
    REFERENCES orders.cart_observed_revisions(cart_scope_ref,observed_revision),
  CHECK (provider_deadline_at >= reserved_at),
  CHECK (reserved_until >= provider_deadline_at + safety_margin_ms * interval '1 millisecond'),
  CHECK ((action = 'Remove' AND desired_milli = 0 AND target_provider_quantity IS NULL)
    OR (action = 'SetQuantity' AND desired_milli > 0 AND desired_milli % 1000 = 0
      AND target_provider_quantity IS NOT NULL AND target_provider_quantity > 0
      AND target_provider_quantity = desired_milli / 1000)),
  CHECK ((state IN ('Verified','RecoveredApplied','RecoveredNotApplied')) = (resolved_at IS NOT NULL)),
  CHECK (dispatched_at IS NULL OR dispatched_at >= reserved_at),
  CHECK (resolved_at IS NULL OR resolved_at >= reserved_at)
);
-- Барьер не связан с текущим fence: смена владельца не разрешает вторую мутацию.
CREATE UNIQUE INDEX orders_one_unresolved_mutation_per_scope ON orders.mutation_reservations(cart_scope_ref)
  WHERE state IN ('Reserved','Dispatched','Acknowledged','UnknownOutcome');
CREATE FUNCTION orders.guard_mutation_reservation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  selected orders.convergence_attempts%ROWTYPE;
  baseline bigint;
  desired bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'mutation reservation cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO selected FROM orders.convergence_attempts WHERE attempt_ref = NEW.attempt_ref;
    -- Ссылки проверяет FK, включая ненулевой baseline; nullable grind сравнивается NULL-safe.
    IF FOUND AND (selected.state IN ('VerifiedInSync','NoOpInSync','OutOfSync','UnknownOutcome','Blocked','Failed')
      OR (selected.selected_action,selected.selected_offer_ref,selected.selected_source_grind_key_hash)
        IS DISTINCT FROM (NEW.action,NEW.offer_ref,NEW.source_grind_key_hash)) THEN
      RAISE EXCEPTION 'reservation does not match selected attempt line' USING ERRCODE = '23514';
    END IF;
    SELECT quantity_milli INTO baseline FROM orders.cart_observed_lines
      WHERE cart_scope_ref = NEW.cart_scope_ref AND observed_revision = NEW.observed_before_revision
        AND offer_ref = NEW.offer_ref AND source_grind_key_hash IS NOT DISTINCT FROM NEW.source_grind_key_hash;
    SELECT quantity_milli INTO desired FROM orders.cart_desired_lines
      WHERE cart_scope_ref = NEW.cart_scope_ref AND desired_revision = NEW.desired_revision
        AND offer_ref = NEW.offer_ref AND source_grind_key_hash IS NOT DISTINCT FROM NEW.source_grind_key_hash;
    IF NEW.observed_before_milli <> COALESCE(baseline,0) OR NEW.desired_milli <> COALESCE(desired,0) THEN
      RAISE EXCEPTION 'reservation quantities conflict with exact physical line proof' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.state IN ('Verified','RecoveredApplied','RecoveredNotApplied') OR
     (NEW.operation_ref,NEW.attempt_ref,NEW.cart_scope_ref,NEW.desired_revision,NEW.fence_epoch,NEW.observed_before_revision,
      NEW.action,NEW.offer_ref,NEW.source_grind_key_hash,NEW.observed_before_milli,NEW.desired_milli,
      NEW.target_provider_quantity,NEW.request_hash,NEW.reserved_at,NEW.safety_margin_ms)
       IS DISTINCT FROM
     (OLD.operation_ref,OLD.attempt_ref,OLD.cart_scope_ref,OLD.desired_revision,OLD.fence_epoch,OLD.observed_before_revision,
      OLD.action,OLD.offer_ref,OLD.source_grind_key_hash,OLD.observed_before_milli,OLD.desired_milli,
      OLD.target_provider_quantity,OLD.request_hash,OLD.reserved_at,OLD.safety_margin_ms)
     OR NEW.reserved_until < OLD.reserved_until OR NEW.provider_deadline_at < OLD.provider_deadline_at
     OR (OLD.dispatched_at IS NOT NULL AND NEW.dispatched_at IS DISTINCT FROM OLD.dispatched_at) THEN
    RAISE EXCEPTION 'mutation identity, deadlines and terminal facts are immutable/monotonic' USING ERRCODE = '23514';
  END IF;
  IF (OLD.state = 'Dispatched' AND NEW.state = 'Reserved')
     OR (OLD.state = 'Acknowledged' AND NEW.state IN ('Reserved','Dispatched'))
     OR (OLD.state = 'UnknownOutcome' AND NEW.state IN ('Reserved','Dispatched','Acknowledged')) THEN
    RAISE EXCEPTION 'mutation state cannot regress' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER orders_mutation_reservation_guard BEFORE INSERT OR UPDATE OR DELETE ON orders.mutation_reservations
  FOR EACH ROW EXECUTE FUNCTION orders.guard_mutation_reservation();

-- Proof проверяется в конце owner transaction, когда Observed, Attempt и Reservation уже записаны.
CREATE FUNCTION orders.verify_terminal_cart_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  attempt orders.convergence_attempts%ROWTYPE;
  proof_revision bigint;
BEGIN
  SELECT * INTO attempt FROM orders.convergence_attempts WHERE attempt_ref = NEW.attempt_ref;
  IF attempt.state NOT IN ('VerifiedInSync','NoOpInSync') THEN RETURN NULL; END IF;
  proof_revision := CASE WHEN attempt.state = 'VerifiedInSync'
    THEN attempt.observed_end_revision ELSE attempt.observed_start_revision END;
  IF (attempt.state = 'NoOpInSync' AND EXISTS (
      SELECT 1 FROM orders.mutation_reservations WHERE attempt_ref = attempt.attempt_ref))
     OR (attempt.state = 'VerifiedInSync' AND NOT EXISTS (
      SELECT 1 FROM orders.mutation_reservations WHERE attempt_ref = attempt.attempt_ref AND state = 'Verified'))
     OR EXISTS (SELECT 1 FROM orders.cart_desired_blockers
      WHERE cart_scope_ref = attempt.cart_scope_ref AND desired_revision = attempt.desired_revision)
     OR EXISTS (
       (SELECT offer_ref,source_grind_key_hash,quantity_milli FROM orders.cart_desired_lines
         WHERE cart_scope_ref = attempt.cart_scope_ref AND desired_revision = attempt.desired_revision
        EXCEPT
        SELECT offer_ref,source_grind_key_hash,quantity_milli FROM orders.cart_observed_lines
         WHERE cart_scope_ref = attempt.cart_scope_ref AND observed_revision = proof_revision)
       UNION ALL
       (SELECT offer_ref,source_grind_key_hash,quantity_milli FROM orders.cart_observed_lines
         WHERE cart_scope_ref = attempt.cart_scope_ref AND observed_revision = proof_revision
        EXCEPT
        SELECT offer_ref,source_grind_key_hash,quantity_milli FROM orders.cart_desired_lines
         WHERE cart_scope_ref = attempt.cart_scope_ref AND desired_revision = attempt.desired_revision)
     ) THEN
    RAISE EXCEPTION 'terminal InSync attempt lacks exact complete cart proof' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER orders_terminal_attempt_proof AFTER INSERT OR UPDATE ON orders.convergence_attempts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION orders.verify_terminal_cart_attempt();
REVOKE ALL ON TABLE orders.mutation_reservations FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON TABLE orders.mutation_reservations TO coffee_orders_convergence_rw;
REVOKE ALL ON FUNCTION orders.guard_mutation_reservation(),orders.verify_terminal_cart_attempt() FROM PUBLIC;
