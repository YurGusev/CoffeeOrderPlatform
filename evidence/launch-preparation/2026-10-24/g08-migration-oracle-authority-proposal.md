# План реализации G08: миграции пяти owner databases

Статус: локальный implementation plan по уже принятой задаче G08. Это не
изменение кода, не разрешение на native Unix endpoint и не результат проверки
G08. Дата пересмотра: 25 октября 2026.

## Критерий и готовые примитивы

`verification/launch/v1/matrix.yaml` задаёт точную команду
`pnpm test:migrations:clean && pnpm test:migrations:forward` и критерий: пять
пустых DB достигают точной schema, повторный запуск — no-op, legacy не
меняется. Скриптов пока нет. Пять owner/migrator/path mappings уже заданы
`config/database-ownership.json`; точные runtime grants —
`config/database-role-map.json`. Все текущие миграции выполняются через
`packages/platform-migrations/src/index.ts::applyMigrations`, который проверяет
упорядоченный checksum prefix, атомарно записывает migration и ledger row, а
повторный вызов возвращает пустой список. Второй migration engine и отдельный
ручной object manifest не нужны.

`verification/launch/v1/scenarios/backup-restore.mjs::schemaSnapshotArguments`
уже задаёт воспроизводимый `pg_dump --schema-only --no-owner --no-acl`
snapshot. В G08 его fingerprint сравнивает независимые clean и forward
результаты для каждого owner. Ledger сравнивается как упорядоченные `(id,
checksum)` пары; `applied_at` в oracle не входит. ACL проверяются отдельно по
role map, а не теряются в `--no-acl` snapshot. Существующие проверки схемы,
constraints и grants находятся в owner tests, указанных ниже.

`verification/launch/v1/scenarios/aroma-sandbox.mjs::applyCanonicalMigrations`
проверяет SQL inventory и применяет migrations только для трёх G16 owners.
`tools/config-bootstrap/index.mjs::provisionAromaSandboxDatabases` и
`openAromaSandboxMigrator` показывают pattern идентификации сервера и `SET ROLE`,
но ограничены G16 и loopback endpoint; это не G08 implementation и не переносит
на G08 Unix socket. G16 создаёт migrator roles `NOLOGIN` только внутри своего
временного кластера и затем использует raw `pg.Client` администратора после
`SET ROLE`. Это отдельная локальная модель: канонический bootstrap задаёт для
migrator roles атрибут `LOGIN` в `scripts/db-bootstrap.mjs::renderRoleSql`.

G00 не выдаёт PostgreSQL server identity: `G00_PREFLIGHT` проверяет GitHub,
checkout/config и локальные version-only Docker probes, без подключения к
PostgreSQL или SQL. В tracked source нет producer `G00_PREFLIGHT` для
`postgres-server-identity.json`; найденные ссылки — G17 consumer и его test
fixture. Поэтому G08 должен сделать собственную свежую read-only проверку
server version/system identifier и canonical role attributes на разрешённом
endpoint до первого `CREATE DATABASE`, связав probe с validated run context и
точными config bytes. Этот probe не следует называть G00 attestation.

## Принятый исторический prefix для forward

Для G08 не требуется выдумывать или отдельно утверждать удобную версию базы.
Принятая исходная ревизия уже названа в закрытой задаче [#11](https://github.com/YurGusev/CoffeeOrderPlatform/issues/11): commit
[`e278aeb10e57d37485542f8668f078456074b038`](https://github.com/YurGusev/CoffeeOrderPlatform/commit/e278aeb10e57d37485542f8668f078456074b038)
(`develop`, PR #170). Это источник
до последующих migration suffixes #11, а не текущий head. По каждому owner
prefix — точная упорядоченная SQL последовательность этого commit; ниже указаны
SHA-256 байтов каждого SQL файла в том commit.

```text
customer 0001_customer_schema 2b8b0a818c4305b34ed853f7f7cc72743741bcb2dbce8513f8376bc4cd8d86e8
customer 0002_customer_indexes 00968f5ed219d9384646e2ea2888aab0d2b5a8ad2c22d1a823e35279feb6e723
catalog 0001_supplier_snapshots d3202a196ae91fd207d7efa1c3591f891451af1f6163c611ed4612d9db9a9344
catalog 0002_snapshot_batches 031d71677423f1a93b30914a5860220ef8f1fa177517480f341da0c55303274f
catalog 0003_snapshot_staging 4038d61d239058e83edd0fbf2fedbdd903069dfde051b848d19468af446ff9c1
catalog 0004_catalog_active 8a0a460dbe540e26ab4f5946245069616c441f38c8b9dd8f3e1f274a31d7381a
catalog 0005_catalog_identity a9a7d8df620c3f920e3cf4d81e41f7794959a582b174fdfdca773fb91ba406bf
catalog 0006_catalog_outbox 22b0a9b31cc8a4eb8c15ca653f4eb49f0bf70960ff561f785864cdd2eb97311d
catalog 0007_catalog_grants 2e9c466b838d5b938015bcd3e6e1811df675f0f5ac72562da3014fa38a242a1d
catalog 0008_catalog_active_read 987fc468722fe54cb19cea00f047bd0968e8a935b98eb41bf45e237803b6eca7
pricing 0001_create_pricing_policy_versions 4717d106a45147c867edede4fce70dfbd814cf62ff84be7985ba2eaeab267e9e
pricing 0002_create_pricing_quotes 1ea8451e245d46daa7f1908d24f8f3e753c56a14030db266771764bc5caad466
pricing 0003_create_pricing_idempotency c571d631c824d8dbc67d704c57330cbff336d6444645f424556920a6da12ffb9
pricing 0004_create_pricing_audit b7b2a5c4065e628958ab4fc16b3257de31bb804fcd4ff94f9c72922dc8abc889
orders 0001_create_orders 2f8383ffd8dc46ee43dfab4fe9deeb74f8d642326c4d6bf05c9e3052dc0b0cfc
orders 0002_create_order_items 464f39f99955f8630f56cff34980578ffad4c8fe2258c52b1b43d9c9ab689e7b
orders 0003_create_order_history 82701109e746a8cefcdfd3c9ef18ac77071e5bd247f33a843a50e34121c086fc
orders 0004_create_order_contributions dea7f23cd00134c4fe09d2a41dbc36bd9d75c5fa07a2f405fbe417a2417be3d5
orders 0005_create_orders_idempotency 872775a342b592c5cc3fbd5750a5d3deabc78d8f0b2b81342edb6714bbf49b72
orders 0006_create_orders_outbox e12a816e3f9ea5923c292a0a1203db34e450f2390f56ec9ef0a2a2a2d362688e
integration 0001_provider_sessions 41a8936bd3fd75160d2b44ecaa82e00fd15c0d3a3c5c5fd73cccbc4583b35aff
integration 0002_provider_mutation_journal 5ba627ed7256557c47682a3ef6beafe770d8f9da6217364f19236fe76d9c801b
integration 0003_offer_bindings 19d4ff0aeabf71ea0ef952aa286f2a0ae261060b1a7e1229c20d75daf0d4dd6b
integration 0004_provider_offer_identity 8c45935ef9e5f592056e7756bdb562759ecfcbd0ff33ab3ca59d4805e7fa295d
integration 0005_catalog_export_attempts 3652392ee45bdf02621c60d84b808171bf32c834b070dcef15cb5d2cdaab940c
integration 0006_provider_mutation_retention 9590251d2b8889843e0a2f84e14dacc659d81279a9cc1f97c64afafcf231ccd9
integration 0007_provider_mutation_grind f55734e3a6b50708bc4262a023192912ea86aeee64d814bcc25b7f9753a48a69
```

В текущем tracked tree после этого prefix идут `catalog/0009_active_snapshot_freshness`,
`pricing/0005_quote_grind_selection` и `orders/0007_order_grind_selection`–
`orders/0023_ascii_observed_identity`; у Customer и Integration suffix пока
пустой. Forward scenario применяет ровно этот принятый prefix, затем актуальный
candidate suffix, проверяя ledger на каждом шаге. Этот выбор привязан к source
commit #11 и полному хэшу миграций, а не подбирается по текущему результату.

## Минимальная реализация G08

1. Добавить `verification/launch/v1/scenarios/migrations.mjs` и связать его с
   двумя уже зафиксированными командами. Сценарий принимает только актуальный
   validated run context, повторно проверяет base config bytes/SHA, ancestry,
   fresh G00 preflight artifact/context binding и derived run DB names. До любого
   создания DB trusted bootstrap выполняет отдельный read-only probe обычного
   endpoint и фиксирует server version/system identifier для этой G08 операции;
   G00 сам PostgreSQL identity не аттестует.
2. Использовать обычный ранее разрешённый endpoint `coffee_postgres:5432` и
   пять вычисляемых `coffee_verify_<run>_<owner>` DB текущего run. До первого
   `CREATE DATABASE` на том же endpoint read-only проверить полный canonical
   role set из ownership/role map, включая пять migrator roles с требуемым
   `LOGIN` и объявленные runtime roles с ожидаемыми атрибутами. При отсутствующей
   или неверной роли завершить проверку до создания любой DB. Не выполнять
   `CREATE ROLE`, `ALTER ROLE` или `DROP ROLE`: роли — внешняя prerequisite/setup
   boundary, а не G08 fixture.
3. В текущем SOPS bundle присутствуют secret fields
   `bootstrap.postgresAdminPassword` и `bootstrap.internalCaPrivateKey`; shape
   bundle не содержит migrator-role credentials. Значения секрета не
   расшифровывались. `scripts/db-bootstrap.mjs::assertBootstrapInputs` требует
   пароли для каждого canonical migrator и runtime role, а
   `renderRoleSql` создаёт/переводит migrators в `LOGIN`. Исторический
   `COFFEE_DB_ROLE_PASSWORDS_JSON` — CLI input, не разрешённый источник секретов
   для G08. Admin secret может оставаться в памяти trusted bootstrap для
   pre-create probe и создания run DB, но сам по себе не даёт подключения под
   canonical migrator.

   Сейчас отсутствует путь соединить разрешённую модель ролей с единственным
   `applyMigrations` engine: `createDatabase` создаёт pool по `{user,password}`
   и не поддерживает connection hook/`SET ROLE`; `applyMigrations` принимает
   только opaque `Database` из этого package. G16 возвращает raw `pg.Client`
   после `SET ROLE`, который нельзя передать в `applyMigrations`. Поэтому
   нельзя ни утверждать исполнимость G08 через текущие функции, ни запускать
   миграции как admin. Требуется отдельное решение о допустимом узком способе
   предоставить уже существующим migrator `LOGIN` credentials trusted bootstrap
   либо связать `SET ROLE` с `Database` без второго migration engine. До такого
   решения G08 остаётся заблокированным; этот документ не разрешает изменение
   production API, секретов или ролей.
4. Clean путь стартует с пяти пустых run DB и применяет все текущие owner SQL
   через `applyMigrations`. Проверяет точные конечные ordered `(id, checksum)`
   rows, fingerprint схемы, существующие owner constraint/schema assertions и
   точные grants по `database-role-map.json`. Повторный вызов обязан вернуть
   `[]`; ledger и schema fingerprint после повторного вызова неизменны.
5. Forward путь на независимых run DB применяет исторические prefix-файлы с
   commit `e278aeb…`, затем до актуального suffix добавляет небольшие owner-local
   legacy rows, только где suffix меняет/ограничивает существующее состояние:
   Catalog — активный snapshot/product/variant; Pricing — обычную старую quote
   line с обеими новыми grind columns `NULL`; Orders — Draft/order item и
   допустимый старый owner Outbox row. Для их формы переиспользовать fixtures в
   `tests/catalog/activation-migrations.test.mjs`,
   `tests/pricing/pricing-store.test.mjs` и `tests/orders/order-store.test.mjs`;
   custom payloads, provider data и shared rows не нужны. Customer и Integration
   на выбранном accepted checkpoint не имеют suffix, поэтому forward для них
   проверяет тот же exact prefix ledger, schema fingerprint и отсутствие
   изменений rows без выдуманного SQL suffix.
6. После suffix для каждого owner сравнить clean/forward fingerprints,
   owner-specific schema assertions, exact role-map grants и logical ledger;
   повторно запустить `applyMigrations` и требовать no-op. Cleanup допустим
   только для принадлежащих текущему run DB после повторной проверки точных имён,
   database owner role и server identity; ошибки до DB creation оставляют DB count
   неизменным.

Переиспользуемые assertions: Customer exact columns/constraints/indexes/grants и
повторный run — `tests/customer/customer-schema.test.mjs::Customer migrations are
repeatable and create the exact owner schema`; Catalog owner table/view/check/
column ACL и fixture сохранности — `tests/catalog/activation-migrations.test.mjs`;
Pricing quote/line fixture и migration list — `tests/pricing/pricing-store.test.mjs`;
Orders ledger no-op/rollback и реальные order/outbox facts —
`tests/orders/order-store.test.mjs`; Integration migration inventory/constraints
и owner-local journal fixture — `tests/aroma/mutation-journal.test.mjs`. Покрытие
схемы/ACL неодинаково: Customer и Catalog содержат наиболее полные live
assertions, остальные owner suites проверяют отдельные migration/runtime
contracts. Эти tests частично gated на disposable/live PostgreSQL и сами по себе
не являются G08 PASS; G08 добавляет пять-owner introspection по принятой role map,
а не параллельный набор migration engines.

## Trust boundary и legacy

ADR-0036 разрешает обычный endpoint и derived run-scoped database namespace.
Private Unix socket/loopback разрешение в ADR-0036 относится только к G17 и здесь
не используется. G08 trusted preflight обязан свежо read-only проверить target
server identity и existing canonical LOGIN roles до `CREATE DATABASE`; если их
нет или их attributes расходятся с canonical role map, G08 завершается без
создания DB и без попытки repair shared roles. G00 artifact используется только
для связи операции с текущим validated run/context и не является доказательством
PostgreSQL identity.

`config/database-ownership.json` denylist включает `coffeeorderdb` и
`coffeeorder_staging`. Не подключаться к ним вообще: доказательство G08
`legacy unchanged` ограничено проверкой denylist и отсутствия legacy target в
любом connect/DDL/write plan. Физическое сравнение schema/data старых БД без
принятого read-only baseline не заявлять и не выполнять. Это не меняет scope
G08 на legacy; уточняется только смысл проверяемого отсутствия влияния G08.

## Граница задачи и проверки

Релевантное правило [AGENTS.md](../../../AGENTS.md): «Read-only исследование
разрешено всегда»; перед изменением trust boundary требуется подтверждение, если
оно не было дано задачей. Для G08 точный обычный endpoint и run namespace уже
разрешены. Никакое разрешение не распространяется на G17 Unix socket, runtime
admin secret, shared-role DDL, legacy DB или внешние записи. Этот документ
фиксирует минимальный план реализации, не утверждает, что code paths/roles
доступны в live target, и не является свидетельством G08 PASS.
