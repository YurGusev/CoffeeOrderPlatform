-- Safe aggregate/allowlist query only; no raw JSON, profile values, cart hashes, names, or credentials.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '5000ms';
SELECT table_name, ordinal_position, column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema='orders'
  AND table_name IN ('AromaCartCurrentLines','AromaCartObservedItems')
  AND (column_name ILIKE '%source%' OR column_name ILIKE '%provenance%'
    OR column_name ILIKE '%snapshot%' OR column_name ILIKE '%profile%'
    OR column_name ILIKE '%readat%' OR column_name ILIKE '%observedat%'
    OR column_name ILIKE '%createdat%' OR column_name ILIKE '%updatedat%'
    OR column_name ILIKE '%freshness%')
ORDER BY table_name, ordinal_position;
SELECT 'cart_current' source,
       CASE WHEN "ExternalPacking"='Aroma' THEN 'Aroma'
            WHEN "ExternalPacking" IS NULL THEN '<null>' ELSE '<other>' END packing,
       count(*) line_occurrences, min("ReadAtUtc") earliest, max("ReadAtUtc") latest,
       round((extract(epoch FROM now()-max("ReadAtUtc"))/86400)::numeric,2) age_days,
       count(DISTINCT "SnapshotId") snapshots
FROM orders."AromaCartCurrentLines" GROUP BY 1,2
UNION ALL
SELECT 'cart_observed',
       CASE WHEN "ExternalPacking"='Aroma' THEN 'Aroma'
            WHEN "ExternalPacking" IS NULL THEN '<null>' ELSE '<other>' END,
       count(*), min("ObservedAtUtc"), max("ObservedAtUtc"),
       round((extract(epoch FROM now()-max("ObservedAtUtc"))/86400)::numeric,2),
       count(DISTINCT "ObservedSnapshotId")
FROM orders."AromaCartObservedItems" GROUP BY 1,2
UNION ALL
SELECT 'catalog_current','all',count(*),min("ObservedAtUtc"),max("ObservedAtUtc"),
       round((extract(epoch FROM now()-max("ObservedAtUtc"))/86400)::numeric,2),
       count(DISTINCT "LastSnapshotId")
FROM catalog."AromaCatalogCurrentOffers"
ORDER BY 1,2;
WITH provider_weight AS (
 SELECT o."ExternalOfferId" offer_id, o."CategorySlug" category_slug,
        o."ObservedAtUtc" catalog_observed_at, (x.elem->>'Value')::integer weight_g
 FROM catalog."AromaCatalogCurrentOffers" o
 CROSS JOIN LATERAL jsonb_array_elements(o."ParametersJson") x(elem)
 WHERE x.elem->>'Slug'='weight'
), current_aroma AS (
 SELECT "ExternalOfferId" offer_id, count(*) current_line_occurrences, max("ReadAtUtc") current_latest
 FROM orders."AromaCartCurrentLines" WHERE "ExternalPacking"='Aroma' GROUP BY 1
), observed_aroma AS (
 SELECT "ExternalOfferId" offer_id, count(*) observed_line_occurrences,
        max("ObservedAtUtc") observed_latest
 FROM orders."AromaCartObservedItems" WHERE "ExternalPacking"='Aroma' GROUP BY 1
), candidates AS (
 SELECT p.offer_id,p.category_slug,p.weight_g,c.current_line_occurrences,
        o.observed_line_occurrences,c.current_latest,o.observed_latest,p.catalog_observed_at
 FROM provider_weight p
 JOIN current_aroma c USING(offer_id)
 JOIN observed_aroma o USING(offer_id)
 JOIN catalog."AromaOfferMappings" m ON m."ExternalOfferId"=p.offer_id
 WHERE p.weight_g IN (500,1000)
   AND p.category_slug IN ('monosorta','aromatizirovannyi-kofe','mikroloty',
       'espresso-smesi','drip-kofe','premialnye-kupazi','robusta',
       'espresso-smesi-dlia-avtomaticeskix-kofemasin-i-vendinga')
   AND m."IsActive" AND NOT m."NeedsManualReview" AND m."ReviewStatus"=1
   AND m."WeightGrams"=p.weight_g
)
SELECT weight_g,count(*) eligible_offer_ids FROM candidates GROUP BY weight_g ORDER BY weight_g;
WITH provider_weight AS (
 SELECT o."ExternalOfferId" offer_id, o."CategorySlug" category_slug,
        o."ObservedAtUtc" catalog_observed_at, (x.elem->>'Value')::integer weight_g
 FROM catalog."AromaCatalogCurrentOffers" o
 CROSS JOIN LATERAL jsonb_array_elements(o."ParametersJson") x(elem)
 WHERE x.elem->>'Slug'='weight'
), current_aroma AS (
 SELECT "ExternalOfferId" offer_id, count(*) current_line_occurrences, max("ReadAtUtc") current_latest
 FROM orders."AromaCartCurrentLines" WHERE "ExternalPacking"='Aroma' GROUP BY 1
), observed_aroma AS (
 SELECT "ExternalOfferId" offer_id, count(*) observed_line_occurrences,
        max("ObservedAtUtc") observed_latest
 FROM orders."AromaCartObservedItems" WHERE "ExternalPacking"='Aroma' GROUP BY 1
)
SELECT p.offer_id,p.category_slug,p.weight_g,'Aroma' packing,
       c.current_line_occurrences,o.observed_line_occurrences,
       c.current_latest,o.observed_latest,p.catalog_observed_at
FROM provider_weight p
JOIN current_aroma c USING(offer_id)
JOIN observed_aroma o USING(offer_id)
JOIN catalog."AromaOfferMappings" m ON m."ExternalOfferId"=p.offer_id
WHERE p.weight_g IN (500,1000)
  AND p.category_slug IN ('monosorta','aromatizirovannyi-kofe','mikroloty',
      'espresso-smesi','drip-kofe','premialnye-kupazi','robusta',
      'espresso-smesi-dlia-avtomaticeskix-kofemasin-i-vendinga')
  AND m."IsActive" AND NOT m."NeedsManualReview" AND m."ReviewStatus"=1
  AND m."WeightGrams"=p.weight_g
ORDER BY p.weight_g DESC,p.offer_id LIMIT 10;
ROLLBACK;
