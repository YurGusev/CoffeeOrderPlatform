# Срез orders-service: справочник

Имена контейнеров, топики и расширение сценария. Запуск, владелец файлов,
образы и карта проверок описаны в [SKILL.md](SKILL.md).

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
Порт сервиса `127.0.0.1:<18510-18580> → 4104`. Порты Postgres и Kafka не
публикуются. Данные обеих служб лежат в tmpfs.

Топики создаются до старта сервиса, потому что `autoTopicCreation` выключен:

- `coffee.orders.lifecycle.v1`, 12 разделов
- `coffee.aroma.cart.commands.v1`, 24 раздела
- `coffee.realtime.invalidate.v1`, 24 раздела

Последние два входят в allowlist производителя. Этот процесс сам в них не
пишет. Они нужны, чтобы релей стартовал с тем же списком, что `platform.yaml`.

Роли `coffee_orders_service_rw`, `coffee_orders_prepare_rw`,
`coffee_orders_observer_rw` и `coffee_orders_convergence_rw` создаются до
миграций: файлы в `apps/orders-service/migrations/` выдают им права.

## Как расширять

Новый SQL подхватывается по имени файла на пустой базе. Новая роль в `GRANT`
добавляется рядом с этими четырьмя в `run.mjs` до применения файлов.

Новый сценарий добавляется в массив `plan` и в карту `SKILL.md`. Он сверяет
ответ HTTP и строку в `db.json`. Успешную сверку AROMA не имитировать
вставкой проекции: её пишет `orders-aroma-preparation`.

Поставщиков Aroma и TastyCoffee не вызывать. Фикстура
`internal-fixture.mjs` остаётся единственным исходящим HTTP этого среза.
Она видит только свой сертификат, свой ключ и сертификат CA.
