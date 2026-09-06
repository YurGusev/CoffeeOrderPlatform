# Issue #5 — acceptance evidence

Статус: **не принято / blocked**. Это фактическая матрица ветки
`feature/5-customer-service`, а не merge/accepted handoff. Проверка выполнена
2026-09-06. Merge, auto-merge, закрытие issue #5 и deployment не выполнялись.

В этом продолжении добавлены общий mTLS foundation с TLS 1.3, SPIFFE SAN и
fail-closed peer verification, явный `public-tls` Edge listener и `mtls` для
внутренних runtime, production wiring `api-public`, `api-internal` и
`customer-service`, scoped delegation verification key sets, отдельный
Customer cursor key/policy, production-safe runtime healthcheck и test-only
unknown-COMMIT/restart harness. Production secret source намеренно не изменён:
SOPS credentials и age key в окружении отсутствуют.

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
| Customer owner boundary и schema | Owner-local `CustomerStore`, migrations, grants и database ownership без межвладельческого SQL | **PASS static; live grants pending** |
| Runtime wiring | Реальный owner и routes Customer; HTTPS/mTLS clients в двух API roots; shared runtime materialization | **PASS code/static; live trust pending** |
| Transport trust | TLS 1.3, separate public Edge key/certificate with CA+hostname validation, internal `mtls` listener/client, environment/runtime SPIFFE SAN, certificate validity и fail-closed setup | **PASS static/unit; blocked live** — scoped certificates не materialized |
| Delegation trust | Active/previous scoped Ed25519 verification sets для edge actor context, API public/internal delegation и Orders caller; no plaintext fallback | **PASS static; blocked live** — encrypted key inventory не provisioned |
| Customer cursor | Ed25519 signer wired from a Customer-only private key and active/previous public keys; `kid`/`iat`/`exp`, max-age, clock-skew, absolute previous-key trust cutoff, unknown-kid, query binding and 2048-character bound enforced | **PASS static/unit; blocked live** — keys absent in SOPS source |
| Customer URL/body limits | Customer cursor 2048, URL budget 8 KiB, body limit 16 KiB; Catalog shared cursor remains 512 | **PASS static/unit** |
| Idempotency/recovery | Transactional owner path, replay-only validation, lost-response path and test-only unknown-COMMIT/restart harness with internal classification log, DB-adapter command evidence and post-error protocol `ROLLBACK` assertion | **PARTIAL** — mandatory PostgreSQL and restart environment absent |
| PII/errors | Allowlisted Problem Details and fail-closed invalid-owner responses | **PASS unit/static; live log proof pending** |
| Generated contracts/authority | Generated artifacts unchanged and authority/catalog/profile/schema/inventory synchronized | **PASS static** |

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
| `node --test --test-name-pattern 'public Edge TLS|configured Edge startup' tests/runtime/lifecycle.test.mjs` | **PASS** — configured Edge startup and production healthcheck use separate public material with hostname validation |
| `node --test tests/customer/customer-http.test.mjs` | **PASS** — 8 pass, including TTL, absolute previous-key trust cutoff, late previous-key signing and unknown-`kid` cursor checks |
| `node --test packages/platform-testing/test/platform-packages.test.mjs` | **PASS** — 30 pass, including public/internal TLS option split |
| isolated `pnpm --filter @coffee-platform/edge-gateway deploy --prod --legacy` import check | **PASS** — deployed tree resolves `@coffee-platform/runtime/healthcheck` without root-only imports |
| `pnpm authority:check` | **PASS** |
| `pnpm versions:check` | **PASS** |
| `pnpm db:smoke` | **PASS structural only** — `liveDatabase:false`, `realKafka:false` |
| `pnpm test` | **BLOCKED** — 199 tests: 182 pass, 2 fail из-за canonical SOPS inventory и 15 skipped |
| `pnpm config:check` | **BLOCKED** — `CONFIG-SCHEMA`: encrypted source lacks new required key paths |
| `pnpm security:secrets` | **BLOCKED** — same missing encrypted inventory |
| `pnpm test:customer-integration` | **BLOCKED / exit 1 by design** — 15 tests: 1 pass, 14 explicit blockers, 0 skipped |
| `pnpm test:compose-smoke` | **BLOCKED** — `SOPS_AGE_KEY_FILE` and `sops` unavailable |
| `node tools/compose-smoke.mjs --stub-secrets --no-build` | **BLOCKED** — ephemeral public/mTLS materialization reached Compose, but required local runtime images are absent; no live evidence claimed |
| `git diff --check` | **PASS** |

## Exact blockers and required action

`sops` не установлен и `SOPS_AGE_KEY_FILE` отсутствует. В каждом из
`development`, `staging` и `production` encrypted source сейчас отсутствуют:

- `edge.tlsCertificate`;
- `security.actorContextEdgeVerificationPublicKeys`;
- `security.customerCursorSigningPrivateKey`;
- `security.customerCursorVerificationPublicKeys`;
- `security.delegationVerificationKeys.api-public`;
- `security.delegationVerificationKeys.api-internal`;
- `security.serviceVerificationKeys.orders-service`.

Уполномоченному владельцу secrets нужно provision/rotate эти значения через
repository `.sops.yaml` с настоящим age key, не помещая plaintext в PR. Также
нужно подтвердить для каждого runtime валидный encrypted
`security.serviceTransportKeys.<runtime>` envelope с `keyPem`, `certPem`,
`caPem`, SAN `spiffe://coffee-platform/<environment>/<runtime>` и
`serverAuth,clientAuth`; config-bootstrap должен materialize только scoped
файл mode `0400` в tmpfs.

Для обязательных live gates нужна выделенная тестовая сеть/сервис и реальные
fixtures: `CUSTOMER_DATABASE_URL`, `CUSTOMER_MIGRATOR_DATABASE_URL`,
`CUSTOMER_FOREIGN_DATABASE_URL`, `CUSTOMER_SERVICE_ORIGIN` по HTTPS,
`CUSTOMER_TEST_CLIENT_TRANSPORT_FILE`, `CUSTOMER_TEST_INTERNAL_TRANSPORT_FILE`,
`CUSTOMER_TEST_HEADERS_JSON`, `CUSTOMER_TEST_INTERNAL_HEADERS_JSON`,
`CUSTOMER_TEST_LOG_FILE` и изолированный PostgreSQL observer. Для unknown
COMMIT/restart harness дополнительно нужны
`CUSTOMER_UNKNOWN_COMMIT_CONFIG_FILE`,
`CUSTOMER_UNKNOWN_COMMIT_SECRETS_FILE` mode `0400`,
`CUSTOMER_UNKNOWN_COMMIT_DATABASE_URL`,
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
внутренним `security.serviceTransportKeys.edge-gateway`.

Эти prerequisites не подменялись фиктивными credentials или live evidence.
Восемь пользовательских файлов и их uncommitted изменения сохраняются и не
входят в commit.

## Remote state

Issue #5 остаётся `OPEN`; PR #129 остаётся open/blocked. Продолжение зафиксировано
коммитом `0b37ad4` и отправлено в `feature/5-customer-service`; merge, auto-merge,
issue checkbox mutation и closure не выполнялись.
