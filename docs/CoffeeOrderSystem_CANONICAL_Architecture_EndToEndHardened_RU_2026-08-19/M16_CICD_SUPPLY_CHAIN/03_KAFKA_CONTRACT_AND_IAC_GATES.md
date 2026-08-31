# M16. Kafka Contract и IaC CI/CD Gates

## 1. Goal

Kafka topology/contracts разворачиваются как version-controlled infrastructure и не создаются приложениями динамически.

## 2. Canonical inputs

CI читает:

```text
M06/kafka-topic-registry.yml
M06/integration-event-envelope.schema.json
M06/integration-command-envelope.schema.json
M06/schemas/**
infra/kafka/** environment overlays
```

## 3. Required CI gates

### Registry lint

Проверить unique topic names, valid kind, owner, key, retentionClass, schema path, producers, consumers, replay/drClass.

### Production completeness

Production overlay не допускает `productionPartitions: null`.

### Topic drift

Сравнить expected registry/IaC и deployed topic config:

```text
partitions
replication factor
minISR
retention/cleanup
max message size
ACL/quota intent
```

Unexpected drift блокирует promotion или требует break-glass evidence.

### Partition change guard

Для active production keyed topic изменение partition count требует explicit migration/ADR label и не проходит как обычный config edit.

### Schema validation

Проверить JSON Schema syntax, envelope + payload fixtures и contract compatibility.

### Runtime Schema Registry

Если включён runtime registry, CI сначала выполняет compatibility check, затем публикует approved schema. Runtime producer не регистрирует новые production schemas самостоятельно.

### Kafka client smoke

Node image smoke проверяет native Kafka client load, produce/consume, manual offset commit, SIGTERM drain и pinned client/runtime versions.

### Debezium config validation

Проверить unique connector/slot/publication names, outbox table include-list, heartbeat/snapshot policy и отсутствие secrets.

## 4. IaC layout

Target:

```text
infra/kafka/
  cluster/
  topics/
  principals/
  acls/
  quotas/
  connect/
  schema-registry/
  dr/
  policies/
```

Application repository может хранить desired-state manifests, но credentials приходят только из secret management.

## 5. Immutable promotion

Kafka client app image и Kafka/Connect config revisions имеют release identity. Canary/recovery evidence сохраняет exact revision/hash.

## Business orchestration gates

Topic Registry и M20 должны совпадать по producer/consumer owner. CI отдельно проверяет critical flow:

```text
orders -> aroma.preparation.commands
orders-aroma-preparation -> catalog.mapping.commands
catalog -> mapping/availability events
orders -> aroma.cart.commands
orders -> invoices.commands
invoices -> invoices.events -> orders
orders.lifecycle(OrderPaymentRequired) -> payments
payments.lifecycle -> orders
```

`coffee.invoices.commands.v1` normal materialization key = `InvoiceOperationRef`, а не ещё не существующий ClientInvoiceId.
