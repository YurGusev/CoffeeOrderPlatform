# Карта проверки orders-service

Этот каталог перечисляет операции, которые процесс `orders-service` отдаёт
по HTTP и пишет в outbox. Перед прогоном прочитать указатель. Затем открыть
файл фичи.

Источник маршрутов: `apps/orders-service/src/http/index.ts`. Контракт:
`packages/contracts/orders-v1`.

## Baseline preconditions

- Запуск из корня репозитория командой `node .cursor/skills/orders-slice-verify/run.mjs`.
- Postgres, Kafka и фикстура `api-internal` принадлежат этому run-id.
- База пустая, миграции `apps/orders-service/migrations` уже применены.
- Aroma и TastyCoffee не вызываются.
- Не открывать сервис, который запустил не этот прогон.

## Driving conventions

- Стабильные опоры: путь маршрута, код проблемы, статус заказа, счётчик строк, тип сообщения outbox.
- Один проход идёт от пустой базы к одному подтверждённому заказу.
- Сценарий со статусом `not-covered` не считать пройденным через другой путь.
- Evidence после очистки не удалять.

## Proof and skip reporting

- Для проверяемого сценария нужны и ответ HTTP, и чтение базы.
- Для подтверждения нужно ещё сообщение из `coffee.orders.lifecycle.v1`.
- В `result.json` у пройденного сценария статус `pass`.
- Непокрытый сценарий хранит `reason` в поле `detail`. Пропущенный из-за раннего сбоя имеет статус `not-run`.
- Код выхода `0` не означает, что непокрытые строки проверены.

## Feature entry contract

У каждой фичи один H1, короткий абзац и четыре заголовка второго уровня
в этом порядке: `Sub-features`, `How to get to it (user POV)`,
`Driving it with orders-slice-verify`, `Gotchas`.

## Features

| Фича | Сценарии | Статус |
|---|---|---|
| [Черновик](./draft.md) | `empty-ready`, `create-draft`, `replay-draft` | проверяется навыком |
| [Позиция](./items.md) | `put-item`, `get-card`, `delete-item` | проверяется навыком |
| [Подтверждение](./confirm.md) | `confirm-empty`, `confirm-order` | проверяется навыком |
| [Сверка](./reconcile.md) | `reconcile-blocked` | проверяется навыком |
| [Сверка](./reconcile.md) | `reconcile-accepted` | не покрыто |
| [Процесс](./runtime.md) | `health-live`, `metrics`, `inbox` | не покрыто |

В `result.json` это 9 сценариев со статусом проверки и 4 со статусом
`not-covered`. Если числа разошлись с `run.mjs`, верным считать `run.mjs`.
