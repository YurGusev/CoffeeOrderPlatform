# 03. Копирование существующего React frontend в новую архитектуру

## 1. Решение

Существующий `src/CoffeeOrderSystem.Web` **не переписывается с нуля**. Он становится исходной реализацией нового frontend и переносится в clean-room TypeScript monorepo методом copy-first handover:

```text
src/CoffeeOrderSystem.Web
        |
        | exact controlled copy
        v
platform/apps/web
        |
        | detach from C# build artifacts
        v
platform-owned React application
```

Цель — сохранить уже реализованные Orders/Products/Customers/Invoices/Work Center UI, UX, accessibility, CSP, E2E и bundle budgets, одновременно убрать физическую зависимость frontend toolchain от `src/` и ASP.NET build tree.

## 2. Что уже существует и переносится

В существующем React приложении уже есть самостоятельный frontend toolchain и production artifacts. Переносить нужно **код и проверки**, а не только JSX/TSX:

```text
app/
features/
shared/
routes/
e2e/
.storybook/
scripts/
public/                 если существует
package.json
pnpm-lock.yaml
pnpm-workspace.yaml
react-router.config.*
vite/test configs
eslint.config.mjs
playwright.config.ts
Dockerfile
nginx.conf
README.md
```

Не копируются:

```text
node_modules/
build/
dist/
test artifacts/browser traces
локальные secrets/.env
временные logs
```

## 3. Целевое расположение

```text
platform/
├── apps/
│   ├── web/                    # перенесённый React frontend
│   ├── api/
│   ├── channel-ingress/
│   ├── channel-egress/
│   ├── realtime-gateway/
│   └── hermes-dispatcher/
├── modules/
│   ├── customer/
│   ├── catalog/
│   ├── orders/
│   ├── invoices/
│   ├── payments/
│   └── aroma/
└── packages/
    ├── contracts/
    ├── http-client/
    ├── observability/
    ├── config/
    └── testkit/
```

Frontend находится в общем TypeScript workspace, но **не импортирует domain implementation packages**. Он может зависеть только от frontend/shared primitives и language-neutral/generated contracts.

## 4. Почему copy-first лучше rewrite

Rewrite потеряет уже проверенные свойства:

- route behavior;
- accessibility/keyboard behavior;
- CSP generation/tests;
- Orders workflows;
- guarded mutations и fresh-read recovery;
- OpenAPI-generated DTO behavior;
- Playwright regression scenarios;
- bundle budgets;
- Storybook/shared UI;
- current operator UX.

Copy-first сохраняет эту evidence base и позволяет сосредоточить риск на **смене backend ownership**, а не одновременно переписывать UI и backend.

## 5. Единственный допустимый момент двойной React-кодовой базы

После initial copy некоторое короткое время существуют:

```text
src/CoffeeOrderSystem.Web        # current source
platform/apps/web                # candidate source
```

Это переходное состояние, а не новая долгосрочная архитектура.

Правило:

> После создания target copy новые product features не реализуются независимо в двух деревьях.

Допускаются только:

- critical fixes, синхронно применяемые в обоих деревьях до handover;
- migration-only changes в target;
- parity fixes.

После web cutover `platform/apps/web` становится единственным source tree, а старый `src/CoffeeOrderSystem.Web` замораживается и удаляется после soak.

## 6. Самая важная зависимость, которую нужно разорвать

Текущий frontend генерирует `client-v1` непосредственно из ASP.NET build artifact вида:

```text
../CoffeeOrderSystem.API/obj/openapi/...client-v1.json
```

Это нельзя сохранять в clean-room target.

Вместо этого:

```text
contracts/openapi/client-v1.json
          |
          +-- legacy C# contract export during migration
          |
          +-- target TS contract export after ownership cutover
          v
platform/apps/web generated client
```

Frontend должен знать **контракт**, а не язык backend, проект `.csproj` или путь `obj/`.

## 7. Contract handover

Этапы:

### F0 — snapshot

Зафиксировать immutable source commit React frontend и OpenAPI contract hash.

### F1 — exact copy

Скопировать дерево в `platform/apps/web` без архитектурной переработки.

Первый gate:

```text
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm bundle:check
pnpm test:e2e
```

Результат должен совпадать с source build.

### F2 — workspace adaptation

- package name/path;
- root pnpm workspace;
- Docker build context;
- CI paths;
- Storybook paths;
- test paths.

Product behavior не меняется.

### F3 — contract decoupling

Заменить прямой путь к ASP.NET `obj/openapi` на versioned contract artifact.

### F4 — web image parity

Собрать отдельный `coffee-platform-web:<digest>` и запустить рядом со старым React image.

### F5 — Nginx web cutover

Переключить только `/app/*` со старого `reactweb` на `platform-web`.

API всё ещё может оставаться C#:

```text
Browser -> Nginx -> platform-web
Browser -> Nginx /api -> C# API
```

Это критически полезно: frontend physical migration отделена от backend rewrite.

### F6 — soak и source handover

После подтверждения Web Vitals/E2E/errors/rollback:

```text
platform/apps/web = canonical
src/CoffeeOrderSystem.Web = frozen legacy copy
```

### F7 — deletion

Старая папка удаляется после agreed soak и отсутствия CI/runtime references.

## 8. Hosting pattern при копировании

Существующий Docker pattern нужно **сохранить в первой версии**:

```text
Build stage  -> Node.js + pnpm + React/Vite/React Router
Runtime      -> internal Nginx serving static build
```

Это уже соответствует SPA Mode и не требует Node server в production только ради static assets.

Target image:

```text
platform/apps/web/Dockerfile
```

первоначально должен быть функционально эквивалентен текущему image, с изменёнными workspace paths.

## 9. Два Nginx — это не дублирование ответственности

```text
coffee-edge             public Nginx
  -> TLS / routing / strangler / rate limits / API proxy

platform-web            internal static Nginx
  -> React files / SPA fallback / immutable assets / frontend CSP
```

Они имеют разные trust boundary и release lifecycle.

## 10. Почему не переносить static files прямо в `coffee-edge`

Можно технически, но separate web image лучше для миграции:

- React и edge имеют независимые image digests;
- frontend можно rollback независимо;
- edge config не пересобирается при каждом UI release;
- Kubernetes scaling/release units остаются чистыми;
- текущая архитектура уже следует такому separation.

## 11. Node React server/SSR — не первый этап

Не вводить runtime Node web server одновременно с copy и backend migration.

Если позже понадобится SSR/streaming/server loaders, контракт `/app/* -> platform-web` остаётся тем же, а внутренняя реализация `platform-web` меняется отдельным ADR:

```text
internal static Nginx
        ->
Node.js React Router server
```

Frontend бизнес-архитектура и public edge при этом не переписываются.

## 12. React API migration

После frontend handover API routes можно переключать независимо:

```text
/app/*              -> platform-web
/api/catalog/*      -> C# или TS
/api/customers/*    -> C# или TS
/api/orders/*       -> C# или TS
```

React не должен знать, какой backend обслуживает конкретную family.

## 13. Realtime migration

Сначала существующий polling/fresh-read behavior сохраняется.

После готовности Node Realtime Gateway:

```text
React
  <- SSE invalidation /events/*
  -> invalidate TanStack Query
  -> GET authoritative /api/*
```

Не менять frontend сразу на WebSocket и не передавать full domain truth через realtime channel.

## 14. Migration tests

Обязательные проверки старого и target web images:

- same canonical routes;
- deep-link refresh;
- generated API request shape;
- authentication/session behavior;
- Orders command safety;
- file upload workflows;
- CSP/security headers;
- accessibility;
- Playwright functional suite;
- bundle budget;
- Web Vitals baseline;
- Nginx cache semantics;
- rollback `/app/*` route.

## 15. Definition of Done frontend handover

- [ ] target copy builds independently от `.NET obj/`;
- [ ] `platform/apps/web` входит в root pnpm workspace;
- [ ] OpenAPI artifact language-neutral;
- [ ] all source tests pass;
- [ ] target Docker image passes health/CSP/bundle checks;
- [ ] Nginx can route `/app/*` to old or new web image;
- [ ] production-like parity proven;
- [ ] rollback tested;
- [ ] old React tree frozen;
- [ ] no new features land in old tree;
- [ ] old tree deletable after soak.
