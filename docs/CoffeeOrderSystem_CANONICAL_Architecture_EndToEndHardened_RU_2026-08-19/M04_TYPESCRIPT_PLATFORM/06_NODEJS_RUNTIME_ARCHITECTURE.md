# M04. Node.js Runtime Architecture — обязательный runtime contract

## 1. Статус

Этот документ — нормативный Node.js contract для всех target workload'ов под `platform/**`.

Базовая линия:

```text
Node.js 24 LTS
TypeScript strict
Fastify-first HTTP runtime
one Node process = one container/pod
bounded concurrency
explicit deadlines/cancellation
explicit DB/HTTP/Kafka connection budgets
OpenTelemetry + event-loop metrics
```

Node 26/Current не используется как production baseline без отдельного upgrade ADR. Конкретный patch Node 24 и image digest фиксируются lock/release automation.

## 2. Fastify-first, без двух framework-слоёв

Нормативный baseline:

```text
Fastify
+ project-owned modules/use cases
+ explicit composition roots
```

NestJS не является baseline и не добавляется "для структуры". Его использование требует отдельного ADR с доказательством missing capability.

Причина: у target platform уже есть собственные boundaries `apps/`, `modules/`, `packages/`; Fastify plugin encapsulation достаточен для HTTP composition и не должен создавать второй параллельный DI/module model.

## 3. Один Node process на workload

Запрещено:

```text
PM2 cluster внутри контейнера
node:cluster для обычного Kubernetes scale
несколько независимых application roles в одном process
```

Правильно:

```text
api-public          -> отдельный process
api-agent           -> отдельный process
api-internal        -> отдельный process
channel-ingress     -> отдельный process
channel-egress      -> отдельный process
realtime-gateway    -> отдельный process
hermes-dispatcher   -> отдельный process
Kafka consumer role -> отдельный process
```

Масштабирование выполняется количеством container/pod replicas.

## 4. Composition roots и trust separation

HTTP surfaces физически разделяются:

```text
platform/apps/api-public
  mounts /api/client-v1 only

platform/apps/api-agent
  mounts /api/agent-v1 only

platform/apps/api-internal
  mounts /api/internal-v1 only
```

Они могут импортировать одинаковые application modules, но имеют разные:

- route inventory;
- auth middleware;
- network exposure;
- service account;
- rate limits;
- response projections;
- secrets.

Даже ошибочная public Nginx route не должна раскрывать `agent-v1`/`internal-v1`, потому что этих routes нет в `api-public` process.

## 5. Deadline / cancellation contract

Каждый request/turn/job получает bounded execution context:

```ts
interface ExecutionContext {
  signal: AbortSignal;
  deadlineUtc: string;
  traceId: string;
  correlationId: string;
}
```

Правило:

```text
outer deadline
  -> application budget
     -> DB/provider sub-budget
```

Timeout без cancellation недостаточен: downstream HTTP/DB/work должен получать отмену там, где client/library поддерживает её.

Использовать `AbortController`, `AbortSignal.timeout()` и `AbortSignal.any()` для объединения caller cancellation и operation timeout.

Не считать Fastify handler timeout автоматической отменой уже запущенных async side effects.

## 6. HTTP client policy: запрет свободного fetch

Application/domain code не делает произвольный `fetch(url)`.

Используются typed provider clients через:

```text
platform/packages/http-client/
platform/packages/provider-clients/
```

Отдельные connection pools/agents:

```text
HermesHttpClient
VkHttpClient
AromaHttpClient
PaymentProviderHttpClient
```

Каждый имеет:

- allowlisted origin;
- connection limit;
- request/deadline budget;
- circuit/rate policy;
- trace propagation;
- response size limit;
- error classification;
- no arbitrary model-controlled URL/method/header.

## 7. PostgreSQL connection budget

Pool sizing считается на fleet, а не на один process:

```text
sum(replicas_i * pg_pool_max_i)
  < application PostgreSQL connection budget
```

Отдельно резервируются connections для:

- migrations;
- Debezium/replication;
- reconciliation/admin jobs;
- observability/DBA;
- emergency headroom.

Нельзя оставлять default `max` без capacity review при горизонтальном scale.

Metrics:

```text
pg_pool_total
pg_pool_idle
pg_pool_waiting
pg_checkout_wait_ms
query_duration
transaction_duration
```

## 8. Transaction primitive

Одна PostgreSQL transaction всегда использует один acquired `pg.Client`.

Общий primitive:

```ts
await withTransaction(ctx, async (tx) => {
  // все statements через tx
})
```

Запрещено использовать `pool.query()` для statements одной transaction.

Transaction layer обязан:

- `BEGIN/COMMIT/ROLLBACK`;
- release client в `finally`;
- rollback на exception;
- trace/metric transaction duration;
- поддерживать explicit isolation/lock policy where required.

## 9. DB timeout profile

Platform config явно задаёт bounded DB budgets. Для разных role/operation классов допускаются разные профили:

```text
short-read
interactive-command
background-reconciliation
migration/admin
```

Используются доступные PostgreSQL/node-postgres механизмы (`statement_timeout`, query timeout, lock timeout, connection checkout timeout) по owning use case.

## 10. SQL toolkit

В target platform используется **один** основной typed SQL toolkit плюс `node-postgres` и raw SQL escape hatch.

Не допускается:

```text
Orders -> ORM A
Catalog -> ORM B
Payments -> raw pg everywhere
```

Перед массовой реализацией M04 выполняется ADR/POC `SQL_TOOLKIT_DECISION`. Кандидат, предпочтительный для текущей архитектуры: Kysely + `pg`, поскольку система SQL-centric и требует явных CTE/locks/fencing/reconciliation. Решение не считается окончательным до POC.

## 11. Event loop hard rules

В runtime request/consumer paths запрещены sync APIs, способные блокировать event loop:

- `fs.*Sync`;
- `child_process.*Sync`;
- sync compression;
- expensive sync crypto;
- unbounded regexp/input processing;
- large unbounded `JSON.parse/stringify`;
- CPU-heavy Excel/PDF/image/ML processing.

Нужен ESLint/static check для известных synchronous server APIs.

Worker Threads применяются только для доказанного CPU-bound JavaScript и через bounded pool. I/O-bound работа остаётся async в основном process или выносится в отдельный workload по operational reason.

## 12. Документы / Excel / PDF

Большие document transforms не выполняются внутри `api-public` request loop.

Target pattern:

```text
upload/command
 -> durable job/event
 -> document-worker
 -> persisted result/event
```

Либо bounded worker-thread pool после benchmark для ограниченного CPU task.

## 13. Fastify server baseline

`platform/packages/http-runtime` создаёт единый factory и явно настраивает:

- `trustProxy` только для известного Nginx/Ingress CIDR/hops;
- request timeout;
- handler timeout;
- small default body limit;
- keep-alive policy;
- request ID/correlation;
- schema compiler;
- error mapper;
- graceful close hooks.

`trustProxy: true` без ограниченной proxy chain запрещён.

## 14. Runtime schemas

Каждая network route имеет:

```text
request schema
response schema
error schema
```

Fastify JSON Schema используется и для validation, и для response serialization/minimization.

Schema definitions считаются application code. Нельзя компилировать user-supplied schemas во время request.

DB/network access не выполняется внутри первичной schema validation.

## 15. Money на JSON boundary

Domain может использовать:

```ts
amountMinor: bigint
```

Но JSON API/Kafka contracts не передают raw JavaScript BigInt.

Canonical wire representation:

```json
{
  "amountMinor": "12500",
  "currency": "RUB"
}
```

или другой явно versioned decimal-string contract. Преобразование выполняется boundary mapper'ом.

## 16. Realtime isolation

`realtime-gateway` не объединяется с `api-public`.

Причина: десятки тысяч SSE sockets создают отдельный профиль:

- open file descriptors;
- long-lived memory;
- per-client buffers;
- reconnect storms;
- event-loop pressure.

Realtime имеет собственный image/deployment/resource budget.

## 17. Realtime Kafka fan-out

Обычная shared consumer group непригодна для broadcast на локальных SSE clients нескольких replicas: event попадёт только одному member группы.

Baseline v1:

```text
каждая realtime replica
  -> отдельный ephemeral consumer group
  -> start from latest
  -> получает все realtime invalidation events
```

Realtime event — только hint. После reconnect/cold start браузер делает authoritative HTTP refresh.

Если число realtime replicas делает broadcast Kafka cost неприемлемым, вводится отдельный fan-out/backplane ADR (например Redis/NATS), но не заранее.

## 18. SSE slow-client backpressure

На connection задаётся bounded pending buffer/events.

Если клиент не успевает:

```text
buffer threshold exceeded
 -> disconnect client
 -> browser reconnects
 -> authoritative refetch
```

Нельзя накапливать unbounded outbound buffers.

Обязательные metrics:

```text
sse_connections
sse_pending_bytes
sse_slow_client_disconnect_total
sse_reconnect_rate
```

Nginx route для SSE отключает proxy buffering и имеет отдельные timeout/cache rules.

## 19. Node runtime observability

Для каждого Node workload обязательны:

```text
event_loop_utilization
event_loop_delay p50/p95/p99
process RSS
heap used/total
external memory
arrayBuffers
GC pauses
active handles/requests where useful
```

CPU не является единственным scaling signal.

## 20. Memory budget

Container memory budget делится:

```text
V8 heap
native libraries (включая librdkafka)
Buffers/ArrayBuffers
runtime/stack/code
safety headroom
```

V8 old-space не должен равняться почти всему container limit. При необходимости задаётся `--max-old-space-size` или percentage policy, оставляя native/headroom.

## 21. Fatal error policy

`uncaughtException`/фатальные runtime errors не приводят к продолжению обычной работы.

Policy:

```text
best-effort telemetry flush
mark unhealthy / stop intake
exit process
Docker/Kubernetes restarts
```

Никакого `catch/log/continue` для неизвестного process state.

## 22. Graceful shutdown per role

### HTTP API

```text
SIGTERM
 -> readiness false
 -> stop new requests
 -> drain in-flight
 -> close DB/provider clients
 -> flush telemetry
 -> exit
```

### Kafka consumer

```text
SIGTERM
 -> pause intake
 -> drain bounded in-flight
 -> commit safe offsets
 -> disconnect consumer
 -> close DB
```

### Realtime

```text
SIGTERM
 -> stop new SSE
 -> optional reconnect hint
 -> close clients within grace
 -> disconnect Kafka
```

### Hermes Dispatcher

```text
SIGTERM
 -> stop claiming/submitting new turns
 -> persist current state
 -> drain bounded submissions
 -> unfinished turns remain recoverable
```

## 23. Cron/background jobs

Не запускать permanent `setInterval()` maintenance loops внутри API process.

Time-driven tasks:

```text
Kubernetes CronJob
или dedicated scheduler/worker role
```

Continuous event consumers — отдельные Deployments.

## 24. Node Permission Model

P1 defense-in-depth: провести permission audit для каждого workload и, где совместимо с native dependencies, ограничить filesystem/child process/worker/addon capabilities.

Permission Model не считается security sandbox и не заменяет container/NetworkPolicy/service credentials.

## 25. Docker baseline

Для Node workloads с native Kafka/OTel dependencies предпочтительный baseline:

```text
node:24-bookworm-slim
```

с exact patch + digest.

Alpine допускается после compatibility smoke; для `platform-web` runtime по-прежнему используется Nginx, а Node нужен только в build stage.

## 26. Verified upstream references

- Node.js release status: https://nodejs.org/en/about/previous-releases
- Node event-loop guidance: https://nodejs.org/en/learn/asynchronous-work/dont-block-the-event-loop
- Node perf hooks: https://nodejs.org/api/perf_hooks.html
- Fastify server: https://fastify.dev/docs/latest/Reference/Server/
- Fastify validation/serialization: https://fastify.dev/docs/v5.8.x/Reference/Validation-and-Serialization/
- node-postgres pooling/transactions: https://node-postgres.com/features/pooling and https://node-postgres.com/features/transactions
