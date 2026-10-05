-- Эквивалентная проверка форматов без повторения класса на каждой позиции.
-- Типы/accepted values/FK/UNIQUE/quantity/creator guards остаются прежними.
ALTER TABLE orders.cart_observed_lines
  DROP CONSTRAINT cart_observed_lines_offer_ref_check,
  DROP CONSTRAINT cart_observed_lines_source_grind_key_hash_check,
  DROP CONSTRAINT cart_observed_lines_sanitized_line_hash_check,
  ADD CONSTRAINT cart_observed_lines_offer_ref_check CHECK (
    char_length(offer_ref) = 30 AND left(offer_ref,4) = 'off_'
    AND substring(offer_ref from 5) !~ '[^0-9A-HJKMNP-TV-Z]'
  ),
  ADD CONSTRAINT cart_observed_lines_source_grind_key_hash_check CHECK (
    source_grind_key_hash IS NULL OR (
      char_length(source_grind_key_hash::text) = 64
      AND source_grind_key_hash::text !~ '[^0-9a-f]'
    )
  ),
  ADD CONSTRAINT cart_observed_lines_sanitized_line_hash_check CHECK (
    char_length(sanitized_line_hash::text) = 64
    AND sanitized_line_hash::text !~ '[^0-9a-f]'
  );
