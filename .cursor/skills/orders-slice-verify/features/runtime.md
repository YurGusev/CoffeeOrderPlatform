# Процесс вокруг заказа

У процесса есть служебные маршруты runtime и inbox той же базы. Этот рычаг
их не проходит.

## Sub-features

- `health-live` не покрыто. `GET /health/live` не вызывается.
- `metrics` не покрыто. `GET /metrics` не вызывается.
- `inbox` не покрыто. У `orders-service` нет потребителей Kafka.

## How to get to it (user POV)

- Открыть `GET /health/live` на порту сервиса.
- Открыть `GET /metrics` на том же порту.
- Дождаться разбора входящего сообщения процессом orders-service.

## Driving it with orders-slice-verify

Preconditions:

- Doctor уже прошёл. Этого недостаточно, чтобы пометить служебные маршруты пройденными.

- **Не считать готовность живостью.** `GET /health/ready` не закрывает `health-live`.
- **Не считать журнал метрикой.** `service.log` не закрывает `metrics`.
- **Не считать публикацию разбором inbox.** У сервиса `consumers: []`. Таблицу `orders.inbox_messages` читают другие роли.

## Gotchas

- Код выхода `0` оставляет эти три сценария в `not-covered`.
- Появление потребителя у `orders-service` требует нового сценария, а не смены статуса этих строк.
