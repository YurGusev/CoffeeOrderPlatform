# M19. Event API и Realtime API

## 1. Kafka message = asynchronous API contract

Kafka stream/message имеет такой же governance, как HTTP surface.

Нормативные детали принадлежат M06; M19 определяет API classification/trust/versioning.

Каждый asynchronous API имеет:

```text
owner
message kind: event|command
producer audience
consumer audience
partition key/ordering
production partition policy
envelope schema
payload schema
compatibility policy
retention/replay/DR class
PII classification
SLO
```

## 2. Separate wire envelopes

Integration event использует:

```text
M06/integration-event-envelope.schema.json
```

Integration command использует:

```text
M06/integration-command-envelope.schema.json
```

Нельзя использовать один ambiguous `messageKind` contract для обоих.

## 3. Canonical topic registry

Единственный список streams:

```text
M06/kafka-topic-registry.yml
```

M19 не дублирует topic catalog.

## 4. Event semantics

Event — факт в прошедшем времени:

```text
OrderConfirmed
PaymentSucceeded
ProductAvailabilityChanged
AromaCartObserved
```

Lifecycle event включает aggregate identity/version, если owner имеет versioned aggregate.

## 5. Command semantics

Async command — requested action:

```text
AgentTurnRequested
ChannelReplyRequested
IndexProductEmbeddingRequested
ConvergeAromaCartRequested
```

Command имеет stable idempotency key и command-specific deadline/expiry semantics.

## 6. Publication

Transaction-bound asynchronous API publication:

```text
BEGIN PostgreSQL
  business state
  outbox
COMMIT
-> WAL
-> Debezium
-> Kafka
```

Direct `DB commit -> Kafka send` для domain transition запрещён.

## 7. Consumption

Side-effect consumer:

```text
schema validation
-> Inbox/idempotency
-> current-state/version validation
-> owned business use case
-> local state + optional Outbox in one transaction
-> safe offset commit
```

## 8. Delivery guarantee language

API documentation использует:

```text
at-least-once transport
+ effectively-once business effects
```

End-to-end exactly-once между Kafka/PostgreSQL/external provider не обещается.

## 9. Replay API semantics

Replay является controlled operations API/process, а не обычной producer retry. External/provider side effects не blind-replay.

## 10. Realtime API

Default browser server→client transport:

```text
GET /events
Content-Type: text/event-stream
```

Realtime message — invalidation/status hint:

```text
SSE hint
-> invalidate TanStack Query
-> fresh GET /api/client-v1
```

Realtime stream не является authoritative business state.

## 11. Multi-replica fan-out

Shared Kafka consumer group не broadcast'ит сообщение всем realtime pods.

Baseline:

```text
unique ephemeral Kafka group per realtime replica
auto.offset.reset=latest
```

При масштабе отдельный backplane/fan-out требует ADR.

## 12. WebSocket

Используется только при доказанной duplex необходимости, например web-chat.


## 13. Order fulfillment orchestration streams

Критический target flow использует:

```text
coffee.aroma.preparation.commands.v1
coffee.catalog.products.v1
coffee.catalog.mapping.commands.v1
coffee.catalog.mapping.v1
coffee.catalog.availability.v1
coffee.aroma.cart.commands.v1
coffee.aroma.cart.events.v1
coffee.invoices.commands.v1
coffee.invoices.events.v1
coffee.orders.lifecycle.v1
coffee.payments.lifecycle.v1
```

Kafka command не является физическим AROMA proof. Convergence command содержит stable identity/version hint; consumer перечитывает Orders DB и выполняет fresh GET before/after.

Нормативный service graph — M20.


## Catalog event semantics

```text
coffee.catalog.products.v1      = product metadata/price lifecycle; never implicit confirmed-order reprice
coffee.catalog.availability.v1  = product/variant availability and tombstones with source ordering
coffee.catalog.mapping.v1       = cart-critical Variant→AROMA mapping fact
```

Only availability/mapping facts can cause Orders Desired semantic target changes. Consumers remain idempotent/current-state guarded.

## Canonical invalidation production model

Only direct BC Outbox invalidation is canonical:

```text
Orders/Catalog/Invoices/Payments/Customer transaction
 -> Outbox RealtimeInvalidation
 -> coffee.realtime.invalidate.v1
 -> each realtime replica unique ephemeral group
 -> SSE hint
 -> browser fresh /api/client-v1 GET
```

Domain lifecycle topics **do not** have `realtime-*` consumer groups in baseline.
