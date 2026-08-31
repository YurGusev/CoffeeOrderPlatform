---
name: next-typescript-platform
description: "Use for target TypeScript/Node.js backend platform, bounded modules, API adapters, shared packages, Fastify-first services, and dependency direction under platform/."
---

# TypeScript Platform Development

## Source of truth

Каноническая программа: `M04_TYPESCRIPT_PLATFORM`. Перед существенным изменением прочитать её `README.md` и релевантные нормативные документы. Если этот skill противоречит канонической программе, **побеждает каноническая программа**, а skill должен быть обновлён.

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

- любая business/application разработка в `platform/**`;
- новый bounded context/module/use case/API;
- общий package/contracts/security/observability;
- Node transport or Hermes dispatcher code.

## Hard rules

- TypeScript strict; запрещать `any` без локально документированной причины.
- `noUncheckedIndexedAccess` и `exactOptionalPropertyTypes` сохраняются.
- Runtime validation обязательна на HTTP/Kafka/provider boundaries; TS types не заменяют validation.
- Business modules не импортируют private internals друг друга.
- Не создавать `shared-domain`, `common-business`, generic manager/helper packages.
- HTTP controllers/handlers тонкие; business decision живёт в application/domain.
- Money не хранится/вычисляется как JS floating `number`; использовать minor units bigint/Decimal contract.
- UTC instant, calendar date и local business time моделируются явно.
- CPU-heavy работу не держать на Node event loop; выносить в bounded worker pool или отдельный workload.
- Fastify является baseline; NestJS требует отдельного ADR.
- Любой production Node workload также требует `next-nodejs-runtime`.
- `api-public`, `api-agent`, `api-internal` являются отдельными composition roots/process roles.
- Arbitrary `fetch()` в application/domain запрещён; использовать typed provider clients.
- DB pool/concurrency рассчитывать fleet-wide, а не per-process изолированно.

## Workflow

1. Определить bounded context и public contract.
2. Создать vertical slice: contract → handler/use case → domain → repository adapter.
3. Добавить runtime validation и ProblemDetails/error codes.
4. Добавить auth/actor boundary.
5. Добавить unit + integration + contract test.
6. Проверить dependency graph и container runtime.

## Минимальная проверка

Перед завершением:

1. проверить соответствие каноническому документу программы;
2. проверить, что не создана новая скрытая cross-boundary зависимость;
3. выполнить targeted unit/integration/contract tests;
4. выполнить architecture/boundary tests для затронутого слоя;
5. проверить Docker build/health, если изменён runtime workload;
6. проверить observability и failure semantics, если изменён I/O/async path;
7. явно записать skipped checks и остаточный риск.


## API changes

Любое изменение HTTP/webhook/provider/Kafka/realtime contract дополнительно требует `next-api-architecture`. M19 является authority по surface/trust/versioning; этот skill отвечает за TypeScript implementation quality.


## Node runtime coordination

Для любого production Node/Fastify/Kafka/SSE/Hermes Dispatcher workload обязательно активировать `next-nodejs-runtime`. Он является authority по event loop, cancellation, connection/memory budgets, process model и graceful lifecycle.


## BusinessLogicHardened service graph

Если задача меняет Orders/Catalog/AROMA/Invoices/Payments interaction, дополнительно активировать `next-business-orchestration` и проверить M20. Target не имеет direct Draft `sendToAromaCart`; `Confirm -> Desired -> Convergence` является нормальным supplier path.
