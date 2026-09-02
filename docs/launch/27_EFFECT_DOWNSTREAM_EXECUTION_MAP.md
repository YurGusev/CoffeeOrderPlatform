# Карта перехода downstream-задач на Effect-native foundation

## Назначение

Документ устраняет технический drift в открытых issue первого запуска до их полного исполнения. Он **не меняет бизнес-scope** задач, их маршруты, state machines, владельцев данных, ограничения безопасности, failure semantics и критерии продукта. Он заменяет только прежний технический способ реализации.

Обязательный predecessor каждой задачи #4–#13 и #16–#18 — accepted issue #32 и handoff `evidence/handoffs/issue-32.yaml`, помимо уже перечисленных business predecessors.

## Общая замена

| Старое требование | Обязательный Effect-native путь |
|---|---|
| Fastify route/server/lifecycle | Effect `HttpApi`/`HttpRouter`, `NodeHttpServer`, `NodeRuntime`, `Layer`, `Scope` |
| Handwritten OpenAPI 3.2 source | Effect `Schema` + `HttpApi`; generated OpenAPI 3.1/JSON Schema — artifacts |
| Hey API generated DTO/client | Typed `HttpApiClient` из source API; generated SDK/DTO отсутствуют |
| AJV production validation | Effect Schema decode/encode |
| Native fetch/custom HTTP wrapper | Effect `HttpClient` и typed `HttpApiClient` |
| Promise/AbortController orchestration | Effect/Fiber/Scope/Clock/Schedule/Stream |
| Temporal/platform-time | Effect `Clock`, `DateTime`, `Duration`, `TestClock` |
| Pino/custom Logger API | Effect logs/spans/metrics + `@effect/opentelemetry`; project redaction policy сохраняется |
| Direct `pg` repositories | owner-local Store → Effect SQL → Coffee transaction policy → PostgreSQL |
| TanStack Query/QueryClient | `@effect/atom-react` + `AtomHttpApi` |
| `node:test` application/runtime suites | Vitest + `@effect/vitest`; Playwright остаётся browser E2E |

## Задача #4 — launch contracts

- Единственный source: versioned Effect Schema/HttpApi packages.
- Сохранить exact public/internal routes, DTO semantics, Problem Details, seven launch events, SSE и NDJSON inventory.
- Генерировать deterministic OpenAPI 3.1 и JSON Schema artifacts; handwritten OpenAPI/Hey API/generated DTO удалить.
- Public/internal package boundary и audience/operation metadata остаются fail-closed.

## Задача #5 — Customer

- HTTP provider — Customer HttpApi handlers.
- Application use cases возвращают typed Effect errors и зависят только от owner services.
- PostgreSQL — Customer Store на Effect SQL; create/idempotency/audit выполняются точными atomic Store operations.
- Нормализация, уникальные constraints, PII masking, exact search и Customer-owned DB/role не меняются.

## Задача #6 — Catalog ingestion

- Gateway NDJSON читается Effect Stream с end-to-end backpressure.
- Каждый batch декодируется Effect Schema и сохраняется через единственный `PgCopy` adapter в Coffee transaction policy.
- Следующий batch не читается до commit предыдущего.
- Active Catalog, Kafka publication и Pricing API остаются вне задачи.

## Задача #7 — Pricing

- Catalog reads выполняются typed InternalApiV1 client Effects с bounded concurrency 8.
- Mixed revision обрабатывается одним явным повтором всей группы, а не generic retry.
- Расчёт остаётся pure bigint logic.
- Persist quote — exact atomic Pricing Store operation; HTTP отсутствует внутри DB transaction.

## Задача #8 — Orders

- Draft/items/Confirm — Effect use cases над owner-local Stores.
- Requirements Confirm не содержат Customer/Pricing/AROMA/Kafka/FileSystem.
- Confirm atomic Store сохраняет Order, history, contribution, Outbox и idempotency одной transaction.
- Order/version/projection/Desired/Observed ownership и state semantics не меняются.

## Задача #9 — React flow

- React Router остаётся URL authority.
- Remote queries/mutations выполняются `AtomHttpApi`; один browser runtime на вкладку.
- Mutations имеют zero automatic retry; ambiguous intent сохраняет тот же Idempotency-Key.
- Server response/allowedActions остаются единственным business-state source.

## Задача #10 — AROMA Gateway

- Provider transport использует Effect HttpClient/Stream с fixed origin, redirect deny, scoped session и redaction.
- Capabilities разделены на CatalogReader, CartReader и CartMutator.
- Safe GET получает только explicit bounded retry policy.
- Unsafe mutation не получает `Effect.retry`; journal `Dispatched` остаётся durable barrier.

## Задача #11 — AROMA convergence

- Worker/heartbeat/current attempt исполняются scoped Fibers и TestClock-compatible schedules.
- Attempt, Lease, Fence, Desired, Observed и Reservation остаются PostgreSQL entities.
- Fiber не является durable workflow.
- UnknownOutcome/recovery/fresh GET/no old operationRef replay не меняются.

## Задача #12 — Realtime

- Kafka consumer — Effect Stream через единый Confluent adapter.
- Fanout использует bounded process-local queues и scoped connection fibers.
- SSE строится `StreamSse`; disconnect прерывает fiber.
- Browser EventSource adapter инвалидирует AtomHttpApi resource и не хранит business state.

## Задача #13 — launch verification

- G00–G19 дополнительно принимают handoff #32.
- Проверки ищут отсутствие Fastify/Hey API/Temporal/Pino/TanStack/parallel Promise stack.
- Добавляются Effect Layer, diagnostics, Scope/finalizer, SQL transaction unknown, Stream/backpressure и Atom checks.
- Смысл fail-closed launch decision не меняется.

## Задача #16 — Catalog activation

- Worker — root Effect program с DB work из durable queue.
- Activation выполняется exact CatalogActivationStore atomic operation.
- Outbox создаётся в той же transaction; Kafka publish после commit.
- Provider HTTP и import responsibilities остаются запрещены.

## Задача #17 — Catalog API

- Client/internal endpoints — Catalog HttpApi groups.
- Read-only Catalog Store использует Effect SQL и active revision only.
- Keyset pagination, cursor signature, visibility и no-supplier-private-fields сохраняются.

## Задача #18 — Catalog verification

- Effect test Layers/TestClock дополняют, но не заменяют real PostgreSQL/provider/stream/restart tests.
- Проверяется Scope cleanup, interruption и bounded memory Stream/COPY pipeline.
- Capacity/failure gates и запрет скрытых fixes остаются.

## Запрещённые обходы

- Нельзя начать business issue до #32.
- Нельзя оставить Fastify или Promise fallback «временно» внутри business PR.
- Нельзя создавать owner-specific альтернативный HTTP/SQL/Kafka/frontend stack.
- Нельзя использовать Effect RPC/Workflow/Persistence/EventLog/Cluster вместо принятых boundaries.
- Нельзя ослаблять provider mutation safety, DB ownership, mTLS/delegation, Node Permission Model или secret scopes.

## Handoff

Каждый downstream PR обязан в handoff указать:

```yaml
inputs:
  - issue: 32
    artifact: evidence/handoffs/issue-32.yaml
```

и доказать отсутствие запрещённого старого пути в затронутом source root.
