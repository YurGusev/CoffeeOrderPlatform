# pricing-service

Считает котировку и проверяет её. Контракт `packages/contracts/pricing-v1`.
Входящие маршруты в `apps/pricing-service/src/http/index.ts`: константы `CREATE` и `VERIFY`.
Исходящий вызов каталога в `infrastructure/catalog-client.ts`.
В `config/platform.yaml` у сервиса `kafka.producers` и `kafka.consumers` пустые.

## Операции

| Операция | Источник | Покрытие |
|---|---|---|
| `POST /api/client-v1/pricing/quotes` | OpenAPI `createPricingQuote`; `http/index.ts` | только unit/integration тесты (`tests/pricing/pricing-http.test.mjs`) |
| `POST /api/internal-v1/pricing/quotes:verify` | OpenAPI `verifyPricingQuote`; `http/index.ts` | только unit/integration тесты (`tests/pricing/pricing-http.test.mjs`) |
| исходящий `GET /api/internal-v1/catalog/products/{productRef}/variants/{variantRef}/pricing-input` | OpenAPI `getCatalogPricingInput`; `catalog-client.ts` | только unit/integration тесты (`tests/pricing/catalog-client.test.mjs`) |
| `GET /health/live` | `packages/platform-runtime/src/index.ts` | только unit/integration тесты (`tests/runtime/lifecycle.test.mjs`) |
| `GET /health/ready` | `packages/platform-runtime/src/index.ts` | только unit/integration тесты (`tests/runtime/lifecycle.test.mjs`) |
| `GET /metrics` | `packages/platform-runtime/src/index.ts` | только unit/integration тесты (`tests/runtime/lifecycle.test.mjs`) |

`tests/pricing/pricing-public-api.test.mjs` бьёт в `api-public`, а не в процесс pricing.
`tests/runtime/lifecycle.test.mjs` проверяет регистратор runtime и процесс `pricing-service` не запускает.

## События

Публикаций и потреблений в коде сервиса нет.
