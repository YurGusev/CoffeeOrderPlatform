# Архитектура сборки и обновления: уход от полного G00–G19 и Docker

Дата: 13 ноября 2026. Область: локальный репозиторий CoffeeOrderPlatform.
Исследование read-only: код, конфигурация, runtime и данные не менялись.

Дополнительные варианты без OpenObserve, Docker BuildKit и pnpm:
[часть II](build-architecture-options-2026-11-13-part2.md).

## Краткий вывод

Проблема «полной сборки G00–G19» не решается только ускорением Docker. В текущем
коде это две разные проблемы:

1. **Verification-архитектура.** 20 гейтов запускаются строго последовательно,
   без выбора, продолжения и переиспользования. Сумма объявленных timeout —
   465 минут при общем лимите runner 120 минут. Любой FAIL в `G00` превращает
   остальные 18 гейтов в `NOT_RUN`, а `G19` при этом получает `PASS` как отчёт.
   В сохранённых evidence нет ни одного полного PASS-прогона: все три полных
   запуска завершились за 31,7–37,0 с на FAIL `G00`.
2. **Build-архитектура.** 14 Node-образов собираются из одного Dockerfile с
   разным `RUNTIME`; `G12` собирает их в OCI-макеты и сканирует, `G13` заново
   собирает те же 14 + nginx через `--load`, `G18` снова собирает стек для
   rollback-сценария. Между гейтами нет передачи образов по digest, поэтому
   одна и та же работа повторяется.

Практический порядок: сначала **build-once + выборочные гейты**, затем
**per-service сборка только затронутых образов**, и только потом — эксперимент
с уходом от Docker. Уход от Docker — это смена runtime-authority, а не
оптимизация сборки: текущие ADR, Compose, healthcheck, tmpfs-секреты,
read-only root, cap-drop и cgroup-лимиты придётся заменить эквивалентным
механизмом и заново подтвердить G12/G13/G14/G18.

## Границы анализа

- Анализировалось рабочее дерево `/home/yurgusev/CoffeeOrderPlatform` на
  13.11.2026, ветка `test/13-launch-gates`, HEAD `bff183ec` (рабочее дерево
  содержит незакоммиченные изменения). В этом дереве гейты ещё называются
  `G00…G19`.
- `origin/develop` (`9f9c4c75`, 13.11.2026) уже переименовал гейты в slug
  (`preflight`, `install`, `supply_chain`, …), но сохранил ту же архитектуру:
  20 гейтов, последовательный runner, лимит 120 минут, 14 `RUNTIME`-сборок.
  Для читаемости ниже используются привычные номера `G00–G19`; slug указан
  там, где это важно.
- Числа из разных прогонов не складываются в один прогноз. Они приведены как
  измеренные факты соответствующих кандидатов и дат.

## 1. Что подтверждено в текущем коде

### 1.1. Гейты: последовательная цепочка, а не граф

`verification/launch/v1/matrix.yaml` содержит 20 гейтов. Их объявленные
timeout в сумме дают **27 900 с = 465 минут**:

| Гейт | timeout, с |
|---|---:|
| `G00` preflight, `G01` install, `G02` generated, `G03` static, `G04` unit, `G05` contracts, `G06` architecture, `G07` config/security | 8 × 900 = 7 200 |
| `G12` supply chain, `G08` migrations, `G09` DB boundaries, `G10` integration, `G11` recovery, `G13` compose, `G14` observability, `G15` browser, `G16` aroma sandbox, `G17` backup/restore, `G18` rollback | 11 × 1 800 = 19 800 |
| `G19` report | 900 |
| **Итого** | **27 900 (465 мин)** |

`verification/launch/v1/run.mjs:60` задаёт общий лимит **120 минут**
(`TOTAL_TIMEOUT_MS = 120 * 60 * 1000`), а `run.mjs:2141` запускает гейты
последовательно. Даже если каждый гейт уложится в свой timeout, полный набор
не может завершиться внутри общего лимита. Это не оценка, а арифметика
текущих констант.

`run.mjs:1574` при FAIL любого predecessor записывает `NOT_RUN` и не запускает
гейт. Исключение сделано только для `G19` (`run.mjs:1467`): отчёт должен
формироваться и при отказе. В результате сохранённые полные прогоны выглядят
так:

| Run | Wall | PASS | FAIL | NOT_RUN | Решение |
|---|---:|---:|---:|---:|---|
| `20261023T145450Z-4606e17` | 37,0 с | 1 (`G19`) | 1 (`G00`) | 18 | НЕ ДОПУСТИТЬ |
| `20261023T150604Z-70f44a7` | 34,4 с | 1 (`G19`) | 1 (`G00`) | 18 | НЕ ДОПУСТИТЬ |
| `20261024T042704Z-4739a1a` | 31,7 с | 1 (`G19`) | 1 (`G00`) | 18 | НЕ ДОПУСТИТЬ |

Источники: `evidence/launch/*/run-result.json`. В `coffee_gates` последний
20-гейтовый прогон — тот же `20261024T042704Z-4739a1a`; более поздние запуски
содержат `gateCount: 0`.

`G00` — не «быстрая проверка кода». В failed preflight 33 проверки, из них
провалились `EXACT_GATE_SCRIPTS`, `CONFIG_AND_ISOLATION` и шесть handoff-ов
(`HANDOFF_2`, `_3`, `_10`, `_14`, `_19`, `_162`). Это проверка проектного
допуска, GitHub-истории и handoff-артефактов, а не изменённого кода. Запускать
её на каждое изменение и блокировать ею все 18 гейтов — смешение разных
контуров.

`run.mjs:2214` принимает только `--candidate-sha`, `--github-snapshot`,
`--accepted-base-commit` и `--openobserve-native-inputs`. Нет `--gate`,
`--from`, `--resume`, `--profile` или `--changed`. Поэтому «запустить только
static/unit» или «продолжить с G08» текущим runner невозможно.

`report.mjs` требует `PASS` всех 20 гейтов для решения `ДОПУСТИТЬ`, но статус
`G19 = PASS` означает лишь успешную генерацию отчёта. Это соответствует
замыслу, но в агрегате выглядит как один зелёный гейт при 18 `NOT_RUN`.
Предложение: отделить `report` от `admission` и не считать `G19` PASS-ом
допуска.

CI в `origin/develop` (`.github/workflows/check.yml`) запускает только
`pnpm check` на self-hosted runner с timeout 30 минут. Он не собирает образы,
не запускает G12–G18 и не является release admission. То есть «полная сборка
G00–G19» — это локальный ручной контур, а не CI-конвейер.

### 1.2. Сборка: 14 образов и повторная работа

`Dockerfile` — один общий build-stage на 14 runtime. `ARG RUNTIME` объявлен
после общего typecheck (`Dockerfile:116`), затем `pnpm deploy --prod` выбирает
один runtime (`Dockerfile:117`), а final-stage копирует `/runtime`
(`Dockerfile:169–197`). В `compose.yaml` — 14 сервисов с разными
`RUNTIME` (`compose.yaml:158–510`). Это осознанная схема «один процесс — один
образ», но у неё есть цена: каждая финальная стадия выполняет свой `deploy`,
хотя исходники, установка зависимостей, native addon и typecheck общие.

`tools/security-scan.mjs:1741` собирает 14 runtime + `storage-helper`,
`edge-nginx`, `kafka`, `openobserve`; результат каждого build — OCI-layout
(`:1719–1720`), затем сканируется и удаляется. `tools/compose-smoke.mjs:1588–1628`
для G13 заново вызывает `docker-build.mjs` **по одному runtime в цикле**,
14 раз плюс nginx, с `--load`. `G18` использует тот же `buildRuntimeImages`
(`tools/compose-smoke.mjs:9339–9341`). Передачи «G12 собрал — G13/G14/G18
загрузили те же digest» в коде нет.

Измерения:

| Измерение | Значение | Условия |
|---|---:|---|
| 5 последовательных Node-сборок, 13.11.2026 | 117,7 + 52,4 + 38,5 + 58,6 + 41,3 = **308,5 с** | тёплый BuildKit, 30/43 cached steps |
| G12, 14 Node-образов, 01.11.2026 | **988,817 с** | Source `883c207`, OCI export + scan |
| G12, 9 сопоставленных Node-образов | **643,107 с** | тот же прогон, против 103,463 с у DD0 |
| G12 целиком, 01.11.2026 | **1 696,201 с** | PASS, 46 отчётов |
| G12 целиком, DD0 | **804,095 с** | PASS, другой кандидат |
| G14 operations-component, 31.10.2026 | **3 642,041 с** | не полный G14, другой SHA |

Все строки — фактические измерения, но из разных прогонов и дат. G14 — это
operations-component, а не полный G14. Их нельзя сложить в обещание «полный
прогон за N минут».

Причина, по которой G12 не укладывается в бюджет, также зафиксирована:
25.10.2026 G12 остановился на 1800 с, выполнив **21 из 38** обязательных
отчётов; в другом прогоне было **18 проверенных образов и 0 отчётов** из-за
disk budget (`evidence/launch-preparation/2026-10-25/runtime-results-*.json`).
То есть проблема не только в скорости Node-сборки, но и в последовательном
build → scan → convert внутри одного гейта.

Текущий builder: 4 CPU, 5 ГиБ RAM, `max-parallelism = 2`
(`~/.docker/buildx/coffee-platform-mtu.toml`, `docker buildx inspect`).
Поэтому «просто распараллелить 14 сборок» ограничено двумя одновременно.

Влияние изменений неоднородно. По `package.json` workspace:

- изменение `packages/platform-runtime`, `platform-config`, `platform-database`,
  `platform-observability`, `platform-security`, `platform-time` затрагивает
  **все 14** runtime;
- изменение `apps/orders-service` затрагивает только orders-service (и его
  тесты/потребителей контрактов);
- изменение `packages/contracts/client-v1` затрагивает api-public, web,
  api-internal и соответствующих потребителей.

Поэтому «собирать только изменённое» даёт выигрыш на локальных правках
сервисов, но не на изменениях общих пакетов. Для release-кандидата всё равно
нужен полный набор образов; вопрос лишь в том, чтобы собрать его **один раз**.

### 1.3. Docker — это действующая runtime-authority, а не только упаковка

`docs/adr/ADR-0019-greenfield-node26-and-service-topology.md:94–95` фиксирует:
«Один container содержит один process role. Масштабирование — replicas, не
PM2/`node:cluster`». `docs/launch/00_SCOPE_AND_DECISIONS.md:17`:
«Docker Compose — первое воспроизводимое окружение; Kubernetes для первой
версии не нужен».

Compose даёт не только изоляцию, но и конкретные гарантии:
`read_only: true`, `user: "node"`, `cap_drop: ALL`,
`no-new-privileges:true`, tmpfs для `/tmp` и `/run/secrets`, healthcheck,
`stop_grace_period: 30s`, cgroup-лимиты (`compose.yaml:4–34`, `109–115`).
Секреты монтируются в `/run/secrets/coffee-platform.yaml`
(`compose.yaml:20–21`), конфигурация — в `/app/config/platform.yaml`;
permission-манифесты разрешают чтение `/app/config/platform.yaml` и `/app/dist`
(`config/platform.yaml:563`, `:605`, `:648`).

Хост технически готов к native-запуску: Ubuntu 24.04, systemd 255, Node
`v26.8.1` в `/home/yurgusev/.local/usr/bin/node`. Но в коде нет systemd-units:
все 14 сервисов слушают `0.0.0.0` (`config/platform.yaml:533–1199`), а
healthcheck вызывается как Docker-команда (`compose.yaml:25–28`). Native-путь
потребует как минимум:

- заменить `/app/...` на пути release-каталога или bind-mount;
- перевести listeners на `127.0.0.1` и развести порты;
- заменить Docker-DNS (`coffee_postgres`, `kafka`) на hosts/DNS;
- воспроизвести read-only root, cap-drop, no-new-privileges, tmpfs-секреты,
  cgroup-лимиты и network policy;
- сохранить nginx TLS и Kafka KRaft либо оставить их контейнерами.

Это не «убрать Docker-сборку», а переписать runtime-контур и заново собрать
доказательства G12/G13/G14/G18.

### 1.4. Обновление сейчас — ручной release-каталог

В `/home/yurgusev/coffee-platform/runtime/releases` лежат **7** неизменяемых
release-каталогов. В каждом есть `release.json` с `sourceSha`, `configSha256`,
`encryptedSecretsSha256`, 15 `runtimeImages` (по `imageId`), `kafkaImageId`,
хешами nginx/browser-assets/compose и сертификатами. Файлы и каталоги
read-only (`dr-x------`, `-r--------`). Это хорошая основа для promote/rollback.

Но в репозитории нет producer/consumer этого манифеста: поиск
`runtimeImages`/`steadyComposeSha256` не находит кода в `tools/`, `scripts/`,
`verification/`, `packages/`, `apps/`. `release.json` — исторический артефакт
ручной сборки, а не исполняемая автоматизация. `tools/coffee-containers.sh`
умеет только `status/start/stop/remove` существующих контейнеров и прямо
говорит: «Новые контейнеры не создаются» (`tools/coffee-containers.sh:1–8`).
`G18` в ADR-0035 — это config-only rollback (`mutationsEnabled: true → false`),
а не откат релиза по `release.json`.

Отсюда практический вывод: автоматизация обновления начинается не с выбора
Docker/Nix, а с формализации **release manifest → deploy → health → rollback**.
Этот манифест уже почти есть; ему не хватает producer/consumer, статуса
`current`, health-гейта и автоматического отката.

## 2. Как это решают другие

### 2.1. Не запускать всё на каждое изменение

OpenObserve (фиксированный upstream-коммит, используемый проектом) в PR
workflow сначала классифицирует изменения: `check_changes` вычисляет
`has_backend_changes`/`has_ui_changes`, и соответствующие suite запускаются
только при наличии изменений. Релизный workflow запускается отдельно по тегам
`v*.*.*` и собирает production-бинарники с `--profile release-prod`:
[unit-tests.yml](https://github.com/openobserve/openobserve/blob/ed07b6e287da91b0a2d7be8dd061599200e0cd15/.github/workflows/unit-tests.yml),
[release.yml](https://github.com/openobserve/openobserve/blob/ed07b6e287da91b0a2d7be8dd061599200e0cd15/.github/workflows/release.yml).
Это прямой пример разделения «быстрая проверка изменения» и «release-сборка».

Turborepo строит кэш по fingerprint входов задачи и умеет remote cache,
чтобы не выполнять одну и ту же задачу на разных машинах:
[caching](https://turborepo.dev/docs/crafting-your-repository/caching),
[remote caching](https://turborepo.dev/docs/core-concepts/remote-caching).
Bazel использует content-addressed remote cache для результатов actions:
[remote caching](https://bazel.build/remote/caching). Nx документирует
`affected`-запуск только для затронутых проектов:
[affected](https://nx.dev/docs/features/ci-features/affected).

### 2.2. Собирать один раз и продвигать артефакт

Официальный пример pnpm для монорепозитория делает один build-stage,
несколько `pnpm deploy --filter=...` и отдельные target-образы:
[pnpm Docker, example 2](https://pnpm.io/docker). Это почти текущая схема,
но у pnpm target-образы собираются из **одного** build-stage, а не запускают
общий typecheck/deploy заново для каждого образа.

Docker BuildKit рекомендует порядок слоёв, cache mounts и внешний cache
(`--cache-from`/`--cache-to`), а `docker buildx bake` позволяет собирать
несколько targets одной командой и параллельно:
[cache optimization](https://docs.docker.com/build/cache/optimize/),
[bake](https://docs.docker.com/build/bake/).
Текущий G12 уже умеет отдавать OCI-layout (`type=oci`), значит ему не хватает
только lifecycle: сохранить digest и передать его следующему гейту.

### 2.3. Как автоматизируют обновление и откат

- **Kubernetes Deployment**: rolling update, readiness, `progressDeadline`,
  история ревизий и `kubectl rollout undo`:
  [Deployments](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/).
- **Kamal** (37signals): собирает образ, поднимает новый контейнер, переключает
  трафик только после `200 OK` на `/up`, затем останавливает старый;
  `kamal rollback <version>` возвращает предыдущий образ без загрузки из
  registry: [deploy](https://kamal-deploy.org/docs/commands/deploy/),
  [rollback](https://kamal-deploy.org/docs/commands/rollback/).
- **Podman auto-update**: systemd-юнит с `AutoUpdate=registry` проверяет digest,
  подтягивает новый образ и перезапускает unit; `--rollback` по умолчанию
  `true`, но для надёжного определения неудачи нужен `sdnotify=container`:
  [podman-auto-update](https://docs.podman.io/en/latest/markdown/podman-auto-update.1.html).
- **NixOS**: `nixos-rebuild switch --rollback` возвращает предыдущую генерацию;
  `system.autoUpgrade` запускает `nixos-rebuild switch --upgrade` по таймеру:
  [rollback](https://github.com/NixOS/nixpkgs/blob/master/nixos/doc/manual/administration/rollback.section.md),
  [auto-upgrade.nix](https://github.com/NixOS/nixpkgs/blob/master/nixos/modules/tasks/auto-upgrade.nix).
  Сам `autoUpgrade` не проверяет здоровье приложения; `deploy-rs` добавляет
  `autoRollback` и `magicRollback` с подтверждением доступности после
  активации: [deploy-rs](https://github.com/serokell/deploy-rs).
- **Fedora CoreOS**: Zincati + rpm-ostree дают атомарные обновления ОС и
  ручной `rpm-ostree rollback -r`; это уровень ОС, не приложения:
  [auto-updates](https://docs.fedoraproject.org/en-US/fedora-coreos/auto-updates/).
- **systemd** для native-варианта: `RuntimeDirectory=`, `LoadCredential=`,
  `ProtectSystem=strict`, `NoNewPrivileges=`, `Restart=on-failure`,
  `TimeoutStopSec=` (проверено локально `man systemd.exec`, `man systemd.service`).
  systemd не умеет сам обновлять приложение: нужен timer/CI-джоб, который
  вызывает deploy-скрипт.

Общая практика: обновление — это **immutable artifact + health-gated switch +
предыдущая версия для отката**. Автоматизация без health-гейта (просто
`systemctl restart` или `docker compose up -d`) не даёт отката и не является
безопасным обновлением.

## 3. Варианты

### Вариант A. Build-once + выборочные гейты, Docker остаётся

**Идея.** Один раз собрать все образы кандидата, сохранить их digest и
сканы, а гейты сделать потребителями артефакта, а не повторными сборщиками.
Одновременно разнести «быструю проверку изменения» и «release admission».

**Что меняется.**

1. `tools/build-artifacts.mjs` (или расширение `security-scan`) собирает
   14 Node + инфраструктурные образы один раз в OCI-layout и пишет
   `artifact-manifest.json`:
   `candidateSha`, `sourceTreeSha`, `toolchainSha`, `configSha256`,
   `images[{service, imageId, manifestDigest, sbomSha256, scanSha256}]`,
   `previousManifest`.
2. `G12` заполняет scan/SBOM и валидирует digest; `G13`, `G14`, `G18`
   загружают те же digest (`docker load`/`buildx imagetools`) и не вызывают
   `buildRuntimeImages`.
3. В `run.mjs` появляются `--profile fast|release`, `--gate`, `--from`,
   `--resume`, `--artifact-manifest`; матрица получает `scope`/`reuse`.
4. `G00` разделяется на `preflight-lite` (контекст, SHA, конфиг, скрипты) и
   `admission-preflight` (handoff/GitHub), который выполняется один раз на
   release-кандидата и переиспользуется по SHA.
5. `G19` больше не может быть `PASS`, если обязательные гейты не `PASS`;
   отчёт получает статус `REPORTED`, а решение — отдельно.
6. Evidence кэшируется по ключу
   `treeSha + toolchainSha + configSha + artifactDigest`; TTL и инвалидация
   при изменении входа.

**Обновление.** `release.json` становится исполняемым: deploy берёт digest из
манифеста, поднимает изменённые сервисы, ждёт readiness, записывает
`current.json`; при FAIL возвращает `previousManifest`. Откат — это deploy
предыдущего манифеста, а не пересборка.

**Плюсы.** Не меняет runtime и security-модель; убирает дублирующие сборки;
сохраняет G12/SBOM/provenance; даёт измеримый эффект; можно внедрять
инкрементально.

**Минусы.** Docker остаётся; полный release-набор тестов всё равно нужен;
14 образов и общий build-stage остаются; G14 по-прежнему длинный; нужен
artifact store и контроль свободного места.

**Когда выбирать.** Первым. Это минимальное изменение с максимальным
устранением боли.

### Вариант B. Per-service build graph + тонкие образы, Docker остаётся

**Идея.** Разделить общий build-stage и финальные образы так, чтобы базовый
слой (Node, librdkafka, production dependencies) собирался один раз, а образ
сервиса добавлял только `dist` и его manifest. Собирать только затронутые
сервисы; release — все, но параллельно через Bake.

**Что меняется.**

- `Dockerfile.base` (Node + librdkafka + `pnpm fetch`/prod deps) с digest-тегом.
- 14 target-ов в `docker-bake.hcl`; каждый target копирует `dist` и
  `package.json` из общего build-stage, как в
  [pnpm Docker example 2](https://pnpm.io/docker).
- `pnpm deploy --filter` только для затронутых; для общих пакетов — все 14.
- Теги/ключи кэша: `baseDigest + sourceHash(service)`; Bake собирает
  targets параллельно (фактический параллелизм ограничен builder-ом).
- Альтернатива для сокращения числа образов: 1 общий runtime-образ со всеми
  14 entrypoints или 3 семейства (stateless gateways, DB owners, Kafka workers).
  Это уменьшает число сборок и сканов, но увеличивает содержимое образа и
  blast radius; требует отдельного решения по least privilege.

**Плюсы.** Быстрее локальный и PR-цикл; меньше повторных `deploy`; можно
собирать только затронутое; сохраняются OCI-гарантии.

**Минусы.** Больше Dockerfile/target-ов; базовый слой большой; кэш зависит от
lockfile и native addon; 14 контейнеров остаются; общие пакеты всё равно
затрагивают все сервисы; нужна аккуратная проверка, что thin image не потерял
production dependency.

**Когда выбирать.** После A, если измерения покажут, что сборка остаётся
доминирующей.

### Вариант C. Native systemd release bundles, без Docker для Node

**Идея.** Собирать не образы, а неизменяемый release-каталог:
`dist`, production `node_modules`, native addon/librdkafka, config,
nginx.conf, browser assets. Запускать 14 Node-процессов через systemd units,
nginx — нативно, Kafka — нативно или оставить контейнером, PostgreSQL уже
внешний.

**Что меняется.**

- `tools/release-native.mjs`: staging в
  `/opt/coffee/releases/<sha>/`, проверка hash, `chown root`, read-only.
- `coffee-runtime@.service` (шаблон) с
  `ExecStart=/opt/coffee/node/26.8.1/bin/node .../dist/main.js`,
  `Restart=on-failure`, `TimeoutStopSec=30`, `KillSignal=SIGTERM`,
  `NoNewPrivileges=yes`, `ProtectSystem=strict`, `ProtectHome=yes`,
  `PrivateTmp=yes`, `CapabilityBoundingSet=`,
  `RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX`,
  `RuntimeDirectory=coffee/%i`, `MemoryMax=`, `CPUQuota=`.
- Секреты: `config-bootstrap` материализует scoped-файл в
  `/run/coffee/<service>/secrets.yaml`; `COFFEE_RUNTIME_SECRETS_FILE`
  указывает туда. Текущий loader не требует именно `/run/secrets`, но nginx
  и compose-контракт — требуют, поэтому пути надо согласовать.
- Listeners: `127.0.0.1:<port>` вместо `0.0.0.0`; nginx — единственный
  публичный `127.0.0.1:8443`.
- Docker-DNS (`coffee_postgres`, `kafka`) заменить на `/etc/hosts`/локальный
  DNS или явные адреса.
- Network policy: `IPAddressAllow=`/`IPAddressDeny=` или nftables; это
  замена Docker networks, а не автоматическая.
- Обновление: `current -> releases/<sha>`; `systemctl restart` изменённых
  units; health-check; при FAIL — `current` на предыдущий release и restart.
  `systemd` timer/CI вызывает deploy-скрипт; автоматический `system.autoUpgrade`
  без health-проверки не использовать.

**Плюсы.** Нет Docker daemon и 14 контейнеров; меньше постоянного overhead;
systemd уже есть на хосте; атомарный symlink-rollback; прозрачные логи и
cgroup-лимиты.

**Минусы.** Придётся заново реализовать и доказать read-only root, cap-drop,
no-new-privileges, tmpfs-секреты, network isolation, healthcheck и graceful
stop; 14 units и 14 пользователей; сложнее egress-политика;	native nginx/Kafka
и их обновление; G12 теряет OCI-сканы (нужны SBOM/scan для файловых
артефактов); ADR-0019 требует superseding; G13/G14/G18 нужно переписать.
Это не «убрать Docker», а «сменить runtime-authority».

**Когда выбирать.** Только если Docker сам по себе является проблемой
(daemon, память, политика), и после пилота на 1–2 сервисах. Не начинать с
этого.

### Вариант D. Nix/NixOS: декларативные генерации

**Идея.** Описать Node 26, зависимости, native addon, конфигурацию, nginx и
systemd-units в Nix; собирать в `/nix/store`, доставлять через binary cache;
переключать генерации; откатываться на предыдущую.

**Что меняется.** Nix-derivation на каждый runtime; `sops-nix`/agenix для
SOPS-секретов; `systemd.services` для 14 процессов; `nixos-rebuild switch`
или `deploy-rs`; `system.autoUpgrade` — только для ОС/базовой части.
Nix кэширует по входным derivations, поэтому изменение одного сервиса не
пересобирает остальные; binary cache ускоряет CI.

**Плюсы.** Самая сильная воспроизводимость и атомарность; generations и
rollback; единый язык для ОС и приложения; хороший remote cache; deploy-rs
даёт autoRollback/magicRollback.

**Минусы.** Высокий порог входа; нужно упаковать Node/native addon/librdkafka;
текущие SOPS- и permission-контракты придётся интегрировать; NixOS на
Ubuntu-хосте — отдельный слой; G12/G13/G14 нужно переосмыслить; нет прямого
соответствия текущим Docker-доказательствам. Это самая большая миграция.

**Когда выбирать.** Если проект готов перейти на NixOS/deploy-rs и есть
экспертиза. Не для первого шага.

### Вариант E. Podman/Quadlet: убрать Docker daemon, оставить OCI

**Идея.** Оставить контейнеры и образы, но запускать их через systemd
(Quadlet) и Podman, без Docker daemon и Compose.

**Что меняется.** 14 `.container` units + network units; `AutoUpdate=registry`;
`Secret=` для scoped-секретов; `--sdnotify=container` (приложение должно
поддержать `sd_notify`); `podman auto-update` по таймеру; `--rollback`
вернёт предыдущий образ при неудачном restart. Сборка — Buildah/Podman или
текущий BuildKit (образы OCI совместимы).

**Плюсы.** Нет Docker daemon; systemd-нативный lifecycle; встроенные
auto-update/rollback; сохраняется OCI-изоляция и digest; меньше изменений,
чем native.

**Минусы.** Всё ещё контейнеры; нужно переписать Compose-топологию и тесты;
сетевые политики/секреты другие; auto-update требует fully-qualified image ref
и `sdnotify`; rollback работает только если unit действительно failed;
текущие G13/G14 Compose-проверки не переиспользуются.

**Когда выбирать.** Если цель — именно «убрать Docker», а не «убрать
контейнеры». Хороший промежуточный шаг перед native/Nix.

### Вариант F. Kubernetes

Не рекомендуется для первого запуска: текущий scope прямо исключает
Kubernetes (`docs/launch/00_SCOPE_AND_DECISIONS.md:44`), а выигрыш
rolling update/rollback не оправдывает cluster, ingress, secrets, network
policy и ops. Kubernetes имеет смысл только после появления нескольких хостов
и доказанной потребности в оркестрации.

## 4. Сравнение

| Вариант | Docker | Один build на кандидата | Атомарное обновление | Откат | Паритет security | Сложность | Рекомендация |
|---|---|---|---|---|---|---|---|
| A. Build-once + гейты | да | да | через release manifest | предыдущий manifest | сохраняется | средняя | **первый** |
| B. Per-service thin images | да | да, по affected | через manifest | предыдущий manifest | сохраняется | средняя | после A |
| C. Native systemd | нет | да (release dir) | symlink | symlink + restart | нужно доказывать | большая | пилот 1–2 сервиса |
| D. Nix/NixOS | нет | да (derivations) | generation | `switch --rollback` | нужно доказывать | очень большая | долгосрочно |
| E. Podman/Quadlet | нет daemon | да | systemd unit | `auto-update --rollback` | близко к OCI | средне-большая | если цель — убрать Docker |
| F. Kubernetes | нет (containerd) | да | Deployment | `rollout undo` | близко | очень большая | не сейчас |

## 5. Рекомендуемый порядок

### Этап 1 — A, без смены runtime

1. Разделить `fast` и `release` профили; вынести `G00` admission в отдельный
   запуск; добавить `--gate/--from/--resume`.
2. Сделать `artifact-manifest` и один build на кандидата; G12→G13→G14→G18
   передают digest, а не собирают заново.
3. Сделать `G19` отчётом, а не PASS-ом допуска; отчёт должен явно показывать
   `NOT_RUN` и причину.
4. Ввести DAG-параллелизм там, где он безопасен, с учётом 8 CPU/14 ГиБ хоста
   и 4 CPU/5 ГиБ builder-а. Не обещать параллелизм, пока не измерен peak RSS.

Критерии приёмки этапа:

- на один кандидат — **один** build каждого образа; в G13/G14/G18 —
  **ноль** вызовов `docker buildx`;
- `pnpm launch:verify --profile fast` не запускает `G12–G18`;
- повторный `--gate static` не запускает `G00` и не пересобирает образы;
- `run-result` с 18 `NOT_RUN` не показывает `G19` как допуск;
- G13/G14 получают те же `manifestDigest`, что G12.

### Этап 2 — B, если сборка остаётся узким местом

Разделить base/thin images и включить affected-сборку. Критерий: время
сборки одного сервиса и 14 сервисов измерено отдельно; общие пакеты
по-прежнему запускают все 14.

### Этап 3 — E или C/D, только после отдельного ADR

Сначала пилот Podman/Quadlet на 2 сервисах (например, `edge-gateway` и
`api-public`) с проверкой mTLS, секретов, readiness и rollback. Native
systemd или Nix — только если пилот докажет, что Docker daemon/память/политика
являются реальной проблемой, а security-паритет воспроизводим.

## 6. Что нельзя делать

- Поднимать timeout G14/main до 90/120 минут без переработки critical path:
  владелец 31.10.2026 выбрал вариант «сначала оптимизировать, лимиты 30/120
  не менять».
- Запускать полный G00–G19 на каждое изменение: это release admission, а не
  dev loop.
- Считать `G19 PASS` доказательством допуска.
- Убирать Docker до того, как заменены read-only root, cap-drop,
  no-new-privileges, tmpfs-секреты, network policy и healthcheck.
- Автоматически обновлять production без health-гейта и предыдущего артефакта.

## 7. Что нужно измерить до выбора

1. Полный cold/warm build 14 образов и отдельно — время `pnpm deploy` на
   каждый runtime.
2. Время передачи/загрузки OCI-артефактов в G13/G14/G18 (сейчас не измерено).
3. Декомпозицию G14 3 642 с: какие фазы дают вклад; что можно перекрыть
   без общей Compose/Collector-гонки.
4. Долю изменений, затрагивающих общие пакеты (14 сервисов), против локальных
   изменений сервиса.
5. Для native/Podman: реальный security-паритет (read-only, cap-drop,
   network allowlist, секреты, graceful stop) и стоимость 14 units.
6. Для Nix: стоимость упаковки Node/native addon и работа SOPS-интеграции.

## 8. Источники

### Репозиторий

- `verification/launch/v1/matrix.yaml` — 20 гейтов и timeout.
- `verification/launch/v1/run.mjs:60,1467,1574,2141,2214` — лимит 120 минут,
  последовательный запуск, G19-исключение, CLI без выбора гейтов.
- `verification/launch/v1/report.mjs` — `ДОПУСТИТЬ` только при 20 PASS.
- `evidence/launch/20261023T145450Z-4606e17/run-result.json`,
  `.../20261023T150604Z-70f44a7/run-result.json`,
  `.../20261024T042704Z-4739a1a/run-result.json` — 31,7–37,0 с, G00 FAIL,
  18 NOT_RUN, G19 PASS.
- `evidence/launch/20261024T042704Z-4739a1a/gates/G00_PREFLIGHT/artifacts/preflight.json`
  — 33 проверки, failed handoff/scripts/config.
- `evidence/launch-preparation/2026-10-25/runtime-results-20261025T160847Z.json`
  — G12: 21/38 отчётов за 1800 с.
- `Dockerfile:10–197` — build stages, `ARG RUNTIME`, `pnpm deploy`, final.
- `compose.yaml:4–34,109–115,152–510` — 14 runtime build, security defaults.
- `tools/security-scan.mjs:1719–1741` — OCI output и 14+infra targets.
- `tools/compose-smoke.mjs:1588–1628,9339–9341` — последовательная сборка
  14+nginx и повторная сборка в G18.
- `config/platform.yaml:533–1199` — `0.0.0.0`, `/app`-пути.
- `docs/adr/ADR-0019-greenfield-node26-and-service-topology.md:94–95` —
  один container на process role.
- `docs/launch/00_SCOPE_AND_DECISIONS.md:17,44` — Compose first, Kubernetes
  вне первого запуска.
- `tools/coffee-containers.sh:1–8` — только существующие контейнеры.
- `/home/yurgusev/coffee-platform/runtime/releases/*/release.json` — 7
  release-манифестов с image ID и хешами.
- `docs/reports/launch` и `evidence/launch` — прежние evidence-прогоны.
- `/home/yurgusev/Documents/Obsidian Vault/Проекты/CoffeeOrderPlatform/Скорость сборки образов.md`
  — измеренные G12 804,095/1 696,201 с и 14 Node 988,817 с.
- `/home/yurgusev/Documents/Obsidian Vault/Проекты/CoffeeOrderPlatform/Длительность итоговой проверки.md`
  — G14 operations-component 3 642,041 с и решение владельца о лимитах 30/120.

### Внешние источники

- OpenObserve:
  [unit-tests.yml](https://github.com/openobserve/openobserve/blob/ed07b6e287da91b0a2d7be8dd061599200e0cd15/.github/workflows/unit-tests.yml),
  [release.yml](https://github.com/openobserve/openobserve/blob/ed07b6e287da91b0a2d7be8dd061599200e0cd15/.github/workflows/release.yml).
- pnpm: [Docker / multi-image monorepo](https://pnpm.io/docker).
- Docker: [cache optimization](https://docs.docker.com/build/cache/optimize/),
  [Bake](https://docs.docker.com/build/bake/).
- Turborepo: [caching](https://turborepo.dev/docs/crafting-your-repository/caching),
  [remote caching](https://turborepo.dev/docs/core-concepts/remote-caching).
- Bazel: [remote caching](https://bazel.build/remote/caching).
- Nx: [affected](https://nx.dev/docs/features/ci-features/affected).
- Kubernetes: [Deployments](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/).
- Kamal: [deploy](https://kamal-deploy.org/docs/commands/deploy/),
  [rollback](https://kamal-deploy.org/docs/commands/rollback/).
- Podman: [auto-update](https://docs.podman.io/en/latest/markdown/podman-auto-update.1.html).
- NixOS: [rollback](https://github.com/NixOS/nixpkgs/blob/master/nixos/doc/manual/administration/rollback.section.md),
  [auto-upgrade.nix](https://github.com/NixOS/nixpkgs/blob/master/nixos/modules/tasks/auto-upgrade.nix).
- deploy-rs: [README](https://github.com/serokell/deploy-rs).
- Fedora CoreOS: [auto-updates](https://docs.fedoraproject.org/en-US/fedora-coreos/auto-updates/).

## Ограничения

- Числа G12/G14 из разных кандидатов и дат; они не являются единым
  benchmark и не доказывают, что после build-once полный прогон уложится в
  120 минут.
- Влияние изменений на 14 сервисов вычислено по `package.json` workspace, без
  анализа фактического графа импортов на уровне файлов.
- Оценки сложности качественные; трудозатраты не измерялись.
- Native/Podman/Nix варианты не проверялись запуском; их security-паритет
  требует отдельного proof.
- `origin/develop` уже переименовал гейты; конкретные имена файлов/строк в
  отчёте относятся к текущему рабочему дереву и могут отличаться в develop.
