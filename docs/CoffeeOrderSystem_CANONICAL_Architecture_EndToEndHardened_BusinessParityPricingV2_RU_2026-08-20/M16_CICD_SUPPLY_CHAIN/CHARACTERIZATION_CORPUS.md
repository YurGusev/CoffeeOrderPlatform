# Characterization corpus before rewrite

Перед удалением legacy каждый business capability получает golden/property/integration cases. Результат классифицируется по `characterization-registry.yml`.

## Обязательные suites

- Customer matching/merge/channel evidence;
- Pricing/markup/delivery/margin;
- Excel preview/commit;
- Catalog search/resolver/feedback/abstention;
- Hermes session/dedupe/confirmation/tool policy;
- Invoice parse/validation/allocation/compensation;
- Work Center priority/calendar/source completeness;
- VK voice/media/callback overlap;
- AROMA convergence/UnknownOutcome/checkout.

`PRESERVE` требует zero unexplained mismatch. `INTENTIONAL_CHANGE` требует target test, который доказывает новое правило и regression test, что старое правило не вернулось. `RETIRE` требует zero-use telemetry + denied route/contract test.
