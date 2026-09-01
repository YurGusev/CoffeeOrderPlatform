# Исполнимая спецификация итогового launch gate

Статус: нормативная спецификация issue #13. Задача проверяет принятый scope и
не исправляет найденные дефекты внутри verification PR.

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

Compose project name `coffee-launch-<run-id>`. Он не создаёт PostgreSQL service
и не подключается к legacy `coffeeorderdb`. Verification использует отдельные
БД `coffee_verify_<run-id>_{customer,catalog,pricing,orders,integration}` и
отдельные roles; bootstrap проверяет server identity PostgreSQL 17.x. Cleanup
удаляет только exact run-id databases/roles после сохранения evidence.

Kafka topics/groups содержат run-id. AROMA mutation по умолчанию выключена.

`environment.json`: commit/tree SHA, dirty=false, UTC/timezone, OS/arch, CPU/RAM,
Node/pnpm/Docker/Compose/PostgreSQL/Kafka/browser versions, image digests,
config hash, encrypted secrets-file hash и run-id resources. Secret values нет.

## 4. Версионированная matrix

Каждая строка `matrix.yaml` содержит:
`id`, `version`, `mandatory`, `owner`, `predecessors`, `command`, `timeout`,
`inputs`, `expectedArtifacts`, `passCriteria`, `cleanup`, `rerunPolicy`.

| ID | Владелец | Exact command | PASS |
|---|---|---|---|
| `G00_PREFLIGHT` | Platform | `pnpm launch:verify:preflight` | clean SHA, handoffs #2–#12/#16–#18 present, no legacy DB target |
| `G01_INSTALL` | Platform | `pnpm install --frozen-lockfile` | lock unchanged; no lifecycle/network surprise outside allowlist |
| `G02_GENERATED` | Contracts | `pnpm contracts:check-generated` | generated tree byte-equal, no drift |
| `G03_STATIC` | Platform | `pnpm format:check && pnpm lint && pnpm typecheck` | все exit 0, warnings budget 0 |
| `G04_UNIT` | Domain owners | `pnpm test:unit -- --coverage` | exit 0; changed critical modules meet declared thresholds |
| `G05_CONTRACTS` | Contracts | `pnpm contracts:check && pnpm contracts:breaking` | positive/negative fixtures pass, no unapproved breaking change |
| `G06_ARCHITECTURE` | Architecture | `pnpm architecture:check` | all GREEN pass; every RED fails with source/target/rule |
| `G07_CONFIG_SECURITY` | Security | `pnpm versions:check && pnpm config:check && pnpm security:secrets` | exact pins/SOPS/scopes/redaction; zero plaintext/canary leak |
| `G08_MIGRATIONS` | DB owners | `pnpm test:migrations:clean && pnpm test:migrations:forward` | five empty DBs reach exact schema; rerun no-op; legacy unchanged |
| `G09_DB_BOUNDARIES` | DB owners | `pnpm db:smoke` | allowlisted operations pass; every cross-owner access denied |
| `G10_INTEGRATION` | Service owners | `pnpm test:integration` | HTTP/DB/Kafka/idempotency/concurrency suites pass |
| `G11_RECOVERY` | Reliability | `pnpm test:recovery` | duplicate/crash/replay/rebalance/lease/fence/reservation matrix pass |
| `G12_SUPPLY_CHAIN` | Security | `pnpm security:scan` | SBOM/provenance produced; zero critical/high exploitable finding |
| `G13_COMPOSE` | Platform | `pnpm test:compose-smoke` | all runtimes ready, dependency failure/graceful stop pass |
| `G14_OBSERVABILITY` | Operations | `pnpm test:observability` | health/metrics/traces/correlation/alerts/redaction pass |
| `G15_BROWSER` | Frontend | `pnpm test:playwright` | Chromium critical/accessibility/deep-link/conflict/realtime pass |
| `G16_AROMA_SANDBOX` | Integration+Reliability | `pnpm test:aroma-sandbox -- --approval-file "$AROMA_SANDBOX_APPROVAL_FILE"` | controlled GET→≤1 mutation→GET/lost-response/recovery/restore pass |
| `G17_BACKUP_RESTORE` | DB owners | `pnpm test:backup-restore` | five dumps restored into new DBs; schema/data/invariants match |
| `G18_ROLLBACK` | Operations | `pnpm test:mutation-disable-rollback` | mutation off, observer/Orders/recovery remain healthy, no state loss |
| `G19_REPORT` | Release owner | `pnpm launch:verify:report` | Russian report, checksums, defects and deterministic decision valid |

Порядок обязателен: G00→G01→G02→G03; затем G04–G12; G13; G14–G18; G19.
Gate не запускается при failed predecessor.

## 5. Общие правила команд

Runner записывает start/end UTC, command argv без secret values, cwd, exit code,
timeout, peak RSS и artifact hashes. Timeout завершает process group и даёт FAIL.
Значения timeout: static/unit/contracts 15m; integration/recovery 30m; Compose,
browser, sandbox, backup/restore, rollback по 30m; полный run максимум 120m.

Retry test command автоматически запрещён. Flaky результат = FAIL и defect.
Повтор возможен только отдельным новым run-id с причиной в отчёте; предыдущий
FAIL не удаляется.

## 6. AROMA sandbox gate

G16 не запускается обычным PR CI. Требуются одновременно:

- encrypted/scoped sandbox credentials;
- allowlisted provider origin и account fingerprint;
- `AROMA_MUTATIONS_ENABLED=true` только для convergence container;
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
restore = immediate FAIL, mutation disable и defect. Production origin/account
закодированы в deny-list. Approval/secrets не попадают в evidence plaintext.

## 7. Backup/restore

Для каждой из пяти owner DB:

1. зафиксировать migration version, owner counts и invariant hashes;
2. `pg_dump --format=custom --no-owner --no-acl` в encrypted artifact;
3. создать новую exact `<db>_restore_<run-id>`;
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

Для каждого из 15 runtime проверить:

- `/health/live` 200 при живом process;
- `/health/ready` 200 только при готовых обязательных зависимостях и 503 при их
  отказе;
- OpenMetrics endpoint: request duration/count/errors, DB/Kafka pool/lag,
  Outbox/Inbox backlog, Attempt/UnknownOutcome, SSE connections/drops;
- один browser correlation id проходит edge→owner→DB log→Outbox→Kafka→worker→SSE→refetch;
- W3C traceparent сохраняется; network/DB spans не содержат body/secrets/PII;
- alerts с test injection: service not ready 5m, consumer lag 5m,
  Outbox oldest 5m, UnknownOutcome >0 2m, SSE drop rate >5% 5m;
- canary secret/PII отсутствует в logs, traces, metrics labels, alerts, artifacts
  и browser bundle.

Topology gate отдельно доказывает: `api-public` монтирует только `client-v1`,
`api-internal` — только `internal-v1`; Edge→owner и Browser→owner запрещены;
оба API root не имеют DB/Kafka/provider secrets; forged delegation и mutation
не от original `aroma-convergence` получают 403. `api-agent` остаётся authority
role `implemented=false` и отсутствует в Compose. Node 26.8.1 используется для
всех 15 production images и foundation/CI; Node 24 считается version drift.

## 9. Rollback mutation-disable

Исходное состояние: running stack, одна unfinished reservation/UnknownOutcome и
доступный safe observer. Процедура:

1. изменить только `services.aroma-convergence.mutationsEnabled=false` в
   versioned config overlay; секреты/DB/schema не менять;
2. restart только `aroma-convergence`; readiness показывает режим read/recovery-only;
3. новые mutation commands не отправляются, existing operationRef не replay;
4. `aroma-observer` продолжает safe GET и Observed events;
5. Orders API/Order Card/Customer/Catalog/Pricing/realtime остаются healthy;
6. Attempt/Reservation/Desired/Observed/Inbox/Outbox сохраняются после restart;
7. reconciliation wake-up сохраняется durable, но mutation блокируется code
   `AROMA_MUTATIONS_DISABLED`;
8. возврат прежнего immutable config digest восстанавливает worker только после
   fresh GET; blind mutation отсутствует.

PASS: zero provider mutation while flag false, no durable row loss, observer и
owner paths healthy, recovery resumes safely.

## 10. Defect workflow

Любой FAIL автоматически создаёт отдельный GitHub issue до G19. Issue содержит:
gate ID/run-id/SHA, severity `P0|P1|P2`, owner area, exact command, expected vs
actual, sanitized evidence links, deterministic reproduction, impact и
acceptance test. Labels: `type:bug`, `status:ready`, area, risk, priority.

Verification branch не исправляет defect, не меняет product contracts/pins/
thresholds и не ослабляет test. `defects.json` содержит issue number и gate.
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
