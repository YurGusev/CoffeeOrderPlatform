# Issue #10 — core regression evidence

Статус этой итерации: `safe-read-increment-verified`, полный issue #10 не принят.

Помимо offer-binding boundary проверена локальная safe-read цепочка
`caller → api-internal → aroma-gateway → ProviderSession/ProviderCartReader` на
isolated HTTPS provider fixture. Доказаны encrypted session persistence, ротация
provider cookies после полного успешного GET, invalidation и single-flight re-login
после provider `401`, native mTLS/delegation negatives, restart/session reuse и
redaction. Live provider requests не выполнялись. Catalog importer/activation,
Orders convergence и provider mutations не входят в этот increment.

## Исправленные замечания

1. `catalog-export.ts` хранит двунаправленную collision map отдельно для `product`,
   `variant` и `offer`: `hash -> NFC(rawProviderId)` и `NFC(rawProviderId) -> hash`.
   Один raw ID с другим hash отклоняется, включая случай после flush предыдущего
   batch. Export не создаёт variant ID.
2. `mutation-journal.ts` декодирует bytes и делегирует shape validation существующим
   `isAromaProblem` и generated `isAromaMutationResponse` guards. Общая source schema
   теперь проверяет `ProblemDetails.type` и `ProblemDetails.instance` как RFC 3986
   URI-reference. Source-owned strict pattern используется и contract AJV, и
   generated runtime package; пробел, backslash, malformed percent encoding, NUL,
   colon в первом сегменте relative-path, brackets вне `//` authority и quote
   отклоняются. Проверены `1:abc`, `:abc` и `/[::1]`. Uppercase scheme/host,
   IPv6 authority, relative reference и percent encoding остаются допустимыми.
   `"😀".repeat(101)`
   остаётся допустимым по Unicode code-point semantics и `maxLength: 200`.
3. Reserve recovery после `TRANSACTION_OUTCOME_UNKNOWN` повторяет полную
   `sameRequest`-проверку request hash, cart scope, operation, offer, quantity и
   trusted delegation. Competing row с тем же `operationRef` возвращает
   `AROMA_OPERATION_REF_CONFLICT`, а не replay/unknown другой операции.
4. `SetLineQuantity` с `quantityMilli: null` или `"0"` отклоняется
   `AROMA_MUTATION_INVALID` до `reserve`; `RemoveLine` с `null` сохраняет допустимую
   семантику. Source `ProviderQuantity` и SQL journal constraint также требуют
   strictly positive Set quantity; max/scale/step provider не выбирались.
5. Четыре pre-runtime contract narrowing зарегистрированы exact-path evidence с
   issue, migration document и named negative fixture. Breaking guard проверяет
   exact before/after (либо их canonical SHA-256), затем исполняет fixture value:
   прежнее ограничение обязано принять его, новое — отклонить заявленным keyword.
   Иное narrowing и ineffective fixture продолжают отклоняться.

6. Ранее reported PostgreSQL regression был недетерминированным: один внешний
   запуск дал `14 pass / 1 fail` (`Missing expected rejection`), повтор — `15/15`.
   Test-only proxy теперь блокирует recovery extended query до durable competing
   COMMIT; `assert.rejects` прикрепляется к original promise немедленно и awaited
   внутри binding proof, поэтому failure сохраняет journal assertion и
   `phase=binding-proof`, не смещаясь в последующую database foundation phase.

## Наблюдаемая проверка

- `node --test tests/aroma/binding-http.test.mjs tests/aroma/catalog-export.test.mjs tests/aroma/mutation-journal.test.mjs tests/aroma/provider-http.test.mjs tests/aroma/source-identity.test.mjs` — `47 tests`, `46 pass`, `0 fail`, `1 skipped` (journal live proof без env).
- `COFFEE_DB_LIVE_PROOF=1 node --test tests/aroma/mutation-journal.test.mjs` —
  два последовательных финальных запуска: каждый `15 tests`, `15 pass`, `0 fail`,
  `0 skipped`. Настоящий
  `ProviderMutationJournalStore` на disposable PostgreSQL вернул
  `AROMA_OPERATION_REF_CONFLICT` после следующего гарантированного порядка:
  suppressed original `COMMIT` → новое закрытие peer относительно baseline →
  blocked recovery `SELECT` → подтверждённое отсутствие original reservation →
  competing `Acknowledged` terminal COMMIT и reread → release recovery query.
  Original mutator не вызван; test-only mutator competing operation вызван ровно один раз.
- `node --test tests/contracts/breaking.test.mjs` — `18 tests`, `18 pass`;
  exact effective narrowing evidence accepted, другое значение и ineffective
  fixture с тем же evidence rejected.
- `pnpm contracts:test` — `39 tests`, `39 pass`; direct `uri-reference` format,
  source fixtures и generated runtime schema используют один strict pattern.
- `pnpm contracts:generate`, `pnpm contracts:check-generated` и
  `pnpm contracts:lint` — exit `0`; generated artifacts byte-identical,
  aggregate SHA-256 `1f87e9631e953d80f3e303fb880362543dc4cf2db6296649fec897a6e64c86f5`.
- `pnpm exec tsc -b --pretty false` — exit `0` до генерации и после неё, чтобы
  compiled `contracts-aroma-v1` использовал свежий generated runtime.
- Первый `pnpm run check` остановился на lint warning о лишнем `await` у
  synchronous test-only barrier release; лишний `await` удалён без изменения порядка.
- Финальный `pnpm run check` — exit `0`: `251 tests`, `235 pass`, `0 fail`, `16 skipped`;
  authority, contracts, architecture, lint и typecheck прошли.
- `git diff --check` — exit `0`; scoped whitespace scan пяти изменённых untracked
  файлов также прошёл.
- AROMA/provider network calls не выполнялись; PostgreSQL proof использовал только
  disposable project-owned database/container и synthetic test-only mutator.

## Ограничения и безопасность

- AROMA/provider network calls: `false`.
- Provider credentials, raw provider IDs и secrets в evidence не записывались.
- Synthetic source и test-only mutator остаются test-only; production composition не
  получила fallback или provider mutation route.
- Commit, push, merge, PR publication и deployment не выполнялись.
- Полная production цепочка export/session/cart/binding population и Catalog/Orders
  handoff остаётся открытой.

## Дополнительная коррекция source identity — 12 сентября 2026

До исправления `offer-\ud800` проходил ручную UTF-16 проверку и давал тот же
HMAC, что корректный `offer-�`: `charCodeAt` за концом строки возвращал `NaN`,
который не отклонялся сравнением границ. Ошибка воспроизведена на compiled helper.
Обе копии проверки (HMAC framing и export identity boundary) заменены стандартным
`String.isWellFormed()`. Валидные surrogate pairs и настоящий U+FFFD сохранены.

- `pnpm exec tsc -b apps/aroma-gateway/tsconfig.json --pretty false` — exit `0`.
- `node --test tests/aroma/source-identity.test.mjs tests/aroma/catalog-export.test.mjs`
  — `25 pass`, `0 fail`, `0 skipped`. Malformed product/variant/offer IDs приводят
  к `snapshot-failed`, без batch persistence; корректные Unicode IDs завершаются.

Эта коррекция не меняет source contracts, HMAC framing, DB и journal.
Предыдущие PostgreSQL/Compose/full-suite результаты выше относятся к прежней
итерации; после данной коррекции они повторно не запускались. Provider calls,
commit, push и merge в этой итерации не выполнялись.

## Safe-read increment — 13 сентября 2026

- `pnpm test:aroma-unit` — exit `0`: `32 pass`, включая encrypted cookie
  invalidation/re-login после provider `401`.
- `pnpm test:aroma-http` — exit `0`: `8 pass`.
- `pnpm test:aroma-integration` — exit `0`; реальный disposable PostgreSQL
  подтвердил encrypted cookie round-trip, expiry/invalid-ciphertext rejection,
  explicit cleanup и `SELECT/INSERT/UPDATE/DELETE` grants.
- `pnpm test:aroma-binding` — exit `0`; native container mTLS proof и cleanup.
- `pnpm test:aroma-compose` — exit `0`; foreign identity `401`, forged delegation
  `403`, malformed body `400`, valid safe-read `200`, sanitized DTO, restart reuse
  (`login=1`, `cart=2`), bounded redacted logs и полный cleanup.
- `pnpm check` — exit `0`: `284 tests`, `268 pass`, `0 fail`, `16 skipped`.
- `pnpm db:smoke` — exit `0`.
- Bare `pnpm test:compose-smoke` fail-closed без `SOPS_AGE_KEY_FILE`; обязательный
  isolated safe-read Compose proof выше использовал только generated fixture
  credentials и не читал repository secret material.

### R1/R2 cart snapshot remediation

- Full provider cart-line identity теперь включает `offerId`, `packing` и
  `grindId`; mapping без доказательства всех трёх компонентов завершается
  `ProviderCartMappingMissing`, а HTTP boundary возвращает sanitized `503`, не
  успешный snapshot.
- Пустая корзина принимается только при пустых `categories`, `weights`,
  `discounts`, `prices` и нулевых `total.default`/`total.promo`; противоречия
  завершаются `ProviderDecodeInvalid` и sanitized HTTP `503`.
- Targeted decoder/cart-reader/HTTP suite — `13 pass`; provider calls не
  выполнялись.
- PostgreSQL и Compose proofs для этой R1/R2 редакции не повторялись: storage,
  session lifecycle и production composition не менялись. Их результаты выше
  являются evidence предыдущей session remediation, а не новой проверкой R1/R2.

Catalog staging/activation и Orders convergence исключены из объёма реализации
#10. Остающиеся production blockers перечислены в актуальном provider protocol;
локальная готовность core не подменяет готовность provider adapters.
