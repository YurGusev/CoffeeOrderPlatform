# Admission генератора контрактов #4

Статус: пользователь разрешил exact prerelease по
[ADR-0026](../adr/ADR-0026-ts7-codegen-prerelease-admission.md).
Golden corpus реальных контрактов #4 завершён; admission является блокирующим.

## Исходная несовместимость (до ADR-0026)

На момент воспроизведения `config/toolchain-versions.json` задавал Node `26.8.1`, TypeScript `7.0.2`,
`@hey-api/openapi-ts` `0.99.0` и OpenAPI `3.2.0`.

Воспроизводимая команда из корня репозитория:

```sh
node scripts/check-node26-compatibility.mjs --skip-native-load --strict-candidate --json
```

Результат: exit `1`, `status=failed`, candidate `blocked` с причиной
`candidate does not load with the sole TypeScript 7 compiler`.
Прямой импорт генератора также падает до чтения OpenAPI:

```sh
node --input-type=module -e 'await import("@hey-api/openapi-ts")'
```

Причина: `@hey-api/openapi-ts/dist/init-D6Y8JFUS.mjs` импортирует `typescript`
и на строке 4017 читает `ts.SyntaxKind.AnyKeyword`. Корневой export TypeScript
7.0.2 предоставляет version API, но не старый Compiler API; итог —
`TypeError: Cannot read properties of undefined (reading 'AnyKeyword')`.
Строка peerDependencies, допускающая версию 7 по semver, этого API не создаёт.

Существующий обычный compatibility gate не выдавал generator admission:
он прямо сообщал `candidate=blocked`. Strict admission обязателен для #4.

## Изолированная проверка исправления

На 2026-09-05 `npm view @hey-api/openapi-ts dist-tags --json` сообщает
`latest=0.99.0`, `next=0.0.0-next-20260824173136`.
В [upstream issue #4235](https://github.com/hey-api/hey-api/issues/4235)
maintainer сообщает об удалении зависимости от TypeScript в next.

Точный `0.0.0-next-20260824173136` установлен через `npm install --ignore-scripts
--no-audit --no-fund --save-exact` только во временный каталог вне workspace.
На этом этапе project manifests, lockfile и pins не менялись. Probe вызвал `createClient`
с единственным plugin `@hey-api/typescript` на OpenAPI 3.2.0 и проверил:

- `$ref` на decimal-string Version;
- required/optional object fields, enum и nullable string;
- `oneOf` response и literal discriminator;
- два вызова генерации: `index.ts` и `types.gen.ts` byte-identical;
- компиляцию результата существующим TS7 `7.0.2`, включая негативные
  `@ts-expect-error` для numeric version, чужого enum и missing required;
- отсутствие установленного `typescript` в дереве зависимостей probe.

Генерация и TS7 compile завершились exit `0`. Полный corpus, streaming,
external refs, compatibility fixtures и production image admission этой
проверкой не подтверждены.

## Принятое исправление

По разрешению пользователя от 2026-09-05 ADR-0026 допускает exact prerelease
`0.0.0-next-20260824173136` в workspace как единственный кандидат #4.
Обновлены `config/toolchain-versions.json`, его package/schema/matrix/checker
проекции и lockfile. TS7 остаётся единственным compiler; матрица сохраняет
`required=true`, `authoritative=true`; `acceptedAfterIssue=4` сохраняет происхождение допуска.

Регрессионные тесты `tests/runtime/node26-compatibility.test.mjs` и
`tests/contracts/generated-types.test.mjs` используют
установленный workspace generator, проверяет strict candidate loading,
двойную types-only генерацию и компиляцию outputs строгим TS7 с негативными
fixtures. Временные outputs удаляются после теста. Golden corpus дополнительно
проверяет composition/required, nullable, refs и discriminated unions реальных sources.

При расширении исходного probe обнаружена неполнота доказательства:
компилировался `types.gen.ts`, но не generated `index.ts`. Без найденного
NodeNext tsconfig генератор по умолчанию создаёт в index импорт `./types.gen`,
который не разрешается строгим ESM NodeNext. Штатная настройка
`output.module.extension: ".js"` исправляет пути без обработки generated-кода.
Регрессионный тест теперь компилирует все outputs и импортирует типы через index.

## Проверка в workspace

Команды из корня репозитория (2026-09-05):

```sh
pnpm install --frozen-lockfile --offline --ignore-scripts
node --test tests/runtime/node26-compatibility.test.mjs
node --test tests/architecture/checks.test.mjs
pnpm versions:check
pnpm authority:check
pnpm exec oxlint --type-aware --deny-warnings scripts/check-toolchain-versions.mjs scripts/check-node26-compatibility.mjs tests/runtime/node26-compatibility.test.mjs
pnpm typecheck
git diff --check
```

Результат: exit `0`; 4 compatibility-теста (включая strict candidate,
byte-identical double generation и TS7 compile), 31 architecture-тест,
27 contract-тестов и 4 authority-теста. Полный `pnpm check` успешен; sole
compiler — TS7 7.0.2. Production image собран, native Kafka addon загружен,
а final stage проверен на отсутствие TypeScript, OpenAPI generator, Oxlint,
generated sources и contract sources. Clean-clone gate зафиксирован в handoff #4.
