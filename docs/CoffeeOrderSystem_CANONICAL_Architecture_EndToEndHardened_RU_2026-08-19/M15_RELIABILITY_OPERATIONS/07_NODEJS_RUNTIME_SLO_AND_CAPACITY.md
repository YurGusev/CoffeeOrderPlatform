# M15. Node.js Runtime SLO и Capacity

## 1. Зачем отдельный Node SLO

Node.js saturation может возникнуть до высокого CPU: event loop, native memory, sockets, DB pools и downstream queues должны измеряться отдельно.

## 2. Обязательные runtime metrics

Каждый Node process публикует:

```text
node_event_loop_utilization
node_event_loop_delay_seconds{quantile}
process_resident_memory_bytes
node_heap_used_bytes
node_heap_total_bytes
node_external_memory_bytes
node_array_buffer_bytes
node_gc_pause_seconds
```

Дополнительно по role:

```text
HTTP in-flight
SSE connections/pending bytes
Kafka in-flight/producer queue
DB pool total/idle/waiting
provider pool queued/in-flight
```

## 3. Event-loop SLI

Основные Node SLI:

```text
ELU
p95/p99 event-loop delay
```

Численные production thresholds определяются benchmark/soak и фиксируются в SLO profile конкретного workload. CPU не может быть единственным HPA signal.

## 4. Memory budget model

Для каждого container:

```text
container memory limit
  - V8 old/young heap budget
  - native addon budget
  - Buffers/ArrayBuffers
  - code/stacks/runtime
  - emergency headroom
```

V8 heap cap выбирается так, чтобы native Kafka/OTel/Buffer growth не приводил к OOMKill до Node heap pressure.

## 5. PostgreSQL fleet connection budget

Capacity sheet содержит:

```text
role replicas
* pool max
= max connections contribution
```

Сумма должна быть ниже выделенного application connection budget с резервом.

Отдельная alert:

```text
pg_pool_waiting > 0 sustained
pg_checkout_wait p95/p99
```

## 6. Provider connection budgets

Отдельно считать:

```text
Hermes connections
VK outbound connections
AROMA connections
payment provider connections
```

Connection limit не увеличивается только потому, что число Node replicas выросло; учитываются provider quotas.

## 7. SSE capacity model

Для realtime измеряются:

```text
connections per pod
RSS per 1k connections
file descriptors
pending bytes/client
outbound events/sec
reconnect/sec
```

Load ladder:

```text
10k
25k
50k
100k+
```

Но каждый уровень тестируется при реальной message/invalidation rate, а не idle sockets only.

## 8. Backpressure gates

При saturation:

- HTTP admission/rate limit;
- Kafka backlog растёт durably, не RAM;
- consumer concurrency не превышает DB/provider budget;
- SSE slow clients отключаются;
- Hermes new run submission bounded;
- document jobs остаются в durable queue.

## 9. Role-specific scale signals

| Workload | Primary signals |
|---|---|
| `api-public` | RPS, p95/p99, ELU, event-loop delay, DB pool wait |
| `api-agent` | agent tool RPS, p99, DB pool wait, identity rejects |
| `api-internal` | operation age, p99, DB/provider saturation |
| `channel-ingress` | callback RPS, Kafka produce latency, ELU |
| `channel-egress` | oldest outbound age, provider 429/quota, ELU |
| `realtime-gateway` | connections, pending bytes, RSS, ELU, reconnect rate |
| `hermes-dispatcher` | waiting turns, oldest turn age, active submissions, ELU |
| Kafka consumers | lag + oldest event age + DB/provider budget |

## 10. Node load acceptance

Release gate включает:

- sustained soak;
- burst traffic;
- slow provider;
- DB pool pressure;
- Kafka rebalance;
- SIGTERM drain;
- memory growth/leak check;
- slow SSE clients;
- fatal process restart recovery.

## 11. Verified Node metrics

Node предоставляет `eventLoopUtilization()` и `monitorEventLoopDelay()` через `perf_hooks`; их включение является частью `platform/packages/observability`.
