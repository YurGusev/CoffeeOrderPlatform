---
name: next-system-design-governance
description: "Use when proposing a new system-design technology or pattern for the new architecture. It enforces capacity-first selection and blocks premature Redis, NoSQL, service mesh, sharding, event sourcing, CQRS-everywhere, or nanoservices."
---

# System Design Governance

## Source of truth

Каноническая программа: `M18_SYSTEM_DESIGN_SELECTIONS`. Перед существенным изменением прочитать её `README.md` и релевантные нормативные документы. Если этот skill противоречит канонической программе, **побеждает каноническая программа**, а skill должен быть обновлён.

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

- предлагается Redis/NoSQL/service mesh/sharding/gRPC/GraphQL/new broker/cache;
- меняется consistency/partitioning architecture;
- нужна оценка нового pattern из system-design sources.

## Hard rules

- Сначала описать bottleneck/guarantee, потом технологию.
- Capacity estimate и failure model обязательны для scale change.
- Предпочитать уже выбранные primitives, если они закрывают задачу.
- Redis добавлять только по измеримому distributed rate-limit/fanout/cache need.
- NoSQL/sharding/service mesh/event sourcing не добавлять “на будущее”.
- Microservice extraction — domain/operational reason, не размер файла.
- Push vs Pull выбирается по authority semantics: external system без event publisher требует authoritative pull/reconciliation.
- Formal methods/TLA+ применять точечно к критическим protocols (Payments/AROMA), не ко всей системе.

## Workflow

1. Сформулировать проблему и измеримый симптом.
2. Проверить, решается ли текущими Postgres/Kafka/Nginx/Node primitives.
3. Оценить consistency, failure, ops, cost, migration burden.
4. Сделать small benchmark/PoC, если решение performance-driven.
5. Записать accepted/deferred/rejected decision в M18/ADR.

## Минимальная проверка

Перед завершением:

1. проверить соответствие каноническому документу программы;
2. проверить, что не создана новая скрытая cross-boundary зависимость;
3. выполнить targeted unit/integration/contract tests;
4. выполнить architecture/boundary tests для затронутого слоя;
5. проверить Docker build/health, если изменён runtime workload;
6. проверить observability и failure semantics, если изменён I/O/async path;
7. явно записать skipped checks и остаточный риск.
