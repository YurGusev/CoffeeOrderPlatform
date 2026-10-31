# catalog-service

Владелец чтения каталога. Контракт `packages/contracts/catalog-v1`.
Маршруты регистрирует `apps/catalog-service/src/http/index.ts`.
В `config/platform.yaml` у сервиса `kafka.producers` и `kafka.consumers` пустые.

Живой навык [catalog-slice-verify](../../catalog-slice-verify/SKILL.md)
запускает `node .cursor/skills/catalog-slice-verify/run.mjs` против процесса
`catalog-service` и базы `coffee_platform_catalog`.

## Операции

| Операция | Источник | Покрытие |
|---|---|---|
| `GET /api/client-v1/catalog/products` | OpenAPI `searchCatalogProducts`; `http/index.ts` | проверяется живым навыком catalog-slice-verify |
| `GET /api/internal-v1/catalog/products/:productRef/variants/:variantRef/pricing-input` | OpenAPI `getCatalogPricingInput`; `http/index.ts` | проверяется живым навыком catalog-slice-verify |
| `GET /health/live` | `packages/platform-runtime/src/index.ts` | проверяется живым навыком catalog-slice-verify |
| `GET /health/ready` | `packages/platform-runtime/src/index.ts` | проверяется живым навыком catalog-slice-verify |
| `GET /metrics` | `packages/platform-runtime/src/index.ts` | проверяется живым навыком catalog-slice-verify |

Навык вызывает поиск, pricing-input, `GET /health/live`, `GET /health/ready` и
`GET /metrics`. Поиск включает пустой снимок, отказы транспорта и делегации и
страницу с курсором. Pricing-input включает отказы, вызов `pricing-service`,
вызов `aroma-convergence` и отсутствующий вариант. Фикстура снимка пишется в
Postgres самим прогоном. Поставщик не вызывается.

`tests/runtime/lifecycle.test.mjs` проверяет регистратор runtime. Процесс
`catalog-service` этот файл не запускает. Живой процесс эти три маршрута всё
равно проходит навыком.

## События

Публикаций и потреблений в коде сервиса нет. `CatalogSnapshotActivated.v1` и
`CatalogMappingChanged.v2` пишет `catalog-activation-worker`. Навык воркер не
поднимает и записывает оба события как `not-covered`. Сценарии `outbox-silent`
и `kafka-silent` проверяют, что этот процесс не пишет `catalog.outbox_messages`
и не двигает offsets `coffee.catalog.snapshot.v1` и `coffee.catalog.mapping.v2`.
