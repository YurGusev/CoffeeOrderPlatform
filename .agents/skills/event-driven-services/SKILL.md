---
name: event-driven-services
description: Проектировать или реализовывать Kafka-команды/события, schemas, Outbox, Inbox, ordering, retries, replay, DLQ и восстановление consumers в CoffeeOrderPlatform.
---

# Событийные сервисы

PostgreSQL — источник истины; Kafka — долговечное перемещение. Транспорт работает
at-least-once, а бизнес-эффекты — effectively-once через Inbox/idempotency/state guards.

Confluent client существует только внутри `platform-kafka-runtime`; application
code получает typed Effect services/streams. Конфигурация каждого runtime явно
разделяет `kafka.producers` и `kafka.consumers`; общий `mode` запрещён. Durable
Outbox, Inbox и idempotency хранятся только в PostgreSQL. Общие production или
testing `InMemory*Store` запрещены; узкий stub объявляется внутри конкретного test.
До `#4` transport proof использует test-local Effect Schema; пустой
`contracts-events-v1` не создаётся.

Для сообщения фиксировать kind, owner, topic, key, ordering, producer, consumer
group, schema, PII, retention, владельца retry, replay class, deadline и side effect.

- Business state and Outbox are one local Effect SQL transaction.
- Separate command/event envelopes and validate payloads Effect Schema.
- Disable auto topic creation/commit; commit after durable processing.
- Commit offset only after durable transaction outcome is known; unknown commit
  outcome blocks acknowledgement and enters recovery.
- Preserve IDs in retry/replay and reject stale owner versions.
- Long retry is durable state; provider effects are not blind-replayed.
- Large files use ArtifactRef; DLQ requires inspect/approve/replay.

Проверять дубликаты, crash, invalid/out-of-order messages, rebalance, retry,
replay и восстановление побочных эффектов.
