# Матрица конфигурации 14 Node runtime и native nginx

Reference-профиль #162 по
[ADR-0031](../adr/ADR-0031-nginx-transport-and-application-auth.md) и
[контракту nginx](29_NGINX_TRANSPORT_AND_AUTH.md) заменяет public Node Edge proxy
и `web` runtime на native `edge-nginx` и private `edge-gateway` authorizer.
Остальные 13 Node ролей и прежние 5 owner DB не меняются. Это точное множество
из 15 runtime **разных типов**, а не «15 Node»; production admission принимает
#13, а не наличие строки в матрице.

Статус: нормативный input #19/#2/#3. Пустое значение записывается как `null` или
`[]`; скрытые defaults запрещены. Общие health paths: `/health/live`,
`/health/ready`, `/metrics`; общий shutdown grace `30000ms`, для realtime
`services.realtime-gateway.realtime.shutdownGraceMs=20000ms` (schema ≤20000ms).
Для каждой строки
`listen.host=0.0.0.0` внутри container; host publish только у nginx, на
`127.0.0.1:8443`. Node Permission manifest —
`config/permissions/<runtime>.json` только для Node ролей. У native nginx
health/live — лишь transport; readiness и metrics имеют отдельную applicability
по [контракту](29_NGINX_TRANSPORT_AND_AUTH.md), static 200 не доказывает
готовность API/auth/SSE.

Общий outbound HTTP pool для разрешённой пары: max connections 32, pipelining 1,
connect timeout 1s, idle timeout 30s; Gateway provider pool max 8. Kafka
partitions/retention берутся только из `06_EVENTS_AND_RECOVERY.md`. Каждый runtime
имеет directional `kafka.producers` и `kafka.consumers`; legacy `mode/topics/groups`
не допускаются, а topics и groups обязаны совпадать с таблицей ниже.
Mutation capability `true` только у `aroma-convergence` delegation и Gateway
transport handler; у остальных runtime explicit `false`.
Transport mode задан явно: только `edge-nginx` использует `public-tls` для
браузерного ingress и отдельную mTLS identity к upstream. Все 14 Node runtime,
включая `edge-gateway`, используют private `mtls` для внутренних соединений.

| Runtime                   | Port | Deadline / concurrency             | DB pool | Kafka                 | Secret refs                                                                                    | Разрешённые host:port / egress                                                                                    |
| ------------------------- | ---: | ---------------------------------- | ------: | --------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| edge-nginx                | 8443 | API 1s connect / 6s idle; auth 1s; SSE 45s idle | — | none | public TLS pair, own service transport only | edge-gateway:4000, api-public:4050, realtime-gateway:4401 |
| edge-gateway              | 4000 | 500ms auth / 320 admission           |       0 | none                  | OIDC client secret, actor signing, own service transport, telemetry | только проверенный OIDC issuer/JWKS; business egress нет |
| api-public                | 4050 | 4.5s / 400                         |       0 | none                  | service identity, actor verify, public delegation signing, telemetry                           | customer-service:4101, catalog-service:4102, pricing-service:4103, orders-service:4104                            |
| api-internal              | 4051 | caller deadline / 300              |       0 | none                  | service identity, delegation signing/verify, telemetry                                         | customer-service:4101, catalog-service:4102, pricing-service:4103, aroma-gateway:4301; route allowlist обязателен |

| customer-service          | 4101 | 2s / 100                           |       8 | none                  | postgres.customer, service identity, telemetry                                                 | coffee_postgres:5432                                                                                              |
| catalog-service           | 4102 | 2s / 150                           |       8 | none                  | postgres.catalogApi, service identity, cursor signing, telemetry                               | coffee_postgres:5432                                                                                              |
| catalog-supplier-sync     | 4201 | 15m / 1 export                     |       4 | none                  | postgres.catalogImport, service identity, telemetry                                            | coffee_postgres:5432, api-internal:4051                                                                           |
| catalog-activation-worker | 4202 | 5s DB batch / 1                    |       4 | P: snapshot, mapping | postgres.catalogActivate, kafka.catalog, service identity, telemetry                           | coffee_postgres:5432, kafka:9092, api-internal:4051                                                                 |
| pricing-service           | 4103 | 5s / 100                           |       8 | none                  | postgres.pricing, service identity, telemetry                                                  | coffee_postgres:5432, api-internal:4051                                                                           |
| orders-service            | 4104 | 5s / 150                           |       4 | P: lifecycle, commands, realtime | postgres.ordersService, kafka.orders, own transport, Orders delegation signing, api-public verification, telemetry | coffee_postgres:5432, api-internal:4051, kafka:9092 |
| orders-aroma-preparation  | 4203 | 5s / 16                            |       4 | P: commands, realtime; C: mapping, lifecycle, projection | postgres.ordersPreparation, kafka.orders, service identity, telemetry                          | coffee_postgres:5432, kafka:9092                                                                                  |
| aroma-observer            | 4204 | 15s / 4                            |       4 | P: aroma events | postgres.aromaObserver, kafka.orders, service identity, telemetry                              | coffee_postgres:5432, api-internal:4051, kafka:9092                                                               |
| aroma-convergence         | 4205 | 30s / 4                            |       4 | P: aroma events, realtime; C: commands | postgres.aromaConvergence, kafka.orders, service identity, telemetry                           | coffee_postgres:5432, api-internal:4051, kafka:9092                                                               |
| aroma-gateway             | 4301 | read 15m/cart 10s/mutation 10s / 8 |       8 | none                  | postgres.aromaGateway, AROMA credentials/session/catalog identity, service identity, telemetry | coffee_postgres:5432, exact `aroma.origin.host:443`                                                               |
| realtime-gateway          | 4401 | stream / technical cap 512         |       0 | C: realtime invalidation (realtime) | kafka.realtime, actor verify, service identity, telemetry                                      | kafka:9092; SSE является inbound stream                                                                           |

Для Orders принятое 27 сентября 2026 уточнение #8 добавляет в целевой scope
`security.ordersServiceDelegationSigningPrivateKey` и
`security.delegationVerificationKeys.api-public`; public verification Orders
остаётся в `security.serviceVerificationKeys.orders-service` у `api-internal`.
Точная модель и тесты — [service delegation](24_SERVICE_IDENTITY_AND_DELEGATION.md#orders-service-ключи-и-delegation-8).
Строка матрицы задаёт требование реализации, а не наличие material в runtime;
изменения secretRefs/schema/bootstrap проверяются в #8 без расширения egress.

`services.orders-service.dbPool.maxWaiting=100` задаёт конечную FIFO-очередь
checkout; у остальных DB runtime отсутствие поля означает 0 (fail-fast).
Пул Orders остаётся max4; HTTP deadline5000ms включает admission, checkout250ms
ограничивает последующее подключение, fleet budget не увеличивается.
Отмена/timeout/shutdown очищают ожидателей; правила
admission и метрик определяет [DB contract](05_DATA_OWNERSHIP.md).

### Kafka directional mapping

Для realtime точный public verifier ref —
`security.actorContextEdgeVerificationPublicKeys`; он материализуется через
trusted bootstrap вместе с собственным transport и Kafka identity. Actor signing
private key, PostgreSQL credential и чужой owner client этой роли запрещены.
`services.realtime-gateway.realtime` задаёт bounded queue/ring/RSS/FD limits;
значения и distinction между technical admission 512/513 и нагрузкой одной
вкладки описаны в [спецификации #12](20_REALTIME_SSE_IMPLEMENTATION_SPEC.md#6-fanout-и-backpressure).
Native worker budget учитывает оба socket slots каждого SSE и API/auth/health
reserve; boundary ceiling не является production admission.

Профиль `operator-1` #12 сохраняет reference budgets: по 2 CPU/512 MiB для
nginx/realtime, один nginx worker и один gateway. Основная когорта — один
subscriber, 100 ACKed invalidations/s для 100 subjects в течение 30min; отдельная
512/513 prephase не заменяет soak. Full-memory override и executable5000 удалены;
исторические receipts не переписываются. Frozen manifest закрепляет hashes
profile и synthetic fixture input без раскрытия секретов.
Начальная worker population и полная новая generation после HUP проверяются
фактически; RSS учитывает все worker processes.

`nginxTransport.limits.requestPoolBytes=2048` материализуется как
`request_pool_size 2048` публичного native server. Это гранулярность существующего
request allocator, не новый предел body/header, число соединений или RSS budget:
пул штатно расширяется по необходимости. Renderer и профильная schema отклоняют
отсутствующее, нецелое, непроверенное или внедряющее директиву значение. Actor/session
TTL, TLS groups/ciphers и container limits этим параметром не меняются.
Меньший observed requested набор одного SSE не заменяет полный capacity/recovery
proof и не является production admission.

Для `/events` сохраняется `proxy_buffering off`, но отдельного
`proxy_buffer_size` override нет: Nginx использует обычный page-sized upstream
response buffer (4 KiB в этом профиле) и для чтения тела ответа. Отключение
proxy buffering не делает этот буфер header-only. TLS transport использует
штатный Nginx из закреплённого официального образа; достаточность бюджета
подтверждается полным transport soak.

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
| `coffee_host_ingress`       | `false`                      | только `edge-nginx`; loopback host publish `127.0.0.1:8443`                               |

| `coffee_edge_backend`       | `true`                       | `edge-nginx`, `edge-gateway`, `api-public`, `realtime-gateway`                              |
| `coffee_public_api_backend` | `true`                       | `api-public`, Customer, Catalog, Pricing и Orders HTTP owners                                 |
| `coffee_internal_api`       | `true`                       | `api-internal` и только allowlisted callers/targets                                           |
| `coffee_postgres_data`      | `true`, external/pre-created | существующий `coffee_postgres`, разрешённые DB runtime и одноразовые migration/bootstrap jobs |
| `coffee_kafka_event`        | `true`                       | `kafka`, разрешённые Kafka runtime и одноразовый `kafka-provisioner`                          |
| `coffee_provider_egress`    | `false`                      | только `aroma-gateway`; единственный egress к exact AROMA origin                              |

`coffee_network` — legacy network существующих PostgreSQL/n8n. Она не входит в
platform policy и не указывается ни у одного нового runtime.

| Runtime                     | Exact Docker network attachments                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------------------ |
| `edge-nginx`                | `coffee_host_ingress`, `coffee_edge_backend`                                                      |
| `edge-gateway`              | `coffee_edge_backend`                                                                             |
| `api-public`                | `coffee_edge_backend`, `coffee_public_api_backend`                                               |
| `api-internal`              | `coffee_internal_api`                                                                            |

| `customer-service`          | `coffee_public_api_backend`, `coffee_internal_api`, `coffee_postgres_data`                       |
| `catalog-service`           | `coffee_public_api_backend`, `coffee_internal_api`, `coffee_postgres_data`                       |
| `catalog-supplier-sync`     | `coffee_internal_api`, `coffee_postgres_data`                                                    |
| `catalog-activation-worker` | `coffee_postgres_data`, `coffee_kafka_event`, `coffee_internal_api`                              |
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

- nginx: только public ingress, private Edge/api-public/realtime; owner/internal/provider запрещены;
- Edge authorizer: только private nginx caller и утверждённый OIDC outbound; business egress запрещён;
- api-public: public-api-backend; internal/provider/Kafka/Postgres запрещены;
- api-internal: internal-api targets; provider origin/Kafka/Postgres запрещены;
- owner runtime: только своя DB/роль и перечисленные HTTP/Kafka связи;
- Gateway: Integration DB + provider egress; Kafka и business DB запрещены;
- realtime: business DB запрещена.
- новый runtime в `coffee_network`, неизвестная network или неописанный
  host:port запрещены.

Негативный topology suite обязан доказать отказ Edge→owner,
`api-public`/`api-internal`→PostgreSQL/Kafka, Customer→Kafka, Gateway→Kafka,
non-Gateway→AROMA origin и любого нового runtime→`coffee_network`. В #19 эти
инварианты проверяются на policy/fixtures; реальные container connect probes
материализует #3.

`pnpm config:check` сравнивает эту таблицу с `platform.yaml`, service catalog,
Compose, Permission manifests и SOPS secretRef allowlists поле-в-поле.

## Настройки долговечных AROMA workers

Единственный источник несекретных настроек — `config/platform.yaml`. Поля
`aromaPreparation`, `aromaObservation`, `aromaConvergence` обязательны только
для соответствующих runtime; их передача другой роли запрещена и JSON Schema,
и runtime-парсером. У каждой группы настроек закрытый список ключей и конечные
положительные целочисленные пределы.

| Runtime | Настройки | Назначение |
|---|---|---|
| `orders-aroma-preparation` | `aromaPreparation.pollIntervalMs`, `batchSize`, `maxOrders`, `maxLines` | Период durable recovery/dirty-scope scan и пределы keyset batch/агрегации |
| `aroma-observer` | `aromaObservation.pollIntervalMs`, `intervalMs`, `leaseMs`, `maxSnapshotAgeMs`, `maxLines`, `maxResponseBytes` | Проверка сохранённого расписания, interval следующего наблюдения, claim lease и границы полного снимка |
| `aroma-convergence` | `aromaConvergence.pollIntervalMs`, `leaseMs`, `heartbeatIntervalMs`, `providerDeadlineMs`, `safetyMarginMs`, `retryBackoffMs`, `maxSnapshotAgeMs`, `maxLines`, `maxResponseBytes` | Durable wake-up/retry, удержание fence/reservation и bounded provider step |

`aromaConvergence.maxSnapshotAgeMs` также задаёт terminal-proof freshness для
preparation projection writer и Orders Card reader: composition roots читают
это значение из той же полной несекретной platform config, не создавая
service-local override или скрытый default. Полная группа `aromaConvergence`
не переносится в runtime config другой роли. HTTP cart response bound workers —
owning `maxResponseBytes: 2097152`, как в существующем InternalApi: полный
снимок 10 000 строк с optional grind hash помещается в 2 MiB. Общий request
`platform.bodyLimitBytes` остаётся 1 MiB. Observer deadline — из своего `deadlineMs`,
convergence provider deadline — из `aromaConvergence.providerDeadlineMs`.

Catalog владеет отдельным необязательным полем
`services.catalog-service.catalogSnapshotProof.maxAgeMs`: положительное safe
integer без default. Оно ограничивает возраст supplier snapshot для proof,
запрошенного convergence; не заменяет `aromaConvergence.maxSnapshotAgeMs`
физической корзины. При отсутствии значения Catalog возвращает convergence
`503 CATALOG_UNAVAILABLE`; Pricing caller не использует этот порог. В reference
config задано `7200000` ms (2 часа), утверждённое владельцем 4 октября 2026 года:
импорт запускается ежечасно, окно активации составляет до 15 минут, а возраст
считается от `supplier_snapshots.created_at` — начала импорта. Активация не
обновляет timestamp. Удаление поля из config оставляет его отсутствующим в
runtime-парсере и сохраняет fail-closed ответ; default не подставляется.

`services.aroma-convergence.mutationsEnabled` — обязательный отдельный boolean,
по умолчанию в reference config **`false`**. `mutationCapability: true` лишь
описывает доверенную роль и не включает физические изменения. Другим runtime
поле `mutationsEnabled` запрещено. Включение требует отдельного разрешения
владельца и доказанного launch gate; commit, CI или наличие typed клиента
не являются этим разрешением.

Runtime-парсер отклоняет observer lease, не покрывающий deadline чтения, и
convergence-настройки без безопасного окна lease/heartbeat/provider deadline.
Для первого запуска convergence lease равна 30 000 ms, heartbeat — 10 000 ms
по issue #11; JSON Schema и runtime-парсер отклоняют другие значения.
Настройка lease сама по себе не доказывает fencing: атомарные проверки времени
исполняются owning store по часам PostgreSQL. Durable schedule хранится в
Orders, а process timer только будит проверку сохранённого `next_*_at`;
restart не создаёт новое намерение и не теряет прежний pending intent.

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
