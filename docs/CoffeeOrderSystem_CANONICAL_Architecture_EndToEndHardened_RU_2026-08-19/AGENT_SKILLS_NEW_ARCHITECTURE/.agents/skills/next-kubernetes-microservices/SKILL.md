---
name: next-kubernetes-microservices
description: "Use for Kubernetes target runtime, selective microservice extraction, workload roles, HPA/KEDA, StatefulSet Hermes, NetworkPolicy, probes, jobs/cronjobs, topology and deployment boundaries."
---

# Kubernetes and Selective Microservices

## Source of truth

Каноническая программа: `M13_KUBERNETES_MICROSERVICES`. Перед существенным изменением прочитать её `README.md` и релевантные нормативные документы. Если этот skill противоречит канонической программе, **побеждает каноническая программа**, а skill должен быть обновлён.

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

- перенос Compose workload в K8s;
- выделение bounded context в service;
- autoscaling/probes/network policy;
- Hermes StatefulSet/GPU pool.

## Hard rules

- Kubernetes = orchestration plane, не доменная архитектура.
- Сначала доказать container/process split в Compose.
- Service extraction только при independent scaling/failure/security/release/data reason.
- Запрещены nanoservices и cross-service SQL.
- API/consumers одного bounded context могут быть разными Deployments с общей domain package, но своим DB ownership.
- Hermes = StatefulSet/per-shard PVC/state-aware drain.
- Kafka/PostgreSQL не тащить в application cluster без отдельного stateful-platform design.
- Readiness = способен безопасно принимать новую работу; liveness не зависит от временной недоступности provider.
- KEDA lag scaling ограничен partition parallelism/provider quotas.

## Workflow

1. Определить workload class и resource profile.
2. Перенести health/graceful shutdown из Compose.
3. Добавить Deployment/StatefulSet/Job/CronJob.
4. Добавить requests/limits, topology spread, PDB где уместно.
5. Добавить default-deny NetworkPolicy и allowlist.
6. Настроить HPA/KEDA по workload metric.
7. Провести rollout/drain/failure test.

## Минимальная проверка

Перед завершением:

1. проверить соответствие каноническому документу программы;
2. проверить, что не создана новая скрытая cross-boundary зависимость;
3. выполнить targeted unit/integration/contract tests;
4. выполнить architecture/boundary tests для затронутого слоя;
5. проверить Docker build/health, если изменён runtime workload;
6. проверить observability и failure semantics, если изменён I/O/async path;
7. явно записать skipped checks и остаточный риск.


## Node runtime coordination

Node workloads масштабируются не только по CPU: использовать ELU/event-loop delay, DB pool wait, RSS/SSE buffers/Kafka age по M04/M15. `api-public`, `api-agent`, `api-internal` остаются отдельными Deployments/trust zones.

## Kafka/KEDA hard rule

KEDA может менять количество consumer replicas, но не Kafka partition count. Production partition topology active keyed topic определяется M06 capacity contract до cutover; автоматическое увеличение partitions из-за lag запрещено.


## BusinessLogicHardened service graph

Если задача меняет Orders/Catalog/AROMA/Invoices/Payments interaction, дополнительно активировать `next-business-orchestration` и проверить M20. Target не имеет direct Draft `sendToAromaCart`; `Confirm -> Desired -> Convergence` является нормальным supplier path.
