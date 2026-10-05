-- Orders API читает только публичные projection facts, не получает права на
-- приватные lease/reservation/Attempt таблицы. InSync проверяется на момент read.
CREATE FUNCTION orders.read_card_projection(p_order_ref text,p_max_age_ms integer)
RETURNS TABLE(state text,desired_revision text,observed_revision text,blocker_codes jsonb,last_observed_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF session_user NOT IN ('coffee_orders_service_rw',current_user) THEN
    RAISE EXCEPTION 'caller cannot read guarded Card projection' USING ERRCODE='42501';
  END IF;
  IF p_max_age_ms IS NULL OR p_max_age_ms<0 THEN
    RAISE EXCEPTION 'invalid Card freshness window' USING ERRCODE='23514';
  END IF;
  RETURN QUERY
  SELECT (CASE
    WHEN EXISTS(SELECT 1 FROM orders.mutation_reservations AS r WHERE r.cart_scope_ref='aroma-primary' AND r.state='UnknownOutcome') THEN 'UnknownOutcome'
    WHEN p.state='InSync' AND NOT COALESCE(
      p_max_age_ms>0 AND d.desired_revision=p.verified_desired_revision AND d.desired_hash=p.verified_desired_hash
      AND observed.observed_revision=p.verified_observed_revision AND observed.cart_fingerprint=p.verified_cart_fingerprint
      AND observed.complete AND observed.captured_at<=clock_timestamp()
      AND observed.captured_at>=clock_timestamp()-p_max_age_ms*interval '1 millisecond'
      AND a.state IN ('NoOpInSync','VerifiedInSync') AND a.attempt_ref=p.attempt_ref
      AND a.desired_revision=d.desired_revision AND a.desired_hash=d.desired_hash
      AND (CASE WHEN a.state='NoOpInSync' THEN a.observed_start_revision ELSE a.observed_end_revision END)=observed.observed_revision
      AND a.fence_epoch=p.fence_epoch AND lease.fence_epoch=a.fence_epoch AND lease.owner_instance_id=a.owner_instance_id
      AND (lease.expires_at IS NULL OR lease.expires_at<=clock_timestamp())
      AND NOT EXISTS(SELECT 1 FROM orders.mutation_reservations AS r WHERE r.cart_scope_ref='aroma-primary' AND r.state IN ('Reserved','Dispatched','Acknowledged','UnknownOutcome'))
      AND NOT EXISTS(SELECT 1 FROM orders.cart_desired_blockers AS b WHERE b.cart_scope_ref='aroma-primary' AND b.desired_revision=d.desired_revision AND b.order_ref=core.order_ref)
      AND EXISTS(SELECT 1 FROM orders.cart_desired_order_facts AS f JOIN orders.order_desired_contributions AS c
        ON c.order_ref=f.order_ref AND c.contribution_revision=f.contribution_revision AND c.state='Current'
        WHERE f.cart_scope_ref='aroma-primary' AND f.desired_revision=d.desired_revision AND f.order_ref=core.order_ref)
      AND NOT EXISTS(SELECT 1 FROM
        (SELECT src.offer_ref,src.source_grind_key_hash,src.quantity_milli FROM orders.cart_desired_lines AS src WHERE src.cart_scope_ref='aroma-primary' AND src.desired_revision=d.desired_revision) AS dl
        FULL JOIN (SELECT src.offer_ref,src.source_grind_key_hash,src.quantity_milli FROM orders.cart_observed_lines AS src WHERE src.cart_scope_ref='aroma-primary' AND src.observed_revision=observed.observed_revision) AS ol
        ON dl.offer_ref=ol.offer_ref AND dl.source_grind_key_hash IS NOT DISTINCT FROM ol.source_grind_key_hash
        WHERE dl.quantity_milli IS DISTINCT FROM ol.quantity_milli),false)
      THEN CASE WHEN lease.expires_at>clock_timestamp() THEN 'Converging' ELSE 'OutOfSync' END
    WHEN p.state='Converging' AND (lease.expires_at IS NULL OR lease.expires_at<=clock_timestamp()) THEN 'OutOfSync'
    ELSE COALESCE(p.state,'PendingObservation') END)::text,
    COALESCE(p.desired_revision,0)::text,COALESCE(p.observed_revision,0)::text,
    CASE WHEN EXISTS(SELECT 1 FROM orders.mutation_reservations AS r WHERE r.cart_scope_ref='aroma-primary' AND r.state='UnknownOutcome')
      THEN '["AROMA_UNKNOWN_OUTCOME"]'::jsonb ELSE COALESCE(p.blocker_codes,'[]'::jsonb) END,p.last_observed_at
  FROM orders.orders AS core
  LEFT JOIN orders.order_aroma_projections AS p ON p.order_ref=core.order_ref
  LEFT JOIN orders.cart_desired_revisions AS d ON d.cart_scope_ref='aroma-primary' AND d.state='Current'
  LEFT JOIN orders.cart_observed_revisions AS observed ON observed.cart_scope_ref='aroma-primary' AND observed.state='Current'
  LEFT JOIN orders.convergence_attempts AS a ON a.attempt_ref=p.verified_attempt_ref
  LEFT JOIN orders.convergence_leases AS lease ON lease.cart_scope_ref='aroma-primary'
  WHERE core.order_ref=p_order_ref;
END;
$$;
REVOKE ALL ON FUNCTION orders.read_card_projection(text,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION orders.read_card_projection(text,integer) TO coffee_orders_service_rw;
