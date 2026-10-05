-- Это owner-specific durable wake-up, не generic job storage.
CREATE TABLE orders.convergence_work (
  cart_scope_ref varchar(32) PRIMARY KEY CHECK (cart_scope_ref = 'aroma-primary'),
  -- NULL означает pending intent до первого реального Desired, а не revision zero.
  desired_revision bigint CHECK (desired_revision > 0),
  dirty boolean NOT NULL DEFAULT true,
  wake_revision bigint NOT NULL DEFAULT 1 CHECK (wake_revision > 0),
  reason varchar(24) NOT NULL CHECK (reason IN ('OrderConfirmed','CatalogChanged','OperatorRequested','Recovery')),
  next_attempt_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  FOREIGN KEY (cart_scope_ref,desired_revision)
    REFERENCES orders.cart_desired_revisions(cart_scope_ref,desired_revision)
);
CREATE FUNCTION orders.guard_convergence_work() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'pending convergence work cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF NEW.cart_scope_ref IS DISTINCT FROM OLD.cart_scope_ref OR NEW.wake_revision < OLD.wake_revision
     OR NEW.updated_at < OLD.updated_at
     OR (OLD.desired_revision IS NOT NULL AND (NEW.desired_revision IS NULL OR NEW.desired_revision < OLD.desired_revision))
     OR (((NEW.desired_revision,NEW.reason) IS DISTINCT FROM (OLD.desired_revision,OLD.reason)
       OR (NEW.dirty AND NOT OLD.dirty)) AND NEW.wake_revision <= OLD.wake_revision) THEN
    RAISE EXCEPTION 'durable convergence intent/wake revision cannot regress' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER orders_convergence_work_guard BEFORE UPDATE OR DELETE ON orders.convergence_work
  FOR EACH ROW EXECUTE FUNCTION orders.guard_convergence_work();

CREATE TABLE orders.observation_schedule (
  cart_scope_ref varchar(32) PRIMARY KEY CHECK (cart_scope_ref = 'aroma-primary'),
  next_observation_at timestamptz NOT NULL,
  lease_owner uuid,
  lease_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CHECK ((lease_owner IS NULL) = (lease_until IS NULL))
);
CREATE FUNCTION orders.guard_observation_schedule() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'durable observation schedule cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF NEW.cart_scope_ref IS DISTINCT FROM OLD.cart_scope_ref OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'observation schedule identity/time cannot regress' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER orders_observation_schedule_guard BEFORE UPDATE OR DELETE ON orders.observation_schedule
  FOR EACH ROW EXECUTE FUNCTION orders.guard_observation_schedule();
REVOKE ALL ON TABLE orders.convergence_work,orders.observation_schedule FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON TABLE orders.convergence_work TO coffee_orders_prepare_rw;
GRANT SELECT ON TABLE orders.convergence_work TO coffee_orders_convergence_rw;
-- Convergence consume/reschedule не может изменить подготовленный intent или wake counter.
GRANT UPDATE (dirty,next_attempt_at,updated_at) ON orders.convergence_work TO coffee_orders_convergence_rw;
GRANT SELECT,INSERT,UPDATE ON TABLE orders.observation_schedule TO coffee_orders_observer_rw;
REVOKE ALL ON FUNCTION orders.guard_convergence_work(),orders.guard_observation_schedule() FROM PUBLIC;
