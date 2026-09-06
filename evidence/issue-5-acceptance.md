# Issue #5 — acceptance evidence

Статус: **acceptance выполнен, готово к merge**. Матрица ветки
`feature/5-customer-service` проверена 2026-09-06. Accepted merge подтверждается
GitHub, а не self commit SHA в этом документе. Production deployment не выполнялся.

В этом продолжении добавлены общий mTLS foundation с TLS 1.3, SPIFFE SAN и
fail-closed peer verification, явный `public-tls` Edge listener и `mtls` для
внутренних runtime, production wiring `api-public`, `api-internal` и
`customer-service`, scoped delegation verification key sets, отдельный
Customer cursor key/policy, production-safe runtime healthcheck и test-only
unknown-COMMIT/restart harness. Исправлен public TLS trust path: server leaf
больше не используется как CA, `edge.tlsCaBundle` — optional scoped public CA
bundle для выделенного test environment, без bundle используется системное
доверие Node.js, а host smoke и runtime healthcheck получают hostname из
`platform.publicBaseUrl`. Test-only provisioning создаёт отдельную public CA;
её private key не materializes в runtime. После расследования исходного inventory и разрешения пользователя выполнен
новый provisioning с постоянными identities и резервной копией вне Git;
детали приведены ниже.

## Authority и predecessors

`origin` указывает на
`https://github.com/YurGusev/CoffeeOrderPlatform.git`. База ветки — принятый
`develop` commit `eb34befd76c0654e75d82637251dc4d12d0e0213` (merge PR #128).

| Input | Accepted merge в `develop` | Handoff SHA-256 | Проверка |
|---|---|---|---|
| #4 contracts | `eb34befd76c0654e75d82637251dc4d12d0e0213` | `42c823ab2fca8037c741a65e27658ee87877c0f01515e7d2faa9fcd684cb3f0a` | ancestor и hash accepted artifact совпали |
| #62 PostgreSQL/idempotency | `56b0e99275573b6bdc2461703b3221c5c678cfa6` | `704a093a2e18fe3de8fe963ab4b56d16fa6670b87de3ac89ee6c06bc59ceab76` | ancestor и hash accepted artifact совпали |
| #119 frontend/recovery | `53753257b22021023f887050669fc964a7998909` | `43a46f611046c36d6212711511192e37d27a48d16c1130692639eaf3d815b1bc` | ancestor и hash accepted artifact совпал |

## Acceptance matrix

| Пункт issue #5 | Реализация | Результат |
|---|---|---|
| Customer owner boundary и schema | Owner-local `CustomerStore`, migrations, grants и database ownership без межвладельческого SQL | **PASS static/live** |
| Runtime wiring | Реальный owner и routes Customer; HTTPS/mTLS clients в двух API roots; shared runtime materialization | **PASS static/live mTLS** |
| Transport trust | TLS 1.3, separate public Edge key/certificate with optional public CA bundle and hostname validation, internal `mtls` listener/client, environment/runtime SPIFFE SAN, certificate validity и fail-closed setup | **PASS static/unit/image/live mTLS** |
| Delegation trust | Active/previous scoped Ed25519 verification sets для edge actor context, API public/internal delegation и Orders caller; no plaintext fallback | **PASS static/SOPS/live** |
| Customer cursor | Ed25519 signer wired from a Customer-only private key and active/previous public keys; `kid`/`iat`/`exp`, max-age, clock-skew, absolute previous-key trust cutoff, unknown-kid, query binding and 2048-character bound enforced | **PASS static/unit/SOPS/live** |
| Customer URL/body limits | Customer cursor 2048, URL budget 8 KiB, body limit 16 KiB; Catalog shared cursor remains 512 | **PASS static/unit** |
| Idempotency/recovery | Transactional owner path, replay-only validation, lost-response path and test-only unknown-COMMIT/restart harness with internal classification log, DB-adapter command evidence and post-error protocol `ROLLBACK` assertion | **PASS live** — atomic rollback, lost response и COMMIT/restart |
| PII/errors | Allowlisted Problem Details and fail-closed invalid-owner responses | **PASS unit/static/live** — capture ждёт completion marker конкретного request |
| Generated contracts/authority | Generated artifacts unchanged and authority/catalog/profile/schema/inventory synchronized | **PASS static** |

## Исправления изолированного production proof

Запуск `--database-proof` воспроизвёл и после исправлений закрыл три дефекта:

1. Вместо строковых placeholders smoke создаёт ephemeral Ed25519 signing keys
   и согласованные active/previous verification sets в scoped tmpfs material.
2. Internal mTLS healthcheck не передаёт IP в TLS SNI, запрещённый Node.js
   26.8.1; CA и SPIFFE verification сохраняются. Public Edge использует hostname. Общий `platform-http` client также опускает SNI для IP; actual loopback mTLS regression воспроизводит исходный `ERR_INVALID_ARG_VALUE` и проходит после исправления.
3. Smoke читает raw HTTP statuses, включая ожидаемый `503`, через
   `readRuntimeHealthStatuses`; production `runRuntimeHealthcheck` по-прежнему
   завершается ошибкой на non-2xx и не скрывает transport/config errors.

Live Customer suite дополнительно воспроизвёл два production дефекта:
маскирование e-mail сохраняло local part целиком; malformed cursor возвращал
`VALIDATION_FAILED`. Исправлены `a***@example.com` и `INVALID_CURSOR` в
Customer и `api-public`; invalid query/URL > 8 KiB сохраняют
`VALIDATION_FAILED`. Existing unit/HTTP regressions и live search прошли.

Финальный production image собран и запущен. Disposable PostgreSQL 17.11:
readiness `200 → 503 → 200`, `/health/live`, `/metrics` и graceful shutdown
проверены. Это foundation readiness proof, а не Customer migration/concurrency/
COMMIT-restart acceptance. Изолированные контейнеры, сети и scoped tmpfs удалены.

Изолированный Customer harness запускает schema перед live tests, использует
реальную migrator role и unsigned high/low PostgreSQL advisory-lock parts.
PII proof ждёт `request completed` именно своего correlation ID; COMMIT replay
выполняется со свежей подписью после 12 секунд (TTL 6 + clock skew 5).
Независимое ревью подтвердило оба исправления, assertions сохранены.

## Commands

| Команда | Результат |
|---|---|
| `pnpm contracts:check-generated` | **PASS** — byte-identical hash `78981da1f7e141913c35fef51d4e5280c3281efcdc3b39423761566f49b67651` |
| `pnpm typecheck` | **PASS** |
| `pnpm lint` | **PASS** |
| `pnpm test:customer-unit` | **PASS** — 9 pass, 0 fail |
| `node --test packages/platform-testing/test/platform-packages.test.mjs` | **PASS** — 30 pass, 0 fail |
| `pnpm contracts:lint` | **PASS** — 11 JSON Schemas, 2 OpenAPI documents |
| `pnpm contracts:breaking` | **PASS** |
| `pnpm contracts:test` | **PASS** — 36 pass, 0 fail |
| `pnpm architecture:check` | **PASS** |
| `node scripts/check-service-catalog.mjs` | **PASS** — 15 runtimes, 29 interactions |
| `node --test --test-name-pattern 'public Edge TLS|configured Edge startup' tests/runtime/lifecycle.test.mjs` | **PASS** — 2 pass, 0 fail; separate public CA/leaf, leaf/wrong-CA/hostname rejection, loopback TCP with `edge.test`, no client service certificate, internal mTLS isolation, configured healthcheck and system-trust path without optional CA |
| `node --test tests/customer/customer-http.test.mjs` | **PASS** — 8 pass, including TTL, absolute previous-key trust cutoff, late previous-key signing and unknown-`kid` cursor checks |
| `node --test packages/platform-testing/test/platform-packages.test.mjs` | **PASS** — 30 pass, including public/internal TLS option split |
| isolated `pnpm --filter @coffee-platform/runtime deploy --prod --legacy` import check | **PASS** — deployed tree resolves `@coffee-platform/runtime/healthcheck` without root-only imports |
| `CI=true node tools/docker-build.mjs --build-arg RUNTIME=edge-gateway --target runtime --load -t coffee-platform-edge-healthcheck:verify .` | **PASS** — final runtime image built; build typecheck/deploy stages passed |
| `docker run --rm --entrypoint node coffee-platform-edge-healthcheck:verify ... import('@coffee-platform/runtime/healthcheck')` | **PASS** — final image healthcheck entrypoint imports; temporary image removed |
| `pnpm authority:check` | **PASS** |
| `pnpm versions:check` | **PASS** |
| `pnpm db:smoke` | **PASS structural only** — `liveDatabase:false`, `realKafka:false` |
| `pnpm test` | **PASS offline + отдельные live gates** — 199 tests: 184 pass, 0 fail, 15 skipped; обязательные live-сценарии проверяются отдельно, пропуски не считаются acceptance |
| `SOPS_AGE_KEY_FILE=/home/yurgusev/.config/sops/age/keys.txt pnpm config:check` | **PASS** — 15 runtimes, development, реальная проверка SOPS MAC |
| `SOPS_AGE_KEY_FILE=/home/yurgusev/.config/sops/age/keys.txt pnpm security:secrets` | **PASS** — полный encrypted inventory и scoped refs |
| `node tools/compose-smoke.mjs --customer-proof --project-name coffee-customer-proof-129n` | **PASS** — тот же набор `test:customer-integration`: normalization 1/1, migrations/grants 3/3, live 11/11; 0 skipped, production image, PostgreSQL 17.11, mTLS; финальный повтор с `--no-build` также проходит; completion marker логов и fresh replay после истечения TTL + clock skew проверены |
| `pnpm test:compose-smoke --recovery-proof --project-name coffee-pr129-full-proof` | **Первый запуск FAIL** — после сборки и healthy 15 runtime возник transient Kafka healthcheck timeout на восстановлении; повтор ниже прошёл |
| `node tools/compose-smoke.mjs --recovery-proof --no-build --keep --project-name coffee-pr129-full-proof` | **PASS / exit 0** — 15 runtime, пять PostgreSQL DB, десять runtime roles; Kafka retention/recreate, ordered/rebalance/quarantine/SIGTERM, DB commit before offset, outbox acknowledgement before finalize, bounded paused-broker unknown outcome/recovery |
| `docker compose … stop --timeout 30` + проверка состояний | **PASS** — все 15 runtime exit 0, Kafka exit 0/143; затем project containers/volumes/network/tmpfs удалены |
| `node --test tests/runtime/lifecycle.test.mjs` | **PASS** — 27/27, включая internal mTLS loopback, raw `503` и strict production rejection |
| `pnpm exec oxlint --type-aware --deny-warnings tools/compose-smoke.mjs tests/runtime/lifecycle.test.mjs packages/platform-runtime/src/healthcheck.ts` | **PASS** |
| `node tools/compose-smoke.mjs --database-proof --project-name coffee-compose-smoke-3080870-a53ae048` | **PASS / exit 0** — production image build, PostgreSQL readiness `200 → 503 → 200`, internal mTLS, live/metrics и graceful shutdown; 1 runtime, Kafka/telemetry/business proof отсутствуют |
| `COFFEE_DB_LIVE_PROOF=1 node --test tests/database/live-db-proof.test.mjs` | **PASS** — 2/2, 0 skipped; disposable PostgreSQL, transactions/idempotency/bootstrap/role isolation, cleanup выполнен |
| `node --test tests/runtime/platform-http.test.mjs` | **PASS** — 4/4; общий HTTPS client дополнительно проверен actual loopback mTLS в lifecycle regression |
| `git diff --check` | **PASS** |

## SOPS provisioning и изоляция proof

SOPS inventory blocker устранён: SOPS 3.13.3 и age 1.3.2 установлены с
проверкой SHA-256 release assets; все required key paths заполнены.
Три новые age identities сохранены в стандартном SOPS каталоге и скопированы
в отдельный recovery-каталог на диске вне репозитория. Оба файла `0600`,
каталоги `0700`; независимый age recovery проверен для всех трёх recipients.
Backup identity успешно проверяет SOPS MAC нового encrypted snapshot.

Все 15 runtime материализованы trusted `config-bootstrap` в tmpfs: exact
scoped refs, mode `0400` и transport environment/runtime identities проверены.
Временные plaintext и scoped файлы удалены. Старые ciphertext/rules сохранены
в recovery-каталоге. Порядок хранения и восстановления закреплён в
[LOCAL_PLATFORM](../docs/platform/LOCAL_PLATFORM.md#постоянные-age-identities-и-резервная-копия-на-этом-сервере).

Независимое ревью подтвердило signing pairs и 45 transport certificates для
трёх окружений; localhost leaf certificates действуют до 2026-12-05.
Внешние AROMA/OIDC/telemetry credentials из исходного fixture остаются
не provisioned; это не доказательство доступа к реальным внешним системам.

Изолированный `--customer-proof` автоматически предоставляет выделенную сеть,
PostgreSQL и необходимые test-only fixtures: `CUSTOMER_DATABASE_URL`, `CUSTOMER_MIGRATOR_DATABASE_URL`,
`CUSTOMER_FOREIGN_DATABASE_URL`, `CUSTOMER_SERVICE_ORIGIN` по HTTPS,
`CUSTOMER_TEST_CLIENT_TRANSPORT_FILE`, `CUSTOMER_TEST_INTERNAL_TRANSPORT_FILE`,
`CUSTOMER_TEST_HEADERS_JSON`, `CUSTOMER_TEST_INTERNAL_HEADERS_JSON`,
`CUSTOMER_TEST_LOG_FILE` и изолированный PostgreSQL observer. Для unknown
COMMIT/restart harness дополнительно нужны
`CUSTOMER_UNKNOWN_COMMIT_CONFIG_FILE`,
`CUSTOMER_UNKNOWN_COMMIT_SECRETS_FILE` mode `0400`,
`CUSTOMER_UNKNOWN_COMMIT_DATABASE_URL`,
`CUSTOMER_UNKNOWN_COMMIT_OBSERVER_DATABASE_URL`,
`CUSTOMER_UNKNOWN_COMMIT_DB_TARGET_HOST`,
`CUSTOMER_UNKNOWN_COMMIT_CLIENT_TRANSPORT_FILE`,
`CUSTOMER_UNKNOWN_COMMIT_HEADERS_JSON`,
`CUSTOMER_UNKNOWN_COMMIT_ACTOR_REF` и
`CUSTOMER_UNKNOWN_COMMIT_SERVICE_ORIGIN` в dedicated network с proxy на
canonical PostgreSQL port `5432`. Harness также требует test-only
`CUSTOMER_UNKNOWN_COMMIT_DB_ADAPTER_LOG_FILE`; он активирует preload только в
дочернем тестовом процессе и фиксирует `BEGIN`/`COMMIT`/`ROLLBACK` без параметров.

Для Edge дополнительно нужен encrypted `edge.tlsCertificate`, matching
`edge.tlsPrivateKey` и hostname `platform.publicBaseUrl`; он не заменяется
внутренним `security.serviceTransportKeys.edge-gateway`. `edge.tlsCaBundle`
остаётся optional: отсутствие означает системное доверие Node.js, наличие
означает явное доверие только указанному public CA bundle; leaf certificate и
internal service CA fallback запрещены.

Canonical SOPS inventory обновлён после разрешённого provisioning. Изолированный Compose использует
собственные ephemeral credentials; Customer business acceptance выполняется отдельным `--customer-proof`.
Восемь пользовательских instruction-файлов, а также появившиеся untracked
`.agents/skills/astra-orchestrator/` и `.codex/` сохраняются и не входят в
commit.

## Расследование SOPS inventory из foundation #3

Источник: локальная история исходной задачи, журнал
`rollout-2026-09-01T14-15-56-01a05c40-f65b-7ea1-b1a9-ac58bbbaa156.jsonl`.
В репозиторий не копируются журнал, plaintext или приватные ключи.

- Строка 234: три age identity созданы в `/tmp/coffee-age-development.key`,
  `/tmp/coffee-age-staging.key`, `/tmp/coffee-age-production.key`.
- Строка 242: все значения трёх окружений заданы статическим тестовым fixture;
  импорта credentials внешних систем в этой команде нет.
- Строки 257/263: fixture зашифрован SOPS и перемещён в canonical inventory;
  commit `7ce3e23d03e3db444e0f92903cc98fd0ea2c4646` добавил 124 encrypted leaves.
- Строки 275/281 и 371–382 подтверждают расшифровку и scoped materialization
  во время исходной реализации, но не постоянное хранение age identity.
- Проверка известных путей 2026-09-06: все три identity отсутствуют, как и
  временный plaintext. В четырёх проверенных implementation/review журналах
  нет `AGE-SECRET-KEY-`; приватные ключи были направлены в файлы.

Найденная история подтверждает тестовое происхождение inventory. Она не
подтверждает резервную копию age keys; восстановление из проверенных журналов
невозможно. Отсутствие иных резервных копий не доказано. Пользователь запретил
перезаписывать ciphertext до расследования, затем разрешил новый provisioning
с резервной копией вне репозитория на диске. Исходный ciphertext сохранён
отдельно; canonical inventory зашифрован новыми identities. Реальные
credentials внешних систем эта история не предоставляет.

## Согласование issue #5

Принятый Customer budget:
`Customer cursor — 2048 символов; Customer URL budget — 8 KiB; Catalog cursor —
512 символов.` Остальные acceptance criteria issue не меняются.

## Remote state

Все обязательные live-сценарии выполнены без пропусков; PR готов к merge в
`develop`. Process state и accepted merge проверяются в GitHub. Self commit SHA
в handoff не записывается. Successors требуют проверки всех своих inputs.
