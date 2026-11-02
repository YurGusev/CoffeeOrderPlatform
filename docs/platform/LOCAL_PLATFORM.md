# Локальный запуск platform foundation

Reference topology запускает 14 Node.js процессов, native nginx и Kafka KRaft. PostgreSQL в
Compose не создаётся: используется существующий PostgreSQL 17.11 через заранее
созданную external network `coffee_postgres_data`.

## Проверка репозитория

```text
npx --yes pnpm@11.24.0 install --frozen-lockfile
npx --yes pnpm@11.24.0 check
docker compose config --quiet
```

Версии Node, pnpm, Docker и Compose должны совпадать с
`config/toolchain-versions.json`. Floating tags и зависимости запрещены.

## Сборка образов за WireGuard

Docker bridge с MTU 1500 нельзя использовать на host, где маршрут до Debian
проходит через WireGuard с MTU 1280: крупные ответы mirror попадают в PMTUD
black hole, поэтому `apt-get update` выглядит как timeout. Проектный wrapper
определяет MTU интерфейса маршрута до `deb.debian.org`, создаёт отдельные сеть
`coffee_platform_build_mtu` и BuildKit builder `coffee-platform-mtu`, затем
разрешает build-only host networking для шагов загрузки:

```text
npx --yes pnpm@11.24.0 image:build -- \
  --build-arg RUNTIME=edge-gateway \
  --target build \
  --load \
  -t coffee-platform-builder:verify .
```

Wrapper не меняет глобальный Docker daemon и не переписывает существующую сеть
с другим MTU. В таком случае он останавливается и сообщает конфликт, чтобы не
разрывать подключения работающих контейнеров.

Для Node 26 Confluent не публикует prebuilt binary, поэтому native addon
собирается из исходников отдельным явным шагом, а lifecycle scripts pnpm
отключены. Предшествующая Docker stage собирает `librdkafka@2.15.0` из
проверенного SHA-256 source archive и устанавливает shared libraries в
`/usr/local`. Addon собирается с официальными upstream flags
`CKJS_LINKING=dynamic BUILD_LIBRDKAFKA=0`; bundled static archive и зависящий от
pnpm-пути GNU MRI script не используются. Builder проверяет `librdkafka`
через `pkg-config`, динамическую связь через `ldd` и загружает итоговый addon
compatibility probe непосредственно под Node `26.8.1`. После `pnpm deploy --prod`
Dockerfile переносит собранный `.node` в resolved production dependency и
повторно загружает его из `/runtime`: package store сам этот build output не
переносит. Final image получает addon, shared libraries и runtime-зависимости
без compiler toolchain.

### Кэш повторной сборки

Corepack/pnpm устанавливаются до копирования проекта. Установка с frozen
lockfile и компиляция Kafka addon зависят только от корневых package-файлов и
`apps/*/package.json`, `packages/*/package.json`. Stage `workspace-manifests`
сохраняет эти пути автоматически; добавлять новый сервис в Dockerfile не нужно.
Исходники, TypeScript-конфигурация и runtime-конфигурация копируются после
зависимостей. Их изменение повторяет compatibility probe, typecheck и упаковку
выбранного runtime, сохраняя кэш установки и native build.

Для проверки использовать один и тот же builder: выполнить команду сборки выше,
изменить исходник и повторить её с `--progress plain`. Шаг установки зависимостей
и native addon должен показать `CACHED`, а typecheck — выполниться заново.
Изменение зависимости в workspace manifest без обновления lockfile должно
завершить сборку ошибкой frozen lockfile. Первая сборка с пустым кэшем по-прежнему
компилирует native зависимости; `--no-cache` отключает это ускорение.

Локальный замер 2026-09-05: `node tools/docker-build.mjs --target build
--progress plain <context>` без экспорта образа занял 75,56 с до изменения
Dockerfile и 33,74 с после прогрева новых слоёв и правки исходника. Это один
замер на том же builder с уже собранной `librdkafka`, около 2,2 раза быстрее;
холодная сборка и время загрузки образа в Docker этим сравнением не измеряются.

## Подготовка конфигурации и секретов

В Git хранятся только `config/platform.yaml` и SOPS-encrypted
`secrets/platform.secrets.sops.yaml`. Private age identity находится вне Git.
Перед запуском trusted init role проверяет SOPS MAC/recipient и выдаёт каждому
runtime только его scoped файл:

```text
SOPS_AGE_KEY_FILE=/secure/path/age-key.txt \
COFFEE_CONFIG_FILE="$PWD/config/platform.yaml" \
COFFEE_RUNTIME_SECRETS_FILE=/run/secrets/coffee-platform.yaml \
node tools/config-bootstrap/index.mjs --runtime customer-service
```

Файл создаётся в tmpfs с mode `0400`; runtime без обоих locator env, с чужим
secretRef или неверным mode завершается до открытия listener. Общий plaintext
secret bundle не создаётся.

Для первого Compose launch trusted bootstrap обновляет истёкшие и близкие к
истечению service certificates командой
`node tools/config-bootstrap/index.mjs --renew-development-transport`.
Она разрешена только в development и использует действующую CA из
зашифрованного `security.serviceTransportAuthority`: существующие private keys,
SAN и остальные секреты сохраняются. Срок service certificate — 24 часа,
подготовка обновления начинается за 6 часов; настройки закреплены в
`config/platform.yaml`. После обновления требуется перезапустить затронутые
runtime. Автоматический scheduler эта команда не создаёт.

Для первоначальной подготовки локального окружения trusted bootstrap принимает
`node tools/config-bootstrap/index.mjs --prepare-development-runtime`. Команда
работает только в `development`, добавляет недостающие scoped credentials и
использует действующую development CA из зашифрованного
`security.serviceTransportAuthority`. Действующие пароли не перезаписываются.

Постоянная локальная установка располагается в `~/coffee-platform`: чистые
контроллеры — в `runtime/controllers/<commit>`, immutable release bundles — в
`runtime/releases/<release>`, состояние identity — в `runtime/state`.
Имена каталогов и постоянных Compose-ресурсов не содержат номеров задач или
проверочных запусков; release определяется commit и хешами config/secrets.

Срок service certificates — `security.certificateValidityHours: 24`, подготовка
обновления начинается за `security.certificateRenewBeforeHours: 6`. Проверяются
ключ, доверенный издатель и точные DNS SAN. Публичный edge certificate сохраняет
отдельную пару и своего издателя. Если издатель публичного edge
certificate не соответствует доступной CA, команда завершится с ошибкой без
смены корня доверия. Для обычного release контроллер подготавливает user timer,
который каждые три часа проверяет срок действующих scoped certificates и при
остатке не более шести часов выполняет последовательный холодный перезапуск
своих сервисов. Публичный edge certificate продлевается отдельно у своего
издателя. До включения timer необходимо измерить недоступность и проверить
пересоздание, доставку телеметрии и сохранность данных; установка unit сама
timer не включает. Новая CA и служба подписи не создаются.
При неудачном запуске или обслуживании основной user unit не перезапускается
автоматически: требуется проверить состояние и выполнить recovery. Ограниченные
Docker restart для отдельных контейнеров остаются действующими.
Предупреждения об истекающем публичном сертификате и ошибке обслуживания
доставляются в Loki как события `coffee-platform-maintenance`; они доступны в
Grafana Explore, datasource `loki`, по запросу
`{service_name="coffee-platform-maintenance"}`. Это не alert episode и не push.
Перед включением timer необходимо проверить реальную доставку и отображение.

### Постоянный локальный запуск

Контроллер работает из чистого detached checkout
`~/coffee-platform/runtime/controllers/<commit>`. Ему передают сохранённый
`COFFEE_LAUNCH_CONTEXT_FILE` с успешным G12 для того же commit и точных image IDs,
`COFFEE_DB_EXPECTED_SERVER_IDENTITY` утверждённого PostgreSQL и
`SOPS_AGE_KEY_FILE` существующего age identity. Эти переменные содержат только
локаторы и проверяемый идентификатор, не пароли. Образы другого commit или
неполный scan не допускаются. `browserOidc: null` исходной normal config
преобразуется в локальный HTTPS OIDC profile; оба isolation flags должны быть
`false`. Итоговый config и его SHA сохраняются в immutable release bundle.

Из этого checkout выполнить `node tools/platform-service.mjs start`:
контроллер проверяет существующую наблюдаемость и PostgreSQL, подготавливает
scoped tmpfs secrets, владельческие БД и миграции, Kafka и identity, затем
запускает бизнес-сервисы и nginx. Все 17 product containers получают общую
bounded non-blocking logging policy из `config/platform.yaml`.

После фактического входа `owner` в HTTPS UI выполнить
`node tools/platform-service.mjs recover`: контроллер проверяет живую сессию
владельца и его административные права в identity, затем отзывает временный
bootstrap-admin. `node tools/platform-service.mjs install` устанавливает user
unit для этого release. Последующий штатный запуск —
`systemctl --user start coffee-platform.service`, остановка —
`systemctl --user stop coffee-platform.service`; `status` контроллера показывает
фактическое состояние и принадлежность контейнеров. БД и volumes при остановке
не удаляются. Автоматический certificate timer включается отдельно после
проверки обслуживания на target.

Сервер PostgreSQL не перенастраивается: budget 96 включает 54 Node connections,
2 identity connections, 8 на serial rollout и резерв 32. Пул AROMA Gateway — 6;
остальные Node pools сохранены. Реальные login, readiness, API→DB→Kafka→SSE и
restart с сохранением данных обязательны до приёмки установки. Такой запуск
сам по себе не является formal G00–G19 admission.

### Постоянные age identities и резервная копия на этом сервере

Для локального CoffeeOrderPlatform используются три age identities:

- основной файл: `/home/yurgusev/.config/sops/age/keys.txt` — стандартный путь
  обнаружения SOPS;
- резервная копия: `/home/yurgusev/.local/share/coffee-platform/recovery/2026-09-06-initial-provision/age-identities.txt`;
- в том же recovery-каталоге сохранены исходный ciphertext до provisioning,
  исходные SOPS rules, новый encrypted inventory и публичные recipients.

Каталоги имеют mode `0700`, identities и recovery-файлы — `0600`. Private age
identity и её копия никогда не добавляются в Git, tmpfs runtime scopes или
контейнеры сервисов. Общий plaintext inventory на диске не сохраняется.
Копия на этом диске защищает от удаления основного файла, но не от потери диска.

Перед provisioning/ротацией прочитать этот раздел. После каждого изменения
recipients обновить резервную копию и проверить восстановление ею. Перед
удалением ключа убедиться, что сохранённые ciphertext больше не требуют его.
Нельзя хранить единственную identity в `/tmp`.

Проверка MAC основным файлом:

```bash
SOPS_AGE_KEY_FILE=/home/yurgusev/.config/sops/age/keys.txt pnpm config:check
SOPS_AGE_KEY_FILE=/home/yurgusev/.config/sops/age/keys.txt pnpm security:secrets
```

Проверка восстановления без вывода plaintext:

```bash
SOPS_AGE_KEY_FILE=/home/yurgusev/.local/share/coffee-platform/recovery/2026-09-06-initial-provision/age-identities.txt \
sops --decrypt --output /dev/null secrets/platform.secrets.sops.yaml
```

Первоначальный provisioning 2026-09-06 заменил утраченные временные age keys,
создал криптографические signing/TLS keys и локальные DB/Kafka credentials.
Certificates для `localhost` относятся к локальному запуску; production TLS
требует сертификат для реального публичного hostname. Сохранённые из исходного
fixture `aroma.email`, `aroma.password`, `edge.oidcClientSecret` и
`telemetry.exporterToken` остаются **не provisioned для внешних систем**;
наличие encrypted поля не доказывает доступ к провайдеру.

### Учётные данные Tasty Coffee

Логин и пароль Tasty Coffee хранятся только в
`secrets/platform.secrets.sops.yaml` под
`environments.development.tasty.login` и `environments.development.tasty.password`.
Секция `tasty` необязательна; если она есть, оба поля обязательны и зашифрованы.
Runtime не получает эти данные: `secretRefs` и outbound permissions не меняются.
Для операторской проверки входа `readTastyCredentials` из trusted
`config-bootstrap` возвращает только логин и пароль выбранного окружения в памяти.

Для локального ввода выполнить из корня репозитория следующую команду.
Оба значения вводятся без отображения, передаются SOPS через stdin и не попадают
в аргументы процесса, shell history или plaintext-файл. Команда заменяет только
ветку `environments.development.tasty`; значения AROMA не меняются. После каждого
поля нажать Enter; при пустом значении программа запросит это поле повторно.

```bash
python3 tools/config-bootstrap/store-tasty-credentials.py
```

Только после сообщения об успешной записи выполнить проверки:

```bash
SOPS_AGE_KEY_FILE=/home/yurgusev/.config/sops/age/keys.txt pnpm config:check
SOPS_AGE_KEY_FILE=/home/yurgusev/.config/sops/age/keys.txt pnpm security:secrets
```

Успех этих проверок подтверждает структуру и SOPS MAC, но не вход в Tasty Coffee.

## PostgreSQL

Безопасный offline plan не подключается к серверу:

```text
npx --yes pnpm@11.24.0 db:bootstrap -- --plan
npx --yes pnpm@11.24.0 db:smoke -- --plan
```

Live bootstrap и role denial smoke выполняются только на явно выбранном trusted
или изолированном verification target по инструкции
`docs/platform/POSTGRES_BOOTSTRAP.md`. Legacy `coffeeorderdb` и
`coffeeorder_staging` всегда отклоняются.

## Compose

После materialization scoped secrets и создания external network:

```text
docker network create --internal coffee_postgres_data
node tools/compose-smoke.mjs --stub-secrets \
  --provision-empty-postgres-network --project-name coffee-platform-local --keep
curl --fail http://127.0.0.1:4000/health/ready
docker compose --project-name coffee-platform-local down
```

Kafka хранит журнал в именованном Compose volume `kafka_data`, который Compose
материализует как `<project>_kafka_data`. У volume нет глобального имени, поэтому
каждый smoke project получает отдельный журнал брокера. Один брокер использует
коэффициент репликации `1`; это ограничение среды разработки без обещания
высокой доступности. Полный smoke публикует запись, фиксирует подтверждение
брокера, удаляет и пересоздаёт только Kafka container в том же project, ждёт
готовности и читает запись из сохранённого volume перед очисткой этого project:

```text
node tools/compose-smoke.mjs --project-name coffee-recovery-foundation
```

На host публикуется только native nginx `127.0.0.1:8443`. Private
`edge-gateway`, owner services, `api-internal`, Kafka и AROMA Gateway host ports
не публикуют. Отдельного Node `web` runtime и запасного Edge ingress нет. Production deployment, registry
publication и изменение существующего PostgreSQL этой инструкцией не разрешены.

Для проверки DB foundation используйте отдельный изолированный режим:

```text
pnpm test:compose-smoke --database-proof
```

Он поднимает только `customer-service` и одноразовый PostgreSQL на уникальной
project-scoped сети `<project>_coffee_postgres_data`, проверяет переход
readiness `200 → 503 → 200` при остановке и восстановлении DB и удаляет
контейнер, сеть и Compose volumes после проверки. Общий compose gate с 14 Node runtime, native nginx
и Kafka остаётся отдельной проверкой и включает зависимости,
реализуемые в #63.

Для полного recovery proof #63 используйте отдельный режим с disposable
PostgreSQL и сгенерированными scoped credentials для всех пяти owner databases,
десяти runtime ролей и Kafka TLS:

```text
node tools/compose-smoke.mjs --recovery-proof --project-name coffee-recovery-foundation
```

Режим не читает SOPS и не использует `coffee_postgres_data`: disposable
PostgreSQL подключается к уникальной project-scoped сети и к bridge для
временного host-порта только на `127.0.0.1`, используемого существующим DB
bootstrap. Compose явно связывает `KAFKA_LOG_DIRS=/var/lib/kafka/data` с volume Kafka:
entrypoint image генерирует broker properties из environment. Volume сохраняется между recreate container
и удаляется вместе с этим project после proof.

Customer acceptance запускается отдельно на disposable PostgreSQL 17.11:

```text
node tools/compose-smoke.mjs --customer-proof --project-name coffee-customer-acceptance
```

Режим собирает production Customer image, создаёт временные mTLS/signing
fixtures в tmpfs, применяет миграции ролью `coffee_customer_migrator` и
последовательно выполняет существующие Customer integration tests без
пропусков. Проверяются grants, concurrency, rollback, lost response и
неподтверждённый COMMIT с реальным restart/replay. Отдельный observer идёт
напрямую в БД, а дочерний Customer — через fault proxy. Контейнеры, сети,
volumes и временные secrets удаляются после проверки. Этот режим не читает
SOPS и не подтверждает credentials внешних провайдеров.

## Reference nginx cutover и возврат

Перед переключением сохранить единый release bundle: SHA коммита,
`config/platform.yaml`, сгенерированного `nginx.conf`, browser assets,
точные image IDs всех затронутых ролей, идентификаторы сертификатов и CA
(без private keys), версии scoped secret materialization, результаты
`pnpm config:check`, `pnpm nginx:check`, `pnpm security:secrets`,
`pnpm test:edge-auth`, `pnpm test:nginx-image`, `pnpm test:nginx-cutover`,
`pnpm test:compose-smoke` и сборки image. Локальный image ID не выдавать за
registry digest; production release потребует отдельного допуска и OCI digests.
Ни тесты с synthetic peer, ни `docker compose config --quiet` не подтверждают
production IdP, DNS/SAN или доступ non-root процесса к PEM: это отдельные
preflight проверки на выбранном target.

Новая конфигурация immutable: generator получает её только из
`config/platform.yaml`, `nginx:check` подтверждает совпадение, затем config
встраивается в новый nginx image. Новые scoped сертификаты материализуются
trusted bootstrap в tmpfs с проверкой пары, CA и SAN. Кандидат проверяется
через `nginx -t` **с теми же mounted PEM и UID 101**, а затем через private
auth/API/SSE probes без второго публичного listener. Если любой gate отвергает
кандидата, действующий bundle не менять. TLS-сертификат или CA ротировать как
новую версию bundle: на время перехода сохранить согласованное доверие старого
и нового peer, не переиспользовать private keys между ролями.

При переключении сначала запретить новые admissions старому ingress и дать
его HTTP/SSE соединениям ограниченный drain (Compose `stop_grace_period: 30s`);
после освобождения **единственного** loopback binding запустить новый
nginx/Edge bundle и проверить private authorizer, API и SSE отдельно от
статического 200. Если проверки не проходят, остановить новую версию,
восстановить прежние image IDs, config и согласованный cert/CA bundle,
повторить preflight и вернуть только прежний listener. Новые бизнес-команды
при auth/transport отказе не replay-ятся автоматически, upstream mutation
не повторяется nginx. Если срок безопасности старого сертификата или ключа
истёк/отозван, возврат к нему запрещён: оставить fail-closed и устранить
причину новой версии. Порядок относится к reference runbook, а не разрешению
выполнить deployment на этой машине.

Fixture HUP/reload проверяет, что отвергнутая конфигурация не заменяет
действующие workers и что принятая конфигурация допускает bounded drain.
Для active image файл `nginx.conf` встроен в image: изменение config или
сертификатов выполняется новой версией bundle, не незаметной правкой файла
в текущем контейнере. Доступность настоящего IdP и конечная приёмка запуска
остаются за отдельными delivery gates.
