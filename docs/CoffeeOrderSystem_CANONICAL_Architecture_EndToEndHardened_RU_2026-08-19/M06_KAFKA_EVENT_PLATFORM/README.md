# M06 — Kafka / Event Platform

## Цель

Ввести Kafka как durable asynchronous backbone с production-grade cluster contract, единым Topic Registry, separate event/command contracts, Transactional Outbox + Debezium, Inbox/idempotency, управляемым replay/DLQ и доказуемым DR/observability.

## Зависимости

M04, M05, M02, M15, M16, M19.

## Нормативные документы программы

1. `01_KAFKA_EVENT_BACKBONE.md` — роль Kafka и end-to-end semantics;
2. `02_OUTBOX_CDC_AND_IDEMPOTENCY.md` — PostgreSQL publication/Inbox;
3. `03_EVENT_MODEL_TOPICS_AND_KEYS.md` — message taxonomy и keys;
4. `04_NODEJS_KAFKA_RUNTIME.md` — Node producer/consumer runtime;
5. `05_KAFKA_PRODUCTION_CLUSTER_CONTRACT.md` — KRaft/durability/security baseline;
6. `06_TOPIC_REGISTRY_PARTITIONS_RETENTION_AND_QUOTAS.md` — topics/partitions/retention/quotas;
7. `07_EVENT_COMMAND_ENVELOPES_AND_SCHEMA_GOVERNANCE.md` — separate envelopes/payload schemas;
8. `08_DEBEZIUM_PRODUCTION_CONTRACT.md` — slots/snapshot/heartbeat/WAL/backpressure;
9. `09_REPLAY_DLQ_AND_CONSUMER_RECOVERY.md` — replay/retry/DLQ/offset recovery;
10. `10_KAFKA_DR_MONITORING_AND_OPERATIONS.md` — RPO/RTO/MM2/metrics/runbooks;
11. `kafka-topic-registry.yml` — единственный canonical topic registry;
12. `integration-event-envelope.schema.json`;
13. `integration-command-envelope.schema.json`;
14. `payload-schemas/**` — message-specific payload schemas;
15. `message-schema-registry.yml` — MessageType → topic/schema/compatibility;
16. `fixtures/valid/**` — positive schema fixtures for CI;
17. `SOURCES.md` — official source index.

## Hard invariants

- PostgreSQL = authoritative business state; Kafka = asynchronous movement/log.
- Delivery = at-least-once; business effects = effectively-once через Inbox/idempotency/current-state guards.
- Event и command не смешиваются в одном ambiguous stream.
- Topic/key/production partition count/retention/replay являются versioned architecture contracts.
- Critical production streams используют RF3/minISR2 + `acks=all`/idempotent producer или managed-equivalent гарантию.
- Automatic topic creation запрещено.
- Business consumer не использует auto-commit и не делает implicit offset reset.
- Transaction-bound publication идёт через Outbox + WAL + Debezium, не `commit -> send`.
- External side effects не blind-replay.
- Debezium slot/WAL/heartbeat state является production SLI.
- Kafka DR имеет explicit RPO/RTO; MirrorMaker2 не трактуется как RPO=0.

## Definition of Done программы

Программа считается принятой, когда:

1. production cluster contract проверен failure drill;
2. topic registry — единственный source of truth и применён через IaC;
3. production partition counts выбраны capacity test и зафиксированы;
4. event/command envelopes и payload schemas валидируются CI/runtime;
5. Node Kafka client compatibility spike принят;
6. shared `platform/packages/kafka-runtime` реализован;
7. Outbox/Debezium/Inbox duplicate/restart tests пройдены;
8. Debezium snapshot/slot/heartbeat/WAL alarms доказаны;
9. replay policies описаны per consumer;
10. DLQ имеет operator recovery path;
11. Kafka/Connect/Schema/DR monitoring и runbooks приняты;
12. recovery/rebalance/broker/connector failure drills пройдены.

## Agent skills новой архитектуры

Основной skill: `next-kafka-event-platform`.

Для cluster/DR/metrics: `next-reliability-operations`.

Для Node producer/consumer implementation: `next-nodejs-runtime`.

Для event APIs/schema: `next-api-architecture`.

Для CI/IaC topic/schema gates: `next-cicd-supply-chain`.

Для significant migration/cutover: `next-verification-and-parity`.


## Business orchestration

M20 defines owner-to-owner service graph. Kafka topics do not grant business ownership. In particular:

- confirmation emits local durable preparation work;
- Catalog mapping resolution is an explicit Catalog-owned command/fact cycle;
- AROMA convergence command is only a wake-up/versioned intent, not an unsafe provider request;
- invoice creation is triggered by immutable checkout/wholesale command, not `OrderConfirmed`;
- payment completion returns as verified Payments event.

## Catalog streams

Catalog uses separate `coffee.catalog.products.v1`, `coffee.catalog.availability.v1` and `coffee.catalog.mapping.v1` facts. Product price events never authorize implicit Orders reprice; availability/mapping may change Desired only through Orders consumers.


## Semantic completeness

Canonical CI must fail when any of the following occurs:

- topic has null/non-positive production partition count;
- topic has no payload schema;
- payload schema is absent from `message-schema-registry.yml`;
- message-specific valid fixture does not validate;
- durable consumer group has zero or multiple runtime-role bindings;
- a removed/deferred topic is referenced by canonical examples;
- non-realtime domain topic declares `realtime-*` consumer group;
- JSON wire uses unbounded `integer` for BIGINT/UInt64 version/revision/epoch/sequence.

Current baseline intentionally has **no separate Catalog indexing command/event topics**. `catalog-search-indexer` consumes `coffee.catalog.products.v1`.
