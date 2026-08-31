# Архитектура исполнения

## Единицы развёртывания

Точные HTTP/event contracts, исходящие вызовы, БД, роли, секреты и публичность
каждого runtime заданы в [нормативном каталоге](10_RUNTIME_CATALOG.md). Таблица
ниже является кратким индексом и не предоставляет исполнителю свободу выбирать
недостающие значения.

| Runtime | Владелец | Назначение | Доступ к данным |
|---|---|---|---|
| `edge-gateway` | Platform | TLS, auth handoff, routing, limits | none |
| `web` | Frontend | React static assets | none |
| `customer-service` | Customer | customer commands/queries | customer DB |
| `catalog-service` | Catalog | products, mappings, availability | catalog DB |
| `catalog-supplier-sync` | Catalog | complete safe AROMA catalog reads | catalog DB |
| `catalog-activation-worker` | Catalog | validate/atomically activate received generations + Outbox | catalog DB |
| `pricing-service` | Pricing | quote calculation and validation | pricing DB |
| `orders-service` | Orders | Draft, Confirm, Order Card | orders DB |
| `orders-aroma-preparation` | Orders | reacts to Catalog facts, updates Desired | orders DB |
| `aroma-observer` | Orders | safe physical cart reads | orders DB |
| `aroma-convergence` | Orders | leased GET-mutate-GET attempts | orders DB |
| `aroma-gateway` | Integration | provider session and typed primitives | integration DB/cache only |
| `realtime-gateway` | Realtime | SSE invalidation fanout | no business DB |

Каждый runtime — один Node process на container. Compose новой платформы
подключает процессы к уже работающему `coffee_postgres` и не создаёт второй
PostgreSQL. Масштабирование выполняется
replicas, а не `node:cluster` или PM2.

## Границы доверия

```text
Browser -> edge -> /api/client-v1/* -> owning services
Browser -> edge -> /events          -> realtime-gateway
Workers -> /api/internal-v1/*       -> private network only
Orders convergence -> aroma-gateway -> allowlisted provider origin
```

Edge не содержит business authorization и не обращается к PostgreSQL.
AROMA credentials доступны только `aroma-gateway`.

## Технические пакеты платформы

```text
contracts, config, database, migrations, http-runtime, http-client,
security, observability, idempotency, outbox, inbox, kafka-runtime, testing
```

Бизнес-типы не помещаются в общие пакеты. Межсервисные зависимости
разрешены только через версионированные контракты OpenAPI/JSON Schema.
