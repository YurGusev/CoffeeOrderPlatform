# Границы и принятые решения

## Принятый подход

- Новая система строится сразу на микросервисах, без промежуточного модульного монолита.
- TypeScript strict, Node.js 24 LTS, Fastify-first.
- React SPA; OpenAPI-generated client; server state через TanStack Query.
- Используется уже работающий PostgreSQL 17; второй PostgreSQL не поднимается.
  Legacy-БД `coffeeorderdb` не изменяется. Для новой платформы на существующем
  сервере создаются отдельные логические БД и роли владельцев.
- Kafka — долговечный асинхронный транспорт; бизнес-состояние в Kafka не хранится.
- HTTP — немедленные запросы/команды и ограниченные вызовы провайдера.
- SSE — инвалидация и отображение прогресса в браузере.
- Docker Compose — первое воспроизводимое окружение; Kubernetes для первой версии не нужен.
- Точные версии runtime, библиотек и инструментов берутся из
  [реестра версий](09_EXISTING_DATABASE_AND_VERSIONS.md); диапазоны и `latest` запрещены.

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
