CREATE TABLE catalog.snapshot_batches (
  snapshot_ref varchar(30) NOT NULL REFERENCES catalog.supplier_snapshots(snapshot_ref) ON DELETE RESTRICT,
  batch_number integer NOT NULL CHECK (batch_number >= 0),
  offer_count integer NOT NULL CHECK (offer_count BETWEEN 0 AND 500),
  uncompressed_bytes integer NOT NULL CHECK (uncompressed_bytes BETWEEN 2 AND 2097152),
  batch_hash char(64) NOT NULL CHECK (batch_hash ~ '^[0-9a-f]{64}$'),
  previous_batch_hash char(64) CHECK (previous_batch_hash ~ '^[0-9a-f]{64}$'),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (snapshot_ref, batch_number),
  CHECK ((batch_number = 0 AND previous_batch_hash IS NULL) OR (batch_number > 0 AND previous_batch_hash IS NOT NULL))
);

REVOKE ALL ON TABLE catalog.snapshot_batches FROM coffee_catalog_import_rw;
GRANT SELECT, INSERT ON TABLE catalog.snapshot_batches TO coffee_catalog_import_rw;
