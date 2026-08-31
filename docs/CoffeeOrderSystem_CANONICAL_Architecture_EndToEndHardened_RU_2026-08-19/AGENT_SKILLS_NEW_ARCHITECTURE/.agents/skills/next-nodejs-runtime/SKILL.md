---
name: next-nodejs-runtime
description: "Use for any production Node.js workload in the new CoffeeOrderSystem architecture: Fastify servers, Kafka consumers/producers, channel ingress/egress, realtime SSE/WebSocket, Hermes Dispatcher, PostgreSQL pools, provider HTTP clients, event-loop/memory budgets, graceful shutdown, Docker/Kubernetes Node runtime, or Node-specific performance/security behavior."
---

# Next Node.js Runtime

## Source of truth

Read first:

- `M04_TYPESCRIPT_PLATFORM/06_NODEJS_RUNTIME_ARCHITECTURE.md`;
- `M15_RELIABILITY_OPERATIONS/07_NODEJS_RUNTIME_SLO_AND_CAPACITY.md`;
- owning program document (M06/M09/M19/etc.).

For Kafka also read `M06_KAFKA_EVENT_PLATFORM/04_NODEJS_KAFKA_RUNTIME.md`. For HTTP also read `M19_API_ARCHITECTURE/10_NODEJS_HTTP_RUNTIME_CONTRACT.md`.

## Scope

Applies only to target runtime under `platform/**` and target `infra/**`. Legacy `src/**` is reference/evidence, not Node design authority.

## Baseline

```text
Node.js 24 LTS
TypeScript strict
Fastify-first
one Node process = one container/pod role
bounded concurrency
AbortSignal/deadline propagation
explicit connection/memory/event-loop budgets
```

NestJS is not baseline and requires an ADR.

## Hard rules

- Do not use PM2/node cluster inside normal target containers for horizontal scale.
- Split `api-public`, `api-agent`, `api-internal` composition roots; do not mount all trust surfaces in one public process.
- No arbitrary `fetch()` from application/domain code; use typed fixed-origin provider clients with bounded pools/deadlines.
- No unbounded `Promise.all`/in-memory queues on server/consumer paths.
- Do not use blocking sync filesystem/child-process/compression/expensive crypto APIs in runtime paths.
- Large PDF/Excel/image/ML work stays outside API event loop.
- One PostgreSQL transaction uses one acquired `pg.Client`; never use `pool.query()` across a transaction.
- Pool sizing is fleet-wide; account for replicas × pool max and reserve DB headroom.
- Propagate `AbortSignal`/deadlines; a timeout without cancellation is incomplete.
- Cancellation is not proof an unsafe provider mutation did not happen; preserve idempotency/UnknownOutcome/reconciliation.
- JSON Schema request/response validation/serialization is required at HTTP boundary.
- `trustProxy: true` blanket setting is forbidden; trust only known edge/ingress chain.
- Domain money may use bigint, but JSON/Kafka wire representation must be versioned decimal/minor-unit string or other explicitly safe representation.
- Realtime SSE is isolated from API process and has bounded per-client output buffering.
- Multiple realtime replicas may not share one work-queue consumer group for broadcast to local clients; use the documented per-replica ephemeral group baseline until a backplane ADR exists.
- Fatal unknown process state is fail-fast: telemetry best-effort then exit and let supervisor restart.
- Cron/maintenance work does not live as permanent `setInterval()` inside API process.

## Required metrics

```text
event-loop utilization
event-loop delay p50/p95/p99
RSS
heap used/total
external memory
ArrayBuffers
GC pause
DB pool waiting/checkout wait
role-specific queue/connection metrics
```

CPU alone is not a sufficient scaling signal.

## Kafka rules

When Kafka is touched also use `next-kafka-event-platform`.

Preferred client candidate is `@confluentinc/kafka-javascript`, but dependency lock requires the documented Node24+pnpm+Docker compatibility spike because upstream marks pnpm support experimental.

Business consumers use shared `platform/packages/kafka-runtime`; do not reimplement rebalance/offset/heartbeat/retry logic in each module.

## HTTP rules

When HTTP/API is touched also use `next-api-architecture`.

Use shared `platform/packages/http-runtime` and typed `http-client/provider-clients` packages.

## Container rules

When Docker/Kubernetes is touched also use `next-docker-compose-runtime` / `next-kubernetes-microservices` as applicable.

Prefer glibc `node:24-bookworm-slim` for workloads with native Kafka/OTel dependencies until compatibility evidence justifies another base. Pin exact patch and digest.

## Verification

At minimum for changed production Node runtime:

1. typecheck/lint/unit/integration;
2. Docker build + startup smoke;
3. memory-limit smoke;
4. SIGTERM graceful shutdown/drain;
5. event-loop/RSS metrics visible;
6. provider/DB pool limits verified;
7. load test for changed concurrency path;
8. Kafka native-load/rebalance test when Kafka dependency/runtime changed;
9. slow-client test when realtime changed;
10. failure/restart recovery test for stateful/durable orchestration changes.

## Kafka runtime hardening coordination

Node Kafka workload следует M06 `04_NODEJS_KAFKA_RUNTIME.md` и `09_REPLAY_DLQ_AND_CONSUMER_RECOVERY.md`: durable consumers fail closed (`auto.commit=false`, `auto.offset.reset=none`, no auto topic), bounded per-partition in-flight/completed-ahead gap, safe drain/commit и stable client.id/principal.
