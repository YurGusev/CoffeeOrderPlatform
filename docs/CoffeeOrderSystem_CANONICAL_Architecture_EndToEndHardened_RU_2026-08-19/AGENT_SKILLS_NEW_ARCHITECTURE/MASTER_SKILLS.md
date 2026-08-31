# MASTER SKILLS — EndToEndHardened

Всего target-only skills: **26**.


---

## next-api-architecture

---
name: next-api-architecture
description: "Use for any target CoffeeOrderSystem API change: client-v1, agent-v1, internal-v1, webhooks/callbacks, partner/provider APIs, Kafka event APIs, realtime SSE/WebSocket, OpenAPI/JSON Schema contracts, auth/trust, versioning, idempotency, UnknownOutcome, or C#→TypeScript API cutover."
---

# Next API Architecture

## Source of truth

Каноническая программа: `M19_API_ARCHITECTURE`.

Перед изменением API прочитать:

1. `M19_API_ARCHITECTURE/README.md`;
2. релевантный документ M19;
3. owning bounded-context program;
4. M03 при public route/cutover;
5. M06 при Kafka event API;
6. M15 при security/reliability/load semantics.

Если skill противоречит M19, побеждает M19 и skill должен быть обновлён.

## Use when

- создаётся/меняется `/api/client-v1`, `/api/agent-v1`, `/api/internal-v1`;
- меняется React generated OpenAPI client;
- добавляется webhook/callback;
- добавляется/меняется AROMA/VK/PSP provider API adapter;
- меняется Kafka topic/event schema/key/audience;
- меняется SSE/WebSocket contract;
- меняются auth/service identity/Channel Identity semantics;
- меняются error codes, `409`, idempotency или UnknownOutcome;
- выполняется C#→TypeScript route/API cutover;
- добавляется GraphQL/gRPC/SOAP или другой новый transport proposal.

## Classification first

Перед edits ответить:

```text
Actor: browser | Hermes | internal workload | provider | Kafka consumer
Trust surface: client-v1 | agent-v1 | internal-v1 | webhook | outbound provider | event | realtime
Transport: HTTP | SSE | WebSocket | Kafka | provider-specific
Owner bounded context: ...
Public/private: ...
Auth: ...
Idempotency/retry semantics: ...
Version/contract artifact: ...
```

Не начинать реализацию без owner/trust classification.

## Hard rules

- OpenAPI — specification format, не classification `Open API`.
- `client-v1`, `agent-v1`, `internal-v1` не объединять.
- `client-v1`, `agent-v1`, `internal-v1` имеют отдельные Node/Fastify composition roots/process roles.
- HTTP runtime использует shared Fastify factory, request/response schemas, explicit proxy trust, AbortSignal deadlines и graceful close.
- Application/domain code не делает arbitrary `fetch`; provider clients имеют fixed origin/connection pool.
- `agent-v1` и `internal-v1` не публиковать public edge.
- React не вызывает provider APIs напрямую.
- Hermes использует `agent-v1`, а не `client-v1`/admin API.
- LLM/model не выбирает customer/VK identity, arbitrary URL/method/header/provider credential.
- Provider webhook получает exact route + provider verification, а не generic untrusted webhook proxy.
- Kafka event schema считается API contract и versioned/compatible.
- Transaction-bound event = local DB + Outbox + CDC, не `commit -> producer.send()`.
- Cross-service database access не считается API и запрещён как substitute contract.
- n8n не пишет domain DB напрямую.
- Nginx владеет edge routing/coarse limits, но не business authorization.
- GraphQL/gRPC/SOAP/service-mesh-like API additions требуют measured/partner-driven ADR, не preference.

## HTTP surface rules

### `client-v1`

- browser-safe DTO;
- user/session auth;
- CSRF для cookie unsafe methods;
- explicit command endpoints для lifecycle transitions;
- server authoritative price/status/permissions/customer ownership;
- stable ProblemDetails/errorCode.

### `agent-v1`

- dedicated Hermes service identity;
- minimal capability set;
- trusted conversation/channel identity injected runtime-side;
- no arbitrary Customer selectors;
- explicit confirmation/idempotency semantics;
- tools do not auto-generate from entire OpenAPI.

### `internal-v1`

- private network;
- per-workload service identity/audience;
- no public Nginx route;
- no generic admin dump surface.

## Webhook/provider rules

Inbound webhook/callback:

```text
verify provider
validate size/schema
stable dedupe/replay identity
persist/durable accept
fast ACK
async work downstream
```

Payment redirect is not payment proof.

Outbound unsafe provider call requires idempotency/UnknownOutcome/reconciliation policy.

## Event API rules

Every Kafka event/topic declares:

- owner;
- producer/consumer audience;
- key/ordering;
- envelope/schemaVersion;
- PII classification;
- retention/replay;
- compatibility.

Event = past-tense fact. Async command = requested action. Do not blur semantics.

## Realtime rules

SSE is default for server→browser invalidation/status.

Realtime event is hint:

```text
hint -> invalidate query -> fresh client-v1 GET
```

Do not make SSE cache/business truth.

WebSocket only for real duplex need.

## Error/idempotency rules

`409` is normal concurrency/business conflict, not `500`.

Unsafe transport exception may be `UnknownOutcome`; caller does not blind retry.

Exactly one retry owner per operation. Avoid retry multiplication across edge/service/provider layers.

## Migration rules

C#→TS implementation change should preserve contract unless an independent API migration is approved.

For reads: shadow/parity/canary allowed.

For writes: HTTP route owner, DB writer owner, background worker owner and migration owner must be consistent before cutover.

React should not change URL/DTO merely because backend language changed.

## Verification

Minimum checks:

1. OpenAPI/JSON Schema validation;
2. generated client reproducibility;
3. compatibility/breaking-change check;
4. actor auth negative tests;
5. public edge negative exposure tests;
6. errorCode/idempotency/UnknownOutcome tests;
7. C#↔TS parity where migrating;
8. webhook replay/signature tests where relevant;
9. Kafka duplicate/replay/schema tests where relevant;
10. route/API-specific load profile when production path changes.

Always combine with `next-verification-and-parity` for migration/cutover.


## Node runtime coordination

Любое изменение production Node HTTP runtime также требует `next-nodejs-runtime` и M19 `10_NODEJS_HTTP_RUNTIME_CONTRACT.md`.

## Kafka hardening coordination

Asynchronous API не хранит собственный topic catalog в M19. Source of truth — M06 `kafka-topic-registry.yml`. Event и command используют разные envelopes и exact payload schemas. Key/partition/replay/DR semantics считаются API contract metadata.


## BusinessLogicHardened service graph

Если задача меняет Orders/Catalog/AROMA/Invoices/Payments interaction, дополнительно активировать `next-business-orchestration` и проверить M20. Target не имеет direct Draft `sendToAromaCart`; `Confirm -> Desired -> Convergence` является нормальным supplier path.

## Catalog/Product API

For Product/Variant/supplier-sync contracts read M19 `12_CATALOG_PRODUCT_API_CONTRACTS.md` and activate `next-catalog-product-lifecycle`. Product update/delete requires expected version; Draft pricing/internal preflight reads are read-only and Confirm never calls Catalog.

## End-to-end closure hard rules

- Exact canonical prefixes are `/api/client-v1`, `/api/agent-v1`, `/api/internal-v1`; verify against M19 OpenAPI files.
- Large manifests/documents use ArtifactRef+hash/size, not oversized HTTP/Kafka bodies.
- Payment provider webhook exact route is `/webhooks/payments/{provider}`.


---

## next-architecture-foundation

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


---

## next-architecture-router

---
name: next-architecture-router
description: "Use this skill first for any task touching the new CoffeeOrderSystem architecture under platform/, target edge/, infra/, hermes/, training/, or a C#→TypeScript migration/cutover. It routes to next-* skills and prevents legacy skills from becoming target-architecture authority."
---

# Next Architecture Skill Router

## Purpose

Это обязательный router для значимых задач новой архитектуры. Он выбирает минимальный набор `next-*` skills, повторно проверяет выбор после discovery и не позволяет legacy skills незаметно вернуть старую C#/.NET архитектуру как target.

## Scope gate

Активировать этот router, если задача затрагивает хотя бы одно:

```text
platform/**
edge/** target/strangler
infra/** new architecture
hermes/**
training/**
C# -> TypeScript migration
React copy/handover
Kafka/Outbox/Debezium
Docker/Compose/Kubernetes
Hermes/VK runtime
bounded-context cutover
legacy decommission
```

Не использовать как основной router для чисто legacy-задач внутри `src/**`, если они не связаны с переездом.

## Precedence

Для target-кода `next-*` skills имеют архитектурный приоритет над legacy skills.

Legacy skills разрешено подключать только как **evidence skills** для:

- чтения старой реализации;
- characterization tests;
- parity comparison;
- извлечения invariants;
- rollback evidence;
- controlled decommission.

Запрещено использовать старые skill-правила вида `CoffeeOrderSystem is a Modular Monolith` или `write runtime code only in src/...` как target-authority для `platform/**`.

## Routing matrix

| Signal | Required skills |
|---|---|
| Любая значимая next-architecture задача | `next-architecture-router`, `next-architecture-foundation` |
| `platform/apps/web`, React handover | `next-react-handover` |
| Dockerfile/Compose/reference runtime | `next-docker-compose-runtime` |
| `edge/`, route maps, canary/rollback | `next-nginx-strangler` |
| TypeScript platform, modules, shared packages | `next-typescript-platform` |
| Production Node/Fastify runtime, event loop, pools, cancellation, SSE, process lifecycle | `next-nodejs-runtime` + owning program skill |
| `client-v1`/`agent-v1`/`internal-v1`, webhooks, provider APIs, Kafka event API, SSE/WebSocket, OpenAPI/contracts | `next-api-architecture` + owning program skill |
| n8n control-plane workflows | `next-n8n-control-plane` |
| PostgreSQL schema/read/write ownership, DB0→DB5 | `next-postgres-migration` |
| Kafka, topics, Outbox, Debezium, Inbox | `next-kafka-event-platform` |
| Customer/Catalog first cutovers | `next-customer-catalog-migration` |
| Product/Variant, supplier catalog sync, pricing, availability, mappings | `next-catalog-product-lifecycle`, `next-customer-catalog-migration` |
| Payments | `next-payments-platform` |
| Hermes/VK/channel identity/model routing | `next-hermes-vk-runtime` |
| Invoices | `next-invoices-migration` |
| AROMA provider boundary/state parity | `next-aroma-migration` |
| Orders | `next-orders-migration`, `next-business-orchestration` |
| K8s/service extraction | `next-kubernetes-microservices` |
| Legacy removal / HostedService replacement | `next-legacy-decommission` |
| SLO/security/backpressure/DR/chaos | `next-reliability-operations` |
| CI/CD/images/SBOM/provenance | `next-cicd-supply-chain` |
| AReaL/datasets/training | `next-areal-training` |
| Новый infrastructure/pattern proposal | `next-system-design-governance` |
| Orders/AROMA/Invoice/Payment service links, Kafka handoffs, sync/async ownership | `next-business-orchestration` + owning program skill |
| Любой cutover/parity/rewrite с риском regression | `next-verification-and-parity` |

## Mandatory checkpoints

1. Task start — определить программу Mxx и target write zone.
2. After discovery — проверить, не открылся ли новый bounded context/infra surface.
3. Before edits — назвать current owner и future owner.
4. Before DB/event writes — подтвердить single-writer и idempotency model.
5. Before verification — активировать `next-verification-and-parity` для migration/cutover.
6. Before cutover — проверить M15 release gates и rollback.
7. Before final — перечислить использованные `next-*` skills и оставшийся legacy dependency.
8. Для API change — назвать M19 surface/actor/transport/owner перед edits и проверить public/private exposure.

## Stop conditions

Остановить реализацию и сначала обновить архитектуру/ADR, если требуется:

- direct `platform/** -> src/**` runtime dependency;
- два writer'а одной business schema;
- shared writable SQLite для Hermes shards;
- прямой transactional `DB commit -> Kafka producer.send()` вместо Outbox/CDC;
- новый public internal API через edge без trust review;
- добавление Redis/NoSQL/service mesh/sharding без measured bottleneck;
- big-bang switch нескольких bounded contexts;
- AReaL в production request path;
- Node/Fastify runtime contract violation: mixed trust surfaces in public process, unbounded Promise fan-out, blanket trustProxy, blocking sync server path, or uncontrolled DB/provider pools.


## Kafka contract stop conditions

Остановить edits и вернуться к M06/ADR, если предлагается: auto-create production topic; mixed command/event topic; direct DB-commit->Kafka domain publication; automatic partition increase; durable consumer auto-commit/implicit offset reset; blind replay provider side effects; removal/recreation Debezium slot без snapshot/WAL analysis; declaration end-to-end exactly-once.


## Business orchestration stop conditions

Stop and return to M11/M12/M20 if proposed target introduces direct Draft `sendToAromaCart`, ports `AromaCartFillBatch` as target model, makes AROMA Gateway own Desired/Convergence, creates synchronous Orders↔Invoices/Payments cycle, or performs Catalog/AROMA HTTP inside Confirm transaction.


---

## next-areal-training

---
name: next-areal-training
description: "Use only for the separate AReaL training/evaluation lifecycle: sanitized Hermes trajectories, datasets, rewards, SFT/QLoRA, agentic RL, model registry, shadow/canary promotion. Never use it to add AReaL to production serving."
---

# AReaL Training-Only

## Source of truth

Каноническая программа: `M17_AREAL_TRAINING`. Перед существенным изменением прочитать её `README.md` и релевантные нормативные документы. Если этот skill противоречит канонической программе, **побеждает каноническая программа**, а skill должен быть обновлён.

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

- trajectory export/dataset;
- reward/evaluator;
- SFT/QLoRA/GRPO/GSPO experiment;
- model registry/promotion;
- AReaL infra.

## Hard rules

- AReaL отсутствует в production request path.
- Hermes state.db не является training dataset напрямую.
- Перед dataset: PII stripping/pseudonymization + business outcome verification.
- Training host не имеет production DB/AROMA/payment credentials.
- Не online-learn от live customer traffic прямо в production weights.
- Цикл: collect→sanitize→freeze dataset→train→evaluate→shadow→canary→promote.
- Reward основан на проверяемом business outcome, а не только “красивом ответе”.
- Cross-customer leakage/identity/confirmation violation = hard failure.
- Model artifact имеет base model/dataset/reward/code/config/checkpoint hashes.

## Workflow

1. Определить dataset schema/privacy class.
2. Собрать verified trajectories.
3. Заморозить versioned train/val/holdout/red-team split.
4. Сначала baseline SFT/QLoRA где уместно.
5. AReaL RL только при готовом evaluator/environment/GPU capacity.
6. Offline eval → Hermes shadow → canary → route promotion.

## Минимальная проверка

Перед завершением:

1. проверить соответствие каноническому документу программы;
2. проверить, что не создана новая скрытая cross-boundary зависимость;
3. выполнить targeted unit/integration/contract tests;
4. выполнить architecture/boundary tests для затронутого слоя;
5. проверить Docker build/health, если изменён runtime workload;
6. проверить observability и failure semantics, если изменён I/O/async path;
7. явно записать skipped checks и остаточный риск.


---

## next-aroma-migration

---
name: next-aroma-migration
description: "Use for target AROMA provider boundary and Orders-owned authoritative cart migration: Gateway protocol, Desired/Observed/Convergence, checkout, fencing, UnknownOutcome, and legacy cart-fill retirement."
---

# AROMA Migration and Safety

## Source of truth

`M11_AROMA_GATEWAY`, `M12_ORDERS`, `M20_SERVICE_ORCHESTRATION`.

## Hard rules

- Gateway = auth/session/HTTP/provider DTO/rate/circuit only.
- Orders = Desired/Observed/Convergence/Attempt/Lease/Fencing/UnknownOutcome/Checkout.
- Do not port `AromaCartFillBatch`, direct Draft send or browser resend workflow.
- Unsafe path: DB lease/fence -> fresh GET -> one mutation -> fresh GET -> exact verify.
- Gateway/HTTP layer never blind-retries unsafe POST/PUT/DELETE.
- Kafka command is wake-up/version hint, not physical proof/mutation authority.
- Failed GET never clears Observed; timeout after unsafe mutation => UnknownOutcome.
- Observer is read-only; checkout freeze uses safe reads only.
- Catalog Supplier Sync uses Gateway only for safe complete wholesale-catalog reads; normal mapping resolution/preflight uses persisted Catalog proof.
- Any service-link change activates `next-business-orchestration`.

## Parity

Compare TypeScript against authoritative C# convergence/checkout decisions, not legacy batch class structure.

- Catalog price changes do not change Desired/cart target; availability/mapping/tombstone facts may.
- Positive convergence requires fresh Catalog complete-snapshot proof; stopped/missing mappings fail closed.

## End-to-end closure hard rules

- Unsafe mutation requires durable MutationReservation + lease extension; new owner reconciles unresolved Mutating/UnknownOutcome before any new mutation.
- Gateway enforces method-level service audiences: catalog read-only callers cannot invoke cart mutations.
- Checkout cancel has `CancelRequested -> CancelGuard -> Cancelled|CompensationRequired` race-safe process.


---

## next-business-orchestration

---
name: next-business-orchestration
description: "Use for any new-architecture task that changes how Orders, Catalog, AROMA Gateway, Invoices, Payments, React/Hermes or Kafka call each other, exchange commands/events, own process state, or recover cross-service workflows. M20 is the source of truth."
---

# Business Orchestration and Service Graph

## Source of truth

Read `M20_SERVICE_ORCHESTRATION` plus owning programs before edits.

## Use when

- adding/changing HTTP client between services;
- adding Kafka producer/consumer or command/event;
- moving a worker into its own deployment;
- Orders/AROMA/Invoice/Payment end-to-end flow;
- deciding whether logic belongs to Gateway or business context.

## Hard rules

- Runtime role != bounded context.
- Orders owns Desired/Observed/Convergence/Fulfillment/Checkout even when workers are separate pods.
- AROMA Gateway owns provider transport only and has no Orders DB credential.
- Confirm transaction performs no Catalog/AROMA/Invoices/Payments HTTP.
- No synchronous business cycles `A -> B -> A`.
- Orders↔Invoices and Orders↔Payments state transitions use durable async contracts.
- Catalog Supplier Sync may use AROMA Gateway only for a safe complete-catalog read; mapping resolver uses persisted snapshot and Catalog never mutates cart.
- Convergence may call Gateway synchronously because GET-mutate-GET is one Orders-owned external consistency attempt.
- New cross-service edge requires updating M20 matrix/diagram/tests.

## Stop conditions

Stop if proposed design needs:

- direct cross-owner DB write/read as mutation shortcut;
- Gateway callback into Orders;
- `OrderConfirmed -> create invoice` before checkout/wholesale proof;
- Payments direct status patch in Orders;
- direct React/Hermes/n8n provider mutation;
- splitting Orders AROMA state into another owner just because it has a separate deployment.

## Verification

- architecture dependency graph;
- Kafka ACL/producers/consumers match matrix;
- no new sync cycle;
- failure/replay semantics documented;
- owning program and M20 both updated.

- Orders Draft may read Catalog synchronously for product snapshot/explicit procurement pricing; Orders Confirm may not.
- Orders Convergence may synchronously read Catalog latest-complete-snapshot proof before positive mutation; there is no reverse callback.

## End-to-end closure hard rules

- Validate every consumer group against `runtime-workload-registry.yml`.
- Normal v1 procurement cardinality is Order-atomic.
- Orders→Invoices uses immutable allocation artifact; Invoices→Orders uses price-proof artifact and per-order summary.
- Payment provider inbound webhook and outbound provider calls are separate directed edges.
- Direct BC Outbox→`coffee.realtime.invalidate.v1` is the only realtime invalidation model.


---

## next-catalog-product-lifecycle

---
name: next-catalog-product-lifecycle
description: Use for target Catalog Product/Variant/Alias mutations, complete AROMA supplier-catalog synchronization, supplier pricing, availability/tombstones, deterministic mappings, Catalog Outbox facts, Draft pricing reads, or Catalog-driven Orders Desired/AROMA cart reactions.
---

# Catalog Product Lifecycle

## Source of truth

Read `M07_CUSTOMER_CATALOG` first. For cart impact also read M11 `06_CATALOG_DRIVEN_CART_SAFETY.md` and M20.

## Hard rules

- Catalog owns Product/Variant/Alias, supplier snapshots/prices, availability and mapping.
- Product price/name changes do not silently rewrite Confirmed Order snapshots or Desired target.
- Availability/mapping/tombstone facts may change active Orders Desired, but only Orders owns that reaction.
- Complete successful supplier snapshot is the operational AROMA catalog proof; failed/partial/suspicious reads preserve prior truth.
- `product_on_stop=true` is `TemporarilyUnavailable`, not ManualReview.
- `MissingFromSnapshot` is distinct from product_on_stop; only a validated complete snapshot may produce it.
- Positive supplier price only; stopped/invalid/zero price does not overwrite working price or create SKU.
- Auto-create Product/Variant only from deterministic category/vendor/package/grind identity.
- Automatic mapping identity includes vendor code + package/non-weight key + canonical grind + ProductFamily.
- Manual-approved mapping has priority over automatic mapping.
- Every semantic manual/automatic mapping change writes Catalog Outbox in the same transaction.
- Availability transition/delete writes product/variant availability/tombstone Outbox in the same transaction.
- Product/Variant tombstone must allow Orders to converge old AROMA key to target zero before identity GC.
- Draft pricing refresh is explicit, stale-protected and reads persisted Catalog facts only.
- Confirm transaction never calls Catalog.
- Normal mapping resolver does not perform per-item provider HTTP; it uses persisted complete snapshot.
- Catalog never calls AROMA cart endpoints or writes Orders DB.

## Verification

Required characterization/property cases include stop/restore, same-state no-op, product+variant tombstone, suspicious snapshot shrink, price history, invalid price preservation, deterministic create, mapping collision/manual preservation, remap old/new keys, duplicate events, stable-fulfillment guard, and Draft-only pricing refresh.

## End-to-end closure hard rules

- Separate `OperatorEnabled` from supplier availability; derive `EffectiveOrderability` instead of one ambiguous IsAvailable flag.
- Separate SupplierListPrice provenance from operator/customer reference price.
- Manual mapping increments override epoch and publishes Outbox in same transaction; supplier projection rechecks epoch/row lock before commit.
- Public production DeleteAll is forbidden; purge is maintenance-only.
- Search indexing consumes `coffee.catalog.products.v1`; no separate indexing command/event topics in baseline.


---

## next-cicd-supply-chain

---
name: next-cicd-supply-chain
description: "Use for CI/CD of the new TypeScript/React/Node platform, container images, lockfiles, SBOM/provenance, security scanning, immutable deploy artifacts, schema/contract compatibility gates, and release promotion."
---

# CI/CD and Supply Chain

## Source of truth

Каноническая программа: `M16_CICD_SUPPLY_CHAIN`. Перед существенным изменением прочитать её `README.md` и релевантные нормативные документы. Если этот skill противоречит канонической программе, **побеждает каноническая программа**, а skill должен быть обновлён.

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

- новый app/package/image;
- GitHub Actions для platform;
- dependency/toolchain update;
- release/canary/promotion;
- SBOM/signing/provenance.

## Hard rules

- Production Node baseline = Node 24 LTS exact patch + digest; floating `latest`/`node:lts` не release identity.
- Workloads with native Kafka/OTel use validated glibc base by default; native-load smoke is mandatory.
- One Node application role per container; PM2/node cluster not used for normal horizontal scale.
- Confluent JS + pnpm compatibility smoke remains release gate while upstream labels pnpm support experimental.
- CI tests SIGTERM graceful shutdown and memory-limit startup for deployable Node roles.


- pnpm lockfile deterministic; не смешивать npm/yarn locks.
- Каждый deploy связывается с commit SHA + image digest + config/contract version.
- Production не использует mutable `latest` как identity.
- Contract/schema compatibility проверяется до promotion.
- Secrets не попадают в build args/logs/artifacts.
- Frontend edge pair и backend images должны иметь независимую attestation/rollback identity.
- Dependency update не bypass-ит tests/bundle/security gates.
- DB migrations — отдельный controlled job/gate, не side effect каждого pod startup.

## Workflow

1. Определить artifact graph.
2. Добавить build/test/lint/typecheck/contracts/security jobs.
3. Собрать images и SBOM/provenance.
4. Проверить migration/schema compatibility.
5. Провести ephemeral/compose smoke.
6. Продвинуть shadow→canary→production с immutable digests.
7. Сохранить rollback target.

## Минимальная проверка

Перед завершением:

1. проверить соответствие каноническому документу программы;
2. проверить, что не создана новая скрытая cross-boundary зависимость;
3. выполнить targeted unit/integration/contract tests;
4. выполнить architecture/boundary tests для затронутого слоя;
5. проверить Docker build/health, если изменён runtime workload;
6. проверить observability и failure semantics, если изменён I/O/async path;
7. явно записать skipped checks и остаточный риск.


## M19 API Architecture

M19 OpenAPI/webhook/event compatibility и public-route exposure входят в CI release gates.


## Node runtime coordination

Node runtime/container changes additionally require `next-nodejs-runtime`.

## Kafka contract/IaC coordination

Для Kafka changes обязательно применять M16 `03_KAFKA_CONTRACT_AND_IAC_GATES.md`: registry lint, production partition completeness, partition-change guard, schema compatibility, deployed-topic drift, Debezium slot/snapshot/heartbeat config validation. Application не auto-create topics и не auto-register production schemas.


---

## next-customer-catalog-migration

---
name: next-customer-catalog-migration
description: "Use for target Customer/Catalog migration and cutover. For Product/Variant/supplier snapshot/pricing/availability/mapping business logic also activate next-catalog-product-lifecycle."
---

# Customer / Catalog Migration

## Catalog hard rules

- Catalog owns Product/Variant/Alias, supplier snapshots/prices, mapping and availability. Supplier-sync may call AROMA Gateway only for safe complete-catalog reads.
- `ConfirmOrder` must not synchronously depend on Catalog.
- Missing mapping -> async `CatalogMappingResolutionRequested` -> resolve from persisted complete supplier snapshot -> mapping/availability facts -> Orders Desired refresh.
- Transport failure != TemporarilyUnavailable.
- Catalog never writes Orders Desired or mutates AROMA cart.
- Activate `next-business-orchestration` for service-link changes.

- Product price change never auto-reprices Confirmed Orders or directly changes AROMA cart target.
- Activate `next-catalog-product-lifecycle` for Product/Variant/supplier-sync work.

## Customer hard rules

- Channel Platform owns ChannelIdentityLedger; Customer owns CustomerChannelLink only.
- One active Customer link per ChannelIdentityRef; identityEpoch change requires revalidation.
- Customer lifecycle is Active/Deactivated/Merged; normal hard delete is forbidden.
- Delivery addresses are versioned and Orders store immutable snapshots.


---

## next-docker-compose-runtime

---
name: next-docker-compose-runtime
description: "Use for Dockerfiles, Docker Compose profiles, local/reference runtime topology, container health, graceful shutdown, and image boundaries for the new architecture."
---

# Docker and Compose Reference Runtime

## Source of truth

Каноническая программа: `M02_DOCKER_COMPOSE`. Перед существенным изменением прочитать её `README.md` и релевантные нормативные документы. Если этот skill противоречит канонической программе, **побеждает каноническая программа**, а skill должен быть обновлён.

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

- добавляется новый workload/app;
- меняется Dockerfile или Compose;
- создаётся local integration topology;
- готовится component к Kubernetes.

## Hard rules

- Каждый runtime workload имеет immutable image и health semantics.
- Multi-stage build, pinned base image major/minor/digest policy по CI.
- Runtime container работает non-root, где это возможно.
- Secrets не bake-ятся в image и не коммитятся в compose.
- Compose — исполняемая reference architecture, а не случайный dev helper.
- Не расширять один гигантский compose бесконечно: использовать bounded compose files/profiles.
- Local topology должна концептуально соответствовать будущим K8s workloads.

## Workflow

1. Определить workload role: HTTP, consumer, stateful, job/cron.
2. Добавить Dockerfile с build/runtime stages.
3. Добавить health/readiness-equivalent checks.
4. Включить workload в соответствующий compose profile.
5. Добавить dependencies только по network/data need, не по convenience.
6. Запустить build + compose smoke + graceful stop/restart test.

## Минимальная проверка

Перед завершением:

1. проверить соответствие каноническому документу программы;
2. проверить, что не создана новая скрытая cross-boundary зависимость;
3. выполнить targeted unit/integration/contract tests;
4. выполнить architecture/boundary tests для затронутого слоя;
5. проверить Docker build/health, если изменён runtime workload;
6. проверить observability и failure semantics, если изменён I/O/async path;
7. явно записать skipped checks и остаточный риск.


## Node runtime coordination

Для production Node image/runtime обязательно активировать `next-nodejs-runtime`: one-process-per-container, Node 24 LTS pin/digest, memory/V8 headroom, SIGTERM drain и native dependency smoke.


---

## next-hermes-vk-runtime

---
name: next-hermes-vk-runtime
description: "Use for Hermes production runtime, VK/channel ingress/egress, Channel Identity, Hermes Dispatcher, EDA-080..084, session sharding/recovery, provider routing, and CoffeeOrder plugin boundary."
---

# Hermes and VK Runtime

## Source of truth

Каноническая программа: `M09_HERMES_VK`. Перед существенным изменением прочитать её `README.md` и релевантные нормативные документы. Если этот skill противоречит канонической программе, **побеждает каноническая программа**, а skill должен быть обновлён.

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

- Hermes Runtime/Dispatcher/plugin;
- VK Callback/egress/realtime ordering;
- channel identity/customer resolution;
- AgentTurnRequested/Completed/Failed;
- model provider routing/fallback.

## Hard rules

- Hermes = production agent runtime; AReaL не входит в serving path.
- Coffee DB = business truth; Hermes state.db = transcript/session runtime only.
- Production Coffee Hermes profile изолирован от developer Hermes.
- Разрешены только CoffeeOrder tools; terminal/file/browser/arbitrary HTTP/general MCP/delegation/code execution выключены.
- Model не выбирает `vk_user_id/customerId`; `resolve_current_customer()` использует trusted opaque channelIdentityRef из transport context.
- Hermes fleet = stateful shards с отдельным PVC/state.db; общий writable SQLite запрещён.
- Persist `AgentConversationBinding` + `OwnerEpoch` вне Hermes.
- Один active mutation-capable turn на conversation; разные conversations параллельны.
- Для high-throughput использовать durable AgentTurn journal и Runs API; не держать Kafka partition заблокированной на весь LLM turn.
- Provider fallback не повторяет уже выполненные business mutations.

## Workflow

1. EDA-080: contract `coffee.agent.turn.requested.v1`.
2. EDA-081: TS Hermes Dispatcher + durable turn journal.
3. EDA-082: shard/session binding, sticky placement, drain/recovery.
4. EDA-083: stable completion/failure outcomes → channel reply.
5. EDA-084: load test model stub + 10k/25k/50k/100k conversation ladder.
6. Проверить identity spoofing, shard loss, submission unknown, provider 429/timeout, replay.

## Минимальная проверка

Перед завершением:

1. проверить соответствие каноническому документу программы;
2. проверить, что не создана новая скрытая cross-boundary зависимость;
3. выполнить targeted unit/integration/contract tests;
4. выполнить architecture/boundary tests для затронутого слоя;
5. проверить Docker build/health, если изменён runtime workload;
6. проверить observability и failure semantics, если изменён I/O/async path;
7. явно записать skipped checks и остаточный риск.


## M19 API Architecture

Hermes `agent-v1`, VK callback и realtime/channel contracts следуют M19 API surface rules.


## Node runtime coordination

TypeScript `channel-ingress`, `channel-egress` и `hermes-dispatcher` дополнительно требуют `next-nodejs-runtime`: bounded pools/concurrency, AbortSignal/deadlines, event-loop/RSS metrics, graceful drain и shared Kafka runtime.

## End-to-end closure hard rules

- Runtime chain includes `channel-identity-broker`, `channel-intake`, `channel-response-mapper`, `hermes-runtime`; do not bypass them.
- `AgentTurnFailed` must reach response mapper with sanitized fallback reply.
- `HermesRunAdapter.submit(turnRef)` is idempotent/reconcilable; `SubmissionUnknown` never blind-resubmits.
- Normal AI/VK confirmation uses structured `ChannelConfirmationProof`; free-text/model decision alone cannot confirm supplier intent.


---

## next-invoices-migration

---
name: next-invoices-migration
description: "Use for target Invoices ownership, immutable checkout/wholesale materialization, PDF/reconciliation, price application proof, Kafka handoff, and DB5 cutover."
---

# Invoices Migration

## Hard rules

- Normal invoice creation is triggered by `InvoiceMaterializationRequested` from immutable Orders checkout+wholesale proof, **not** simple `OrderConfirmed`.
- Invoices never reads/writes Orders DB and never calls AROMA in normal flow.
- Materialization stable identity = profile + checkoutSnapshotRef + wholesaleSnapshotRef/operationRef.
- Price result returns as event; Orders decides its own lifecycle transition.
- After applied price, generic unlink is locked; use explicit compensation/refund/correction workflows.
- Activate `next-business-orchestration` for cross-service changes.

## End-to-end closure hard rules

- `InvoiceMaterializationRequested` must carry immutable CheckoutAllocationManifest ArtifactRef + SHA-256 + byte size + schema version; refs-only payload is invalid.
- `InvoicePricesApplied` must carry bounded per-order totals/coverage hashes plus immutable full price-proof ArtifactRef.
- PDF is an Artifact Storage object, not DB blob/container file/Kafka payload.
- Compensation uses explicit command/event state machine; original allocations/proofs are append-only.


---

## next-kafka-event-platform

---
name: next-kafka-event-platform
description: "Use for Kafka cluster/topic contracts, keys/partitions, producers/consumers, Outbox/Debezium CDC, Inbox/idempotency, schemas, replay/DLQ, DR, quotas, retention, ordering and backpressure in the new CoffeeOrderSystem architecture."
---

# Kafka Event Platform

## Source of truth

Каноническая программа: `M06_KAFKA_EVENT_PLATFORM`.

Перед изменением прочитать `M06/README.md` и релевантные `05..10` hardening contracts. Topic list всегда брать из `kafka-topic-registry.yml`, не из старого Markdown/legacy code.

Если skill противоречит M06 — побеждает M06, skill обновляется.

## Scope

Только target architecture:

```text
platform/**
infra/kafka/**
infra/debezium/**
infra/connect/**
hermes/** when Kafka boundary changes
```

`src/**` — только legacy behavior/parity evidence.

## Use when

- Kafka cluster/topology/config;
- topic/key/partition/retention/quota;
- event/command schema;
- producer/consumer;
- Outbox/Debezium/Inbox;
- replay/DLQ/recovery;
- Kafka DR/monitoring;
- KEDA consumer scaling.

## Classification before edits

Записать:

```text
Message kind: event | command
Owner:
Topic:
Key:
Ordering invariant:
Retention class:
Durability class:
PII class:
Replay class:
DR class:
Producer(s):
Consumer group(s):
Schema paths:
External side effect: yes/no
```

## Hard rules — platform

- Production critical Kafka = KRaft, separate controller/broker roles or managed equivalent.
- Critical streams = RF3/minISR2 + producer `acks=all` + idempotence.
- `auto.create.topics.enable=false`; clients also disable auto topic creation.
- Topic creation/config/ACL/quota = IaC/registry, не application side effect.
- Stable workload-specific `client.id`/principal; generic shared Kafka credential запрещён.

## Hard rules — topics

- Единственный topic source of truth — `kafka-topic-registry.yml`.
- Event и command не смешивать в одном ambiguous stream.
- Key выбирается по ordering invariant.
- Production partition count выбирается capacity test **до cutover**.
- Active keyed topic partition count нельзя менять автоматически из-за lag/KEDA.
- Изменение key/partition strategy может требовать new topic major.
- Retention задаётся class-specific, не одним global default.
- Large files/transcripts не перевозить Kafka; application message baseline <= 256 KiB без ADR.

## Hard rules — schemas

- Integration event и integration command имеют разные envelopes.
- Envelope + exact payload JSON Schema обязательны.
- Lifecycle events публикуют `aggregateVersion` where applicable.
- Side-effecting commands имеют stable `idempotencyKey` и expiry/deadline policy.
- Git schemas = source of truth; runtime Schema Registry не auto-register'ит arbitrary prod schema из request path.
- Breaking key/money/identity/event-vs-command semantics не masquerade как additive schema change.

## Hard rules — publication/consumption

- Transaction-bound publication: business state + Outbox one DB transaction -> WAL/Debezium -> Kafka.
- Запрещён `DB commit -> producer.send()` для domain transition.
- Delivery semantics = at-least-once transport + effectively-once business effects.
- Side-effect consumer = schema validation -> Inbox/current-state guard -> business transaction -> safe offset commit.
- Durable consumer: `enable.auto.commit=false`, `allow.auto.create.topics=false`, `auto.offset.reset=none`.
- Realtime ephemeral consumer может использовать `latest` и unique group per replica.
- Shared `platform/packages/kafka-runtime` владеет offsets/rebalance/pause/retry lifecycle.
- `maxCompletedAheadGap`/bounded in-flight обязательны; не копить unlimited later offsets.

## Hard rules — retry/replay/DLQ

- Один retry owner.
- Long retry хранится как durable process state; Kafka consumer не sleep'ит минуты.
- Replay policy per consumer: projection / business DB / provider side effect.
- External provider side effect не blind-replay.
- Original `eventId`/`commandId` сохраняется при replay.
- DLQ не auto-loop'ится в source; нужен inspect/approve/replay workflow.

## Hard rules — Debezium

- Capture только approved outbox/heartbeat tables.
- Unique connector/slot/publication per physical DB source/connector.
- Snapshot policy explicit; не полагаться на default.
- Heartbeat/WAL retention/queue utilization — production SLI.
- Bounded queue, `max.queue.size > max.batch.size` и byte budget.
- Не пытаться масштабировать PostgreSQL connector через `tasks.max`.

## Hard rules — DR/operations

- RF3/minISR2 != cross-cluster DR.
- MirrorMaker2/managed equivalent — async DR и не означает RPO=0.
- ACKed external ingress имеет явный RPO requirement.
- Quotas защищают interactive traffic от replay/background load.
- Наблюдать broker ISR/offline/minISR, partition skew, consumer age/lag, rebalances, Debezium WAL/heartbeat, quotas.

## Workflow

1. Классифицировать message/topic/consumer.
2. Обновить canonical registry/schema first.
3. Проверить partition/capacity/replay/DR implications.
4. Реализовать publication/consumer через shared runtime.
5. Добавить duplicate/crash/rebalance/schema/failure tests.
6. Добавить monitoring/runbook.
7. Прогнать M16 registry/schema/IaC gates.
8. Не делать cutover без M15 recovery evidence.

## Required verification

Минимум:

1. YAML/JSON Schema validation;
2. topic registry unique/completeness check;
3. compatibility test;
4. producer/consumer integration test;
5. duplicate Inbox test;
6. crash-after-DB-commit-before-offset test;
7. rebalance/SIGTERM drain test;
8. invalid schema/poison record test;
9. replay/DLQ test for changed consumer;
10. Debezium restart/WAL test if CDC changed;
11. broker/minISR/DR drill if platform durability changed;
12. load/partition skew test if topology/capacity changed.

## Coordination

- Node implementation: `next-nodejs-runtime`.
- API/schema governance: `next-api-architecture`.
- K8s/KEDA: `next-kubernetes-microservices`.
- SLO/DR: `next-reliability-operations`.
- CI/IaC: `next-cicd-supply-chain`.
- Migration/cutover: `next-verification-and-parity`.


## BusinessLogicHardened service graph

Если задача меняет Orders/Catalog/AROMA/Invoices/Payments interaction, дополнительно активировать `next-business-orchestration` и проверить M20. Target не имеет direct Draft `sendToAromaCart`; `Confirm -> Desired -> Convergence` является нормальным supplier path.

## End-to-end closure hard rules

- Every canonical topic has explicit productionPartitions and >=1 exact payload schema.
- Every declared payload schema has message-type registry entry and valid fixture.
- Every consumer group maps to runtime workload (except explicit ephemeral-per-replica special case).
- User/channel/agent text topics are possible-PII, not opaque-ref-only.
- UInt64/Int64 business versions are decimal strings on JSON wire.
- Catalog availability/mapping streams are critical durability.


---

## next-kubernetes-microservices

---
name: next-kubernetes-microservices
description: "Use for Kubernetes target runtime, selective microservice extraction, workload roles, HPA/KEDA, StatefulSet Hermes, NetworkPolicy, probes, jobs/cronjobs, topology and deployment boundaries."
---

# Kubernetes and Selective Microservices

## Source of truth

Каноническая программа: `M13_KUBERNETES_MICROSERVICES`. Перед существенным изменением прочитать её `README.md` и релевантные нормативные документы. Если этот skill противоречит канонической программе, **побеждает каноническая программа**, а skill должен быть обновлён.

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

- перенос Compose workload в K8s;
- выделение bounded context в service;
- autoscaling/probes/network policy;
- Hermes StatefulSet/GPU pool.

## Hard rules

- Kubernetes = orchestration plane, не доменная архитектура.
- Сначала доказать container/process split в Compose.
- Service extraction только при independent scaling/failure/security/release/data reason.
- Запрещены nanoservices и cross-service SQL.
- API/consumers одного bounded context могут быть разными Deployments с общей domain package, но своим DB ownership.
- Hermes = StatefulSet/per-shard PVC/state-aware drain.
- Kafka/PostgreSQL не тащить в application cluster без отдельного stateful-platform design.
- Readiness = способен безопасно принимать новую работу; liveness не зависит от временной недоступности provider.
- KEDA lag scaling ограничен partition parallelism/provider quotas.

## Workflow

1. Определить workload class и resource profile.
2. Перенести health/graceful shutdown из Compose.
3. Добавить Deployment/StatefulSet/Job/CronJob.
4. Добавить requests/limits, topology spread, PDB где уместно.
5. Добавить default-deny NetworkPolicy и allowlist.
6. Настроить HPA/KEDA по workload metric.
7. Провести rollout/drain/failure test.

## Минимальная проверка

Перед завершением:

1. проверить соответствие каноническому документу программы;
2. проверить, что не создана новая скрытая cross-boundary зависимость;
3. выполнить targeted unit/integration/contract tests;
4. выполнить architecture/boundary tests для затронутого слоя;
5. проверить Docker build/health, если изменён runtime workload;
6. проверить observability и failure semantics, если изменён I/O/async path;
7. явно записать skipped checks и остаточный риск.


## Node runtime coordination

Node workloads масштабируются не только по CPU: использовать ELU/event-loop delay, DB pool wait, RSS/SSE buffers/Kafka age по M04/M15. `api-public`, `api-agent`, `api-internal` остаются отдельными Deployments/trust zones.

## Kafka/KEDA hard rule

KEDA может менять количество consumer replicas, но не Kafka partition count. Production partition topology active keyed topic определяется M06 capacity contract до cutover; автоматическое увеличение partitions из-за lag запрещено.


## BusinessLogicHardened service graph

Если задача меняет Orders/Catalog/AROMA/Invoices/Payments interaction, дополнительно активировать `next-business-orchestration` и проверить M20. Target не имеет direct Draft `sendToAromaCart`; `Confirm -> Desired -> Convergence` является нормальным supplier path.


---

## next-legacy-decommission

---
name: next-legacy-decommission
description: "Use for deleting or disabling legacy C# runtime, HostedServices, old routes, flags, contracts, Blazor leftovers, AI/VK workers, and migration scaffolding after accepted cutovers."
---

# Legacy Decommission

## Source of truth

Каноническая программа: `M14_DECOMMISSION`. Перед существенным изменением прочитать её `README.md` и релевантные нормативные документы. Если этот skill противоречит канонической программе, **побеждает каноническая программа**, а skill должен быть обновлён.

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

- bounded context прошёл DB5/cutover;
- удаляется `src/**` runtime path;
- удаляются HostedServices/flags/old routes;
- нужно доказать zero consumers.

## Hard rules

- Удаление только после accepted cutover + soak + rollback evidence.
- Перед удалением сделать residual searches по code/config/docs/compose/CI.
- Не оставлять zombie writer/worker с выключенным по умолчанию flag как “на всякий случай” бесконечно.
- Legacy route removal и DB writer removal — разные gates.
- Archived docs явно помечать superseded, а не смешивать с каноном.
- Финальная цель: C# production workloads = 0; reference history остаётся Git history, не live runtime.

## Workflow

1. Подтвердить owner = target.
2. Проверить telemetry: legacy traffic/work = 0.
3. Удалить worker/route/config/secret/build artifact волной с rollback commit.
4. Запустить residual grep/static dependency check.
5. Проверить Compose/K8s/CI/docs.
6. Обновить supersession/decommission evidence.

## Минимальная проверка

Перед завершением:

1. проверить соответствие каноническому документу программы;
2. проверить, что не создана новая скрытая cross-boundary зависимость;
3. выполнить targeted unit/integration/contract tests;
4. выполнить architecture/boundary tests для затронутого слоя;
5. проверить Docker build/health, если изменён runtime workload;
6. проверить observability и failure semantics, если изменён I/O/async path;
7. явно записать skipped checks и остаточный риск.

## BusinessLogicHardened Orders/AROMA rule

При Orders/AROMA migration target parity строится против authoritative `Confirm -> Desired -> Observed -> Convergence -> Checkout` semantics. Legacy `sendToAromaCart`/`AromaCartFillBatch` не является обязательным target behavior; из него переносятся только безопасные edge-case invariants. Service links дополнительно проверяются по M20/`next-business-orchestration`.


---

## next-n8n-control-plane

---
name: next-n8n-control-plane
description: "Use for n8n workflows in the new architecture: scheduled/manual automation, operator approvals, reports, notifications, administrative orchestration, and low-frequency integrations. It prevents n8n from becoming a domain runtime, realtime transport, or direct database writer."
---

# n8n Control Plane

## Source of truth

Канонический документ: `M04_TYPESCRIPT_PLATFORM/05_N8N_CONTROL_PLANE_BOUNDARY.md`.

## Область действия

Только новая архитектура. n8n является automation/control-plane инструментом рядом с `platform/**`; он не является частью domain runtime.

## Use when

- создаётся scheduled/manual n8n workflow;
- нужен operator approval/human-in-the-loop;
- отчёт/notification/admin orchestration;
- low-frequency integration через `internal-v1` Platform API;
- обсуждается публикация command/event из n8n.

## Hard rules

- n8n не пишет напрямую domain PostgreSQL tables.
- n8n не хранит Order/Payment/AROMA business truth.
- n8n не заменяет Kafka high-throughput consumers.
- n8n не является VK realtime gateway или Hermes Dispatcher.
- Mutation выполняется только через authenticated Platform API / explicit admin command.
- Kafka command из n8n допускается только через утверждённый producer contract и с idempotency semantics owning bounded context.
- n8n не выполняет AROMA mutation в обход owning state machine.
- Secrets хранятся в n8n credential mechanism/secret manager, не в workflow JSON в Git.
- Workflow retry не должен дублировать unsafe business operation: retry owner и idempotency определяет API contract.

## Workflow

1. Определить, действительно ли задача low-frequency/control-plane, а не realtime/domain.
2. Найти owning bounded context и explicit API command/query.
3. Создать минимальный workflow без business calculations.
4. Передавать correlation/idempotency references.
5. Настроить bounded timeout/retry только для безопасных transport operations.
6. Добавить audit/observable outcome и operator failure path.
7. Проверить, что workflow можно удалить без потери business truth.

## Verification

- no direct DB credentials/domain SQL;
- no public/internal auth bypass;
- duplicate workflow execution безопасен;
- API errors/409/unknown outcome не приводят к blind replay;
- workflow экспорт не содержит secrets;
- audit/correlation видимы в Platform observability.


## M19 API Architecture

n8n использует только approved `internal-v1`/control contracts по M19; direct DB writes запрещены.


---

## next-nginx-strangler

---
name: next-nginx-strangler
description: "Use for public Nginx edge, route-family ownership, C#→TypeScript strangler routing, canary/rollback, TLS, coarse limits, and same-origin boundaries."
---

# Nginx Strangler Edge

## Source of truth

Каноническая программа: `M03_NGINX_STRANGLER`. Перед существенным изменением прочитать её `README.md` и релевантные нормативные документы. Если этот skill противоречит канонической программе, **побеждает каноническая программа**, а skill должен быть обновлён.

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

- меняется `edge/**`;
- переключается backend/frontend route family;
- нужен canary/rollback;
- меняются body/rate limits, proxy, SSE/WebSocket.

## Hard rules

- Nginx не содержит business logic.
- Public edge владеет TLS, routing, coarse rate/body limits, security headers и migration switch.
- Internal APIs не становятся публичными автоматически.
- Route limits задаются по semantics; избегать глобального oversized body limit.
- Canary/rollback должен менять routing, а не database truth.
- Нельзя переключать route на target до parity/release gate.
- SSE/WebSocket proxy settings отдельно от обычного API.

## Workflow

1. Определить route family и current/target upstream.
2. Добавить fail-closed target mapping.
3. Проверить headers/forwarding/body limits/timeouts.
4. Добавить canary и rollback control/evidence.
5. Запустить nginx -t и route smoke.
6. На cutover зафиксировать exact image digests/config hash и rollback path.

## Минимальная проверка

Перед завершением:

1. проверить соответствие каноническому документу программы;
2. проверить, что не создана новая скрытая cross-boundary зависимость;
3. выполнить targeted unit/integration/contract tests;
4. выполнить architecture/boundary tests для затронутого слоя;
5. проверить Docker build/health, если изменён runtime workload;
6. проверить observability и failure semantics, если изменён I/O/async path;
7. явно записать skipped checks и остаточный риск.


## M19 API Architecture

Public/private API allowlist определяется M19. Никогда не публиковать `agent-v1`/`internal-v1` через edge.


---

## next-nodejs-runtime

---
name: next-nodejs-runtime
description: "Use for any production Node.js workload in the new CoffeeOrderSystem architecture: Fastify servers, Kafka consumers/producers, channel ingress/egress, realtime SSE/WebSocket, Hermes Dispatcher, PostgreSQL pools, provider HTTP clients, event-loop/memory budgets, graceful shutdown, Docker/Kubernetes Node runtime, or Node-specific performance/security behavior."
---

# Next Node.js Runtime

## Source of truth

Read first:

- `M04_TYPESCRIPT_PLATFORM/06_NODEJS_RUNTIME_ARCHITECTURE.md`;
- `M15_RELIABILITY_OPERATIONS/07_NODEJS_RUNTIME_SLO_AND_CAPACITY.md`;
- owning program document (M06/M09/M19/etc.).

For Kafka also read `M06_KAFKA_EVENT_PLATFORM/04_NODEJS_KAFKA_RUNTIME.md`. For HTTP also read `M19_API_ARCHITECTURE/10_NODEJS_HTTP_RUNTIME_CONTRACT.md`.

## Scope

Applies only to target runtime under `platform/**` and target `infra/**`. Legacy `src/**` is reference/evidence, not Node design authority.

## Baseline

```text
Node.js 24 LTS
TypeScript strict
Fastify-first
one Node process = one container/pod role
bounded concurrency
AbortSignal/deadline propagation
explicit connection/memory/event-loop budgets
```

NestJS is not baseline and requires an ADR.

## Hard rules

- Do not use PM2/node cluster inside normal target containers for horizontal scale.
- Split `api-public`, `api-agent`, `api-internal` composition roots; do not mount all trust surfaces in one public process.
- No arbitrary `fetch()` from application/domain code; use typed fixed-origin provider clients with bounded pools/deadlines.
- No unbounded `Promise.all`/in-memory queues on server/consumer paths.
- Do not use blocking sync filesystem/child-process/compression/expensive crypto APIs in runtime paths.
- Large PDF/Excel/image/ML work stays outside API event loop.
- One PostgreSQL transaction uses one acquired `pg.Client`; never use `pool.query()` across a transaction.
- Pool sizing is fleet-wide; account for replicas × pool max and reserve DB headroom.
- Propagate `AbortSignal`/deadlines; a timeout without cancellation is incomplete.
- Cancellation is not proof an unsafe provider mutation did not happen; preserve idempotency/UnknownOutcome/reconciliation.
- JSON Schema request/response validation/serialization is required at HTTP boundary.
- `trustProxy: true` blanket setting is forbidden; trust only known edge/ingress chain.
- Domain money may use bigint, but JSON/Kafka wire representation must be versioned decimal/minor-unit string or other explicitly safe representation.
- Realtime SSE is isolated from API process and has bounded per-client output buffering.
- Multiple realtime replicas may not share one work-queue consumer group for broadcast to local clients; use the documented per-replica ephemeral group baseline until a backplane ADR exists.
- Fatal unknown process state is fail-fast: telemetry best-effort then exit and let supervisor restart.
- Cron/maintenance work does not live as permanent `setInterval()` inside API process.

## Required metrics

```text
event-loop utilization
event-loop delay p50/p95/p99
RSS
heap used/total
external memory
ArrayBuffers
GC pause
DB pool waiting/checkout wait
role-specific queue/connection metrics
```

CPU alone is not a sufficient scaling signal.

## Kafka rules

When Kafka is touched also use `next-kafka-event-platform`.

Preferred client candidate is `@confluentinc/kafka-javascript`, but dependency lock requires the documented Node24+pnpm+Docker compatibility spike because upstream marks pnpm support experimental.

Business consumers use shared `platform/packages/kafka-runtime`; do not reimplement rebalance/offset/heartbeat/retry logic in each module.

## HTTP rules

When HTTP/API is touched also use `next-api-architecture`.

Use shared `platform/packages/http-runtime` and typed `http-client/provider-clients` packages.

## Container rules

When Docker/Kubernetes is touched also use `next-docker-compose-runtime` / `next-kubernetes-microservices` as applicable.

Prefer glibc `node:24-bookworm-slim` for workloads with native Kafka/OTel dependencies until compatibility evidence justifies another base. Pin exact patch and digest.

## Verification

At minimum for changed production Node runtime:

1. typecheck/lint/unit/integration;
2. Docker build + startup smoke;
3. memory-limit smoke;
4. SIGTERM graceful shutdown/drain;
5. event-loop/RSS metrics visible;
6. provider/DB pool limits verified;
7. load test for changed concurrency path;
8. Kafka native-load/rebalance test when Kafka dependency/runtime changed;
9. slow-client test when realtime changed;
10. failure/restart recovery test for stateful/durable orchestration changes.

## Kafka runtime hardening coordination

Node Kafka workload следует M06 `04_NODEJS_KAFKA_RUNTIME.md` и `09_REPLAY_DLQ_AND_CONSUMER_RECOVERY.md`: durable consumers fail closed (`auto.commit=false`, `auto.offset.reset=none`, no auto topic), bounded per-partition in-flight/completed-ahead gap, safe drain/commit и stable client.id/principal.


---

## next-orders-migration

---
name: next-orders-migration
description: "Use for target Orders consistency-core: Order lifecycle/version/history, explicit Confirm, Desired/Observed/Convergence ownership, Order Card projection, checkout, invoice/payment handoffs, and final C#→TypeScript cutover."
---

# Orders Migration and Business Invariants

## Source of truth

`M12_ORDERS`, `M11_AROMA_GATEWAY`, `M20_SERVICE_ORCHESTRATION`.

## Hard rules

- Target Order lifecycle: `Draft -> Confirmed -> AwaitingCustomerPayment -> Completed`, plus guarded `Cancelled`.
- AROMA/fulfillment/checkout/payment are orthogonal state machines; never add them to `Order.Status`.
- **No target `sendToAromaCart`** and no `AromaCartFillBatch` rewrite.
- `Confirm` is local atomic transaction: status/history/Desired/revisions/Outbox; no external HTTP.
- Orders owns Desired/Observed/Convergence/Attempt/Lease/Fencing/UnknownOutcome/Checkout.
- Provider physical truth only from fresh successful AROMA GET.
- Catalog supplier price/name changes do not silently rewrite Confirmed Order snapshots.
- Catalog availability/mapping/tombstone facts may change Desired target through guarded Orders consumers; stable fulfillment can never be reintroduced.
- Positive convergence requires latest-complete Catalog supplier proof before AROMA cart mutation.
- After Confirm, no generic edit/return-to-Draft. Use explicit guarded commands.
- Hard delete normal path only for Draft; post-confirm business records use cancel/compensation.
- Target public concurrency uses application-owned OrderVersion, not permanent raw `xmin` contract.
- Invoice/Payment transitions require verified owner facts and Inbox/idempotency.
- Any service-link change activates `next-business-orchestration`.

## Migration target

Characterization compares against current authoritative Desired/Observed/Convergence/Checkout behavior. Legacy batch is only edge-case evidence.

## Required tests

- lifecycle transition matrix;
- property tests Desired contribution/revisions;
- UnknownOutcome/fencing;
- checkout freeze proof;
- invoice/price/payment correlation;
- duplicate/replay/out-of-order events;
- no cross-owner sync dependency in Confirm.

## End-to-end closure hard rules

- v1 procurement is **Order-atomic**; no hidden partial checkout/invoice coverage.
- `addConfirmedItem` is a first-class guarded command before freeze; it uses a current persisted Catalog quote snapshot, then atomically writes OrderItem + quote/provenance + Desired + history + Outbox.
- additions after freeze create a new related Order.
- AI/VK `Draft -> Confirmed` requires trusted channel proof or operator approval; LLM cannot create proof.
- Checkout→Invoice and Invoice→Orders handoffs use immutable ArtifactRef+hash manifests; cross-owner reads are forbidden.
- Wire BIGINT/UInt64 versions/revisions are decimal strings.


---

## next-payments-platform

---
name: next-payments-platform
description: "Use for target Payments bounded context, OrderPaymentRequired handoff, provider intent/webhook/reconciliation, PaymentSucceeded facts, refunds, and audited manual payment fallback."
---

# Payments Platform

## Hard rules

- Payments owns PaymentIntent/provider proof; Orders owns Order status.
- Consume `OrderPaymentRequired`; do not query Orders inside provider webhook transaction.
- Publish verified `PaymentSucceeded`; never patch Orders directly.
- Browser redirect is not proof.
- Provider timeout => reconcile/idempotency, not blind second payment.
- Manual `Деньги собраны` is explicit manual/cash/recovery mode, not fake provider success.
- Activate `next-business-orchestration` for cross-service changes.

## End-to-end closure hard rules

- Provider webhook is a dedicated `payments-webhook` workload with verified WebhookInbox before ACK/async processing.
- Refund/cancel are explicit stable-ref commands and facts; original PaymentSucceeded remains immutable.
- Late success after cancellation never resurrects Order; refund/incident policy decides next step.


---

## next-postgres-migration

---
name: next-postgres-migration
description: "Use for PostgreSQL DB0→DB5 migration, schema compatibility, Drizzle/node-postgres/raw SQL, transactions, migrations, single-writer ownership, and C#→TypeScript data cutover."
---

# PostgreSQL DB0→DB5 Migration

## Source of truth

Каноническая программа: `M05_DATABASE_MIGRATION`. Перед существенным изменением прочитать её `README.md` и релевантные нормативные документы. Если этот skill противоречит канонической программе, **побеждает каноническая программа**, а skill должен быть обновлён.

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

- новая repository/persistence model;
- чтение legacy schema из TS;
- migration ownership меняется EF→TS;
- schema cutover/read-only/shadow write;
- locks/isolation/indexes/NUMERIC/time semantics.

## Hard rules

- Один writer/migration owner на business schema в каждый момент.
- DB0 pure domain → DB1 DDL contract → DB2 sanitized clone RO → DB3 writable clone → DB4 production RO shadow → DB5 TS ownership.
- TS не получает production write до parity/cutover gate.
- Не запускать EF и TS migrations как concurrent authorities одной schema.
- Сложный locking/CTE/`FOR UPDATE SKIP LOCKED` разрешено писать raw SQL; ORM не должен скрывать semantics.
- Transaction всегда использует один acquired connection/client.
- Indexes/constraints — часть behavior contract, не только performance detail.

## Workflow

1. Экспортировать/прочитать реальный DDL и data anomalies.
2. Смоделировать TS persistence без изменения production schema.
3. Пройти DB1–DB3 integration tests.
4. DB4: read parity против C#.
5. Freeze legacy migrations для bounded schema.
6. Baseline target migrations.
7. DB5 cutover с backup/rollback и post-cutover verification.

## Минимальная проверка

Перед завершением:

1. проверить соответствие каноническому документу программы;
2. проверить, что не создана новая скрытая cross-boundary зависимость;
3. выполнить targeted unit/integration/contract tests;
4. выполнить architecture/boundary tests для затронутого слоя;
5. проверить Docker build/health, если изменён runtime workload;
6. проверить observability и failure semantics, если изменён I/O/async path;
7. явно записать skipped checks и остаточный риск.


---

## next-react-handover

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


---

## next-reliability-operations

---
name: next-reliability-operations
description: "Use for capacity models, backpressure, bulkheads, retry budgets, timeouts, SLO/SLI, OpenTelemetry, security boundaries, DR, fault injection, runbooks, and operational release gates."
---

# Reliability and Operations

## Source of truth

Каноническая программа: `M15_RELIABILITY_OPERATIONS`. Перед существенным изменением прочитать её `README.md` и релевантные нормативные документы. Если этот skill противоречит канонической программе, **побеждает каноническая программа**, а skill должен быть обновлён.

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

- новый I/O path/provider/queue;
- масштабирование;
- SLO/metrics/tracing;
- security/trust boundary;
- DR/backup/recovery;
- chaos/fault test.

## Hard rules

- Capacity моделируется через messages/sec, turns/sec, tools/turn, latency, tokens/sec, connection counts — не `maxUsers`.
- Каждый слой имеет bounded concurrency/backpressure; unlimited Promise/work queue запрещена.
- Retry имеет одного owner, budget, jitter и idempotency prerequisite.
- Timeout hierarchy задаётся от outer request budget к inner operation budget.
- Bulkheads разделяют ingress, egress, realtime, Hermes, business consumers, AROMA.
- Oldest queue/event age важнее одного lag count.
- OpenTelemetry trace проходит HTTP/Kafka/Hermes/tool path без PII/secrets.
- Security default deny; internal surfaces не публикуются через edge автоматически.
- DR определяется RPO/RTO и проверяется restore drill, а не наличием backup script.
- Node workloads имеют отдельные ELU/event-loop-delay/RSS/native-memory/connection-budget SLI.
- CPU alone не является достаточным Node saturation signal.
- SSE slow clients имеют bounded buffers и disconnect/reconnect recovery.

## Workflow

1. Для нового flow рассчитать workload/capacity assumptions.
2. Определить SLI/SLO и saturation signals.
3. Определить retry/timeout/backpressure owner.
4. Добавить metrics/logs/traces.
5. Добавить fault injection/chaos scenarios.
6. Добавить runbook и recovery evidence.
7. Не разрешать production cutover без M15 gate.

## Минимальная проверка

Перед завершением:

1. проверить соответствие каноническому документу программы;
2. проверить, что не создана новая скрытая cross-boundary зависимость;
3. выполнить targeted unit/integration/contract tests;
4. выполнить architecture/boundary tests для затронутого слоя;
5. проверить Docker build/health, если изменён runtime workload;
6. проверить observability и failure semantics, если изменён I/O/async path;
7. явно записать skipped checks и остаточный риск.


## M19 API Architecture

API SLO/error/auth/load/UnknownOutcome acceptance проверяются совместно с M19.


## Node runtime coordination

Для Node capacity/performance/runtime reliability активировать `next-nodejs-runtime` и читать M15 `07_NODEJS_RUNTIME_SLO_AND_CAPACITY.md`.

## Kafka platform coordination

Kafka reliability дополнительно требует `next-kafka-event-platform` и M15 `08_KAFKA_PLATFORM_SLO_AND_RECOVERY.md`. Проверять broker/minISR/controller health, partition skew, oldest-event-age, Debezium WAL/heartbeat, quotas, replay/DLQ age и explicit Kafka RPO/RTO. RF3/minISR2 не объявлять cross-cluster DR.


## BusinessLogicHardened service graph

Если задача меняет Orders/Catalog/AROMA/Invoices/Payments interaction, дополнительно активировать `next-business-orchestration` и проверить M20. Target не имеет direct Draft `sendToAromaCart`; `Confirm -> Desired -> Convergence` является нормальным supplier path.

## End-to-end closure hard rules

- Use M15 `11_BUSINESS_SLO_RPO_RTO_V1.md` as target release gate; metrics without numeric objectives are insufficient.
- Channel/agent message content is possible PII with 7-day Kafka retention baseline and sanitized training export.
- Artifact storage participates in backup/restore/integrity drills.


---

## next-system-design-governance

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


---

## next-typescript-platform

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


---

## next-verification-and-parity

---
name: next-verification-and-parity
description: "Use before completing any new-architecture migration, route cutover, DB ownership transfer, event pipeline change, Hermes runtime change, or legacy deletion. It protects tests as source of truth and requires characterization, parity, failure, and rollback evidence."
---

# Next Architecture Verification and Parity

## Scope

Применяется вместе с program skill. Этот skill не определяет ownership — он определяет доказательства безопасности перехода.

## Core rule

**Тесты и инварианты нельзя переписывать под новую реализацию только потому, что TypeScript/Hermes/Kafka ведут себя иначе.** Сначала доказать, что старый test устарел по принятому ADR/contract, и только затем менять test отдельным осознанным diff.

## Required test layers

1. Pure domain/unit invariants.
2. Contract/schema validation.
3. PostgreSQL integration with real engine.
4. Kafka duplicate/replay/crash tests for async flows.
5. Characterization tests against C# current behavior when migrating.
6. Differential/parity tests C# vs TS for same inputs.
7. Nginx route/canary/rollback smoke.
8. Docker/Compose integration.
9. Failure injection for unsafe/external paths.
10. Browser E2E for React-visible cutovers.
11. Load/capacity tests for throughput claims.
12. Restore/recovery drill for stateful workloads.

## Migration evidence states

```text
NotCompared
ShadowMismatch
ShadowParity
Canary
Primary
SoakAccepted
LegacyRemovable
```

Нельзя перескакивать `ShadowMismatch -> Primary`.

## Differential tests

Для C#→TS business logic:

```text
same fixture/input
  -> legacy C# decision/output
  -> target TS decision/output
  -> normalized semantic diff
```

Особенно обязательно для Orders, pricing, confirmation, invoice reconciliation, AROMA Desired/Observed.

## Unknown outcome tests

Каждый unsafe I/O path должен иметь сценарий:

```text
provider/server accepted mutation
response lost
caller uncertain
```

Acceptance: нет blind retry; выполняется fresh read/reconciliation/idempotent lookup.

## Property-based candidates

- quantity/weight/grind combinations;
- Money arithmetic;
- order lifecycle transitions;
- duplicate Kafka events;
- webhook duplicates/out-of-order;
- AROMA fencing/lease epochs;
- confirmation versions;
- Hermes turn ordering.

## Cutover checklist

Перед primary:

- parity threshold accepted;
- no unexplained mismatch;
- rollback tested;
- target observability live;
- SLO baseline captured;
- target DB writer ownership clear;
- legacy writer blocked where DB5 applies;
- exact image/config/contract digests recorded.

## Final report

Указать:

- tests run;
- parity evidence;
- failure scenarios;
- load level;
- skipped checks;
- rollback path;
- reason any legacy test/contract was changed.

## BusinessLogicHardened Orders/AROMA rule

При Orders/AROMA migration target parity строится против authoritative `Confirm -> Desired -> Observed -> Convergence -> Checkout` semantics. Legacy `sendToAromaCart`/`AromaCartFillBatch` не является обязательным target behavior; из него переносятся только безопасные edge-case invariants. Service links дополнительно проверяются по M20/`next-business-orchestration`.

## Catalog Product rewrite

For M07 require characterization for availability no-op/transition, product+variant tombstones, complete snapshot rejection, positive price history, stopped offer behavior, deterministic create/mapping, manual mapping preservation/propagation, remap old/new Desired keys and explicit Draft-only price refresh.
