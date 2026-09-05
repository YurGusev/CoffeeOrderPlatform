---
name: coffee-platform-router
description: Маршрутизировать значимую работу CoffeeOrderPlatform к минимальному набору навыков архитектуры, runtime, контрактов, данных, доменов, frontend и проверки. Использовать в начале задачи и при изменении затронутой области.
---

# Маршрутизатор CoffeeOrderPlatform

Прочитать `AGENTS.md` и `docs/launch/README.md`. Канонические roots определяют
бизнес-инварианты, но не процесс миграции. Техническую authority задаёт
ADR-0025, prerequisites — `docs/launch/13_DELIVERY_DEPENDENCY_GRAPH.md`.
Историческая Effect-линия #48–#55 больше не является планом реализации.

| Сигнал | Навыки |
|---|---|
| service boundary, ownership, topology, technology | `greenfield-microservices` |
| Node/Fastify process, pools, cancellation | `node-service-runtime` |
| HTTP/OpenAPI/auth/errors/webhook/SSE | `http-api-contracts` |
| Kafka, commands/events, Outbox/Inbox | `event-driven-services` |
| PostgreSQL, migrations, transactions, locks | `postgres-service-ownership` |
| Customer, Catalog, supplier snapshot, Pricing | `customer-catalog-pricing` |
| Draft, Confirm, Order, Desired/Observed | `orders-lifecycle` |
| AROMA Gateway, convergence, unsafe mutation | `aroma-cart-integration` |
| React/operator UI/client-v1 | `react-operator-frontend` |
| invoice, allocation, PDF, reconciliation | `invoices-service`, `artifact-processing` |
| payment intent, webhook, refund, provider proof | `payments-service` |
| VK/channel identity/media/Hermes | `channel-hermes-platform` |
| operator queues, projections, typed recovery | `work-center-operations` |
| documents, media, ArtifactRef, scanning | `artifact-processing` |
| Docker, Compose, CI/CD, images, deployment | `platform-delivery` |
| failures, recovery, security, SLO | `reliability-verification` |
| issue authoring/audit | `issue-authoring` |
| handoff, PR, merge, closure | `issue-delivery-closure` |

При пересечении границ применять несколько владеющих навыков. Повторно проверять
маршрут после исследования, перед правками, проверкой и отправкой. Остановиться,
если неоднозначны владелец, доверие, writer данных, побочные эффекты или публичный
контракт. Внешние записи требуют актуального явного разрешения.
