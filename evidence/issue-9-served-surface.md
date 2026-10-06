# Served-surface evidence #9 — локальная проверка

Дата: 6 октября 2026. Baseline: `3e82493ace561a3320b7b94c0b69ab5f32131bea`.
Исходная ветка runtime/review receipts: `test/9-served-surface-evidence`;
на момент этих проверок изменения были **uncommitted/unmerged**.
Публикация оформляется отдельным follow-up [#173](https://github.com/YurGusev/CoffeeOrderPlatform/issues/173)
в ветке `fix/173-served-surface-evidence` от того же baseline. Runtime source
fingerprints ниже совпадают; переименование ветки не является новым runtime proof.
Это новый receipt конкретного diff, не повторная приёмка неизменённого #172.
Исторический `evidence/handoffs/issue-9.yaml` и канонические revision roots не изменены.

## Проверенный путь

Настоящая собранная SPA → pinned native nginx → production Edge configured
routes/authorizer и API-public receiver; upstream mTLS, SPIFFE SAN, actor signature,
audience/operation/correlation проверяются настоящими production механизмами.
Business owners и crypto OIDC — явно изолированные fixtures, не PostgreSQL,
live IdP или провайдер. Served branch не использует Vite preview/route.fulfill/echo API.
Browser принимает self-signed public TLS fixture через `ignoreHTTPSErrors`; это не
проверка production browser CA trust. Upstream mTLS/SPIFFE/signature checks при этом
не отключаются и выполняются production receiver/authorizer.

## Три причинных исправления

1. Default-clock session expiry округляется вниз на создании authority session,
   чтобы Temporal получал integer и абсолютная жизнь не продлевалась.
   Fractional-clock regression: RED exit 1 → GREEN exit 0; полный Edge auth PASS.
2. Default/configured API ingress — только `edge-nginx`, без эвристики по Node
   `config.services`, где native nginx закономерно отсутствует. Real-config RED exit 1
   → Customer HTTP GREEN exit 0; legacy ingress остаётся запрещён.
3. После fatal Order GET 403/404 older successful GET не снимает барьер,
   даже когда monotonic cache остаётся прежним. Допустимый равный GET снимает
   барьер, включая возврат прежнего object identity. Запоздалая mutation не подтверждает доступ.
   Первичный independent review выявил BLOCK R1; native older GET RED exit 1
   → GREEN exit 0. Older и equal-divergent сценарии сохранены отдельно.

## Наблюдаемый итог

`WEB_SERVED_EVIDENCE=/home/yurgusev/.hermes/cache/scratch/issue9-served-surface-20261006/parent-accepted-candidate/native pnpm test:web-served-surface` — **exit 0**,
**26/26 PASS**, source hashes не изменились во время прогона.
Keyboard-only Customer → Draft → Catalog → Quote → quantity/save → Confirm/reconcile;
четыре deep links/reload, immutable assets/no SPA fallback, native Back и permission
403/privacy/503, conflict без повторной команды, late mutation, оба fatal statuses
с последующими 503/divergent/older responses и допустимым восстановлением,
session switch, реальный logout/CSRF/401 и отдельный controlled expiry.

Default-clock login не заменялся injected clock. Только отдельный expiry scenario
использует authority `now` seam; wall-clock/live IdP expiry этим не доказан.

| Команда после финального guard | Результат |
|---|---|
| `pnpm test:web-queries` | exit 0 |
| `WEB_OPERATOR_PORT=4177 pnpm test:web-operator` | exit 0 |
| `pnpm test:web-idempotency` | exit 0 |
| `pnpm test:web-bundle` | exit 0 |
| `pnpm typecheck` | exit 0 |
| `pnpm lint` | exit 0 |
| `pnpm contracts:check-generated` | exit 0 |
| `pnpm architecture:check` | exit 0 |
| `pnpm check` | exit 1 |
| `git diff --check` | exit 0 |

До последнего guard основной агент также выполнил nginx cutover, Edge auth,
Customer unit/HTTP, contracts/test, config и authority — exit 0; их production
source hashes сохранены. Exact command JSON: `parent-final/{checks,regressions}.json`.

`pnpm check` **FAIL**: `TOOLCHAIN-LOCK` требует отсутствующий importer для
`apps/web/node_modules/.vite/deps/package.json`. Это воспроизведённый на базовой
редакции warm-cache tooling defect; cache/pins/checker не менялись ради PASS.
Полный `pnpm test` и Compose smoke не объявляются пройденными.

## Повтор перед публикацией follow-up #173

В ветке `fix/173-served-surface-evidence` исходники девяти code/test files
сверены с fingerprints ниже до и после повторного native run: совпадают.
`WEB_SERVED_EVIDENCE=/home/yurgusev/.hermes/cache/scratch/issue9-served-surface-20261006/publication/native pnpm test:web-served-surface`
— exit 0, **26/26 PASS**. Повтор настоящего QueryClient/query-options probe —
exit 0, **18/18 PASS**. Это новый runtime run, а не вывод из переименования ветки.

`pnpm test:edge-auth`, `pnpm test:customer-unit`, `pnpm test:web-queries`,
`pnpm typecheck`, `pnpm lint`, `pnpm contracts:check-generated`,
`pnpm architecture:check`, `git diff --check` — exit 0.
`pnpm check` — exit 1 на том же missing Vite-cache importer; последующие команды
из root chain этим запуском не выполнены. Operator/idempotency/bundle результаты
из предыдущей таблицы относятся к тем же неизменённым runtime исходникам.

Exact command receipts: `publication/checks.json`. Независимый readback после
повтора: `publication/cleanup-independent.json`; owned Docker/tmpfs targets
отсутствуют, оба runtime порта недоступны, browser имеет только close receipt.
Исходные BLOCK/RED, GREEN и review receipts сохранены отдельно.

## Review и границы приёмки

Первичный `independent-review.json`: BLOCK R1. Исправление и native RED/GREEN
наблюдены основным агентом. `independent-r1-recheck.json`: PASS по R1;
18/18 actual QueryClient/query-options probes, canonical decimal validator,
сохранение всех прежних 22 сценариев и четыре новых проверки подтверждены.
Визуальный review восьми выбранных из 22 PNG: PASS; остальные 14 визуально
не проверялись. Основной агент повторно выполнил probe и финальный native run
после получения review: exit 0, 26/26 PASS, source hashes не изменились.
На момент исходных runtime/review receipts приёмка владельца, CI, publication/merge,
production IdP/PKI/provider и SSE capacity не наблюдались. Последующая публикация
PR сама по себе не подтверждает остальные границы. Этот документ не разрешает
#12 implementation/deployment; merge текущего follow-up владелец прямо запретил.

## Cleanup и артефакты

RED, GREEN и финальный native run: exact owned container/config-container,
network/image/tmpfs targets отсутствуют, runtime listeners закрыты, shutdown
pending пуст. Browser close receipt есть; независимого browser PID в нём нет.
Существующие host resources не удалялись. Независимые readbacks:
`parent-accepted-candidate/cleanup-independent.json`.

Артефакты в `/home/yurgusev/.hermes/cache/scratch/issue9-served-surface-20261006/`:
`older-red.log`, `older-green.log`, `parent-accepted-candidate/`, review reports.
Native output: `scenarios.json`, sanitized `browser-network.json`/`owner-network.json`,
`native-image.json`, session-clock receipts, PNG, `cleanup.json`. Transient
credentials присутствовали только в fixture memory/scoped tmpfs; значения
не экспортируются. Ни secrets-файлы, ни raw cookie/token/private-key values
не являются evidence artifacts.

## Source fingerprint финального native run

| Source | SHA-256 |
|---|---|
| `package.json` | `0ccff4efc76e91b2082b2013fa5480f16bd4662df57ddfbdbf017b611c16e4bc` |
| `tests/nginx/cutover.test.mjs` | `c42377e172300a5db161fbfc8681609f9406556656bc3a17563103df0f3ec611` |
| `tests/nginx/fixtures/served-backend.mjs` | `7c0b703ce9e03ca5674d59e171f766dcec6f65e99c5a7531a1f1dc9bbcae3145` |
| `apps/web/test/operator-flow.spec.ts` | `fc8f0e1e0f02ef94c78a83fdfe0b549005355900eb8fa513a6b356636a3e2c28` |
| `apps/edge-gateway/src/oidc-auth.ts` | `138a9e1887b67113931e6014cdd50faf41e98ebeadd59ad52fda49c299c69575` |
| `tests/edge-auth/oidc-auth.test.mjs` | `461bfd98877c9e6b86bf20bc0be8ee32d5ad16297d8cbe532c02b19112419733` |
| `apps/api-public/src/index.ts` | `1907c71fea0857ff2e62f8f0fb5565f58202a5cdce9a6a5ef223a28b2a78e5fc` |
| `tests/customer/customer-http.test.mjs` | `7424f6968dd2fb24bc00155586047568eb8f292494692bd70bddbbe7fe316310` |
| `apps/web/src/browser/api/remote.ts` | `46202a2565dc39356ded54c41ec098627c4401644fea3c5aa7aad487bec8a3db` |

Это hashes локального diff от указанной базы, не self commit SHA и не изменение
исторического handoff. После любой code правки native evidence нужно получить заново.
