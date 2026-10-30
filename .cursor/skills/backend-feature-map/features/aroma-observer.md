# aroma-observer

Снимает наблюдаемую корзину. Входящих бизнес-маршрутов в `apps/aroma-observer/src` нет.
Исходящее чтение собирает `gateway-client.ts`. Событие пишет
`infrastructure/observation-store.ts`. Релей вызывает `runtime-composition.ts`.
В `config/platform.yaml` производитель `coffee.aroma.cart.events.v1`, потребители пустые.

## Операции

| Операция | Источник | Покрытие |
|---|---|---|
| исходящий `POST /api/internal-v1/aroma/cart-snapshots:read` | OpenAPI `readAromaCartSnapshot`; `gateway-client.ts` | только unit/integration тесты (`tests/aroma/safe-read-http.test.mjs`) |
| `GET /health/live` | `packages/platform-runtime/src/index.ts` | только unit/integration тесты (`tests/runtime/lifecycle.test.mjs`) |
| `GET /health/ready` | `packages/platform-runtime/src/index.ts` | только unit/integration тесты (`tests/runtime/lifecycle.test.mjs`) |
| `GET /metrics` | `packages/platform-runtime/src/index.ts` | только unit/integration тесты (`tests/runtime/lifecycle.test.mjs`) |

`tests/runtime/lifecycle.test.mjs` проверяет регистратор runtime. Процесс `aroma-observer` этот файл не запускает.

## События

| Событие | Топик | Код | Покрытие |
|---|---|---|---|
| публикует `AromaObservationChanged.v1` | `coffee.aroma.cart.events.v1` | `observation-store.ts` | только unit/integration тесты (`tests/aroma/observer-live.test.mjs`) |

Потреблений в коде сервиса нет.
