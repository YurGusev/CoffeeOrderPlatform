# Границы исходников при сборке runtime

Статус: подготовка исходников. Для окончательного SHA ещё обязательны CI,
G12, SSE qualification и полный G00–G19. Этот документ не является допуском.

## Фактические результаты

Standalone G12 `20261101T065708Z-1e95d5c` на
`1e95d5ccaa291352cdf01741275cec302f48c5e6` завершился `PASS`:
1462,207 с, exit 0, 23 цели, 46 отчётов, 22 образа. Raw HIGH — 2;
оба разрешены только ранее утверждённым адресным VEX. Unresolved HIGH
и CRITICAL — 0. Итоговый result SHA-256:
`a0299d9910a519884bc158f34b08aa1025221cffe5a4f517457570ddcdfa0135`.
Независимо перепроверены SHA всех 59 артефактов, включая три OCI.
Минимальный доступный root — 40 261 808 128 байт, BuildKit —
15 001 513 984 байта; ресурсные guards и бюджет не сработали.
Внешний scratch и scanner lock удалены, `cleanupFailures` пуст.
Это компонентный результат прежнего SHA, а не formal admission нового.

SSE qualification после него не дошла до измерения нагрузки:

- Каталог результатов оператора находился вне объявленного `TMPDIR=/tmp`;
  parser отклонил его до создания стенда. Путь исправлен на приватный
  canonical directory внутри `/tmp`, Source не менялся.
- Три входных файла подготовленного checkout имели `0664`; штатный
  загрузчик требует `0644`. Права исправлены без изменения байтов и Git
  executable bit. Read-only загрузчик после этого принял Kafka и все
  15 runtime image IDs; импорт и одноразовый qualification claim не вызывались.
- Сохранённый после ошибки дочерний checkout нарушил требование чистого
  parent. Он перенесён целиком в приватный архив с сохранением inode,
  Git-истории и отрицательных доказательств; штатный inspector принял parent.
- Следующая попытка остановилась до нагрузки при восстановлении runtime
  image: checker ошибочно прочитал намеренно неправильный тестовый Dockerfile
  вложенного браузерного checkout как production-файл.

У последней попытки duration нагрузки — 0. Контейнеры, сеть и четыре
планировавшихся тега проверены по точным именам и отсутствуют. Собственная
синтетическая private materialization удалена вручную. Исходные
`FAIL`/`cleanupVerified=false` и отрицательные журналы не переписаны;
ручная очистка имеет отдельное доказательство.

## Первопричина и изменение

G12 экспортирует Node runtime в OCI для сканирования; это само по себе
не загружает образы в Docker. Qualification штатно восстанавливает
отсутствующие образы и обязана сравнить их IDs с G12.

`docker-build.mjs` предварительно вызывает checker toolchain. Его обход
всего parent исключал корневой `tests/`, но не ту же тестовую область
контролируемого `.g15-browser-child-…`. Реальная команда воспроизвела
`TOOLCHAIN-FINAL-IMAGE` за 0,3 с без сборки: источник ошибки —
`tests/architecture/fixtures/invalid-final-image/Dockerfile` внутри child.

Добавлено одно исключение только для
`^\.g15-browser-child-[A-Za-z0-9]+/tests/`. Production Dockerfile дочернего
checkout, любые остальные production-файлы и похожие посторонние пути
по-прежнему проверяются. Глобальный обход Git-репозиториев, новый framework,
изменения CI, pins, image-ID binding и порогов не добавлялись.

Смысл операций обхода и разделение build context/exporter сверены с
[Node fs.readdir](https://nodejs.org/api/fs.html#fspromisesreaddirpath-options)
и [Docker build exporters](https://docs.docker.com/build/exporters/).
Значение Git executable bit проверено по
[core.fileMode](https://git-scm.com/docs/git-config#Documentation/git-config.txt-corefileMode).

## Проверки

Под общим heavy lock, Node 26.8.1 и `umask 022`:

```text
node --test --test-name-pattern='TOOLCHAIN-FINAL-IMAGE|exact TS7 toolchain' tests/architecture/checks.test.mjs
```

3/3 PASS, 1,344 с. Новый сценарий последовательно проверяет nested child
tests GREEN, child production RED, похожее имя с `_` RED и root production
RED. Старые GREEN и RED остаются. Журнал SHA-256:
`aa40af8f54a848460c900a597bab5b7b6270092b1a17e60a62a4bd682fa239cc`.

Scoped type-aware Oxlint, Prettier, `node --check` обоих файлов и
`git diff --check`: PASS. Журнал SHA-256:
`64baf1a3ca4d99ba54374861757fe3bb15b3e9a57bb691bc7b52db1f1584615d`.
Реальная сборка после изменения и SSE qualification ещё не выполнены.
Лимиты G14/main/qualification сохраняются: 1800/7200/2700 с.
