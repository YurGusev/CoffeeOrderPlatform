# Предложение authority для разблокировки G08

Статус: локальное предложение владельцу. Ни секреты, ни PostgreSQL роли/данные
не изменялись; G08 не запускался. Проверка репозитория: 25 октября 2026.

## Источники и зафиксированное состояние

При проверке `HEAD` был `bff183ec8a3503a2caae4debf2abef2539bf58b3`.
Это fingerprint текущего source checkout, не утверждение о clean candidate:
рабочая область содержит параллельный WIP. SHA-256 относящихся к G08 файлов:

```text
config/platform.yaml                 cb894ad41bdaebf8d5b5aea10631f037a4b2185e426737e4db8df04f8a1dbeb7
config/database-ownership.json       0a43fd7c32f18900ef1c3a01e0f4cacb7e875f86aee4a10bbdc2e2acbb4acbaa
config/database-role-map.json       d30edb42a74ad1d79a4ecd5d8481ba82d1e9cb50640e464edc0781e64a3def63
secrets/platform-secrets.schema.json af0879a48cb4477e1cc3c6174e9662446f7cbe2b51358eb0fe22137a396ae7fd
```

Текущий config указывает canonical PostgreSQL `coffee_postgres:5432` и
не-production `development`; toolchain pin ожидает PostgreSQL 17.11.
G08 в `verification/launch/v1/matrix.yaml` требует
`pnpm test:migrations:clean && pnpm test:migrations:forward`: пять owner DB,
точные schemas, повторный запуск без изменений, отсутствие влияния на legacy.

Canonical role map задаёт ровно эти 15 LOGIN identities:

```text
Migrators: coffee_customer_migrator, coffee_catalog_migrator,
           coffee_pricing_migrator, coffee_orders_migrator,
           coffee_integration_migrator
Runtime:   coffee_customer_rw, coffee_catalog_api_ro,
           coffee_catalog_import_rw, coffee_catalog_activate_rw,
           coffee_pricing_rw, coffee_orders_service_rw,
           coffee_orders_prepare_rw, coffee_orders_observer_rw,
           coffee_orders_convergence_rw, coffee_aroma_gateway_rw
```

`secrets/platform-secrets.schema.json` задаёт admin secret и эти десять runtime
credentials, но не миграторские. Plaintext секретов не читался. Последний факт
`evidence/launch-preparation/2026-10-24/external-postgres-readonly.json` от
24 октября, 11:54 UTC сообщал PostgreSQL 17.11, system identifier
`7613370342949990434` и `existingCanonicalRoles: []`. Этот результат устарел:
он не доказывает текущее отсутствие/наличие ролей и не является текущей
identity pin.

Штатного свежего G08 probe пока нет. `tools/config-bootstrap/index.mjs`:

- `provisionAromaSandboxDatabases` — G16-only loopback operation с CREATE ROLE,
  CREATE DATABASE и объектами; применять её к canonical endpoint нельзя.
- `readG17BackupCredential` и `validateG17BackupTarget` проверяют G17 backup
  target и существующий G00 `postgres-server-identity.json`; они не выполняют
  свежую G08 probe. G00 сам PostgreSQL не опрашивает.
- `readG16Secrets`/`decryptInMemory` — in-process доверенный SOPS reader, но
  доступен только внутри config-bootstrap; plaintext не должен попадать на диск,
  в argv или логи.

В `scripts/db-bootstrap.mjs::assertBootstrapInputs` обязательны пароли всех 15
ролей; `renderRoleSql` задаёт LOGIN и неопасные role attributes. Но
`bootstrapDatabases` вызывает `ensureRole`, которая создаёт или меняет роли.
Этот вызов непригоден для G08 или первичного conditional setup. Миграции не
должны идти от admin. `packages/platform-database/src/index.ts::createDatabase`
принимает canonical `{database, user, password}`, а
`packages/platform-migrations/src/index.ts::applyMigrations` принимает его
opaque `Database`; этого достаточно для единственного migration engine.

## Минимальный conditional setup, требующий решения владельца

Изменить только эти границы после одобрения ниже:

1. `tools/config-bootstrap/index.mjs`: добавить ограниченный G08 preparation
   entry point. До генерации секрета, SOPS write или DDL он принимает свежий
   validated launch context, сверяет candidate/config SHA и canonical
   `coffee_postgres:5432`, затем внутри trusted bootstrap читает только текущий
   admin credential и выполняет read-only probe к `postgres`. Probe получает
   PostgreSQL version, `pg_control_system().system_identifier`, current user,
   superuser и role-name/attribute metadata для точных 15 allowlisted roles.
   Evidence содержит ожидаемую и фактическую identity, hashes контекста/config
   и probe outcome, без credential values. PostgreSQL 17.11 и точный system
   identifier должны быть свежо подтверждены владельцем и записаны в evidence
   до secret generation или role DDL. Старое значение `7613370342949990434`
   нельзя считать свежей identity pin.
2. Продолжение разрешено только если свежий probe подтверждает одобренные
   server version/system identifier и показывает, что отсутствуют **все 15**
   ролей. Если найдена хотя бы одна роль, остановиться без любого role DDL,
   secret generation или secret rewrite; сохранить только безопасную
   инвентаризацию. Уже существующий migrator secret block также означает отказ:
   не генерировать замену, не переписывать ciphertext и не считать retry после
   частичного setup идемпотентным. Если probe/identity не прошёл — не читать и не
   менять bundle дальше.
3. Только для подтверждённого all-absent состояния
   `secrets/platform-secrets.schema.json` разрешает отсутствующий строгий блок
   `environments.<env>.bootstrap.migrators` ровно с пятью owner-keyed encrypted
   паролями. Trusted config-bootstrap генерирует пять credentials
   криптографически, объединяет их в памяти с уже существующими десятью
   runtime credentials и готовит SOPS ciphertext для выбранного non-production
   environment. Перед атомарной заменой bundle он повторно проверяет, что
   исходный ciphertext file имеет зафиксированный before-SHA/dev/inode и что
   migrator block всё ещё отсутствует. Любое изменение источника или уже
   появившийся block приводит к отказу без записи. В evidence фиксируются только
   before-SHA, resulting-SHA, candidate/config identity и конечные имена ролей;
   plaintext не попадает на диск, в runtime mounts, argv или logs. Все DDL
   credentials читаются заново только из этой exact saved bundle version с
   совпадающим resulting-SHA; при hash mismatch — отказ.
4. После успешной encrypted replacement и проверки resulting-SHA preparation
   открывает одну PostgreSQL transaction, повторно читает system identity и
   inventory, требует те же одобренные server identity и отсутствие всех 15
   ролей, затем создаёт ровно 15 canonical roles одним CREATE-only набором с
   LOGIN/privilege attributes из `scripts/db-bootstrap.mjs::renderRoleSql` и
   identity из `config/database-role-map.json`. Statements не содержат `ALTER
   ROLE`, `IF NOT EXISTS ... ALTER` или `SET ROLE`; конфликт любой роли либо
   ошибка приводит к ROLLBACK всей transaction. Результат COMMIT, если ответ
   потерян или неоднозначен, считается неизвестным: сохранить конечный
   diagnostic/evidence и остановиться. Никакого автоматического DROP, repair,
   повторного secret write или следующей попытки создания.
5. Preparation не создаёт/не меняет canonical business DB, schema, grants или
   ownership. После успешной подготовки штатный G08 создаёт только пять
   derived run-scoped DB текущего запуска. Их DB-level grants, `search_path`,
   schema/table grants выводятся из role map только внутри этих новых DB. Затем
   `createDatabase` подключается каждым migrator LOGIN и
   `applyMigrations` выполняет clean/forward. G08 cleanup удаляет только эти
   проверенные run DB; `coffeeorderdb` и `coffeeorder_staging` не открываются.
   Трекнутое изменение SOPS bundle меняет candidate source: требуется новый
   clean candidate и свежий launch context/G00 admission. Context до bundle
   change непригоден и не переиспользуется.

Для runtime G08 остаётся один migration engine: обычные
`createDatabase` + `applyMigrations`. Existing `scripts/db-bootstrap.mjs::bootstrapDatabases`
не используется: оно включает shared-role repair и canonical DB bootstrap.
G08 scenario/scripts/tests подключаются к существующему matrix command;
повторно используют schema/ledger assertions из
`evidence/launch-preparation/2026-10-24/g08-migration-oracle-authority-proposal.md`
и текущие owner migration suites, без ручного второго manifest/engine.

## Требуемая approval boundary

ADR-0036 уже разрешает обычный endpoint `coffee_postgres:5432` и run-scoped DB
namespace; G17 Unix socket сюда не входит. Для указанного conditional setup
отдельно требуется явное согласие владельца на:

- изменение secret schema и выбранной encrypted SOPS environment, включая
  trusted in-memory генерацию/запись пяти canonical migrator passwords;
- создание ровно 15 canonical roles в одной transaction только если свежий
  probe показывает, что отсутствуют все 15; при наличии любой роли — отказ без
  DDL, а частичный/неизвестный COMMIT не даёт разрешения на DROP или repair;
- свежую публикацию/фиксацию PostgreSQL 17.11 identity и system identifier в
  приватном run evidence как обязательного precondition перед DDL.

До одобрения этих точных scope изменений proposal не запускает probe, SOPS
writer или role DDL. До fresh identity подтверждения и role inventory G08
остаётся NOT_ESTABLISHED. Не разрешаются shared-role ALTER/rotation, legacy или
production DB connections/writes, G17 endpoint, provider mutations,
GitHub/remote writes или publication.
