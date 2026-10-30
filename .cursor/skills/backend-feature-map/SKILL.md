---
name: backend-feature-map
description: Карта операций и событий бэкенда apps и статуса их покрытия. Use when a backend route, Kafka message, or slice-skill coverage row needs to be checked or updated.
---

# Карта фич бэкенда

Это указатель, а не прогон. Сервисы он не поднимает. Живой срез customer остаётся в
[customer-slice-verify](../customer-slice-verify/SKILL.md). Карта экранов `apps/web`
остаётся в [verify-web](../verify-web/SKILL.md).

Состав сервисов и строки покрытия лежат в [README.md](README.md). У каждого
сервиса свой файл в `features/`.

Предметные навыки не копировать. Для правки поведения читать их и менять код там:

- HTTP и trust surfaces: [http-api-contracts](../../../.agents/skills/http-api-contracts/SKILL.md)
- Kafka, Outbox и Inbox: [event-driven-services](../../../.agents/skills/event-driven-services/SKILL.md)
- Orders: [orders-lifecycle](../../../.agents/skills/orders-lifecycle/SKILL.md)
- Customer, Catalog, Pricing: [customer-catalog-pricing](../../../.agents/skills/customer-catalog-pricing/SKILL.md)
- AROMA: [aroma-cart-integration](../../../.agents/skills/aroma-cart-integration/SKILL.md)
- процесс и deadlines: [node-service-runtime](../../../.agents/skills/node-service-runtime/SKILL.md)
- PostgreSQL: [postgres-service-ownership](../../../.agents/skills/postgres-service-ownership/SKILL.md)
- отказы и SLO: [reliability-verification](../../../.agents/skills/reliability-verification/SKILL.md)
- границы сервисов: [greenfield-microservices](../../../.agents/skills/greenfield-microservices/SKILL.md)

Строка карты меняется в том же PR, что и маршрут, событие или навык среза.
Сверка всей карты с кодом описана в README.
