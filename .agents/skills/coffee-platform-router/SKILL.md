---
name: coffee-platform-router
description: Выбрать навыки для задачи CoffeeOrderPlatform.
---

# Маршрутизатор CoffeeOrderPlatform

Использовать `AGENTS.md` и навигацию `docs/launch/README.md` для выбора документов
затронутой области. Канонические roots определяют бизнес-инварианты, но не процесс
миграции; читать в них только применимые документы. Техническую authority задаёт
ADR-0025, prerequisites — `docs/launch/13_DELIVERY_DEPENDENCY_GRAPH.md`.
Историческая Effect-линия #48–#55 больше не является планом реализации.

В Hermes загружать выбранный навык через `skill_view(name="<имя>")`, а не
копировать его в глобальную библиотеку. Загружать только навыки текущей области;
ссылки на проектные документы читать через `read_file` от корня репозитория.
Вложенные `AGENT_SKILLS_NEW_ARCHITECTURE` — исторические источники, не активные навыки.

| Сигнал | Навыки |
|---|---|
| service boundary, ownership, topology, technology | `greenfield-microservices` |
| Node/Fastify process, pools, cancellation | `node-service-runtime` |
| HTTP/OpenAPI/auth/errors/webhook/SSE | `http-api-contracts` |
| Kafka, commands/events, Outbox/Inbox | `event-driven-services` |
| PostgreSQL, migrations, transactions, locks | `postgres-service-ownership` |
| Customer, Catalog, supplier snapshot, Pricing | `customer-catalog-pricing` |
| живой срез customer-service и его PostgreSQL | прочитать `.cursor/skills/customer-slice-verify/SKILL.md` |
| Draft, Confirm, Order, Desired/Observed | `orders-lifecycle` |
| AROMA Gateway, convergence, unsafe mutation | `aroma-cart-integration` |
| React/operator UI/client-v1 | `react-operator-frontend` |
| макеты сайта, прототип экрана, сравнение визуальных направлений | `web-mockup-workflow`; `react-operator-frontend` для интерфейса платформы |
| invoice, allocation, reconciliation | `invoices-service`; `artifact-processing` при изменении документов |
| payment intent, webhook, refund, provider proof | `payments-service` |
| VK/channel identity/media, production Hermes-channel | `channel-hermes-platform` |
| operator queues, projections, typed recovery | `work-center-operations` |
| documents, media, ArtifactRef, scanning | `artifact-processing` |
| Docker, Compose, CI/CD, images, deployment | `platform-delivery` |
| failures, recovery, security, SLO | `reliability-verification` |
| issue authoring/audit | `issue-authoring` |
| handoff, PR, merge, closure | `issue-delivery-closure` |

При пересечении границ применять несколько владеющих навыков. Пересматривать
маршрут только при обнаружении новой области задачи. Неоднозначность владельца,
доверия, writer данных, побочных эффектов или публичного контракта сначала
разрешить по доступным документам. Если её устранить не удалось, уточнить у
пользователя до зависимых правок, продолжая независимую разрешённую работу.
Внешние записи требуют явного разрешения; уже выданное в беседе разрешение
сохраняется, пока scope и последствия не изменились.
