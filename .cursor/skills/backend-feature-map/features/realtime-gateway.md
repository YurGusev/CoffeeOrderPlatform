# realtime-gateway

Поток инвалидаций заказа. Контракт операции `GET /events` в
`contracts/openapi/client-v1.yaml`, `operationId` `streamOrderInvalidations`.
Пакет `packages/contracts/realtime-v1` указывает тот же OpenAPI и реэкспортирует
типы SSE из generated client-v1. Маршрут регистрирует
`apps/realtime-gateway/src/runtime-composition.ts`. Топик и группа заданы в
`contract.ts`: `coffee.realtime.invalidate.v1`, группа `realtime-gateway-v1`.
Схема конверта `contracts/schemas/events/realtime-invalidated.v1.schema.json`.
В `config/platform.yaml` производители пустые, потребитель один, обработка `realtime`.

## Операции

| Операция | Источник | Покрытие |
|---|---|---|
| `GET /events` | OpenAPI `streamOrderInvalidations`; `runtime-composition.ts` | только unit/integration тесты (`tests/realtime/auth.test.mjs`) |
| `GET /health/live` | `packages/platform-runtime/src/index.ts` | только unit/integration тесты (`tests/runtime/lifecycle.test.mjs`) |
| `GET /health/ready` | `packages/platform-runtime/src/index.ts` | только unit/integration тесты (`tests/runtime/lifecycle.test.mjs`) |
| `GET /metrics` | `packages/platform-runtime/src/index.ts` | только unit/integration тесты (`tests/runtime/lifecycle.test.mjs`) |

`tests/runtime/lifecycle.test.mjs` проверяет регистратор runtime. Процесс `realtime-gateway` этот файл не запускает.

## События

| Событие | Топик | Код | Покрытие |
|---|---|---|---|
| потребляет `RealtimeInvalidated.v1` | `coffee.realtime.invalidate.v1` | `contract.ts` | только unit/integration тесты (`tests/realtime/contract.test.mjs`) |

Публикаций в коде сервиса нет.
