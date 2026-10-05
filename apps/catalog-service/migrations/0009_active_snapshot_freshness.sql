-- Начало импорта доступно читателям Catalog через существующий owner-local view.
CREATE OR REPLACE VIEW catalog.active_snapshot_metadata AS
  SELECT state.active_snapshot_ref AS snapshot_ref,
         state.active_snapshot_revision::text AS snapshot_revision,
         snapshot.created_at AS snapshot_created_at
    FROM catalog.catalog_state AS state
    LEFT JOIN catalog.supplier_snapshots AS snapshot ON snapshot.snapshot_ref = state.active_snapshot_ref
   WHERE state.id = true;

REVOKE ALL ON TABLE catalog.active_snapshot_metadata FROM PUBLIC;
GRANT SELECT ON TABLE catalog.active_snapshot_metadata TO coffee_catalog_api_ro;
