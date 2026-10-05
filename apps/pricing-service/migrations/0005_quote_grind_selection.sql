-- Forward-only: old quote rows remain without a selection; existing hashes are immutable.
ALTER TABLE pricing.pricing_quote_lines
  ADD COLUMN source_grind_key_hash char(64),
  ADD COLUMN grind_display_name varchar(200),
  ADD CONSTRAINT pricing_quote_lines_grind_pair_ck
    CHECK ((source_grind_key_hash IS NULL) = (grind_display_name IS NULL)
      AND (source_grind_key_hash IS NULL OR source_grind_key_hash ~ '^[0-9a-f]{64}$')
      AND (grind_display_name IS NULL OR length(grind_display_name) > 0));

ALTER TABLE pricing.pricing_quote_lines
  DROP CONSTRAINT pricing_quote_lines_quote_ref_product_ref_variant_ref_key;
ALTER TABLE pricing.pricing_quote_lines
  ADD CONSTRAINT pricing_quote_lines_product_variant_grind_uq
    UNIQUE NULLS NOT DISTINCT (quote_ref, product_ref, variant_ref, source_grind_key_hash);
