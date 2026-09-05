# События и восстановление

Исполнимые envelope/payload definitions семи launch messages находятся в
`contracts/schemas/{common,events}` и перечислены в `contracts/manifest.yaml`.
Kafka runtime валидирует их до Inbox/business effect; отдельной wire-схемы нет.

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

## PostgreSQL terminal outcome и idempotency (#62)

`withTransaction(database, {mode, signal, correlationId, causationId, traceparent},
callback)` — единственная transaction boundary. `callback` получает opaque
`Transaction`, не connection. Owner repository заранее определяет
параметризованные statements через `@coffee-platform/database/owner`.
После terminal state, при другом owner database или после cancellation они
отклоняются. Внутри callback нет HTTP/provider effects; #63 добавляет owner-local
Inbox/Outbox writes в тот же context.

| Наблюдение | State / результат | Connection / recovery |
|---|---|---|
| Ответный command tag `COMMIT` | `Committed`, вернуть callback result | Release; теперь допустим `acceptDurable()` |
| Callback/query failure до COMMIT, подтверждённый `ROLLBACK` | `RolledBack`, исходная typed failure | Release; новый запуск только по owner policy |
| Abort до COMMIT, подтверждённый `ROLLBACK` | `RolledBack`, `DB_INTERRUPTED` | Release; client timeout сам по себе не доказывает rollback |
| Потеря/blackhole ответа COMMIT или неизвестный command tag | `Unknown`, `TRANSACTION_OUTCOME_UNKNOWN` | Destroy; **никакого ROLLBACK и automatic retry** |
| Abort/failure и ROLLBACK без подтверждения | `Unknown`, `DB_ROLLBACK_FAILED` | Destroy; `previousCode` сохраняет безопасный код исходного отказа |
| Перехваченная SQL-ошибка и ответный tag `ROLLBACK` на COMMIT | `RolledBack`, `DB_TRANSACTION_ROLLED_BACK` | Нет acceptance/Replay; owner state и Completed откатились |
| Повторное использование context после terminal operation | `DB_INVALID_TRANSITION` | SQL не отправляется |

Production budgets: checkout `250ms`, transaction `10000ms`, каждый terminal
operation `2000ms`; interactive/background statement timeout `1500/5000ms`,
lock timeout `250ms`. Их сумма с двумя terminal operations меньше shutdown
`30000ms`. Request/shutdown signal действует до начала COMMIT; после начала
COMMIT ожидается только его собственный конечный budget. Broken/ambiguous
соединение никогда не возвращается пригодным в pool.

Нативные pending операции учитываются до фактического settlement. При закрытии
socket драйвер завершает pending I/O. Произвольный callback Promise может не
реагировать на abort: transaction вернёт управление, но DB resource останется
pending. Runtime #61 фиксирует `fail-stop` и завершает процесс с кодом 1;
это не обещание принудительной отмены произвольного JavaScript.

Acquired, owner mutation и terminal response/Completed записываются одной
транзакцией. Unique identity — `(actor_ref, scope, idempotency_key)`, где
`idempotency_key` хранит protocol field `key`. Повтор с тем же canonical SHA-256
возвращает только durable Completed response; другой hash — Conflict. Active
или expired Acquired остаётся InProgress. Истечение lease/retention не даёт
права повторить неизвестный эффект: owner recovery читает durable truth в новой
транзакции после reconnect/restart и отдельно принимает решение. Локального
кэша Completed и production InMemory store нет.

## Kafka/Inbox/Outbox foundation (#63)

Текущий transport API находится в `packages/platform-kafka-runtime/src/index.ts`.
Доступ к Kafka задаётся направленно в `services.<runtime>.kafka`:
`producers` содержит только разрешённые topic names, а `consumers` —
`{groupId, topics, processing}`. Legacy `mode`, `groups` и общий список topics
не являются частью API. Глобальные budgets находятся в `kafka.delivery` и не
переопределяются переменными окружения или service-local настройками.

Единственный общий envelope соответствует разделу 6 нормативного каталога:
`envelopeVersion: "1"`, `messageId`, `messageType`, `occurredAt`, `producer`,
`correlationId`, обязательный `causationId` (строка или `null`), `traceparent`,
`aggregate: {type, ref, version}` и generic `payload`. Foundation проверяет
общую структуру, а #4 поставляет schemas семи business payload и точные
форматы их refs/versions. Плоской альтернативной wire-формы нет. `KafkaRecord` добавляет
`topic`, неотрицательный `partition`, десятичный строковый `offset`, непустой
`key` и transport headers. `parseEnvelope` и `validateTransport` отвергают
неизвестные поля, control characters, неверное время, traceparent, offset или
несовпадающие headers. `Uint8Array` декодируется как UTF-8 с отказом при неверной последовательности байтов; строковое значение
должно быть JSON; object value сначала canonicalize-ится. Лимит размера
проверяется до вызова Inbox или owner handler.

`PartitionWorkers` держит один serial worker на assigned `topic:partition`.
`active` и очередь учитываются в общем `PartitionBudget`: `maxInFlight` ограничивает
одновременные owner operations, а `queueCapacity` — сумму queued и in-flight
records. Revoke/failure прекращает intake, очищает queued records и передаёт
ошибку recovery. Обычный revoke дожидается текущего handler, выполняет
`unassign` и принимает новый assignment на том же consumer; reconnect при
обычном rebalance не создаёт цикл смены members. Ошибка или unknown offset
использует закрытие и новый consumer. Это bounded transport гарантия, а не гарантия отмены произвольного
Promise owner handler.

Глобальный `kafka.delivery` задаёт следующие фиксированные bounds для каждого
runtime; значения не читаются из `.env` и не заменяются service-local defaults:

| Поле | Значение |
|---|---:|
| `producerRetries` | `3` |
| `maxMessageBytes` | `1048576` |
| `maxPartitions` на consumer group | `24` |
| `maxInFlight` | `4` |
| `queueCapacity` | `32` |
| `sendTimeoutMs` / `receiveTimeoutMs` | `2000` / `1000` |
| `commitTimeoutMs` | `2000` |
| `revokeTimeoutMs` / `shutdownTimeoutMs` | `2000` / `5000` |
| `leaseMs` | `30000` |
| `retry.baseMs` / `retry.maxMs` / `retry.maxAttempts` | `1000` / `60000` / `12` |
| `quarantine.durable` / `quarantine.realtime` | `owner-database` / `topic-dlq` |

Native producer использует `SASL_SSL`, `acks=all`, idempotence, один in-flight
request на connection и `message.send.max.retries=3`. Это bounded retry Kafka
transport; он не повторяет owner handler или unsafe provider effect. `send`
возвращает typed `KafkaSendAck` с topic/partition/offset, а неизвестный broker
result остаётся typed unknown.

### SQL contract delivery tables

Таблицы создаёт мигратор конкретной owner DB в owner schema. Runtime получает
только opaque `Transaction` из `withTransaction`; raw `pg` client и cross-owner
SQL запрещены. Текущие `SqlInboxStore` и `SqlOutboxStore` используют следующие
имена по умолчанию (`public` можно заменить явным `schema`/`table` в
owner repository):

```sql
CREATE TABLE <owner_schema>.inbox_messages (
  message_id text PRIMARY KEY,
  message_type text NOT NULL,
  received_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  state text NOT NULL CHECK (state IN ('Processing', 'Processed', 'Quarantined')),
  lease_owner text NOT NULL,
  lease_until timestamptz NOT NULL,
  attempt integer NOT NULL CHECK (attempt > 0),
  processed_at timestamptz,
  quarantine_reason text,
  quarantined_at timestamptz
);

CREATE TABLE <owner_schema>.inbox_quarantine (
  topic text NOT NULL,
  partition integer NOT NULL CHECK (partition >= 0),
  "offset" text NOT NULL,
  message_id text,
  message_type text,
  payload_hash text CHECK (payload_hash IS NULL OR payload_hash ~ '^[0-9a-f]{64}$'),
  envelope jsonb,
  reason text NOT NULL,
  quarantined_at timestamptz NOT NULL,
  PRIMARY KEY (topic, partition, "offset")
);

CREATE TABLE <owner_schema>.outbox_messages (
  message_id text PRIMARY KEY,
  message_type text NOT NULL,
  topic text NOT NULL,
  aggregate_ref text NOT NULL,
  aggregate_sequence bigint NOT NULL CHECK (aggregate_sequence > 0),
  owner_version text NOT NULL,
  partition_key text NOT NULL,
  schema_version text NOT NULL,
  envelope jsonb NOT NULL,
  payload jsonb NOT NULL,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  occurred_at timestamptz NOT NULL,
  correlation_id text NOT NULL,
  causation_id text,
  traceparent text,
  state text NOT NULL CHECK (state IN ('Pending', 'Publishing', 'Published', 'Quarantined')),
  lease_owner text NOT NULL,
  lease_token bigint NOT NULL CHECK (lease_token >= 0),
  lease_until timestamptz NOT NULL,
  attempt integer NOT NULL CHECK (attempt >= 0),
  next_attempt_at timestamptz NOT NULL,
  last_error text,
  published_at timestamptz,
  quarantined_at timestamptz,
  UNIQUE (aggregate_ref, aggregate_sequence)
);
```

`InboxStore.begin` вставляет `Processing` с lease и attempt `1`, возвращает
`duplicate` для `Processed`/`Quarantined`, `conflict` при другом canonical
`payload_hash`, а просроченный `Processing` переназначает с увеличением
attempt. Только владелец lease в той же transaction может вызвать `markProcessed`,
`quarantine` или `release`. `quarantineRecord` идемпотентен по
`(topic, partition, offset)` и сохраняет envelope/wire value (для oversized, неверного UTF-8
или не сериализуемого object value используется digest); raw payload не становится error
label.

`OutboxStore.enqueue` блокирует последнюю sequence данного `aggregate_ref`,
требует непрерывную `aggregate_sequence` с единицы и возвращает
`created`/`duplicate`/`conflict` по stable `message_id` и metadata. Relay
выбирает `Pending` либо expired `Publishing` через `FOR UPDATE SKIP LOCKED`,
но блокирует запись, если predecessor того же aggregate не `Published`.
Claim получает `lease_owner`, monotonic `lease_token`, lease и увеличенный
attempt. `finalize` переводит запись в `Published` только при совпадении lease
и token; известная permanent ошибка переводит в `Quarantined`, остальные — в
`Pending` с bounded exponential retry. Broker acknowledgement не заменяет
owner transaction и не является доказательством `Published` до finalize.

Stable identity сохраняется на всех этапах: producer передаёт caller-provided
`messageId`, relay повторно использует Outbox `message_id`, Inbox уникален по
`message_id`, quarantine — по `(topic, partition, offset)`, а Outbox — по
`message_id` и `(aggregate_ref, aggregate_sequence)`. Inbox
`payload_hash` вычисляется от canonical JSON envelope, переданного в
`consumeOnce`; Outbox `payload_hash` — от canonical JSON отправляемого envelope; его payload
обязан совпадать с отдельным `payload` row. Row `schema_version` соответствует
`envelopeVersion`, `aggregate_ref` — `aggregate.ref`, `owner_version` —
`aggregate.version`; `aggregate_sequence` остаётся отдельным непрерывным
delivery counter. Отсутствующий row `causation_id` соответствует wire `null`.
Relay берёт исходный `occurredAt`
из envelope: PostgreSQL `timestamptz` округляет до микросекунд и не должен
переписывать более точное wire timestamp.
Canonical JSON упорядочивает object keys, сохраняет порядок arrays и запрещает
не-JSON значения.

### Порядок offset и восстановление

Для durable consumer порядок исполнения такой:

1. Consumer poll передаёт record в assigned partition worker после проверки
   topic allowlist и bounded capacity.
2. Envelope и transport metadata декодируются до любого `Inbox.begin`.
   Невалидный record записывается в owner-local `inbox_quarantine` в отдельной
   известной transaction; после её COMMIT offset подтверждается. При ошибке
   quarantine transaction откатывается, offset остаётся неподтверждённым.
3. Валидный record вызывает `consumeOnce`: `Inbox.begin`, owner `handle`,
   owner state/Outbox writes и `markProcessed` идут в одной transaction.
   `duplicate` и `conflict` не запускают handler; conflict записывается в
   quarantine. Offset commit выполняется только после известного DB COMMIT.
4. Rollback, abort или `TransactionOutcomeUnknown` не подтверждают offset.
   Обработка может начаться снова после lease recovery; `Completed`/`Processed`
   duplicate не запускает effect повторно.
5. Неизвестный Kafka offset commit получает
   `OFFSET_COMMIT_OUTCOME_UNKNOWN`, останавливает affected worker, прекращает
   intake и запускает bounded close/revoke/reopen с новой assignment. Следующий
   unsafe record в том же worker не запускается; redelivery повторно проходит
   Inbox protocol.

Для единственного realtime исключения (`realtime-gateway`,
`coffee.realtime.invalidate.v1`, `realtime-gateway-v1`) DB/Inbox не вызываются:
validated envelope ставится в local ring/fanout, затем commit offset. Malformed
record сначала отправляется в `<topic>.dlq` с broker ack, затем commit offset.
Другой runtime/group/topic с `processing: realtime` — configuration error.
При revoke или shutdown сначала прекращается intake и boundedly завершается
текущий transaction/ack. Revoke снимает assignment на том же group member;
shutdown закрывает consumer/producer. Не cooperative
Promise не считается принудительно отменённым; окончательный исход передаётся
process-level fail-stop из #61.
