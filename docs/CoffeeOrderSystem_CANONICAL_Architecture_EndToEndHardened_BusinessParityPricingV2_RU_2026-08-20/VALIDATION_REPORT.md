# Validation Report — BusinessParityPricingV2 revision overlay

**Baseline SHA-256:** `e869535c9c5c0f19d84ff1d2582bd541c4ed1781c44fa5d49836be85235f37f5`  
**Revision date:** 2026-08-20

## Baseline evidence

EndToEndHardened baseline had 21 programs, 20 Kafka topics, 35 MessageTypes, 41 JSON schemas, 32 runtime roles, zero reported sync cycles and production status `PENDING EVIDENCE`.

## Revision structural results

- Programs after overlay: **23** (`M00…M22`).
- New Kafka topics: **8**; resulting logical total **28**.
- New MessageTypes: **10**; resulting logical MessageTypes **45**.
- New JSON payload schemas: **10**; resulting logical schema total **51** (41 baseline + 10 revision).
- New runtime roles: **10**; resulting logical total **42**.
- Existing baseline topics receive explicit `work-center-projection` consumer-group patches for Orders/Catalog/AROMA/Invoices/Payments.
- Baseline `Orders Draft → Catalog product-snapshot-and-explicit-pricing` edge is replaced by `product-snapshot-only` + dedicated `Orders Draft → Pricing` quote edge.
- New agent skills: **9**; resulting logical target-skill total **35** (26 baseline + 9 revision).
- JSON/YAML syntax: validated by this package build.
- All new MessageTypes have positive fixture.
- Relative links within overlay: validated.

## Semantic results

PASS at specification level for newly audited capabilities:

- Customer duplicate/evidence lifecycle;
- Pricing v2;
- Excel Import/Export;
- Work Center;
- Catalog Search/Resolution;
- Invoice manual recovery;
- Hermes policy parity;
- VK media/voice;
- privacy/identity hardening;
- characterization dispositions.

## Production status

Still **PENDING EVIDENCE**. Additional gates introduced by this revision:

1. Pricing shadow comparison against legacy accepted cases and intentional-change cases.
2. Actual delivery coefficient dry-run with real completed procurement batch.
3. ProductPriceProjection load/performance and stale-propagation test.
4. Excel import golden corpus/worker load test.
5. Work Center source-completeness/lag failure test.
6. Customer indexed resolver parity and scale test.
7. Catalog Search model/vector fallback and abstention evaluation.
8. Invoice manual recovery canary.
9. Hermes policy parity and VK media/voice provider canary.
10. Repository full-history secret scan after credential rotation/history rewrite.

**Revision specification verdict:** `PASS`.  
**Production certification:** `PENDING EVIDENCE`.
