# Предложение: изоляция DB для launch run без второго YAML

Статус: владелец явно утвердил предложенную изоляцию DB 24 октября 2026.
Исполнимое решение: [ADR-0036](../../../docs/adr/ADR-0036-launch-database-isolation.md).
Основание: issue #13, повторная проверка 24 октября 2026.

## Подтверждённое противоречие

`run.mjs` создаёт UTC + candidate SHA run-id во время запуска. G00 требует,
чтобы десять runtime уже содержали в committed `services.*.database` пять имён
`coffee_verify_<run-id>_<owner>`. Canonical YAML содержит постоянные имена
`coffee_platform_<owner>`. Записать будущий timestamp и собственный commit SHA
в тот же commit невозможно. Loader не интерполирует строки, а schema допускает
только обычные DB identifiers. Текущее поведение честно выдаёт FAIL.

Anchors: `verification/launch/v1/run.mjs` создание context/resources;
`verification/launch/v1/scenarios/preflight.mjs` проверка десяти target;
`config/platform.schema.json` database pattern; `packages/platform-config/src/index.ts`
loadPlatformConfig; `packages/platform-runtime/src/index.ts` configuredRuntimeIdentity.

## Рекомендуемое решение для утверждения

Сохранить единственный committed `config/platform.yaml` как authority базовых
DB/owner и правил. Разрешить только в явно включённом verification режиме
вычисление run-scoped DB имён в памяти из доверенного read-only launch context
и canonical `config/database-ownership.json`. Context передаёт identity запуска,
а не произвольные DB names/credentials. Любое готовое имя из context игнорируется
или отклоняется; prefix/suffix вычисляются и проверяются заново.

В обычном запуске и production эта возможность выключена; наличие launch context
при выключенной policy прекращает запуск. Для каждого runtime одинаково
вычисляются `database` и `allowedDatabase`, owner сверяется с canonical mapping.
Bootstrap и runtime обязаны подтвердить SHA base config, candidate/run identity,
реальный effective target и namespace. Никаких env DB values, второго service
YAML, legacy target, cross-owner SQL или расширения grants.

G00 проверяет canonical owner authority и план всех десяти effective targets
до создания ресурсов. Runtime receipt подтверждает реально использованные
пять run-scoped DB. Неполный/подменённый context, неподходящий owner, SHA или
namespace, symlink и production режим должны завершаться до DB connect.

## Минимальные изменения и проверки

- Явная disabled-by-default policy в canonical schema/config и документах 11/21.
- Один общий derivation/validation путь в platform-config; runtime использует
  его при проверенном context locator. Обычные callers сохраняют прежнее поведение.
- Runner/Compose/bootstrap передают только read-only run identity locator;
  preflight проверяет base authority и вычисленный план вместо невозможного
  буквального сравнения будущего run-id с committed YAML.
- Существующие config/preflight/runtime tests: disabled/production denial,
  valid five owners, mismatch/symlink/foreign namespace/extra targets denial;
  живой proof exact five DB и cleanup только собственных run resources.

G18 B→D→R по ADR-0035 по-прежнему отличается только mutationsEnabled;
base config hash и effective context identity фиксируются отдельно. Это не
разрешение overlay и не освобождение от G00–G19 PASS на одном candidate.

## Альтернатива

Сохранить текущее требование буквальных DB имён и оставить G00 FAIL: исполнимого
полного запуска с непредсказуемым timestamp/own SHA в том же commit сейчас нет.

Разрешение не меняет production и не даёт launch-допуска. Его реализация и
фактические проверки фиксируются отдельно; отсутствие полного G00–G19 PASS
сохраняет решение `НЕ ДОПУСТИТЬ`.
