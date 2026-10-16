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
| `G00_PREFLIGHT` | Platform | `pnpm launch:verify:preflight` | clean SHA; accepted GitHub PR/handoffs #14/#19/#2–#12/#16–#18/#60/#61/#62/#63/#64; authority repo exact; no legacy DB target |
| `G01_INSTALL` | Platform | `pnpm install --frozen-lockfile` | lock unchanged; no lifecycle/network surprise outside allowlist |
| `G02_GENERATED` | Contracts | `pnpm contracts:check-generated` | generated tree byte-equal, no drift |
| `G03_STATIC` | Platform | `pnpm format:check && pnpm lint && pnpm typecheck` | все exit 0, warnings budget 0 |
| `G04_UNIT` | Domain owners | `pnpm test:unit -- --coverage` | exit 0; changed critical modules meet declared thresholds |
| `G05_CONTRACTS` | Contracts | `pnpm contracts:check-generated && pnpm contracts:breaking && pnpm contracts:test` | positive/negative fixtures pass, no unapproved breaking change |
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
Gate не запускается при failed predecessor, кроме G19: отчёт с решением
`НЕ ДОПУСТИТЬ` формируется и при отказе предыдущих gates.

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

Владелец реализации — #64 (Operations), обязательный accepted
predecessor #13. Он поставляет Collector/OpenObserve, exporters, alert evaluation
и `pnpm test:observability`; #13 проверяет этот результат, а не создаёт backend.
Внутри этой команды canonical `runtimeMetricMatrix` проверяет functional
наблюдаемость всех 14 Node runtime в recovery-proof Compose запуске и native nginx.
Это evidence не закрывает launch-level full-system G14: #13 отдельно принимает
SLO, chaos/failure, capacity и полный browser/business/DB/Kafka/SSE путь.
Handoff — `evidence/handoffs/issue-64.yaml`. В
`evidence/observability/<run-id>/` обязательны `alert-transitions.json`,
`correlation-proof.json`, `redaction-scan.json`, `queue-loss-counters.json`,
`retention-result.json`, `runtime-health-matrix.json` и `result.json` с source,
config/BOM/image digests. NOT_RUN/FAIL любого обязательного сценария сохраняет
G14 закрытым. Внешние notifications запрещены. Единственная policy authority —
`config/platform.yaml.telemetry`; [runbook](../operations/observability.md)
не является вторым источником значений.
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

1. committed/versioned изменением единственного `config/platform.yaml` установить
   `services.aroma-convergence.mutationsEnabled=false`; overlay запрещён;
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
`#64` добавляет collector/exporter и alert evaluation; #63 не подменяет G14.

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

G05/G10/G15 принимают outputs #4/#5/#7/#8/#9 по
[протоколу browser recovery](26_BROWSER_COMMAND_RECOVERY.md): потерянный ответ
Customer/Draft/Quote, reload до resourceRef, Completed read-only replay без
повторного эффекта, non-terminal InProgress и lookup unavailable/not-retained.
Проверяются текущая авторизация, scope concrete path и отсутствие PII в storage.
G15 также требует изменение/удаление Draft item, старый GET/replay после новой
карточки, первичный SSE refetch, logout/session switch и deep-link reload через
Edge. Missing asset/API не возвращает index.html. Fixture evidence #9 дополняется
интеграционным owner proof #5/#7/#8; один mock не доказывает отсутствие DB writes.
