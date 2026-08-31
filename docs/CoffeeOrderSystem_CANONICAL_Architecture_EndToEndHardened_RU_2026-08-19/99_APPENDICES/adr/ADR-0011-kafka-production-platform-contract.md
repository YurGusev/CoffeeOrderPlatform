# ADR-0011: Kafka Production Platform Contract

**Status:** Accepted target

## Decision

Kafka используется как at-least-once durable asynchronous backbone. Production critical deployment использует KRaft с separate controller/broker roles или managed equivalent, critical topic durability profile RF3/minISR2, `acks=all` и producer idempotence.

Canonical stream topology хранится в `M06/kafka-topic-registry.yml`; application auto-topic creation запрещён. Event и command используют разные topics/envelopes. Key и production partition topology считаются versioned architecture contracts после cutover.

Transactional domain publication выполняется через PostgreSQL Outbox + Debezium. Consumer local effects защищены Inbox/idempotency. External/provider side effects не blind-replay.

Cluster-local replication не считается disaster recovery. Cross-cluster RPO/RTO решается отдельно; asynchronous MirrorMaker2/managed replication не объявляется RPO=0.
