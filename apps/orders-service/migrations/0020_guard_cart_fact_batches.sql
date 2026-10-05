-- Capacity: once-per-statement creator guard вместо 10000 одинаковых header lookups.
-- Каждый distinct revision сохраняет прежние Current/xmin гарантии; FK/unique,
-- append-only UPDATE/DELETE guards и fence checks не меняются.
CREATE FUNCTION orders.guard_desired_fact_statement() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM (SELECT DISTINCT cart_scope_ref,desired_revision FROM new_cart_facts) AS facts
    JOIN orders.cart_desired_revisions AS revision USING(cart_scope_ref,desired_revision)
    WHERE revision.xmin IS DISTINCT FROM pg_current_xact_id()::xid OR revision.state<>'Current'
  ) THEN
    RAISE EXCEPTION 'cart facts must be inserted atomically with a Current revision' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE FUNCTION orders.guard_observed_fact_statement() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM (SELECT DISTINCT cart_scope_ref,observed_revision FROM new_cart_facts) AS facts
    JOIN orders.cart_observed_revisions AS revision USING(cart_scope_ref,observed_revision)
    WHERE revision.xmin IS DISTINCT FROM pg_current_xact_id()::xid OR revision.state<>'Current'
  ) THEN
    RAISE EXCEPTION 'cart facts must be inserted atomically with a Current revision' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;
DROP TRIGGER orders_desired_lines_insert_guard ON orders.cart_desired_lines;
DROP TRIGGER orders_desired_blockers_insert_guard ON orders.cart_desired_blockers;
DROP TRIGGER orders_aroma_order_facts_insert_guard ON orders.cart_desired_order_facts;
DROP TRIGGER orders_observed_lines_insert_guard ON orders.cart_observed_lines;
CREATE TRIGGER orders_desired_lines_insert_guard AFTER INSERT ON orders.cart_desired_lines
  REFERENCING NEW TABLE AS new_cart_facts FOR EACH STATEMENT EXECUTE FUNCTION orders.guard_desired_fact_statement();
CREATE TRIGGER orders_desired_blockers_insert_guard AFTER INSERT ON orders.cart_desired_blockers
  REFERENCING NEW TABLE AS new_cart_facts FOR EACH STATEMENT EXECUTE FUNCTION orders.guard_desired_fact_statement();
CREATE TRIGGER orders_aroma_order_facts_insert_guard AFTER INSERT ON orders.cart_desired_order_facts
  REFERENCING NEW TABLE AS new_cart_facts FOR EACH STATEMENT EXECUTE FUNCTION orders.guard_desired_fact_statement();
CREATE TRIGGER orders_observed_lines_insert_guard AFTER INSERT ON orders.cart_observed_lines
  REFERENCING NEW TABLE AS new_cart_facts FOR EACH STATEMENT EXECUTE FUNCTION orders.guard_observed_fact_statement();
DROP FUNCTION orders.guard_cart_fact_insert();
REVOKE ALL ON FUNCTION orders.guard_desired_fact_statement(),orders.guard_observed_fact_statement() FROM PUBLIC;
