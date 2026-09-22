# Issue #6 — acceptance evidence

Base: `origin/develop@4b2cad1dab30af66ad0b2fe64da280222e506574`; branch `feature/6-catalog-batch-ingestion`. No commit, push, PR or merge was performed. No real AROMA request or mutation was made.

## Delivered boundary

- Exactly three Catalog migrations create the six issue-owned permanent staging tables. Catalog import grants cover those tables; TEMP-table creation is owner-only and permanent DDL is denied to `coffee_catalog_import_rw`.
- Shared `aroma-v1` canonical JSON/SHA-256 helpers and golden vectors are used by Gateway and importer. Missing optional properties remain distinct from JSON `[]`; money remains decimal-string text.
- The importer creates `Created` before HTTP, enforces one total import deadline, validates generated InternalApiV1 NDJSON records, and waits for clean EOF before `Received`. Terminal verification rechecks durable ordinals/counts batch-by-batch before a short guarded transition.
- Exact batch replay is checked under the generation lock before expected sequence; a conflicting replay durably rejects `Receiving` with `BATCH_HASH_CONFLICT` without downgrading terminal generations. Create, started, new or earlier replayed batch, Received and rejection unknown-COMMIT outcomes use exact operation-specific durable rereads. A lost successful terminal acknowledgement does not re-export or downgrade `Received`; a known-not-committed transition is closed as a known failure rather than mislabeled `OutcomeUnknown`.
- The TEMP-table capability checks table, column and SQL type descriptors at runtime, not only through TypeScript. Provider `snapshot-failed` records are durably rejected after clean EOF and surface as failed scheduler runs.
- Recovery precedes every export and rejects incomplete generations honestly; DB failure blocks export, and each later traversal uses a new `snapshotRef`. Readiness requires completed startup recovery and a live scheduler supervisor. The monotonic 3,600,000 ms scheduler is startup-immediate, single-flight and skip-not-queue.
- #16 receives only `Received` staging, reconstruction rules, contract/hash helpers and vectors. No active tables, activation, events, new HTTP endpoint, cross-app runtime import or foreign-service mutation was added.

## RED evidence captured before implementation

Each command exited `1`, with zero skips:

- `pnpm test:catalog-ingestion` — `ERR_MODULE_NOT_FOUND` for `@coffee-platform/contracts-aroma-v1`.
- `pnpm test:catalog-stream` — missing `apps/catalog-supplier-sync/dist/ndjson-reader.js`.
- `pnpm test:catalog-copy` — missing shared contract package/live proof.
- `pnpm test:catalog-recovery` — missing `scripts/catalog-recovery-live-proof.mjs`.

## Review remediation (2026-09-21)

All five supplied findings, the residual observability P2 and the follow-up
terminal-memory P2 have local code/test/evidence closure in
`evidence/issue-6-review-remediation.md`; fresh command receipts are in
`evidence/issue-6-review-checks.json`. That report records review-specific RED,
real SIGKILL/restart through production composition and mTLS InternalApi fixture,
503→200 readiness, stream/generation/validation/COPY/transaction spans, safe
correlation fields, batch-duration and stream/COPY backpressure measurements,
linear framing, and the large
fragmented stream/persistence-delay proof, plus production `complete()` verification
of 131,072 distinct batch manifests under a 4 MiB retained-heap-growth limit.
The latter runs the real store with lazy SQL fixtures (not PostgreSQL capacity);
its observed peak retained growth was 161,296 bytes, and its pre-fix RED is preserved.
The HTTPS fixture is not the deployed
api-internal, Gateway or provider; the capacity test uses a controlled persistence
seam, not a full database/provider load benchmark. These explicit boundaries
supersede any broader restart/load interpretation of prior evidence.

## Final Catalog gates

Final post-edit runs produced these observed results:

- `pnpm test:catalog-ingestion`: 6 passed, 0 failed, **0 skipped**;
- `pnpm test:catalog-stream`: 21 passed, 0 failed, **0 skipped**;
- `pnpm test:catalog-copy`: disposable PostgreSQL COPY/migration/reconstruction gate, 1 passed, 0 failed, **0 skipped**;
- `pnpm test:catalog-recovery`: disposable PostgreSQL recovery/ack-loss gate, 1 passed, 0 failed, **0 skipped**;
- `pnpm lint` and `pnpm typecheck`: exit 0.

The live gates started PostgreSQL `17.11` in uniquely named disposable containers, exercised the real migration runner and runtime role through `@coffee-platform/database`, and removed containers in `finally`. Recovery dropped each create/started/batch/terminal/reject `COMMIT` acknowledgement through the repository TCP blackhole proxy and reconciled by durable owner-local reread. The terminal fault is armed on the fourth `COMMIT`, independently observes durable `Received` before reconciliation, and proves no re-export; an earlier-batch replay ACK loss remains `Receiving` at the already advanced `next_batch_number`. Terminal negatives prove durable ordinal and independently recounted-row tampering cannot reach `Received`. Fixtures crossed the typed InternalApiV1 client boundary. No Catalog live gate has a prerequisite skip path.

## Repository gates

Fresh observed results:

- `pnpm check` — PASS: authority, toolchain/Node 26 compatibility, config, contract lint/generation/breaking/tests, architecture, rule parity, lint, typecheck and the 393-test repository suite.
- `pnpm contracts:check-generated` — PASS, byte-identical digest `f6ff9ea5c04796695f1e8c2aafb20950950ea739596a93f5bb533b6bab92102e`.
- `pnpm config:check` — PASS, 15 runtimes.
- `pnpm architecture:check` — PASS with Dependency Cruiser 18.2.0.
- `pnpm typecheck` — PASS.
- `pnpm lint` — PASS with deny-warnings.
- `pnpm test` — PASS: 393 tests, 377 passed, 0 failed, 16 skipped.
- `pnpm db:smoke` — PASS: 5 database configs and 15 services validated.
- `git diff --check` — PASS.

The first `pnpm check` attempt failed in the unrelated AROMA binding saturation
proof (`DB_POOL_EXHAUSTED`); its isolated rerun and exact full-check rerun passed
without code or timeout changes. The failed receipt remains recorded.

The 16 global skips are unrelated pre-existing live lanes: one AROMA journal live test, one database foundation live test, and fourteen Customer live tests requiring scoped database, mTLS, log or unknown-COMMIT fixtures. The four Catalog gates report zero skips.

## Mandatory Compose proof

`pnpm test:compose-smoke -- --recovery-proof --no-build --project-name
coffee-issue6-final-observability` passed. The proof created disposable PostgreSQL
and Kafka resources, applied the three Catalog migrations before runtime startup,
started all 15 runtimes plus a generated local HTTPS provider fixture, and observed
them healthy. It exercised database/Kafka/native recovery and graceful shutdown,
then removed the scoped containers, volumes, networks, tmpfs secrets and fixture.
Provider DNS was bound only to the local fixture on a Docker `internal: true`
network, so public provider egress was impossible. The receipt observed one login
and one Catalog request at the fixture, with cart and mutation counts at zero; no
real AROMA request or mutation was made. This supersedes the earlier missing-SOPS
and bounded `--stub-secrets` attempts, whose timeout alone was not accepted as
proof of an external-only blocker.

## Дополнительное закрытие критериев 22 сентября 2026 года

- `failure_code` принимает только закрытый набор безопасных кодов. Ошибки схемы,
  порядка, batch gap/chain, source identity, terminal counts/hash и provider
  terminal code остаются различимыми; SQL, `Error.message` и тело ответа
  провайдера не сохраняются.
- `DB_QUERY_FAILED` становится `IMPORT_DB_ROLLED_BACK` только после наблюдённого
  успешного `ROLLBACK`. Перед terminal `Rejected` выполняется guarded reread.
  Потеря соединения, неизвестный `COMMIT`/`ROLLBACK` и ошибка reconciliation read
  сохраняют неопределённый исход и не разрешают terminal write.
- HTTP status/content-type errors и отказ чтения response body до `started` дают
  только `HTTP_BEFORE_STARTED`. Ошибка best-effort `body.cancel()` не заменяет
  исходный безопасный transport code.
- Live PostgreSQL proof вызывает cancellation и source error после первого
  полученного COPY chunk, проверяет уничтожение source, пригодность pool и
  неизменность шести таблиц. Post-merge сценарий наблюдает четыре merge и
  SQLSTATE `42501` на manifest insert, затем подтверждает полный rollback.
- Migration proof применяет `0001`, затем вперёд `0002`/`0003`, сохраняет
  `Created`, `Receiving`, `Received`, `Rejected`, подтверждает repeat no-op и
  `MIGRATION_CHECKSUM_DRIFT`. Checksummed migrations не менялись.
- ACL proof входит настоящей `coffee_catalog_import_rw`: TEMP разрешён, девять
  запрещённых операций возвращают `42501`. Foreign database denial доказан не
  structural планом `pnpm db:smoke`, а четырьмя фактическими `Client.connect()`
  к чужим БД; каждый отказ вернул `42501`.
- Существующий architecture checker проверяет пять importer-specific
  запрещённых направлений и разрешённые package imports.

Receipt `evidence/issue-6-terminal-checks/final-verification-20260922.log`
фиксирует Catalog `9/56/1/1`, architecture `42`, repository
`437 total / 421 passed / 0 failed / 16` существующих opt-in skips, а также
успешные `pnpm check`, `pnpm db:smoke` и `git diff --check`. `pnpm db:smoke`
учитывается только как structural smoke; proof foreign `CONNECT` находится в
live Catalog harness того же receipt.

Fresh-image receipt
`evidence/issue-6-terminal-checks/fresh-image-provenance-20260922.json` записывает
base SHA, текущий HEAD только как базу незакоммиченного diff, `dirtyTree=true`,
отсутствие финального implementation commit и SHA-256 parity четырёх реально
собранных host/image artifacts. Recovery proof на 15 уникальных image tags
прошёл с fixture `login=1`, `catalog=1`, `cart/post/put/delete=0`.
После исправления Kafka recreation удаляет anonymous image volume через
`docker compose rm --volumes`; финальная проверка обнаружила ноль project
containers/volumes/networks, tmpfs fixture directories, generated project
override files и соответствующих dangling anonymous volumes.

## Rollback

Before publication, remove only this worktree/branch and issue-owned disposable containers. After migration application, use forward correction; do not rewrite checksummed migrations.
