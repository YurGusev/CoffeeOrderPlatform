# Issue #5 — acceptance evidence

Статус: **не принято / blocked**. Это фактическая матрица локальной ветки, а
не merge/accepted handoff. Проверка выполнена 2026-09-05 в
`feature/5-customer-service`; GitHub issue/PR не изменялись.

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
| Customer owner boundary | Owner-local `CustomerRepository`, SQL statements через `database/owner`, Customer-only dependencies | `pnpm architecture:check`, `pnpm config:check`, review imports/SQL | **PASS static; live grants pending** |
| Exact schema/migrations | `0001_customer_schema.sql` и `0002_customer_indexes.sql`: tables, checks, FK, partial unique indexes, grants | `pnpm db:smoke` только structural; `customer-schema.test.mjs` | **PARTIAL** — `CUSTOMER_MIGRATOR_DATABASE_URL`/runtime DB отсутствуют |
| Runtime wiring | `customer-service/src/main.ts` создаёт реальный owner и регистрирует routes; API roots создают HTTP clients и real configured adapters | `pnpm typecheck`, `pnpm test`, `pnpm architecture:check` | **PASS code/static** |
| Transport trust | Delegation signatures/claims проверяются; transport functions fail-closed | code review; no scoped mTLS certificate/trust callback in foundation | **BLOCKED** — без foundation materialization нельзя доказать requests |
| Normalization | NFC/whitespace/name, `libphonenumber-js@1.13.12` RU parsing, E.164, IDN email, normalized address | `tests/customer/customer-normalization.test.mjs`; `pnpm versions:check` | **PASS local unit** |
| `POST /api/client-v1/customers` | Exact body/response JSON schemas, validation, owner transaction, Customer/Address/audit/Completed path | full test baseline; live create/fault tests | **PARTIAL** — live PostgreSQL blocked |
| Idempotency/recovery | `(actor, scope, key)`, normalized hash, 30s lease, no expired takeover, read-only replay-only, no replay marker on lookup errors | `pnpm test`; live Customer tests | **PARTIAL** — live commit/reconnect/replay proof blocked |
| Search | exact phone/email, escaped name prefix, keyset cursor, bounded limit, masked contacts | unit/domain code and full test baseline | **PARTIAL** — cursor is canonical base64url/query-bound, but issue requires cryptographic signing; Customer cursor key/adapter is absent from accepted scoped config |
| Private order-input | Minimal `customerRef/customerVersion/displayName/state`; no contacts/address | code/schema; live internal delegation test | **PARTIAL** — live trust/database blocked |
| API-root adapters | Typed Customer operations only; API public signs actor delegation, API internal signs service delegation and forwards via HTTP | `pnpm typecheck`, `pnpm architecture:check`; live route test | **PARTIAL** — mTLS transport remains fail-closed |
| Errors/PII | RFC problem mapping, no raw DB/cause in response, runtime structured logging path, replay response validation | `pnpm test`; customer PII test is skipped without service | **PARTIAL** — live canary/log evidence pending |
| Generated contracts | Existing OpenAPI/generated artifacts unchanged and route schemas mirror Customer DTOs | `pnpm contracts:check-generated`, `pnpm contracts:test` | **PASS** |

## Commands

| Команда | Результат |
|---|---|
| `pnpm contracts:check-generated` | **PASS** — byte-identical hash `7e9ee4e0780e17e211275d736442e165d6ee5df4b7f5ff33b0ddbbe4f8656efd` |
| `pnpm typecheck` | **PASS** |
| `pnpm lint` | **PASS** |
| `pnpm test` | **PASS** — 184 tests: 172 pass, 0 fail, 12 skipped; Customer live/schema skips из-за окружения |
| `pnpm test:customer-integration` | **PASS process, incomplete evidence** — 12 tests: 1 pass, 0 fail, 11 blocked/skipped |
| `pnpm contracts:test` | **PASS** — 35 pass, 0 fail |
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
  fault-injection rollback, unknown commit, abort DB work и PII log canary.
- `SOPS_AGE_KEY_FILE` и команда `sops` отсутствуют в окружении; compose smoke
  с реальными scoped secrets не выполнен.
- В принятом config/service-catalog нет Customer-scoped cursor signing key и
  общего mTLS request transport verifier; Customer не создаёт замену этим
  foundation capabilities и fail-closes.
- Commit/PR/merge/issue checkbox не являются evidence этой матрицы. Merge и
  закрытие issue #5 не выполнялись.

## Remote state

Issue #5 оставлена `OPEN`. Push, PR, GitHub checkbox mutation, merge и closure
не выполнялись.
