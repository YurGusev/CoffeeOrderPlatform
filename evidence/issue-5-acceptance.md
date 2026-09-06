# Issue #5 — acceptance evidence

Статус: **не принято / blocked**. Это фактическая матрица локальной ветки, а
не merge/accepted handoff. Проверка выполнена 2026-09-06 в
`feature/5-customer-service`; GitHub issue/PR не изменялись.

После review r1 добавлены общий generated runtime-schema путь, безопасная
нормализация owner errors, Customer Store boundary и fail-closed signed cursor.
После review r2 добавлены HTTP parameter decoding, framework/parser Problem
mapping, compact Ed25519 cursor representation и передача replay marker из Store
через owner adapter. После review r3 compressed cursor representation проверена
на повторяющемся 200-символьном Unicode sort tuple, а tampering regression
проверяет подпись на синтаксически допустимом изменённом payload. Review r4
показал, что deflate не даёт worst-case гарантии: допустимое слабо сжимаемое
200-символьное имя даёт 889-символьный signed cursor и `INVALID_CURSOR`.
После review r4 явно разрешён вариант 1: Customer cursor и response `nextCursor`
увеличены до 2048, Customer URL budget до 8 KiB, Catalog cursor оставлен 512,
а compression удалён. Production trust materialization и live PostgreSQL
остаются отдельными blockers.
По acceptance review PR #129 обязательные live-gates усилены: missing trust/log
fixtures теперь дают mandatory blocker, foreign-database check проверяет отказ
на CONNECT, а live fixtures покрывают fault после каждой required DB write,
lost response во время COMMIT и abort после начала Customer INSERT. Эти сценарии
добавлены, но не исполнены без approved live environment.

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

| Пункт issue #5 | Реализация | Проверка | Результат |
|---|---|---|---|
| Customer owner boundary | Owner-local `CustomerStore` owns transactions/idempotency/search/order-input; `CustomerRepository` owns SQL statements через `database/owner` | `pnpm architecture:check`, `pnpm config:check`, review imports/SQL | **PASS static; live grants pending** |
| Exact schema/migrations | `0001_customer_schema.sql` и `0002_customer_indexes.sql`: tables, checks, FK, partial unique indexes, grants | `pnpm db:smoke` только structural; `customer-schema.test.mjs` | **PARTIAL** — `CUSTOMER_MIGRATOR_DATABASE_URL`/runtime DB отсутствуют |
| Runtime wiring | `customer-service/src/main.ts` создаёт реальный owner и регистрирует routes; API roots создают HTTP clients и configured adapters | `pnpm typecheck`, `pnpm test`, `pnpm architecture:check` | **PASS code/static; trust integration pending** |
| Transport trust | Delegation signatures/claims проверяются; transport functions fail-closed | code review; no scoped mTLS certificate/trust callback in foundation | **BLOCKED** — без foundation materialization нельзя доказать requests |
| Normalization | NFC/whitespace/name, `libphonenumber-js@1.13.12` RU parsing, E.164, IDN email, normalized address | `tests/customer/customer-normalization.test.mjs`; `pnpm versions:check` | **PASS local unit** |
| `POST /api/client-v1/customers` | Generated OpenAPI runtime schemas, cross-field recovery validation, 16 KiB body limit, owner transaction, Customer/Address/audit/Completed path | `pnpm test:customer-unit`; live create/fault tests | **PARTIAL** — live PostgreSQL blocked |
| Idempotency/recovery | `(actor, scope, key)`, normalized hash, 30s lease, no expired takeover, read-only replay-only, no replay marker on lookup errors; live fixtures cover every write fault and lost response during COMMIT with bodyless same-key recovery | `pnpm test`; live Customer tests | **PARTIAL** — live PostgreSQL proof blocked |
| Search | exact phone/email, escaped name prefix, keyset cursor, bounded limit, decoded HTTP limit, full canonical signed cursor, masked contacts | signed/tamper, 2049-character rejection, adversarial two-page 200-character Unicode Ed25519 HTTP regression and 8 KiB URL guard in `pnpm test:customer-unit`; live search test | **PARTIAL** — Customer cursor contract is 2048/8 KiB; Customer-scoped signing key/adapter is absent from accepted scoped config; Catalog remains on shared 512 cursor |
| Private order-input | Minimal `customerRef/customerVersion/displayName/state`; no contacts/address | code/schema; live internal delegation test | **PARTIAL** — live trust/database blocked |
| API-root adapters | Typed Customer operations only; API public signs actor delegation, API internal signs service delegation and forwards via HTTP; bodyless recovery, decoded limits, parser/body-limit, permission and error tests use real Fastify | `pnpm test:customer-unit`, `pnpm typecheck`, `pnpm architecture:check`; live route test | **PARTIAL** — mTLS transport remains fail-closed |
| Errors/PII | RFC problem mapping, fixed allowlisted owner errors, no raw DB/cause/canary in response, replay response validation | `pnpm test:customer-unit`; mandatory customer PII/log test | **PARTIAL** — live service and `CUSTOMER_TEST_LOG_FILE` are mandatory blockers |
| Generated contracts | OpenAPI-generated runtime schemas drive route and stored-response validation; owner rows use local JSON Schemas | `pnpm contracts:check-generated`, `pnpm contracts:test`, `pnpm architecture:check` | **PASS static** |

## Commands

| Команда | Результат |
|---|---|
| `pnpm contracts:check-generated` | **PASS** — byte-identical hash `78981da1f7e141913c35fef51d4e5280c3281efcdc3b39423761566f49b67651` |
| `pnpm typecheck` | **PASS** |
| `pnpm lint` | **PASS** |
| `pnpm test:customer-unit` | **PASS** — 9 tests: 9 pass, 0 fail |
| `pnpm test` | **PASS** — 195 tests: 181 pass, 0 fail, 14 skipped; Customer live/schema remain skipped outside mandatory mode |
| `r4` adversarial Unicode cursor reproduction | **RESOLVED** — full canonical signed cursor for the accepted 200-character name fits in the approved 2048 limit and paginates over HTTP |
| `pnpm test:customer-integration` | **BLOCKED / non-zero by design** — 14 tests: 1 pass, 13 explicit prerequisite blockers, 0 skipped; live PostgreSQL/service/log fixture отсутствуют |
| `pnpm contracts:lint` | **PASS** — 11 JSON Schemas, 2 OpenAPI documents |
| `pnpm contracts:breaking` | **PASS** |
| `pnpm contracts:test` | **PASS** — 36 pass, 0 fail |
| `pnpm architecture:check` | **PASS** |
| `pnpm db:smoke` | **PASS structural only** — `liveDatabase:false`, `realKafka:false`; это не live PostgreSQL proof |
| `pnpm security:secrets` | **PASS** — encrypted repository leaves/runtime scopes accepted |
| `pnpm test:compose-smoke` | **BLOCKED** — exit 1: `SOPS_AGE_KEY_FILE` отсутствует; default smoke не запускал decrypted topology |
| `pnpm authority:check` | **PASS** |
| `pnpm versions:check` | **PASS** — exact Node/TypeScript/toolchain pins, включая `libphonenumber-js@1.13.12` |
| `pnpm config:check` | **PASS** |
| `git diff --check` | **PASS** |

## Explicit limitations

- Не доступны `CUSTOMER_DATABASE_URL`, `CUSTOMER_MIGRATOR_DATABASE_URL`,
  `CUSTOMER_FOREIGN_DATABASE_URL` и запущенный `customer-service`; поэтому не
  доказаны реальные PostgreSQL 17.11 migrations/GRANT, concurrency,
  fault-injection rollback после каждой write, lost response/COMMIT recovery,
  abort после начала DB work и PII log canary.
- `SOPS_AGE_KEY_FILE` и команда `sops` отсутствуют в окружении; compose smoke
  с реальными scoped secrets не выполнен.
- В принятом config/service-catalog нет Customer-scoped cursor signing key и
  общего mTLS request transport verifier; secretRefs также не materialize
  `security.delegationVerificationKeys.*`,
  `security.actorContextEdgeVerificationPublicKey` или
  `security.serviceVerificationKeys.orders-service`. Customer не создаёт замену
  этим foundation capabilities и fail-closes; production transport остаётся
  `verifyTransport: () => false` до принятого foundation handoff.
- `pnpm test:customer-integration` теперь намеренно завершается non-zero при
  отсутствии live prerequisites; в обязательном запуске получено 14 тестов,
  13 explicit `BLOCKER` и 0 skipped, поэтому недоступное окружение не выглядит
  как успешный integration gate.
- Public contract для Customer cursor теперь явно расширен до 2048, URL budget —
  до 8 KiB; Catalog использует отдельный `Cursor` и сохраняет 512. Для
  консервативной JSON-escaping верхней границы 200 UTF-16 units расчёт даёт
  1301 payload bytes + 1735 base64url payload + 86 Ed25519 signature = 1821,
  то есть запас до 2048 сохраняется.
- Commit/PR/merge/issue checkbox не являются evidence этой матрицы. Merge и
  закрытие issue #5 не выполнялись.

## Remote state

Issue #5 оставлена `OPEN`. Push, PR, GitHub checkbox mutation, merge и closure
не выполнялись.
