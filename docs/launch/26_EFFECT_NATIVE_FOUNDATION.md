# Effect-native foundation: единая линия реализации

Этот документ является изменяемой нормативной спецификацией технического перехода после PR #22. Историческая issue #3 и её evidence не переписываются.

## Цель

До разработки Customer, Catalog, Pricing, Orders, AROMA и Realtime заменить набор независимых Fastify/Promise/OpenAPI/Temporal/Pino/TanStack решений одной Effect-native платформой без изменения бизнес-архитектуры.

## Неприкосновенные границы

- ровно 15 runtime;
- существующие bounded contexts и пять owner DB;
- запрет cross-owner SQL/imports;
- Edge → `api-public`, internal calls → `api-internal`;
- provider egress/credentials только Gateway;
- Orders-owned convergence;
- PostgreSQL durable truth;
- Kafka committed-fact/wake-up transport;
- Outbox/Inbox/Idempotency и Gateway journal остаются durable protocols;
- Node Permission Model, network segmentation, SOPS/age, mTLS/delegation сохраняются;
- unsafe AROMA mutation не получает automatic retry.

## Целевая техническая линия

```text
React / Effect Atom / AtomHttpApi
→ ClientApiV1
→ Edge HttpRouter
→ api-public HttpApi
→ owner HttpApi
→ Application Effect
→ owner Store
→ Effect SQL / PostgreSQL

Owner transaction
→ Outbox
→ Effect Kafka adapter
→ Kafka
→ consumer Inbox + owner transaction

Orders/Integration durable state
→ Effect orchestration
→ InternalApiV1
→ AROMA Gateway
→ provider
```

## Разделение кода runtime

```text
apps/<runtime>/src/
├── main.ts          # только NodeRuntime + root Layer
├── layer.ts         # единственная production composition boundary
├── transport/       # HttpApi/HttpRouter/Kafka adapters
├── application/     # Effect use cases
├── domain/          # pure state/functions/schemas
└── infrastructure/  # owner-local Stores/clients
```

Пустые каталоги не создаются заранее. `Effect.run*` запрещён вне `main.ts`, browser runtime root, tests и approved tooling. `Effect.provide`/Layer composition запрещены в application use cases.

## Контракты

Effect Schema и HttpApi — единственный source. Public, internal, events и runtime control contracts находятся в отдельных versioned packages. Generated OpenAPI 3.1/JSON Schema используются для документации, compatibility и внешней проверки, но production-код импортирует source schemas/API.

## Runtime

Каждый процесс запускается через `NodeRuntime.runMain(Layer.launch(MainLive))`. Root Scope владеет server listener, HTTP agents, DB pools, Kafka clients, queues, background fibers и OpenTelemetry providers. Liveness отражает root supervisor; readiness — фактическую готовность обязательных dependencies.

## SQL

Application use case зависит от owner Store, а не от generic SQL client. Store выполняет точную atomic operation через Coffee transaction policy. Все DB rows декодируются Schema. Direct driver доступен только `platform-database`. `TransactionOutcomeUnknown` является явным terminal technical result.

## Kafka

Один Confluent→Effect adapter. Producer/consumer scoped; consumer records — bounded Stream. Auto commit/topic creation запрещены. Offset следует за DB commit. Inbox/Outbox/Idempotency production state находится только в PostgreSQL.

## Frontend

Один browser runtime на вкладку. Remote state принадлежит AtomHttpApi, URL — React Router, form input — React local state. Mutation retry отсутствует. Browser обращается только к same-origin `client-v1`. EventSource оборачивается одним Effect Stream и только инвалидирует remote atoms.

## Переход

```text
#25 authority
#26 BOM/diagnostics/closed legacy inventory
#27 contract cutover
#28 runtime/HTTP/config/security/observability cutover
#29 DB cutover
#30 Kafka/durable protocols cutover
#31 frontend cutover
#32 clean admission и удаление inventory
```

Каждый cutover PR одновременно добавляет новый путь и удаляет заменённый. В `develop` не остаются feature flags и fallbacks.

## Обязательные machine checks

- exact Effect BOM и одна версия core;
- exact allowed/forbidden module families;
- owner-local Layer boundaries;
- no nested runtime/provide in application;
- no new Promise workflows in migrated roots;
- no direct drivers outside adapters;
- no in-memory durable state;
- no unsafe mutation retry;
- no internal contract in browser;
- no legacy dependency/path after its removal owner;
- E00–E15 pass на одном SHA перед #4.

## Handoff

Каждая задача создаёт `evidence/handoffs/issue-<N>.yaml` с predecessor SHA, входами, выходами, командами и downstream consumer. Следующая ветка создаётся только после accepted predecessor в `develop`; stacked work не принимается и не merge до выполнения этого условия.
