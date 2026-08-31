# M00. Сводка канонических архитектурных решений

**Статус:** source of truth для новой архитектуры CoffeeOrderSystem.  
**Дата:** 2026-08-19.

## 1. Цель перехода

CoffeeOrderSystem переезжает с существующего C# modular-monolith runtime на **clean-room TypeScript-first online platform** без big-bang rewrite.

```text
ТЕКУЩЕЕ / MIGRATION SOURCE             ЦЕЛЕВОЕ
--------------------------------      ---------------------------------
src/*.NET                              platform/*.ts
ASP.NET application runtime            Node.js/TypeScript online platform
C# hosted workers                      TypeScript process roles / Kafka consumers
DB-as-transport polling                Kafka where workload is transport-only
src/CoffeeOrderSystem.Web              platform/apps/web (copy-first)
public neutral Nginx edge               public Nginx Strangler Edge
React static Nginx                      platform-web internal Nginx
C# AI/VK runtime                        Node channels + Hermes
AReaL as production runtime target      Hermes production; AReaL training-only
```

## 2. Что остаётся неизменным по смыслу

Переезд языка не отменяет доменные гарантии:

- PostgreSQL остаётся business/process source of truth;
- Order, Customer, Catalog, Invoice, Payment принадлежат своим bounded contexts;
- AROMA external state проверяется свежими чтениями;
- unsafe external mutation не повторяется вслепую после неопределённого результата;
- explicit confirmation остаётся backend-validated proof;
- idempotency обязательна для replay/retry;
- Kafka не является заменой business database;
- Hermes не получает прямой доступ к domain DB или AROMA;
- React не вычисляет business truth.

## 3. Clean-room принцип

Новая платформа создаётся в `/platform` рядом с `/src` и не импортирует C# implementation artifacts.

Разрешённые источники поведения:

- versioned OpenAPI/HTTP contracts;
- PostgreSQL DDL, constraints и реальные query semantics;
- Kafka contracts;
- characterization tests;
- sanitized production-like datasets;
- доказанное корректное поведение старой реализации;
- явно выписанные invariants.

Запрещено:

- ссылаться из TypeScript runtime на .NET assemblies;
- генерировать domain model из EF entities как runtime dependency;
- допускать двух writers одной schema;
- переносить старое поведение без characterization/evidence.

## 4. Web delivery состоит из трёх разных слоёв

```text
Browser
  ↓
coffee-edge             = public Nginx, TLS, strangler, canary, rate limits
  ↓ /app/*
platform-web            = internal Nginx, immutable React/Vite SPA artifacts
  ↓
React                   = browser application/runtime
```

**Отдельный Node.js React server не является первым target.** Node используется на build-stage frontend image. SSR/streaming/BFF допускаются только отдельным ADR после доказанной необходимости.

## 5. Nginx — инструмент миграции, а не только reverse proxy

`coffee-edge` владеет:

- public port/TLS;
- route-family ownership;
- C# ↔ TypeScript strangler switch;
- frontend artifact cutover;
- canary/rollback;
- route-scoped body limits;
- coarse rate limiting;
- `/events` и `/channels` proxy;
- security headers/trusted forwarding chain.

## 6. Docker — foundation

Каждый deployable target workload имеет Dockerfile до production cutover. Docker Compose — локальная исполняемая reference architecture. Kubernetes оркестрирует те же immutable images позже.

## 7. TypeScript/Node.js — target online platform

Target language/runtime ownership:

```text
TypeScript / Node.js:
  React toolchain
  API/business platform
  Kafka consumers/producers where direct transport is needed
  channel ingress/egress
  realtime gateway
  Hermes dispatcher
  provider gateways

Python:
  Hermes runtime/plugin
  AReaL training/ML tooling

C#:
  migration/reference implementation only
  production workloads постепенно → 0
```

## 8. Kafka

Kafka — durable asynchronous backbone:

- work distribution;
- fan-out;
- replay;
- partition ordering;
- backlog/backpressure visibility.

Для transaction-bound business events используется:

```text
Business transaction
+ Outbox row
→ PostgreSQL WAL
→ Debezium/Kafka Connect
→ Kafka
```

Не использовать централизованный Node Kafka proxy для всех domain events.

## 9. Database migration

Подключение PostgreSQL начинается рано, production write ownership передаётся поздно:

```text
DB0 — pure domain
DB1 — real DDL/constraints
DB2 — sanitized read-only clone
DB3 — writable shadow clone
DB4 — production read-shadow
DB5 — production write ownership
```

Одна schema в каждый момент времени имеет только одного writer/migration owner.

## 10. Hermes и AReaL

```text
Production:
Kafka → TypeScript Hermes Dispatcher → Hermes Runtime Pool → CoffeeOrder Plugin → agent-v1

Training:
Sanitized Hermes trajectories → dataset/evaluator → SFT/QLoRA/AReaL RL → candidate model → Hermes shadow/canary
```

AReaL не находится в production request path.

## 11. Microservices

Target — domain-oriented selective services, а не nanoservices. Сначала logical bounded contexts + separate process roles. Physical extraction происходит только при operational reason: scaling, failure isolation, security, release cadence или provider boundary.

## 12. Cross-cutting guarantees

До production обязательны:

```text
capacity model
backpressure
bulkheads
idempotency
retry budgets
outbox/CDC
per-route rate limiting
tracing
SLO
DR/recovery
fault injection
parity testing
```

## 13. Не добавлять преждевременно

Без измеримой необходимости не вводятся:

- service mesh;
- mandatory Redis;
- database sharding;
- Cassandra/Dynamo-like primary storage;
- event sourcing как business source of truth;
- GraphQL/gRPC everywhere;
- microfrontends;
- distributed lock service;
- десятки мелких network microservices.

## 14. BusinessLogicHardened Orders/AROMA decision

Нормальный supplier flow новой платформы:

```text
Draft -> Confirmed + Desired -> Catalog preparation -> Observed/Convergence
-> Checkout/Wholesale proof -> Invoices -> Payment -> Completed
```

Target не переносит direct Draft `sendToAromaCart` и `AromaCartFillBatch` как архитектуру. AROMA Gateway является provider boundary, а Desired/Observed/Convergence/Checkout остаются Orders ownership. Межсервисные связи и anti-cycle rules определяет M20.

## Catalog Product ownership clarification

Catalog Product/Variant/Alias, complete supplier snapshots, supplier list prices/history, availability and AROMA mapping are Catalog-owned. Orders owns customer/pricing-policy snapshots and all Desired/Observed/Convergence reactions. Catalog price changes do not auto-reprice confirmed orders; availability/mapping facts may change cart eligibility through Orders.
