# Задание для AI coding agent

Реализуй новый React operator UI экрана «Счета и заказы» в CoffeeOrderPlatform по agent-ready макету `docs/frontend/prototypes/invoice-orders-workspace/v1.1.0/`. Обязательная иерархия: `счёт → заказы счёта → раскрываемые товары заказа`.

## Authority

Прочитай и соблюдай:

1. repository `AGENTS.md`;
2. `docs/launch/07_FRONTEND_CONTRACT.md`;
3. `docs/launch/17_ORDERS_IMPLEMENTATION_SPEC.md`;
4. `docs/launch/18_FRONTEND_IMPLEMENTATION_SPEC.md`;
5. `docs/frontend/prototypes/invoice-orders-workspace/v1.1.0/AGENT_HANDOFF.md`;
6. `docs/frontend/prototypes/invoice-orders-workspace/v1.1.0/ui-contract.json`;
7. `docs/frontend/prototypes/invoice-orders-workspace/v1.1.0/DESIGN.md`;
8. `docs/frontend/prototypes/invoice-orders-workspace/v1.1.0/COMPONENT_MAP.md`;
9. `docs/frontend/prototypes/invoice-orders-workspace/v1.1.0/ACCEPTANCE.md`.

`index.html` — исполняемый visual/interaction reference. `exact-source.css` — точный presentation layer. Не переноси React/API/state/domain/runtime из legacy CoffeeOrderSystem.

## Scope

Сначала проверь, существуют ли React runtime/dependencies, accepted registry route и Orders list contract. Не добавляй dependency, framework, public API или schema без разрешения владельца.

Если registry contract отсутствует:

- не создавай production `/app/orders` на mock данных;
- реализуй только согласованный fixture/story или Order Card route `/app/orders/:orderRef`;
- зафиксируй owner projection `invoice → orders`, payment и registry route как contract gaps;
- не делай browser fan-out и cross-owner join.

## Non-negotiable implementation rules

- используй generated `client-v1` transport types через project-owned fetch client;
- runtime validate every response;
- TanStack Query владеет server state;
- owner response владеет identity, money, version, projectionVersion, status и allowedActions;
- mutation: `expectedVersion` + `Idempotency-Key`; item upsert также quote proof;
- browser не считает authoritative total и не выводит действия из status;
- `UnknownOutcome` не имеет blind retry;
- SSE только invalidates/refetches;
- invoice/payment не добавляются в `OrderCardResponse` без owner contracts;
- не строй invoice groups клиентским join или browser fan-out;
- используй stable `data-ui` hooks;
- сохрани точные fonts/tokens/density/shell/table/drawer из макета;
- desktop monitor support: от 1024×600 до 3840×2160, включая live resize;
- рассчитывай высоту registry/composer из фактического viewport; не показывай частично обрезанные товарные строки;
- при скрытом продолжении выводи `registry-scroll-hint` с отдельными vertical/horizontal actions или `items-scroll-hint`, а не полагайся на невидимый scrollbar;
- mobile 375/430 — diagnostic only.

## Required states

Loading, empty, validation, Problem Details, pending mutation, stale quote, version conflict, provider unavailable, route-fatal 401/403/404, а также все AROMA states: `NotRequested`, `PendingObservation`, `OutOfSync`, `Converging`, `InSync`, `Blocked`, `UnknownOutcome`.

## Required verification

- выполни все применимые критерии `ACCEPTANCE.md`;
- unit/contract tests для codecs, action gating и bigint-safe money formatting;
- Playwright для invoice disclosure, связи заказов с родительским счётом, раскрытия товаров заказа, add/edit/delete/quantity, confirm, drawer focus/Escape/scrim/return focus, conflict и UnknownOutcome;
- served screenshots после последнего CSS/font/layout изменения;
- console/page/network failures = 0;
- lint, typecheck, tests и project checks;
- не заявляй WCAG PASS без полного аудита.

## Deliverable

Рабочая локальная реализация и короткий handoff: изменённые файлы, contract gaps, команды и фактические результаты проверок. Не commit/push/PR без отдельного разрешения владельца.
