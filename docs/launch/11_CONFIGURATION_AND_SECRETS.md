# Единая конфигурация и единое хранилище секретов

Observability #64 использует required `config/platform.yaml.telemetry`: endpoints,
streams, producer/Collector limits, retention, disk breaker и alert windows без
hidden defaults. Только Collector получает `telemetry.openObserveIngestToken`,
trusted bootstrap — `telemetry.openObserveAdmin`; Node сохраняет producer ingest
token. Generated config и secrets находятся в tmpfs. Normal OpenObserve runtime
использует seeded persistent volume без admin secret. Новые encrypted leaves
остаются fail-closed до provisioning; второй secrets/config source запрещён.
OpenObserve writer limits (`memTableMaxSizeMiB`, два `maxFileSize*MiB`,
`maxFileRetentionSeconds`, `memPersistIntervalSeconds`) обязательны и проходят
schema/parser budget validation; точная политика и материализация описаны в
[runbook](../operations/observability.md#bootstrap-и-storage).
[Конкретный поток и runbook](../operations/observability.md).

Reference-профиль #162 содержит 14 Node runtime и один native nginx по
[29_NGINX_TRANSPORT_AND_AUTH.md](29_NGINX_TRANSPORT_AND_AUTH.md): public TLS scope
принадлежит `edge-nginx`, signing/OIDC — private `edge-gateway`, `web` runtime
исчезает, `apps/web` browser build остаётся. Примеры ниже не являются вторым
источником значений или доказательством production IdP/сертификатов.
Единственные value authorities остаются `config/platform.yaml` и зашифрованный
`secrets/platform.secrets.sops.yaml`.

## 1. Ровно два нормативных файла

| Назначение                | Путь                                 | Содержимое                                                                                                                   | Git                                   |
| ------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| Все несекретные настройки | `config/platform.yaml`               | endpoints, ports, timeouts, pools, limits, feature flags, topic names, runtime permission allowlists и ссылки на secret keys | хранится открыто                      |
| Все секреты               | `secrets/platform.secrets.sops.yaml` | пароли, private keys, tokens, provider credentials и encryption keys                                                         | хранится только в SOPS-encrypted виде |

Другие `.env`, `.env.local`, service-specific config files, отдельные password
files и секреты в Compose/CI запрещены. Допускаются только JSON Schemas,
проверяющие эти два файла: `config/platform.schema.json` и
`secrets/platform-secrets.schema.json`; они не содержат значений.

SOPS `3.13.3` шифрует YAML через age `1.3.2`. Private age identity никогда не
попадает в репозиторий или SOPS-файл. `.sops.yaml` содержит только правила
шифрования и public recipients, поэтому не является третьим файлом настроек.

## 2. Структура `config/platform.yaml`

```yaml
schemaVersion: 1
environment: development
toolchainRef: config/toolchain-versions.json

platform:
  publicBaseUrl: https://localhost:8443
  shutdownGraceMs: 30000
  requestDeadlineMs: 5000
  bodyLimitBytes: 1048576

postgres:
  host: coffee_postgres
  port: 5432
  sslMode: prefer

kafka:
  brokers: [kafka:9092]
  clientProtocol: SASL_SSL
  autoTopicCreation: false

services:
  customer-service:
    listen: { host: 0.0.0.0, port: 4101 }
    database: coffee_platform_customer
    secretRefs: [postgres.customer]
    outbound: []
    kafka: { topics: [], groups: [] }
    permissions: { net: [coffee_postgres:5432], fsRead: [], fsWrite: [] }
```

Файл обязан содержать точное множество 15 runtime из `10_RUNTIME_CATALOG.md`:
14 Node и один native nginx, без `web`.
`api-agent` присутствует только в authority как planned/implemented=false и не
входит в `services`/Compose. `config-bootstrap` описывается как initialization
role, а не runtime. Для каждого runtime
задаются `listen`, health paths, timeouts, pools, database или явное `null`,
Kafka topics/groups, outbound allowlist, `secretRefs` и Node Permission Model
allowlist. Отсутствующее значение не берётся из скрытого default: loader
завершает запуск ошибкой с полным YAML path.

Постоянные локальные пути age identity, резервной копии и проверка восстановления
зафиксированы в [LOCAL_PLATFORM](../platform/LOCAL_PLATFORM.md#постоянные-age-identities-и-резервная-копия-на-этом-сервере).
Перед provisioning и ротацией следовать этому порядку; единственный ключ в `/tmp`
не является постоянным хранилищем.

### Изоляция verification DB

По [ADR-0036](../adr/ADR-0036-launch-database-isolation.md) единственный YAML
сохраняет canonical DB names и disabled-by-default
`verification.databaseIsolation.enabled: false`. Явно включённый verification
candidate вне production вычисляет пять run-scoped имён из canonical ownership
и проверенных run-id/candidate SHA. Context не передаёт готовые DB names, grants
или credentials. Runtime получает только locator `COFFEE_LAUNCH_CONTEXT_FILE`
read-only regular файла metadata, проверяет base config SHA-256 и policy до DB
connect. Compose монтирует этот файл readonly только для такого candidate.
Отсутствующий context при enabled policy, context при disabled policy, symlink,
writable файл, неправильный SHA/owner и production завершаются ошибкой.

G18 хранит base и фактический config digest раздельно: только отключённый
`aroma-convergence` допускает единственную config-only замену ADR-0035.
Остальные runtime и восстановленный R обязаны использовать исходные байты B.
Этот metadata locator не является третьим источником настроек или секретов.

## 3. Структура `secrets/platform.secrets.sops.yaml`

До шифрования логическая схема имеет следующий вид; в Git каждое значение
ниже обязано быть `ENC[AES256_GCM,...]`:

```yaml
schemaVersion: 1
environments:
  development:
    bootstrap:
      postgresAdminPassword: ENC[...]
      internalCaPrivateKey: ENC[...]
    postgres:
      customer: {username: coffee_customer_rw, password: ENC[...]}
      catalogImport: {username: coffee_catalog_import_rw, password: ENC[...]}
      catalogActivate: {username: coffee_catalog_activate_rw, password: ENC[...]}
      catalogApi: {username: coffee_catalog_api_ro, password: ENC[...]}
      pricing: {username: coffee_pricing_rw, password: ENC[...]}
      ordersService: {username: coffee_orders_service_rw, password: ENC[...]}
      ordersPreparation: {username: coffee_orders_prepare_rw, password: ENC[...]}
      aromaObserver: {username: coffee_orders_observer_rw, password: ENC[...]}
      aromaConvergence: {username: coffee_orders_convergence_rw, password: ENC[...]}
      aromaGateway: {username: coffee_aroma_gateway_rw, password: ENC[...]}
    kafka:
      catalog: {username: catalog, password: ENC[...]}
      orders: {username: orders, password: ENC[...]}
      realtime: {username: realtime, password: ENC[...]}
    aroma:
      email: ENC[...]
      password: ENC[...]
      sessionEncryptionKey: ENC[...]
      catalogIdentityKeyV1: ENC[...]
    edge:
      tlsPrivateKey: ENC[...] # только edge-nginx, public TLS
      tlsCertificate: ENC[...] # только edge-nginx
      oidcClientSecret: ENC[...] # только edge-gateway
    security:
      actorContextEdgeSigningPrivateKey: ENC[...]
      actorContextEdgeVerificationPublicKeys:
        active: ENC[...]
        previous: ENC[...]
      apiPublicDelegationSigningPrivateKey: ENC[...]
      apiInternalDelegationSigningPrivateKey: ENC[...]
      catalogCursorSigningPrivateKey: ENC[...]
      customerCursorSigningPrivateKey: ENC[...]
      customerCursorVerificationPublicKeys:
        active: ENC[...]
        previous: ENC[...]
      delegationVerificationKeys:
        api-public:
          active: ENC[...]
          previous: ENC[...]
        api-internal:
          active: ENC[...]
          previous: ENC[...]
      serviceVerificationKeys:
        orders-service:
          active: ENC[...]
          previous: ENC[...]
      serviceTransportKeys: # each value decrypts to a JSON transport envelope
        edge-gateway: ENC[...]
        api-public: ENC[...]
        api-internal: ENC[...]
        edge-nginx: ENC[...] # требуется до реального запуска; provisioning отдельно
        customer-service: ENC[...]
        catalog-service: ENC[...]
        pricing-service: ENC[...]
        orders-service: ENC[...]
        catalog-supplier-sync: ENC[...]
        catalog-activation-worker: ENC[...]
        orders-aroma-preparation: ENC[...]
        aroma-observer: ENC[...]
        aroma-convergence: ENC[...]
        aroma-gateway: ENC[...]
        realtime-gateway: ENC[...]
    telemetry:
      exporterToken: ENC[...]
sops: {}
```

Секции `staging` и `production` имеют ту же schema, но отдельные ciphertext и
recipients. Пустые строки, plaintext, reusable default password и ссылки на
legacy `postgres/postgres` запрещены.

### Secret inventory и runtime refs

Inventory authority — это encrypted paths в `secrets/platform.secrets.sops.yaml`,
а runtime получает только refs, перечисленные одновременно в
`config/platform.yaml`, `config/service-catalog.json` и
`platform/launch-v1-runtime-profile.json`. Production wiring для затронутых runtime:

| Runtime            | Secret refs                                                                                                                                                                                                                                                                                         |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `edge-nginx`       | `edge.tlsPrivateKey`, `edge.tlsCertificate`, `security.serviceTransportKeys.edge-nginx` — public pair и собственная mTLS identity; нового ключа пока нет в зашифрованном source, до provisioning startup fail-closed                                                                                |
| `edge-gateway`     | `edge.oidcClientSecret`, `security.actorContextEdgeSigningPrivateKey`, `security.serviceTransportKeys.edge-gateway`, `telemetry.exporterToken`                                                                                                                                                      |
| `api-public`       | `security.apiPublicDelegationSigningPrivateKey`, `security.actorContextEdgeVerificationPublicKeys`, `security.serviceTransportKeys.api-public`, `telemetry.exporterToken`                                                                                                                           |
| `api-internal`     | `security.apiInternalDelegationSigningPrivateKey`, `security.serviceVerificationKeys.orders-service`, `security.serviceVerificationKeys.pricing-service`, `security.serviceTransportKeys.api-internal`, `telemetry.exporterToken`                                                                   |
| `customer-service` | `postgres.customer`, `security.customerCursorSigningPrivateKey`, `security.customerCursorVerificationPublicKeys`, `security.delegationVerificationKeys.api-public`, `security.delegationVerificationKeys.api-internal`, `security.serviceTransportKeys.customer-service`, `telemetry.exporterToken` |
| `catalog-service`  | `postgres.catalogApi`, `security.catalogCursorSigningPrivateKey`, `security.delegationVerificationKeys.api-public`, `security.delegationVerificationKeys.api-internal`, `security.serviceTransportKeys.catalog-service`, `telemetry.exporterToken`                                                  |
| `pricing-service`  | `postgres.pricing`, `security.pricingServiceDelegationSigningPrivateKey`, `security.delegationVerificationKeys.api-public`, `security.delegationVerificationKeys.api-internal`, `security.serviceTransportKeys.pricing-service`, `telemetry.exporterToken`                                          |

`edge-nginx` использует `public-tls`: его публичный listener предъявляет
`edge.tlsCertificate` с парой `edge.tlsPrivateKey`, но не требует service
certificate от браузера. К private targets он обращается только со своей
`security.serviceTransportKeys.edge-nginx` identity; public pair не является
внутренней client identity. `edge-gateway` использует только private mTLS и
отдельную actor signing identity; его OIDC secret не попадает в nginx. Остальные
HTTP Node runtime продолжают проверять scoped CA и SPIFFE SAN.
Наличие legacy ciphertext (например, прежнего web transport) в общем encrypted
source не даёт доступа runtime: `web` отсутствует в `services` и materialization
scope. Удаление/ротация исторического encrypted material требует отдельного
разрешения и не имитируется правкой документации. Новый nginx transport key
должен быть отдельно provisioned до реального запуска; fixture tests используют
только одноразовые материалы.

`security.customerCursorSigningPrivateKey` — отдельный Customer-scoped ключ;
он не переиспользуется для Catalog cursor, actor context, delegation или mTLS.
`security.pricingServiceDelegationSigningPrivateKey` используется только
`pricing-service` для исходящего signed service delegation. `api-internal`
получает лишь active/previous public verification keys: caller по mTLS без
действительной подписи и правильного `operationId` не авторизуется.
`catalog-activation-worker` использует только собственные scoped
`postgres.catalogActivate` и `security.serviceTransportKeys.catalog-activation-worker`:
последний устанавливает mTLS до allowlisted `api-internal` для Gateway binding.
Raw provider credentials, произвольный outbound URL и общий доступ к SOPS-файлу
worker не получает. Секрет HMAC source identity остаётся в Gateway.
Public verification metadata Customer cursor находится в
`security.customerCursor` в `config/platform.yaml`; active/previous public
material остаётся в SOPS inventory и materializes только для Customer.

## 4. Runtime-доступ без раскрытия общего файла

Один source-файл секретов не означает, что каждый сервис получает все секреты.

1. Trusted `config-bootstrap` читает `config/platform.yaml`, проверяет schema и
   decrypts `secrets/platform.secrets.sops.yaml` в памяти.
2. Он сверяет `services.<runtime>.secretRefs` и `optionalSecretRefs` с allowlist
   из service catalog. Optional ref materializes только если значение есть в
   encrypted inventory; его отсутствие не блокирует scoped file.
3. Для runtime создаётся только scoped ephemeral YAML в tmpfs
   `/run/secrets/coffee-platform.yaml`, mode `0400`, owner UID runtime.
4. Процесс получает только `COFFEE_CONFIG_FILE=/app/config/platform.yaml` и
   `COFFEE_RUNTIME_SECRETS_FILE=/run/secrets/coffee-platform.yaml`.
5. После запуска bootstrap очищает buffers и не записывает plaintext на disk,
   stdout, logs, artifacts, crash reports или shell history.

`config-bootstrap` — единственный процесс, имеющий право decrypt общего файла.
`edge-nginx`, `edge-gateway`, `api-public`, `api-internal` и `realtime-gateway` не
получают DB passwords. Bootstrap
admin password доступен только отдельной одноразовой provisioning-команде и не
попадает в runtime containers.

Для transport identity scoped materialization содержит только собственный
runtime material: leaf certificate, matching Ed25519 private key и certificate
chain/trust metadata, необходимую для проверки peer. CA private key туда не
входит. Общий trust metadata остаётся открытым в
`security.serviceTrustBundles`: `activeKid`, `previousKid`, 12-часовое overlap,
SAN binding из service identity contract и текущий environment. Runtime не
читает общий SOPS-файл и не получает чужой transport material.
Значение `security.serviceTransportKeys.<runtime>` после decrypt — строго JSON
строка с полями `keyPem`, `certPem`, `caPem`; runtime отклоняет неизвестные
поля, plaintext fallback и certificate с неправильным environment/runtime SAN.

## 5. Загрузка и приоритеты

- Единственный источник несекретных значений — `config/platform.yaml`.
- Единственный источник secret values — scoped materialization из SOPS-файла.
- Environment variables не переопределяют business/runtime settings. Разрешены
  только три locator-переменные: `COFFEE_CONFIG_FILE`,
  `COFFEE_RUNTIME_SECRETS_FILE`, `SOPS_AGE_KEY_FILE` у bootstrap.
- CLI flags не переопределяют значения, кроме `--check-config` и `--print-schema`.
- Unknown YAML keys запрещены; schema validation работает с `additionalProperties: false`.
- Config и secret schema versions проверяются до открытия network listeners.

## 5.1. Обязательный launch-профиль без скрытых defaults

Полная field-by-field authority находится в
[матрице 14 Node + 1 native runtime](23_RUNTIME_CONFIGURATION_MATRIX.md); `platform.yaml` не
может заменять её значением «по умолчанию».

Порты/DB pool: `edge-gateway 4000/0`, `api-public 4050/0`,
`api-internal 4051/0`, `edge-nginx 8443/native`,
`customer-service 4101/8`, `catalog-service 4102/8`,
`catalog-supplier-sync 4201/4`, `catalog-activation-worker 4202/4`,
`pricing-service 4103/8`, `orders-service 4104/4`,
`orders-aroma-preparation 4203/4`, `aroma-observer 4204/4`,
`aroma-convergence 4205/4`, `aroma-gateway 4301/8`,
`realtime-gateway 4401/0`. Steady application pool budget — 56;
serial rollout добавляет максимум 8, migrations/DBA reserve — 32;
итого 56 + 8 + 32 = 96 при `max_connections>=96`.

Для всех DB pools: checkout/lock timeout `250ms`, interactive statement
timeout `1500ms`, background `5000ms`, idle `30000ms`, max lifetime `1800000ms`.
Orders задаёт `dbPool.maxWaiting=100`, остальные runtime при отсутствии поля
используют 0. Admission ждёт под request/transaction signal до checkout;
фазы, отмену и счётчики определяет [DB contract](05_DATA_OWNERSHIP.md).
Health paths: `/health/live`, `/health/ready`, `/metrics`; interval `5000ms`,
timeout `1000ms`, startup grace `30000ms`, failure threshold `3`, success `1`.

Outbox/Inbox: poll `250ms`, batch `100`, claim lease `30000ms`, максимум 12
попыток, backoff `1s,5s,30s,60s`, published retention `168h`, failed/quarantine
`720h`. Invalid schema сразу quarantine, без бесконечного retry.

В `security.actorContext`: `Ed25519`, issuer `edge-gateway`, max age `60s`,
clock skew `5s`, overlap active/previous key `86400s`. В
`security.catalogCursor`: отдельный Ed25519 key, max age `86400s`, overlap
`172800s`. Active/previous `kid` и public verification keys находятся в
`platform.yaml`; private keys — только в SOPS. Старый key проверяет подписи лишь
до конца overlap и никогда не подписывает новые. Actor, cursor, TLS и OIDC keys
не переиспользуются друг для друга.

`security.customerCursor` — отдельная Customer-scoped Ed25519 policy с max age
`86400s`, clock skew `5s`, overlap metadata `172800s` и явным
`previousKeyTrustUntilEpochSeconds`. Envelope содержит `kid`, `iat` и `exp`;
новый token подписывается только active key, `exp` не может превышать
`iat + maxAgeSeconds`, а previous key принимается только до абсолютного
`previousKeyTrustUntilEpochSeconds`, независимо от возраста token. Неизвестный/
старый `kid`, просроченный token и token с будущим `iat` отвергаются. Customer
cursor key не совпадает с Catalog cursor, actor context, delegation или
transport key.

Полный issuance/SAN/TTL/rotation/revocation contract определён в
[service identity specification](24_SERVICE_IDENTITY_AND_DELEGATION.md).

Internal delegation context подписывает только `api-internal`; public actor
delegation подписывает только `api-public` отдельным ключом. Internal claims:
`iss=api-internal`, `aud=<target-runtime>`, `originalCaller`, `operationId`,
`iat`, `exp`, `jti`, `correlationId`, `traceparent`, `kid`. TTL не превышает
request deadline + 5s skew. Target проверяет transport mTLS identity =
`api-internal`, original caller и operation allowlist. Только delegated
`originalCaller=aroma-convergence` получает mutation audience Gateway.

Network matrix: `public-ingress` содержит edge/web; `public-api-backend` —
edge→api-public→owner services; `internal-api` — callers→api-internal→targets;
`provider-egress` разрешает outbound только `aroma-gateway` к allowlisted
origin. Edge→owner, api-public→internal/Gateway, api-internal→provider origin и
любой non-Gateway provider egress запрещены.

## 6. Проверки

Команда `pnpm config:check` обязана:

- валидировать оба YAML по schema;
- сверять точное множество 15 runtime с service catalog, а не только count;
- проверять, что каждый `secretRef` существует и разрешён runtime;
- запрещать plaintext по всем secret leaves;
- запрещать secret-like keys (`password`, `token`, `privateKey`, `secret`) в
  `config/platform.yaml`, Compose, CI и repository text;
- запрещать дополнительные `.env*` и `*secrets*` files, кроме allowlist;
- проверять, что runtime без БД не получает postgres secret;
- проверять SOPS MAC и recipients;
- проверять file mode `0400` scoped tmpfs и отсутствие plaintext после shutdown.

Обязательные негативные тесты:

1. `web` с `postgres.orders` → отказ с runtime и secretRef;
2. `catalog-service` с `postgres.orders` → отказ;
3. `aroma-gateway` без `aroma.password` → fail-fast до listener;
4. plaintext `password: test` → отказ;
5. unknown YAML key → отказ;
6. `.env` или пароль в Compose → отказ;
7. неверный SOPS MAC/recipient → отказ без partial startup;
8. secret попал в logger/error → redaction test падает.
9. `customer-service` имеет Kafka network/topic/group/credential → отказ;
10. `aroma-gateway` имеет Kafka network/topic/group/credential → отказ;
11. повторно использован actor/cursor/TLS/OIDC key или неизвестный `kid` → отказ.
12. Edge напрямую вызывает owner, client route смонтирован в `api-internal` или
    internal route в `api-public` → отказ;
13. forged `originalCaller`, неверный target/audience или mutation не от
    delegated `aroma-convergence` → `403 SERVICE_AUDIENCE_FORBIDDEN`;
14. `api-public`/`api-internal` имеют DB/Kafka/provider secret или egress → отказ;
15. `api-agent` попал в Compose либо `config-bootstrap` стал long-running → отказ.

## 7. Ротация

Ротация атомарно меняет private material в
`secrets/platform.secrets.sops.yaml` и соответствующие public keys/trust
bundle/active `kid` в `config/platform.yaml` одним русским PR. PR показывает
encrypted paths и public metadata, но не plaintext. Проверяются decrypt, schema,
overlap, restart всех затронутых runtime, rollback и audit record.
Компрометация общего файла считается компрометацией всех environments и требует
полной ротации; это осознанная цена требования «один файл».

## 8. Verification backup G17

Владелец 24 октября 2026 разрешил существующему trusted bootstrap использовать
закреплённый age 1.3.2, public recipients из `.sops.yaml` и документированный age
identity locator для backup/restore только пяти run-scoped verification DB.
Точный scope:
[принятое предложение G17](../../evidence/launch-preparation/2026-10-24/remaining-gates-authority-proposal.md).
Dump шифруется потоком, restore получает plaintext только через pipe. Ciphertext
и hashes сохраняются в evidence; runtime не получает age key, общий decrypted
bundle или новый secret scope. Отдельная bootstrap operation сначала проверяет
run/SHA/server/owner/source/restore targets и запрещает production/legacy.
