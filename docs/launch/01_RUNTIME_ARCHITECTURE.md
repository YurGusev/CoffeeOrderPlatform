# Runtime Architecture

## Deployment units

| Runtime | Owner | Назначение | Data access |
|---|---|---|---|
| `edge-gateway` | Platform | TLS, auth handoff, routing, limits | none |
| `web` | Frontend | React static assets | none |
| `customer-service` | Customer | customer commands/queries | customer DB |
| `catalog-service` | Catalog | products, mappings, availability | catalog DB |
| `catalog-supplier-sync` | Catalog | complete safe AROMA catalog reads | catalog DB |
| `pricing-service` | Pricing | quote calculation and validation | pricing DB |
| `orders-service` | Orders | Draft, Confirm, Order Card | orders DB |
| `orders-aroma-preparation` | Orders | reacts to Catalog facts, updates Desired | orders DB |
| `aroma-observer` | Orders | safe physical cart reads | orders DB |
| `aroma-convergence` | Orders | leased GET-mutate-GET attempts | orders DB |
| `aroma-gateway` | Integration | provider session and typed primitives | integration DB/cache only |
| `realtime-gateway` | Realtime | SSE invalidation fanout | no business DB |

Каждый runtime — один Node process на container. Масштабирование выполняется
replicas, а не `node:cluster` или PM2.

## Trust surfaces

```text
Browser -> edge -> /api/client-v1/* -> owning services
Browser -> edge -> /events          -> realtime-gateway
Workers -> /api/internal-v1/*       -> private network only
Orders convergence -> aroma-gateway -> allowlisted provider origin
```

Edge не содержит business authorization и не обращается к PostgreSQL.
AROMA credentials доступны только `aroma-gateway`.

## Platform packages

```text
contracts, config, database, migrations, http-runtime, http-client,
security, observability, idempotency, outbox, inbox, kafka-runtime, testing
```

Business types не помещаются в shared packages. Межсервисные зависимости
разрешены только через versioned OpenAPI/JSON Schema contracts.

