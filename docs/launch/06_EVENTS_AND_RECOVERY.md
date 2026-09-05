# События и восстановление

## Контракты первого запуска

Точные envelope и payload schemas семи сообщений определены в
[нормативном каталоге контрактов](12_LAUNCH_CONTRACT_CATALOG.md). Дополнительные
launch-сообщения нельзя вводить без изменения каталога и ADR.

| Сообщение | Вид | Producer | Consumer | Ключ |
|---|---|---|---|---|
| `CatalogSnapshotActivated` | event | catalog-activation-worker | production consumer отсутствует | supplierRef |
| `CatalogMappingChanged` | event | catalog-activation-worker | orders-aroma-preparation | productRef |
| `OrderConfirmed` | event | orders-service | orders-aroma-preparation | orderRef |
| `AromaConvergenceRequested` | command | Orders preparation/service | aroma-convergence | cartScopeRef |
| `AromaObservationChanged` | event | aroma-observer/convergence | Orders projections | cartScopeRef |
| `AromaConvergenceChanged` | event | aroma-convergence | orders-aroma-preparation | cartScopeRef |
| `RealtimeInvalidated` | event | owners | realtime-gateway | subjectRef |

Every contract has versioned JSON Schema, `messageId`, `occurredAt`, trace,
causation, correlation and owner-defined aggregate version where applicable.

## Kafka registry первого запуска

| Message | Topic | Partitions / retention | Consumer group |
|---|---|---|---|
| `CatalogSnapshotActivated.v1` | `coffee.catalog.snapshot.v1` | 12 / 2160h | none; owner/audit fact retained |
| `CatalogMappingChanged.v2` | `coffee.catalog.mapping.v2` | 12 / 2160h | `orders-catalog-mapping-v2` |
| `OrderConfirmed.v1` | `coffee.orders.lifecycle.v1` | 12 / 2160h | `orders-aroma-preparation-v1` |
| `AromaConvergenceRequested.v1` | `coffee.aroma.cart.commands.v1` | 24 / 168h | `aroma-convergence-v1` |
| `AromaObservationChanged.v1` | `coffee.aroma.cart.events.v1` | 24 / 720h | `orders-aroma-projection-v1` |
| `AromaConvergenceChanged.v1` | `coffee.aroma.cart.events.v1` | 24 / 720h | `orders-aroma-projection-v1` |
| `RealtimeInvalidated.v1` | `coffee.realtime.invalidate.v1` | 24 / 1h | `realtime-gateway-v1` (один instance) |

Topic creation выполняет только #3. Key берётся из таблицы контрактов выше;
ordering гарантируется только внутри key. Для каждого topic создаётся
`<topic>.dlq`, invalid schema отправляется туда один раз с original envelope и
sanitized validation result. Business retry выполняется через Inbox/durable
state, не через бесконечный Kafka redelivery. Первый запуск использует один realtime instance. Несколько replicas требуют
отдельного решения с fan-out каждому instance; общий group распределяет сообщения
между replicas и не обеспечивает доставку всем SSE connections.

## Семантика доставки

- business state and Outbox are written in one owner transaction;
- transport is at-least-once;
- consumers validate schema before Inbox/business effects;
- Inbox + current-state guard provides effectively-once business behavior;
- offsets commit only after durable processing;
- out-of-order events cannot roll back newer owner versions.

## Политика повторов

- transient safe reads: bounded exponential retry with deadline;
- invalid schema: quarantine/DLQ, no retry loop;
- unsafe AROMA mutation: no transport retry; reconcile from reservation + GET;
- long delay: durable scheduled state, never consumer sleep;
- replay preserves original message and operation IDs.

## Обязательные тесты отказов

1. duplicate `OrderConfirmed`;
2. crash after DB commit before Kafka offset;
3. stale/out-of-order Catalog mapping;
4. lease expiry during convergence;
5. stale fence trying to persist success;
6. provider accepted mutation but response was lost;
7. failed verification GET;
8. service restart with unfinished MutationReservation;

## Request cancellation и durable acceptance (#61)

До known durable commit owner передаёт `request.runtimeContext.signal`
поддерживаемым HTTP/DB операциям и scoped children. Разрыв input либо response
connection и deadline отменяют эту request operation. Normal response finish
снимает таймер, не отменяя handler. Произвольный Promise не получает гарантию
принудительной отмены.

После подтверждённого durable commit owner вызывает
`request.runtimeContext.acceptDurable()`. Последующий disconnect не отменяет
его signal; remaining request deadline и конечный shutdown budget сохраняются.
Эта отметка не совершает commit, не хранит idempotency и не отменяет уже
произошедший abort. Её нельзя ставить до COMMIT или при неизвестном исходе I/O.
Завершение HTTP transport не меняет принятый intent и не запускает повтор эффекта.

При потерянном ответе client повторяет команду с тем же idempotency key, а owner
возвращает durable result или восстанавливает неизвестный исход. Реализацию
`TransactionOutcomeUnknown`, canonical hash/replay и owner transaction поставляет
#62; атомарные Inbox/Outbox и offset ordering — #63. Runtime #61 не выполняет
blind retry, compensation или повторный provider вызов.

Lifecycle fixture с owner ledger проверяет только границу disconnect/acceptance
и отсутствие повторного вызова fake effect. Это не доказательство durability
после restart: такой admission требует PostgreSQL/Kafka handoffs #62/#63.
