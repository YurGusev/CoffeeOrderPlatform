---
name: next-react-handover
description: "Use for copying, moving, adapting, testing, or cutting over the existing React frontend from src/CoffeeOrderSystem.Web to platform/apps/web without rewriting it."
---

# React Copy-First Handover

## Source of truth

Каноническая программа: `M01_FRONTEND_HANDOVER`. Перед существенным изменением прочитать её `README.md` и релевантные нормативные документы. Если этот skill противоречит канонической программе, **побеждает каноническая программа**, а skill должен быть обновлён.

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

- копируется/перемещается существующий React;
- меняется `platform/apps/web`;
- меняются generated API contracts/frontend API source;
- меняется internal `platform-web` Docker/Nginx hosting;
- переключается `/app/*` на новый image.

## Hard rules

- Copy-first, не rewrite-first.
- Короткий handover: нельзя долго развивать две React-кодовые базы параллельно.
- Сохранить React Router SPA mode, Vite, TanStack Query/Table, testing/CSP/bundle gates до отдельного ADR.
- Node используется build-stage; production SPA отдаётся internal Nginx. Не добавлять Node SSR server без отдельной измеримой причины/ADR.
- Frontend зависит только от language-neutral client contracts и browser infrastructure, не от backend implementation packages.
- Отвязать `api:generate` от `CoffeeOrderSystem.API/obj`; источник OpenAPI должен стать neutral contract artifact.
- Public gateway = `coffee-edge`; `platform-web` не публикует host port наружу.

## Workflow

1. Снять baseline текущего React: lockfile, build hash, CSP, bundle, route list, Playwright.
2. Сделать controlled copy в `platform/apps/web` без feature rewrite.
3. Исправить workspace-relative paths и contract generation.
4. Запустить parity build/typecheck/lint/unit/E2E/bundle/CSP.
5. Собрать новый `platform-web` image.
6. Переключить `/app/*` через Nginx route cutover.
7. После soak заморозить и удалить старый React source.

## Минимальная проверка

Перед завершением:

1. проверить соответствие каноническому документу программы;
2. проверить, что не создана новая скрытая cross-boundary зависимость;
3. выполнить targeted unit/integration/contract tests;
4. выполнить architecture/boundary tests для затронутого слоя;
5. проверить Docker build/health, если изменён runtime workload;
6. проверить observability и failure semantics, если изменён I/O/async path;
7. явно записать skipped checks и остаточный риск.

## Дополнительные проверки

Обязательны route parity, deep-link refresh, CSP, immutable assets, auth/session behavior, API error mapping, Playwright critical flows и bundle budget.


## M19 API Architecture

API contract authority — M19 `client-v1` + language-neutral registry. Не возвращать dependency на ASP.NET `obj/openapi`.


## BusinessLogicHardened service graph

Если задача меняет Orders/Catalog/AROMA/Invoices/Payments interaction, дополнительно активировать `next-business-orchestration` и проверить M20. Target не имеет direct Draft `sendToAromaCart`; `Confirm -> Desired -> Convergence` является нормальным supplier path.
