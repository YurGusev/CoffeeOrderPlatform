---
name: next-kafka-event-platform
description: "Use for Kafka cluster/topic contracts, keys/partitions, producers/consumers, Outbox/Debezium CDC, Inbox/idempotency, schemas, replay/DLQ, DR, quotas, retention, ordering and backpressure in the new CoffeeOrderSystem architecture."
---

# Kafka Event Platform

## Source of truth

Каноническая программа: `M06_KAFKA_EVENT_PLATFORM`.

Перед изменением прочитать `M06/README.md` и релевантные `05..10` hardening contracts. Topic list всегда брать из `kafka-topic-registry.yml`, не из старого Markdown/legacy code.

Если skill противоречит M06 — побеждает M06, skill обновляется.

## Scope

Только target architecture:

```text
platform/**
infra/kafka/**
infra/debezium/**
infra/connect/**
hermes/** when Kafka boundary changes
```

`src/**` — только legacy behavior/parity evidence.

## Use when

- Kafka cluster/topology/config;
- topic/key/partition/retention/quota;
- event/command schema;
- producer/consumer;
- Outbox/Debezium/Inbox;
- replay/DLQ/recovery;
- Kafka DR/monitoring;
- KEDA consumer scaling.

## Classification before edits

Записать:

```text
Message kind: event | command
Owner:
Topic:
Key:
Ordering invariant:
Retention class:
Durability class:
PII class:
Replay class:
DR class:
Producer(s):
Consumer group(s):
Schema paths:
External side effect: yes/no
```

## Hard rules — platform

- Production critical Kafka = KRaft, separate controller/broker roles or managed equivalent.
- Critical streams = RF3/minISR2 + producer `acks=all` + idempotence.
- `auto.create.topics.enable=false`; clients also disable auto topic creation.
- Topic creation/config/ACL/quota = IaC/registry, не application side effect.
- Stable workload-specific `client.id`/principal; generic shared Kafka credential запрещён.

## Hard rules — topics

- Единственный topic source of truth — `kafka-topic-registry.yml`.
- Event и command не смешивать в одном ambiguous stream.
- Key выбирается по ordering invariant.
- Production partition count выбирается capacity test **до cutover**.
- Active keyed topic partition count нельзя менять автоматически из-за lag/KEDA.
- Изменение key/partition strategy может требовать new topic major.
- Retention задаётся class-specific, не одним global default.
- Large files/transcripts не перевозить Kafka; application message baseline <= 256 KiB без ADR.

## Hard rules — schemas

- Integration event и integration command имеют разные envelopes.
- Envelope + exact payload JSON Schema обязательны.
- Lifecycle events публикуют `aggregateVersion` where applicable.
- Side-effecting commands имеют stable `idempotencyKey` и expiry/deadline policy.
- Git schemas = source of truth; runtime Schema Registry не auto-register'ит arbitrary prod schema из request path.
- Breaking key/money/identity/event-vs-command semantics не masquerade как additive schema change.

## Hard rules — publication/consumption

- Transaction-bound publication: business state + Outbox one DB transaction -> WAL/Debezium -> Kafka.
- Запрещён `DB commit -> producer.send()` для domain transition.
- Delivery semantics = at-least-once transport + effectively-once business effects.
- Side-effect consumer = schema validation -> Inbox/current-state guard -> business transaction -> safe offset commit.
- Durable consumer: `enable.auto.commit=false`, `allow.auto.create.topics=false`, `auto.offset.reset=none`.
- Realtime ephemeral consumer может использовать `latest` и unique group per replica.
- Shared `platform/packages/kafka-runtime` владеет offsets/rebalance/pause/retry lifecycle.
- `maxCompletedAheadGap`/bounded in-flight обязательны; не копить unlimited later offsets.

## Hard rules — retry/replay/DLQ

- Один retry owner.
- Long retry хранится как durable process state; Kafka consumer не sleep'ит минуты.
- Replay policy per consumer: projection / business DB / provider side effect.
- External provider side effect не blind-replay.
- Original `eventId`/`commandId` сохраняется при replay.
- DLQ не auto-loop'ится в source; нужен inspect/approve/replay workflow.

## Hard rules — Debezium

- Capture только approved outbox/heartbeat tables.
- Unique connector/slot/publication per physical DB source/connector.
- Snapshot policy explicit; не полагаться на default.
- Heartbeat/WAL retention/queue utilization — production SLI.
- Bounded queue, `max.queue.size > max.batch.size` и byte budget.
- Не пытаться масштабировать PostgreSQL connector через `tasks.max`.

## Hard rules — DR/operations

- RF3/minISR2 != cross-cluster DR.
- MirrorMaker2/managed equivalent — async DR и не означает RPO=0.
- ACKed external ingress имеет явный RPO requirement.
- Quotas защищают interactive traffic от replay/background load.
- Наблюдать broker ISR/offline/minISR, partition skew, consumer age/lag, rebalances, Debezium WAL/heartbeat, quotas.

## Workflow

1. Классифицировать message/topic/consumer.
2. Обновить canonical registry/schema first.
3. Проверить partition/capacity/replay/DR implications.
4. Реализовать publication/consumer через shared runtime.
5. Добавить duplicate/crash/rebalance/schema/failure tests.
6. Добавить monitoring/runbook.
7. Прогнать M16 registry/schema/IaC gates.
8. Не делать cutover без M15 recovery evidence.

## Required verification

Минимум:

1. YAML/JSON Schema validation;
2. topic registry unique/completeness check;
3. compatibility test;
4. producer/consumer integration test;
5. duplicate Inbox test;
6. crash-after-DB-commit-before-offset test;
7. rebalance/SIGTERM drain test;
8. invalid schema/poison record test;
9. replay/DLQ test for changed consumer;
10. Debezium restart/WAL test if CDC changed;
11. broker/minISR/DR drill if platform durability changed;
12. load/partition skew test if topology/capacity changed.

## Coordination

- Node implementation: `next-nodejs-runtime`.
- API/schema governance: `next-api-architecture`.
- K8s/KEDA: `next-kubernetes-microservices`.
- SLO/DR: `next-reliability-operations`.
- CI/IaC: `next-cicd-supply-chain`.
- Migration/cutover: `next-verification-and-parity`.


## BusinessLogicHardened service graph

Если задача меняет Orders/Catalog/AROMA/Invoices/Payments interaction, дополнительно активировать `next-business-orchestration` и проверить M20. Target не имеет direct Draft `sendToAromaCart`; `Confirm -> Desired -> Convergence` является нормальным supplier path.

## End-to-end closure hard rules

- Every canonical topic has explicit productionPartitions and >=1 exact payload schema.
- Every declared payload schema has message-type registry entry and valid fixture.
- Every consumer group maps to runtime workload (except explicit ephemeral-per-replica special case).
- User/channel/agent text topics are possible-PII, not opaque-ref-only.
- UInt64/Int64 business versions are decimal strings on JSON wire.
- Catalog availability/mapping streams are critical durability.
