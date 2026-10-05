-- Один Orders-owned counter для Order command и material AROMA change.
-- Business version/snapshot остаются во владении orders-service.
ALTER TABLE orders.order_aroma_projections
  DROP CONSTRAINT order_aroma_projections_state_check,
  ADD CONSTRAINT order_aroma_projections_state_check
    CHECK (state IN ('PendingObservation','Converging','InSync','OutOfSync','Blocked','UnknownOutcome'));

CREATE FUNCTION orders.write_card_projection(p_order_ref text, p_aroma jsonb DEFAULT NULL)
RETURNS TABLE(projection_version bigint, material_change boolean, snapshot jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  core orders.orders%ROWTYPE;
  previous orders.order_aroma_projections%ROWTYPE;
  candidate orders.order_aroma_projections%ROWTYPE;
  has_previous boolean;
  next_version bigint;
  ignored text[] := ARRAY['projection_version','updated_at','source_message_id'];
BEGIN
  -- Definer равен владельцу миграций; runtime caller не может выбрать чужой путь.
  IF (p_aroma IS NULL AND session_user NOT IN ('coffee_orders_service_rw',current_user))
     OR (p_aroma IS NOT NULL AND session_user NOT IN ('coffee_orders_prepare_rw',current_user)) THEN
    RAISE EXCEPTION 'caller cannot advance this Card projection' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO core FROM orders.orders WHERE order_ref=p_order_ref FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order does not exist' USING ERRCODE = '23503';
  END IF;
  IF p_aroma IS NULL THEN
    UPDATE orders.orders AS current SET projection_version=current.projection_version+1
      WHERE current.order_ref=p_order_ref RETURNING current.projection_version INTO next_version;
    RETURN QUERY SELECT next_version,true,NULL::jsonb;
    RETURN;
  END IF;
  IF core.status <> 'Confirmed' OR jsonb_typeof(p_aroma) IS DISTINCT FROM 'object'
     OR p_aroma->>'order_ref' IS DISTINCT FROM p_order_ref
     OR p_aroma ?| ARRAY['projection_version','updated_at']
     OR p_aroma - ARRAY['order_ref','cart_scope_ref','desired_revision','desired_hash','observed_revision',
       'observed_cart_fingerprint','verified_desired_revision','verified_desired_hash','verified_observed_revision',
       'verified_cart_fingerprint','attempt_ref','verified_attempt_ref','fence_epoch','state','blocker_codes',
       'last_observed_at','source_message_id'] <> '{}'::jsonb THEN
    RAISE EXCEPTION 'invalid material Card projection' USING ERRCODE = '23514';
  END IF;
  candidate := jsonb_populate_record(NULL::orders.order_aroma_projections,p_aroma);
  SELECT * INTO previous FROM orders.order_aroma_projections WHERE order_ref=p_order_ref FOR UPDATE;
  has_previous := FOUND;
  IF has_previous AND (to_jsonb(previous)-ignored) IS NOT DISTINCT FROM (to_jsonb(candidate)-ignored) THEN
    RETURN QUERY SELECT core.projection_version,false,to_jsonb(previous);
    RETURN;
  END IF;
  UPDATE orders.orders AS current SET projection_version=current.projection_version+1
    WHERE current.order_ref=p_order_ref RETURNING current.projection_version INTO next_version;
  candidate.projection_version := next_version;
  candidate.updated_at := transaction_timestamp();
  INSERT INTO orders.order_aroma_projections SELECT (candidate).*
  ON CONFLICT(order_ref) DO UPDATE SET
    cart_scope_ref=EXCLUDED.cart_scope_ref,projection_version=EXCLUDED.projection_version,
    desired_revision=EXCLUDED.desired_revision,desired_hash=EXCLUDED.desired_hash,
    observed_revision=EXCLUDED.observed_revision,observed_cart_fingerprint=EXCLUDED.observed_cart_fingerprint,
    verified_desired_revision=EXCLUDED.verified_desired_revision,verified_desired_hash=EXCLUDED.verified_desired_hash,
    verified_observed_revision=EXCLUDED.verified_observed_revision,verified_cart_fingerprint=EXCLUDED.verified_cart_fingerprint,
    attempt_ref=EXCLUDED.attempt_ref,verified_attempt_ref=EXCLUDED.verified_attempt_ref,fence_epoch=EXCLUDED.fence_epoch,
    state=EXCLUDED.state,blocker_codes=EXCLUDED.blocker_codes,last_observed_at=EXCLUDED.last_observed_at,
    updated_at=EXCLUDED.updated_at,source_message_id=EXCLUDED.source_message_id;
  RETURN QUERY SELECT next_version,true,to_jsonb(candidate);
END;
$$;
REVOKE ALL ON FUNCTION orders.write_card_projection(text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION orders.write_card_projection(text,jsonb)
  TO coffee_orders_service_rw,coffee_orders_prepare_rw;
REVOKE INSERT,UPDATE,DELETE ON TABLE orders.order_aroma_projections FROM coffee_orders_prepare_rw;
-- Нельзя обойти guarded counter прямым UPDATE metadata column.
REVOKE UPDATE ON TABLE orders.orders FROM coffee_orders_service_rw;
GRANT UPDATE(status,version,customer_ref,customer_version,customer_display_name,customer_state,
  customer_state_proof_hash,currency,confirmed_at,updated_at,last_modified_by_actor_ref)
  ON TABLE orders.orders TO coffee_orders_service_rw;
