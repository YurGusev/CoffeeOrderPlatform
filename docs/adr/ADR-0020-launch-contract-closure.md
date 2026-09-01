# ADR-0020: contract closure первого greenfield-запуска

Статус: Accepted вместе с launch authority package. Дата: 2026-09-01.

## Контекст

Канонический `CatalogMappingChanged.v1` описывает legacy-compatible
`CoffeeWeightVariantRef` и другой status vocabulary. Greenfield Catalog владеет
`productRef/variantRef/offerRef`; повторное использование имени v1 для другого
wire payload нарушило бы schema evolution. В M19 также отсутствует variant-
specific Pricing input route. Realtime topic в launch расходился с registry.

## Решение

- Новый контракт называется только `CatalogMappingChanged.v2`, key =
  `productRef`; payload: `productRef`, `variantRef`, `offerRef|null`,
  `catalogSnapshotRevision`, `mappingRevision`, `mappingState`, `availability`,
  `effectiveAt`. V1 не производится и не потребляется launch runtimes.
- Private route первого запуска:
  `GET /api/internal-v1/catalog/products/{productRef}/variants/{variantRef}/pricing-input`.
  Он доступен только audience `pricing-service`; несовпадающая пара refs — 404,
  stopped/unavailable — 409, неполная generation — 503.
- Realtime использует canonical topic `coffee.realtime.invalidate.v1`, 24
  partitions, retention 1h. Каждая replica имеет отдельную ephemeral consumer
  group `realtime-gateway-<replica-id>`; общий static group запрещён, иначе
  connection другой replica потеряет invalidation.

JSON Schemas, registry, OpenAPI, fixtures, producers и consumers обновляются
атомарно в #4. Наличие v1 launch payload, старого pricing route или другого
realtime topic блокирует `pnpm contracts:check`.
