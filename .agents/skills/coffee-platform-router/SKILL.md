---
name: coffee-platform-router
description: Маршрутизировать значимую работу CoffeeOrderPlatform к минимальному набору навыков архитектуры, runtime, контрактов, данных, доменов, frontend и проверки. Использовать в начале задачи и при изменении затронутой области.
---

# Маршрутизатор CoffeeOrderPlatform

Прочитать `AGENTS.md`, `docs/launch/README.md`, текущий delivery graph и
применимый accepted ADR. Канонические roots определяют бизнес-инварианты, но не
технологический baseline и не процесс миграции. До закрытия `#55` соблюдать
единственную последовательность `#48 → #49 → #50 → #51 → #52 → #53 → #54 → #55`:
каждая задача начинается только после merge предыдущей. Business delivery
остаётся заблокированной. После `#55` продолжать с `#4` и дальше по зависимостям
issues.

| Сигнал | Навыки |
|---|---|
| service boundary, ownership, topology, technology | `greenfield-microservices` |
| Effect/Node process, Layer/Scope, pools, cancellation | `node-service-runtime` |
| Effect HttpApi/OpenAPI/auth/errors/webhook/SSE | `http-api-contracts` |
| Kafka adapter, commands/events, Outbox/Inbox | `event-driven-services` |
| Effect SQL/PostgreSQL, migrations, transactions, locks | `postgres-service-ownership` |
| Customer, Catalog, supplier snapshot, Pricing | `customer-catalog-pricing` |
| Draft, Confirm, Order, Desired/Observed | `orders-lifecycle` |
| AROMA Gateway, convergence, unsafe mutation | `aroma-cart-integration` |
| React/Effect Atom/operator UI/client-v1 | `react-operator-frontend` |
| invoice, allocation, PDF, reconciliation | `invoices-service`, `artifact-processing` |
| payment intent, webhook, refund, provider proof | `payments-service` |
| VK/channel identity/media/Hermes | `channel-hermes-platform` |
| operator queues, projections, typed recovery | `work-center-operations` |
| documents, media, ArtifactRef, scanning | `artifact-processing` |
| Docker, Compose, images, deployment | `platform-delivery` |
| failures, recovery, security, SLO | `reliability-verification` |
| issue authoring, body/checklist, scope, boundaries, acceptance | `issue-authoring` |
| issue checklist, handoff, commit/push, PR/merge, closure | `issue-delivery-closure` |

При пересечении границ применять несколько владеющих навыков. Повторно проверять
маршрут после исследования, перед правками, проверкой и отправкой. Остановиться,
если неоднозначны владелец, доверие, writer данных, побочные эффекты или публичный
контракт. Внешние записи требуют актуального явного разрешения.

При создании или переписывании issue применять `issue-authoring` после owning
skill. При завершении issue применять `issue-delivery-closure` после owning skill
изменённой области; эти навыки не заменяют domain/runtime verification.
