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
partitions/retention берутся только из `06_EVENTS_AND_RECOVERY.md`. Каждый runtime
имеет directional `kafka.producers` и `kafka.consumers`; legacy `mode/topics/groups`
не допускаются, а topics и groups обязаны совпадать с таблицей ниже.
Mutation capability `true` только у `aroma-convergence` delegation и Gateway
transport handler; у остальных runtime explicit `false`.
Transport mode задан явно: только `edge-gateway` использует `public-tls` для
браузерного ingress; остальные 14 runtime используют `mtls` для внутренних
listener/client соединений.

| Runtime                   | Port | Deadline / concurrency             | DB pool | Kafka                 | Secret refs                                                                                    | Разрешённые host:port / egress                                                                                    |
| ------------------------- | ---: | ---------------------------------- | ------: | --------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| edge-gateway              | 4000 | 5s / 500                           |       0 | none                  | public TLS key/certificate, optional public CA bundle, OIDC, actor signing, service transport, telemetry | web:3000, api-public:4050, realtime-gateway:4401                                                                  |
| api-public                | 4050 | 4.5s / 400                         |       0 | none                  | service identity, actor verify, public delegation signing, telemetry                           | customer-service:4101, catalog-service:4102, pricing-service:4103, orders-service:4104                            |
| api-internal              | 4051 | caller deadline / 300              |       0 | none                  | service identity, delegation signing/verify, telemetry                                         | customer-service:4101, catalog-service:4102, pricing-service:4103, aroma-gateway:4301; route allowlist обязателен |
| web                       | 3000 | 5s / 500                           |       0 | none                  | service transport identity                                                                     | none                                                                                                              |
| customer-service          | 4101 | 2s / 100                           |       8 | none                  | postgres.customer, service identity, telemetry                                                 | coffee_postgres:5432                                                                                              |
| catalog-service           | 4102 | 2s / 150                           |       8 | none                  | postgres.catalogApi, service identity, cursor signing, telemetry                               | coffee_postgres:5432                                                                                              |
| catalog-supplier-sync     | 4201 | 15m / 1 export                     |       4 | none                  | postgres.catalogImport, service identity, telemetry                                            | coffee_postgres:5432, api-internal:4051                                                                           |
| catalog-activation-worker | 4202 | 5s DB batch / 1                    |       4 | P: snapshot, mapping | postgres.catalogActivate, kafka.catalog, service identity, telemetry                           | coffee_postgres:5432, kafka:9092                                                                                  |
| pricing-service           | 4103 | 5s / 100                           |       8 | none                  | postgres.pricing, service identity, telemetry                                                  | coffee_postgres:5432, api-internal:4051                                                                           |
| orders-service            | 4104 | 5s / 150                           |       4 | P: lifecycle, commands, realtime | postgres.ordersService, kafka.orders, service identity, telemetry                              | coffee_postgres:5432, api-internal:4051, kafka:9092                                                               |
| orders-aroma-preparation  | 4203 | 5s / 16                            |       4 | P: commands, realtime; C: mapping, lifecycle, projection | postgres.ordersPreparation, kafka.orders, service identity, telemetry                          | coffee_postgres:5432, kafka:9092                                                                                  |
| aroma-observer            | 4204 | 15s / 4                            |       4 | P: aroma events | postgres.aromaObserver, kafka.orders, service identity, telemetry                              | coffee_postgres:5432, api-internal:4051, kafka:9092                                                               |
| aroma-convergence         | 4205 | 30s / 4                            |       4 | P: aroma events, realtime; C: commands | postgres.aromaConvergence, kafka.orders, service identity, telemetry                           | coffee_postgres:5432, api-internal:4051, kafka:9092                                                               |
| aroma-gateway             | 4301 | read 15m/cart 10s/mutation 10s / 8 |       8 | none                  | postgres.aromaGateway, AROMA credentials/session/catalog identity, service identity, telemetry | coffee_postgres:5432, exact `aroma.origin.host:443`                                                               |
| realtime-gateway          | 4401 | stream / 5000 connections          |       0 | C: realtime invalidation (realtime) | kafka.realtime, actor verify, service identity, telemetry                                      | kafka:9092; SSE является inbound stream                                                                           |

### Kafka directional mapping

`P` — producer topics, `C` — consumer subscriptions. Consumer `groupId` и
`processing` фиксированы и не выводятся из `mode`:

| Runtime | Producers | Consumers (`groupId`: topics; processing) |
|---|---|---|
| `catalog-activation-worker` | `coffee.catalog.snapshot.v1`, `coffee.catalog.mapping.v2` | — |
| `orders-service` | `coffee.orders.lifecycle.v1`, `coffee.aroma.cart.commands.v1`, `coffee.realtime.invalidate.v1` | — |
| `orders-aroma-preparation` | `coffee.aroma.cart.commands.v1`, `coffee.realtime.invalidate.v1` | `orders-catalog-mapping-v2`: `coffee.catalog.mapping.v2`; `orders-aroma-preparation-v1`: `coffee.orders.lifecycle.v1`; `orders-aroma-projection-v1`: `coffee.aroma.cart.events.v1` — `durable` |
| `aroma-observer` | `coffee.aroma.cart.events.v1` | — |
| `aroma-convergence` | `coffee.aroma.cart.events.v1`, `coffee.realtime.invalidate.v1` | `aroma-convergence-v1`: `coffee.aroma.cart.commands.v1` — `durable` |
| `realtime-gateway` | — | `realtime-gateway-v1`: `coffee.realtime.invalidate.v1` — `realtime` |

Все остальные runtime имеют пустые `producers` и `consumers`. `processing: realtime`
разрешён только для указанной строки `realtime-gateway`; он подтверждает offset
после локального ring/fanout enqueue и не получает DB/Inbox.

### Kafka delivery budgets

Глобальный `kafka.delivery` в `config/platform.yaml` задаёт bounded policy для
всех Kafka runtime: `maxMessageBytes=1048576`, `maxPartitions=24`,
`maxInFlight=4`, `queueCapacity=32`, `sendTimeoutMs=2000`,
`receiveTimeoutMs=1000`, `commitTimeoutMs=2000`, `revokeTimeoutMs=2000`,
`shutdownTimeoutMs=5000`, `leaseMs=30000`. Retry policy —
`baseMs=1000`, `maxMs=60000`, `maxAttempts=12`; quarantine destinations —
`durable=owner-database` и `realtime=topic-dlq`. Скрытые defaults и
service-local overrides запрещены.

`api-internal` operation allowlist берётся только из runtime catalog. Для
mutation требуется delegation `originalCaller=aroma-convergence`; Gateway
проверяет transport caller, target audience и operation. `api-agent` не имеет
строки: он planned/implemented=false и не запускается. `config-bootstrap` — init
role и не имеет listener/health/replicas.

## Физические Docker networks

Trust zone описывает доверие и route class; Docker network описывает только L3
adjacency. Это разные поля policy. #19 фиксирует следующие exact network names,
а #3 переносит их в Compose без переименования:

| Docker network              | `internal`                   | Участники / назначение                                                                        |
| --------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------- |
| `coffee_host_ingress`       | `false`                      | только `edge-gateway`; transport-only интерфейс для локальной публикации `127.0.0.1:4000`     |
| `coffee_public_ingress`     | `true`                       | ingress bridge для `edge-gateway` и `web`; host publish только у Edge                         |
| `coffee_edge_backend`       | `true`                       | `edge-gateway`, `api-public`, `realtime-gateway`                                              |
| `coffee_public_api_backend` | `true`                       | `api-public`, Customer, Catalog, Pricing и Orders HTTP owners                                 |
| `coffee_internal_api`       | `true`                       | `api-internal` и только allowlisted callers/targets                                           |
| `coffee_postgres_data`      | `true`, external/pre-created | существующий `coffee_postgres`, разрешённые DB runtime и одноразовые migration/bootstrap jobs |
| `coffee_kafka_event`        | `true`                       | `kafka`, разрешённые Kafka runtime и одноразовый `kafka-provisioner`                          |
| `coffee_provider_egress`    | `false`                      | только `aroma-gateway`; единственный egress к exact AROMA origin                              |

`coffee_network` — legacy network существующих PostgreSQL/n8n. Она не входит в
platform policy и не указывается ни у одного нового runtime.

| Runtime                     | Exact Docker network attachments                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------------------ |
| `edge-gateway`              | `coffee_host_ingress`, `coffee_public_ingress`, `coffee_edge_backend`                            |
| `api-public`                | `coffee_edge_backend`, `coffee_public_api_backend`                                               |
| `api-internal`              | `coffee_internal_api`                                                                            |
| `web`                       | `coffee_public_ingress`                                                                          |
| `customer-service`          | `coffee_public_api_backend`, `coffee_internal_api`, `coffee_postgres_data`                       |
| `catalog-service`           | `coffee_public_api_backend`, `coffee_internal_api`, `coffee_postgres_data`                       |
| `catalog-supplier-sync`     | `coffee_internal_api`, `coffee_postgres_data`                                                    |
| `catalog-activation-worker` | `coffee_postgres_data`, `coffee_kafka_event`                                                     |
| `pricing-service`           | `coffee_public_api_backend`, `coffee_internal_api`, `coffee_postgres_data`                       |
| `orders-service`            | `coffee_public_api_backend`, `coffee_internal_api`, `coffee_postgres_data`, `coffee_kafka_event` |
| `orders-aroma-preparation`  | `coffee_postgres_data`, `coffee_kafka_event`                                                     |
| `aroma-observer`            | `coffee_internal_api`, `coffee_postgres_data`, `coffee_kafka_event`                              |
| `aroma-convergence`         | `coffee_internal_api`, `coffee_postgres_data`, `coffee_kafka_event`                              |
| `aroma-gateway`             | `coffee_internal_api`, `coffee_postgres_data`, `coffee_provider_egress`                          |
| `realtime-gateway`          | `coffee_edge_backend`, `coffee_kafka_event`                                                      |

`platform/launch-v1-connectivity-policy.json` материализует таблицы полями
`dockerNetworks`, `hostPortPolicy.default=deny`, `allowedHostPorts`,
`allowedExternalEgress` и `denyAssertions`. DNS/IP назначения после resolution
тоже обязаны принадлежать allowlist; redirect к другому AROMA host запрещён.

## Permission/network invariants

- edge: public ingress + web/api-public/realtime; owner/internal/provider запрещены;
- api-public: public-api-backend; internal/provider/Kafka/Postgres запрещены;
- api-internal: internal-api targets; provider origin/Kafka/Postgres запрещены;
- owner runtime: только своя DB/роль и перечисленные HTTP/Kafka связи;
- Gateway: Integration DB + provider egress; Kafka и business DB запрещены;
- web/realtime: business DB запрещены.
- новый runtime в `coffee_network`, неизвестная network или неописанный
  host:port запрещены.

Негативный topology suite обязан доказать отказ Edge→owner,
`api-public`/`api-internal`→PostgreSQL/Kafka, Customer→Kafka, Gateway→Kafka,
non-Gateway→AROMA origin и любого нового runtime→`coffee_network`. В #19 эти
инварианты проверяются на policy/fixtures; реальные container connect probes
материализует #3.

`pnpm config:check` сравнивает эту таблицу с `platform.yaml`, service catalog,
Compose, Permission manifests и SOPS secretRef allowlists поле-в-поле.

## Бюджет replicas первого запуска

Первый запуск использует `replicas: 1` для каждого из 15 deployable runtime.
`postgres.rolloutReplicas: 1` разрешает только один дополнительный DB-backed
instance одновременно; rollout выполняется последовательно: следующая новая replica
запускается после остановки предыдущей. Это не увеличивает `maxConnections` или
owner pool автоматически. Для каждого DB pool `terminalTimeoutMs=2000` и
`transactionTimeoutMs=10000`; оба значения меньше `platform.shutdownGraceMs=30000`.
Перед увеличением числа replicas или rollout с overlap обязательна проверка:

```text
sum((steady replicas + temporary rollout replicas) × owner pool.max)
  + reservedConnections <= maxConnections
```

Текущая сумма steady pool maxima равна 56; с reserve 32 и одним крупнейшим
rollout pool 8 получается ровно 96. Превышение блокирует startup/admission
typed configuration error. Автоматическое удвоение replicas запрещено без
пересчёта. Database foundation по ADR-0025 проверяет бюджет и ограничивает
admission, а не увеличивает PostgreSQL limits молча.

При зафиксированном serial rollout временная часть формулы применяется к одному
выбранному DB-backed runtime; admission проверяет худший вариант
`max(owner pool.max) × postgres.rolloutReplicas`, а не одновременный rollout
всех owners.
Realtime #12 дополнительно материализует process-wide SSE memory/FD budget и
проверяет его soak test; per-connection limit сам по себе не доказывает capacity.

`kafka.delivery.producerRetries: 3` явно ограничивает native broker transport retry внутри `sendTimeoutMs=2000`. Producer использует idempotence, `acks=all` и один in-flight request на connection. Это не повтор owner handler/provider effect; durable Outbox retry policy задаётся отдельно.

Kafka scoped secret сохраняет `{username, password}`; необязательный `caPem`
задаёт частный CA, в том числе для disposable Compose proof. Без `caPem`
используется системное хранилище доверенных CA. Проверка сертификата и hostname
не отключается; общий encrypted secrets-файл runtime не получает.
