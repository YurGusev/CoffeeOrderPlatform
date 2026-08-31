# M06. Kafka Event Backbone

## 1. Роль

Kafka — durable asynchronous backbone новой CoffeeOrderSystem architecture для integration events/commands, replay, fan-out, burst absorption и consumer scaling.

Kafka не заменяет PostgreSQL state machines, Inbox, idempotency, provider reconciliation или explicit business transactions.

## 2. Delivery model

Нормативная формула:

```text
transport delivery      = at least once
local business effect   = effectively once через Inbox/idempotency
external provider effect = idempotency + lookup/reconciliation + UnknownOutcome
```

Запрещено обещать end-to-end exactly-once для цепочки PostgreSQL + Kafka + Hermes + AROMA/PSP/VK.

## 3. Platform contracts

M06 состоит из четырёх слоёв гарантий:

```text
Cluster contract
  -> durability / KRaft / ACL / quotas

Topic contract
  -> kind / key / partitions / retention / replay

Message contract
  -> event/command envelope + payload schema

Consumer/CDC contract
  -> Outbox / Debezium / Inbox / offsets / replay / recovery
```

## 4. Canonical registry

Полный список streams хранится только в:

```text
kafka-topic-registry.yml
```

Документы не создают альтернативных topic catalogs.

## 5. Commands и events

Integration event — факт в прошедшем времени.

Integration command — просьба выполнить действие одному логическому owner.

Они имеют отдельные envelopes и не смешиваются в `command/event` topics.

## 6. Key/ordering

Kafka ordering гарантируется только внутри partition. Key выбирается по invariant:

```text
conversation -> ConversationKeyHash
order        -> OrderRef
payment      -> PaymentIntentRef
catalog      -> ProductRef / CoffeeWeightVariantRef по stream
invoice command -> InvoiceOperationRef
invoice event   -> ClientInvoiceRef
AROMA cart   -> ProfileName + CartKeyHash
```

Key semantics и partition count после production cutover являются versioned architecture contracts.

## 7. Backpressure

Consumer lag, oldest-event-age, partition skew и paused partitions — first-class signals. Unlimited in-memory Promise fan-out запрещён.

## 8. Retry

Операция имеет одного retry owner. Kafka transport retry не умножается на application/provider retry без explicit budget.

Long retry не держит partition через sleep; он сохраняется как durable process state и переиздаётся позже через scheduler/outbox.

## 9. DLQ/replay

DLQ разрешён только с operator recovery workflow. Blind automatic DLQ loop запрещён. Replay policy задаётся per consumer и особенно ограничивает external side effects.

## 10. DB-as-queue migration

Polling tables удаляются, если они были только transport queue. Таблицы business process state остаются в PostgreSQL.

## 11. Production gate

До production cutover должны быть приняты:

- `05_KAFKA_PRODUCTION_CLUSTER_CONTRACT.md`;
- `06_TOPIC_REGISTRY_PARTITIONS_RETENTION_AND_QUOTAS.md`;
- `07_EVENT_COMMAND_ENVELOPES_AND_SCHEMA_GOVERNANCE.md`;
- `08_DEBEZIUM_PRODUCTION_CONTRACT.md`;
- `09_REPLAY_DLQ_AND_CONSUMER_RECOVERY.md`;
- `10_KAFKA_DR_MONITORING_AND_OPERATIONS.md`.
