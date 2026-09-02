# Матрица rule parity для TypeScript 7, Effect и Oxlint

Статус: исполнимая проекция [ADR-0022](../adr/ADR-0022-ts7-native-toolchain.md)
и Effect-native authority [ADR-0023](../adr/ADR-0023-effect-native-platform.md).
Документ не вводит ESLint и не разрешает второй TypeScript compiler lane.

## 1. Authority и границы

Единая static/semantic authority состоит из четырёх непересекающихся частей:

1. `typescript@7.0.2`, пропатченный `@effect/tsgo@0.39.0`, владеет compiler
   diagnostics, Effect diagnostics, project references и emit;
2. `oxlint@1.80.0` и `oxlint-tsgolint@7.0.2001` владеют включёнными
   structural/type-aware lint rules;
3. `scripts/check-architecture.mjs` владеет CoffeeOrderPlatform-specific
   boundary, durability, capability и Effect usage rules;
4. RED/GREEN fixtures доказывают, что зарегистрированное правило реально
   завершает gate ненулевым кодом.

Нормативные команды:

```text
pnpm lint
pnpm typecheck
pnpm architecture:check
pnpm rule-parity:check
pnpm rule-parity:admit
```

`pnpm typecheck` является одним semantic lane: Effect TS-Go патчит pinned
TypeScript и тот же `tsc -b` выполняет project references, Effect diagnostics и
emit. Отдельный обязательный полный `effect-tsgo diagnostics` применяется только
к изолированному RED-проекту и не является вторым production compiler lane.

## 2. Severity contract

Для release-relevant correctness, security, Effect execution и architecture
rules допустим только результат `BLOCK`:

- diagnostic severity — `error`;
- warnings budget — `0`;
- нарушение завершает команду ненулевым кодом;
- существует executable RED fixture;
- waiver без точного rule, owner, причины и removal condition запрещён.

Статусы:

- **COVERED** — включённый diagnostic/checker и executable evidence;
- **PARTIAL** — часть класса ошибок блокируется, но остаётся названный обход;
- **GAP** — требование известно, но release gate его ещё не доказывает.

`rule-parity:check` проверяет честность матрицы. Он допускает явно записанные
старые `GAP/PARTIAL`, но Effect foundation rows обязаны быть только `COVERED`.
`rule-parity:admit` возвращает ненулевой код, пока хотя бы одна blocking-строка
не имеет статус `COVERED`.

## 3. Общая TS7/Oxlint matrix

| ID | Гарантия | Enforcement | Статус | Severity/evidence |
|---|---|---|---|---|
| `JS-CORRECTNESS` | Базовые ошибки JavaScript | Oxlint correctness + deny warnings | **COVERED** | `BLOCK`, architecture tests |
| `TS7-PROMISE` | Floating Promise / invalid await | type-aware lint + `TS7-PROMISE` | **COVERED** | `BLOCK`, `invalid-ts7-promise` |
| `TS7-MISUSED-PROMISE` | Promise в sync callback/boolean | rule зарегистрирован, но ещё не включён | **GAP** | блокирует admission |
| `TS7-UNSAFE-ANY` | Unsafe any flow | explicit syntax covered, type-flow обход остаётся | **PARTIAL** | блокирует admission |
| `TS7-EXHAUSTIVE-SWITCH` | Полная обработка tagged union | default проверяется, typed `never` ещё не доказан | **PARTIAL** | блокирует admission |
| `ARCH-SYNC-API` | Запрет sync Node API в request/consumer | scoped rule ещё не материализован | **GAP** | блокирует admission |
| `TS7-EVAL` | `eval`, `new Function`, implied eval | architecture checker | **COVERED** | `BLOCK`, RED fixture |
| `TS7-ESM` | ESM и `.js` runtime specifiers | architecture checker | **COVERED** | `BLOCK`, RED fixtures |
| `TS7-ERASABLE` | Erasable TS7 и одна compiler line | TS/checkers | **COVERED** | `BLOCK`, RED fixtures |
| `TS7-BRAND-CAST` | Запрет прямого cast branded IDs | architecture checker | **COVERED** | `BLOCK`, RED fixture |
| `BOUNDARIES` | Owner/DB/secret/interaction boundaries | Dependency Cruiser + `BOUND-*` | **COVERED** | `BLOCK`, RED/GREEN fixtures |
| `ARCH-FORBIDDEN` | Axios, FFI/SQLite/VFS, mutable Date | architecture checker | **COVERED** | `BLOCK`, RED fixtures |

Существующие `GAP/PARTIAL` не маскируются успешным lint и остаются причиной
ненулевого `rule-parity:admit`. Их закрытие принадлежит отдельному продолжению
static foundation и обязательно до admission `[3.8]`.

## 4. Effect diagnostic matrix

В `tsconfig.effect.json` ровно 22 mandatory diagnostics имеют severity `error`.
Machine evidence находится в
`tests/architecture/fixtures/effect-diagnostics/manifest.json`.

### Native Effect 4 language-service evidence

```text
floatingEffect
floatingEffectInVitest
missingEffectContext
missingEffectError
missingLayerContext
promiseInEffectSuccess
anyUnknownInErrorContext
effectFnImplicitAny
leakingRequirements
multipleEffectProvide
runEffectInsideEffect
strictEffectProvide
tryCatchInEffectGen
unknownInEffectCatch
globalErrorInEffectCatch
globalErrorInEffectFailure
abortControllerInEffect
asyncFunction
extendsNativeError
outdatedApi
```

Каждое имя обязано реально появиться в выводе pinned language service на RED
project. Проверка только наличия ключа в JSON недостаточна.

### Project-level evidence

- `duplicatePackage`: standalone source не может создать вторую физическую копию
  package; проверяется синтетическим lock/package graph через
  `EFFECT-TOOLCHAIN-DUPLICATE`.
- `scopeInLayerEffect`: upstream `@effect/tsgo@0.39.0` документирует diagnostic
  только для Effect v3; в Effect 4 та же гарантия обеспечивается обязательным
  `ARCH-EFFECT-SCOPED-LAYER` и RED fixture. Конфигурация сохраняется `error` для
  compatibility, но не выдаётся за нативное v4 evidence.

## 5. Effect architecture matrix

Следующие правила являются частью основного `architecture:check`, а не
необязательной второй команды:

| ID | Гарантия | Статус |
|---|---|---|
| `EFFECT-ARCH-PRIMARY` | Effect — единственная effectful application model | **COVERED** |
| `EFFECT-ARCH-RUN-BOUNDARY` | Runtime запускается только на process/browser/test boundary | **COVERED** |
| `EFFECT-ARCH-PROVIDE-BOUNDARY` | Layer composition только в composition roots | **COVERED** |
| `EFFECT-ARCH-MODULE-ALLOWLIST` | `unstable/*` default-deny и exact allowlist | **COVERED** |
| `EFFECT-ARCH-OWNER-LAYER` | Layer не пересекает bounded-context ownership | **COVERED** |
| `EFFECT-ARCH-DURABILITY` | Process memory не является durable state | **COVERED** |
| `EFFECT-ARCH-UNSAFE-RETRY` | AROMA mutation не получает retry/repeat Schedule | **COVERED** |
| `EFFECT-ARCH-SCOPED-FIBER` | Daemon/unowned Fiber запрещён | **COVERED** |
| `EFFECT-ARCH-SCOPED-LAYER` | Resource finalizer требует `Layer.scoped` | **COVERED** |
| `EFFECT-ARCH-SQL-BOUNDARY` | Raw PostgreSQL drivers принадлежат одному adapter | **COVERED** |
| `EFFECT-ARCH-CONTRACT-AUTHORITY` | Generated/internal contract обходы запрещены | **COVERED** |
| `EFFECT-ARCH-DIAGNOSTIC-WAIVER` | Inline disable требует полного временного waiver | **COVERED** |
| `EFFECT-ARCH-LEGACY-INVENTORY` | Legacy inventory закрыт и не растёт | **COVERED** |

## 6. Canonical machine-readable matrix

```json
{
  "schemaVersion": 2,
  "authority": {
    "compiler": "typescript@7.0.2",
    "effectLanguageService": "@effect/tsgo@0.39.0",
    "oxlint": "oxlint@1.80.0",
    "tsgolint": "oxlint-tsgolint@7.0.2001",
    "diagnosticParityTest": "tests/architecture/effect-diagnostics.test.mjs"
  },
  "replacement": "ESLint",
  "uncoveredPolicy": "block-replacement",
  "rows": [
    { "id": "JS-CORRECTNESS", "status": "COVERED", "uncoveredBlocksReplacement": true, "evidence": ["tests/architecture/checks.test.mjs"] },
    { "id": "TS7-PROMISE", "status": "COVERED", "uncoveredBlocksReplacement": true, "evidence": ["tests/architecture/fixtures/invalid-ts7-promise"] },
    { "id": "TS7-MISUSED-PROMISE", "status": "GAP", "uncoveredBlocksReplacement": true, "evidence": ["tests/compose/rule-parity.test.mjs"] },
    { "id": "TS7-UNSAFE-ANY", "status": "PARTIAL", "uncoveredBlocksReplacement": true, "evidence": ["tests/architecture/fixtures/invalid-ts7-any"] },
    { "id": "TS7-EXHAUSTIVE-SWITCH", "status": "PARTIAL", "uncoveredBlocksReplacement": true, "evidence": ["tests/architecture/fixtures/invalid-ts7-switch"] },
    { "id": "ARCH-SYNC-API", "status": "GAP", "uncoveredBlocksReplacement": true, "evidence": ["tests/compose/rule-parity.test.mjs"] },
    { "id": "TS7-EVAL", "status": "COVERED", "uncoveredBlocksReplacement": true, "evidence": ["tests/architecture/checks.test.mjs"] },
    { "id": "TS7-ESM", "status": "COVERED", "uncoveredBlocksReplacement": true, "evidence": ["tests/architecture/fixtures/invalid-ts7-commonjs", "tests/architecture/fixtures/invalid-ts7-import"] },
    { "id": "TS7-ERASABLE", "status": "COVERED", "uncoveredBlocksReplacement": true, "evidence": ["tests/architecture/fixtures/invalid-ts7-enum", "tests/architecture/fixtures/invalid-ts7-version-mix"] },
    { "id": "TS7-BRAND-CAST", "status": "COVERED", "uncoveredBlocksReplacement": true, "evidence": ["tests/architecture/fixtures/invalid-ts7-brand"] },
    { "id": "BOUNDARIES", "status": "COVERED", "uncoveredBlocksReplacement": true, "evidence": ["tests/architecture/checks.test.mjs"] },
    { "id": "ARCH-FORBIDDEN", "status": "COVERED", "uncoveredBlocksReplacement": true, "evidence": ["tests/architecture/checks.test.mjs"] }
  ],
  "effectDiagnostics": [
    { "id": "EFFECT-DIAG-floatingEffect", "diagnostic": "floatingEffect", "enforcement": "language-service", "status": "COVERED", "uncoveredBlocksReplacement": true, "evidence": ["tsconfig.effect.json", "tests/architecture/fixtures/effect-diagnostics/manifest.json", "tests/architecture/effect-diagnostics.test.mjs"] },
    { "id": "EFFECT-DIAG-floatingEffectInVitest", "diagnostic": "floatingEffectInVitest", "enforcement": "language-service", "status": "COVERED", "uncoveredBlocksReplacement": true, "evidence": ["tsconfig.effect.json", "tests/architecture/fixtures/effect-diagnostics/manifest.json", "tests/architecture/effect-diagnostics.test.mjs"] },
    { "id": "EFFECT-DIAG-missingEffectContext", "diagnostic": "missingEffectContext", "enforcement": "language-service", "status": "COVERED", "uncoveredBlocksReplacement": true, "evidence": ["tsconfig.effect.json", "tests/architecture/fixtures/effect-diagnostics/manifest.json", "tests/architecture/effect-diagnostics.test.mjs"] },
    { "id": "EFFECT-DIAG-missingEffectError", "diagnostic": "missingEffectError", "enforcement": "language-service", "status": "COVERED", "uncoveredBlocksReplacement": true, "evidence": ["tsconfig.effect.json", "tests/architecture/fixtures/effect-diagnostics/manifest.json", "tests/architecture/effect-diagnostics.test.mjs"] },
    { "id": "EFFECT-DIAG-missingLayerContext", "diagnostic": "missingLayerContext", "enforcement": "language-service", "status": "COVERED", "uncoveredBlocksReplacement": true, "evidence": ["tsconfig.effect.json", "tests/architecture/fixtures/effect-diagnostics/manifest.json", "tests/architecture/effect-diagnostics.test.mjs"] },
    { "id": "EFFECT-DIAG-promiseInEffectSuccess", "diagnostic": "promiseInEffectSuccess", "enforcement": "language-service", "status": "COVERED", "uncoveredBlocksReplacement": true, "evidence": ["tsconfig.effect.json", "tests/architecture/fixtures/effect-diagnostics/manifest.json", "tests/architecture/effect-diagnostics.test.mjs"] },
    { "id": "EFFECT-DIAG-anyUnknownInErrorContext", "diagnostic": "anyUnknownInErrorContext", "enforcement": "language-service", "status": "COVERED", "uncoveredBlocksReplacement": true, "evidence": ["tsconfig.effect.json", "tests/architecture/fixtures/effect-diagnostics/manifest.json", "tests/architecture/effect-diagnostics.test.mjs"] },
    { "id": "EFFECT-DIAG-effectFnImplicitAny", "diagnostic": "effectFnImplicitAny", "enforcement": "language-service", "status": "COVERED", "uncoveredBlocksReplacement": true, "evidence": ["tsconfig.effect.json", "tests/architecture/fixtures/effect-diagnostics/manifest.json", "tests/architecture/effect-diagnostics.test.mjs"] },
    { "id": "EFFECT-DIAG-leakingRequirements", "diagnostic": "leakingRequirements", "enforcement": "language-service", "status": "COVERED", "uncoveredBlocksReplacement": true, "evidence": ["tsconfig.effect.json", "tests/architecture/fixtures/effect-diagnostics/manifest.json", "tests/architecture/effect-diagnostics.test.mjs"] },
    { "id": "EFFECT-DIAG-multipleEffectProvide", "diagnostic": "multipleEffectProvide", "enforcement": "language-service", "status": "COVERED", "uncoveredBlocksReplacement": true, "evidence": ["tsconfig.effect.json", "tests/architecture/fixtures/effect-diagnostics/manifest.json", "tests/architecture/effect-diagnostics.test.mjs"] },
    { "id": "EFFECT-DIAG-runEffectInsideEffect", "diagnostic": "runEffectInsideEffect", "enforcement": "language-service", "status": "COVERED", "uncoveredBlocksReplacement": true, "evidence": ["tsconfig.effect.json", "tests/architecture/fixtures/effect-diagnostics/manifest.json", "tests/architecture/effect-diagnostics.test.mjs"] },
    { "id": "EFFECT-DIAG-scopeInLayerEffect", "diagnostic": "scopeInLayerEffect", "enforcement": "architecture-checker", "ruleId": "ARCH-EFFECT-SCOPED-LAYER", "status": "COVERED", "uncoveredBlocksReplacement": true, "evidence": ["scripts/effect-architecture-policy.mjs", "tests/architecture/effect-policy-extended.test.mjs"] },
    { "id": "EFFECT-DIAG-strictEffectProvide", "diagnostic": "strictEffectProvide", "enforcement": "language-service", "status": "COVERED", "uncoveredBlocksReplacement": true, "evidence": ["tsconfig.effect.json", "tests/architecture/fixtures/effect-diagnostics/manifest.json", "tests/architecture/effect-diagnostics.test.mjs"] },
    { "id": "EFFECT-DIAG-tryCatchInEffectGen", "diagnostic": "tryCatchInEffectGen", "enforcement": "language-service", "status": "COVERED", "uncoveredBlocksReplacement": true, "evidence": ["tsconfig.effect.json", "tests/architecture/fixtures/effect-diagnostics/manifest.json", "tests/architecture/effect-diagnostics.test.mjs"] },
    { "id": "EFFECT-DIAG-unknownInEffectCatch", "diagnostic": "unknownInEffectCatch", "enforcement": "language-service", "status": "COVERED", "uncoveredBlocksReplacement": true, "evidence": ["tsconfig.effect.json", "tests/architecture/fixtures/effect-diagnostics/manifest.json", "tests/architecture/effect-diagnostics.test.mjs"] },
    { "id": "EFFECT-DIAG-globalErrorInEffectCatch", "diagnostic": "globalErrorInEffectCatch", "enforcement": "language-service", "status": "COVERED", "uncoveredBlocksReplacement": true, "evidence": ["tsconfig.effect.json", "tests/architecture/fixtures/effect-diagnostics/manifest.json", "tests/architecture/effect-diagnostics.test.mjs"] },
    { "id": "EFFECT-DIAG-globalErrorInEffectFailure", "diagnostic": "globalErrorInEffectFailure", "enforcement": "language-service", "status": "COVERED", "uncoveredBlocksReplacement": true, "evidence": ["tsconfig.effect.json", "tests/architecture/fixtures/effect-diagnostics/manifest.json", "tests/architecture/effect-diagnostics.test.mjs"] },
    { "id": "EFFECT-DIAG-abortControllerInEffect", "diagnostic": "abortControllerInEffect", "enforcement": "language-service", "status": "COVERED", "uncoveredBlocksReplacement": true, "evidence": ["tsconfig.effect.json", "tests/architecture/fixtures/effect-diagnostics/manifest.json", "tests/architecture/effect-diagnostics.test.mjs"] },
    { "id": "EFFECT-DIAG-asyncFunction", "diagnostic": "asyncFunction", "enforcement": "language-service", "status": "COVERED", "uncoveredBlocksReplacement": true, "evidence": ["tsconfig.effect.json", "tests/architecture/fixtures/effect-diagnostics/manifest.json", "tests/architecture/effect-diagnostics.test.mjs"] },
    { "id": "EFFECT-DIAG-extendsNativeError", "diagnostic": "extendsNativeError", "enforcement": "language-service", "status": "COVERED", "uncoveredBlocksReplacement": true, "evidence": ["tsconfig.effect.json", "tests/architecture/fixtures/effect-diagnostics/manifest.json", "tests/architecture/effect-diagnostics.test.mjs"] },
    { "id": "EFFECT-DIAG-duplicatePackage", "diagnostic": "duplicatePackage", "enforcement": "project-checker", "ruleId": "EFFECT-TOOLCHAIN-DUPLICATE", "status": "COVERED", "uncoveredBlocksReplacement": true, "evidence": ["scripts/check-effect-toolchain.mjs", "tests/architecture/effect-policy-extended.test.mjs"] },
    { "id": "EFFECT-DIAG-outdatedApi", "diagnostic": "outdatedApi", "enforcement": "language-service", "status": "COVERED", "uncoveredBlocksReplacement": true, "evidence": ["tsconfig.effect.json", "tests/architecture/fixtures/effect-diagnostics/manifest.json", "tests/architecture/effect-diagnostics.test.mjs"] }
  ],
  "effectArchitecture": [
    { "id": "EFFECT-ARCH-PRIMARY", "status": "COVERED", "uncoveredBlocksReplacement": true, "evidence": ["scripts/effect-architecture-policy.mjs", "tests/architecture/effect-policy.test.mjs"] },
    { "id": "EFFECT-ARCH-RUN-BOUNDARY", "status": "COVERED", "uncoveredBlocksReplacement": true, "evidence": ["scripts/effect-architecture-policy.mjs", "tests/architecture/effect-policy.test.mjs"] },
    { "id": "EFFECT-ARCH-PROVIDE-BOUNDARY", "status": "COVERED", "uncoveredBlocksReplacement": true, "evidence": ["scripts/effect-architecture-policy.mjs", "tests/architecture/effect-policy.test.mjs"] },
    { "id": "EFFECT-ARCH-MODULE-ALLOWLIST", "status": "COVERED", "uncoveredBlocksReplacement": true, "evidence": ["scripts/effect-architecture-policy.mjs", "tests/architecture/effect-policy.test.mjs", "tests/architecture/effect-policy-extended.test.mjs"] },
    { "id": "EFFECT-ARCH-OWNER-LAYER", "status": "COVERED", "uncoveredBlocksReplacement": true, "evidence": ["scripts/effect-architecture-policy.mjs", "tests/architecture/effect-policy.test.mjs"] },
    { "id": "EFFECT-ARCH-DURABILITY", "status": "COVERED", "uncoveredBlocksReplacement": true, "evidence": ["scripts/effect-architecture-policy.mjs", "tests/architecture/effect-policy.test.mjs"] },
    { "id": "EFFECT-ARCH-UNSAFE-RETRY", "status": "COVERED", "uncoveredBlocksReplacement": true, "evidence": ["scripts/effect-architecture-policy.mjs", "tests/architecture/effect-policy.test.mjs"] },
    { "id": "EFFECT-ARCH-SCOPED-FIBER", "status": "COVERED", "uncoveredBlocksReplacement": true, "evidence": ["scripts/effect-architecture-policy.mjs", "tests/architecture/effect-policy.test.mjs"] },
    { "id": "EFFECT-ARCH-SCOPED-LAYER", "status": "COVERED", "uncoveredBlocksReplacement": true, "evidence": ["scripts/effect-architecture-policy.mjs", "tests/architecture/effect-policy-extended.test.mjs"] },
    { "id": "EFFECT-ARCH-SQL-BOUNDARY", "status": "COVERED", "uncoveredBlocksReplacement": true, "evidence": ["scripts/effect-architecture-policy.mjs", "tests/architecture/effect-policy.test.mjs"] },
    { "id": "EFFECT-ARCH-CONTRACT-AUTHORITY", "status": "COVERED", "uncoveredBlocksReplacement": true, "evidence": ["scripts/effect-architecture-policy.mjs", "tests/architecture/effect-policy.test.mjs"] },
    { "id": "EFFECT-ARCH-DIAGNOSTIC-WAIVER", "status": "COVERED", "uncoveredBlocksReplacement": true, "evidence": ["scripts/effect-architecture-policy.mjs", "tests/architecture/effect-policy-extended.test.mjs"] },
    { "id": "EFFECT-ARCH-LEGACY-INVENTORY", "status": "COVERED", "uncoveredBlocksReplacement": true, "evidence": ["scripts/check-effect-legacy-inventory.mjs", "tests/architecture/effect-policy.test.mjs"] }
  ]
}
```

## 7. Architecture bans и waivers

`oxlint-disable`, `eslint-disable` и `@effect-diagnostics` не могут отключить
Coffee architecture checkers. Любой `@effect-diagnostics` directive в production
source требует рядом metadata:

```text
@coffee-effect-waiver rule=<exactRule> owner=#<issue> removeAfter=<task/date> reason=<non-empty>
```

Отсутствующее поле, несовпадающий rule или waiver вне exact path завершают
`architecture:check` ошибкой `ARCH-EFFECT-DIAGNOSTIC-WAIVER`. Waiver не может
понизить `BOUND-*`, durability или AROMA safety rule.

## 8. Обновление матрицы

При добавлении или изменении mandatory rule одновременно требуются:

1. изменение canonical JSON;
2. exact severity/configuration;
3. executable RED fixture;
4. GREEN fixture, если правило ограничивает допустимый паттерн;
5. canonical/single-thread profile parity;
6. handoff/evidence owning issue.

Наличие зарегистрированного, но не включённого rule не является покрытием.
Наличие fixture без проверки конкретного diagnostic/rule id также не является
покрытием.
