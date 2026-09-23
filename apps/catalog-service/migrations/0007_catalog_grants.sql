REVOKE ALL ON SCHEMA catalog FROM PUBLIC;
GRANT USAGE ON SCHEMA catalog TO coffee_catalog_activate_rw, coffee_catalog_api_ro;

REVOKE ALL ON TABLE catalog.platform_schema_migrations, catalog.supplier_snapshots, catalog.snapshot_batches,
  catalog.snapshot_products, catalog.snapshot_variants, catalog.snapshot_offers,
  catalog.snapshot_availability, catalog.catalog_state, catalog.products,
  catalog.variants, catalog.offer_mappings, catalog.availability,
  catalog.source_identities, catalog.offer_binding_acks, catalog.outbox_messages,
  catalog.active_products, catalog.active_variants, catalog.active_offer_mappings,
  catalog.active_availability
  FROM coffee_catalog_activate_rw, coffee_catalog_api_ro;

GRANT SELECT ON TABLE catalog.supplier_snapshots TO coffee_catalog_activate_rw;
GRANT UPDATE (state, failure_code, declared_batch_count, declared_product_count, declared_variant_count,
  declared_offer_count, content_hash, received_at) ON TABLE catalog.supplier_snapshots TO coffee_catalog_activate_rw;
GRANT SELECT ON TABLE catalog.snapshot_batches, catalog.snapshot_products,
  catalog.snapshot_variants, catalog.snapshot_offers, catalog.snapshot_availability
  TO coffee_catalog_activate_rw;
GRANT SELECT, INSERT, UPDATE ON TABLE catalog.catalog_state TO coffee_catalog_activate_rw;
GRANT SELECT, INSERT ON TABLE catalog.products, catalog.variants,
  catalog.offer_mappings, catalog.availability TO coffee_catalog_activate_rw;
GRANT SELECT, INSERT ON TABLE catalog.source_identities TO coffee_catalog_activate_rw;
GRANT UPDATE (last_seen_snapshot_ref, state) ON TABLE catalog.source_identities TO coffee_catalog_activate_rw;
GRANT SELECT, INSERT, UPDATE ON TABLE catalog.offer_binding_acks, catalog.outbox_messages TO coffee_catalog_activate_rw;

GRANT SELECT ON TABLE catalog.active_products, catalog.active_variants,
  catalog.active_offer_mappings, catalog.active_availability TO coffee_catalog_api_ro;

-- coffee_catalog_import_rw remains limited to the staging grants from 0001–0003.
