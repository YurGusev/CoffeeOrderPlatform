ALTER TABLE catalog.products
  ADD COLUMN category_name text CHECK (category_name IS NULL OR char_length(category_name) BETWEEN 1 AND 200);

CREATE OR REPLACE VIEW catalog.active_products AS
  SELECT product.snapshot_ref, product.product_ref, product.display_name, product.display_name_sort_key,
         product.created_at, product.category_name
    FROM catalog.catalog_state AS state
    JOIN catalog.products AS product ON product.snapshot_ref = state.active_snapshot_ref
   WHERE state.id = true;
