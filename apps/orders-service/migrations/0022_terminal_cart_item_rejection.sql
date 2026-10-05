ALTER TABLE orders.mutation_reservations
  DROP CONSTRAINT mutation_reservations_state_check,
  DROP CONSTRAINT mutation_reservations_check3,
  ADD CONSTRAINT mutation_reservations_state_check CHECK (state IN ('Reserved','Dispatched','Acknowledged','Verified','Rejected','UnknownOutcome','RecoveredApplied','RecoveredNotApplied')),
  ADD CONSTRAINT mutation_reservations_check3 CHECK ((state IN ('Verified','Rejected','RecoveredApplied','RecoveredNotApplied')) = (resolved_at IS NOT NULL)),
  ADD CONSTRAINT mutation_reservations_rejected_outcome_check CHECK (state <> 'Rejected' OR gateway_outcome_hash IS NOT NULL);

CREATE OR REPLACE FUNCTION orders.guard_mutation_reservation() RETURNS trigger LANGUAGE plpgsql AS $$
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
  IF OLD.state IN ('Verified','Rejected','RecoveredApplied','RecoveredNotApplied') OR
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
     OR (OLD.state = 'UnknownOutcome' AND NEW.state IN ('Reserved','Dispatched','Acknowledged'))
     OR (NEW.state = 'Rejected' AND OLD.state <> 'Dispatched') THEN
    RAISE EXCEPTION 'mutation state cannot regress or reject without a definitive dispatch result' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION orders.guard_mutation_reservation() FROM PUBLIC;
