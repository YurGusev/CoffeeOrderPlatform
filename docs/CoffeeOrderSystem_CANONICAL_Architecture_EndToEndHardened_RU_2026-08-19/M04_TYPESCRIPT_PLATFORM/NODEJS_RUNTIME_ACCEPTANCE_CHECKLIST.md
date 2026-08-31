# Node.js Runtime Acceptance Checklist

Использовать для каждого нового production Node workload.

## Architecture

- [ ] один process = одна runtime role;
- [ ] role не объединяет public/agent/internal trust surfaces;
- [ ] Fastify-first baseline соблюдён либо есть ADR;
- [ ] нет runtime import из legacy `src/**`;
- [ ] CPU-heavy/document processing не находится в main event loop.

## I/O budgets

- [ ] PostgreSQL pool max рассчитан с учётом replicas;
- [ ] provider HTTP origin/connection pool фиксирован;
- [ ] Kafka concurrency bounded;
- [ ] timeout/deadline определён;
- [ ] AbortSignal распространяется downstream where supported;
- [ ] unsafe UnknownOutcome не превращается в blind retry.

## HTTP

- [ ] request schema;
- [ ] response schema;
- [ ] small default body limit;
- [ ] trustProxy ограничен известной chain;
- [ ] no arbitrary fetch/application-controlled URL;
- [ ] graceful Fastify close.

## Runtime

- [ ] ELU и event-loop delay экспортируются;
- [ ] RSS/heap/external/ArrayBuffer/GC видимы;
- [ ] V8 heap оставляет native/headroom;
- [ ] fatal unknown process state = exit/restart;
- [ ] blocking sync APIs отсутствуют в server path.

## Lifecycle

- [ ] readiness снимается до drain;
- [ ] SIGTERM test проходит;
- [ ] in-flight work либо завершается, либо остаётся replayable;
- [ ] DB/Kafka/provider clients корректно закрываются;
- [ ] Docker memory-limit smoke проходит.

## Role-specific

### Kafka

- [ ] shared kafka-runtime используется;
- [ ] safe offset lifecycle доказан;
- [ ] rebalance/drain test проходит.

### Realtime

- [ ] slow-client buffer bounded;
- [ ] disconnect/reconnect recovery есть;
- [ ] multi-replica broadcast semantics доказаны.

### Hermes Dispatcher

- [ ] no long partition block;
- [ ] AgentTurn durable state;
- [ ] submission unknown outcome reconciliation.
