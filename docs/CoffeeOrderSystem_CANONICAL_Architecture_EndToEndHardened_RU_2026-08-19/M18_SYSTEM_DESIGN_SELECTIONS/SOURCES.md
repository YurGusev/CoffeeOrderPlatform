# Источники и evidence

## Текущий CoffeeOrderSystem

Архитектурный пакет опирается на актуальные файлы ветки `develop`, в частности:

- `src/CoffeeOrderSystem.Web/` — существующий React client;
- `src/CoffeeOrderSystem.Web/package.json` — React Router/Vite/TanStack/OpenAPI/Vitest/Playwright toolchain и текущая прямая зависимость API generation от `CoffeeOrderSystem.API/obj/openapi`;
- `src/CoffeeOrderSystem.Web/Dockerfile` — Node build stage + Nginx runtime;
- `src/CoffeeOrderSystem.Web/nginx.conf` — SPA fallback, immutable Vite assets, CSP/health;
- `docs/architecture/07_react_frontend_platform.md` — принятая React SPA architecture;
- `edge/nginx.conf` и route-map files — neutral edge/canary/rollback foundation;
- `docker-compose.yml` — текущий reference runtime и PostgreSQL/API/migrations;
- `docs/Архитектура/MODULAR_MONOLITH_PLAN.md` — bounded context/schema preparation.

## System-design repositories, отфильтрованные под CoffeeOrderSystem

1. `donnemartin/system-design-primer`
   - capacity/back-of-envelope;
   - load balancing;
   - caching trade-offs;
   - message queues/backpressure;
   - SQL scaling only after bottleneck evidence.

2. `ashishps1/awesome-system-design-resources`
   - idempotency;
   - rate limiting;
   - consistent hashing;
   - CDC;
   - tracing;
   - circuit breaker;
   - push/pull, sync/async trade-offs.

3. `systemdesign42/system-design-academy`
   - real scaling case studies;
   - Nginx/concurrency;
   - Stripe idempotency/rate limiting;
   - payment systems;
   - database migration lessons;
   - microservices failure lessons;
   - chaos engineering.

4. `InterviewReady/system-design-resources`
   - DB-as-queue antipattern;
   - Transactional Outbox/Saga;
   - event-driven architecture;
   - domain-oriented microservices/nanoservice caution;
   - Docker/capacity;
   - deterministic distributed testing/TLA+/Jepsen references.

## Официальные технологии для implementation verification

Перед реализацией pin/version review выполняется по официальной документации соответствующего проекта:

- Node.js / TypeScript;
- React / React Router / Vite;
- Nginx;
- Docker / Docker Compose;
- Apache Kafka;
- Debezium;
- PostgreSQL;
- Kubernetes / KEDA;
- OpenTelemetry;
- Hermes Agent;
- AReaL (training only).

## Принцип использования источников

System-design repositories используются как источник patterns/trade-offs, а не как указание автоматически внедрять все перечисленные технологии. Нормативный отбор находится в `01_SYSTEM_DESIGN_SELECTIONS.md`.

## Node.js runtime hardening — первичные источники

- Node.js release status / LTS: https://nodejs.org/en/about/previous-releases
- Node.js event loop guidance: https://nodejs.org/en/learn/asynchronous-work/dont-block-the-event-loop
- Node.js `perf_hooks` ELU / event-loop delay: https://nodejs.org/api/perf_hooks.html
- Fastify Server / `trustProxy` / runtime options: https://fastify.dev/docs/latest/Reference/Server/
- Fastify validation and response serialization: https://fastify.dev/docs/v5.8.x/Reference/Validation-and-Serialization/
- node-postgres pooling: https://node-postgres.com/features/pooling
- node-postgres pool sizing: https://node-postgres.com/guides/pool-sizing
- node-postgres transactions: https://node-postgres.com/features/transactions
- Confluent JavaScript Kafka client: https://github.com/confluentinc/confluent-kafka-javascript
