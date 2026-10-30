# catalog-service

Владелец чтения каталога. Контракт `packages/contracts/catalog-v1`.
Маршруты регистрирует `apps/catalog-service/src/http/index.ts`.
В `config/platform.yaml` у сервиса `kafka.producers` и `kafka.consumers` пустые.

## Операции

| Операция | Источник | Покрытие |
|---|---|---|
| `GET /api/client-v1/catalog/products` | OpenAPI `searchCatalogProducts`; `http/index.ts` | только unit/integration тесты (`tests/catalog/catalog-owner.test.mjs`) |
| `GET /api/internal-v1/catalog/products/:productRef/variants/:variantRef/pricing-input` | OpenAPI `getCatalogPricingInput`; `http/index.ts` | только unit/integration тесты (`tests/catalog/catalog-owner.test.mjs`) |
| `GET /health/live` | `packages/platform-runtime/src/index.ts` | только unit/integration тесты (`tests/runtime/lifecycle.test.mjs`) |
| `GET /health/ready` | `packages/platform-runtime/src/index.ts` | только unit/integration тесты (`tests/runtime/lifecycle.test.mjs`) |
| `GET /metrics` | `packages/platform-runtime/src/index.ts` | только unit/integration тесты (`tests/runtime/lifecycle.test.mjs`) |

`tests/runtime/lifecycle.test.mjs` проверяет регистратор runtime. Процесс `catalog-service` этот файл не запускает.

## События

Публикаций и потреблений в коде сервиса нет. События каталога пишет
`catalog-activation-worker`.
