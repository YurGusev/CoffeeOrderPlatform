ALTER TABLE catalog.snapshot_products
  ADD COLUMN category_name text CHECK (category_name IS NULL OR char_length(category_name) BETWEEN 1 AND 200);

