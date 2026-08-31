# План реализации

## Цель

Быстро получить демонстрируемый вертикальный срез, построенный по production-
принципам, при этом любое небезопасное поведение провайдера закрывается отказом.

## Дни 1–2: контракты и каркас

- repository/app/package layout;
- OpenAPI and event schemas for launch routes/messages;
- Docker Compose с подключением к существующему PostgreSQL, а также Kafka и observability;
- provisioning отдельных БД/ролей новой платформы без изменения `coffeeorderdb`;
- shared HTTP, DB, Outbox/Inbox, auth and telemetry runtimes;
- React shell and generated mock client.

## Дни 3–5: Customer, Catalog, Pricing

- Customer create/search;
- safe full AROMA catalog snapshot through Gateway;
- persisted product/mapping/availability search;
- PricingQuote creation and validation;
- frontend customer/catalog/order-draft screens.

## Дни 6–8: Orders

- Draft/items/version/history;
- quote/product snapshots;
- atomic Confirm + Desired + Outbox;
- Order Card and SSE invalidation;
- lifecycle, idempotency and concurrency tests.

## Дни 9–11: корзина AROMA

- Gateway session and typed operations;
- observer;
- preparation and convergence workers;
- lease/fencing/reservation/UnknownOutcome;
- GET-mutate-GET verification and recovery tests.

## Дни 12–14: усиление надёжности и демонстрация

- E2E browser flow;
- duplicate/crash/restart/provider-timeout tests;
- dashboards and alerts;
- backup/restore smoke;
- security review of credentials and public routes;
- operator demo with a controlled provider sandbox/account.

## Условия допуска к запуску

- no public `internal-v1` or Gateway route;
- Confirm contains no provider/network call;
- no blind retry after unsafe mutation timeout;
- duplicate messages and commands have no duplicate business effect;
- stale fence cannot mutate/persist success;
- source/export amounts and versions use decimal strings;
- OpenAPI, event schemas, integration tests and Playwright pass;
- every runtime has health, metrics, trace and graceful shutdown;
- rollback is disabling convergence mutation while preserving observer and
  all durable Order/attempt state.

## Параллельная работа

Frontend начинается в первый день на основе OpenAPI mocks. Backend и интеграция
с провайдером разрабатываются независимо по одним контрактам. Живая мутация
AROMA остаётся выключенной до успешных safety/failure tests; безопасные чтения
каталога и корзины можно подключить раньше.
