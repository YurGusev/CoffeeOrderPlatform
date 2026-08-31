# M06. Debezium Production Contract

## 1. Роль

Debezium/Kafka Connect реализует надёжный transport между PostgreSQL Outbox и Kafka:

```text
business transaction
-> PostgreSQL Outbox
-> WAL
-> Debezium PostgreSQL connector
-> Kafka
```

Debezium не получает право читать/публиковать arbitrary business tables только потому, что технически может.

## 2. Capture scope

Connector захватывает только утверждённые outbox tables и heartbeat table, необходимые конкретному physical database source.

Design-stage:

```text
orders.outbox
catalog.outbox
payments.outbox
...
```

Если bounded contexts находятся в одном physical PostgreSQL database, допускается один connector, захватывающий набор approved outbox tables. При разделении на разные physical DB используется connector/slot/publication на каждый DB source.

## 3. Replication slot/publication ownership

Каждый PostgreSQL connector имеет уникальные:

```text
slot.name
publication.name
connector.name
```

Один replication slot нельзя делить между независимыми connector instances.

Slot/publication являются IaC-managed resources и входят в DR/runbook.

## 4. Outbox row contract

Рекомендуемый минимальный row contract:

```text
message_id UUID
message_kind event|command
message_type
schema_version
destination
partition_key
occurred_or_requested_at_utc
aggregate_type/target_type
aggregate_id/target_id
aggregate_version nullable
correlation_id
causation_id
traceparent
payload JSONB
```

`destination` выбирается application code только из approved topic registry enum/mapping. Нельзя принимать destination/topic от browser/LLM/provider payload.

## 5. Outbox Event Router

Debezium Outbox Event Router/эквивалентный controlled SMT может использоваться для routing и envelope transformation.

Routing configuration является version-controlled infrastructure. Нельзя строить arbitrary topic name из untrusted payload.

## 6. Snapshot policy

Каждый connector rollout явно фиксирует:

```text
snapshot.mode
slot creation point
publication state
expected historical outbox rows
cutover timestamp/LSN evidence
```

Нельзя полагаться на неявный default snapshot behavior.

Если historical outbox replay не нужен, rollout использует controlled no-data/streaming strategy только после доказательства, что нужная позиция ещё доступна в WAL/slot. Если historical outbox нужен — snapshot/replay выполняется осознанно и проходит idempotency/replay gates.

## 7. Heartbeat и WAL retention

`connector_running=true` недостаточно.

Для low-traffic captured DB включается heartbeat policy, чтобы replication slot мог продвигать acknowledged LSN и PostgreSQL не удерживал WAL бесконечно.

Обязательные metrics/alerts:

```text
replication slot confirmed/restart LSN
retained WAL bytes/age
heartbeat age
connector source lag
connector queue usage
connector error/restart count
```

WAL retention alarm — P0. Потеря disk из-за stalled replication slot является production incident.

## 8. Queue/backpressure

Debezium queue обязана быть bounded:

```text
max.queue.size > max.batch.size
max.queue.size.in.bytes > 0  # production budget, selected by load test
```

Точное значение определяется capacity test. Queue должна давать backpressure, а не превращаться в неограниченный memory buffer.

## 9. `tasks.max` misconception

PostgreSQL Debezium connector работает как одна source task на connector. Нельзя «ускорить» один PostgreSQL WAL stream увеличением `tasks.max`.

Если CDC становится bottleneck, рассматриваются:

- уменьшение payload;
- Kafka/Connect throughput tuning;
- physical DB/bounded-context separation;
- отдельные connectors на разные DB sources;
- измеренное изменение topology.

## 10. Delivery semantics

Debezium может повторно emit records после restart/recovery. Downstream consumer обязан иметь Inbox/idempotency.

Нельзя строить assumption:

```text
Debezium emitted exactly once
-> Inbox не нужен
```

## 11. Connect internal topics

Kafka Connect internal config/offset/status topics должны иметь production replication/durability profile и входить в backup/DR/recovery reasoning.

## 12. Failure tests

Обязательные сценарии:

1. Kafka unavailable while PostgreSQL continues commits;
2. Debezium process restart after reading before Kafka publish acknowledgement;
3. connector restart with pending queue;
4. replication slot inactivity/WAL growth;
5. schema change in outbox table;
6. Kafka Connect worker rebalance/restart;
7. PostgreSQL primary failover/recovery procedure;
8. duplicate CDC delivery downstream.

## 13. Official references

- Debezium PostgreSQL connector: https://debezium.io/documentation/reference/stable/connectors/postgresql.html
- Debezium Outbox Event Router: https://debezium.io/documentation/reference/stable/transformations/outbox-event-router.html
