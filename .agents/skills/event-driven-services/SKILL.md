---
name: event-driven-services
description: Менять Kafka-сообщения, Outbox/Inbox и replay.
---

# Событийные сервисы

PostgreSQL — источник истины; Kafka — долговечное перемещение. Транспорт работает
at-least-once, а бизнес-эффекты — effectively-once через Inbox/idempotency/state guards.

Для сообщения фиксировать kind, owner, topic, key, ordering, producer, consumer
group, schema, PII, retention, владельца retry, replay class, deadline и side effect.

- Business state and Outbox are one local transaction.
- Separate command/event envelopes and validate exact payload schemas.
- Disable auto topic creation/commit; commit after durable processing.
- Preserve IDs in retry/replay and reject stale owner versions.
- Long retry is durable state; provider effects are not blind-replayed.
- Large files use ArtifactRef; DLQ requires inspect/approve/replay.

Проверять дубликаты, crash, invalid/out-of-order messages, rebalance, retry,
replay и восстановление побочных эффектов.
