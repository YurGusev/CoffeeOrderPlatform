# catalog-activation-worker

Активация снимка каталога и привязка offer. Входящих бизнес-маршрутов в
`apps/catalog-activation-worker/src` нет. Исходящий вызов собирает
`gateway-binding-client.ts`. Сообщения собирает `events.ts`. Релей outbox
вызывает `main.ts`. В `config/platform.yaml` потребители Kafka пустые, производители
`coffee.catalog.snapshot.v1` и `coffee.catalog.mapping.v2`.

## Операции

| Операция | Источник | Покрытие |
|---|---|---|
| исходящий `POST /api/internal-v1/aroma/offer-bindings` | OpenAPI `registerAromaOfferBinding`; `gateway-binding-client.ts` | только unit/integration тесты (`tests/catalog/activation-binding-client.test.mjs`) |
| `GET /health/live` | `packages/platform-runtime/src/index.ts` | только unit/integration тесты (`tests/runtime/lifecycle.test.mjs`) |
| `GET /health/ready` | `packages/platform-runtime/src/index.ts` | только unit/integration тесты (`tests/runtime/lifecycle.test.mjs`) |
| `GET /metrics` | `packages/platform-runtime/src/index.ts` | только unit/integration тесты (`tests/runtime/lifecycle.test.mjs`) |

`tests/runtime/lifecycle.test.mjs` проверяет регистратор runtime. Процесс воркера этот файл не запускает.

## События

Схемы лежат в `contracts/schemas/events/`. Строки манифеста
`contracts/manifest.yaml` называют этого воркера производителем обоих типов.
`consumers` у `CatalogSnapshotActivated.v1` в манифесте пустой. `kafka.bind` на
`coffee.catalog.snapshot.v1` в `apps/` нет.

| Событие | Топик | Код | Покрытие |
|---|---|---|---|
| публикует `CatalogSnapshotActivated.v1` | `coffee.catalog.snapshot.v1` | `events.ts` | только unit/integration тесты (`tests/catalog/activation-events.test.mjs`) |
| публикует `CatalogMappingChanged.v2` | `coffee.catalog.mapping.v2` | `events.ts` | только unit/integration тесты (`tests/catalog/activation-events.test.mjs`) |

Потреблений в коде сервиса нет.
