# ADR-0022: TS7-native compiler, linting и contract codegen

Decision ID: `ADR-COP-TS7-NATIVE-001`
Status: `Accepted for CoffeeOrderPlatform greenfield launch`
Date: `2026-09-01`
Related: ADR-0019, issues #19, #3, #4 и #13.
Does not modify: неизменяемые канонические revision roots.

Supersedes: launch pins `openapi-typescript@7.13.0` и ESLint `10.9.1`, а не
несуществующий отдельный TS5/6 compatibility ADR. Канонические roots остаются
неизменяемым evidence: их обязательная static-check гарантия сохраняется, но
target implementation для CoffeeOrderPlatform заменяется на Oxlint+tsgolint
только после документированной rule-parity matrix и negative fixtures #3/#13.

## Контекст

CoffeeOrderPlatform создаётся с нуля и не имеет compatibility-обязательств перед
TypeScript 5/6, CommonJS, legacy compiler API, custom transformers или сторонними
language-service plugins. Один compiler должен одинаково определять typecheck,
JavaScript/declaration emit, project references, generated-code validation и CI
diagnostics. Runtime validation при этом остаётся отдельной обязательной границей.

`openapi-typescript@7.13.0` требует TypeScript `^5.x`. ESLint без TypeScript
parser не обеспечивает требуемый type-aware анализ, а `typescript-eslint` не
является TS7-native authority. Параллельная compatibility lane создала бы второй
compiler и два набора diagnostics без продуктовой гарантии.

## Решение

### 1. Единственная compiler authority

- `typescript@7.0.2` и поставляемый им native Go `tsc` — единственный compiler.
- TypeScript 5/6, `@typescript/native-preview`, глобальный `tsc`, compiler API,
  language-service API, custom transformers и runtime transpilation запрещены.
- `tsc` выполняет typecheck, backend emit, declaration emit, project references,
  generated-code validation и canonical CI diagnostics.
- `oxlint@1.80.0` выполняет structural/syntax linting.
- `oxlint-tsgolint@7.0.2001`, соответствующий TypeScript 7.0.2, выполняет
  type-aware linting через `oxlint --type-aware`.
- `oxlint --type-check` не используется как вторая compiler authority.
- Форматирование выполняет только `prettier@3.9.6`; Oxfmt не добавляется.

### 2. Contract codegen

`@hey-api/openapi-ts@0.99.0` с единственным plugin `@hey-api/typescript`
принимается как кандидат на types-only генерацию:

```text
OpenAPI 3.2 -> generated transport types -> tsc 7.0.2
```

Generated SDK, HTTP client, TanStack Query hooks, Zod, Axios, interceptors и
Vite integration запрещены. Project-owned client использует native fetch/Undici,
AbortSignal/deadline, exact typed route и runtime response validation.

Версия генератора `0.x` не считается доказательством корректности. До принятия
#4 обязательны golden corpus всех используемых OpenAPI 3.2 constructs,
negative fixtures, deterministic double generation, zero generated diff и TS7
compile. Любая потеря поля, `$ref`/composition semantics или diagnostic делает
generator неприемлемым; замена требует отдельного решения, а downgrade OpenAPI
или добавление TS5 compiler запрещены.

### 3. Явный строгий baseline

Во всех проектах явно включаются:

```text
strict=true
noUncheckedIndexedAccess=true
exactOptionalPropertyTypes=true
noUncheckedSideEffectImports=true
noImplicitOverride=true
noImplicitReturns=true
noFallthroughCasesInSwitch=true
noPropertyAccessFromIndexSignature=true
useUnknownInCatchVariables=true
forceConsistentCasingInFileNames=true
verbatimModuleSyntax=true
moduleDetection=force
isolatedModules=true
erasableSyntaxOnly=true
skipLibCheck=false
```

`enum`, `namespace`, parameter properties, legacy internal modules,
experimental decorators и transform-dependent syntax запрещены. Используются
literal unions, `as const`, discriminated unions, явные поля и ESM.

Backend: `target=ES2025`, `module/moduleResolution=NodeNext`, `lib=[ES2025]`,
`types=[node]`, package `type=module`, `.js` в относительных runtime imports.
`baseUrl`, CommonJS, `eval`, `new Function` и runtime transpilation запрещены.

Frontend: `target=ES2025`, `module=ESNext`, `moduleResolution=Bundler`,
`lib=[ES2025,DOM,DOM.Iterable]`, explicit types и `noEmit=true`. Vite не является
typechecker; TS7 typecheck всегда предшествует build. Точный browser baseline
доказывается Playwright evidence.

### 4. Project references и границы

Корневой `tsconfig.json` содержит `files=[]` и только `references`. Каждый
`apps/<runtime>` и каждый versioned/technical package имеет отдельный project.
Для `packages/contracts/**` и `packages/platform-*/**` обязательны
`composite`, `declaration` и `isolatedDeclarations`; apps не экспортируют
declarations как межсервисный API.

Project references не заменяют architecture checker. Запрещены cross-owner
app imports, frontend-to-backend imports, provider DTO вне Gateway, contract
imports runtime/DB/Fastify types, cycles и generic shared business packages.

### 5. Типы и runtime validation

Wire identifiers, деньги, quantities, versions и revisions представлены
отдельными opaque/brand types. Brand создаётся только после runtime validation;
прямой `as <Brand>` вне утверждённого parser/adapter запрещён. Состояния и ошибки
— закрытые discriminated unions с exhaustive `never`.

HTTP, Kafka, PostgreSQL JSON, config/environment и provider data всегда входят
как `unknown` и проходят JSON Schema/AJV либо иной утверждённый runtime parser.
Generated TypeScript types не являются security boundary и не заменяют wire
schemas, signed assertions или response validation.

### 6. Сборка и supply chain

#3 измеряет фиксированные профили `checkers/builders` на целевой машине и
утверждает один canonical CI profile. Parallel и `--singleThreaded` обязаны
давать одинаковые diagnostics, exit code, declarations и artifacts. Cache
`tsbuildinfo` не коммитится; key включает TypeScript/Node versions, lockfile и
tsconfig hash. Nx, Turborepo и remote cache не добавляются без измеренной проблемы.

Node native TypeScript разрешён только для малых repository/admin scripts без
application imports, DB business migrations и custom loaders. Production
runtime запускает заранее собранный JavaScript и не содержит compiler/linter/codegen.

Machine authority проверяет exact pins, соответствие tsgolint↔TS, единственный
`typescript` в lockfile, frozen/offline install, platform native binaries,
builder SBOM и отсутствие build tools в final images. Go toolchain не добавляется.

### 7. Обязательные негативные доказательства

До `implemented=true` проверки обязаны отвергать:

1. `enum` и иной non-erasable syntax;
2. CommonJS;
3. `baseUrl`;
4. Node ESM import без `.js`;
5. floating/misused Promise;
6. unsafe `any` assignment/argument/return;
7. non-exhaustive state switch;
8. direct identifier brand cast;
9. смешение `OrderVersion` и `ProjectionVersion`;
10. cross-owner app import;
11. generated drift или nondeterministic generation;
12. второй TypeScript package;
13. compiler/linter/codegen в production image;
14. неподдержанный используемый OpenAPI 3.2 construct;
15. различие parallel и single-threaded diagnostics/artifacts.

## Владение решением и реализацией

- #19 добавляет в upstream foundation authority только immutable decision ref,
  exact pin identity и запрет второй compiler lane; он не создаёт workspace,
  package manifests, lockfile, tsconfig или lint/build configuration.
- #3 единолично материализует manifests, lockfile, tsconfig graph,
  Oxlint/tsgolint, rule-parity matrix и build evidence.
- #4 доказывает OpenAPI 3.2 types-only codegen и generated drift.
- #13 запускает supply-chain, negative-fixture и clean-build gates.

Новая runtime-задача, service или production process не создаётся.

## Upgrade и rollback

Каждый stable patch проверяется отдельным русскоязычным issue/PR и меняет pin,
lockfile, SBOM и evidence атомарно. `next` допустим только в non-authoritative
probe; nightly не становится authority. Rollback возвращает предыдущие exact
pins и lockfile одним согласованным изменением. Две compiler lanes одновременно
не поддерживаются.
