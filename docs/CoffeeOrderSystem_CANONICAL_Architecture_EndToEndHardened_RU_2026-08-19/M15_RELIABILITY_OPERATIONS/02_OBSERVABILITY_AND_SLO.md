# 19. Observability и SLO

## 1. Наблюдаемость входит в foundation

Новая platform не принимает бизнес-код до появления общего telemetry package.

```text
platform/packages/observability
```

Он стандартизует:

- OpenTelemetry traces;
- structured logs;
- metrics;
- correlation/causation IDs;
- health/readiness;
- release/image metadata.

## 2. Сквозной trace

Одна пользовательская операция должна быть прослеживаема:

```text
Browser/VK
 -> Nginx edge
 -> React web / channel ingress
 -> TypeScript API/Kafka
 -> Hermes
 -> agent-v1
 -> domain module
 -> PostgreSQL/provider
 -> Kafka
 -> realtime/VK response
```

## 3. Canonical identifiers

```text
traceId
requestId
eventId
correlationId
causationId
conversationKeyHash
turnId
orderRef/paymentRef/invoiceRef
releaseDigest
```

PII не используется как correlation identifier.

## 4. Web frontend metrics

Browser:

```text
LCP
INP
CLS
route navigation time
API error rate
JS error rate
React error-boundary count
```

`platform-web`:

```text
static request rate
p95/p99 response
5xx
asset 404
health
release digest
```

## 5. Edge metrics

```text
requests by route family/upstream
legacy vs platform routing ratio
upstream p95/p99
499/502/503/504
rate-limit rejects
active connections
SSE connections
```

Это позволяет наблюдать Strangler migration quantitatively.

## 6. TypeScript API

```text
HTTP p50/p95/p99
requests/sec
error classes
DB pool wait
transaction duration
outbox rows/sec
idempotency hits
optimistic conflicts
```

## 7. Kafka

Обязательные показатели platform-level:

```text
UnderReplicatedPartitions
UnderMinIsrPartitionCount
OfflinePartitionsCount
ISR shrink/expand
controller quorum health/lag
produce/fetch request latency
request queue / handler idle
broker disk growth/free
quota throttle time
```

Consumer/topic/partition-level:

```text
produce latency/errors
consumer lag per partition
oldest unprocessed event age
records/bytes per partition
processing latency
paused partitions
rebalance count/rate/duration
commit failures
DLQ/replay activity
partition skew/hot-key signals
```

`oldest event age` важнее одного только lag count. Average topic lag не должен скрывать hot partition. Полный profile — `08_KAFKA_PLATFORM_SLO_AND_RECOVERY.md`.

## 8. Debezium

```text
connector status
source lag
heartbeat age
replication slot retained WAL bytes/age
connector queue records/bytes utilization
outbox oldest unpublished age
outbox events emitted
connector errors/restarts
Connect internal topic health
```

## 9. Hermes

```text
queued turns
oldest turn age
active runs/shard
submission latency
run p95/p99
state store latency/errors
provider/model latency
TTFT
tokens/sec
tool calls/turn
```

## 10. AROMA

```text
Observed freshness
Desired/Observed drift count
convergence attempts
UnknownOutcome count/oldest age
provider latency/errors
circuit state
lease/fencing rejection
checkout stage age
```

## 11. Payments

```text
payment intent age
provider create latency
webhook processing age
reconciliation backlog
payment success/failure
refund status
unknown outcome
```

## 12. SLO policy

SLO определяется пользовательским outcome, а не только process uptime.

Примеры SLI:

```text
frontend availability
API successful request latency
VK durable-accept latency
agent queue age
order command success
payment reconciliation age
AROMA observation freshness
```

Численные thresholds устанавливаются после baseline/load tests и хранятся в versioned SLO document.

## 13. Release comparison

Для каждого C#→TS canary dashboard должен разделять:

```text
legacy
platform
```

и сравнивать:

```text
latency
error rate
payload/parity mismatches
DB cost
resource usage
```

Без такого сравнения route cutover не считается доказанным.


## Node runtime mandatory metrics

Каждый Node process экспортирует ELU, event-loop delay p50/p95/p99, RSS, heap used/total, external memory, ArrayBuffers и GC pause. Для realtime добавляются SSE pending bytes/slow-client disconnect/reconnect; для DB — pool waiting/checkout wait; для Kafka — native queue/client stats where available. См. `07_NODEJS_RUNTIME_SLO_AND_CAPACITY.md`.
