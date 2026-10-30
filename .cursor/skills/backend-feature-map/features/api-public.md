# api-public

Прокси `client-v1`. Своей базы и своих событий нет. Контракт
`contracts/openapi/client-v1.yaml`, пакет `packages/contracts/client-v1`.
Маршруты регистрирует `apps/api-public/src/index.ts`. `GET /events` в этом
файле нет: его принимает `realtime-gateway`. В `config/platform.yaml` у сервиса
`kafka.producers` и `kafka.consumers` пустые.

## Операции

| Операция | Источник | Покрытие |
|---|---|---|
| `POST /api/client-v1/customers` | OpenAPI `createCustomer`; `index.ts` | только unit/integration тесты (`tests/customer/customer-http.test.mjs`) |
| `GET /api/client-v1/customers` | OpenAPI `searchCustomers`; `index.ts` | только unit/integration тесты (`tests/customer/customer-http.test.mjs`) |
| `GET /api/client-v1/catalog/products` | OpenAPI `searchCatalogProducts`; `index.ts` | только unit/integration тесты (`tests/catalog/catalog-root.test.mjs`) |
| `POST /api/client-v1/pricing/quotes` | OpenAPI `createPricingQuote`; `index.ts` | только unit/integration тесты (`tests/pricing/pricing-public-api.test.mjs`) |
| `POST /api/client-v1/orders/drafts` | OpenAPI `createOrderDraft`; `index.ts` | только unit/integration тесты (`tests/orders/public-api.test.mjs`) |
| `PUT /api/client-v1/orders/:orderRef/items/:itemRef` | OpenAPI `upsertOrderItem`; `index.ts` | только unit/integration тесты (`tests/orders/public-api.test.mjs`) |
| `DELETE /api/client-v1/orders/:orderRef/items/:itemRef` | OpenAPI `removeOrderItem`; `index.ts` | только unit/integration тесты (`tests/orders/public-api.test.mjs`) |
| `POST /api/client-v1/orders/:orderRef/commands/confirm` | OpenAPI `confirmOrder`; `index.ts` | только unit/integration тесты (`tests/orders/public-api.test.mjs`) |
| `POST /api/client-v1/orders/:orderRef/commands/request-aroma-reconciliation` | OpenAPI `requestAromaReconciliation`; `index.ts` | только unit/integration тесты (`tests/orders/public-api.test.mjs`) |
| `GET /api/client-v1/orders/:orderRef` | OpenAPI `getOrderCard`; `index.ts` | только unit/integration тесты (`tests/orders/public-api.test.mjs`) |
| `GET /health/live` | `packages/platform-runtime/src/index.ts` | только unit/integration тесты (`tests/runtime/lifecycle.test.mjs`) |
| `GET /health/ready` | `packages/platform-runtime/src/index.ts` | только unit/integration тесты (`tests/runtime/lifecycle.test.mjs`) |
| `GET /metrics` | `packages/platform-runtime/src/index.ts` | только unit/integration тесты (`tests/runtime/lifecycle.test.mjs`) |

`tests/runtime/lifecycle.test.mjs` проверяет регистратор runtime. Процесс `api-public` этот файл не запускает.

## События

Публикаций и потреблений в коде сервиса нет.
