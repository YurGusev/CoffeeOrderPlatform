# ADR-0026: точный prerelease генератора контрактов для TS7

- Статус: принято пользователем 2026-09-05; полный admission генератора остаётся в #4.
- Область: исключение к [ADR-0022](ADR-0022-ts7-native-toolchain.md).
- Владелец реализации: [issue #4](https://github.com/YurGusev/CoffeeOrderPlatform/issues/4).

## Причина

`@hey-api/openapi-ts@0.99.0` падает при загрузке: обращение к
`typescript.SyntaxKind.AnyKeyword` требует старого JavaScript Compiler API,
которого нет в единственном compiler `typescript@7.0.2`. Ошибка возникает
до чтения OpenAPI и не исправляется изменением контракта.

Upstream подтвердил причину в
[issue #4235](https://github.com/hey-api/hey-api/issues/4235) и удалил зависимость
генератора от TypeScript. Exact prerelease прошёл изолированную генерацию и
строгую TS7 compile; [evidence](../platform/CONTRACT_CODEGEN_ADMISSION.md)
отделяет эту проверку от полного admission.

## Решение

Разрешён только `@hey-api/openapi-ts@0.0.0-next-20260824173136` как кандидат
в workspace, builder и проверках #4. Единственный источник pin —
`config/toolchain-versions.json`; package manifest, lockfile, schemas,
compatibility matrix и validators синхронизируются с ним.

Это исключение для одной версии, а не разрешение на dist-tag `next`, диапазон
версий или произвольные prerelease. Lockfile фиксирует версии и integrity
генератора и транзитивных пакетов. Последующий upgrade требует отдельного
согласованного изменения и повторения проверок.

Сохраняются OpenAPI 3.2, единственный plugin `@hey-api/typescript`, types-only
outputs и единственный compiler TS7. TS5/6, patches в `node_modules`, SDK,
generated HTTP clients/hooks и присутствие compiler/codegen в final runtime
images запрещены прежними решениями.

## Проверка и предел допуска

Регрессионная проверка в `tests/runtime/node26-compatibility.test.mjs`
загружает установленный кандидат, дважды генерирует минимальный OpenAPI 3.2
пример, сравнивает outputs и компилирует их TS7 со строгим baseline и
негативными type fixtures. `output.module.extension: ".js"` задаётся явно:
compile включает оба generated `index.ts` и type import через entrypoint,
не полагаясь на обнаружение tsconfig по расположению output. Exact pin и sole-compiler dependency graph
проверяются существующими `versions:check` и `authority:check`.

Compatibility matrix сохраняет `required=false`, `authoritative=false`,
`acceptedAfterIssue=4`. Успешный `--strict-candidate` доказывает загрузку;
полный golden corpus всех используемых constructs, runtime contract fixtures,
generated drift и остальные acceptance #4 остаются обязательными.
Supply-chain/image gates и SBOM/provenance поставляемых images сохраняются;
смена build-time кандидата не подтверждает их прохождение.

## Rollback

При регрессии вернуть pin, его проекции и lockfile одним согласованным
изменением. Возврат к `0.99.0` восстанавливает известный blocker #4 на TS7,
поэтому не считается рабочим обходом. Переход на stable выполняется после
тех же проверок; плавающий канал обновлений не используется.
