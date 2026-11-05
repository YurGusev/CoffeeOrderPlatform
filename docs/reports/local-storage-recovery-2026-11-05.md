# Локальное хранилище: итог штатного пересоздания Buildx на SSD

Дата: 5 ноября 2026 года. Область: домашний сервер разработки.
Buildx, сборка, GC, swap и сохранность volumes подтверждены.
Обнаружено сервисное исключение: ранее остановленный `coffee_tailscale`
оказался запущен в цикле перезапусков; его прежнее остановленное состояние
восстановлено. У 26 ранее работавших контейнеров перезапусков нет.
Итог независимой проверки: **PASS_WITH_EXCEPTION**.

## Подтверждённое состояние

| Проверка                 | Результат                                                                                                                                                         |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Стандартный state        | `buildx_buildkit_coffee-platform-mtu0_state` на корневой SSD ext4 `/dev/sda3`; `opts.json={}`, скрытый bind на loop удалён                                        |
| Устройство и каталог     | Внутри builder device `2051`, как у `/`; inode canonical `_data` остался `6820809` — volume/data directory не пересоздавались                                     |
| Штатное пересоздание     | Выполнены `docker buildx rm --keep-state` и обычный `create`; CID изменился, worker ID сохранился                                                                 |
| Пробная сборка           | Административная и независимая пользовательская scratch/COPY сборки прошли; `COPY CACHED`, результат проверен побайтово                                           |
| GC                       | Effective config содержит `gc=true`; worker сообщает четыре политики, основные пороги reserved/cache/free — 2/10/40 ГиБ                                           |
| Image и ресурсы          | Прежний image ID, registry CA hashes и сеть `coffee_platform_build_mtu` / MTU 1280; memory 5 ГиБ, memory+swap 6 ГиБ; штатные CPU DriverOpts 400000/100000 (4 CPU) |
| Swap                     | `/swapfile` 8 ГиБ на SSD, root-owned `0600`, активен с priority 10; одна запись в fstab `sw,pri=10`                                                               |
| Zram                     | Priority 100; `vm.swappiness=10` сохранён                                                                                                                         |
| Именованные volumes      | Все 33 сохранены: Name, Driver, Scope, Labels, Options, Mountpoint совпадают с baseline; отличился только отображаемый CreatedAt canonical volume                 |
| CoffeeOrderDb            | Оба volumes сохранены; PostgreSQL 17, структуры до глубины два совпадают — по 101 записи                                                                          |
| Работающие контейнеры    | ID/PID/start ticks всех 26 контейнеров из baseline до операции совпадают; Docker видит их работающими                                                             |
| Остановленные контейнеры | У 12 прочих ранее созданных остановленных контейнеров нет старта после начала операции; отдельное исключение `coffee_tailscale` описано ниже                      |
| Текущий набор running    | После остановки `coffee_tailscale` равен 26 исходным работающим контейнерам плюс builder                                                                          |
| Операторский guard       | Действующая проверка G12 принимает устройство стандартного SSD volume                                                                                             |
| Свободное место          | Около 49 ГиБ, корень заполнен на 70%                                                                                                                              |

Первый штатно созданный CID:
`ade421552790c6a23f4a6c327d4cb3e8fe27dad60e9c696b18d761133e49b895`.
После проверочного `rm --keep-state` / `create`:
`f874dc3600f1138dda7398ba00b3ec00b1583b772ed00c2141a16bccc468bdee`.
Worker ID до/после: `2ua5ip5beazb6x6nip9ib3it9`.

Кэш скопирован из временного SSD volume с сохранением прав, xattrs и hardlinks,
сверен через checksum dry-run и пережил обычное пересоздание. Ручной Docker
container create-spec больше не нужен. Сохранены временный SSD volume,
предыдущие контейнеры в остановленном состоянии и прежний HDD cache по исходному
loop-пути; `volume rm` при переводе и проверке не применялся.

## Исключение coffee_tailscale

Исходная административная сверка PID охватывала **работавшие** контейнеры.
Она подтвердила непрерывность 26 процессов, но не проверяла, что ранее
остановленные контейнеры остались остановленными.

Расширенная проверка обнаружила `coffee_tailscale` с прежним ID
`0b8ba36b3b5eac590b0de060a552b720cf414d4c614bccdea5f3f629f9b3e6a4`
в running state, с политикой `unless-stopped` и RestartCount=12.
Его последний StartedAt был позже начала операции. Первое start-событие не
сохранилось в доступном Docker events buffer; точный инициатор первого запуска
не установлен. Наличие цикла перезапусков подтверждено наблюдаемыми изменениями
StartedAt/FinishedAt и счётчиком.

Контейнер остановлен по точному ID через `docker stop --time 20`. Политика
перезапуска, mounts и данные не менялись. Повторно подтверждены `Running=false`,
`Restarting=false` и исходный набор работающих контейнеров. Поэтому утверждение
«остальные контейнеры вообще не запускались» **не выполнено** для этого одного
ранее остановленного контейнера; восстановление текущего состояния не отменяет
исторический запуск.

## Почему обычный Buildx возвращал HDD

Docker API показывал у canonical volume `Options=null`, но его `opts.json`
содержал `MountType=none`, `MountOpts=bind` и `MountDevice` со старым путём
`/media/yurgusev/coffee-g12-work/diagnostics/buildkit-migration-20261028/restored-state`.
Временный read-only consumer видел device `1795`; под отключённым bind
находился пустой native SSD `_data` с inode `6820809`.

Local driver загружает options при инициализации, а затем использует объект
из кэша — см. [Moby local driver](https://github.com/moby/moby/blob/master/daemon/volume/local/local.go).
Во время административного шага только builder был остановлен, сохранён под
backup-именем и переведён на canonical volume. Docker service/socket кратко
останавливались с уже включённым live-restore, чтобы безопасно скопировать кэш
в пустой canonical `_data` и очистить bind options при неработающем daemon.
Другие daemon settings, версия и сеть не менялись.
[Docker live restore](https://docs.docker.com/engine/daemon/live-restore/)
сохранил процессы 26 работающих контейнеров.

Публичные registry CA закреплены в пользовательском BuildKit TOML и штатной
регистрации Buildx. Их SHA-256 совпали с исходным builder. После двух штатных
созданий отдельно проверены canonical volume, устройство, прежний worker ID,
GC, image, ресурсы и CA. Старый custom SSD volume сохранён, но active builder
его больше не использует.

## Штатное пересоздание

Для сохранения cache/volumes использовать `--keep-state`:

```bash
docker buildx rm --keep-state coffee-platform-mtu
docker buildx create --name coffee-platform-mtu --node coffee-platform-mtu0 --driver docker-container --buildkitd-config /home/yurgusev/.docker/buildx/coffee-platform-mtu.toml --buildkitd-flags '--allow-insecure-entitlement=network.host' --driver-opt cpu-period=100000 --driver-opt cpu-quota=400000 --driver-opt image=moby/buildkit@sha256:28a898719c18a33f4e8000685287fa36fd0dd9560c6440227d3a732d79bb41d8 --driver-opt memory=5g --driver-opt memory-swap=6g --driver-opt network=coffee_platform_build_mtu --bootstrap unix:///var/run/docker.sock
```

Это проверенная стандартная команда Buildx с сохранёнными driver options и
конфигурацией; ручной `docker create` и копирование config archive не нужны.
Canonical volume теперь постоянно хранит state на SSD и не зависит от loop.

Независимая пробная сборка после административного шага:

```bash
docker buildx build --builder coffee-platform-mtu --progress plain --output type=local,dest=/home/yurgusev/.cache/coffee-storage-recovery/2026-11-05/standard-buildx/verification-smoke-output /home/yurgusev/.cache/coffee-storage-recovery/2026-11-05/admin-step/smoke
```

Exit code 0, `COPY CACHED`, экспортированный `proof.txt` совпал с исходным.

## Очистка и сохранённые данные

Первичная read-only инвентаризация 594 анонимных dangling volumes выявила
240 пустых каталогов и 354 PostgreSQL data directories (22,912 ГиБ).
После явного разрешения пользователя удалены ровно 592 тома из согласованного
списка: 240 пустых и 352 PostgreSQL, через `docker volume rm` без force.
Фактически освобождено 22 950 932 480 байт (21,37 ГиБ) за 64,326 секунды.
Два volumes `CoffeeOrderDb` и все именованные исключены из очистки:

- `bccaeea73ab8aa05b271ee9d144e777c1f009b5d798468785219a6cb6f57e7f5`
- `d907652cf42486f0ace3798b33e0ba1f0d13aef0713503f3953addd22773cfa7`

Images, архивы, worktrees и sessions не очищались. На первом этапе BuildKit
переведён в новый SSD volume; на втором кэш перенесён в сохранённый canonical
volume. В итоге все 33 именованных volumes, существовавших перед стандартным
пересозданием, присутствуют.

## Evidence и границы проверки

Каталог: `/home/yurgusev/.cache/coffee-storage-recovery/2026-11-05/`.

- `standard-buildx/receipt.json` — административный PASS: штатное пересоздание,
  cache, GC, CA, swap, volumes и PID 26 исходно работающих контейнеров.
- `standard-buildx/verification.json` — независимая сверка **PASS_WITH_EXCEPTION**.
- `standard-buildx/unexpected-autostart.json` — обнаружение и остановка
  `coffee_tailscale`, неизменная restart policy, 12 остальных stopped containers.
- `standard-buildx/smoke-build.log`, `verification-smoke.log` и соответствующие
  output directories — две успешные сборки.
- `standard-buildx/opts.before.json`, `plan.json` и profile/registration snapshots
  — исходная bind-привязка, baseline volumes и настройки до применения.
- `post-apply-verification.json` — актуальная сводка; прежний SSD этап сохранён
  в `post-apply-verification-before-standard.json`.
- `cleanup-receipt.json`, `volume-inventory.json`, `anonymous-contents.json`,
  `postgresql-catalog-metadata.json` — исходная инвентаризация и согласованная очистка.

Перед применением прошли 3/3 tests конвертации: сохранение cache, mode,
hardlinks и inode каталога; отказ при непустом destination; отказ при изменении
options. Проверка без применения также прошла. После применения выполнена
независимая сверка Docker metadata, kernel PID/start ticks, структур двух БД,
настоящих worker GC policies, файла swap и реальной пользовательской сборки.

Полный G12, перезагрузка, SQL-проверка целостности БД и фактическое срабатывание
GC под заполнением не выполнялись. GC подтверждён по effective config и четырём
принятым worker policies. Проверка структуры volumes не является SQL integrity check.

Четыре bounded observability loops, их лимиты `maxDiskBytes=1GiB` и memory limit
Tempo 768 МиБ сохранены. NTFS sdb4, SMART, Windows/chkdsk, независимое резервное
копирование и переразметка накопителей в этот этап не входили.
