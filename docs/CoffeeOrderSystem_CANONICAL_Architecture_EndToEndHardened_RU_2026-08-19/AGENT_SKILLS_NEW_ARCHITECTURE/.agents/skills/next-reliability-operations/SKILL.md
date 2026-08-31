---
name: next-reliability-operations
description: "Use for capacity models, backpressure, bulkheads, retry budgets, timeouts, SLO/SLI, OpenTelemetry, security boundaries, DR, fault injection, runbooks, and operational release gates."
---

# Reliability and Operations

## Source of truth

Каноническая программа: `M15_RELIABILITY_OPERATIONS`. Перед существенным изменением прочитать её `README.md` и релевантные нормативные документы. Если этот skill противоречит канонической программе, **побеждает каноническая программа**, а skill должен быть обновлён.

## Область действия

Этот skill относится **только к новой архитектуре CoffeeOrderSystem**. Нормативная зона записи:

```text
platform/**
edge/**          # только target/strangler изменения
infra/**         # новая Docker/Kafka/Debezium/Kubernetes topology
hermes/**
training/**
```

`src/**` является legacy/reference-зоной. Изменять `src/**` разрешено только когда задача явно требует characterization/parity instrumentation, migration adapter, rollback support или удаления legacy после принятого cutover. Нельзя использовать legacy C# архитектуру как шаблон для target-кода.

Новая platform не должна импортировать runtime-код, сборки или внутренние типы из `src/**`. Разрешены только language-neutral contracts, наблюдаемое поведение, database schema evidence и characterization tests.

## Use when

- новый I/O path/provider/queue;
- масштабирование;
- SLO/metrics/tracing;
- security/trust boundary;
- DR/backup/recovery;
- chaos/fault test.

## Hard rules

- Capacity моделируется через messages/sec, turns/sec, tools/turn, latency, tokens/sec, connection counts — не `maxUsers`.
- Каждый слой имеет bounded concurrency/backpressure; unlimited Promise/work queue запрещена.
- Retry имеет одного owner, budget, jitter и idempotency prerequisite.
- Timeout hierarchy задаётся от outer request budget к inner operation budget.
- Bulkheads разделяют ingress, egress, realtime, Hermes, business consumers, AROMA.
- Oldest queue/event age важнее одного lag count.
- OpenTelemetry trace проходит HTTP/Kafka/Hermes/tool path без PII/secrets.
- Security default deny; internal surfaces не публикуются через edge автоматически.
- DR определяется RPO/RTO и проверяется restore drill, а не наличием backup script.
- Node workloads имеют отдельные ELU/event-loop-delay/RSS/native-memory/connection-budget SLI.
- CPU alone не является достаточным Node saturation signal.
- SSE slow clients имеют bounded buffers и disconnect/reconnect recovery.

## Workflow

1. Для нового flow рассчитать workload/capacity assumptions.
2. Определить SLI/SLO и saturation signals.
3. Определить retry/timeout/backpressure owner.
4. Добавить metrics/logs/traces.
5. Добавить fault injection/chaos scenarios.
6. Добавить runbook и recovery evidence.
7. Не разрешать production cutover без M15 gate.

## Минимальная проверка

Перед завершением:

1. проверить соответствие каноническому документу программы;
2. проверить, что не создана новая скрытая cross-boundary зависимость;
3. выполнить targeted unit/integration/contract tests;
4. выполнить architecture/boundary tests для затронутого слоя;
5. проверить Docker build/health, если изменён runtime workload;
6. проверить observability и failure semantics, если изменён I/O/async path;
7. явно записать skipped checks и остаточный риск.


## M19 API Architecture

API SLO/error/auth/load/UnknownOutcome acceptance проверяются совместно с M19.


## Node runtime coordination

Для Node capacity/performance/runtime reliability активировать `next-nodejs-runtime` и читать M15 `07_NODEJS_RUNTIME_SLO_AND_CAPACITY.md`.

## Kafka platform coordination

Kafka reliability дополнительно требует `next-kafka-event-platform` и M15 `08_KAFKA_PLATFORM_SLO_AND_RECOVERY.md`. Проверять broker/minISR/controller health, partition skew, oldest-event-age, Debezium WAL/heartbeat, quotas, replay/DLQ age и explicit Kafka RPO/RTO. RF3/minISR2 не объявлять cross-cluster DR.


## BusinessLogicHardened service graph

Если задача меняет Orders/Catalog/AROMA/Invoices/Payments interaction, дополнительно активировать `next-business-orchestration` и проверить M20. Target не имеет direct Draft `sendToAromaCart`; `Confirm -> Desired -> Convergence` является нормальным supplier path.

## End-to-end closure hard rules

- Use M15 `11_BUSINESS_SLO_RPO_RTO_V1.md` as target release gate; metrics without numeric objectives are insufficient.
- Channel/agent message content is possible PII with 7-day Kafka retention baseline and sanitized training export.
- Artifact storage participates in backup/restore/integrity drills.
