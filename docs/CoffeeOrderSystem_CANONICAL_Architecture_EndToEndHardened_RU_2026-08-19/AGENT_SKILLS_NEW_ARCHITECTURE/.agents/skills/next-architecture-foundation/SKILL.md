---
name: next-architecture-foundation
description: "Use for target architecture, clean-room repository layout, language/runtime ownership, program boundaries, supersession decisions, and any change that could alter the canonical migration architecture."
---

# Next Architecture Foundation

## Source of truth

Каноническая программа: `M00_ARCHITECTURE_FOUNDATION`. Перед существенным изменением прочитать её `README.md` и релевантные нормативные документы. Если этот skill противоречит канонической программе, **побеждает каноническая программа**, а skill должен быть обновлён.

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

- создаётся/перемещается target workload;
- меняется ownership языка/runtime;
- меняется структура `platform/edge/infra/hermes/training`;
- предлагается новый cross-cutting component или dependency;
- нужно решить, является ли решение target, temporary adapter или legacy.

## Hard rules

- `platform/**` — target TypeScript/React online platform; `src/**` — legacy/reference до cutover.
- PostgreSQL хранит business/process truth; Kafka не становится database truth.
- Nginx — public edge/strangler; React web runtime — внутренний static Nginx workload.
- Hermes — production agent runtime; AReaL — training-only.
- Docker image — обязательный deployment artifact; Kubernetes приходит после доказанного process/container split.
- Не добавлять технологию только ради унификации или “best practice”; нужна конкретная гарантия/проблема.
- Любое supersede старого решения фиксировать в supersession map.

## Workflow

1. Определить программу Mxx и будущего owner.
2. Сверить target diagram/repository layout/supersession map.
3. Зафиксировать allowed dependencies и prohibited dependencies.
4. Если решение меняет канон — обновить ADR/source-of-truth до кода.
5. Добавить architecture test или static boundary rule, если правило машинно проверяемо.

## Минимальная проверка

Перед завершением:

1. проверить соответствие каноническому документу программы;
2. проверить, что не создана новая скрытая cross-boundary зависимость;
3. выполнить targeted unit/integration/contract tests;
4. выполнить architecture/boundary tests для затронутого слоя;
5. проверить Docker build/health, если изменён runtime workload;
6. проверить observability и failure semantics, если изменён I/O/async path;
7. явно записать skipped checks и остаточный риск.
