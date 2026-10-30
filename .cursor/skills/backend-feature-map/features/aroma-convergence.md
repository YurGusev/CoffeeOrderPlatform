# aroma-convergence

Сводит желаемую и наблюдаемую корзину. Входящих бизнес-маршрутов в
`apps/aroma-convergence/src` нет. Исходящие вызовы собирает `gateway-client.ts`.
Входящий конверт проверяет `application/messages.ts` на тип
`AromaConvergenceRequested.v1`. Исходящие типы пишет
`infrastructure/convergence-store.ts` в топик `coffee.aroma.cart.events.v1`.
Подписка и релей в `runtime-composition.ts`. Группа конфига `aroma-convergence-v1`
читает `coffee.aroma.cart.commands.v1`.

`config/platform.yaml` в `aroma-convergence.kafka.producers` перечисляет ещё
`coffee.realtime.invalidate.v1`. Строки с этим топиком код `aroma-convergence` не ставит.
`contracts/manifest.yaml` не называет `aroma-convergence` производителем
`RealtimeInvalidated.v1`.

## Операции

| Операция | Источник | Покрытие |
|---|---|---|
| исходящий `POST /api/internal-v1/aroma/cart-snapshots:read` | OpenAPI `readAromaCartSnapshot`; `gateway-client.ts` | только unit/integration тесты (`tests/aroma/safe-read-http.test.mjs`) |
| исходящий `GET /api/internal-v1/catalog/products/{productRef}/variants/{variantRef}/pricing-input` | OpenAPI `getCatalogPricingInput`; `gateway-client.ts` | только unit/integration тесты (`tests/aroma/worker-gateway-client.test.mjs`) |
| исходящий `POST /api/internal-v1/aroma/cart-lines/{offerRef}:set-quantity` | OpenAPI `setAromaCartLineQuantity`; `gateway-client.ts` | только unit/integration тесты (`tests/aroma/worker-gateway-client.test.mjs`) |
| исходящий `POST /api/internal-v1/aroma/cart-lines/{offerRef}:remove` | OpenAPI `removeAromaCartLine`; `gateway-client.ts` | только unit/integration тесты (`tests/aroma/worker-gateway-client.test.mjs`) |
| `GET /health/live` | `packages/platform-runtime/src/index.ts` | только unit/integration тесты (`tests/runtime/lifecycle.test.mjs`) |
| `GET /health/ready` | `packages/platform-runtime/src/index.ts` | только unit/integration тесты (`tests/runtime/lifecycle.test.mjs`) |
| `GET /metrics` | `packages/platform-runtime/src/index.ts` | только unit/integration тесты (`tests/runtime/lifecycle.test.mjs`) |

`tests/runtime/lifecycle.test.mjs` проверяет регистратор runtime. Процесс `aroma-convergence` этот файл не запускает.

## События

| Событие | Топик | Код | Покрытие |
|---|---|---|---|
| потребляет `AromaConvergenceRequested.v1` | `coffee.aroma.cart.commands.v1` | `messages.ts` | только unit/integration тесты (`tests/aroma/convergence-live.test.mjs`) |
| публикует `AromaObservationChanged.v1` | `coffee.aroma.cart.events.v1` | `convergence-store.ts` | только unit/integration тесты (`tests/aroma/convergence-live.test.mjs`) |
| публикует `AromaConvergenceChanged.v1` | `coffee.aroma.cart.events.v1` | `convergence-store.ts` | только unit/integration тесты (`tests/aroma/convergence-live.test.mjs`) |
