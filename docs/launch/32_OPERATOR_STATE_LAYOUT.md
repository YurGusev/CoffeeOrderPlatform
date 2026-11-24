# Раскладка операторского состояния

Документ фиксирует, где лежит состояние вне исходного репозитория и почему
именно там. Цель — один корень для всех артефактов прогонов, развёртывания и
резервных копий, без разбросанных каталогов в домашнем профиле.

## Корни

| Путь                                     | Назначение                       | Кто пишет                                              |
| ---------------------------------------- | -------------------------------- | ------------------------------------------------------ |
| `~/CoffeeOrderPlatform`                  | основной репозиторий (`develop`) | git                                                    |
| `~/CoffeeOrderPlatform-worktrees/<task>` | рабочие ветки задач              | `git worktree add`                                     |
| `~/coffee-platform`                      | корень операторского состояния   | `tools/platform-service.mjs`, `scripts/launch-run.mjs` |

Путь `~/coffee-platform` закреплён в коде (`tools/platform-service.mjs`
использует `~/coffee-platform/runtime` и `~/coffee-platform/certificates`),
поэтому это единственный допустимый корень состояния.

## Состав `~/coffee-platform`

```
certificates/           удостоверяющие сертификаты развёртывания (контракт platform-service)
runtime/                releases/<sha>-<env>-<cfg>/, controllers/, state/, overrides/
launch/                 состояние launch-верификации
  candidates/<sha>/     git worktree кандидата; evidence принадлежит кандидату
  soak/<runId>/         результат realtime qualification (родитель 0700)
  logs/<runId>/         stdout/stderr шагов supply_chain, soak, run
  scan-cache/           COFFEE_SCAN_CACHE_DIR для Trivy (db, java-db)
  receipts/             исторические receipts и старые артефакты
  tmp/                  TMPDIR для приватного checkout runner
backups/<date>/         архивы и манифесты резервных копий
legacy/                 посторонние каталоги, ожидающие решения об удалении
```

## Пути, которые задаёт код

Все каталоги состояния резолвятся через `tools/state-paths.mjs`; скрытых
значений в коде нет, каждый путь переопределяется переменной окружения:

| Функция                      | Переменная                      | Значение по умолчанию                                   |
| ---------------------------- | ------------------------------- | ------------------------------------------------------- |
| `deploymentStateRoot`        | `COFFEE_PLATFORM_STATE`         | `~/coffee-platform`                                     |
| `deploymentReleasesRoot`     | —                               | `<state>/runtime/releases`                              |
| `deploymentRuntimeStateRoot` | —                               | `<state>/runtime/state`                                 |
| `systemdUserUnitRoot`        | `COFFEE_SYSTEMD_USER_DIR`       | `~/.config/systemd/user`                                |
| `observabilityReleasesRoot`  | `COFFEE_OBSERVABILITY_RELEASES` | `~/.local/share/coffee-platform/observability/releases` |
| корень сканера               | `COFFEE_SCAN_CACHE_DIR`         | `~/.cache/coffee-platform/scan`                         |
| корень launch-состояния      | `COFFEE_LAUNCH_STATE`           | `~/coffee-platform/launch`                              |
| корень soak                  | `COFFEE_LAUNCH_SCRATCH`         | без значения по умолчанию                               |

Относительный путь в любой из переменных отвергается с явной ошибкой:
инструмент не угадывает каталог и не создаёт файлы «где-то рядом».

## Обязательные требования, которые формируют раскладку

- `evidence` обязан лежать внутри checkout кандидата:
  `evidenceDir = <sourceRepoRoot>/evidence/launch/<runId>`
  (`verification/launch/v1/report.mjs`).
- Каталог результата realtime qualification должен быть абсолютным, находиться
  внутри объявленного scratch-корня (`COFFEE_LAUNCH_SCRATCH`, затем `TMPDIR`) и
  иметь родителя, принадлежащего пользователю без битов записи для группы и
  остальных (`tests/realtime/soak.test.mjs`,
  `verification/launch/v1/realtime-capacity.mjs`).
  Скрытого значения по умолчанию нет: без объявленного корня запуск завершается
  ошибкой. Поэтому `launch/soak` создаётся с правами `0700`.
- Приватный checkout прогона создаётся в `TMPDIR`, поэтому временные каталоги
  ограничены `launch/tmp` при явной передаче переменной.

## Требования к свободному месту

Пороги подобраны по фактическому потреблению, а не по проценту тома:

| Потребитель        | Требование                     | Откуда                                                     |
| ------------------ | ------------------------------ | ---------------------------------------------------------- |
| supply_chain | 10 GiB свободно                | `config/platform.yaml` → `securityScan.minimumFreeDiskGiB` |
| BuildKit           | 12 GiB свободно, кеш до 18 GiB | `config/platform.yaml` → `buildkit`                        |
| observability      | `max(6 GiB, 5% тома)`          | `tools/observability/service.mjs`                          |
| launch-обёртка     | 15 GiB до старта               | `scripts/launch-run.mjs --min-free-gib`                    |

Процентный порог для observability заменён на абсолютный минимум: на томе 168 GiB
прежняя формула требовала 34 GiB, что не связано с реальной потребностью стека.

Перед прогоном стоит освобождать кеш сборки — он восстанавливается:

```
docker buildx prune --builder coffee-platform-mtu --keep-storage 6GB
```

## Единая команда

```
pnpm launch:run -- --sha <commit> --g08-expected-system-identifier <id> [--base <commit>] [--g16-signer <path>]
```

`--g08-expected-system-identifier` обязателен: оператор передаёт утверждённый
system identifier PostgreSQL явно, без него обёртка завершается кодом 2 до
создания состояния и вызова Docker. Пример полного запуска:

```
pnpm launch:run -- --sha <commit> --g08-expected-system-identifier <id>
```

Шаги: предусловия (SOPS-ключ, закреплённые образы, свободное место, lock
сканеров) → worktree кандидата → `pnpm install --offline` и `tsc -b` → контекст
и environment → `supply_chain` → `realtime qualification` → полный прогон
preflight…report → сводка гейтов.

Обёртка оставляет два последних кандидата и три последних soak-каталога,
выполняет `git worktree prune` и поддерживает `README.md` в корне состояния.

## Быстрая перепроверка перед циклом

Полный цикл обновляется при каждом коммите: меняется SHA, значит нужен новый
кандидат, `supply_chain` и soak. Чтобы не узнавать о линте или юнит-ошибках
через час, перед запуском цикла выполняется локальная проверка:

```
pnpm launch:precheck               # все быстрые гейты
pnpm launch:precheck --gate static # один гейт
pnpm launch:precheck --list        # список проверяемых
```

Проверяются `install`, `generated`, `static`, `unit`, `contracts`,
`architecture`, `config_security` — те гейты, которым не нужны кандидат,
Docker-образы и soak. Команды берутся из `matrix.yaml`, поэтому локальная
проверка совпадает с тем, что выполняет runner.

## Профили запуска

`admission` проверяет только допуск кандидата и укладывается в минуту, `fast`
прогоняет девять быстрых гейтов, `release` выносит решение `ДОПУСТИТЬ`. Состав,
длительности и правила выбора профиля описаны в
[профилях гейтов запуска](34_LAUNCH_GATE_PROFILES.md), решение — в
[ADR-0044](../adr/ADR-0044-launch-gate-profiles.md), identity и resume —
в [спецификации проверки](21_LAUNCH_VERIFICATION_SPEC.md), раздел 18.

```
pnpm launch:admission                 # только preflight, диагностический результат
pnpm launch:fast                      # девять быстрых гейтов без живого состояния
pnpm launch:release                   # полный прогон и решение о допуске
pnpm launch:release --resume <runId|evidenceDir>  # повторно использовать PASS
node verification/launch/v1/run.mjs --gate static --gate unit
node verification/launch/v1/run.mjs --from compose --resume <runId|evidenceDir>
```

Все профили запускаются из чистого checkout: runner создаёт detached checkout
кандидата и пишет evidence в `evidence/launch/<runId>`. `--gate`/`--from` не
запускают предков и всегда дают `НЕ ДОПУСТИТЬ`. Переиспользованный PASS виден
в записи гейта как `reusedFrom`; source evidence не переписывается.

## Правила уборки

- кандидаты и soak-каталоги удаляются свободно: они воспроизводимы;
- `runtime/releases` удаляются только вместе с соответствующим релизом;
- `backups` удаляются по истечении согласованного срока хранения;
- `legacy` требует явного решения: содержимое не принадлежит этому репозиторию.
