# Матрица конфигурации 15 runtime

Статус: нормативный input #19/#2/#3. Пустое значение записывается как `null` или
`[]`; скрытые defaults запрещены. Общие health paths: `/health/live`,
`/health/ready`, `/metrics`; shutdown grace `30000ms`. Для каждой строки
`listen.host=0.0.0.0` внутри container, metrics обслуживается на том же port по
`/metrics`; host publish разрешён только edge, а web доступен через Edge proxy.
Node Permission manifest —
`config/permissions/<runtime>.json`; отсутствие файла блокирует startup.

Общий outbound HTTP pool для разрешённой пары: max connections 32, pipelining 1,
connect timeout 1s, idle timeout 30s; Gateway provider pool max 8. Kafka
partitions/retention берутся только из `06_EVENTS_AND_RECOVERY.md`; строка
`producer|consumer` обязана перечислять exact topics/groups в `platform.yaml`.
Mutation capability `true` только у `aroma-convergence` delegation и Gateway
transport handler; у остальных runtime explicit `false`.

| Runtime | Port | Deadline / concurrency | DB pool | Kafka | Secret refs | Разрешённый outbound |
|---|---:|---|---:|---|---|---|
| edge-gateway | 4000 | 5s / 500 | 0 | none | TLS, OIDC, actor signing, service transport, telemetry | web:3000, api-public:4050, realtime:4401 |
| api-public | 4050 | 4.5s / 400 | 0 | none | service identity, actor verify, telemetry | customer:4101, catalog:4102, pricing:4103, orders:4104 |
| api-internal | 4051 | caller deadline / 300 | 0 | none | service identity, delegation signing/verify, telemetry | exact allowlisted target only |
| web | 3000 | 5s / 500 | 0 | none | service transport identity | none |
| customer-service | 4101 | 2s / 100 | 8 | none | postgres.customer, service identity, telemetry | none |
| catalog-service | 4102 | 2s / 150 | 8 | none | postgres.catalogApi, service identity, cursor signing, telemetry | none |
| catalog-supplier-sync | 4201 | 15m / 1 export | 4 | none | postgres.catalogImport, service identity, telemetry | api-internal:4051 |
| catalog-activation-worker | 4202 | 5s DB batch / 1 | 4 | producer | postgres.catalogActivate, kafka.catalog, telemetry | Kafka only |
| pricing-service | 4103 | 5s / 100 | 8 | none | postgres.pricing, service identity, telemetry | api-internal:4051 |
| orders-service | 4104 | 5s / 150 | 12 | producer | postgres.ordersService, kafka.orders, service identity, telemetry | api-internal:4051, Kafka |
| orders-aroma-preparation | 4203 | 5s / 16 | 4 | consumer+producer | postgres.ordersPreparation, kafka.orders, telemetry | Kafka only |
| aroma-observer | 4204 | 15s / 4 | 4 | consumer+producer | postgres.aromaObserver, kafka.orders, service identity, telemetry | api-internal:4051 |
| aroma-convergence | 4205 | 30s / 4 | 4 | consumer+producer | postgres.aromaConvergence, kafka.orders, service identity, telemetry | api-internal:4051 |
| aroma-gateway | 4301 | read 15m/cart 10s/mutation 10s / 8 | 8 | none | postgres.aromaGateway, AROMA credentials/session/catalog identity, service identity, telemetry | allowlisted AROMA HTTPS only |
| realtime-gateway | 4401 | stream / 5000 connections | 0 | consumer | kafka.realtime, actor verify, telemetry | SSE sockets only |

`api-internal` operation allowlist берётся только из runtime catalog. Для
mutation требуется delegation `originalCaller=aroma-convergence`; Gateway
проверяет transport caller, target audience и operation. `api-agent` не имеет
строки: он planned/implemented=false и не запускается. `config-bootstrap` — init
role и не имеет listener/health/replicas.

## Permission/network invariants

- edge: public ingress + api-public/realtime; owner/internal/provider запрещены;
- api-public: public-api-backend; internal/provider/Kafka/Postgres запрещены;
- api-internal: internal-api targets; provider origin/Kafka/Postgres запрещены;
- owner runtime: только своя DB/роль и перечисленные HTTP/Kafka связи;
- Gateway: Integration DB + provider egress; Kafka и business DB запрещены;
- web/realtime: business DB запрещены.

`pnpm config:check` сравнивает эту таблицу с `platform.yaml`, service catalog,
Compose, Permission manifests и SOPS secretRef allowlists поле-в-поле.
