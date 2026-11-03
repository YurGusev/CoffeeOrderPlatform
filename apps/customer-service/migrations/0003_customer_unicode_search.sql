CREATE COLLATION customer.unicode_lowercase (
  provider = icu,
  locale = 'und',
  deterministic = true
);

ALTER TABLE customer.customers
  DROP CONSTRAINT customers_check1,
  ADD CONSTRAINT customers_display_name_search_check
    CHECK (display_name_search = lower(display_name COLLATE customer.unicode_lowercase));
