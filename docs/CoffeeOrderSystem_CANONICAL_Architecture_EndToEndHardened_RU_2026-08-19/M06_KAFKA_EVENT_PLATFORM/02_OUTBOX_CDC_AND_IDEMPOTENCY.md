# M06. Transactional Outbox, CDC, Inbox и Idempotency

## 1. Стандарт publication

Если message связан с PostgreSQL state change:

```text
BEGIN
  update authoritative business state
  insert outbox row
COMMIT
```

Затем:

```text
PostgreSQL WAL
-> Debezium PostgreSQL connector
-> controlled Outbox Event Router/SMT
-> Kafka
```

## 2. Запрещённый dual-write

Нельзя:

```text
COMMIT DB
-> producer.send()
```

или:

```text
producer.send()
-> COMMIT DB
```

Оба варианта имеют failure window и нарушают atomic publication intent.

## 3. Outbox contract

Outbox хранит как минимум:

```text
message_id
message_kind
message_type
schema_version
destination
partition_key
occurred_or_requested_at_utc
aggregate/target metadata
aggregate_version when applicable
correlation_id
causation_id
traceparent
payload
```

`destination` определяется application code через approved mapping/enum из topic registry. Browser, LLM и provider input не могут выбирать Kafka topic.

## 4. Debezium scope

Debezium захватывает только approved outbox/heartbeat tables. Полный production contract — `08_DEBEZIUM_PRODUCTION_CONTRACT.md`.

## 5. Inbox

Side-effecting consumer:

```text
receive message
BEGIN
  insert inbox(messageId) if absent
  validate current state/version
  apply business effect
  insert local outbox messages if needed
COMMIT
commit safe Kafka offset
```

Если process падает после DB commit, но до Kafka offset commit, message будет повторён, а Inbox предотвращает повторный effect.

## 6. Idempotency

`platform/packages/idempotency` предоставляет общие primitives, но persistence и scope принадлежат owning bounded context.

Stable idempotency keys обязательны для:

- agent mutations;
- payment create/refund;
- provider webhook processing;
- side-effecting integration commands;
- unsafe retryable boundaries.

## 7. Idempotency не заменяет UnknownOutcome

Если external provider мог принять request, но response потерян:

```text
unknown result
-> authoritative provider lookup/reconciliation
-> только затем решение о retry
```

Нельзя создавать вторую payment/AROMA/provider mutation только потому, что transport timeout выглядел как failure.

## 8. Aggregate version

Lifecycle integration events публикуют authoritative aggregate version. Это помогает projection/replay guards, но не заменяет Inbox и eventId dedupe.

## 9. Delivery semantics

Kafka/Debezium chain проектируется как at-least-once. Effectively-once business behavior достигается application semantics, а не декларацией «Kafka exactly once».
