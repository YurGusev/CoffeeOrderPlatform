# Матрица rule parity для Oxlint и tsgolint

Статус: исполнимая проекция [ADR-0022](../adr/ADR-0022-ts7-native-toolchain.md)
для первого запуска и issue #3. Этот документ не вводит ESLint и не разрешает
второй TypeScript compiler lane. Exact tool pins читаются из
`config/toolchain-versions.json`; эта матрица содержит только rule parity и
evidence, не второй version registry. Effect contract/runtime authority
определяется ADR-0024.

## 1. Authority и границы

Единственная toolchain authority состоит из трёх непересекающихся частей:

- `config/toolchain-versions.json#/typescript` владеет compiler diagnostics,
  project references и emit;
- `config/toolchain-versions.json#/oxlint` владеет structural/syntax rules;
- `config/toolchain-versions.json#/oxlintTsgolint` владеет type-aware lint rules через
  `oxlint --type-aware`.

Нормативные CI-команды — `pnpm lint`, `pnpm typecheck` и
`pnpm architecture:check`. `oxlint --type-check` запрещён: он создал бы вторую
compiler authority. ESLint-equivalent ниже означает эквивалентную гарантию, а
не зависимость от ESLint или его runtime.

На момент materialization issue #3 отдельного `.oxlintrc.json` нет. Поэтому
фактически включены только default correctness rules Oxlint/tsgolint;
`--deny-warnings` превращает каждое их предупреждение в ненулевой exit code.
Наличие зарегистрированного, но не включённого rule не считается покрытием.
Materialized `.github/workflows` также ещё нет: `package.json` задаёт локальный
aggregate gate, но сам по себе не является доказательством hosted CI.

## 2. Severity contract

В baseline включаются только release-relevant правила:

1. correctness и type-safety на boundary;
2. security и запрет динамического исполнения;
3. Promise/concurrency correctness;
4. event-loop safety runtime-кода;
5. архитектурные запреты ADR и ownership boundaries.

Для них допустим только результат `BLOCK`: rule/checker завершает CI ненулевым
кодом, warnings budget равен нулю, а RED fixture доказывает отказ. Категории
`style`, `perf` и широкая `pedantic` не включаются целиком: отдельное правило из
них становится blocking только при прямой связи с гарантией в этой матрице.

Статусы:

- **COVERED** — включённый rule или отдельный checker плюс RED fixture;
- **PARTIAL** — часть гарантии блокируется, но остаётся названный обход;
- **GAP** — rule зарегистрирован или требование известно, но release gate его
  ещё не доказывает. `GAP` и `PARTIAL` сохраняются в truth matrix и имеют
  `uncoveredBlocksReplacement: true`: они блокируют полную замену ESLint и
  принятие `G03_STATIC`, даже если текущий `pnpm lint` возвращает `0`.
  Admission issue #49 является отдельным scoped gate только для строк
  `ARCH-EFFECT-*` (включая `ARCH-EFFECT-PARSER`) и не объявляет старые GAP
  покрытыми.

## 3. Rule-parity matrix

| ID / гарантия                                                    | ESLint-equivalent                                                | TS7-native enforcement                                                                                                       | Текущий статус  | CI severity / доказательство                                                                                     |
| ---------------------------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------- |
| `JS-CORRECTNESS` / Базовые ошибки JavaScript и бесполезный код   | ESLint recommended correctness                                   | default `correctness` rules Oxlint, включая `no-eval`, плюс `--deny-warnings`                                                | **COVERED**     | `BLOCK`; canonical и `--threads=1` diagnostics сравниваются byte-for-byte в `tests/architecture/checks.test.mjs` |
| `TS7-PROMISE` / Floating Promise и `await` не-thenable           | `@typescript-eslint/no-floating-promises`, `await-thenable`      | default type-aware `typescript/no-floating-promises` и `typescript/await-thenable`; дополнительный fail-closed `TS7-PROMISE` | **COVERED**     | `BLOCK`; fixture `invalid-ts7-promise`                                                                           |
| `TS7-MISUSED-PROMISE` / Promise передан sync callback/boolean    | `@typescript-eslint/no-misused-promises`                         | зарегистрирован `typescript/no-misused-promises`, но default profile его не включает                                         | **GAP**         | `BLOCK`; отдельная scoped negative fixture обязательна до разрешения ESLint replacement                          |
| `TS7-UNSAFE-ANY` / `any` на assignment/argument/return boundary  | `no-unsafe-assignment`, `no-unsafe-argument`, `no-unsafe-return` | type-aware правила зарегистрированы, но не включены; checker ловит только явные синтаксические формы                         | **PARTIAL**     | `BLOCK`; явный `any` покрыт, type-flow обходы блокируют replacement до negative fixtures                         |
| `TS7-EXHAUSTIVE-SWITCH` / Exhaustive discriminated-union switch  | `switch-exhaustiveness-check`                                    | правило зарегистрировано, но не включено; checker требует `default`, но не доказывает исчерпывающий `never`                  | **PARTIAL**     | `BLOCK`; пропущенный variant блокирует replacement до negative fixture                                           |
| `ARCH-SYNC-API` / Запрет sync Node APIs в request/consumer paths | `node/no-sync` и restricted API list                             | Node plugin не включён; permission manifest не анализирует вызовы `fs.*Sync`/`child_process.*Sync`                           | **GAP**         | `BLOCK`; scoped runtime checker обязателен, admin/migration scope должен быть явным                              |
| `TS7-EVAL` / Запрет eval, implied eval и `new Function`          | `no-eval`, `no-implied-eval`, `no-new-func`                      | scoped checker блокирует `eval`, implied eval и `new Function`                                                              | **COVERED**     | `BLOCK`; отдельная RED fixture                                                                                              |
| `TS7-ESM` / Только ESM и относительные `.js` imports             | `no-require-imports`, import extensions                          | `TS7-ESM` запрещает CommonJS и extensionless relative imports                                                                | **COVERED**     | `BLOCK`; fixtures `invalid-ts7-commonjs`, `invalid-ts7-import`                                                   |
| `TS7-ERASABLE` / Только erasable TS7 syntax и одна compiler line | parser/project consistency rules                                 | `TS7-ERASABLE`, `TS7-VERSION-MIX`, `check-toolchain-versions.mjs` и `tsc`                                                    | **COVERED**     | `BLOCK`; fixtures `invalid-ts7-enum`, `invalid-ts7-version-mix`, `TS7-SINGLE-COMPILER`                           |
| `TS7-BRAND-CAST` / Branded IDs нельзя создавать прямым cast      | restricted syntax/custom rule                                    | `TS7-BRAND-CAST`                                                                                                             | **COVERED**     | `BLOCK`; fixture `invalid-ts7-brand`                                                                             |
| `BOUNDARIES` / Cross-owner import, чужая DB/secret и interaction | boundaries/import rules                                          | Dependency Cruiser wrapper и `BOUND-*` checkers                                                                              | **COVERED**     | `BLOCK`; RED fixtures проверяют source, target и rule id                                                         |
| `ARCH-FORBIDDEN` / Axios, native FFI/SQLite/VFS и mutable `Date` | restricted imports/syntax                                        | `ARCH-FORBIDDEN-HTTP`, `ARCH-FORBIDDEN-NATIVE`, `ARCH-TEMPORAL`                                                              | **COVERED**     | `BLOCK`; отдельные RED fixtures                                                                                  |
| `ARCH-EFFECT-PRIMARY` / Promise/async/timer/clock escape         | Effect execution model                                          | `check-architecture.mjs` с exact temporary legacy inventory                                                                    | **COVERED**     | `BLOCK`; fixture `invalid-effect-primary`, inventory is finite and `allowNewUsage=false`                       |
| `ARCH-EFFECT-RUN-BOUNDARY` / Effect execution starts only at roots | restricted runtime entrypoints                                | `check-architecture.mjs`                                                                                                      | **COVERED**     | `BLOCK`; fixture `invalid-effect-run`                                                                            |
| `ARCH-EFFECT-PROVIDE-BOUNDARY` / Layer composition ownership    | restricted DI composition                                       | `check-architecture.mjs`                                                                                                      | **COVERED**     | `BLOCK`; fixture `invalid-effect-provide`                                                                        |
| `ARCH-EFFECT-MODULE-ALLOWLIST` / Effect module surface          | restricted imports                                             | ADR-0024 unstable default-deny and `check-architecture.mjs`                                                                    | **COVERED**     | `BLOCK`; fixture `invalid-effect-module`                                                                         |
| `ARCH-EFFECT-OWNER-LAYER` / Layer cannot cross owner             | import/ownership boundaries                                     | owner-local Layer import guard in `check-architecture.mjs`                                                                      | **COVERED**     | `BLOCK`; fixture `invalid-effect-owner-layer`                                                                    |
| `ARCH-EFFECT-DURABILITY` / Durable protocol cannot be in-memory | restricted state primitives                                    | PostgreSQL/Kafka durability rule in `check-architecture.mjs`                                                                    | **COVERED**     | `BLOCK`; fixture `invalid-effect-durability`                                                                     |
| `ARCH-EFFECT-UNSAFE-RETRY` / AROMA mutation has no blind retry   | restricted retry/cancellation                                   | AROMA mutation path guard in `check-architecture.mjs`                                                                          | **COVERED**     | `BLOCK`; fixture `invalid-effect-unsafe-retry`                                                                  |
| `ARCH-EFFECT-SCOPED-FIBER` / Background effects are Scope-owned | restricted concurrency                                     | `forkScoped` requirement in `check-architecture.mjs`                                                                            | **COVERED**     | `BLOCK`; fixture `invalid-effect-scoped-fiber`                                                                  |
| `ARCH-EFFECT-CONTRACT-AUTHORITY` / Schema/HttpApi is contract source | restricted generated/handwritten paths                      | web/internal/generated DTO guard in `check-architecture.mjs`                                                                      | **COVERED**     | `BLOCK`; fixture `invalid-effect-contract-authority`                                                            |
| `ARCH-EFFECT-SQL-BOUNDARY` / SQL uses Effect SQL and Schema     | restricted database APIs                                      | `pg`/transaction/row-cast/identifier guard in `check-architecture.mjs`                                                          | **COVERED**     | `BLOCK`; fixture `invalid-effect-sql-boundary`                                                                  |
| `ARCH-EFFECT-PARSER` / Unknown source syntax fails closed       | parser safety                                                 | fail-closed source parser and stable source/line diagnostics                                                                       | **COVERED**     | `BLOCK`; fixture `invalid-effect-parser`                                                                        |
| Generated drift, contract compatibility и final-image toolchain  | не lint guarantee                                                | отдельные gates `contracts:*`, `versions:check`, image/supply-chain checks                                                   | Вне lint matrix | Нельзя маскировать lint warning или включать второй compiler; owning gate остаётся blocking                      |

Машиночитаемая часть этой таблицы является canonical input для
`scripts/check-rule-parity.mjs`. `pnpm rule-parity:check` проверяет достоверность
матрицы, наличие evidence и blocking-флагов и возвращает `0`, если `GAP` или
`PARTIAL` обозначены честно. Отдельный `pnpm rule-parity:admit` — admission gate
issue #49: при `uncoveredPolicy: block-replacement` он проверяет только строки
`ARCH-EFFECT-*` и возвращает ненулевой код, если любая из них не `COVERED`.
Статусы non-Effect `GAP`/`PARTIAL` не меняются и по-прежнему блокируют полную
замену ESLint; этот scoped admission не является доказательством их покрытия.

```json
{
  "schemaVersion": 1,
  "authority": {
    "compilerRef": "config/toolchain-versions.json#/typescript",
    "oxlintRef": "config/toolchain-versions.json#/oxlint",
    "tsgolintRef": "config/toolchain-versions.json#/oxlintTsgolint",
    "diagnosticParityTest": "tests/architecture/checks.test.mjs"
  },
  "replacement": "ESLint",
  "uncoveredPolicy": "block-replacement",
  "effectAdmission": "ARCH-EFFECT-*",
  "rows": [
    {
      "id": "JS-CORRECTNESS",
      "status": "COVERED",
      "uncoveredBlocksReplacement": true,
      "evidence": ["tests/architecture/checks.test.mjs"]
    },
    {
      "id": "TS7-PROMISE",
      "status": "COVERED",
      "uncoveredBlocksReplacement": true,
      "evidence": ["tests/architecture/fixtures/invalid-ts7-promise"]
    },
    {
      "id": "TS7-MISUSED-PROMISE",
      "status": "GAP",
      "uncoveredBlocksReplacement": true,
      "evidence": ["tests/compose/rule-parity.test.mjs"]
    },
    {
      "id": "TS7-UNSAFE-ANY",
      "status": "PARTIAL",
      "uncoveredBlocksReplacement": true,
      "evidence": ["tests/architecture/fixtures/invalid-ts7-any"]
    },
    {
      "id": "TS7-EXHAUSTIVE-SWITCH",
      "status": "PARTIAL",
      "uncoveredBlocksReplacement": true,
      "evidence": ["tests/architecture/fixtures/invalid-ts7-switch"]
    },
    {
      "id": "ARCH-SYNC-API",
      "status": "GAP",
      "uncoveredBlocksReplacement": true,
      "evidence": ["tests/compose/rule-parity.test.mjs"]
    },
    {
      "id": "TS7-EVAL",
      "status": "COVERED",
      "uncoveredBlocksReplacement": true,
      "evidence": ["tests/architecture/checks.test.mjs"]
    },
    {
      "id": "TS7-ESM",
      "status": "COVERED",
      "uncoveredBlocksReplacement": true,
      "evidence": [
        "tests/architecture/fixtures/invalid-ts7-commonjs",
        "tests/architecture/fixtures/invalid-ts7-import"
      ]
    },
    {
      "id": "TS7-ERASABLE",
      "status": "COVERED",
      "uncoveredBlocksReplacement": true,
      "evidence": [
        "tests/architecture/fixtures/invalid-ts7-enum",
        "tests/architecture/fixtures/invalid-ts7-version-mix"
      ]
    },
    {
      "id": "TS7-BRAND-CAST",
      "status": "COVERED",
      "uncoveredBlocksReplacement": true,
      "evidence": ["tests/architecture/fixtures/invalid-ts7-brand"]
    },
    {
      "id": "BOUNDARIES",
      "status": "COVERED",
      "uncoveredBlocksReplacement": true,
      "evidence": ["tests/architecture/checks.test.mjs"]
    },
    {
      "id": "ARCH-FORBIDDEN",
      "status": "COVERED",
      "uncoveredBlocksReplacement": true,
      "evidence": ["tests/architecture/checks.test.mjs"]
    },
    {
      "id": "ARCH-EFFECT-PRIMARY",
      "status": "COVERED",
      "uncoveredBlocksReplacement": true,
      "evidence": ["tests/architecture/fixtures/invalid-effect-primary", "tests/architecture/fixtures/invalid-effect-legacy-inventory"]
    },
    {
      "id": "ARCH-EFFECT-RUN-BOUNDARY",
      "status": "COVERED",
      "uncoveredBlocksReplacement": true,
      "evidence": ["tests/architecture/fixtures/invalid-effect-run"]
    },
    {
      "id": "ARCH-EFFECT-PROVIDE-BOUNDARY",
      "status": "COVERED",
      "uncoveredBlocksReplacement": true,
      "evidence": ["tests/architecture/fixtures/invalid-effect-provide"]
    },
    {
      "id": "ARCH-EFFECT-MODULE-ALLOWLIST",
      "status": "COVERED",
      "uncoveredBlocksReplacement": true,
      "evidence": ["tests/architecture/fixtures/invalid-effect-module"]
    },
    {
      "id": "ARCH-EFFECT-OWNER-LAYER",
      "status": "COVERED",
      "uncoveredBlocksReplacement": true,
      "evidence": ["tests/architecture/fixtures/invalid-effect-owner-layer", "tests/architecture/fixtures/valid-effect-owner-layer"]
    },
    {
      "id": "ARCH-EFFECT-DURABILITY",
      "status": "COVERED",
      "uncoveredBlocksReplacement": true,
      "evidence": ["tests/architecture/fixtures/invalid-effect-durability"]
    },
    {
      "id": "ARCH-EFFECT-UNSAFE-RETRY",
      "status": "COVERED",
      "uncoveredBlocksReplacement": true,
      "evidence": ["tests/architecture/fixtures/invalid-effect-unsafe-retry"]
    },
    {
      "id": "ARCH-EFFECT-SCOPED-FIBER",
      "status": "COVERED",
      "uncoveredBlocksReplacement": true,
      "evidence": ["tests/architecture/fixtures/invalid-effect-scoped-fiber", "tests/architecture/fixtures/valid-effect-scoped-resource"]
    },
    {
      "id": "ARCH-EFFECT-CONTRACT-AUTHORITY",
      "status": "COVERED",
      "uncoveredBlocksReplacement": true,
      "evidence": ["tests/architecture/fixtures/invalid-effect-contract-authority", "tests/architecture/fixtures/valid-effect-contract"]
    },
    {
      "id": "ARCH-EFFECT-SQL-BOUNDARY",
      "status": "COVERED",
      "uncoveredBlocksReplacement": true,
      "evidence": ["tests/architecture/fixtures/invalid-effect-sql-boundary"]
    },
    {
      "id": "ARCH-EFFECT-PARSER",
      "status": "COVERED",
      "uncoveredBlocksReplacement": true,
      "evidence": ["tests/architecture/fixtures/invalid-effect-parser"]
    }
  ]
}
```

## 3.1. Временный legacy inventory Effect

До cutover #50–#54 `scripts/check-architecture.mjs` содержит закрытую exact
таблицу `path → owner/removalIssue → rule/line`. Она перечисляет только текущие
Promise/Temporal/in-memory protocol строки foundation:

| Путь | Владелец удаления |
|---|---|
| `packages/platform-config/src/index.ts`, `packages/platform-runtime/src/index.ts`, `packages/platform-time/src/index.ts` | #51 |
| `packages/platform-database/src/index.ts`, `packages/platform-migrations/src/index.ts` | #52 |
| `packages/platform-idempotency/src/index.ts`, `packages/platform-inbox/src/index.ts`, `packages/platform-kafka-runtime/src/index.ts`, `packages/platform-outbox/src/index.ts` | #53 |

Каждая запись допускает только перечисленные исходные строки; новая usage в
известном или неизвестном пути завершается `ARCH-EFFECT-*` с non-zero exit.
После удаления последнего legacy пути #55 удаляет таблицу, сохраняя постоянные
architecture rules.

## 4. Architecture bans и waivers

Inline-комментарии `oxlint-disable`/`eslint-disable` не могут ослабить
`scripts/check-architecture.mjs`, Dependency Cruiser или manifest checkers: они
читают исходный текст и manifests независимо от lint directives и завершаются
ошибкой по собственному rule id. В baseline нет общего waiver-файла и нет
разрешения понизить `BOUND-*`, `ARCH-*` или `TS7-*` до warning.

Новый waiver допустим только отдельным ADR с owner, точным rule id, узким
path/symbol scope, причиной, expiry/removal condition и положительным/отрицательным
тестом. До materialization такого механизма отсутствие проверки любого из этих
полей означает ошибку CI; сам документ не является waiver.

## 5. Launch gate и обновление матрицы

`G03_STATIC` принимается только когда `format:check`, `lint` и `typecheck`
возвращают `0` при warnings budget `0`. `G06_ARCHITECTURE` отдельно требует, чтобы
каждый GREEN fixture прошёл, а каждый RED fixture завершился ненулевым кодом с
source, target и rule id. Поэтому rule parity проверяет не только успешный
default lint, но и scoped checker/RED fixtures для каждой blocking-гарантии.
`rule-parity:check` валидирует truth matrix; `rule-parity:admit` отдельно
подтверждает scoped Effect admission issue #49 и не снимает blocking-маркеры
непокрытых non-Effect строк.

При добавлении или обновлении rule обязательно одновременно изменить:

1. эту строку matrix и её статус;
2. exact Oxlint config/CLI scope;
3. ближайший RED fixture, который проходит без rule и падает с rule;
4. canonical и single-threaded diagnostics parity test.

Read-only команды для сверки materialized toolchain без изменения checkout:

```text
node_modules/.bin/oxlint --rules --type-aware
node_modules/.bin/oxlint --type-aware --print-config apps/aroma-convergence/src/main.ts
node_modules/.bin/oxlint --type-aware --deny-warnings apps packages scripts tests
node --test tests/architecture/checks.test.mjs
```

После устранения source-build blocker нормативными остаются pnpm entrypoints из
`package.json`; прямой вызов binary выше служит только диагностикой rule matrix.
