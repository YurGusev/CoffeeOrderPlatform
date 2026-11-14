# Карта потоков образов в гейтах запуска

Статус: действует. Относится к `verification/launch/v1/**`, `tools/**`,
`tests/**` и документации первого запуска. Документ описывает существующее
поведение; он не вводит новый контракт манифеста и не разрешает новую сборку.

Документ отвечает на три вопроса:

1. какие runtime-образы собирает `supply_chain` и где публикуется результат;
2. какие гейты используют опубликованные образы, а какие не работают с ними;
3. в каких местах ещё вызывается `docker buildx build` и что это переключает.

Строки указаны по текущему состоянию файлов. Ориентиром при сдвиге строк
служат имена функций, констант и переменных, приведённые рядом.

## 1. Термины и границы

- **Runtime-образы** — 15 образов, которые запускает Compose: 14 Node-runtime из
  `RUNTIME_NAMES` плюс `edge-nginx`
  (`packages/platform-config/src/index.ts:30-45`,
  `tools/compose-smoke.mjs:1327`, `tools/security-scan.mjs:70-73`).
- **Инфраструктурные образы** — `kafka`, `grafana`, `otel-collector`,
  `keycloak`, `storage-helper`. Они собираются тем же гейтом
  `supply_chain`, но не входят в inventory runtime-образов
  (`tools/security-scan.mjs:2644-2653`).
- **Upstream-образы** — `loki`, `prometheus`, `tempo`. Они не собираются:
  `supply_chain` тянет их по digest из `config/toolchain-versions.json` и
  сканирует (`tools/security-scan.mjs:53-57`, `2787-2865`).
- **Launch context** — `context.json` запуска, который передаётся гейтам через
  `COFFEE_LAUNCH_CONTEXT_FILE`. Из него выводятся `runId`, `candidateSha`,
  `evidenceDir` и `resources.composeProject`
  (`verification/launch/v1/run.mjs:998-1020`, `740-766`).
- **Inventory** — файл `artifacts/image-inventory.json` в evidence
  `supply_chain`. Он описывает только 15 runtime-образов и является входом для
  Compose-гейтов, а не заменой OCI-артефактам инфраструктурных образов
  (`tools/image-inventory.mjs:6-8`, `68-74`).
- **Verified artifact** — OCI-архив и receipt `supply_chain`, по которым
  потребитель загружает инфраструктурный образ в Docker daemon и сверяет
  image ID (`tools/verified-infrastructure-image.mjs:312-392`, `1015-1035`).

Граница документа: локальный деплой `tools/platform-service.mjs` упомянут
только как разрешённая точка сборки вне launch; его устройство здесь не
описывается.

## 2. Канонический поток

В полном launch-прогоне источник runtime-образов один:

```text
supply_chain (pnpm security:scan)
  ├─ собирает 14 Node runtime + edge-nginx + 5 инфраструктурных образов
  │  через docker buildx build;
  ├─ публикует 15 runtime-образов в Docker daemon под тегами проекта запуска;
  ├─ пишет OCI-артефакты и receipts для всех собранных образов;
  └─ пишет artifacts/image-inventory.json только при PASS.

compose / integration / recovery ── compose-smoke
  └─ readLaunchImageInventory → imageMode = "reuse" → docker compose up --no-build

observability ── tools/observability/verify.mjs
  ├─ loadVerifiedGateImage для инфраструктурных образов;
  └─ runBrowserProof → дочерний compose-smoke → reuse runtime-образов

browser ── verification/launch/v1/scenarios/browser.mjs
  └─ дочерний compose-smoke --browser-proof → reuse runtime-образов

rollback ── verification/launch/v1/scenarios/rollback.mjs
  └─ дочерний compose-smoke --mutation-disable-rollback → reuse runtime-образов
```

Правило, которое следует из этой схемы: в launch-прогоне канонические
runtime-образы собирает только `supply_chain`; остальные гейты обязаны
использовать опубликованный inventory или verified artifact. Сборка внутри
`compose-smoke` допустима только для standalone-запуска без launch context —
это отладочный путь, а не часть полного прогона.

Отдельно нужно различать **fixture-сборки**: `observability` и `browser`
собирают вспомогательные `edge-nginx` и нативный `realtime-gateway` из
рабочего дерева для своих тестовых стендов. Эти образы не являются
каноническим набором запуска и не публикуются в inventory; они перечислены в
разделе 3.3 и являются кандидатами на устранение в successor-задачах.

## 3. Сборка

### 3.1 Единственная обёртка `docker buildx build`

`tools/docker-build.mjs:134-148` — единственная production-обёртка, которая
собирает argv `docker buildx build`, подготавливает builder `coffee-platform-mtu`
и запускает `docker buildx build` через `spawnSync`. Скрипт `pnpm image:build`
указывает на этот файл (`package.json:77`).

`tools/security-scan.mjs` содержит второй, независимый вызов buildx:
`imageBuildArgs` формирует аргументы (`tools/security-scan.mjs:2541-2624`),
`buildProductImages` запускает их (`2626-2700`, вызов `run("docker", args)` на
`2688`). Это единственная точка, где собирается полный набор образов запуска.

### 3.2 Где вызывается `buildRuntimeImages`

`buildRuntimeImages` определена в `tools/compose-smoke.mjs:1649-1691`. Она
проходит по переданным runtime-сервисам, вызывает
`tools/docker-build.mjs` для каждого (`1661-1668`) и отдельно собирает
`edge-nginx` (`1679-1690`).

| Место вызова | Что собирает | Когда достижимо |
| --- | --- | --- |
| `tools/compose-smoke.mjs:10565` | Все `RUNTIMES` или их подмножество, плюс `edge-nginx`; выбор зависит от proof-режима | Только при `imageMode === "build"` (`10541-10549`), то есть без опубликованного inventory, без ownership-ready и без rollback-образов |
| `tools/platform-service.mjs:867` | Недостающие runtime-образы для локального деплоя | Только локальный деплой, вне launch |
| `tests/realtime/fixtures/setup.mjs:1217` | `edge-gateway`, `api-public`, `realtime-gateway`, `edge-nginx` для подготовки realtime qualification | Подготовка qualification (`tests/realtime/fixtures/setup.mjs:1206-1235`), не команда одного из 20 гейтов |
| `tests/compose/topology.test.mjs:2322`, `2339`, `2345`, `2354` | Тестовые вызовы с подменённым Docker | Unit-тесты; реальный `docker buildx build` не запускается |

Вызов в `tools/compose-smoke.mjs:10565` — единственное место, где
`buildRuntimeImages` может выполниться в ходе запуска гейта. Он защищён
условием `imageMode === "build"` и проверкой `!options.noBuild &&
!rollbackRuntimeImages` (`10549`).

### 3.3 Где ещё выполняется `pnpm image:build`

Кроме `buildRuntimeImages`, канонический Dockerfile запускается через
`pnpm image:build` в тестовых фикстурах. Эти вызовы не публикуют образы в
inventory и не заменяют `supply_chain`.

| Место вызова | Что собирает | Достижимость в launch |
| --- | --- | --- |
| `tests/observability/launch-path.mjs:452-460` | `edge-nginx` из `apps/edge-nginx/Dockerfile` | `observability`: стенд `runLaunchPath` (`tools/observability/verify.mjs:5800-5816`) |
| `tests/realtime/fixtures/setup.mjs:1256-1263` | `runtime` с `RUNTIME=realtime-gateway` (нативный Node-адаптер) | `observability` и `browser`: `launch-path` и `owner-browser`; при переданном `qualification` этот путь не выполняется |
| `tests/realtime/fixtures/owner-browser.mjs:297-305` | `edge-nginx` | `browser`: `owner-browser` (`verification/launch/v1/scenarios/browser.mjs:1785`); также вызывается из `observability` через `runBrowserParent` |
| `tests/nginx/fixtures/served-backend.mjs:75-83` | `edge-nginx` | Не гейт запуска: `test:web-served-surface` / nginx cutover |
| `tests/nginx/image.test.mjs:163` | `edge-nginx` | Не гейт запуска: `test:nginx-image` |
| `tests/nginx/cutover.test.mjs:407` | `edge-nginx` | Не гейт запуска: `test:nginx-cutover` |

Отдельно: `scripts/launch-run.mjs:451-458` вызывает `tools/security-scan.mjs`
напрямую в pre-launch режиме, а `scripts/launch-run.mjs:468-478` запускает
`tools/realtime-capacity.mjs` для подготовки qualification. Это обёртки вокруг
того же канонического пути, а не отдельные гейты.

### 3.4 Как `compose-smoke` выбирает build или reuse

Ключевая логика находится в `tools/compose-smoke.mjs:10541-10549`:

- при наличии `launchImageInventory` выбирается `reuse`;
- при `ownedImagePhase === "ready"` или отсутствии недостающих ownership-ссылок
  выбирается `reuse`;
- иначе выбирается `build`, и при `!options.noBuild` вызывается
  `buildRuntimeImages` (`10549-10565`).

`launchImageInventory` читается из evidence `supply_chain` при наличии
`COFFEE_LAUNCH_CONTEXT_FILE` (`tools/compose-smoke.mjs:9548-9556`). Если
inventory отсутствует, но `result.json` гейта `supply_chain` уже существует,
чтение завершается ошибкой `IMAGE_INVENTORY_MISSING`
(`tools/image-inventory.mjs:330-338`): тихая пересборка вместо опубликованного
набора запрещена.

Переключатели:

- `COFFEE_LAUNCH_CONTEXT_FILE` — включает чтение inventory и привязку к
  `evidenceDir`/`composeProject` (`verification/launch/v1/run.mjs:740-766`);
- `COFFEE_LAUNCH_IMAGE_OWNERSHIP` — путь к
  `gates/integration/artifacts/runtime-image-ownership.json`; включает
  ownership-режим для `integration`, `recovery`, `compose`, `observability`
  (`verification/launch/v1/run.mjs:749-751`, `2695-2704`);
- `--no-build` — запрещает сборку в `compose-smoke` (`10549`, `10604`);
- `--project-name` — задаёт Compose-проект; inventory проверяется на точное
  совпадение `composeProject` (`tools/image-inventory.mjs:160-183`);
- `--browser-proof` — выбирает browser-стенд и запрещает остальные режимы
  (`tools/compose-smoke.mjs:1457-1478`), но не меняет источник образов;
- `--mutation-disable-rollback` — выбирает rollback-стенд с D/R checkout;
  образы всё равно берутся из inventory/rollback-контекста
  (`tools/compose-smoke.mjs:1498-1518`).

## 4. Публикация

### 4.1 Что публикует `supply_chain`

`tools/security-scan.mjs` собирает образы в OCI-layout, проверяет metadata,
provenance и attestation, затем:

1. Для всех собранных образов записывает provenance и attestation в
   `result.provenance.images` (`tools/security-scan.mjs:3403-3432`, `3744`).
   По этим записям `readVerifiedRuntimeImages` восстанавливает ID 15
   runtime-образов (`tools/verified-infrastructure-image.mjs:926-958`,
   `1023-1035`).
2. Для пяти инфраструктурных образов (`kafka`, `storage-helper`, `grafana`,
   `keycloak`, `otel-collector`) сохраняет OCI-архив
   `artifacts/<service>.oci.tar` и receipt
   `artifacts/<service>-receipt.json`
   (`tools/security-scan.mjs:1977-2020`, `4017-4100`). Этими файлами
   пользуется `loadVerifiedGateImage`
   (`tools/verified-infrastructure-image.mjs:312-392`, `1015-1022`).
3. Для 15 runtime-сервисов при наличии корректного `composeProject` загружает
   образ в Docker daemon под тегом
   `<composeProject>-<service>:latest`, сверяет image ID после загрузки и
   добавляет запись в `publishedRuntimeImages`
   (`tools/security-scan.mjs:3701-3739`). Шаблон тега задаёт
   `runtimeImageTag` (`tools/image-inventory.mjs:76-78`).
4. При `status === "PASS"` и `publishesRuntimeImages` пишет inventory
   (`tools/security-scan.mjs:3996-4016`) и добавляет в `result.json` ссылку
   `result.imageInventory = { path, sha256, sizeBytes }`
   (`4011-4016`). Inventory пишется только при PASS; при FAIL ссылки нет.

`publishesRuntimeImages` вычисляется из `resources.composeProject` контекста
(`tools/security-scan.mjs:3492-3495`). Если Compose-проект не задан, runtime
образы всё равно собираются и сканируются, но не публикуются и inventory не
создаётся.

### 4.2 Контракт `image-inventory.json`

Файл лежит по пути
`<evidenceDir>/gates/supply_chain/artifacts/supply-chain/artifacts/image-inventory.json`
(`tools/image-inventory.mjs:68-74`), пишется с режимом `0600`
(`tools/security-scan.mjs:1960-1975`).

Поля верхнего уровня (`tools/image-inventory.mjs:16-38`, `111-158`):

- `schemaVersion`, `gate`, `status`;
- `runId`, `candidateSha`;
- `treeSha`, `configSha256`, `toolchainVersionsSha256`, `lockfileSha256`;
- `composeProject`;
- `buildInputSha256` — хеш от `treeSha`, `configSha256`,
  `toolchainVersionsSha256` и `lockfileSha256` (`85-109`);
- `images[]` с полями `service`, `tag`, `imageId`, `manifestDigest`,
  `platformManifestDigest`, `provenanceSha256`, `attestationSha256`.

Валидация проверяет точный набор ключей, соответствие `runId`/`candidateSha`
контексту и environment, совпадение `composeProject`, полный набор 15 сервисов
и формат всех digest/hash (`tools/image-inventory.mjs:160-201`).

`readLaunchImageInventory` дополнительно сверяет inventory с независимо
прочитанным `supply_chain/result.json`: PASS, `SUPPLY_CHAIN_SCAN_CLEAN`,
provenance, checksum-ссылку `result.imageInventory` и записи provenance для
каждого образа (`tools/image-inventory.mjs:256-320`, `322-372`). Inventory сам
по себе не является доказательством — только согласие с evidence гейта.

### 4.3 Инфраструктурные и upstream-образы

Инфраструктурные образы не попадают в `image-inventory.json`. Для них
публикуются OCI-архив и receipt; потребитель загружает образ по требованию
через `loadVerifiedGateImage` и сверяет image ID, digest и provenance с
receipt (`tools/verified-infrastructure-image.mjs:312-392`, `1015-1035`).
Upstream-образы `loki`, `prometheus`, `tempo` только тянутся по digest и
сканируются; отдельного артефакта публикации у них нет
(`tools/security-scan.mjs:53-57`, `2787-2865`).

## 5. Потребители

### 5.1 `compose-smoke`

`compose-smoke` — основной потребитель inventory:

- читает inventory при наличии launch context (`tools/compose-smoke.mjs:9548-9556`);
- проверяет, что опубликованные теги указывают на ожидаемые image ID
  (`assertPublishedRuntimeImages`, `tools/compose-smoke.mjs:1755-1774`, вызов
  `10530-10531`);
- подставляет образы в scoped Compose override как `runtimeImages` с
  `pull_policy: never` (`10074-10087`, `3161-3184`);
- запускает Compose с `--no-build` (`10664`);
- после старта сверяет `container.Image` с inventory
  (`assertRuntimeContainersMatchInventory`, `1776-1884`, вызов `10719-10723`).

Если inventory нет, `compose-smoke` возвращается к сборке только в отсутствие
launch context либо в дочернем scope без результата `supply_chain`.

### 5.2 `integration` и `recovery`

Оба гейта запускают `verification/launch/v1/scenarios/owner-suites.mjs`; после
owner-тестов он вызывает `tools/compose-smoke.mjs` с `--customer-proof` и
`--recovery-proof` (`verification/launch/v1/scenarios/owner-suites.mjs:157-170`).
В launch-прогоне `run.mjs` передаёт этим гейтам контекст и ownership-файл
(`verification/launch/v1/run.mjs:742-766`, `2695-2704`), поэтому
`compose-smoke` выбирает `reuse` и не вызывает `buildRuntimeImages`. Запуск
`pnpm test:integration` или `pnpm test:recovery` без launch context сохраняет
standalone-путь со сборкой.

### 5.3 `observability`

`tools/observability/verify.mjs`:

- загружает `storage-helper`, `grafana` и `otel-collector` как verified
  artifacts (`4713-4730`);
- запускает browser-дочерний процесс, который читает runtime-образы через
  `readVerifiedRuntimeImages` (`6352-6355`);
- передаёт дочернему процессу launch context и запускает
  `runBrowserProof` (`5800-5816`, `6381-6412`); внутри используется
  `runComposeSmoke` с `--recovery-proof`, поэтому runtime-образы берутся из
  inventory, а не собираются.

При этом `runLaunchPath` в `tests/observability/launch-path.mjs` собирает
fixture-образы `edge-nginx` и нативный `realtime-gateway` через
`pnpm image:build` (`tests/observability/launch-path.mjs:452-460`,
`tests/realtime/fixtures/setup.mjs:1256-1263`). Это не публикация и не замена
канонического набора; см. раздел 7.

### 5.4 `browser`

`verification/launch/v1/scenarios/browser.mjs` создаёт дочерний checkout и
запускает `tools/compose-smoke.mjs --browser-proof`
(`verification/launch/v1/scenarios/browser.mjs:1738`). Дочерний
`compose-smoke` читает inventory из launch context и использует
опубликованные runtime-образы. После этого `browser` запускает
`owner-browser`, который собирает fixture `edge-nginx`
(`tests/realtime/fixtures/owner-browser.mjs:297-305`) и нативный
`realtime-gateway` через общий fixture (`tests/realtime/fixtures/setup.mjs:1256-1263`).

### 5.5 `rollback`

`verification/launch/v1/scenarios/rollback.mjs` валидирует привязку образов к
родительскому контексту (`1442-1455`) и запускает
`tools/compose-smoke.mjs --mutation-disable-rollback`
(`verification/launch/v1/scenarios/rollback.mjs:1906-1912`). Внутри
`compose-smoke` использует inventory и `rollbackRuntimeImages`; сборка для
rollback-стенда не выполняется (`tools/compose-smoke.mjs:10541-10549`).

### 5.6 `platform-service` (вне launch)

`tools/platform-service.mjs:755-756` читает verified runtime-образы, а
`tools/platform-service.mjs:867` вызывает `buildRuntimeImages` только если
образа нет в локальном daemon. Это разрешённая точка сборки локального
деплоя; к 20 гейтам запуска она не относится.

### 5.7 Контроль в `run.mjs`

`verification/launch/v1/run.mjs` закрепляет контракт между `supply_chain` и
потребителями:

- после PASS `supply_chain` читает image evidence и записывает
  `environment.imageDigests`/`nodeImageDigest` (`2261-2358`, `2367-2438`);
- создаёт ownership-файл перед `integration` и передаёт его в
  `integration`/`recovery`/`compose`/`observability` (`2601-2630`,
  `2695-2704`);
- после PASS `integration` переводит ownership в `ready`
  (`2716-2733`);
- при cleanup удаляет только run-owned образы, не затрагивая опубликованные
  `supply_chain` (`tools/runtime-image-inventory.mjs:186-245`).

## 6. Таблица гейтов

Порядок строк совпадает с `verification/launch/v1/matrix.yaml`. Гейты
адресуются slug-идентификаторами; позиционные номера здесь не используются.

| Гейт | Команда | Runtime-образы | Сборка и публикация | Переключатели |
| --- | --- | --- | --- | --- |
| `preflight` | `pnpm launch:verify:preflight` | Не использует runtime-образы; проверяет локальные pinned Node/nginx base images | Не собирает и не публикует | — |
| `install` | `pnpm install --frozen-lockfile` | Не использует | Не собирает и не публикует | — |
| `generated` | `pnpm contracts:check-generated` | Не использует | Не собирает и не публикует | — |
| `static` | `pnpm format:check && pnpm lint && pnpm typecheck` | Не использует | Не собирает и не публикует | — |
| `unit` | `pnpm test:unit -- --coverage` | Не использует | Не собирает и не публикует | — |
| `contracts` | `pnpm contracts:check-generated && pnpm contracts:breaking && pnpm contracts:test` | Не использует | Не собирает и не публикует | — |
| `architecture` | `pnpm architecture:check` | Не использует | Не собирает и не публикует | — |
| `config_security` | `pnpm versions:check && pnpm config:check && pnpm security:secrets` | Не использует | Не собирает и не публикует | — |
| `supply_chain` | `pnpm security:scan` | Собирает 14 Node runtime + `edge-nginx` + 5 инфраструктурных; upstream тянет по digest | Публикует 15 runtime-образов в daemon под тегами проекта; пишет OCI/receipts инфраструктурных и `image-inventory.json` | `COFFEE_LAUNCH_CONTEXT_FILE`; опционально `COFFEE_LAUNCH_DATA_TEMP_DIR`; кэш `COFFEE_SCAN_CACHE_DIR` |
| `migrations` | `pnpm test:migrations:clean && pnpm test:migrations:forward` | Не использует | Не собирает и не публикует | — |
| `db_boundaries` | `pnpm db:smoke` | Не использует | Не собирает и не публикует | — |
| `integration` | `pnpm test:integration` | В launch — reuse 15 runtime-образов из inventory; standalone — fallback-сборка `customer-service`/всех runtime | В launch не собирает и не публикует | `COFFEE_LAUNCH_CONTEXT_FILE`, `COFFEE_LAUNCH_IMAGE_OWNERSHIP`, `--customer-proof`, `--recovery-proof`, `--project-name` |
| `recovery` | `pnpm test:recovery` | В launch — reuse 15 runtime-образов; standalone — fallback-сборка всех runtime | В launch не собирает и не публикует | `COFFEE_LAUNCH_CONTEXT_FILE`, `COFFEE_LAUNCH_IMAGE_OWNERSHIP`, `--recovery-proof`, `--project-name` |
| `compose` | `pnpm test:compose-smoke` | В launch — reuse 15 runtime-образов; без launch context — fallback-сборка | В launch не собирает и не публикует; fallback-сборка только без контекста | `COFFEE_LAUNCH_CONTEXT_FILE`, `COFFEE_LAUNCH_IMAGE_OWNERSHIP`, `--no-build`, `--project-name` |
| `observability` | `pnpm test:observability` | Использует verified runtime- и инфраструктурные образы; fixture собирает `edge-nginx` и нативный `realtime-gateway` | Канонические образы не собирает и не публикует; fixture-сборка через `image:build` | `COFFEE_LAUNCH_CONTEXT_FILE`; дочерний browser-процесс наследует контекст |
| `browser` | `pnpm test:playwright` | В дочернем `compose-smoke` — reuse 15 runtime-образов; fixture собирает `edge-nginx` и нативный `realtime-gateway` | Канонические образы не собирает и не публикует; fixture-сборка через `image:build` | `COFFEE_LAUNCH_CONTEXT_FILE`; дочерний `--browser-proof` |
| `aroma_sandbox` | `pnpm test:aroma-sandbox -- --approval-file "$AROMA_SANDBOX_APPROVAL_FILE"` | Не использует runtime-образы; работает с pinned PostgreSQL fixture | Не собирает и не публикует | `COFFEE_LAUNCH_CONTEXT_FILE` (контекст изолированного scope) |
| `backup_restore` | `pnpm test:backup-restore` | Не использует | Не собирает и не публикует | `COFFEE_LAUNCH_CONTEXT_FILE` |
| `rollback` | `pnpm test:mutation-disable-rollback` | В launch — reuse verified runtime-образов родительского контекста | Не собирает и не публикует | `COFFEE_LAUNCH_CONTEXT_FILE`; дочерний `--mutation-disable-rollback` |
| `report` | `pnpm launch:verify:report` | Не использует | Не собирает и не публикует | `COFFEE_LAUNCH_CONTEXT_FILE` (только чтение evidence) |

## 7. Где сборка обязана исчезнуть

Следующие задачи меняют эту карту; до их merge текущее поведение остаётся
источником истины:

- **Э1, #311 «Artifact manifest как единственный контракт передачи образов»**:
  `supply_chain` начнёт публиковать `artifact-manifest.json` рядом с
  inventory, а потребители (`compose-smoke`, `observability`, `rollback`)
  получат единый `readArtifactManifest`. Эта карта — вход для Э1; новый формат
  манифеста здесь не проектируется.
- **Э2, #312 «Запретить сборку образов вне supply_chain»**: при наличии
  launch context отсутствие манифеста должно давать `IMAGE_INVENTORY_REQUIRED`,
  а не тихую сборку; fallback `imageMode === "build"` для launch-режима должен
  исчезнуть. Сборка остаётся только в `supply_chain` и локальном
  `platform-service`.

Текущие отклонения, которые Э2 должен устранить или явно классифицировать:

1. `compose-smoke` всё ещё допускает `imageMode === "build"` при наличии
   launch context, если `supply_chain` в этом scope ещё не публиковал
   inventory (`tools/compose-smoke.mjs:10541-10549`). Для полного прогона это
   недостижимо из-за порядка гейтов, но контракт пока не запрещает путь.
2. `observability` и `browser` собирают fixture-образы `edge-nginx` и
   нативный `realtime-gateway` через `pnpm image:build` в тестовых стендах
   (`tests/observability/launch-path.mjs:452-460`,
   `tests/realtime/fixtures/setup.mjs:1256-1263`,
   `tests/realtime/fixtures/owner-browser.mjs:297-305`). Это не публикация
   канонического набора, но это вызовы buildx внутри launch-гейтов.
3. Подготовка realtime qualification (`tests/realtime/fixtures/setup.mjs:1206-1235`,
   `tools/realtime-capacity.mjs:252-254`) может пересобрать `edge-gateway`,
   `api-public`, `realtime-gateway` и `edge-nginx`, если verified image
   отсутствует в daemon. Это pre-launch шаг, не один из 20 гейтов, но он
   должен быть учтён при переходе на reuse-only.
4. `tools/nginx/fixtures/served-backend.mjs`, `tests/nginx/image.test.mjs` и
   `tests/nginx/cutover.test.mjs` собирают `edge-nginx` только в собственных
   тестах и не входят в 20 гейтов; их не нужно смешивать с launch-потоком.

После Э2 критерий простой: в launch-прогоне `docker buildx build` вызывается
только из `supply_chain`; `compose-smoke` в launch-режиме имеет единственный
режим `reuse`, а `observability`/`browser` либо перестают собирать fixture-
образы, либо фиксируют их как явно разрешённое исключение с отдельным
контрактом.

## 8. Ссылки

- [Матрица гейтов](https://github.com/YurGusev/CoffeeOrderPlatform/blob/develop/verification/launch/v1/matrix.yaml)
- [Спецификация launch verification](21_LAUNCH_VERIFICATION_SPEC.md)
- [Имена гейтов](22_GATE_NAMING.md)
- [Э1: Artifact manifest](https://github.com/YurGusev/CoffeeOrderPlatform/issues/311)
- [Э2: Запретить сборку вне supply_chain](https://github.com/YurGusev/CoffeeOrderPlatform/issues/312)
