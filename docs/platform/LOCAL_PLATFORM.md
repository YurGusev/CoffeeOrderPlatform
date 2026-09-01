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
compatibility probe непосредственно под Node `26.8.1`. Final image получает
только shared libraries и их runtime-зависимости, без compiler toolchain.

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
docker compose up --build --wait
curl --fail http://127.0.0.1:4000/health/ready
docker compose down
```

На host публикуется только Edge `4000`. Owner services, `api-internal`, web,
Kafka и AROMA Gateway host ports не публикуют. Production deployment, registry
publication и изменение существующего PostgreSQL этой инструкцией не разрешены.
