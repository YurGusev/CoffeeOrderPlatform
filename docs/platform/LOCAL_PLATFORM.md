# Локальный запуск platform foundation

Foundation запускает ровно 15 Node.js процессов и Kafka KRaft. PostgreSQL в
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

На host публикуется только Edge `4000`. Owner services, `api-internal`, web,
Kafka и AROMA Gateway host ports не публикуют. Production deployment, registry
publication и изменение существующего PostgreSQL этой инструкцией не разрешены.

Для проверки DB foundation используйте отдельный изолированный режим:

```text
pnpm test:compose-smoke --database-proof
```

Он поднимает только `customer-service` и одноразовый PostgreSQL на уникальной
project-scoped сети `<project>_coffee_postgres_data`, проверяет переход
readiness `200 → 503 → 200` при остановке и восстановлении DB и удаляет
контейнер, сеть и Compose volumes после проверки. Общий compose gate с 15
runtime и Kafka остаётся отдельной проверкой и включает зависимости,
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
