# ADR-0005: Transactional Outbox + Debezium + Kafka

**Status:** Accepted target

Событие, связанное с business DB change, создаётся outbox row в той же PostgreSQL transaction. Debezium/Kafka Connect публикует его в Kafka. `DB commit -> kafka.send()` как application dual-write запрещён.
