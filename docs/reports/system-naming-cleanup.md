# Нейтральные системные имена CoffeeOrderPlatform

Дата: 30 октября 2026 года, Asia/Yekaterinburg.
Ветка: `fix/system-names`, создана от обновлённой `origin/develop`
`699ac4e` в отдельном checkout. Исходное рабочее дерево с незакоммиченными
изменениями сохранено.

## Результат повторной проверки

Исправлены актуальные исполняемые имена из
[аудита](system-naming-audit.md): переменные, функции, константы, имена файлов,
тестовые SQL-таблицы и сообщения, OIDC client ID, Docker labels и имена
временных ресурсов. Согласованы все найденные producers, consumers,
assertions и cleanup. Производственные HTTP/event contracts, бизнес-модели,
миграции и данные не менялись.

Отчёт от 29 октября описывает прежний рабочий снимок. На актуальной базе
собственный producer OpenObserve уже отсутствует, поэтому `native8`/`trial`
из его исторических исходников не переносились и не переписывались.
Сохранившиеся generic helpers переименованы по назначению: migration,
browser fixture, backup/restore, recovery и sandbox.

## Основные изменения

| Область отчёта | Исправление |
|---|---|
| T01 | `issue8Expansion` → `confirmResponseExpansion`; сообщения проверки названы по Confirm response. |
| T02–T03 | Внедряемые тестовые переменные `issue12*` и stdout/errors `ISSUE12_PRIVATE_EOF_*` заменены нейтральными; parser обновлён вместе с producer. |
| T04 | Тестовые `Issue63.TestEvent`, aggregate и topics стали `DeliveryTest.Event`, `DeliveryTestAggregate`, `coffee.delivery.*`. |
| T05–T08 | Proof-таблицы теперь `db_live_*` и `delivery_live_*`; live envelopes/topics — `DeliveryProof.*` и `coffee.delivery-proof.live.v1`. Обновлены DDL, SQL readers, writers, locks, hashes и assertions. Новые файлы результатов — `db-live-proof-*`, `db-foundation-live-proof-*`, `delivery-live-proof-*`; прежние evidence сохранены. |
| T09–T13, T15–T18 | Fixture run IDs, containers, signing IDs, TLS names, idempotency keys и temporary paths получили имена по назначению. OIDC client ID — `realtime-browser-fixture`; Docker label — `coffee.realtime.fixture`; обе стороны точных сравнений обновлены. |
| T19 | Локальные имена preflight fixture variables нейтральны. Реальные номера принятых GitHub issues и historical evidence paths сохранены. |
| G01–G11 | Общие функции и константы migration/browser/backup/recovery/sandbox больше не используют номер gate в имени. Импорты и строковые тестовые генераторы обновлены вместе с объявлениями. |

Примеры нейтральных exports: `readMigrationCredential`,
`prepareCanonicalMigratorRoles`, `startBrowser`, `materializeBrowserFixture`,
`createBrowserOwnerEvidence`, `validateBrowserChildContext`,
`validateBackupTarget`, `verifyRestoreTableAclSnapshots`,
`proveRecoveryAfterRestore`, `writeUnitEvidenceArtifacts`.

## Переименованные файлы

| Прежний путь | Новый путь |
|---|---|
| `tools/g15-browser-driver.mjs` | `tools/browser-driver.mjs` |
| `tools/g15-browser-proof.mjs` | `tools/browser-proof.mjs` |
| `tools/g15-owner-evidence.mjs` | `tools/browser-owner-evidence.mjs` |
| `tools/config-bootstrap/g15-nss-trust.py` | `tools/config-bootstrap/browser-nss-trust.py` |
| `tests/tools/g15-browser-driver.test.mjs` | `tests/tools/browser-driver.test.mjs` |
| `tests/tools/g15-browser-proof.test.mjs` | `tests/tools/browser-proof.test.mjs` |
| `tests/tools/g15-owner-evidence.test.mjs` | `tests/tools/browser-owner-evidence.test.mjs` |

Изменены 54 файла кода и тестов, включая семь переименований файлов.
Все актуальные импорты и исполняемые строки путей обновлены. Копии и
compatibility wrappers для старых файлов не добавлены.

## Сохранённые идентификаторы и история

- Формальные G00–G19, диагностические коды, serialized context keys,
  gate-scoped labels и значения allowlists остаются интерфейсом проверок.
  В частности, путь Unix socket `coffee-g17-*` и ограничения для него не менялись.
- `issue-3` в machine-readable authority и ссылки на конкретные принятые handoff
  сохранены как происхождение решения, вместе с соответствующими validators.
- `issue-64-operations-predecessor` в observability coverage остаётся
  идентификатором исторической области доказательства; его assertions сохранены.
- Не переименован исторический `ADR-0034-g16-existing-account-verification.md`.
  Прежний аудит/CSV, остальные существующие документы и `evidence/**` не изменены.
- Номера SQL-миграций, версии API и ADR IDs не являются номерами задач.

## Проверки

Зависимости установлены из существующего локального store:
`pnpm install --frozen-lockfile --offline` — 288 пакетов переиспользованы,
скачиваний и изменений lockfile нет.

| Команда | Результат |
|---|---|
| `pnpm typecheck` | PASS |
| `pnpm lint` | PASS |
| `pnpm authority:check` | Authority PASS, 9 tests PASS |
| `pnpm config:check` | PASS, 15 runtimes |
| `pnpm contracts:breaking` | PASS |
| `pnpm architecture:check` | Checker PASS, 73 tests PASS |
| `pnpm rule-parity:check` | PASS, 12 canonical rows |
| `env -u COFFEE_LAUNCH_CONTEXT_FILE -u COFFEE_DB_LIVE_PROOF node scripts/db-smoke.mjs` | Offline SQL/ownership contract PASS |
| `node --check` изменённых MJS и in-memory Python compile | PASS |
| `git diff --check` / `git diff --cached --check` | PASS |

Первый регрессионный набор — **156 PASS, 0 FAIL, 0 SKIP**:

```sh
env -u COFFEE_LAUNCH_CONTEXT_FILE -u COFFEE_DB_LIVE_PROOF \
  node --test --test-concurrency=1 \
  tests/tools/browser-driver.test.mjs \
  tests/tools/browser-proof.test.mjs \
  tests/tools/browser-owner-evidence.test.mjs \
  tests/config/observability-bootstrap.test.mjs \
  tests/database/db-bootstrap.test.mjs \
  tests/compose/topology.test.mjs
```

Второй набор — **421 PASS, 1 FAIL, 0 SKIP**; единственная первоначальная ошибка
provenance объяснялась семью старыми удалёнными путями, которые ещё находились
в Git index. После staging переименований точечный повтор прошёл.
Исходники ради этого результата не менялись; провал сохранён в диагностическом логе.

```sh
env -u COFFEE_LAUNCH_CONTEXT_FILE -u COFFEE_DB_LIVE_PROOF \
  node --test --test-concurrency=1 \
  verification/launch/v1/scenarios/backup-restore.test.mjs \
  verification/launch/v1/runner.test.mjs \
  verification/launch/v1/scenarios/preflight.test.mjs \
  tests/realtime/fixtures/harness.test.mjs \
  packages/platform-testing/test/platform-packages.test.mjs \
  tests/contracts/breaking.test.mjs \
  tests/observability/alerts.test.mjs

env -u COFFEE_LAUNCH_CONTEXT_FILE -u COFFEE_DB_LIVE_PROOF \
  node --test --test-name-pattern='verification provenance hashes' \
  tests/observability/alerts.test.mjs
```

Точечный повтор — **1 PASS, 0 FAIL**. Всего проверено 578 различных тестов
регрессионных наборов с успешным результатом каждого после staging.

Живая проверка переименованных SQL fixtures:

```sh
node scripts/db-live-proof.mjs \
  --run-id naming-20261030-a9c3 \
  --evidence-dir /tmp/system-names-checks/db-live
```

PASS на отдельном PostgreSQL с закреплённым image digest: первый bootstrap
создал пять DB, повторный подтвердил идемпотентность; 10 разрешённых записей,
40 запрещённых чужих SELECT и 40 INSERT. Проверены transaction/idempotency,
Inbox/Outbox и Catalog activation. Legacy fixture внутри этого же временного
контейнера сохранилась. Контейнер `coffee-db-proof-naming-20261030-a9c3`
удалён; проверка `docker ps -a` подтвердила отсутствие. Реальная рабочая БД
и provider не использовались. Kafka в этом proof не запускалась.

Диагностические логи текущей сессии: `/tmp/system-names-checks/`.
Полные runtime gates G00–G19, browser E2E, standalone nginx image/cutover
и live Kafka/provider smoke не выполнялись; эти результаты не являются
launch admission или deployment acceptance.

## Независимое ревью

Astra Orchestrator reviewer: **Accepted, существенных замечаний нет**.
Проверены парные SQL, сообщения, OIDC, Docker identity/cleanup, imports и
строковые преобразования. Новых изменений production schema/wire format и
trust policy не выявлено.
