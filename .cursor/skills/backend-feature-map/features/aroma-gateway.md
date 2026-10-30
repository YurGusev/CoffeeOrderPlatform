# aroma-gateway

Транспорт провайдера AROMA. Платформенные маршруты регистрирует
`apps/aroma-gateway/src/transport/http/index.ts`. Контракт операций
`contracts/openapi/internal-v1.yaml` и пакет `packages/contracts/aroma-v1`.
Вызовы `aromateacoffee.ru` собирает `infrastructure/provider/http-client.ts`.
В `config/platform.yaml` у сервиса `kafka.producers` и `kafka.consumers` пустые.

Две операции OpenAPI `setAromaCartLineQuantity` и `removeAromaCartLine` сидят на одном маршруте Fastify
`POST /api/internal-v1/aroma/cart-lines/:mutationTarget`. Параметр должен совпасть с
`off_<ulid>:set-quantity` или `off_<ulid>:remove`. У `api-internal` это два отдельных маршрута.

## Операции

| Операция | Источник | Покрытие |
|---|---|---|
| `POST /api/internal-v1/aroma/offer-bindings` | OpenAPI `registerAromaOfferBinding`; `transport/http/index.ts` | только unit/integration тесты (`tests/aroma/binding-http.test.mjs`) |
| `POST /api/internal-v1/aroma/cart-snapshots:read` | OpenAPI `readAromaCartSnapshot`; `transport/http/index.ts` | только unit/integration тесты (`tests/aroma/binding-http.test.mjs`) |
| `POST /api/internal-v1/aroma/cart-lines/:mutationTarget` для `:set-quantity` | OpenAPI `setAromaCartLineQuantity`; `transport/http/index.ts` | только unit/integration тесты (`tests/aroma/gateway-operations-http.test.mjs`) |
| `POST /api/internal-v1/aroma/cart-lines/:mutationTarget` для `:remove` | OpenAPI `removeAromaCartLine`; `transport/http/index.ts` | только unit/integration тесты (`tests/aroma/gateway-operations-http.test.mjs`) |
| `POST /api/internal-v1/aroma/catalog-exports` | OpenAPI `exportAromaCatalog`; `transport/http/index.ts` | только unit/integration тесты (`tests/aroma/catalog-export.test.mjs`) |
| исходящий `POST /api/v1/auth/login` | `provider/http-client.ts` | только unit/integration тесты (`tests/aroma/provider-http.test.mjs`) |
| исходящий `GET /api/v1/cart/` | `provider/http-client.ts`, kind `cart` | только unit/integration тесты (`tests/aroma/provider-http.test.mjs`) |
| исходящий `GET /api/v1/user` | `provider/http-client.ts`, kind `user` | только unit/integration тесты (`tests/aroma/provider-http.test.mjs`) |
| исходящий `GET /api/v1/catalog/grinds` | `provider/http-client.ts`, kind `grinds` | только unit/integration тесты (`tests/aroma/catalog-export.test.mjs`) |
| исходящий `GET /api/v1/catalog/wholesale/products` | `provider/http-client.ts`, kind `catalog-page` | только unit/integration тесты (`tests/aroma/provider-http.test.mjs`) |
| исходящий `POST /api/v1/cart/` | `provider/http-client.ts`, kind `add-cart-line` | только unit/integration тесты (`tests/aroma/provider-cart-mutator.test.mjs`) |
| исходящий `PUT /api/v1/cart/{cartLineId}` | `provider/http-client.ts`, kind `set-cart-line-quantity` | только unit/integration тесты (`tests/aroma/provider-cart-mutator.test.mjs`) |
| исходящий `DELETE /api/v1/cart/{cartLineId}` | `provider/http-client.ts`, kind `remove-cart-line` | только unit/integration тесты (`tests/aroma/provider-cart-mutator.test.mjs`) |
| `GET /health/live` | `packages/platform-runtime/src/index.ts` | только unit/integration тесты (`tests/runtime/lifecycle.test.mjs`) |
| `GET /health/ready` | `packages/platform-runtime/src/index.ts` | только unit/integration тесты (`tests/runtime/lifecycle.test.mjs`) |
| `GET /metrics` | `packages/platform-runtime/src/index.ts` | только unit/integration тесты (`tests/runtime/lifecycle.test.mjs`) |

`tests/runtime/lifecycle.test.mjs` проверяет регистратор runtime. Процесс `aroma-gateway` этот файл не запускает.

## События

Публикаций и потреблений в коде сервиса нет.
