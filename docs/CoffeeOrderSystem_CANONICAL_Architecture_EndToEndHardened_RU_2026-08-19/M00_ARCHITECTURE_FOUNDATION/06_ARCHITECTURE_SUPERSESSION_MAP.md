# M00. Карта supersession старых архитектурных решений

Этот документ устраняет двусмысленность между предыдущими пакетами.

## 1. Production Agent Runtime

**Устарело:** AReaL как production agent runtime.  
**Канон:** Hermes — production runtime; AReaL — training-only.

## 2. Business backend language

**Устарело как конечная цель:** TypeScript только для transport/event platform, C# как постоянная Business Platform.  
**Канон:** TypeScript/Node.js — target online business/event platform; C# временно остаётся migration/reference owner.

## 3. React hosting

**Устарело:** отдельный Node.js React server как обязательный production host.  
**Канон первого этапа:** `platform-web` = внутренний static Nginx runtime с immutable React/Vite SPA. Node.js используется на build-stage. SSR/streaming/BFF — отдельный future ADR.

## 4. React implementation

**Устарело:** переписывать React одновременно с backend.  
**Канон:** copy-first существующего `src/CoffeeOrderSystem.Web` в `platform/apps/web`, затем contract decoupling и handover.

## 5. Kafka integration language

**Устарело:** идея одного централизованного Node Kafka proxy для всех C# domain events.  
**Канон:** Kafka native clients/CDC; transaction-bound events — Outbox+Debezium. Node/TS владеет channel/realtime/Hermes orchestration и target business consumers после migration.

## 6. Backend migration style

**Устарело:** file-by-file rewrite внутри `src/`.  
**Канон:** clean-room `/platform` рядом с `/src`, parity/shadow/canary и bounded-context ownership cutover.

## 7. Database integration timing

**Устарело:** подключить реальную БД только после полного написания backend.  
**Канон:** DB0→DB5 ladder; DDL/clone подключается рано, production write ownership — поздно.

## 8. Kubernetes timing

**Устарело:** Kubernetes как первый шаг новой платформы.  
**Канон:** Docker/process split/Compose/health/observability сначала; Kubernetes затем оркестрирует доказанные workloads.

## 9. Microservices

**Устарело:** microservice per module/class.  
**Канон:** domain-oriented selective extraction; Orders остаётся cohesive consistency-core до доказанной необходимости дробления.


## 10. API architecture

**Устарело:** один общий `/api` surface для browser, agent, internal services и provider callbacks; трактовка OpenAPI как типа «Open API».  
**Канон:** отдельная M19 API Architecture с `client-v1`, `agent-v1`, `internal-v1`, explicit webhook/callback surfaces, outbound provider adapters, Kafka event APIs и realtime SSE. OpenAPI — language-neutral specification format для HTTP contracts.

## Node.js runtime hardening supersession

Следующие ранние формулировки считаются superseded:

| Ранее | Канон теперь |
|---|---|
| `NestJS modules where useful + Fastify` | Fastify-first; NestJS только отдельным ADR |
| один абстрактный `platform-api` | `api-public` + `api-agent` + `api-internal` separate composition roots/processes |
| CPU/RPS как основные Node capacity signals | ELU + event-loop delay + RSS/native memory + connection/queue budgets |
| timeout без общей cancellation semantics | ExecutionContext + AbortSignal/deadline propagation |
| произвольный `fetch()` допустим в adapters | typed fixed-origin provider clients + bounded pools |
| Kafka JS client не выбран | `@confluentinc/kafka-javascript` preferred candidate после Node24+pnpm+Docker compatibility spike |
| realtime replicas могут быть обычной consumer group | broadcast invalidation: unique ephemeral group per realtime replica до отдельного backplane ADR |
| generic Docker Node image | Node 24 LTS exact patch/digest; glibc slim preferred for native Kafka/OTel workloads |


## Kafka hardening supersession

| Предыдущее решение | Каноническое решение |
|---|---|
| дублирующие Markdown topic catalogs | `M06/kafka-topic-registry.yml` — единственный source of truth |
| `coffee.catalog.indexing.v1` mixed command/event | superseded; search projection consumes `coffee.catalog.products.v1` |
| промежуточные `coffee.catalog.indexing.commands.v1` + `coffee.catalog.indexing.events.v1` | superseded; separate indexing topics удалены из canonical baseline до отдельного ADR |
| `coffee.aroma.cart.v1` mixed event/trigger | `coffee.aroma.cart.commands.v1` + `coffee.aroma.cart.events.v1` |
| один generic event envelope с `messageKind` | separate integration event + integration command envelopes |
| implicit consumer offset reset/default auto-commit | durable consumers fail closed: manual commit + `auto.offset.reset=none` |
| partition count можно увеличить как capacity tweak | active keyed topic partition count = versioned cutover contract |
| Debezium = просто WAL -> Kafka | explicit slot/publication/snapshot/heartbeat/WAL/backpressure contract |
| RF3 = DR | RF3/minISR = local durability; cross-cluster RPO/RTO — отдельный DR contract |

## BusinessLogicHardened supersession

Следующие legacy concepts не являются target architecture:

```text
Draft -> sendToAromaCart
AromaCartFillBatch/AromaCartFillLine as target work model
browser-managed AROMA batch resend/polling as business orchestration
OrderConfirmed -> immediate invoice creation without checkout/wholesale proof
AROMA Gateway as owner of Desired/Observed/Convergence
```

Их supersede:

```text
Confirm -> Orders Desired -> Catalog facts -> Orders Convergence
-> immutable Checkout/Wholesale proof -> Invoices -> Payments
```

Cross-service authority определяет M20.
