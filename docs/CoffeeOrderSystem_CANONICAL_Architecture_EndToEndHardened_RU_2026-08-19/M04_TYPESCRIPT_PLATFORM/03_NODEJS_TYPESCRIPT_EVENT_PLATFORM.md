# M04. Node.js/TypeScript Event Platform

## 1. Назначение

Event Platform — technical bounded context для network/event I/O.

```text
Node.js 24 LTS
TypeScript strict
Kafka
Fastify where HTTP required
SSE/WebSocket
OpenTelemetry
```

Обязательные runtime правила задаёт `06_NODEJS_RUNTIME_ARCHITECTURE.md`.

## 2. Runtime roles

```text
apps/channel-ingress
apps/channel-egress
apps/realtime-gateway
apps/hermes-dispatcher
```

Каждая role — отдельный Node process/container/deployment.

## 3. Channel Ingress

```text
VK Callback
 -> validate provider + body
 -> normalize
 -> identity attestation
 -> Kafka idempotent produce/acks=all
 -> provider ACK
```

Нельзя ждать Hermes/LLM перед ACK.

## 4. Channel Egress

```text
Kafka outbound
 -> delivery idempotency
 -> provider rate/concurrency budget
 -> fixed-origin VK client
 -> delivery outcome event
```

## 5. Realtime Gateway

```text
Kafka invalidation
 -> TypeScript realtime gateway
 -> bounded SSE buffers
 -> React invalidate query
 -> authoritative GET
```

Realtime не передаёт mutable aggregate как новый source of truth.

### Multi-replica broadcast

Shared Kafka consumer group для всех realtime replicas запрещён, если каждой replica нужно доставить event своим локальным clients.

V1 baseline: unique ephemeral group per realtime replica, consume from latest. При пропущенном hint/reconnect React выполняет authoritative refetch.

## 6. Hermes Dispatcher

TypeScript workload, потому что он выполняет I/O orchestration:

```text
Kafka
PostgreSQL turn/binding state
Hermes /v1/runs
run status/events
Kafka outcome
```

Business calculations отсутствуют.

## 7. Dispatcher responsibilities

- `AgentTurn` journal;
- `AgentConversationBinding`;
- one-active-turn-per-conversation;
- sticky shard placement;
- run submission/reconciliation;
- shard capacity/drain;
- outcome normalization;
- safe Kafka offset lifecycle.

## 8. Shared platform packages

```text
packages/kafka-runtime
packages/http-client
packages/channel-protocols
packages/hermes-client
packages/observability
packages/security-context
```

Business handlers не дублируют Kafka lifecycle/HTTP pooling logic.

## 9. Backpressure

Event Platform использует bounded concurrency. При saturation work остаётся в Kafka/durable turn state, а не в unlimited Promise queues/RAM.

## 10. Event loop and memory

Каждая role публикует ELU/event-loop delay, RSS/heap/external/ArrayBuffer metrics. Native Kafka memory учитывается отдельно от V8 heap.

## 11. Graceful shutdown

Каждая role имеет свой drain contract: снять readiness, прекратить intake, завершить bounded in-flight, сохранить durable state/offsets, закрыть Kafka/DB/HTTP clients.
