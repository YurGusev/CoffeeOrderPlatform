# Дополнительные варианты: native, portable, scheduler и immutable OS

Дата: 13 ноября 2026. Продолжение исследования
`docs/reports/build-architecture-options-2026-11-13.md`.

По требованию в этой части **не используются как опора** OpenObserve,
Docker BuildKit и pnpm. Это не означает, что установка зависимостей исчезает;
речь о том, что предложенные варианты не строятся на этих трёх инструментах.

## 0. Что уже установлено на хосте

Проверено read-only 13.11.2026:

- Ubuntu 24.04.5, systemd 255, Node `v26.8.1`.
- `portablectl` отсутствует; пакет `systemd-container` доступен (255.4) и
  содержит `portablectl`, `systemd-portabled`, профили `default/strict`.
- `mkosi` в apt есть (20.2), но не установлен.
- `mksquashfs`, `veritysetup`, `systemd-repart` установлены; `mkfs.erofs` нет.
- `nix`, `guix`, `bazel`, `podman`, `buildah`, `nerdctl`, `nomad` не
  установлены; `containerd` установлен.
- Node 26.8.1 поддерживает `--build-sea`; VFS для SEA появился в 26.9.0,
  то есть на текущем pinned Node 26.8.1 ещё недоступен.

Это важно для реалистичности: часть вариантов требует только пакета из
Ubuntu, часть — нового toolchain и обучения.

## 1. Вариант G. Portable services systemd + слоистые образы

Это самый близкий к «уходу от Docker без отказа от упаковки» вариант.

### Как устроено

Portable service — это образ с корневой файловой системой и unit-файлами.
`portablectl attach` копирует unit-файлы в систему, добавляет drop-in с
`RootImage=`/`RootDirectory=` и профиль sandboxing. Служба запускается как
обычный systemd-процесс, но в собственном корне образа, а не в PID 1
контейнера. Это официальный механизм systemd, а не самодельный chroot:
[Portable Services](https://systemd.io/PORTABLE_SERVICES/),
[portablectl(1)](https://www.freedesktop.org/software/systemd/man/latest/portablectl.html).

Для CoffeeOrderPlatform предлагается схема «база + расширения»:

1. **Базовый образ** `coffee-runtime-base.raw`: Ubuntu/Debian rootfs, Node
   26.8.1, glibc, CA-сертификаты, `librdkafka.so`, системные библиотеки для
   native addon. Собирается `mkosi`, `debootstrap` или `dnf --installroot`;
   Docker не нужен.
2. **14 extension-образов** `coffee-<service>_<sha>.raw`: `dist`, production
   зависимости, unit-файл, `extension-release`. Каждый extension
   подключается поверх базы через `portablectl attach --extension`.
3. Unit каждого сервиса получает `RootImage` базы и overlay extension;
   `ExecStart` указывает на Node и `dist/main.js` внутри образа.
4. Конфигурация и scoped-секреты монтируются read-only:
   `BindReadOnlyPaths=/etc/coffee/config:/app/config`,
   `BindReadOnlyPaths=/run/coffee/<service>/secrets.yaml:/run/secrets/coffee-platform.yaml`.
   Это сохраняет текущие пути `/app/config/platform.yaml` и
   `/app/dist` (`config/platform.yaml:563–648`) без переписывания кода.
5. Публичный nginx остаётся один; Kafka и PostgreSQL — внешние, как сейчас.

Portable services поддерживают extension images и overlayfs с v249;
`portablectl reattach` — с v248. На systemd 255 всё это доступно. Но
`portablectl` в текущей системе нет: нужен пакет `systemd-container`
(в Ubuntu noble он содержит `portablectl`, `systemd-portabled` и профили):
[file list](https://packages.ubuntu.com/noble/amd64/systemd-container/filelist).

### Обновление и откат

- Сборка: новый base/extension с версией в имени; base меняется редко,
  extension — на каждый релиз сервиса.
- Deploy: `portablectl reattach --now --extension <new-extension> <base> <prefix>`.
  `reattach` не делает stop/start, а перезапускает обновлённые unit-файлы;
  это меньше простоя, чем полный detach/attach.
- Health: внешний deploy-скрипт проверяет `/health/ready` каждого сервиса,
  mTLS и зависимости; portable services не имеют встроенного health-гейта.
- Rollback: сохранить предыдущий extension и выполнить
  `portablectl reattach --now --extension <old-extension> <base> <prefix>`, либо
  `portablectl attach` старого набора. Предыдущие образы не удалять до
  успешного health-подтверждения.
- Автоматизация: systemd timer или CI-джоб вызывает deploy-скрипт; сам
  `portablectl` не планирует обновления.

### Плюсы

- Нет Docker daemon и OCI runtime; нет 14 контейнеров.
- Образы read-only; профиль `default` включает `ProtectSystem=strict`;
  можно сделать свой профиль с `NoNewPrivileges`, `CapabilityBoundingSet=`,
  `RestrictAddressFamilies=`, `MemoryMax=`, `CPUQuota=`.
- База переиспользуется 14 сервисами; extension-образы тонкие.
- `RootImage`/`RootDirectory` дают изоляцию корня лучше, чем plain systemd
  unit, но слабее полноценного контейнера (сеть и часть окружения общие).
- Обновление и откат — на уровне образа, без пересборки всех сервисов.

### Минусы и риски

- Portable services **не являются полноценным контейнером**: сеть, PID,
  часть `/proc`, `/sys` и host resources общие; сетевую изоляцию нужно
  делать через `IPAddressAllow/Deny`, nftables или отдельные namespace.
- Нет встроенного health-gated rollback; его пишет deploy-скрипт.
- 14 unit-файлов и 14 extension-образов; нужен реестр версий и cleanup
  старых образов.
- Нужен `systemd-container` и `systemd-portabled`; это новый пакет на хосте.
- Сборка rootfs и native addon/librdkafka — отдельный pipeline; текущий
  Dockerfile нельзя переиспользовать напрямую.
- G12 (SBOM/scan) придётся переориентировать с OCI на файловые образы;
  G13/G14 — переписать с Compose на `portablectl`.
- ADR-0019 говорит «один container — один process role»; portable service
  сохраняет один процесс на unit, но слово «container» в ADR нужно
  заменить/уточнить отдельным ADR.

### Когда выбирать

Если цель — убрать Docker, но сохранить упаковку зависимостей, read-only
образы и относительно простой rollback. Это лучший кандидат для пилота
«без Docker»: один сервис (`edge-gateway` или `api-public`), затем 2–3,
затем все 14.

### Почему не systemd-sysext

`systemd-sysext` тоже умеет overlay `/usr` и `/opt`, но man page прямо
предупреждает: это не generic software packaging framework, у него нет
dependency scheme, а все установленные sysext активируются при загрузке.
Для 14 сервисов с разными версиями и unit-файлами это менее удобно, чем
portable services:
[systemd-sysext(8)](https://www.freedesktop.org/software/systemd/man/latest/systemd-sysext.html).

## 2. Вариант H. Native blue-green с nginx и systemd templates

Это не способ сборки, а способ **обновления** native-артефактов без Docker.
Он хорошо сочетается с вариантом G или с обычными systemd units.

### Как устроено

- Для каждого сервиса — два цвета: `blue` и `green`, на разных портах
  (например, `4101` и `14101`).
- systemd template units: `coffee-runtime@blue.service`,
  `coffee-runtime@green.service`; `Environment=COFFEE_PORT=...` или
  отдельный drop-in.
- nginx upstream указывает на активный цвет. Новый цвет поднимается,
  проверяется `/health/ready`, затем `nginx -s reload` переключает трафик.
- Старый цвет не останавливается сразу: nginx graceful reload даёт старым
  worker-процессам доработать текущие запросы; после drain — stop.
- Rollback: вернуть upstream на старый цвет и сделать reload; старый процесс
  ещё жив в течение окна отката.

NGINX документирует, что `reload` проверяет конфигурацию, при ошибке
откатывается на старую, а старые worker-процессы дорабатывают текущие
запросы:
[Beginner’s Guide](https://nginx.org/en/docs/beginners_guide.html).
systemd template units и `ExecReload`/`TimeoutStopSec` дают управляемый
drain: `man systemd.service`, `man systemd.exec`.

### Где применимо

- **Хорошо:** `edge-gateway`, `api-public`, `api-internal`, `realtime-gateway`,
  `catalog-service`, `customer-service`, `pricing-service` — stateless или
  с идемпотентными read-операциями.
- **Сложнее:** `orders-service` (Draft/Confirm, транзакции), `aroma-gateway`
  (provider mutations), `aroma-convergence` (leases/fencing), worker-сервисы
  (Kafka consumer groups). Для них нужен rolling restart с проверкой
  readiness и lease/fence, а не просто два цвета.
- Kafka consumers: два экземпляра в одной group могут делить партиции; это
  допустимо, но нужно доказать отсутствие duplicate processing и корректный
  rebalance. Для `catalog-activation-worker`/`orders-aroma-preparation`
  это отдельный recovery-proof.

### Обновление и автоматизация

1. Собрать новый release (tarball/portable image).
2. Поднять неактивный цвет; дождаться readiness и зависимостей.
3. Переключить nginx upstream; `nginx -s reload`.
4. Проверить ошибки/латентность; выдержать окно.
5. Остановить старый цвет; сохранить его артефакт для rollback.
6. При FAIL — вернуть upstream, reload, остановить новый цвет.

Это можно автоматизировать скриптом `tools/deploy-native.mjs` с явными
шагами и health-проверками; systemd timer или CI вызывает скрипт.
Никакого «самообновления» без health-гейта.

### Плюсы

- Нет Docker; можно использовать обычные systemd units или portable images.
- Нулевой простой для stateless-сервисов; быстрый rollback переключением
  upstream.
- Понятная диагностика: два процесса, два порта, nginx upstream.

### Минусы

- Требует per-color портов и service discovery для внутренних вызовов.
  Сейчас все слушают фиксированные порты (`config/platform.yaml:533–1199`);
  для blue-green нужен план портов и генерация конфигурации.
- nginx знает только edge; внутренние вызовы идут напрямую к owner-сервисам.
  Для них нужен local reverse proxy/registry или клиентский retry на
  несколько адресов.
- Удваивает процессы на время обновления; на 8 CPU/14 ГиБ это надо измерять.
- Для stateful/lease-сервисов не заменяет recovery-proof.
- Не решает сборку; это дополнение к G/C.

## 3. Вариант I. Nix/Guix: декларативные генерации

### Nix

Nix описывает Node 26, зависимости, native addon, конфигурацию, nginx и
systemd-units как derivations; сборка идёт в `/nix/store`, доставка — через
binary cache. `nixos-rebuild switch` переключает поколение, `--rollback`
возвращает предыдущее. `deploy-rs` добавляет `autoRollback` и
`magicRollback` с подтверждением доступности после активации:
[NixOS rollback](https://github.com/NixOS/nixpkgs/blob/master/nixos/doc/manual/administration/rollback.section.md),
[deploy-rs](https://github.com/serokell/deploy-rs),
[system.autoUpgrade](https://github.com/NixOS/nixpkgs/blob/master/nixos/modules/tasks/auto-upgrade.nix).

Обновление: `deploy-rs` собирает/копирует closure, активирует, проверяет
доступность; при FAIL откатывает. `system.autoUpgrade` — таймер для ОС/базы,
но он не проверяет здоровье приложения; для приложения нужен deploy-rs или
свой health-гейт.

### Guix

Guix System использует поколения и `guix deploy`; `guix deploy --roll-back`
возвращает предыдущую конфигурацию. В manual прямо указано, что `guix deploy`
ещё находится в разработке:
[guix deploy](https://guix.gnu.org/manual/1.5.0/en/html_node/Invoking-guix-deploy.html),
[guix system](https://guix.gnu.org/manual/1.5.0/en/html_node/Invoking-guix-system.html).

### Плюсы

- Самая сильная воспроизводимость и atomic rollback.
- Binary cache ускоряет повторные сборки; изменённые derivations собираются
  только для затронутых пакетов.
- Нет Docker; systemd интегрирован; секреты можно подключить через
  `sops-nix`/agenix (потребует интеграции с текущим SOPS).
- Один язык для ОС и приложения (NixOS).

### Минусы

- Высокий порог входа; нужен Nix/Guix на хосте или отдельная NixOS-машина.
- Node 26/native addon/librdkafka нужно упаковать; текущий lockfile и
  lifecycle scripts — отдельная работа.
- NixOS на Ubuntu-хосте — дополнительный слой; Guix deploy ещё нестабилен.
- G12/G13/G14 придётся переосмыслить; текущие Docker-доказательства не
  переносятся.
- Для 14 сервисов и одного хоста выгода может не окупить миграцию.

### Когда выбирать

Если воспроизводимость и atomic rollback важнее скорости внедрения, и есть
экспертиза. Nix — предпочтительнее Guix из-за зрелости deploy-rs.

## 4. Вариант J. Nomad с raw_exec/exec

Nomad — планировщик без обязательного Docker. Задача может быть
`raw_exec` (обычный процесс) или `exec` (isolated fork/exec). Артефакт —
tar/zip с Node, приложением и библиотеками; Nomad скачивает его через
`artifact` stanza, проверяет checksum и запускает.

### Обновление

- Job spec `update` stanza: canary, health checks, `auto_revert`,
  `max_parallel`; при неудачном canary Nomad откатывает job.
- `nomad job history` и `nomad job revert` возвращают предыдущую версию.
- Service checks задают readiness; без них canary не имеет смысла.

Ссылки: [update stanza](https://developer.hashicorp.com/nomad/docs/job-specification/update),
[raw_exec](https://developer.hashicorp.com/nomad/docs/deploy/task-driver/raw_exec),
[exec](https://developer.hashicorp.com/nomad/docs/deploy/task-driver/exec),
[job revert](https://developer.hashicorp.com/nomad/commands/job/revert).

### Плюсы

- Нет Docker; scheduler даёт rollout/canary/auto-revert/history.
- Один job spec на сервис; артефакты версионируются.
- Хорошо масштабируется на несколько хостов в будущем.

### Минусы

- Для одного хоста это дополнительный server/client; выгода появляется
  только при multi-host.
- `raw_exec` не даёт container-level изоляции; `exec` даёт chroot/cgroups,
  но требует настройки. Секреты (SOPS) и network policy нужно интегрировать.
- Нет готового способа запускать 14 сервисов с текущими mTLS/секретами;
  нужен artifact pipeline и job templates.
- G12/G13/G14 не переиспользуются.

### Когда выбирать

Если в течение года ожидается несколько хостов и нужен scheduler без
Kubernetes. Для одного текущего хоста — overkill.

## 5. Вариант K. Immutable OS: CoreOS/Flatcar + app units

Идея: ОС обновляется атомарно, приложение — systemd units или portable
images в `/opt`.

- Fedora CoreOS: Zincati проверяет обновления, rpm-ostree хранит несколько
  deployment-ов; обновление применяется после reboot; rollback —
  `rpm-ostree rollback -r`. Maintenance windows настраиваются в Zincati.
  [Auto-updates](https://docs.fedoraproject.org/en-US/fedora-coreos/auto-updates/).
- Flatcar использует ту же модель update_engine/`locksmith`; детали зависят
  от версии, поэтому здесь не утверждаются без проверки.

### Плюсы

- Атомарное обновление ОС; предыдущий deployment остаётся для rollback.
- Хорошо для базовой ОС, драйверов, CA, Node runtime.
- Можно сочетать с portable services для приложений.

### Минусы

- Для частых релизов приложения пересборка/перезагрузка ОС слишком тяжела.
- Приложение всё равно нужно обновлять отдельно (portable services/systemd).
- Один хост и текущая Ubuntu-инфраструктура: миграция ОС — большой проект.
- Не решает G00–G19 и сборку 14 сервисов.

### Когда выбирать

Если появится парк хостов и нужна атомарная ОС. Для текущего одного хоста —
не первый шаг.

## 6. Вариант L. Hermetic build systems: Bazel/Buck2/Pants

Идея: описать граф сборки и кэшировать результаты actions, а не файлы.
Bazel поддерживает remote cache и remote execution; Buck2 и Pants — похожие
модели. Выход — tar/rootfs/бинарники, без Docker.

- Bazel: [remote caching](https://bazel.build/remote/caching),
  [remote execution](https://bazel.build/remote/rbe).
- Buck2: [docs](https://buck2.build/docs/).
- Pants: [docs](https://www.pantsbuild.org/).

### Плюсы

- Сильная воспроизводимость и кэш на уровне actions; параллелизм.
- Можно собирать только затронутые targets.
- Артефакты можно упаковать в tar/portable image и обновлять через G/H/J.

### Минусы

- Node/TypeScript/native addon интеграция нетривиальна; нужны правила и
  toolchain, часто с собственным lockfile/package manager.
- Высокая стоимость миграции; команда должна знать Bazel/Buck2.
- Текущие контракты, codegen и tsconfig-проекты нужно переописать.
- Для 14 сервисов выгода не доказана; сначала нужны измерения.

### Когда выбирать

Если сборка станет основным узким местом и появится отдельная
build-платформа. Не первый шаг.

## 7. Вариант M. Node SEA: один исполняемый файл на сервис

Node 26.8.1 поддерживает `node --build-sea`. Можно упаковать
`dist/main.js` и ассеты в один executable; Node не нужен на хосте.
Но:

- модули в main script по умолчанию не читаются из файловой системы;
  приложение нужно бандлить;
- native addon (`.node`) нельзя загрузить напрямую из SEA; его нужно
  записать во временный файл и вызвать `process.dlopen()`;
- `librdkafka.so` остаётся динамической библиотекой на хосте;
- VFS для ассетов появился в Node 26.9.0, на pinned 26.8.1 его нет;
- SEA имеет статус Active development.

Ссылка: [Single executable applications](https://nodejs.org/api/single-executable-applications.html).
Факт `--build-sea` подтверждён `node --help` на текущем хосте.

### Плюсы

- Один файл на сервис; нет `node_modules` в runtime; проще tar/portable
  artifact.
- Можно сочетать с systemd/portable services.

### Минусы

- Native addon и динамическая librdkafka усложняют; нужно извлекать addon
  во временный файл.
- Отладка и heap snapshots сложнее; бандлинг может изменить поведение.
- Не решает 14 сервисов; это packaging, а не архитектура обновления.
- Риск для Kafka-сервисов выше, чем для stateless.

### Когда выбирать

Для небольших stateless-сервисов после G/H, не для всего парка.

## 8. Вариант N. Пакеты ОС (.deb/.rpm) + unattended upgrades

Идея: каждый сервис — пакет, репозиторий apt/dnf, systemd unit; security
обновления автоматически, версии фиксируются.

- Плюсы: знакомый ops-процесс, подписи пакетов, версии, зависимости.
- Минусы: нет атомарного обновления 14 сервисов; rollback — вручную через
  версию пакета; миграции БД отдельно; конфигурация и секреты не входят в
  пакет; G12/G13 не переиспользуются.
- Вывод: не основной вариант; допустим как упаковка для K/OS-layer.

## 9. Сравнение новых вариантов

| Вариант | Docker | Изоляция | Артефакт | Обновление | Откат | Сложность | Оценка |
|---|---|---|---|---|---|---|---|
| G. Portable services | нет | root image + profile | base + 14 extension | `portablectl reattach` | предыдущий extension | большая | **лучший «без Docker»** |
| H. Native blue-green | нет | systemd | tar/portable | nginx reload + drain | переключить upstream | средне-большая | дополнение к G/C |
| I. Nix/Guix | нет | systemd | store closure | deploy/switch | generation/rollback | очень большая | долгосрочно |
| J. Nomad | нет | exec/raw_exec | tar + artifact | canary/auto-revert | `job revert` | большая | при multi-host |
| K. Immutable OS | нет | OS | OS image + units | Zincati/rpm-ostree | `rpm-ostree rollback` | большая | для парка хостов |
| L. Bazel/Buck2 | нет | build sandbox | tar/rootfs | зависит от G/H/J | зависит | очень большая | не первый |
| M. Node SEA | нет | systemd | executable | replace + restart | предыдущий бинарник | средняя | нишево |
| N. OS packages | нет | systemd | .deb/.rpm | apt/dnf | версия пакета | средняя | слабо для 14 сервисов |

## 10. Рекомендация по новым вариантам

1. **G, пилот на 1–2 сервисах.** Начать с `edge-gateway` или `api-public`:
   они stateless, без БД и Kafka. Собрать base + extension, запустить через
   `portablectl`, проверить mTLS, секреты, readiness, read-only root,
   `reattach` и rollback. Только после этого решать про 14 сервисов.
2. **H поверх G или обычных units.** Для stateless-сервисов blue-green даёт
   нулевой простой и быстрый откат; для orders/aroma — только после
   recovery-proof.
3. **J — если появится multi-host.** Nomad даёт scheduler и canary, но для
   одного хоста это лишний слой.
4. **I — если воспроизводимость станет требованием.** Nix + deploy-rs;
   Guix — только если команда уже на Guix.
5. **K — для ОС, не для приложений.** CoreOS/Flatcar решают обновление
   хоста, но не 14 сервисов.
6. **L/M/N — не первые.** Bazel/Buck2 — большая миграция; SEA — нишевая
   упаковка; .deb/.rpm — слабая атомарность.

### Критерии приёмки пилота G

- сервис запускается без Docker, с read-only root image;
- `/health/ready`, mTLS и scoped-секреты работают;
- `portablectl reattach --now` обновляет сервис, health проходит;
- откат на предыдущий extension возвращает рабочее состояние;
- нет записи в root image; state только в `StateDirectory`/БД;
- измерены RSS/CPU и время attach/reattach;
- G13/G14-подмножество для этого сервиса проходит;
- задокументированы отличия от Docker-изоляции (network, PID, secrets).

### Главные риски G

- portable services не дают полной сетевой изоляции; для provider-egress
  (`aroma-gateway`) и БД-сервисов нужен отдельный network policy.
- 14 unit-файлов и 14 extension-образов требуют реестра версий и cleanup.
- `portablectl`/`systemd-portabled` — новый пакет и новый daemon на хосте.
- G12 (SBOM/scan) нужно переориентировать на файловые образы; G13/G14 —
  переписать.
- ADR-0019 и launch evidence говорят на языке контейнеров; нужен отдельный
  ADR о смене runtime-authority.

## 11. Источники

### Репозиторий

- `docs/adr/ADR-0019-greenfield-node26-and-service-topology.md:94–95` —
  один process role на container.
- `config/platform.yaml:533–1199` — фиксированные порты `0.0.0.0`.
- `config/platform.yaml:563–648` — `/app/config`, `/app/dist`.
- `compose.yaml:10–28` — read-only, cap-drop, tmpfs, healthcheck.
- `Dockerfile:116–117` — `ARG RUNTIME` и `deploy`.
- `/home/yurgusev/coffee-platform/runtime/releases/*/release.json` — 7
  release-манифестов.
- `tools/coffee-containers.sh:1–8` — управление только существующими
  контейнерами.

### Внешние

- systemd Portable Services:
  [systemd.io](https://systemd.io/PORTABLE_SERVICES/),
  [portablectl(1)](https://www.freedesktop.org/software/systemd/man/latest/portablectl.html).
- Ubuntu `systemd-container`:
  [file list](https://packages.ubuntu.com/noble/amd64/systemd-container/filelist).
- mkosi: [mkosi.systemd.io](https://mkosi.systemd.io/).
- systemd.exec: `RootImage`, `MountImages`, `ExtensionImages`,
  `ProtectSystem`, `StateDirectory` —
  [systemd.exec(5)](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html).
- systemd.sysext:
  [systemd-sysext(8)](https://www.freedesktop.org/software/systemd/man/latest/systemd-sysext.html).
- NGINX reload:
  [Beginner’s Guide](https://nginx.org/en/docs/beginners_guide.html).
- NixOS:
  [rollback](https://github.com/NixOS/nixpkgs/blob/master/nixos/doc/manual/administration/rollback.section.md),
  [auto-upgrade](https://github.com/NixOS/nixpkgs/blob/master/nixos/modules/tasks/auto-upgrade.nix).
- deploy-rs: [README](https://github.com/serokell/deploy-rs).
- Guix:
  [guix deploy](https://guix.gnu.org/manual/1.5.0/en/html_node/Invoking-guix-deploy.html),
  [guix system](https://guix.gnu.org/manual/1.5.0/en/html_node/Invoking-guix-system.html).
- Nomad:
  [update](https://developer.hashicorp.com/nomad/docs/job-specification/update),
  [raw_exec](https://developer.hashicorp.com/nomad/docs/deploy/task-driver/raw_exec),
  [exec](https://developer.hashicorp.com/nomad/docs/deploy/task-driver/exec),
  [job revert](https://developer.hashicorp.com/nomad/commands/job/revert).
- Fedora CoreOS:
  [auto-updates](https://docs.fedoraproject.org/en-US/fedora-coreos/auto-updates/).
- Bazel:
  [remote caching](https://bazel.build/remote/caching),
  [remote execution](https://bazel.build/remote/rbe).
- Node SEA:
  [single executable applications](https://nodejs.org/api/single-executable-applications.html).

## Ограничения

- Варианты G–M не запускались; это архитектурные предложения, а не
  подтверждённый runtime.
- `portablectl`, `mkosi`, Nix, Nomad, Bazel на хосте не установлены;
  доступность пакетов проверена, но установка не выполнялась.
- Оценки сложности качественные; трудозатраты не измерялись.
- Сетевой и security-паритет portable services нужно проверять отдельным
  proof, особенно для `aroma-gateway` (provider egress) и БД-сервисов.
- G12/G13/G14 в текущем виде привязаны к Docker/Compose; перенос на любой
  native-вариант требует переработки evidence, а не только запуска.
