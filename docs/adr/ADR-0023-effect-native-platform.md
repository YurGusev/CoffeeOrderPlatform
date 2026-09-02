# ADR-0023: Effect-native платформа CoffeeOrderPlatform

- Статус: предлагается; становится принятой после merge issue #25
- Дата: 2026-09-02
- Владелец решения: Platform Architecture
- Предшественники: ADR-0019, ADR-0020, ADR-0021, ADR-0022, issue #3, PR #22

## Контекст

PR #22 материализовал запускаемый foundation из 15 Node.js runtime, Compose-топологию, PostgreSQL roles, Kafka, config/secrets bootstrap, Node Permission Model и архитектурные проверки. Бизнес-реализация Customer, Catalog, Pricing, Orders, AROMA convergence, Realtime и React-сценария ещё не создана.

Текущий foundation использует несколько независимых технических моделей: Fastify для HTTP/lifecycle, handwritten OpenAPI и Hey API для контрактов, Promise/AbortController для эффектов, собственные PostgreSQL/Kafka helpers, Temporal для времени, Pino для logging и планируемый TanStack Query для frontend remote-state. Продолжение разработки в таком виде приведёт к появлению параллельных моделей ошибок, ресурсов, DI, cancellation, validation и client state.

Effect 4 принимается до начала бизнес-кода, чтобы дальнейшие bounded contexts строились на одной execution model и не потребовали поздней миграции handlers, DTO, repositories, tests и frontend state.

## Решение

CoffeeOrderPlatform становится Effect-native платформой.

### Единые технические authority

| Область | Единственная authority после admission #32 |
|---|---|
| Effectful execution | `Effect` |
| Dependency injection | `Context.Service` и owner-local `Layer` |
| Process lifecycle | `NodeRuntime`, `Layer.launch`, `Scope` |
| Runtime validation | Effect `Schema` |
| HTTP contracts | Effect `Schema` + `HttpApi` |
| HTTP server/client | Effect `HttpRouter`, `HttpApi`, `HttpClient` |
| Streaming | Effect `Stream` |
| SQL | `@effect/sql-pg` и Coffee transaction policy |
| Time | Effect `Clock`, `DateTime`, `Duration`, `TestClock` |
| Observability | Effect logs/spans/metrics и `@effect/opentelemetry` |
| Backend tests | Vitest и `@effect/vitest` |
| Frontend remote-state | `@effect/atom-react` и `AtomHttpApi` |
| Durable state | PostgreSQL; Kafka только transport committed facts/wake-up |

Не создаётся внутренний framework-обёртка `platform-effect`, `coffee-effect` или общий `AppEffect`. Код использует публичные Effect API напрямую.

## Неприкосновенная бизнес- и distributed-архитектура

Переход не меняет:

1. Ровно 15 deployable runtime.
2. Bounded contexts Customer, Catalog, Pricing, Orders, Integration и Realtime.
3. Пять логических PostgreSQL DB, их владельцев и runtime roles.
4. Запрет cross-owner SQL и shared mutable business model.
5. `edge-gateway`, `api-public`, `api-internal` как отдельные trust surfaces.
6. Provider egress и credentials только у `aroma-gateway`.
7. Orders как владельца Desired, Observed, Attempt, Lease, Fence, Reservation и convergence decisions.
8. Integration DB operation journal как последний durable barrier перед AROMA.
9. PostgreSQL как источник бизнес-истины.
10. Kafka как транспорт committed facts и durable wake-up, но не business state.
11. Outbox, Inbox и Idempotency как project-owned durable protocols.
12. SOPS/age, scoped tmpfs secrets, mTLS/delegation, Docker segmentation и Node Permission Model.
13. React как presentation layer и server-owned `allowedActions`.
14. Запрет blind retry unsafe AROMA mutation.

Effect `Ref`, `Queue`, `Cache`, `Fiber` и `Schedule` не заменяют durable сущности PostgreSQL/Kafka.

## Exact BOM

После materialization задачи #26 используются только точные версии:

```text
effect@4.0.0-rc.112
@effect/platform-node@4.0.0-rc.112
@effect/platform-browser@4.0.0-rc.112
@effect/sql-pg@4.0.0-rc.112
@effect/opentelemetry@4.0.0-rc.112
@effect/atom-react@4.0.0-rc.112
@effect/vitest@4.0.0-rc.112
@effect/tsgo@0.39.0
pg-copy-streams@7.0.0
```

Сохраняются Node 26.8.1, TypeScript 7.0.2, Oxlint 1.80.0, oxlint-tsgolint 7.0.2001, PostgreSQL 17.11, pg 8.23.0, Kafka 4.3.1, Confluent client 1.10.0, librdkafka 2.15.0, React 19.2.8, React Router 7.18.3, Vite 8.2.2, Vitest 4.1.11 и Playwright 1.62.1.

Любое обновление Effect выполняется отдельным platform-only issue/PR без business changes. Все matching Effect packages обновляются одним набором; floating ranges запрещены.

## Разрешённая поверхность Effect

Разрешены:

```text
effect/*
effect/unstable/http/*
effect/unstable/httpapi/*
effect/unstable/sql/*
effect/unstable/encoding/*
effect/unstable/reactivity/*
@effect/platform-node
@effect/platform-browser
@effect/sql-pg
@effect/opentelemetry
@effect/atom-react
@effect/vitest
```

Без отдельного ADR запрещены:

```text
effect/unstable/rpc/*
effect/unstable/workflow/*
effect/unstable/cluster/*
effect/unstable/persistence/*
effect/unstable/eventlog/*
effect/unstable/ai/*
effect/unstable/cli/*
effect/unstable/workers/*
```

RPC дублировал бы `api-internal`; Workflow/Persistence/EventLog — PostgreSQL state machines, Outbox/Inbox и Kafka; Cluster — принятую deployment topology.

## Контракты

Единственный путь:

```text
Effect Schema + HttpApi source
→ runtime decode/encode
→ typed server handlers
→ typed HttpApi clients
→ generated OpenAPI 3.1 artifact
→ generated JSON Schema artifacts
→ fixtures и compatibility checks
```

`client-v1` и `internal-v1` остаются физически раздельными. Frontend не импортирует `internal-v1`. OpenAPI является производным compatibility/documentation artifact, а не source of truth. Handwritten OpenAPI, generated SDK/client, duplicated DTO, Zod mirror и AJV production mirror после cutover запрещены.

## PostgreSQL

Единственный путь:

```text
Application Effect
→ owner-local Store
→ Effect SQL statement + Schema row decoding
→ Coffee transaction policy
→ @effect/sql-pg
→ PostgreSQL
```

Прямой `pg` разрешён только внутри `platform-database`. Application-код не получает raw Pool/PoolClient и generic transaction callback. Каждый owner Store предоставляет точную atomic operation.

Прямой `SqlClient.withTransaction` запрещается: платформа обязана различать `NotStarted`, `Active`, `Committing`, `Committed`, `RollingBack`, `RolledBack`, `OutcomeUnknown`. Потеря соединения во время `COMMIT` не считается доказанным rollback и не вызывает generic retry.

Migration checksum policy остаётся project-owned. `COPY FROM STDIN` реализуется одним узким adapter внутри `platform-database`.

## Kafka и durable protocols

Confluent Kafka client остаётся единственным driver и скрывается внутри `platform-kafka-runtime`. Kafka consumer предоставляется как Effect Stream, producer — как Effect service; resources принадлежат Scope.

Offset commit допускается только после durable PostgreSQL result. Inbox business effect и `Processed` выполняются одной owner transaction. Outbox retry state, leases и attempts живут в PostgreSQL. Effect Schedule задаёт polling, но не является durable retry store.

## Frontend

Единственный remote-state путь:

```text
React + React Router
→ один browser Effect/Atom runtime на вкладку
→ AtomHttpApi
→ ClientApiV1
```

Form state остаётся локальным React state, URL state — React Router. Mutations не имеют automatic retry. Ambiguous mutation сохраняет тот же idempotency intent. SSE только инвалидирует owner resource и запускает refetch; frame не становится business state.

## Правило cutover

Каждая задача #27–#31 владеет одной технической областью:

```text
старый путь остаётся единственным до owning PR
→ новый Effect-path реализуется и проверяется
→ старый путь удаляется в том же PR
→ feature flag, fallback и dual-run не остаются в develop
```

До #32 существующий legacy foundation фиксируется закрытым inventory и не может расширяться. #32 удаляет inventory и доказывает отсутствие двойных решений.

## Линия поставки

```text
#3 / PR #22
→ #25 [3.1] authority
→ #26 [3.2] BOM, diagnostics, architecture guards
→ #27 [3.3] Schema/HttpApi contract platform
→ #28 [3.4] runtime/HTTP/config/security/observability cutover
→ #29 [3.5] PostgreSQL/migrations/COPY cutover
→ #30 [3.6] Kafka/Idempotency/Inbox/Outbox cutover
→ #31 [3.7] frontend Atom cutover
→ #32 [3.8] admission/no-legacy proof
→ #4 contracts
→ существующая business-линия
```

#4 не начинается до решения `ДОПУСТИТЬ EFFECT FOUNDATION` в #32.

## Последствия

Положительные:

- один error, resource, cancellation, DI, time и streaming model;
- typed requirements усиливают owner/capability boundaries;
- contract server/client/runtime validation строятся из одного определения;
- меньше собственных Promise/Abort/lifecycle abstractions;
- TestClock и scoped resources упрощают failure/recovery tests;
- переход выполняется до появления основного business-кода.

Риски:

- Effect 4 находится в RC, а HTTP/SQL/reactivity API пока `unstable`;
- повышается требование к дисциплине Layer composition и Effect diagnostics;
- обновление зависимостей требует полного foundation regression run.

Контроль рисков:

- exact pins и единая версия;
- точный import allowlist;
- обязательные RED fixtures;
- отдельные upgrade PR;
- E00–E15 admission;
- отсутствие automatic dependency upgrade.

## Отклонённые варианты

1. Effect только как retry/helper поверх Fastify/Promise — создаёт двойную execution model.
2. Fastify boundary + ManagedRuntime на каждый request — оставляет два lifecycle/HTTP stack.
3. Effect RPC/Workflow/Persistence — дублирует принятые service/state boundaries.
4. Поздняя миграция после Customer/Catalog/Orders — потребует переписать handlers, DTO, repositories, tests и frontend.

## Rollback

До merge #32 rollback выполняется возвратом всей линейки Effect foundation, а не сохранением параллельного runtime. После начала business implementation rollback требует нового ADR, потому что Effect становится contract/runtime/SQL authority.
