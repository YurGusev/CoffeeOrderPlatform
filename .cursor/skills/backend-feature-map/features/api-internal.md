# api-internal

Прокси `internal-v1`. Своей базы и своих событий нет. Контракт
`contracts/openapi/internal-v1.yaml`, пакет `packages/contracts/internal-v1`.
Маршруты регистрирует `apps/api-internal/src/index.ts`. В `config/platform.yaml`
у сервиса `kafka.producers` и `kafka.consumers` пустые.

## Операции

| Операция | Источник | Покрытие |
|---|---|---|
| `POST /api/internal-v1/pricing/quotes:verify` | OpenAPI `verifyPricingQuote`; `index.ts` | только unit/integration тесты (`tests/pricing/pricing-internal-api.test.mjs`) |
| `POST /api/internal-v1/aroma/offer-bindings` | OpenAPI `registerAromaOfferBinding`; `index.ts` | только unit/integration тесты (`tests/aroma/api-internal-operations.test.mjs`) |
| `GET /api/internal-v1/customers/:customerRef/order-input` | OpenAPI `getCustomerOrderInput`; `index.ts` | только unit/integration тесты (`tests/customer/customer-http.test.mjs`) |
| `GET /api/internal-v1/catalog/products/:productRef/variants/:variantRef/pricing-input` | OpenAPI `getCatalogPricingInput`; `index.ts` | только unit/integration тесты (`tests/catalog/catalog-root.test.mjs`) |
| `POST /api/internal-v1/aroma/catalog-exports` | OpenAPI `exportAromaCatalog`; `index.ts` | только unit/integration тесты (`tests/aroma/api-internal-operations.test.mjs`) |
| `POST /api/internal-v1/aroma/cart-snapshots:read` | OpenAPI `readAromaCartSnapshot`; `index.ts` | только unit/integration тесты (`tests/aroma/safe-read-http.test.mjs`) |
| `POST /api/internal-v1/aroma/cart-lines/:offerRef:set-quantity` | OpenAPI `setAromaCartLineQuantity`; `index.ts` | только unit/integration тесты (`tests/aroma/gateway-operations-http.test.mjs`) |
| `POST /api/internal-v1/aroma/cart-lines/:offerRef:remove` | OpenAPI `removeAromaCartLine`; `index.ts` | только unit/integration тесты (`tests/aroma/gateway-operations-http.test.mjs`) |
| `GET /health/live` | `packages/platform-runtime/src/index.ts` | только unit/integration тесты (`tests/runtime/lifecycle.test.mjs`) |
| `GET /health/ready` | `packages/platform-runtime/src/index.ts` | только unit/integration тесты (`tests/runtime/lifecycle.test.mjs`) |
| `GET /metrics` | `packages/platform-runtime/src/index.ts` | только unit/integration тесты (`tests/runtime/lifecycle.test.mjs`) |

`tests/runtime/lifecycle.test.mjs` проверяет регистратор runtime. Процесс `api-internal` этот файл не запускает.

## События

Публикаций и потреблений в коде сервиса нет.
