CREATE TABLE orders.convergence_attempts (
  attempt_ref varchar(30) PRIMARY KEY CHECK (attempt_ref ~ '^att_[0-9A-HJKMNP-TV-Z]{26}$'),
  cart_scope_ref varchar(32) NOT NULL CHECK (cart_scope_ref = 'aroma-primary'),
  desired_revision bigint NOT NULL,
  desired_hash char(64) NOT NULL CHECK (desired_hash ~ '^[0-9a-f]{64}$'),
  owner_instance_id uuid NOT NULL,
  fence_epoch bigint NOT NULL CHECK (fence_epoch > 0),
  state varchar(24) NOT NULL CHECK (state IN ('Started','Observed','MutationReserved','MutationDispatched','VerifiedInSync','NoOpInSync','OutOfSync','UnknownOutcome','Blocked','Failed')),
  observed_start_revision bigint CHECK (observed_start_revision > 0),
  observed_end_revision bigint CHECK (observed_end_revision > 0),
  selected_offer_ref varchar(30) CHECK (selected_offer_ref IS NULL OR selected_offer_ref ~ '^off_[0-9A-HJKMNP-TV-Z]{26}$'),
  selected_source_grind_key_hash char(64) CHECK (selected_source_grind_key_hash IS NULL OR selected_source_grind_key_hash ~ '^[0-9a-f]{64}$'),
  selected_action varchar(16) CHECK (selected_action IN ('SetQuantity','Remove')),
  started_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  ended_at timestamptz,
  failure_code text,
  blocker_codes jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(blocker_codes) = 'array'),
  FOREIGN KEY (cart_scope_ref,desired_revision,desired_hash)
    REFERENCES orders.cart_desired_revisions(cart_scope_ref,desired_revision,desired_hash),
  FOREIGN KEY (cart_scope_ref,observed_start_revision)
    REFERENCES orders.cart_observed_revisions(cart_scope_ref,observed_revision),
  FOREIGN KEY (cart_scope_ref,observed_end_revision)
    REFERENCES orders.cart_observed_revisions(cart_scope_ref,observed_revision),
  UNIQUE (attempt_ref,cart_scope_ref,fence_epoch),
  UNIQUE (attempt_ref,cart_scope_ref,desired_revision,fence_epoch,observed_start_revision),
  CHECK ((state IN ('VerifiedInSync','NoOpInSync','OutOfSync','UnknownOutcome','Blocked','Failed')) = (ended_at IS NOT NULL)),
  CHECK (ended_at IS NULL OR ended_at >= started_at),
  CHECK ((selected_action IS NULL AND selected_offer_ref IS NULL AND selected_source_grind_key_hash IS NULL)
    OR (selected_action IS NOT NULL AND selected_offer_ref IS NOT NULL)),
  CHECK (state NOT IN ('Observed','MutationReserved','MutationDispatched','VerifiedInSync','NoOpInSync')
    OR observed_start_revision IS NOT NULL),
  CHECK (state NOT IN ('MutationReserved','MutationDispatched','VerifiedInSync') OR selected_action IS NOT NULL),
  CHECK (state <> 'VerifiedInSync' OR observed_end_revision IS NOT NULL),
  CHECK (state <> 'NoOpInSync' OR (selected_action IS NULL
    AND (observed_end_revision IS NULL OR observed_end_revision = observed_start_revision)))
);
CREATE INDEX orders_attempt_scope_started_idx ON orders.convergence_attempts(cart_scope_ref,started_at DESC);
CREATE FUNCTION orders.guard_convergence_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'attempt history cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF OLD.state IN ('VerifiedInSync','NoOpInSync','OutOfSync','UnknownOutcome','Blocked','Failed') OR
     (NEW.attempt_ref,NEW.cart_scope_ref,NEW.desired_revision,NEW.desired_hash,NEW.owner_instance_id,NEW.fence_epoch,NEW.started_at)
       IS DISTINCT FROM
     (OLD.attempt_ref,OLD.cart_scope_ref,OLD.desired_revision,OLD.desired_hash,OLD.owner_instance_id,OLD.fence_epoch,OLD.started_at)
     OR (OLD.observed_start_revision IS NOT NULL AND NEW.observed_start_revision IS DISTINCT FROM OLD.observed_start_revision)
     OR (OLD.selected_action IS NOT NULL AND
       (NEW.selected_action,NEW.selected_offer_ref,NEW.selected_source_grind_key_hash) IS DISTINCT FROM
       (OLD.selected_action,OLD.selected_offer_ref,OLD.selected_source_grind_key_hash)) THEN
    RAISE EXCEPTION 'attempt identity/terminal facts are immutable' USING ERRCODE = '23514';
  END IF;
  IF (OLD.state = 'Observed' AND NEW.state = 'Started')
     OR (OLD.state = 'MutationReserved' AND NEW.state IN ('Started','Observed'))
     OR (OLD.state = 'MutationDispatched' AND NEW.state IN ('Started','Observed','MutationReserved')) THEN
    RAISE EXCEPTION 'attempt state cannot regress' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER orders_attempt_guard BEFORE UPDATE OR DELETE ON orders.convergence_attempts
  FOR EACH ROW EXECUTE FUNCTION orders.guard_convergence_attempt();
ALTER TABLE orders.cart_observed_revisions ADD CONSTRAINT orders_observed_attempt_fence_fk
  FOREIGN KEY (source_attempt_ref,cart_scope_ref,fence_epoch)
  REFERENCES orders.convergence_attempts(attempt_ref,cart_scope_ref,fence_epoch);
REVOKE ALL ON TABLE orders.convergence_attempts FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON TABLE orders.convergence_attempts TO coffee_orders_convergence_rw;
GRANT SELECT ON TABLE orders.convergence_attempts TO coffee_orders_prepare_rw;
REVOKE ALL ON FUNCTION orders.guard_convergence_attempt() FROM PUBLIC;
