-- Keep all existing order rows and their immutable history unchanged.
ALTER TABLE orders.order_items
  ADD COLUMN source_grind_key_hash char(64),
  ADD COLUMN grind_display_name varchar(200),
  ADD CONSTRAINT order_items_grind_pair_ck
    CHECK ((source_grind_key_hash IS NULL) = (grind_display_name IS NULL)
      AND (source_grind_key_hash IS NULL OR source_grind_key_hash ~ '^[0-9a-f]{64}$')
      AND (grind_display_name IS NULL OR length(grind_display_name) > 0));

ALTER TABLE orders.order_desired_contribution_lines
  ADD COLUMN source_grind_key_hash char(64)
    CHECK (source_grind_key_hash IS NULL OR source_grind_key_hash ~ '^[0-9a-f]{64}$');
ALTER TABLE orders.order_desired_contribution_lines
  DROP CONSTRAINT order_desired_contribution_lines_pkey;
ALTER TABLE orders.order_desired_contribution_lines
  ADD COLUMN line_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ADD CONSTRAINT order_desired_contribution_lines_physical_key_uq
    UNIQUE NULLS NOT DISTINCT (order_ref, contribution_revision, offer_ref, source_grind_key_hash);
