ALTER TABLE orders.cart_observed_lines
  ALTER COLUMN offer_ref TYPE varchar(30) COLLATE "C",
  ALTER COLUMN source_grind_key_hash TYPE char(64) COLLATE "C",
  ALTER COLUMN sanitized_line_hash TYPE char(64) COLLATE "C";
