# Раскладка операторского состояния

Документ фиксирует, где лежит состояние вне исходного репозитория и почему
именно там. Цель — один корень для всех артефактов прогонов, развёртывания и
резервных копий, без разбросанных каталогов в домашнем профиле.

## Корни

| Путь | Назначение | Кто пишет |
| --- | --- | --- |
| `~/CoffeeOrderPlatform` | основной репозиторий (`develop`) | git |
| `~/CoffeeOrderPlatform-worktrees/<task>` | рабочие ветки задач | `git worktree add` |
| `~/coffee-platform` | корень операторского состояния | `tools/platform-service.mjs`, `scripts/launch-run.mjs` |

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

## Обязательные требования, которые формируют раскладку

- `evidence` обязан лежать внутри checkout кандидата:
  `evidenceDir = <sourceRepoRoot>/evidence/launch/<runId>`
  (`verification/launch/v1/report.mjs`).
- Каталог результата realtime qualification должен быть абсолютным, а его
  родитель — принадлежать пользователю и не иметь битов записи для группы и
  остальных (`tools/realtime-capacity.mjs`). Поэтому `launch/soak` создаётся с
  правами `0700`.
- Приватный checkout прогона создаётся в `TMPDIR`, поэтому временные каталоги
  ограничены `launch/tmp` при явной передаче переменной.

## Единая команда

```
pnpm launch:run -- --sha <commit> [--base <commit>] [--g16-signer <path>]
```

Шаги: предусловия (SOPS-ключ, закреплённые образы, свободное место, lock
сканеров) → worktree кандидата → `pnpm install --offline` и `tsc -b` → контекст
и environment → `supply_chain` → `realtime qualification` → полный прогон
G00–G19 → сводка гейтов.

Обёртка оставляет два последних кандидата и три последних soak-каталога,
выполняет `git worktree prune` и поддерживает `README.md` в корне состояния.

## Правила уборки

- кандидаты и soak-каталоги удаляются свободно: они воспроизводимы;
- `runtime/releases` удаляются только вместе с соответствующим релизом;
- `backups` удаляются по истечении согласованного срока хранения;
- `legacy` требует явного решения: содержимое не принадлежит этому репозиторию.
