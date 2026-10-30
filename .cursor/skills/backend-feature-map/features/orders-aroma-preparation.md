# orders-aroma-preparation

Готовит желаемую корзину AROMA по заказу. Входящих бизнес-маршрутов в
`apps/orders-aroma-preparation/src` нет. Входящие конверты разбирает
`application/messages.ts`. Исходящие строки пишет
`infrastructure/preparation-store.ts`. Подписки и релей собирает
`runtime-composition.ts`. Группы из `config/platform.yaml`:
`orders-catalog-mapping-v2`, `orders-aroma-preparation-v1`,
`orders-aroma-projection-v1`. Производители конфига:
`coffee.aroma.cart.commands.v1` и `coffee.realtime.invalidate.v1`.

## Операции

| Операция | Источник | Покрытие |
|---|---|---|
| `GET /health/live` | `packages/platform-runtime/src/index.ts` | только unit/integration тесты (`tests/runtime/lifecycle.test.mjs`) |
| `GET /health/ready` | `packages/platform-runtime/src/index.ts` | только unit/integration тесты (`tests/runtime/lifecycle.test.mjs`) |
| `GET /metrics` | `packages/platform-runtime/src/index.ts` | только unit/integration тесты (`tests/runtime/lifecycle.test.mjs`) |

`tests/runtime/lifecycle.test.mjs` проверяет регистратор runtime. Процесс подготовки этот файл не запускает.

## События

| Событие | Топик | Код | Покрытие |
|---|---|---|---|
| потребляет `CatalogMappingChanged.v2` | `coffee.catalog.mapping.v2` | `messages.ts` | только unit/integration тесты (`tests/orders/aroma-preparation-live.test.mjs`) |
| потребляет `OrderConfirmed.v1` | `coffee.orders.lifecycle.v1` | `messages.ts` | только unit/integration тесты (`tests/orders/aroma-preparation-live.test.mjs`) |
| потребляет `OrderReconciliationRequested.v1` | `coffee.orders.lifecycle.v1` | `messages.ts` | только unit/integration тесты (`tests/orders/aroma-preparation-live.test.mjs`) |
| потребляет `AromaObservationChanged.v1` | `coffee.aroma.cart.events.v1` | `messages.ts` | только unit/integration тесты (`tests/orders/aroma-preparation-live.test.mjs`) |
| потребляет `AromaConvergenceChanged.v1` | `coffee.aroma.cart.events.v1` | `messages.ts` | только unit/integration тесты (`tests/orders/aroma-preparation-live.test.mjs`) |
| публикует `AromaConvergenceRequested.v1` | `coffee.aroma.cart.commands.v1` | `preparation-store.ts` | только unit/integration тесты (`tests/orders/aroma-preparation-live.test.mjs`) |
| публикует `RealtimeInvalidated.v1` | `coffee.realtime.invalidate.v1` | `preparation-store.ts` | только unit/integration тесты (`tests/orders/aroma-preparation-live.test.mjs`) |

Декодер `CatalogMappingChanged.v2` этот файл вызывает без дополнительной переменной окружения. Проход остальных типов через Inbox и публикацию outbox тот же файл делает внутри `fixture`. Эти тесты пропускаются, пока нет `COFFEE_DB_LIVE_PROOF=1`.
