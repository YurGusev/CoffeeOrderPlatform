# orders-service

Владелец заказа. Контракт `packages/contracts/orders-v1`. Входящие пути собраны в
`apps/orders-service/src/http/index.ts` от базы `/api/client-v1/orders`.
Исходящие вызовы: `infrastructure/customer-client.ts` и `infrastructure/pricing-client.ts`.

В outbox этот процесс пишет два типа. Оба идут в `coffee.orders.lifecycle.v1`
из `infrastructure/database/order-store.ts`. Релей в `main.ts` берёт allowlist
`config/platform.yaml` `orders-service.kafka.producers`. Там ещё
`coffee.aroma.cart.commands.v1` и `coffee.realtime.invalidate.v1`.
`INSERT` этих типов в `apps/orders-service` нет. Их ставит в ту же таблицу
`orders.outbox_messages` процесс `orders-aroma-preparation`. Потребителей Kafka
у `orders-service` в конфиге нет.

## Операции

| Операция | Источник | Покрытие |
|---|---|---|
| `POST /api/client-v1/orders/drafts` | OpenAPI `createOrderDraft`; `http/index.ts` | только unit/integration тесты (`tests/orders/owner-http.test.mjs`) |
| `GET /api/client-v1/orders/:orderRef` | OpenAPI `getOrderCard`; `http/index.ts` | только unit/integration тесты (`tests/orders/owner-http.test.mjs`) |
| `PUT /api/client-v1/orders/:orderRef/items/:itemRef` | OpenAPI `upsertOrderItem`; `http/index.ts` | только unit/integration тесты (`tests/orders/owner-http.test.mjs`) |
| `DELETE /api/client-v1/orders/:orderRef/items/:itemRef` | OpenAPI `removeOrderItem`; `http/index.ts` | только unit/integration тесты (`tests/orders/owner-http.test.mjs`) |
| `POST /api/client-v1/orders/:orderRef/commands/confirm` | OpenAPI `confirmOrder`; `http/index.ts` | только unit/integration тесты (`tests/orders/owner-http.test.mjs`) |
| `POST /api/client-v1/orders/:orderRef/commands/request-aroma-reconciliation` | OpenAPI `requestAromaReconciliation`; `http/index.ts` | только unit/integration тесты (`tests/orders/owner-http.test.mjs`) |
| исходящий `GET /api/internal-v1/customers/{customerRef}/order-input` | OpenAPI `getCustomerOrderInput`; `customer-client.ts` | только unit/integration тесты (`tests/orders/upstream-clients.test.mjs`) |
| исходящий `POST /api/internal-v1/pricing/quotes:verify` | OpenAPI `verifyPricingQuote`; `pricing-client.ts` | только unit/integration тесты (`tests/orders/upstream-clients.test.mjs`) |
| `GET /health/live` | `packages/platform-runtime/src/index.ts` | только unit/integration тесты (`tests/runtime/lifecycle.test.mjs`) |
| `GET /health/ready` | `packages/platform-runtime/src/index.ts` | только unit/integration тесты (`tests/runtime/lifecycle.test.mjs`) |
| `GET /metrics` | `packages/platform-runtime/src/index.ts` | только unit/integration тесты (`tests/runtime/lifecycle.test.mjs`) |

`tests/orders/public-api.test.mjs` бьёт в `api-public`.
`tests/runtime/lifecycle.test.mjs` проверяет регистратор runtime и процесс `orders-service` не запускает.

## События

| Событие | Топик | Код | Покрытие |
|---|---|---|---|
| публикует `OrderConfirmed.v1` | `coffee.orders.lifecycle.v1` | `order-store.ts` | только unit/integration тесты (`tests/orders/order-store.test.mjs`) |
| публикует `OrderReconciliationRequested.v1` | `coffee.orders.lifecycle.v1` | `order-store.ts` | только unit/integration тесты (`tests/orders/reconciliation-live.test.mjs`) |

Потреблений в коде сервиса нет.
