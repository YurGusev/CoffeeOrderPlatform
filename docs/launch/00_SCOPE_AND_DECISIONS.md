# Границы и принятые решения

## Принятый подход

- Новая система строится сразу на микросервисах, без промежуточного модульного монолита.
- TypeScript strict, Node.js 26 Current, Fastify-first. Статус LTS не является
  ограничением: проект сознательно использует свежую ветку Node.js.
- React SPA; project-owned browser fetch client использует generated
  `client-v1` transport types; generated SDK/client запрещён; server state через
  TanStack Query.
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
- `api-public`;
- `api-internal`;
- `web`;
- `customer-service`;
- `catalog-service`, `catalog-supplier-sync` и `catalog-activation-worker`;
- `pricing-service`;
- `orders-service`;
- `orders-aroma-preparation`;
- `aroma-observer`;
- `aroma-convergence`;
- `aroma-gateway`;
- `realtime-gateway`.

Это exact set 15 из runtime catalog. `api-agent` planned/implemented=false и не
входит в первый запуск; `config-bootstrap` — init role, не runtime.

## Не входит в первый запуск

- invoices, payments, Hermes/VK и Work Center business commands;
- checkout AROMA и supplier invoice materialization;
- Kubernetes, multi-region Kafka, Redis, service mesh;
- legacy database import, dual-write, route strangler и C# parity;
- browser-owned retry unsafe AROMA mutation.

## Неподвижные инварианты

- `Confirm` не вызывает Catalog, Pricing или AROMA по HTTP.
- `Confirm` атомарно сохраняет Order, contribution, history и Outbox;
  cart-level Desired строит `orders-aroma-preparation` после commit.
- Orders владеет Desired/Observed/Convergence/Attempt/Lease/Fencing.
- AROMA Gateway владеет только provider session/protocol/HTTP.
- Failed provider GET не очищает последнее Observed.
- Timeout unsafe mutation означает `UnknownOutcome`, а не автоматический retry.
- React показывает server-derived state и `allowedActions`.
