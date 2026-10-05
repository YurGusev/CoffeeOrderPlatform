CREATE TABLE orders.cart_desired_order_facts (
  cart_scope_ref varchar(32) NOT NULL,
  desired_revision bigint NOT NULL,
  order_ref varchar(30) NOT NULL REFERENCES orders.orders(order_ref) ON DELETE RESTRICT,
  contribution_revision bigint NOT NULL CHECK (contribution_revision > 0),
  contribution_hash char(64) NOT NULL CHECK (contribution_hash ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (cart_scope_ref,desired_revision,order_ref),
  FOREIGN KEY (cart_scope_ref,desired_revision) REFERENCES orders.cart_desired_revisions ON DELETE RESTRICT,
  FOREIGN KEY (order_ref,contribution_revision) REFERENCES orders.order_desired_contributions(order_ref,contribution_revision) ON DELETE RESTRICT
);
CREATE TABLE orders.order_aroma_projections (
  order_ref varchar(30) PRIMARY KEY REFERENCES orders.orders(order_ref) ON DELETE RESTRICT,
  cart_scope_ref varchar(32) NOT NULL CHECK (cart_scope_ref = 'aroma-primary'),
  projection_version bigint NOT NULL CHECK (projection_version > 0),
  desired_revision bigint NOT NULL CHECK (desired_revision >= 0),
  desired_hash char(64),
  observed_revision bigint NOT NULL CHECK (observed_revision >= 0),
  observed_cart_fingerprint char(64),
  verified_desired_revision bigint,
  verified_desired_hash char(64),
  verified_observed_revision bigint,
  verified_cart_fingerprint char(64),
  attempt_ref varchar(30),
  verified_attempt_ref varchar(30),
  fence_epoch bigint CHECK (fence_epoch IS NULL OR fence_epoch > 0),
  state varchar(24) NOT NULL CHECK (state IN ('PendingObservation','InSync','OutOfSync','Blocked','UnknownOutcome')),
  blocker_codes jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(blocker_codes) = 'array'),
  last_observed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  source_message_id text NOT NULL CHECK (source_message_id <> ''),
  FOREIGN KEY (attempt_ref,cart_scope_ref,fence_epoch)
    REFERENCES orders.convergence_attempts(attempt_ref,cart_scope_ref,fence_epoch),
  FOREIGN KEY (verified_attempt_ref) REFERENCES orders.convergence_attempts(attempt_ref),
  FOREIGN KEY (cart_scope_ref,verified_desired_revision,verified_desired_hash)
    REFERENCES orders.cart_desired_revisions(cart_scope_ref,desired_revision,desired_hash),
  FOREIGN KEY (cart_scope_ref,verified_observed_revision,verified_cart_fingerprint)
    REFERENCES orders.cart_observed_revisions(cart_scope_ref,observed_revision,cart_fingerprint),
  CHECK ((desired_revision = 0 AND desired_hash IS NULL) OR (desired_revision > 0 AND desired_hash IS NOT NULL)),
  CHECK ((observed_revision = 0 AND observed_cart_fingerprint IS NULL) OR (observed_revision > 0 AND observed_cart_fingerprint IS NOT NULL)),
  CHECK ((attempt_ref IS NULL) = (fence_epoch IS NULL)),
  CHECK ((verified_desired_revision IS NULL) = (verified_desired_hash IS NULL)),
  CHECK ((verified_observed_revision IS NULL) = (verified_cart_fingerprint IS NULL)),
  CHECK (state <> 'InSync' OR (verified_desired_revision = desired_revision AND verified_desired_hash = desired_hash
    AND verified_observed_revision = observed_revision AND verified_cart_fingerprint = observed_cart_fingerprint
    AND attempt_ref IS NOT NULL AND verified_attempt_ref = attempt_ref AND fence_epoch > 0
    AND blocker_codes = '[]'::jsonb) IS TRUE)
);
CREATE FUNCTION orders.guard_order_aroma_projection() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  proof orders.convergence_attempts%ROWTYPE;
  observed_proof bigint;
  has_proof boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'AROMA projection cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND ((NEW.order_ref,NEW.cart_scope_ref) IS DISTINCT FROM (OLD.order_ref,OLD.cart_scope_ref)
    OR NEW.projection_version <= OLD.projection_version OR NEW.desired_revision < OLD.desired_revision
    OR NEW.observed_revision < OLD.observed_revision OR NEW.updated_at < OLD.updated_at) THEN
    RAISE EXCEPTION 'AROMA projection identity/version cannot regress' USING ERRCODE = '23514';
  END IF;
  -- CHECK выдаёт точную ошибку для неполного InSync; trigger не скрывает SQL UNKNOWN.
  IF NEW.state = 'InSync' AND (NEW.desired_hash IS NULL OR NEW.observed_cart_fingerprint IS NULL
    OR NEW.verified_desired_hash IS NULL OR NEW.verified_cart_fingerprint IS NULL
    OR NEW.verified_attempt_ref IS NULL OR NEW.fence_epoch IS NULL) THEN RETURN NEW; END IF;
  IF NEW.desired_revision > 0 AND NOT EXISTS (SELECT 1 FROM orders.cart_desired_revisions
    WHERE cart_scope_ref = NEW.cart_scope_ref AND desired_revision = NEW.desired_revision AND desired_hash = NEW.desired_hash) THEN
    RAISE EXCEPTION 'projection desired proof does not exist' USING ERRCODE = '23503';
  END IF;
  IF NEW.observed_revision > 0 AND NOT EXISTS (SELECT 1 FROM orders.cart_observed_revisions
    WHERE cart_scope_ref = NEW.cart_scope_ref AND observed_revision = NEW.observed_revision
      AND cart_fingerprint = NEW.observed_cart_fingerprint) THEN
    RAISE EXCEPTION 'projection observed proof does not exist' USING ERRCODE = '23503';
  END IF;
  IF NEW.state = 'InSync' THEN
    SELECT * INTO proof FROM orders.convergence_attempts WHERE attempt_ref = NEW.verified_attempt_ref;
    has_proof := FOUND;
    observed_proof := CASE WHEN proof.state = 'VerifiedInSync'
      THEN proof.observed_end_revision ELSE proof.observed_start_revision END;
    IF NOT has_proof OR proof.state NOT IN ('VerifiedInSync','NoOpInSync')
       OR (NEW.cart_scope_ref,NEW.verified_desired_revision,NEW.verified_desired_hash,NEW.verified_observed_revision,NEW.fence_epoch)
         IS DISTINCT FROM (proof.cart_scope_ref,proof.desired_revision,proof.desired_hash,observed_proof,proof.fence_epoch)
       OR NOT EXISTS (SELECT 1 FROM orders.cart_desired_revisions
         WHERE cart_scope_ref=NEW.cart_scope_ref AND desired_revision=NEW.desired_revision AND state='Current')
       OR NOT EXISTS (SELECT 1 FROM orders.cart_observed_revisions
         WHERE cart_scope_ref=NEW.cart_scope_ref AND observed_revision=NEW.observed_revision AND state='Current')
       OR NOT EXISTS (SELECT 1 FROM orders.convergence_leases
         WHERE cart_scope_ref=NEW.cart_scope_ref AND fence_epoch=NEW.fence_epoch
           AND owner_instance_id=proof.owner_instance_id)
       OR EXISTS (SELECT 1 FROM orders.mutation_reservations
         WHERE cart_scope_ref=NEW.cart_scope_ref
           AND state IN ('Reserved','Dispatched','Acknowledged','UnknownOutcome'))
       OR EXISTS (SELECT 1 FROM orders.cart_desired_blockers
         WHERE cart_scope_ref=NEW.cart_scope_ref AND desired_revision=NEW.desired_revision
           AND order_ref=NEW.order_ref)
       OR NOT EXISTS (SELECT 1 FROM orders.cart_desired_order_facts facts
         JOIN orders.order_desired_contributions contribution
           ON contribution.order_ref = facts.order_ref AND contribution.contribution_revision = facts.contribution_revision
         WHERE facts.cart_scope_ref = NEW.cart_scope_ref AND facts.desired_revision = NEW.desired_revision
           AND facts.order_ref = NEW.order_ref AND contribution.state = 'Current') THEN
      RAISE EXCEPTION 'InSync requires current fenced proof, no unresolved mutation and no per-Order blocker' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER orders_aroma_projection_guard BEFORE INSERT OR UPDATE OR DELETE ON orders.order_aroma_projections
  FOR EACH ROW EXECUTE FUNCTION orders.guard_order_aroma_projection();
CREATE TRIGGER orders_aroma_order_facts_insert_guard BEFORE INSERT ON orders.cart_desired_order_facts
  FOR EACH ROW EXECUTE FUNCTION orders.guard_cart_fact_insert();
CREATE TRIGGER orders_aroma_order_facts_guard BEFORE UPDATE OR DELETE ON orders.cart_desired_order_facts
  FOR EACH ROW EXECUTE FUNCTION orders.reject_cart_fact_mutation();
CREATE TABLE orders.order_aroma_projection_history (
  order_ref varchar(30) NOT NULL REFERENCES orders.orders(order_ref) ON DELETE RESTRICT,
  projection_version bigint NOT NULL CHECK (projection_version > 0),
  projection jsonb NOT NULL CHECK (jsonb_typeof(projection) = 'object'),
  recorded_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (order_ref,projection_version)
);
CREATE FUNCTION orders.reject_projection_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'projection history is append-only' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER orders_projection_history_append_only BEFORE UPDATE OR DELETE ON orders.order_aroma_projection_history
  FOR EACH ROW EXECUTE FUNCTION orders.reject_projection_history_mutation();
REVOKE ALL ON TABLE orders.cart_desired_order_facts,orders.order_aroma_projections,orders.order_aroma_projection_history FROM PUBLIC;
GRANT SELECT,INSERT ON TABLE orders.cart_desired_order_facts TO coffee_orders_prepare_rw;
GRANT SELECT ON TABLE orders.cart_desired_order_facts TO coffee_orders_observer_rw,coffee_orders_convergence_rw;
GRANT SELECT,INSERT,UPDATE ON TABLE orders.order_aroma_projections TO coffee_orders_prepare_rw;
-- Guard sole writer проверяет текущий fence и scope-wide mutation barrier.
GRANT SELECT ON TABLE orders.convergence_leases,orders.mutation_reservations TO coffee_orders_prepare_rw;
GRANT SELECT ON TABLE orders.order_aroma_projections TO coffee_orders_observer_rw,coffee_orders_convergence_rw;
GRANT SELECT,INSERT ON TABLE orders.order_aroma_projection_history TO coffee_orders_prepare_rw;
GRANT SELECT ON TABLE orders.order_aroma_projections TO coffee_orders_service_rw;
REVOKE ALL ON FUNCTION orders.reject_projection_history_mutation(),orders.guard_order_aroma_projection() FROM PUBLIC;
