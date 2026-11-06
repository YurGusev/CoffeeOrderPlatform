# Размещение временных данных

Статус: подготовка исходников. Полный G12 и ordered G00–G19 окончательного
SHA ещё обязательны; этот документ не является runtime admission.

## Измеренное ограничение

Компонентный G12 `20261101T055907Z-db30ffa` выполнялся с исполняемым SSD
`/tmp` и `umask 0022`. После 1724,208 с защитный оператор остановил его:
`FAIL/INTERRUPTED`, exit 130, 38 из 46 отчётов, stage `image-scan`.
Минимальный доступный root — 36 429 443 072 байта: сработал сохранённый
буфер 512 MiB над базовым резервом 20%, базовый резерв не пересечён.
Остановка не была превышением 1800 с или builder floor 1 GiB.
Собственные контейнеры и временный каталог удалены, `cleanupFailures` пуст.
Raw result SHA-256:
`fccd7b957d839892ca80cc91e759391887a7eb7e67b27505ba25c600e0e3d7a2`.

G14 дополнительно держит четыре исходных sparse ext4 backing files по 1 GiB,
реально заполняет их в pressure-фазах и одновременно создаёт четыре restore
backing files и архивы. Удаление файла внутри ext4 без discard не доказывает
освобождение физических блоков host. Поэтому один общий root для checkout,
scratch и backup не даёт достаточного запаса. Неподтверждённые временные Git
checkout и образы не удалялись ради получения этого запаса.

## Холодный старт 6 ноября 2026

В отдельном component run #275 с внешним `TMPDIR` Grafana не достигла health
за 180 секунд: SQLite migrations ещё выполнялись. Raw FAIL сохранён с SHA-256
`f8c8c39df849228407e42e4770c514c020d5d3cda232620d32339cde27f2a69c`;
причина задержки отдельных fsync не измерялась. Component run на ROOT `/tmp`
завершил startup и три signals за 72,006 с, но не проверял полный G14.
[Handoff #275](../../handoffs/issue-275.yaml) сохраняет ограничения и evidence.

Для полного G14 внешний placement остаётся необходимым из-за четырёх исходных
и четырёх restore backing files, pressure и backup. Локальное окно холодного
старта Grafana увеличено до 1800 с в пределах неизменённого общего бюджета G14
1800 с. Холодный полный G14 нового source ещё не проверен.

## Изменение

Внутренний runner принимает `--data-temp-dir` — операционный путь к уже
существующему canonical directory текущего UID, строго `0700`, без symlink.
Валидация выполняется до создания candidate checkout и evidence.

- Только G12 получает `COFFEE_LAUNCH_DATA_TEMP_DIR`; сканер повторно проверяет
  границу и использует путь только как parent большого `mkdtemp`.
  `TMPDIR` и исходный `SCAN_LOCK` сохраняются.
- Только G14 получает внешний `TMPDIR` для storage/backup. Его существующий
  launch phase использует tmpfs, а browser child остаётся внутри исполняемого
  candidate checkout.
- Parent, qualification, другие gates и их `TMPDIR` не меняются; inherited
  internal locator очищается. Gate argv, result DTO/schema, лимиты, CVE/VEX,
  DB guards, product config и lineage не менялись.

Расположение для этого host:
`/media/yurgusev/coffee-g12-cache-210/coffee-issue-210/tmp`, существующий
private directory на NTFS. Исполняемые checkout остаются на SSD `/tmp`.
G12 по-прежнему проверяет фактические 20 GiB свободного места; buffer root
20% + 512 MiB и builder floor 1 GiB остаются у оператора. Actual runner argv
с locator записывается в operator evidence без расширения закрытого DTO.

## Проверки исходников

В изолированном checkout выполнены с `umask 022`:

- offline frozen install 3,81 с и `pnpm exec tsc -b --pretty false` 12,90 с: PASS;
- существующий runner test `launch data temporary directory is private`:
  1/1 PASS, 1,79 с, включая CLI/path negatives и фактический child env;
- существующие scanner tests `G12 temporary root validates` и
  `G12 builds product images, records pinned upstream identity`:
  2/2 PASS, 32,28 с; отдельное размещение scratch/lock и cleanup;
- scoped type-aware lint, Prettier, `node --check`, `git diff --check`: PASS.

Первый runner test выявил пропущенный импорт в новом тесте; он исправлен,
отрицательный журнал сохранён с SHA
`68d3a0f55448de8618f615961049306e57016b22bfa41e6328a370f30bc366fd`.
Независимое ревью четырёх файлов блокирующих замечаний не нашло.
Scanner Docker-команды в этих tests подменены; реальный placement/cleanup
на NTFS и все обязательные runtime сценарии проверяются следующим frozen run.
