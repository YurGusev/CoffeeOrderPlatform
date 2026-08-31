# Единая конфигурация и единое хранилище секретов

## 1. Ровно два нормативных файла

| Назначение | Путь | Содержимое | Git |
|---|---|---|---|
| Все несекретные настройки | `config/platform.yaml` | endpoints, ports, timeouts, pools, limits, feature flags, topic names, runtime permission allowlists и ссылки на secret keys | хранится открыто |
| Все секреты | `secrets/platform.secrets.sops.yaml` | пароли, private keys, tokens, provider credentials и encryption keys | хранится только в SOPS-encrypted виде |

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
  publicBaseUrl: https://localhost
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
    listen: {host: 0.0.0.0, port: 4101}
    database: coffee_platform_customer
    secretRefs: [postgres.customer]
    outbound: []
    permissions: {net: [coffee_postgres:5432, kafka:9092], fsRead: [], fsWrite: []}
```

Файл обязан содержать все 13 runtime из `10_RUNTIME_CATALOG.md`. Для каждого
задаются `listen`, health paths, timeouts, pools, database или явное `null`,
Kafka topics/groups, outbound allowlist, `secretRefs` и Node Permission Model
allowlist. Отсутствующее значение не берётся из скрытого default: loader
завершает запуск ошибкой с полным YAML path.

## 3. Структура `secrets/platform.secrets.sops.yaml`

До шифрования логическая схема имеет следующий вид; в Git каждое значение
ниже обязано быть `ENC[AES256_GCM,...]`:

```yaml
schemaVersion: 1
environments:
  development:
    bootstrap:
      postgresAdminPassword: ENC[...]
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
      aromaGateway: {username: aroma-gateway, password: ENC[...]}
      realtime: {username: realtime, password: ENC[...]}
    aroma:
      email: ENC[...]
      password: ENC[...]
      sessionEncryptionKey: ENC[...]
    edge:
      tlsPrivateKey: ENC[...]
      oidcClientSecret: ENC[...]
    telemetry:
      exporterToken: ENC[...]
sops: {}
```

Секции `staging` и `production` имеют ту же schema, но отдельные ciphertext и
recipients. Пустые строки, plaintext, reusable default password и ссылки на
legacy `postgres/postgres` запрещены.

## 4. Runtime-доступ без раскрытия общего файла

Один source-файл секретов не означает, что каждый сервис получает все секреты.

1. Trusted `config-bootstrap` читает `config/platform.yaml`, проверяет schema и
   decrypts `secrets/platform.secrets.sops.yaml` в памяти.
2. Он сверяет `services.<runtime>.secretRefs` с allowlist из service catalog.
3. Для runtime создаётся только scoped ephemeral YAML в tmpfs
   `/run/secrets/coffee-platform.yaml`, mode `0400`, owner UID runtime.
4. Процесс получает только `COFFEE_CONFIG_FILE=/app/config/platform.yaml` и
   `COFFEE_RUNTIME_SECRETS_FILE=/run/secrets/coffee-platform.yaml`.
5. После запуска bootstrap очищает buffers и не записывает plaintext на disk,
   stdout, logs, artifacts, crash reports или shell history.

`config-bootstrap` — единственный процесс, имеющий право decrypt общего файла.
`web`, `edge-gateway` и `realtime-gateway` не получают DB passwords. Bootstrap
admin password доступен только отдельной одноразовой provisioning-команде и не
попадает в runtime containers.

## 5. Загрузка и приоритеты

- Единственный источник несекретных значений — `config/platform.yaml`.
- Единственный источник secret values — scoped materialization из SOPS-файла.
- Environment variables не переопределяют business/runtime settings. Разрешены
  только три locator-переменные: `COFFEE_CONFIG_FILE`,
  `COFFEE_RUNTIME_SECRETS_FILE`, `SOPS_AGE_KEY_FILE` у bootstrap.
- CLI flags не переопределяют значения, кроме `--check-config` и `--print-schema`.
- Unknown YAML keys запрещены; schema validation работает с `additionalProperties: false`.
- Config и secret schema versions проверяются до открытия network listeners.

## 6. Проверки

Команда `pnpm config:check` обязана:

- валидировать оба YAML по schema;
- сверять 12 runtime с service catalog;
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

## 7. Ротация

Ротация меняет только `secrets/platform.secrets.sops.yaml` отдельным русским PR.
PR показывает изменённые encrypted paths, но не plaintext. Проверяются decrypt,
schema, старый/new credential overlap, restart order, rollback и audit record.
Компрометация общего файла считается компрометацией всех environments и требует
полной ротации; это осознанная цена требования «один файл».
