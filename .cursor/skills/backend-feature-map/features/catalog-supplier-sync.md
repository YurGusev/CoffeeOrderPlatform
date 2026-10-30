# catalog-supplier-sync

Почасовой импорт каталога. Входящих бизнес-маршрутов в `apps/catalog-supplier-sync/src` нет.
Исходящий вызов собирает `apps/catalog-supplier-sync/src/internal-api-client.ts`.
Расписание задаёт `hourly-scheduler.ts`, прогон делает `run-catalog-import.ts`.
В `main.ts` аргумент Kafka назван `_kafka` и не используется. В `config/platform.yaml`
у сервиса `kafka.producers` и `kafka.consumers` пустые.

## Операции

| Операция | Источник | Покрытие |
|---|---|---|
| исходящий `POST /api/internal-v1/aroma/catalog-exports` | OpenAPI `exportAromaCatalog`; `internal-api-client.ts` | только unit/integration тесты (`tests/catalog/stream.test.mjs`) |
| `GET /health/live` | `packages/platform-runtime/src/index.ts` | только unit/integration тесты (`tests/runtime/lifecycle.test.mjs`) |
| `GET /health/ready` | `packages/platform-runtime/src/index.ts` | только unit/integration тесты (`tests/runtime/lifecycle.test.mjs`) |
| `GET /metrics` | `packages/platform-runtime/src/index.ts` | только unit/integration тесты (`tests/runtime/lifecycle.test.mjs`) |

`tests/runtime/lifecycle.test.mjs` проверяет регистратор runtime. Процесс `catalog-supplier-sync` этот файл не запускает.

## События

Публикаций и потреблений в коде сервиса нет.
