# Предложение: воспроизводимый formatter scope для G03

Статус: предложение к точному одобрению владельца; не является принятой
formatter policy и не подтверждает G03 PASS.
Дата: 24 октября 2026.

## Что подтверждено

Закрытые GitHub issues #3, #14 и #60 и их comments не задают отдельный точный
scope для Prettier. Принятый [ADR-0022](../../../docs/adr/ADR-0022-ts7-native-toolchain.md)
фиксирует только «Форматирование выполняет только `prettier@3.9.6`; Oxfmt не
добавляется». `docs/launch/21_LAUNCH_VERIFICATION_SPEC.md` и
`verification/launch/v1/matrix.yaml` задают G03 command
`pnpm format:check && pnpm lint && pnpm typecheck`, но не перечисляют formatter
paths.

Поиск в Obsidian Vault дал те же два факта: архитектурная заметка сводит G03 к
format/lint/typecheck/zero warnings, а заметка launch №13 сообщает об отсутствии
exact `format:check`, не задавая scope. Запись по прежнему #12 formatter baseline
фиксирует локальное исключение конкретного файла в handoff, но не общую policy.

Установлен pinned Prettier `3.9.6`. Для одного воспроизводимого широкого active
code scope была выполнена read-only проверка текущего checkout/WIP. Предложенная
область включает tracked и текущие untracked файлы кода/конфигурации из дерева
проекта, исключая документацию (включая canonical revision roots), `evidence/`,
`secrets/`, generated contracts, provenance, build outputs, dependency lockfile
и `.codex` agent configuration. Она включает активные `apps/`, `packages/`,
`scripts/`, `tests/`, `tools/`, `verification/`, `config/`, root manifests и
CI/config файлы.

## Измерение без записи

Exact enumeration/check command:

```sh
rg --files --hidden --null \
  -g '*.{js,mjs,cjs,ts,tsx,mts,cts,json,jsonc,yaml,yml,css,scss,html}' \
  -g '!docs/**' -g '!evidence/**' -g '!secrets/**' \
  -g '!packages/generated/**' -g '!packages/platform-ui/provenance/**' \
  -g '!.codex/**' -g '!.git/**' -g '!**/node_modules/**' -g '!**/dist/**' \
  -g '!**/coverage/**' -g '!pnpm-lock.yaml' \
| sort -z \
| xargs -0 -r pnpm exec prettier --check
```

На установленном Prettier 3.9.6 точный отсортированный scope содержит 623 tracked
+ 13 untracked WIP файлов, всего 636. Явное исключение `!.git/**` убирает две
не-Git записи metadata, которые ранее попали в перечень `rg`. Проверка завершилась
exit 1: 530 файлов требуют форматирования, parser errors — 0. Из уже изменённых
в checkout 69 файлов этой области 67 не проходят check; ещё 463 несовпадения
находятся вне текущих изменений. Игнорируемых Git-файлов в перечне нет; root
manifests включены. Файлы не форматировались и не записывались.

Полный точный перечень и SHA-256 каждого файла сохранён в
[g03-format-scope-inventory.json](g03-format-scope-inventory.json)
(SHA-256 `2133d049cedc1c3324b920f1a0b89a8b8d49e26b0214d4a5b07c4e701cffbd58`).
Он привязан к source HEAD `bff183ec8a3503a2caae4debf2abef2539bf58b3` и
снимку текущего изменяющегося WIP, а не к чистой рабочей копии или canonical
baseline. Инвентарь содержит для каждого пути состояние tracked/untracked,
изменённость и результат Prettier.

## Рекомендуемое решение для утверждения

Рекомендуется один полный active-code scope, перечисленный выше, с точной
read-only проверкой этой командой. Это сохраняет смысл G03 как проверки кода
репозитория и исключает неизменяемые canonical roots, generated/provenance,
evidence и секретный материал. Исключение уже существующих неудовлетворяющих
форматированию active files означало бы неполный formatter gate; поэтому для
принятия такого scope требуется заранее решить судьбу baseline: одобрить
ограниченное однократное форматирование перечисленного active-code дерева либо
принять иной точный authority до изменения файлов. Этот proposal не
форматирует 530 файлов и не меняет команду G03.

По текущей ADR-0037 G04 выбирает изменённые критические модули по source paths.
Перечень formatter затрагивает все 16 таких модулей; сейчас G04 измеряет пять.
Поэтому после принятия и применения baseline потребуется новый G04 с порогами
90/90/85 для всех 16 модулей. Старые пять-module результаты не переносятся на
отформатированный candidate; исключение для изменений только whitespace не
вводится. Это дополнительный объём обязательной проверки, а не только размер
diff форматирования.

Вопрос для владельца: **Одобряете ли вы перечисленный полный active-code scope
для G03 и однократное форматирование его текущего baseline (530 файлов), включая
463 файла вне текущего WIP, чтобы последующий `format:check` проверял весь этот
scope без исключений?**
