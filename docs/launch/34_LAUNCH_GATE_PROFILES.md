# Профили гейтов запуска

Статус: operator entry для `admission`, `fast`, `release` и выборочного
диагностического запуска. Утверждено [ADR-0044](../adr/ADR-0044-launch-gate-profiles.md);
identity и resume проверяются по
[спецификации проверки запуска](21_LAUNCH_VERIFICATION_SPEC.md), раздел 18.

Профиль — это выборка строк `verification/launch/v1/matrix.yaml` и бюджет
времени. Состав и команды гейтов не меняются; профиль не добавляет и не
убирает проверки внутри гейта.

## 1. Что входит в профиль

| Профиль | Гейты | Бюджет | Решение о допуске |
| --- | --- | ---: | --- |
| `admission` | `preflight` (единственный гейт с `admission: true`) | жёсткий предел 90 секунд | всегда `НЕ ДОПУСТИТЬ` |
| `fast` | `preflight`, `install`, `generated`, `static`, `unit`, `contracts`, `architecture`, `config_security`, `report` | 20 минут | всегда `НЕ ДОПУСТИТЬ` |
| `release` | все 20 гейтов в порядке `matrix.yaml` | 180 минут | `ДОПУСТИТЬ` при PASS всех рабочих гейтов |
| `--gate` / `--from` | явно выбранное подмножество | 180 минут | всегда `НЕ ДОПУСТИТЬ` |

`report` не участвует в решении о допуске: он публикует `reportStatus`, а
`docs/reports/launch/<run-id>/ОТЧЁТ.md` создаёт только полный `release`-прогон.
Поэтому профиль `release` решает по 19 рабочим гейтам, а `admission` и `fast`
не могут вынести `ДОПУСТИТЬ` даже при всех PASS.

Гейты с `profile: fast` или `profile: both` входят в `fast` и `release`; гейты
с `profile: release` — только в `release`. Пометка `admission: true` не меняет
участие гейта в `fast`/`release`: `preflight` остаётся первым гейтом обоих
профилей.

## 2. Сколько занимает по измерению

Измерения на dev-machine; фактические длительности каждого прогона записаны в
`evidence/launch/<runId>/run-result.json` и в отчёте.

| Профиль | Измерено | Источник |
| --- | ---: | --- |
| `admission` | 42 секунды | `evidence/launch/20261114T173258Z-7e41cd6`, preflight PASS |
| `fast` | не перемерялся в #314; историческая оценка по гейтам полного прогона без `supply_chain` — около 8,5 минут | отчёт `docs/reports/launch/20261102T064519Z-4393aea/ОТЧЁТ.md` |
| `release` | не перемерялся в #314; бюджет 180 минут, исторический полный прогон прерывался на живых гейтах | там же и `evidence/launch/20261102T064519Z-4393aea` |

`admission` укладывается в минуту за счёт того, что запускает только
`preflight`: чистый SHA кандидата, свежий GitHub-снимок и политика preflight.
Повторный admission-прогон с `--resume` того же результата занимает около
1,5 секунды: preflight не запускается и evidence источника не переписывается.
Для PASS нужны те же операторские входы, что у preflight: принятая база через
`--accepted-base-commit` и доступный `SOPS_AGE_KEY_FILE`; без них admission
диагностически показывает FAIL, а не пропускает проверку.
`fast` включает `unit` и `report`, поэтому его длительность определяется
зависимостями и тестовым suite; бюджет профиля ограничивает прогон, даже если
отдельный гейт медленнее. `report` в `fast` финализирует evidence и не
публикует отчёт в отслеживаемом `docs/reports/launch/`. `supply_chain`
остаётся только в `release`: он собирает и публикует образы и требует сканера.
`release` дополнительно снимает живое состояние Compose, БД, Kafka, браузера и
AROMA, поэтому его время зависит от разрешений и состояния target, а не только
от кода.

## 3. Когда какой профиль применять

- **`admission`** — сразу после появления кандидата и перед планированием
  `release`. Проверяет, что SHA чистый, GitHub-снимок актуален, а принятые
  PR/handoff и authority-репозиторий не изменились. Один admission-прогон
  замораживает пару `candidateSha` + `githubSnapshotSha256`; новый снимок или
  новый SHA требует нового admission-прогона.
- **`fast`** — для итерации по коду и документации, когда живой стек ещё не
  нужен. Не заменяет `release` и не разрешает запуск.
- **`release`** — единственный профиль, который выносит решение `ДОПУСТИТЬ`.
  Запускается на замороженном кандидате после `fast` и `admission`.
- **`--gate` / `--from`** — диагностика одного гейта или хвоста после него.
  Предки не запускаются, решение всегда `НЕ ДОПУСТИТЬ`; `--from` требует
  `--resume` с PASS-предками.

## 4. Переиспользование admission-результата

`release` может переиспользовать PASS `preflight` из admission-прогона только
для той же пары `candidateSha` и `githubSnapshotSha256`:

```
pnpm launch:admission
pnpm launch:release --resume <admission-runId|evidenceDir>
```

Правило identity, проверка source-артефакта и статус
`RESUME_IDENTITY_MISMATCH` определены в
[спецификации](21_LAUNCH_VERIFICATION_SPEC.md), раздел 18.3. Source evidence
не переписывается, артефакты между прогонами не переносятся; в записи
`preflight` нового прогона остаётся `reusedFrom` с source run и хешами снимка
и артефакта. Остальные гейты `release` выполняются заново.

`admission` не разрешает выпуск: его результат — диагностический. Решение
`ДОПУСТИТЬ` остаётся за `release` и требует PASS всех 19 рабочих гейтов.

## 5. Точки входа

```
pnpm launch:admission      # node verification/launch/v1/run.mjs --profile admission
pnpm launch:fast           # node verification/launch/v1/run.mjs --profile fast
pnpm launch:release        # node verification/launch/v1/run.mjs --profile release
node verification/launch/v1/run.mjs --help
```

Профиль записывается в `run-result.json` полем `profile`, поэтому оператор не
угадывает режим по статусам гейтов. Exit code 1 означает `НЕ ДОПУСТИТЬ` (в том
числе для диагностических профилей), а не отсутствие результата:
диагностический evidence создаётся и при отказе, а `ОТЧЁТ.md` в
`docs/reports/launch/` публикует только полный `release`-прогон.
