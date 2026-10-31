# Исполнимая спецификация итогового launch gate

При принятом [ADR-0031](../adr/ADR-0031-nginx-transport-and-application-auth.md)
reference baseline #162 содержит 14 Node + 1 native nginx. #13 обязан проверить
фактический состав, private
authorizer, отсутствие Node `web` runtime и второго public path. Negative
route/auth/TLS/SSE/static/CSRF/rotation cases, real IdP admission,
capacity/reload overlap и новый измеренный end-to-end SLA заданы
[контрактом #159](29_NGINX_TRANSPORT_AND_AUTH.md); целевые пределы не равны
прошедшему production/browser/SSE evidence. #160/#161/#162 публикуют
собственные проверки до launch gate; #64 отвечает за native observability.

Статус: нормативная спецификация issue #13. Задача проверяет принятый scope и
не исправляет найденные дефекты внутри verification PR.

По прямому поручению владельца от 24 октября 2026 в текущий scope дополнительно
включено устранение таймаута первого импорта Catalog в новую БД и его cold
regression. Это точечное исключение для Catalog activation; pins, права ролей,
DB-бюджеты и обязательные критерии допуска сохраняются.

Последующее прямое поручение владельца включает реализацию runtime G18,
исследование и исправление packing G16 и проверку остальных gates по фактическим
результатам. Эти работы ведутся в #13; подтверждённые provider semantics,
разделение trust surfaces, pins, права ролей, DB-бюджеты и критерии допуска
сохраняются. Read-only исследование поставщика не разрешает новую unsafe
операцию без предусмотренного G16 approval.

Поручение владельца от 28 октября 2026 довести разработку #13 до merge включает
исправление блокирующих проверку ZIP guard, остановки дочерних процессов G17,
режимов private checkout, несогласованных Customer HTTP/Problem статусов
и проверки точных байтов конфигурации при добавлении или удалении UTF-8 BOM.
Исправления сохраняют публичные контракты, владельцев данных и пороги допуска;
unit PASS не заменяет общий G00–G19 на одном чистом кандидате.

Владелец 24 октября 2026 отдельно разрешил точные G12/G17/G00 предложения из
[remaining-gates-authority-proposal.md](../../evidence/launch-preparation/2026-10-24/remaining-gates-authority-proposal.md):
Trivy 0.76.1 с exact image digest и verification budgets; потоковый age backup
только пяти verification DB доверенным bootstrap; закрытый корректирующий
supplement accepted handoffs. Исторические blobs не меняются, прежний runtime
PASS не выводится. Эти исключения не означают успешную проверку gates.

По прямому решению владельца от 31 октября 2026 браузерная фаза G14 может
использовать тот же ограниченный OIDC-only дочерний commit, что и G15.
[Точные границы решения](../../evidence/launch-preparation/2026-10-31/observability-correlation.md)
сохраняют product candidate для остальных фаз G14, внешний PostgreSQL,
таймаут 1800 секунд и прежние проверки. Различие SHA этой фазы отражается
явно и принимается только после проверки parent/child lineage; оно не даёт
права подменять SHA остальных gates или добавлять постоянный IdP.

## 1. Решение о допуске

Результат имеет только два значения:

- `ДОПУСТИТЬ`: каждый mandatory gate имеет `PASS`, exact command, exit code 0,
  артефакт и проверяемую связь с одним commit SHA;
- `НЕ ДОПУСТИТЬ`: хотя бы один gate `FAIL`, `SKIPPED`, `NOT_RUN`, выполнен на
  другом SHA/окружении или не имеет evidence.

Ручное «проверено глазами», скрытый retry до зелёного результата и accepted
risk вместо обязательного gate запрещены. После исправления defect весь
затронутый gate и downstream gates запускаются заново на новом SHA.

## 2. Файлы результата

```text
verification/launch/v1/matrix.yaml
verification/launch/v1/run.mjs
verification/launch/v1/schemas/{matrix,run-result}.schema.json
verification/launch/v1/scenarios/**
docs/reports/launch/<run-id>/ОТЧЁТ.md
evidence/launch/<run-id>/
  environment.json
  commands.ndjson
  gates/<gate-id>/{result.json,stdout.log,stderr.log,artifacts/**}
  defects.json
  decision.json
  checksums.sha256
evidence/handoffs/issue-13.yaml
```

`run-id = UTC YYYYMMDDTHHMMSSZ + short commit SHA`. Logs проходят redaction до
сохранения. Plaintext secrets, provider bodies и PII в evidence запрещены.

## 3. Clean environment

Runner checkout exact merge-candidate SHA в пустой каталог. До install
отсутствуют `node_modules`, build output, generated output и Docker volumes
этого run-id. Используются только pinned Node 26 image/digest, Corepack/pnpm,
lockfile и toolchain registry.

Compose project name `coffee-launch-<lowercase(run-id)>`: только имя Compose
использует нижний регистр, поскольку Compose запрещает заглавные символы. UTC
`run-id`, пути evidence и Kafka сохраняют исходные `T`/`Z`; cleanup
использует точное имя проекта из runner context. Он не создаёт PostgreSQL service
и не подключается к legacy `coffeeorderdb`. Verification использует отдельные
БД `coffee_verify_<normalized-run-id>_{customer,catalog,pricing,orders,integration}` и
отдельные roles; bootstrap проверяет server identity PostgreSQL 17.x. Cleanup
удаляет только exact run-id databases/roles после сохранения evidence.

Имена DB вычисляются по принятому
[ADR-0036](../adr/ADR-0036-launch-database-isolation.md): lowercase run-id и
единственный `-` заменён на `_`. Единственный committed YAML содержит canonical
owner mapping и явную verification policy; context задаёт только run/SHA/base
config digest. G00 проверяет derived plan, runtime — те же имена и actual config
bytes. Отдельная standalone runtime проверка с disposable PostgreSQL может
диагностировать G18, но не закрывает требование внешнего PostgreSQL для G13.

Kafka topics/groups содержат run-id. AROMA mutation по умолчанию выключена.

`environment.json`: commit/tree SHA, dirty=false, UTC/timezone, OS/arch, CPU/RAM,
Node/pnpm/Docker/Compose/PostgreSQL/Kafka/browser versions, image digests,
config hash, encrypted secrets-file hash и run-id resources. Secret values нет.

G03 выполняет `pnpm format:check && pnpm lint && pnpm typecheck`. Formatter
использует закреплённый Prettier и проверяет существующие обычные tracked и
non-ignored untracked файлы Git с расширениями `js`, `mjs`, `cjs`, `ts`, `tsx`,
`mts`, `cts`, `json`, `jsonc`, `yaml`, `yml`, `css`, `scss`, `html`. Пути
сортируются; symlink и удалённые файлы не включаются. Исключены `docs/`,
`evidence/`, `secrets/`, `packages/generated/`, `packages/platform-ui/provenance/`,
`.codex/`, `.git/`, `pnpm-lock.yaml` и любые каталоги `node_modules`, `dist`,
`coverage`. Единственный путь выбора — `scripts/format.mjs`; обычная команда
только проверяет, а `node scripts/format.mjs --write` записывает baseline.
Владелец одобрил эту область и однократное форматирование 25 октября 2026;
исходный inventory и принятие сохранены в evidence первого запуска.
`packages/platform-ui/src/styles/tokens.css` и
`packages/platform-ui/src/styles/global.css` дополнительно исключены из этой
проверки. Их SHA-256 зафиксирован в `prototype-font-manifest.json`.
Изменения только форматирования не освобождают критические модули от G04.

G04 измеряет emitted JavaScript в `dist` для каждого изменённого критического
source-модуля; `tools/config-bootstrap` измеряется как исполняемый `.mjs`.
Изменение определяется относительно `acceptedBaseCommit`, а артефакты включаются
целиком, в том числе не загруженные тестами файлы. TypeScript и JavaScript
coverage не сопоставляются по строкам: source maps не включены, а прямой тест
`.ts` сам по себе не доказывает coverage emitted JS. Порог — минимум 90% lines,
90% functions и 85% branches отдельно для каждого затронутого модуля. Список
модулей, pure unit suites и значения находятся в strict
`verification.unitCoverage`; skip, todo, cancel и неполный LCOV inventory
завершают gate ошибкой. Основание политики описано в
[ADR-0037](../adr/ADR-0037-unit-coverage-policy.md).

Inventory G04 включает 60 существующих unit/property suites; дополнительно в
него включены `tests/aroma/api-internal-operations.test.mjs`,
`tests/aroma/safe-read-http.test.mjs`, `tests/aroma/scoping-provenance.test.mjs`,
`tests/aroma/source-identity.test.mjs`, `tests/orders/security.test.mjs`,
`tests/orders/observability.test.mjs` и `tests/edge-auth/operations.test.mjs`.

## 4. Версионированная matrix

Каждая строка `matrix.yaml` содержит:
`id`, `version`, `mandatory`, `owner`, `predecessors`, `command`, `timeout`,
`inputs`, `expectedArtifacts`, `passCriteria`, `cleanup`, `rerunPolicy`.

| ID                    | Владелец                | Exact command                                                                      | PASS                                                                                                                         |
| --------------------- | ----------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `G00_PREFLIGHT`       | Platform                | `pnpm launch:verify:preflight`                                                     | clean SHA; accepted GitHub PR/handoffs #14/#19/#2–#12/#16–#18/#60/#61/#62/#63/#64; authority repo exact; no legacy DB target |
| `G01_INSTALL`         | Platform                | `pnpm install --frozen-lockfile`                                                   | lock unchanged; no lifecycle/network surprise outside allowlist                                                              |
| `G02_GENERATED`       | Contracts               | `pnpm contracts:check-generated`                                                   | generated tree byte-equal, no drift                                                                                          |
| `G03_STATIC`          | Platform                | `pnpm format:check && pnpm lint && pnpm typecheck`                                 | все exit 0, warnings budget 0                                                                                                |
| `G04_UNIT`            | Domain owners           | `pnpm test:unit -- --coverage`                                                     | exit 0; changed critical modules meet per-module floors from `config/platform.yaml`                                          |
| `G05_CONTRACTS`       | Contracts               | `pnpm contracts:check-generated && pnpm contracts:breaking && pnpm contracts:test` | positive/negative fixtures pass, no unapproved breaking change                                                               |
| `G06_ARCHITECTURE`    | Architecture            | `pnpm architecture:check`                                                          | all GREEN pass; every RED fails with source/target/rule                                                                      |
| `G07_CONFIG_SECURITY` | Security                | `pnpm versions:check && pnpm config:check && pnpm security:secrets`                | exact pins/SOPS/scopes/redaction; zero plaintext/canary leak                                                                 |
| `G08_MIGRATIONS`      | DB owners               | `pnpm test:migrations:clean && pnpm test:migrations:forward`                       | five empty DBs reach exact schema; rerun no-op; legacy unchanged                                                             |
| `G09_DB_BOUNDARIES`   | DB owners               | `pnpm db:smoke`                                                                    | allowlisted operations pass; every cross-owner access denied                                                                 |
| `G10_INTEGRATION`     | Service owners          | `pnpm test:integration`                                                            | HTTP/DB/Kafka/idempotency/concurrency suites pass                                                                            |
| `G11_RECOVERY`        | Reliability             | `pnpm test:recovery`                                                               | duplicate/crash/replay/rebalance/lease/fence/reservation matrix pass                                                         |
| `G12_SUPPLY_CHAIN`    | Security                | `pnpm security:scan`                                                               | SBOM/provenance produced; zero critical/high exploitable finding                                                             |
| `G13_COMPOSE`         | Platform                | `pnpm test:compose-smoke`                                                          | all runtimes ready, dependency failure/graceful stop pass                                                                    |
| `G14_OBSERVABILITY`   | Operations              | `pnpm test:observability`                                                          | health/metrics/traces/correlation/alerts/redaction pass                                                                      |
| `G15_BROWSER`         | Frontend                | `pnpm test:playwright`                                                             | Chromium critical/accessibility/deep-link/conflict/realtime pass                                                             |
| `G16_AROMA_SANDBOX`   | Integration+Reliability | `pnpm test:aroma-sandbox -- --approval-file "$AROMA_SANDBOX_APPROVAL_FILE"`        | controlled GET→≤1 mutation→GET/lost-response/recovery/restore pass                                                           |
| `G17_BACKUP_RESTORE`  | DB owners               | `pnpm test:backup-restore`                                                         | five dumps restored into new DBs; schema/data/invariants match                                                               |
| `G18_ROLLBACK`        | Operations              | `pnpm test:mutation-disable-rollback`                                              | mutation off, observer/Orders/recovery remain healthy, no state loss                                                         |
| `G19_REPORT`          | Release owner           | `pnpm launch:verify:report`                                                        | Russian report, checksums, defects and deterministic decision valid                                                          |

### G08: canonical PostgreSQL и oracle миграций

G08 работает только с PostgreSQL `coffee_postgres:5432` и служебной БД `postgres`;
для этой проверки `postgres.bootstrapUsername` задан как `coffeeuser`. Существующие
`coffeeorderdb` и `coffeeorder_staging` не открываются. Trusted bootstrap сначала
проверяет настроенный credential по свежему TCP-соединению и сверяет версию,
superuser и утверждённый `systemIdentifier`. Синхронизация admin credential
разрешена только после точного SQLSTATE `28P01`: читается пароль из контейнера
`coffee_postgres` с повторной проверкой его закреплённых container/image/network
identity, затем credential проверяется свежим TCP probe до единственной SOPS
записи. Другие ошибки подключения, отсутствующая роль или изменившаяся identity
завершают шаг без записи.

Отдельное разрешение владельца охватывает подготовку пяти migrator credentials
и создание ровно 15 canonical LOGIN roles; их набор и атрибуты проверяются до
DDL, роли создаются одной транзакцией. Пароли остаются в SOPS и выдаются только
выбранному in-process caller через trusted config-bootstrap; их нельзя передавать
через argv, environment или plaintext-файл. После подтверждённого commit и
сохранения нового clean candidate создаётся owner-only `0400` proof
`<validated evidenceDir>/gates/G08_MIGRATIONS/artifacts/canonical-preparation.json`.
Он содержит только sanitized результат role preparation. G08 связывает proof с
текущим run/context, exact 15-role map, canonical endpoint/configuration,
encrypted-bundle SHA-256 и проверкой, что SHA candidate подготовки является
предком текущего candidate. При ранее разрешённом переходе verification isolation
bootstrap читает `config/platform.yaml` из commit подготовки, проверяет его хэш
и допускает только одновременное включение `databaseIsolation.enabled` и
`kafkaNamespaceIsolation` из `false` в `true`; остальные байты должны совпадать.
Proof не является G00 attestation.

Если canonical роли уже подготовлены, clean oracle получает свежую read-only
аттестацию их атрибутов и password authentication по текущему SOPS bundle.
Она не создаёт роли и не изменяет ciphertext. Стадия `roles-verified` содержит
`createdCount: 0`, `transaction: "read-only"`, одинаковые before/resulting
bundle SHA-256 и точные run/candidate/config текущего запуска. Повторные проверки
identity и входных данных предшествуют возврату proof. Историческая стадия
`roles-created` с подтверждённым commit сохраняет прежнюю семантику и проверки.

Clean oracle применяет полный упорядоченный набор миграций к пяти пустым
run-derived БД. Forward oracle использует те же пять имён после clean cleanup:
применяет принятый исторический prefix, загружает существующие owner fixtures,
затем применяет suffix. Обе ветки сравнивают schema fingerprint; дополнительно
проверяются упорядоченные IDs/checksums migration ledger, точные grants,
сохранность fixture и повторный no-op. Cleanup разрешён только для принадлежащих
текущему run derived DB после повторной проверки server identity и владельца;
неопределённый результат CREATE остаётся retained и завершает проверку ошибкой.
Статус отдельных запусков фиксируется только в относящемся к нему handoff и
evidence; этот документ задаёт требования gate и сам не является результатом run.

G17 сравнивает сырые SHA-256 схем источника и восстановления. Он не применяет
общий SQL normalizer: любое исключение должно быть exact, ограниченным и
подтверждённым immutable owner artifact в том же run. Полные G17 artifacts не
переносятся в этой ветке; этот документ не объявляет G17 успешно проверенным.

Порядок обязателен: G00→G01→G02→G03→G04→G05→G06→G07→G12→G08→G09→G10→G11;
затем G13→G14→G15→G16→G17→G18→G19. Принятая перестановка G12 по
[ADR-0025](../adr/ADR-0025-fastify-launch-recovery.md) позволяет запускать Kafka
consumers только после проверки точного OCI artifact.
Gate не запускается при failed predecessor, кроме G19: отчёт с решением
`НЕ ДОПУСТИТЬ` формируется и при отказе предыдущих gates.

## 5. Общие правила команд

Runner записывает start/end UTC, command argv без secret values, cwd, exit code,
timeout, peak RSS и artifact hashes. Timeout завершает process group и даёт FAIL.
Значения timeout: static/unit/contracts 15m; integration/recovery 30m; Compose,
browser, sandbox, backup/restore, rollback по 30m; полный run максимум 120m.

`pnpm lint` сначала выполняет штатный `pnpm typecheck`, чтобы создать declarations
workspace-зависимостей для type-aware анализа после свежей установки. G03 сохраняет
указанные выше команды, порядок и нулевой бюджет предупреждений.

Retry test command автоматически запрещён. Flaky результат = FAIL и defect.
Повтор возможен только отдельным новым run-id с причиной в отчёте; предыдущий
FAIL не удаляется.

## 6. AROMA sandbox gate

G16 не запускается обычным PR CI. По прямому поручению владельца используется
режим `controlled-live-existing-account` согласно
[ADR-0034](../adr/ADR-0034-g16-existing-account-verification.md): sandbox —
изолированный локальный контур приложения, upstream — реальный AROMA с
существующей учётной записью. Отдельный vendor sandbox не заявляется.
Требуются одновременно:

- существующие encrypted/scoped development credentials только в Gateway;
- allowlisted provider origin, фактически проверенный account fingerprint и
  точное `existingAccountException` с authority `user-2026-10-23`;
- `services.aroma-convergence.mutationsEnabled=true` в единственном versioned
  `config/platform.yaml` verification run, materialized только convergence; env
  override и config overlay запрещены;
- approval JSON: run-id, commit SHA, account fingerprint, expiresAt <=2h,
  approver, allowed offerRef и maximum quantity; detached signature;
- исходная complete cart observation и план восстановления.

Сценарии:

1. GET baseline;
2. no-op equality: mutation count 0;
3. one diff: fresh GET → one reserved mutation → verification GET;
4. injected lost response after sandbox accepted mutation -> UnknownOutcome;
5. restart -> fresh GET -> recovery without replay old operationRef;
6. restore exact baseline через новый явно разрешённый operationRef;
7. final complete GET/fingerprint equals baseline.

Любое несоответствие allowlist, signature, SHA, expiry, baseline или final
restore = immediate FAIL, mutation disable и defect. Production targets
закодированы в deny-list; ADR-0034 разрешает единственное точное исключение
origin/account для указанного запуска. Environment приложения `production`
запрещён без исключений. Approval/secrets не попадают в evidence plaintext.

Начальная корзина должна быть пустой. Разрешены один свежий offer без помола
и количество не больше двух единиц Gateway. Provider checkout, заказы, счета,
оплата, профиль и credentials не меняются. При чужих изменениях — STOP/FAIL,
автоматическая очистка чужой корзины запрещена. Контролируемый Desired fixture
меняет только атомарные монотонные revisions/lines/work в отдельной Orders DB;
Observed/Attempt/Reservation/lease/fence/recovery пишет только production owner.
После потери ответа прежний Desired сохраняется до завершения reconciliation.
Этот сценарий не доказывает Confirm → contribution → aggregate Desired,
API-internal delegation или Kafka broker transport; их проверяют свои gates.

### Локальная проверка допуска

G16 относится к #13. Закрытая историческая
[#55](https://github.com/YurGusev/CoffeeOrderPlatform/issues/55) относит provider
sandbox к #13; [#64](https://github.com/YurGusev/CoffeeOrderPlatform/issues/64)
явно исключает sandbox mutations из своего scope. Gateway и convergence
#10/#11 дают безопасные примитивы, но не заменяют этот launch-сценарий.

`verification.aromaSandbox` в единственном `config/platform.yaml` по умолчанию
равен `null`. Непустая closed policy задаёт mode, exact origin/account MAC,
`existingAccountException`, production deny-lists, Ed25519 public keys с
`keyId`/`approver` и existing refs `aroma.email`/`aroma.password`. Значения
credentials не копируются в отдельную sandbox-ветку. Policy не передаётся в
runtime-конфигурацию сервисов и сама по себе не включает mutations.

Account MAC определяется ADR-0034 по authenticated email, сравненному в памяти
с canonical credential, с существующим Gateway identity key и отдельным
namespace. Пароль в MAC не участвует; открытые hashes email/password,
profile/cookies и ключи в evidence запрещены. Локальный PostgreSQL ограничен
policy `resourceLimits`: memory 1024 MiB и tmpfs 512 MiB; runtime DB names и
resource IDs выводятся из run-id и проверяются перед доступом/cleanup.

Approval проверяется по `schemas/aroma-approval.schema.json` внутри
`verification/launch/v1/`. Detached signature в `<approval-file>.sig` — base64
от 64 байт Ed25519; подписываются точные UTF-8 байты approval JSON, включая
пробелы и переводы строк. Подмена байтов требует новой подписи. Проверяются
signed mode/exception authority, run-id/SHA, origin/account, keyId/approver,
срок не более двух часов, offerRef и maximum quantity (`"1"` или `"2"` в
единицах Gateway). Читаемые policy/schema/inventory должны существовать в
candidate commit и соответствовать ему; staged/unstaged изменения запрещены.
Service delegation/transport keys для approval не используются.

```sh
pnpm launch:verify:aroma-approval -- --approval-file "$AROMA_SANDBOX_APPROVAL_FILE"
```

Offline проверка требует `COFFEE_LAUNCH_CONTEXT_FILE` текущего запуска.
Она не расшифровывает SOPS и не выполняет HTTP/SQL/Docker операции.
Некорректный approval даёт FAIL; отсутствующие входы — NOT_RUN. Даже успешный
admission возвращает exit 78 и `liveWorkflow: NOT_RUN`: подпись не заменяет
семь фактических фаз `pnpm test:aroma-sandbox`. Synthetic Gateway recovery
proofs сохраняют свой отдельный scope. Допуск G16 возможен только после
реальных provider effects, durable recovery и полного восстановления baseline.

Для disposable Catalog используется production activation без дополнительной
подготовки planner statistics через migrator. Cold first-import regression
проверяется отдельно на новой БД с canonical runtime ролью и DB-бюджетами.
Evidence разделяет `catalogStatisticsPrepared=false` и `coldDatabasePlannerProof=false`: G16
не проверяет производительность первого импорта в новую БД без статистики.
Исходные cold failures сохраняются отдельно (ADR-0034).

## 7. Backup/restore

По явному разрешению владельца используется существующий age 1.3.2 и public
recipient set из `.sops.yaml`. Только trusted bootstrap получает документированный
age identity locator: `pg_dump` подаётся прямо в шифрование, расшифрованный поток
сразу в `pg_restore`. Plaintext dump, новый private key или runtime secret scope
не создаются. Gate читает source DB; необходимые completed/pending fixtures
готовятся отдельно до freeze/snapshot. Проверка восстановления выполняет
production handlers именно на restored DB с локальным provider fixture.

Для каждой из пяти owner DB:

1. зафиксировать migration version, owner counts и invariant hashes;
2. `pg_dump --format=custom --no-owner --no-acl` в encrypted artifact;
3. создать новую exact `coffee_restore_<run-id>_<owner>`, где owner — один из
   `customer`, `catalog`, `pricing`, `orders`, `integration`. До создания проверить
   полное совпадение имени с текущими run-id/owner и длину UTF-8 <=63 bytes;
   исходное длинное имя DB повторно в имя restore не включать;
4. `pg_restore --single-transaction --exit-on-error`;
5. запустить migration/schema/constraint/owner invariant checks;
6. проверить pending Outbox/Inbox/Attempt/Reservation rows и запустить workers;
7. доказать: completed не повторяется, unfinished безопасно продолжается,
   UnknownOutcome начинает с GET, старый operationRef не replay;
8. удалить только restore DB после evidence.

PASS: пять restore успешны, invariant hashes совпали, RPO равен моменту dump,
restore каждой DB <=10m и совокупно <=30m на записанном окружении. Backup без
успешного restore не является доказательством.

## 8. Observability gate

Владелец текущего стека — #210 (Operations), обязательный accepted
predecessor #13 после merge и приёмки handoff. Он заменяет OpenObserve-specific
часть #64 отдельными Grafana/Loki/Prometheus/Tempo и готовым Alloy по
[ADR-0040](../adr/ADR-0040-grafana-observability.md). Producer guarantees #64
сохраняются; #13 проверяет результат, а не создаёт backend. Component proofs
самого #210 выполняются до merge без зависимости от собственного accepted handoff.
Внутри этой команды canonical `runtimeMetricMatrix` проверяет functional
наблюдаемость всех 14 Node runtime в recovery-proof Compose запуске и native nginx.
Это evidence не закрывает launch-level full-system G14: #13 отдельно принимает
SLO, chaos/failure, capacity и полный browser/business/DB/Kafka/SSE путь.
Новый handoff — `evidence/handoffs/issue-210.yaml`; исторический
`evidence/handoffs/issue-64.yaml` не переписывается. В
`evidence/observability/<run-id>/` обязательны `alert-transitions.json`,
`correlation-proof.json`, `redaction-scan.json`, `queue-loss-counters.json`,
`retention-result.json`, `runtime-health-matrix.json` и `result.json` с source,
config/BOM/image digests. NOT_RUN/FAIL любого обязательного сценария сохраняет
G14 закрытым. Внешние notifications запрещены. Единственная policy authority —
`config/platform.yaml.telemetry`; [runbook](../operations/observability.md)
не является вторым источником значений.
Для нового стека владелец согласовал отдельные ограниченные persistent volumes,
retention три дня, штатные отказы/восстановление и alert на 80% заполнения.
Loki использует native WAL threshold 0.8; Prometheus и Tempo не обязаны
возвращать HTTP 503 при 80%. Alert не подменяет ingestion guard. Проверка TTL
в ускоренном изолированном профиле явно отделяется от elapsed 72h production proof.
Сквозной сценарий использует ограниченные по времени spans и W3C context/links;
`orderRef` и correlation связывают долгоживущий order с несколькими traces.
Бесконечный span на весь lifecycle заказа не требуется.

Canonical runtime matrix #64 проверяет для каждого из 14 Node runtime реальные
self-mTLS запросы к `/health/live`, `/health/ready`, text OpenMetrics и ожидаемые
4xx, а также доступность OTLP HTTP/error и producer metrics. Матрица проверяет
наличие 10 DB-waiting, 2 durable consumer-lag и 5 scoped Outbox-age series.
Предшествующий launch проверяет lag preparation и realtime после реальной
активности; вместе эти проверки охватывают все 3 consumer owners. Событийные и
транзакционные samples допускаются только после реальной активности существующего
owner launch (шесть ролей и SQL-backed convergence helper). Перед стандартным
Compose cleanup все 15 final images сканируются по фактическим image IDs; запуск
не использует `--keep`, закрепление контейнеров или отдельную parallel pipeline.
Результат матрицы фиксируется ровно в поле `runtimeMetricMatrix`.

Матрица #64 не доказывает full-system launch acceptance и не измеряет capacity.
Для #13 остаются обязательными:

- `/health/live` 200 при живом process;
- `/health/ready` 200 только при готовых обязательных зависимостях и 503 при их
  отказе;
- OpenMetrics endpoint: request duration/count/errors, DB/Kafka pool/lag,
  Outbox/Inbox backlog, Attempt/UnknownOutcome, SSE connections/drops;
- один browser correlation id проходит edge→api-public→owner→DB log→Outbox→Kafka→projection worker→Realtime→edge→browser→owner refetch;
  только эта фаза G14 вправе использовать согласованный OIDC-only child по
  разделу 16: прямой parent — product candidate, единственное изменение —
  `browserOidc`, отдельные child run/DB/Kafka/evidence, sealed lineage и Git
  bundle. Остальные фазы G14 остаются на product candidate. Runner требует
  доказанную связь child с parent и cleanup; G13/G15 artifacts не перезаписываются;
- W3C traceparent сохраняется; network/DB spans не содержат body/secrets/PII;
- alerts: существующий `notReady` 5m охватывает Node `runtime_ready` и native
  nginx `httpcheck.status` класса `2xx`. При здоровых 14 Node остановить native
  nginx, проверить переход probe `1→0`, firing после настроенного окна и resolved
  того же episode после restart и перехода `0→1`. Сохранить Node not-ready
  injection; сначала завершить synthetic alert transitions до business-owner
  launch path, затем выдержать здоровый notReady baseline и resolved старые
  episodes в течение evaluation interval плюс health interval; остальные
  сценарии — consumer lag 5m, Outbox oldest 5m,
  UnknownOutcome >0 2m, SSE drop rate >5% 5m;
- canary secret/PII отсутствует в logs, traces, metrics labels, alerts, artifacts
  и browser bundle.

Для native nginx отдельно проверить transport `/health/live`, конфигурацию и
реальный private auth/API/SSE dependency path; static 200 или `nginx -t` не
заменяет full-system readiness. Native access allowlist и collector/alerts
принимает #64, transport-inclusive capacity и reconnect — #12/#13.
Availability alert использует только private endpoint из
`telemetry.nginxStatusEndpoint`: `http_check` публикует native `2xx` status как
1 при доступности и 0 при probe failure, а существующий `notReady` применяет
`min(runtime_ready or native_nginx_2xx) <= 0` с прежним окном 5m. Проверка
останавливает nginx при здоровых 14 Node и подтверждает firing и resolved того
же episode после восстановления. Этот сигнал не подменяет Node readiness и сам
по себе не доказывает полную system readiness или capacity. Collector удаляет
`http.status_code` из nginx probe datapoints для стабильной availability series
и `error.message` из всех metric datapoints для защиты от утечки текста ошибок.
Общий metric transform также удаляет `http.url`, чтобы probe endpoint не становился label.

Topology gate отдельно доказывает: `api-public` монтирует только `client-v1`,
`api-internal` — только `internal-v1`; Edge→owner и Browser→owner запрещены;
оба API root не имеют DB/Kafka/provider secrets; forged delegation и mutation
не от original `aroma-convergence` получают 403. `api-agent` остаётся authority
role `implemented=false` и отсутствует в Compose. Node 26.8.1 используется для
14 Node runtime images и foundation/CI; native nginx использует отдельный pinned
image по `config/toolchain-versions.json`. Node 24 считается version drift.

## 9. Rollback mutation-disable

Исходное состояние: running stack, одна unfinished reservation/UnknownOutcome и
доступный safe observer. Процедура:

1. создать отдельный config-only commit `D` от product candidate `B` по
   [ADR-0035](../adr/ADR-0035-launch-rollback-config-lineage.md): в единственном
   `config/platform.yaml` меняется только
   `services.aroma-convergence.mutationsEnabled: true → false`; overlay запрещён;
2. restart только `aroma-convergence`; readiness показывает режим read/recovery-only;
3. новые mutation commands не отправляются, existing operationRef не replay;
4. `aroma-observer` продолжает safe GET и Observed events;
5. Orders API/Order Card/Customer/Catalog/Pricing/realtime остаются healthy;
6. Attempt/Reservation/Desired/Observed/Inbox/Outbox сохраняются после restart;
7. reconciliation wake-up сохраняется durable, но mutation блокируется code
   `AROMA_MUTATIONS_DISABLED`;
8. config-only commit `R` от `D` возвращает прежние байты config из `B` и
   восстанавливает worker только после fresh GET; blind mutation отсутствует.

В основном run-result остаётся product candidate `B`. Отдельное evidence G18
обязано доказать lineage `B → D → R`, unchanged product trees, точные config hashes
и фактическое применение каждого config runtime. Дополнительные source изменения,
неверные parent/diff или отсутствие receipts не допускаются. Разрешение владельца
от 24 октября касается этой узкой процедуры; оно не означает PASS G18.

PASS: zero provider mutation while flag false, no durable row loss, observer и
owner paths healthy, recovery resumes safely.

## 10. Defect workflow

Любой FAIL всегда создаёт локальный sanitized `defect.json` до G19. Отдельный
publish step создаёт GitHub issue только при заранее выданном scoped разрешении
на mutation `YurGusev/CoffeeOrderPlatform`. Issue содержит:
gate ID/run-id/SHA, severity `P0|P1|P2`, owner area, exact command, expected vs
actual, sanitized evidence links, deterministic reproduction, impact и
acceptance test. Labels: `type:bug`, `status:ready`, area, risk, priority.

Verification branch не исправляет defect, не меняет product contracts/pins/
thresholds и не ослабляет test. `defects.json` содержит локальный defect id и,
если публикация разрешена/успешна, GitHub issue number. Отсутствие разрешения не
скрывает FAIL и не меняет `НЕ ДОПУСТИТЬ`.
P0/P1 всегда блокирует; любой mandatory FAIL блокирует независимо от severity.

## 11. Русский отчёт

`ОТЧЁТ.md` содержит: решение крупным заголовком, run-id/SHA/time, окружение и
digests, таблицу G00–G19, exact commands/durations/results, ссылки и SHA-256
артефактов, sandbox account fingerprint без credentials, backup RPO/restore
times, observability/rollback результаты, defect issues, открытые риски и
непроверенное поведение. Отчёт генерируется из result JSON; ручное изменение
decision запрещено schema/checksum check.

## 12. Не входит

Production deployment, Kubernetes, исправление defect, повышение thresholds,
новые features/dependencies/services, реальные production AROMA credentials,
перезапись legacy DB и удаление пользовательских данных не входят в #13.

## 13. Runtime evidence #61 для последующего launch gate

Foundation проверяется существующей командой
`node --test tests/runtime/lifecycle.test.mjs`. Handoff
`evidence/handoffs/issue-61.yaml` передаёт #62/#63/#64 общий lifecycle API,
матрицу 15 roots, configured deadlines и ограничения. Этот suite не заменяет
G10/G11/G13/G14 на принятом launch SHA.

Обязательные сценарии: реальные TCP disconnect до завершения input и после
полного GET; normal response без abort; request deadline; known acceptance и
replay fake owner result; startup partial cleanup в обратном порядке; bounded
readiness blackhole; live `200`/ready `503` при draining; invalid transition и
повтор shutdown; неотвечающий hook и owned socket с конечным возвратом;
process-level fail-stop и снятие единственной пары signal handlers.
Один harness выполняется для всех 15 configured identities, включая отсутствие,
успех и отказ обязательных dependency checks.

Бюджеты production берутся только из `config/platform.yaml`:
`health.startupGraceMs=30000`, `health.timeoutMs=1000`,
`platform.shutdownGraceMs=30000`; request deadlines и явные `null` сохраняются
по каждому runtime. Тесты используют уменьшенные in-memory budgets и измеряют
фактическое завершение с допуском scheduler. Для non-cooperative hooks требуется
`fail-stop` evidence и принудительное закрытие зарегистрированных ресурсов,
а не только успешное завершение Promise ожидания.

## 14. PostgreSQL foundation evidence #62

Unit state-machine и fake-driver failures выполняются в существующем
`packages/platform-testing/test/platform-packages.test.mjs`; они не заменяют
реальный PostgreSQL. `tests/database/db-bootstrap.test.mjs` проверяет fleet
budget с резервом/rollout и отсутствие автоматического изменения лимитов.

Live commands: `COFFEE_DB_LIVE_PROOF=1 node --test
 tests/database/live-db-proof.test.mjs` и `node scripts/db-live-proof.mjs`.
Harness создаёт disposable PostgreSQL фиксированной версии, временные owner
fixtures и credentials в памяти, затем удаляет созданный контейнер.
Обязательные сценарии: concurrent acquire/replay/conflict, rollback при
перехваченной SQL-ошибке, потерянный ответ COMMIT при фактически записанном owner
state и восстановление durable response после reconnect, потерянный ответ
ROLLBACK, checksum drift, COPY interruption и pool/health recovery.

TCP proxy направляет terminal command настоящему серверу и удерживает ответ;
измеряются wall-clock bound, destroy и отсутствие ROLLBACK после COMMIT.
Timeout не считается доказательством rollback. Отдельный unit scenario
не cooperative callback требует `fail-stop` с `stop:database` в pending.

`pnpm test:compose-smoke --database-proof` проверяет owner-local pool/readiness
в изолированном Compose окружении с disposable PG. Общий Kafka readiness gate
не подменяется этим scoped proof и остаётся зависимым от #63. Structural
`pnpm db:smoke` доказывает bootstrap/grants contract, не blackhole recovery.
Итоговые команды, измерения и SHA-256 передаются в
`evidence/handoffs/issue-62.yaml`; они не заменяют launch G10/G11/G13/G14.

## 15. Kafka/Inbox/Outbox foundation evidence #63

Эта секция определяет evidence для bounded delivery foundation. Машинные
результаты выполненных DB/Compose проверок, команды и ограничения опубликованы
в `evidence/handoffs/issue-63.yaml`; принятие подтверждается merge в GitHub.
Пропущенный live/Compose сценарий не является PASS.

### 15.1 Structural protocol checks

На одном commit SHA должны пройти `pnpm authority:check`,
`pnpm architecture:check`, `pnpm config:check`, `pnpm lint`,
`pnpm typecheck`, `pnpm test` и `git diff --check`. Architecture/config checks
должны отвергать Effect Kafka imports, legacy `mode`/`groups`, неизвестный
topic/group и любой `processing: realtime`, кроме тройки
`realtime-gateway`/`coffee.realtime.invalidate.v1`/`realtime-gateway-v1`.

Детерминированный suite обязан зафиксировать:

1. Один assigned partition обрабатывает записи в offset order с одним owner
   handler in flight; несколько partitions используют общий `maxInFlight`, а
   queued + active не превышают `queueCapacity`.
2. Decode и transport validation выполняются до Inbox. Невалидная durable
   запись попадает в owner quarantine и получает offset commit только после
   известного quarantine COMMIT; ошибка quarantine оставляет redelivery.
3. `Inbox.begin` → owner state/Outbox → `markProcessed` — одна transaction;
   duplicate и hash conflict не вызывают handler. DB rollback или
   `TransactionOutcomeUnknown` не вызывают offset commit.
4. Broker offset commit выполняется после known DB COMMIT. Неизвестный commit
   даёт `OFFSET_COMMIT_OUTCOME_UNKNOWN`, останавливает affected partition,
   вызывает bounded revoke/restart/reassignment и не пропускает следующий
   unsafe record в том же worker.
5. Revoke и SIGTERM прекращают intake, boundedly завершают текущую
   transaction/ack, закрывают consumer/producer и уничтожают зависший client;
   non-cooperative Promise завершается process-level fail-stop, а не обещанием
   принудительной отмены.
6. Outbox сохраняет исходный `messageId` и payload hash, sequence одного
   aggregate публикуется через barrier `n → n+1`, разные aggregates не блокируют
   друг друга; crash после broker ack до finalize восстанавливает lease без
   потери строки или blind retry unsafe effect.

### 15.2 Live DB/Kafka and retention proof

Структурная команда `pnpm db:smoke` проверяет owner-local bootstrap/grants и не
заменяет PostgreSQL failure proof. Обязательные disposable DB сценарии
запускаются командами `COFFEE_DB_LIVE_PROOF=1 node --test
tests/database/live-db-proof.test.mjs` и `node scripts/db-live-proof.mjs`:
atomic Inbox/owner/Outbox result, duplicate/conflict, DB unknown, expired lease,
rollback и pool recovery. Evidence обязана показывать owner schema и role; raw
credentials, payload и SQL parameters запрещены.

Compose failure proof запускается через `pnpm test:compose-smoke --recovery-proof`
и `node tools/compose-smoke.mjs --recovery-proof --project-name coffee-recovery-foundation`.
Этот флаг включает disposable DB и native failure scenarios; обычный режим с
SOPS сам по себе их не подтверждает. Повтор использует `--no-build` только для
образов с теми же production sources. После
broker acknowledgement контейнер Kafka пересоздаётся с тем же project name,
record читается после health recovery, а named volume сохраняет только этот
Compose project scope. Один broker и RF=1 — development limit; это не HA claim.
Broker ack без recreate/retention evidence не считается durable delivery.

### 15.3 Handoff наблюдаемости

`#63` передаёт `#64` следующие bounded fields: lag по
`runtime/groupId/topic/partition`, `assigned`, `active`, `queued`, `pending`,
capacity, queue saturation, Inbox lease expiry, quarantine,
duplicate/conflict, `unknownCommitTotal`, recovery и last machine code.
Разрешённые labels ограничены config allowlists и конечными machine reasons;
payload, envelope, message body, key, SQL, credentials, secret material и
correlation identifiers не являются metric labels. `correlationId`,
`causationId`, `traceparent` можно передавать как correlation fields в log/trace.
`#64` добавляет producer/collector foundation; #210 заменяет backend и alert evaluation. #63 не подменяет G14.

`#63` также передаёт business consumers typed decoder/handler boundary и
owner-local migration contract. Business event schemas, provider semantics,
HTTP contracts и migrations конкретного owner не считаются реализованными этим
foundation. `#4` получает отдельный contract handoff и не становится
циклической зависимостью Kafka delivery.

## 16. Frontend recovery admission #119

Для #12 G10/G15 принимают раздельные proofs: material owner→persisted Outbox→
native Kafka→nginx→served SPA→owner GET без transform compiled transport и
explicit-only private EOF negative/recovery; ни один не заменяет полный
`operator-1` (1 SSE subscriber, 100 ACKed invalidations/s, 100 subjects, 30min).
В существующей owner/browser вертикали отдельный `reauth` proof подтверждает
native EventSource через nginx/Edge при естественном actor expiry60s/check30s:
server auth-close, новый авторизованный stream, ready и owner GET без ручного
reconnect/session refresh или изменения TTL. Transport-only re-auth и Vite401
не заменяют этот совместный proof; frozen compiled transport остаётся неизменным.
При expiry Observed повторный owner GET возвращает `OutOfSync` с прежней
projectionVersion: браузер обязан принять read-time freshness transition,
показать расхождение без fatal protocol alert и сохранить business version.
Отдельная prephase доказывает512/513 до SSE headers и cleanup до main cohort.
nginx/realtime сохраняют по2CPU/512MiB; authTTL≤60s/check30s/retry3000,
session renewal, HUP900s, loaded shutdown≤20s/cleanup≤10s и прежние latency/
event-loop/headroom thresholds обязательны. Исторический5000FAIL не становится PASS.
Owner-пик100 одновременно начатых потоков заказов×10 позиций проверяется отдельно
на реальных Orders routes/PostgreSQL/Outbox при текущих deadlines/pool; synthetic
Customer/Pricing/auth seams не доказывают production ingress/VK/Agent/LLM capacity.

По решению владельца от 31 октября 2026 для G14 обязательна отдельная
квалификация SSE на том же product candidate: prephase 512/513 и полный
`operator-1` с одним subscriber, 100 ACK/s для 100 subjects и измерением
1800000 ms. На подготовку, нагрузку, cleanup и sealing отводится отдельный
бюджет 2700 s; бюджеты G14 1800 s и всего launch 7200 s не изменяются.
Пакет принимается не позднее 7200 s после завершения и только один раз для
текущего пользователя на сервере. Он связывает SHA кандидата, исходную
конфигурацию, BOM и lock, все 15 image IDs проверенного G12, фактически
использованные native images трёх ролей и nginx, Kafka, host profile и
проверенную OIDC-only lineage. Повторное использование, неизвестный cleanup,
расхождение или отсутствие PASS блокируют G14 и merge. Synthetic Orders и IdP
для transport qualification и отдельного supplemental component diagnostic G14:
ни один из них не доказывает browser OrderConfirm, production IdP или full-system G14.

G05/G10/G15 принимают outputs #4/#5/#7/#8/#9 по
[протоколу browser recovery](26_BROWSER_COMMAND_RECOVERY.md): потерянный ответ
Customer/Draft/Quote, reload до resourceRef, Completed read-only replay без
повторного эффекта, non-terminal InProgress и lookup unavailable/not-retained.
Проверяются текущая авторизация, scope concrete path и отсутствие PII в storage.
G15 также требует изменение/удаление Draft item, старый GET/replay после новой
карточки, первичный SSE refetch, logout/session switch и deep-link reload через
Edge. Missing asset/API не возвращает index.html. Fixture evidence #9 дополняется
интеграционным owner proof #5/#7/#8; один mock не доказывает отсутствие DB writes.

`pnpm test:playwright` запускает родительский сценарий из product candidate с
проверенным launch context и неизменённым `browserOidc: null`. Сценарий создаёт
один отдельный дочерний checkout и config-only commit с прямым родителем
product candidate; меняется только `browserOidc` с `null` на утверждённый
synthetic профиль. Дочерний checkout запускает `node tools/compose-smoke.mjs
--browser-proof` напрямую. Родитель связывает собственный context с child
context, запечатанной lineage, полным browser artifact и cleanup; после
удаления child checkout восстанавливает его bounded Git bundle во временный
object store и заново проверяет прямого родителя, единственный изменённый путь
и точные config blobs. G00–G13 и все фазы G14, кроме браузерной корреляции,
остаются привязаны к product candidate с `browserOidc: null`. По решению
владельца от 31 октября 2026 та же OIDC-only lineage разрешена фазе
browser correlation G14 и выполняемому перед ней supplemental component diagnostic.
Diagnostic использует проверенную parent G08 preparation и пять выделенных БД во
внешнем PostgreSQL; browser запускается только после подтверждённой очистки.
Synthetic diagnostic сохраняется отдельно и не заменяет реальный browser proof. Она сохраняет собственные child context, lineage,
bundle, config blobs, runtime result и cleanup в `gates/G14_OBSERVABILITY/artifacts/`;
G15 сохраняет отдельный комплект в своём artifact directory. Parent и child
identities и отличие единственного поля проверяются так же строго, как G15;
чужой gate, другой parent, дополнительные изменения и отсутствующий cleanup
прекращают проверку. Ни один из этих synthetic IdP не является постоянной
установкой или доказательством production IdP. Mock-сценарии UI остаются
в `pnpm test:web-operator`.

G15 сохраняет child context, lineage receipt, полный browser runtime artifact,
оба config blob, Git bundle и parent receipt в
`gates/G15_BROWSER/artifacts/`. Runner проверяет identities обоих запусков,
joined exit code 0, восстановленную Git lineage, owner evidence, stdout receipt
и отсутствие child checkout/evidence, контейнеров, сетей, volumes, временных
ключей, NSS profile и Compose override. Один exit code 0 не является PASS.
Synthetic login не подтверждает production IdP; actual runtime status берётся
только из результата конкретного запуска.

## 17. Запуск runner v1

Из чистого checkout кандидата с установленными зависимостями закреплённых версий:

```sh
node verification/launch/v1/run.mjs \
  --candidate-sha <полный-SHA-кандидата> \
  --accepted-base-commit <принятая-develop-до-начала-работы> \
  --realtime-qualification <абсолютный-путь-к-qualification.json>
```

Runner создаёт отдельный пустой detached checkout указанного SHA. Зависимости
управляющего процесса не копируются в него и не заменяют G01. G00 до install использует
YAML parser из проверенного исходного checkout; отчёт G19 использует только
встроенные модули Node. `COFFEE_LAUNCH_CONTEXT_FILE` передаёт служебные пути и identity
запуска, без настроек приложения и секретов. Необязательный `--github-snapshot`
задаёт reference artifact; он не заменяет свежую проверку GitHub authority.

Для дочерних gate-команд runner задаёт служебную настройку pnpm
`pnpm_config_verify_deps_before_run=false`: в pnpm 11 стандартное поведение
[`verifyDepsBeforeRun=install`](https://pnpm.io/settings/build#verifydepsbeforerun)
может установить зависимости ещё до G00. Отключается только автоматическая
проверка/установка перед script; явный `pnpm install --frozen-lockfile` остаётся
исключительной командой G01. Exact argv gates не меняется. Это настройка
инструмента проверки, а не override конфигурации приложения.

Результаты сохраняются в `evidence/launch/<run-id>/` и
`docs/reports/launch/<run-id>/ОТЧЁТ.md`; временный checkout удаляется после
сохранения результата. При `НЕ ДОПУСТИТЬ` runner возвращает exit 1. Новый запуск
требует нового run-id; предыдущие evidence сохраняются. G19 создаёт отчёт и
checksums даже после отказа G00, когда install и все downstream gates не запущены.
Новый `checksums.sha256` содержит стандартные строки `SHA-256  relative-path`.
Проверка из корня репозитория:

```sh
sha256sum -c evidence/launch/<run-id>/checksums.sha256
```

Размеры файлов хранятся в artifact records и отчёте. Evidence предыдущего run-id
сохраняет исходный формат и проверяется verifier из его candidate SHA; задним
числом не преобразуется.

Наличие runner не подтверждает launch acceptance. Отсутствующая exact command,
непроверенный handoff, несовместимый host или отсутствие sandbox approval
сохраняют блокировку. Runner не создаёт production/test infrastructure и не
подменяет недостающие сценарии соседними suites; такие gaps устраняются отдельно
по defect workflow раздела 10. Запуск закреплённых images, изолированные DB/roles,
полный native stack и provider admission требуют собственных фактических proofs.

Выявлено противоречие имени Compose project в разделе 3: run-id содержит
заглавные `T`/`Z`, а Compose принимает только строчные буквы, цифры, `_` и `-`.
G00 фиксирует `composeProjectSyntaxValid=false`; скрытая нормализация имени
запрещена. До отдельного согласованного исправления норматива это blocker.

Проверки самого runner и G00 входят в `pnpm test`; узкий запуск:

```sh
node --test verification/launch/v1/runner.test.mjs \
  verification/launch/v1/scenarios/preflight.test.mjs
```
