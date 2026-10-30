# Срез orders-service: справочник

## Граница

Один процесс `orders-service` (`node apps/orders-service/dist/main.js`),
одна база `coffee_platform_orders` и один брокер `kafka:9092`. Имя базы, порт
`4104`, исходящий `api-internal:4051` и протокол `SASL_SSL` читаются из
`config/platform.yaml`. Хост Postgres в конфиге зафиксирован как
`coffee_postgres`. Рычаг даёт это имя алиасом своей сети.

Роль runtime берётся из `GRANT USAGE ON SCHEMA orders TO coffee_orders_service_rw`.
Рядом создаются роли `coffee_orders_prepare_rw`, `coffee_orders_observer_rw`
и `coffee_orders_convergence_rw`, потому что миграции выдают им права.
Пароль роли, ключи mTLS и материал Kafka создаются на прогон и пишутся в
`/dev/shm/orders-slice-verify-<run-id>/`. Каталог принимается только если
`statfs` показывает tmpfs. Файл scoped secrets получает владельца `1000:1000`
и режим `0400`.

Фикстура `api-internal` использует `node:26.8.1-bookworm-slim` с тем же
digest, что customer-slice-verify. Процесс `orders-service` использует
бинарник Node запускающего скрипта. В контейнер только для чтения
монтируются `/lib64` и `/lib/x86_64-linux-gnu` хоста: сборка
`@confluentinc/kafka-javascript` привязана к glibc этого Node, а bookworm
из образа фикстуры её не загружает. Скрипт `ar-mri` стоит в `PATH` только
на время этой сборки: `ar -M` читает `+` в пути pnpm как комментарий MRI.
Образ Postgres совпадает с тем же срезом: `postgres:17.11-alpine`. Образ
Kafka читается из `config/toolchain-versions.json` `kafkaImage`.

## Команда

```bash
node .cursor/skills/orders-slice-verify/run.mjs
node .cursor/skills/orders-slice-verify/run.mjs --keep
node .cursor/skills/orders-slice-verify/run.mjs --down <run-id>
```

| Код | Значение |
|---|---|
| 0 | обязательные сценарии прошли, срез удалён |
| 1 | сценарий, старт или аргументы не прошли; если контейнеры успели появиться, срез удалён |

`--keep` оставляет контейнеры. Перед следующим обычным запуском его не
обязательно гасить: у нового прогона другое имя. Оставленный прогон всё равно
нужно снять `--down`.

run-id имеет вид `20261030t120700z-ab12cd`.

## Docker

| Объект | Имя |
|---|---|
| проект Compose | `orders-slice-verify-<run-id>` |
| сеть | `orders-slice-verify-<run-id>-net` |
| Postgres | `orders-slice-verify-<run-id>-postgres` |
| Kafka | `orders-slice-verify-<run-id>-kafka` |
| фикстура | `orders-slice-verify-<run-id>-internal` |
| сервис | `orders-slice-verify-<run-id>-orders` |

Метки: `com.coffee.slice=orders`, `com.coffee.slice.run=<run-id>`.
Данные Postgres лежат в tmpfs. Данные Kafka лежат в tmpfs. Порт сервиса
`127.0.0.1:<18510-18580> → 4104`. Порты Postgres и Kafka не публикуются.

Топики создаются до старта сервиса, потому что `autoTopicCreation` в конфиге
выключен:

- `coffee.orders.lifecycle.v1`, 12 разделов
- `coffee.aroma.cart.commands.v1`, 24 раздела
- `coffee.realtime.invalidate.v1`, 24 раздела

Последние два входят в allowlist производителя. Этот процесс сам в них не
пишет. Они нужны, чтобы релей стартовал с тем же списком, что `platform.yaml`.

## Evidence

`evidence/orders-slice-verify/` в `.gitignore`.

| Файл | Содержимое |
|---|---|
| `result.json` | `status`, `passed`, `failed`, `notCovered`, сценарии |
| `http.ndjson` | одна строка на запрос |
| `db.json` | счётчики после сценария и краткое совпадение сообщения Kafka |
| `doctor.json` | готовность и владелец порта |
| `service.log` | журнал процесса после удаления ключевого материала |
| `fixture.log` | журнал фикстуры, без заголовка делегирования |
| `kafka.log` | журнал брокера после удаления паролей |
| `environment.json` | образы, порт, commit, dirty |
| `run.json` | имена контейнеров для `--down` |

## Как расширять

Новый SQL в `apps/orders-service/migrations/` подхватывается по имени файла
на пустой базе. Новая роль в `GRANT` должна быть создана до применения файлов,
рядом с четырьмя ролями в `run.mjs`.

Новый сценарий добавляется в массив `plan` в `run.mjs`, в таблицу `SKILL.md`
и в файл `features/`. Сценарий обязан проверять и HTTP, и `db.json`.
Успешную сверку AROMA не имитировать вставкой проекции от имени этого
процесса: проекцию пишет `orders-aroma-preparation`.

Поставщиков Aroma и TastyCoffee не вызывать. Фикстура внутреннего API остаётся
единственным исходящим HTTP этого среза.
