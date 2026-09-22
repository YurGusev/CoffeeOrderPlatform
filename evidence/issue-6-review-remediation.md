# Issue #6 review remediation — observed local evidence

Date: 2026-09-21. Scope: `feature/6-catalog-batch-ingestion`, uncommitted worktree.
This closes the five supplied review findings and follow-up P2 locally; it is not PR, CI, merge,
deployment, provider access, or #16 activation evidence.

## Observed RED before the corresponding implementation

The excerpts below are from executed commands, not reconstructed test results.
No RED commit was made (commits are not authorized).

| Finding | Command / observed failing assertion |
|---|---|
| 1 — recovery on later ticks | `node --experimental-test-module-mocks tests/catalog/composition-proof.mjs recovery`: `Missing expected rejection: DB loss must block the second export` (exit 1). |
| 2 — truthful readiness | `node --experimental-test-module-mocks tests/catalog/composition-proof.mjs readiness-reject`: `startup recovery and supervisor need a readiness check` (exit 1). |
| 3 — required telemetry | `pnpm test:catalog-stream`: `generation span missing`; 16 pass, 1 fail, 0 skips. |
| 4 — real restart evidence | `pnpm test:catalog-recovery`: `restart must kill a production-composed OS process`; actual `undefined`, expected `SIGKILL`; 0 pass, 1 fail, 0 skips. |
| 5 — framing | `pnpm test:catalog-stream`: `quadratic framing copies: 60637577 bytes for 11012`; 15 pass, 1 fail, 0 skips. |

The persistence pause was already an intended property of the serial importer.
Its new capacity test adds observation rather than claiming a pre-existing
backpressure behavior failure. No old tests or evidence requirements were removed.
During proof development, invalid fixture configuration/schema and lint errors
also failed gates; they were corrected in new proof code, not by weakening the
existing wire validators, database rules, or architecture checker.

## Closure and evidence boundaries

1. **Recovery:** the production `main.ts` callback reconciles on **every** tick,
   before generation creation or HTTP export. The composition regression uses
   the real scheduler with a deterministic clock: unknown first generation,
   DB unavailable on the next tick (no export), then restored DB, old-generation
   rejection, and only then the second export. Recovery failure remains visible
   in scheduler metrics and bounded structured diagnostics.
2. **Readiness:** false until startup recovery finishes; false if the supervisor
   resolves unexpectedly, rejects, or is stopped/destroyed. Import/provider
   failure does not kill a live supervisor. Both supervisor termination modes and
   ordinary provider failure are exercised. The live restart proof additionally
   observes actual HTTP `/health/ready` status **503 → 200** while a PostgreSQL
   lock deliberately delays startup recovery.
3. **Telemetry:** reuse Gateway's existing `@opentelemetry/api` and runtime
   `/metrics`/structured logger pattern. Generation, stream, validation, COPY and
   transaction spans are emitted and ended on success/failure. Batch duration has
   sum/count measurements; stream consumer hold time and COPY source pause time
   measure their respective backpressure boundaries without counting upstream wait
   or setup/settlement. Diagnostics and span attributes carry the allowlisted
   `snapshotRef`, `correlationId` and batch-scoped `batchNumber`; metric labels stay
   fixed to phase/outcome and never contain those identifiers. Batch count/bytes
   count successfully reconciled accepted stream batches (exact replay included),
   not claimed unique durable rows. Import age is monotonic time since the last
   successful generation, or process telemetry startup before any success,
   disambiguated by `has_success`. Tests reject payloads, raw errors, SQL, secrets,
   authorization/key material and high-cardinality metric labels. This verifies
   instrumentation and runtime rendering, **not delivery to an external OTLP
   collector**.
4. **Restart / composition / capacity:**
   - `catalog-runtime-live-proof.mjs` forks `runtime-child.mjs`, which imports the
     unchanged production main/composition and uses the real runtime lifecycle,
     scheduler, recovery, PostgreSQL store, typed InternalApi client, Undici and
     mutual TLS. Only deployment bootstrap/config and DNS are local fixtures;
     `fetch`, scheduler, store and importer are not mocked in this live proof.
   - Local HTTPS fixture responds as `api-internal`; it is **not the deployed
     api-internal service, Gateway or AROMA provider**. It verifies the production
     InternalApiV1 route/body and TLS peer identity. No provider calls occur.
   - Parent observes durable `Receiving/next_batch_number=1`, sends SIGKILL,
     waits for the process exit, then forks a different PID. The old generation
     is `Rejected` before the second HTTP export is served; the new snapshot is
     distinct and becomes `Received`. One standalone observed PID pair was
     **87743 → 87771**; assertions re-observe fresh PIDs on each run.
   - The separate capacity process has a **64 MiB V8 old-space limit**, serial
     importer/real reader with a controlled persistence seam, **3,072 batches**,
     **168,344,938 wire bytes**, and **657,410 fragments of at most 257 bytes**.
     First batch persistence is held for **125 ms**; producer fragment count
     remains unchanged after bounded Readable prefetch settles, and there is
     still only one accepted/uncommitted batch. The gate asserts sampled heap
     growth <48 MiB, RSS growth <96 MiB and external growth <16 MiB. Final dedicated
     run measured **17,462,984 / 33,079,296 / 3,564,534 bytes** respectively.
     This is a synthetic streamed-capacity proof with an instrumented persistence
     seam, **not a full database/provider load benchmark or continuous RSS peak**.
5. **NDJSON:** before accumulation, compare fragment length against remaining
   line budget. Complete lines use views; fragmented lines use one reusable
   max-line-sized slab, copying each fragment once, without full-prefix concat
   or a per-fragment object list. Regressions cover one-byte UTF-8 fragments and
   a small prefix followed by an oversized fragment, plus previous malformed,
   trailing, cancellation and boundary cases.

## Follow-up P2 — complete observability contract

The first remediation added bounded telemetry but omitted the stream span, batch
duration, backpressure measurements and safe correlation fields required by #6.

**RED before production edits:** after TypeScript build, the focused production
wiring test failed with `AssertionError: stream span missing` (1 failed, zero skips).

**GREEN:** `catalog.import.stream`, batch-duration sum/count, stream consumer hold
and COPY source pause measurements are wired through the production importer/store.
`snapshotRef`, `correlationId` and batch-scoped `batchNumber` are present only in
diagnostics/span attributes, not metric labels. `tests/catalog/observability-proof.mjs`
exercises timing boundaries, failure cleanup, context isolation and secret/payload
redaction. The focused test and final `pnpm test:catalog-stream` pass with zero skips.

## Follow-up P2 — bounded production terminal verification

`complete()` previously kept every verified digest in `batchHashes: string[]`
until EOF verification. The existing stream capacity fixture mocked `complete()`
and did not cover this O(batchCount) retention.

**RED before production edits:** after `pnpm exec tsc -b --pretty false`, ran:

```text
node --experimental-test-module-mocks --expose-gc --max-old-space-size=64 tests/catalog/terminal-capacity-proof.mjs
AssertionError [ERR_ASSERTION]: production complete retained heap grew 4475496 bytes after 49153 manifests (limit 4194304)
exitCode: 1
```

The exact captured failing output is `evidence/issue-6-terminal-red.log`. A second
RED, `pnpm test:catalog-ingestion`, failed with
`TypeError: hashes.createCatalogContentHash is not a function` (3 pass, 1 fail,
zero skips) before the shared helper was implemented.

**Implementation:** `aroma-v1` exports `createCatalogContentHash()` and its
accumulator type. It validates each lowercase SHA-256 hex digest, converts it to
32 binary bytes, and updates the same SHA-256 state; `digest()` finalizes once.
The existing array API delegates to this shared authority. Production
`complete()` now keeps this state and the previous batch hash, plus its existing
single bounded manifest/reconstructed batch, not a snapshot-sized hash array.
Verification order, chain/hash checks, durable recounts, guarded transition and
terminal replay semantics are unchanged. Migrations and their original hashes,
provider code, activation/#16 boundary, wire output and golden fixture are unchanged.

**GREEN production-path evidence:** `tests/catalog/terminal-capacity-proof.mjs`
imports the production `createCatalogImportStore`; neither `complete()`, manifest
verification, reconstruction nor the shared hash code is mocked. Only transaction
and SQL execution are replaced by a lazy, fail-closed fixture returning one
manifest/batch at a time. Every batch has a distinct digest. Expected content hash
is independently built with Node crypto over ordered binary digests.

The dedicated stream gate observes **131,072 manifests and 131,072 reconstructions**,
**two recounts**, **one Received transition**, exact terminal replay and conflicting
replay rejection. A 64 MiB old-space subprocess samples post-GC retained heap
at 8,192-batch intervals and after completion, asserting growth **<4,194,304 bytes**.
The observed maximum was **161,296 bytes**; sampled RSS growth was **21,020,672 bytes**
(asserted <67,108,864 bytes). The large count and heap limit reject the old retained
array without substituting a fake `complete()`.
This is a production-terminal memory regression with a synthetic SQL seam, **not
PostgreSQL capacity, provider load, or a continuous allocation/RSS peak proof**.
The separate existing COPY and recovery gates still use real PostgreSQL.

The hash regression checks empty input, multiple digests/order, invalid hex,
finalization and the unchanged golden contentHash:
`a54d94109a18a7024dca3d4e2490f169eee9b0d0d2c442cf2dab1574cdf45fe2`.

The first full `pnpm check` run failed outside Catalog with `DB_POOL_EXHAUSTED`
in `tests/aroma/binding-live.test.mjs` / `runReadinessAndSaturationProof`.
The isolated `node --test tests/aroma/binding-live.test.mjs` passed (1/1, zero skips),
and an exact `pnpm check` rerun passed without source, timeout or skip changes.
The failed attempt is preserved in `issue-6-terminal-checks/check-attempt-1.log`;
the final exact rerun is included in
`issue-6-terminal-checks/final-verification-fail-closed-20260921.log`.
Machine-readable output hashes cover the exact persisted log bytes.

## Final local commands

Machine-readable observed results: `evidence/issue-6-review-checks.json`.

- `pnpm test:catalog-ingestion`: **6/6**, zero skips.
- `pnpm test:catalog-stream`: **21/21**, zero skips.
- `pnpm test:catalog-copy`: **1/1**, real PostgreSQL, zero skips.
- `pnpm test:catalog-recovery`: **1/1**, real PostgreSQL + real process/mTLS,
  zero skips; existing terminal COMMIT ACK loss cases remain.
- `pnpm check`: **PASS**; contracts 39/39; overall **393 tests, 377 passed,
  16 pre-existing opt-in non-Catalog skips**, zero failures.
- `pnpm test:compose-smoke -- --recovery-proof --no-build --project-name
  coffee-issue6-final-observability`: **PASS**. The proof creates disposable
  PostgreSQL/Kafka resources, applies Catalog migrations before startup, routes
  provider DNS exclusively to a generated local HTTPS fixture on a Docker
  `internal: true` network, observes all 15 runtimes plus the fixture healthy,
  exercises PostgreSQL/Kafka/native recovery, and removes the scoped project
  resources. The receipt records `providerFixture.login=1` and
  `providerFixture.catalog=1` with cart/mutation counts at zero; the proof fails
  if Catalog traversal does not reach the fixture. It cannot contact the real
  provider.
- `pnpm db:smoke`: **PASS** (structural/role smoke; not a substitute for Catalog
  live gates).
- `git diff --check`: **PASS**.

All new temporary certificates are worktree-local and removed in `finally`;
child processes, HTTPS sockets and the recovery lock are also cleaned in
`finally`. PostgreSQL harness uses unique `coffee-catalog-*` container/volume
names and removes both in its existing `finally`. No schema/migration content,
checksum-ledger policy, activation/outbox/Kafka implementation, or architecture
checker was changed by this remediation. Final inspection found no `coffee-catalog-*`
or `coffee-issue6-final-observability-*` containers, volumes or networks and no
`.omh/probes` fixtures. No commit/push/PR/merge was performed.

An independent read-only re-review returned **ship** with no actionable findings.
It confirmed that recovery provider egress is fail-closed, the persisted fixture
receipt proves one Catalog request, observability identifiers remain outside metric
labels, and the lazy-SQL terminal-memory limitation remains explicit.

## Дополнение по оставшимся критериям — 22 сентября 2026 года

После следующего независимого review устранены два блокирующих дефекта:

1. Rollback при reconciliation read больше не считается доказательством rollback
   исходного batch. Любая ошибка повторной проверки после
   `TRANSACTION_OUTCOME_UNKNOWN`, кроме явного несовпадения durable
   postcondition, сохраняет `CatalogOutcomeUnknown` и не разрешает запись
   `Rejected`.
2. Ошибка чтения HTTP response body до `started` классифицируется как
   `HTTP_BEFORE_STARTED`; best-effort cancellation при status/content-type
   failure не может перезаписать исходный bounded code своей ошибкой.

Новые regressions сначала падали, затем прошли в
`pnpm test:catalog-stream`: **56 passed, 0 failed, 0 skipped**. Live PostgreSQL
proof сохранил **1 passed, 0 skipped** и фиксирует настоящий COPY cancel/source
error после consumed chunk, post-merge rollback, forward/checksum migrations,
фактические ACL и четыре foreign `CONNECT` denial с SQLSTATE `42501`.

Финальные receipts:

- `evidence/issue-6-terminal-checks/final-verification-20260922.log`, SHA-256
  `914b6910e4a87de4cce6365ebdf018ec0140abc1ca3104bcfe2601cdbde18445`;
- `evidence/issue-6-terminal-checks/compose-recovery-proof-fresh-image-20260922.log`,
  SHA-256 `fcf6813c9ee97ebd2f84af8f9f12e2bf28ed3e646d1641caba5bedaf77b94ab6`;
- `evidence/issue-6-terminal-checks/fresh-image-provenance-20260922.json` —
  SHA-256 `1ac5cdf41582480cc62d3dbc07b434ec299baa02a9aabded796370bdc02110eb`;
  `baseSha=4b2cad1...`, `headSha=2ae6155...`, `dirtyTree=true`, финальный commit
  отсутствует, четыре compiled artifact hash совпадают между host и image.

Recovery proof использовал уникальные свежие image tags из текущего dirty
worktree, локальный HTTPS provider и fail-closed internal provider network. Он
не является production deployment, реальным provider load или доказательством
внешней доставки OTLP.

Первый независимый evidence review обнаружил оставшийся после прерванного build
tmpfs fixture directory и потенциальную утечку anonymous Kafka volume при
recreation. Точный tmpfs directory удалён только после проверки отсутствия
mount/process references. В `tools/compose-smoke.mjs` добавлен
`docker compose rm --volumes`, его regression сначала RED, затем **9/9 GREEN**.
Повторный recovery proof прошёл; после teardown наблюдались ноль project
containers/volumes/networks, ноль `coffee-platform-secrets-*` directories и
ноль dangling volumes из окна proof.

Повторная независимая cleanup-проверка обнаружила один generated Compose
override от прерванного первого запуска. Перед удалением точного файла
подтверждены ноль process references и ноль container mount references;
после удаления matching project override files также равны нулю. Остальные
проверенные evidence/handoff hashes совпали; runtime findings отсутствовали.
