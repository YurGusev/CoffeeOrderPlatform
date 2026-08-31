# 27. Отбор идей System Design для целевой архитектуры

## 1. Принцип отбора

Из System Design Primer и трёх curated repositories берутся не технологии ради масштаба, а механизмы, усиливающие конкретные гарантии CoffeeOrderSystem.

## 2. P0 — внедрить обязательно

### Capacity-first

До scale decisions фиксировать workload equations, saturation knee и bottleneck.

### Backpressure

На каждом queue/boundary bounded intake/concurrency.

### Bulkheads

Channel, realtime, Hermes, Payments, AROMA используют отдельные resource/failure pools.

### Idempotency

Платежи, agent mutations, Kafka consumers, provider operations.

### Transactional Outbox + CDC

DB change + outbox в одной transaction; Debezium relays event.

### Nginx Strangler

Route-family cutover/rollback C#→TS и old→new web.

### Distributed tracing

End-to-end request/event/agent correlation.

### Retry budget

Один owner retries; jitter/max wall-clock; не умножать layers.

### Deterministic/parity testing

C# reference vs TS target, duplicates/crashes/rebalance.

## 3. P1 — после foundation

### Saga/process manager

Payments и supplier/checkout long-running flows.

### Consistent/rendezvous hashing

Hermes shard placement + persisted binding.

### Fault injection/chaos

Compose/Toxiproxy сначала, K8s chaos позже.

### TLA+

Только AROMA convergence и Payments invariants.

### Cache-aside

Только measured read hot spots Catalog/reference data.

## 4. P2 — только по метрикам

### Redis

Возможные роли:

- distributed provider rate limiter;
- realtime fan-out backplane.

Не business source of truth.

### Read replicas

После измеримого read pressure PostgreSQL.

## 5. Не добавлять сейчас

```text
Cassandra/Dynamo replacement
DB sharding
full Event Sourcing
Service Mesh
CRDT
global distributed lock service
GraphQL everywhere
gRPC everywhere
microfrontends
nanoservices
mandatory Redis
```

## 6. Architecture test question

Перед добавлением любой новой технологии ответить:

```text
Какую конкретную гарантию она улучшает?
Какой измеримый bottleneck она устраняет?
Какова операционная цена?
Можно ли решить проблему уже выбранным компонентом?
Как её удалить/rollback?
```

Если нет доказанного ответа — не добавлять.
