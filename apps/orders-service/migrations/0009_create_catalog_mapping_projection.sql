CREATE TABLE orders.catalog_mapping_projection (
  product_ref varchar(30) NOT NULL CHECK (product_ref ~ '^prd_[0-9A-HJKMNP-TV-Z]{26}$'),
  variant_ref varchar(30) NOT NULL CHECK (variant_ref ~ '^var_[0-9A-HJKMNP-TV-Z]{26}$'),
  offer_ref varchar(30) CHECK (offer_ref IS NULL OR offer_ref ~ '^off_[0-9A-HJKMNP-TV-Z]{26}$'),
  mapping_revision bigint NOT NULL CHECK (mapping_revision >= 0),
  catalog_snapshot_revision bigint NOT NULL CHECK (catalog_snapshot_revision >= 0),
  mapping_state varchar(16) NOT NULL CHECK (mapping_state IN ('Active','Missing','Stopped')),
  availability varchar(16) NOT NULL CHECK (availability IN ('Available','Unavailable','Stopped')),
  effective_at timestamptz NOT NULL,
  source_message_id text NOT NULL CHECK (source_message_id <> ''),
  payload_hash char(64) NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (product_ref,variant_ref),
  CHECK (mapping_state <> 'Active' OR offer_ref IS NOT NULL)
);
CREATE FUNCTION orders.guard_catalog_mapping_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'mapping projection cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF (NEW.product_ref,NEW.variant_ref) IS DISTINCT FROM (OLD.product_ref,OLD.variant_ref)
     OR NEW.mapping_revision < OLD.mapping_revision THEN
    RAISE EXCEPTION 'mapping identity/revision cannot regress' USING ERRCODE = '23514';
  END IF;
  IF NEW.mapping_revision = OLD.mapping_revision THEN
    IF (to_jsonb(NEW) - 'source_message_id') IS DISTINCT FROM (to_jsonb(OLD) - 'source_message_id') THEN
      RAISE EXCEPTION 'equal mapping revision conflicts with persisted fact' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER orders_catalog_mapping_revision_guard BEFORE UPDATE OR DELETE ON orders.catalog_mapping_projection
  FOR EACH ROW EXECUTE FUNCTION orders.guard_catalog_mapping_revision();
REVOKE ALL ON FUNCTION orders.guard_catalog_mapping_revision() FROM PUBLIC;
CREATE INDEX orders_catalog_mapping_offer_idx
  ON orders.catalog_mapping_projection (offer_ref) WHERE offer_ref IS NOT NULL;
REVOKE ALL ON TABLE orders.catalog_mapping_projection FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON TABLE orders.catalog_mapping_projection TO coffee_orders_prepare_rw;
GRANT SELECT ON TABLE orders.catalog_mapping_projection TO coffee_orders_convergence_rw;
