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
