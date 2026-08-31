# Scope and Decisions

## Принятый подход

- Greenfield microservices-first, без промежуточного модульного монолита.
- TypeScript strict, Node.js 24 LTS, Fastify-first.
- React SPA; OpenAPI-generated client; server state через TanStack Query.
- PostgreSQL — authoritative state, отдельная database/schema и writer на owner.
- Kafka — durable asynchronous transport; business state в Kafka не хранится.
- HTTP — немедленные query/command и bounded provider calls.
- SSE — invalidation и progress для браузера.
- Docker Compose — первый воспроизводимый runtime; Kubernetes не нужен для MVP.

## В первой вертикали реализуются

- `edge-gateway`;
- `web`;
- `customer-service`;
- `catalog-service` и `catalog-supplier-sync`;
- `pricing-service`;
- `orders-service`;
- `orders-aroma-preparation`;
- `aroma-observer`;
- `aroma-convergence`;
- `aroma-gateway`;
- `realtime-gateway`.

## Не входит в первый запуск

- invoices, payments, Hermes/VK и Work Center business commands;
- checkout AROMA и supplier invoice materialization;
- Kubernetes, multi-region Kafka, Redis, service mesh;
- legacy database import, dual-write, route strangler и C# parity;
- browser-owned retry unsafe AROMA mutation.

## Неподвижные инварианты

- `Confirm` не вызывает Catalog, Pricing или AROMA по HTTP.
- `Confirm` атомарно сохраняет Order, Desired, history и Outbox.
- Orders владеет Desired/Observed/Convergence/Attempt/Lease/Fencing.
- AROMA Gateway владеет только provider session/protocol/HTTP.
- Failed provider GET не очищает последнее Observed.
- Timeout unsafe mutation означает `UnknownOutcome`, а не автоматический retry.
- React показывает server-derived state и `allowedActions`.

