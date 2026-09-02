# Архитектура исполнения

## Единицы развёртывания

Точные HTTP/event contracts, исходящие вызовы, БД, роли, секреты и публичность
каждого runtime заданы в [нормативном каталоге](10_RUNTIME_CATALOG.md). Таблица
ниже является кратким индексом и не предоставляет исполнителю свободу выбирать
недостающие значения.

| Runtime | Владелец | Назначение | Доступ к данным |
|---|---|---|---|
| `edge-gateway` | Platform | TLS, auth handoff, routing, limits | none |
| `api-public` | Platform | stateless `client-v1` trust/composition root | none |
| `api-internal` | Platform | stateless `internal-v1` trust/delegation root | none |
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
Browser -> edge -> api-public -> /api/client-v1/* -> owning services
Browser -> edge -> /events          -> realtime-gateway
Workers -> api-internal -> /api/internal-v1/* -> owning services/Gateway
api-internal -> aroma-gateway -> allowlisted provider origin
```

Edge не содержит business authorization, не обращается к PostgreSQL и не имеет
маршрута непосредственно к owner services. `api-public`/`api-internal` не имеют
business DB, Kafka или provider credentials. Delegation context позволяет
Gateway проверить transport caller, original caller и operation audience.
AROMA credentials доступны только `aroma-gateway`.

Эти trust zones не совпадают один-к-одному с Docker networks. Exact physical
attachments, отдельные `coffee_postgres_data`/`coffee_kafka_event`, разрешённые
host:port и default-deny проверки заданы в
[матрице runtime](23_RUNTIME_CONFIGURATION_MATRIX.md). Ни один новый runtime не
подключается к legacy `coffee_network`.

## Технические пакеты платформы

```text
contracts, config, database, migrations, http-runtime, http-client,
security, observability, idempotency, outbox, inbox, kafka-runtime, testing
```

Бизнес-типы не помещаются в общие пакеты. Межсервисные зависимости разрешены
только через versioned Effect Schema/HttpApi contracts и их generated
OpenAPI/JSON Schema artifacts.

## Добавление нового runtime

Каталог первого запуска является закрытым exact set. Шестнадцатый runtime не
добавляется только правкой Compose или созданием каталога. До реализации нужны:

1. отдельный принятый ADR с причиной новой process/trust/failure boundary;
2. один названный владелец данных, API, событий, retry и восстановления;
3. versioned HTTP/event contracts без межвладельческого SQL;
4. обновление service/DB/interaction/secret manifests и их JSON Schema;
5. RED tests для cross-owner import, DB claim и неизвестного interaction;
6. отдельный русскоязычный issue, ветка и PR в `develop`.

До создания workspace в #3 проверки #2 запускаются напрямую:

```text
node scripts/check-service-catalog.mjs
node scripts/check-database-ownership.mjs
node scripts/check-architecture.mjs
node --test tests/architecture/checks.test.mjs
```

#3 подключает их без изменения semantics к `pnpm architecture:check` и фиксирует
`dependency-cruiser@18.2.0` в manifest/lockfile. Второй TypeScript compiler для
Dependency Cruiser не добавляется: project-owned wrapper применяет правила к
AST dependency graph и нормализует NodeNext `.js` specifier к source `.ts`.
