# M00. Языки и runtime ownership

## 1. Каноническое решение

Целевая online-платформа CoffeeOrderSystem — **TypeScript-first на Node.js**.

Это означает не «Kafka реализована на JavaScript», а:

> online application, event, channel, realtime и orchestration workloads проектируются на TypeScript/Node.js; Kafka остаётся language-agnostic backbone.

## 2. TypeScript / Node.js

В target входят:

- `api-public`, `api-agent`, `api-internal` Node/Fastify API roles;
- Customer/Catalog/Orders/Invoices/Payments application services;
- Kafka business consumers после migration;
- Channel Ingress/Egress;
- Realtime Gateway;
- Hermes Dispatcher;
- AROMA Gateway;
- provider webhooks;
- operational projections;
- shared contracts/validation/observability libraries.

## 3. React

React-код также TypeScript, но живёт как browser runtime. Production SPA build раздаётся внутренним `platform-web` Nginx container.

## 4. Python

Python сохраняется там, где он является естественным runtime:

- Hermes Agent Runtime;
- Hermes CoffeeOrder plugin;
- training/evaluation tooling;
- AReaL/ML.

Business truth в Python не переносится.

## 5. C#/.NET

C# становится migration/reference implementation:

- источник characterization behavior;
- временный production owner ещё не мигрировавших bounded contexts;
- rollback owner только пока DB/schema остаётся совместимой.

Финальный target — zero C# production workloads.

## 6. Business event publication

После TypeScript migration transaction-bound business event публикуется через Outbox+CDC, а не через внешний JS proxy:

```text
TypeScript transaction
  UPDATE domain
  INSERT outbox
COMMIT
  ↓
Debezium
  ↓
Kafka
```

## 7. Запрет language-driven architecture

Не создавать лишний service только ради языка. Bounded context и operational ownership важнее uniformity. Если специализированный CPU/ML/PDF workload обоснован другим runtime, он может быть выделен отдельно.
