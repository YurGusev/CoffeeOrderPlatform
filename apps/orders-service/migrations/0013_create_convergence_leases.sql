CREATE TABLE orders.convergence_leases (
  cart_scope_ref varchar(32) PRIMARY KEY CHECK (cart_scope_ref = 'aroma-primary'),
  owner_instance_id uuid NOT NULL,
  fence_epoch bigint NOT NULL CHECK (fence_epoch > 0),
  acquired_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  heartbeat_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  expires_at timestamptz NOT NULL,
  CHECK (heartbeat_at >= acquired_at)
);
CREATE FUNCTION orders.guard_convergence_fence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'convergence fence must be monotonic' USING ERRCODE = '23514';
  END IF;
  IF NEW.cart_scope_ref IS DISTINCT FROM OLD.cart_scope_ref OR NEW.fence_epoch < OLD.fence_epoch
     OR (NEW.fence_epoch = OLD.fence_epoch AND NEW.acquired_at IS DISTINCT FROM OLD.acquired_at)
     OR NEW.heartbeat_at < OLD.heartbeat_at OR
     (NEW.owner_instance_id IS DISTINCT FROM OLD.owner_instance_id AND NEW.fence_epoch <= OLD.fence_epoch) THEN
    RAISE EXCEPTION 'convergence fence must be monotonic' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER orders_convergence_fence_guard BEFORE UPDATE OR DELETE ON orders.convergence_leases
  FOR EACH ROW EXECUTE FUNCTION orders.guard_convergence_fence();
REVOKE ALL ON TABLE orders.convergence_leases FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON TABLE orders.convergence_leases TO coffee_orders_convergence_rw;
REVOKE ALL ON FUNCTION orders.guard_convergence_fence() FROM PUBLIC;
