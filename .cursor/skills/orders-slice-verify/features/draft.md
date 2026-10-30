# Черновик заказа

Оператор создаёт пустой черновик для уже известного клиента. Повтор того же
ключа возвращает тот же заказ. Другое тело с тем же ключом отклоняется.

## Sub-features

- `empty-ready` проверяется навыком. Сервис готов, строк владельца нет.
- `create-draft` проверяется навыком. `POST /api/client-v1/orders/drafts` пишет одну строку `Draft`.
- `replay-draft` проверяется навыком. Повтор не создаёт вторую строку, конфликт ключа возвращает 409.

## How to get to it (user POV)

- Дождаться готовности сервиса.
- Отправить создание черновика с `customerRef`.
- Повторить тот же запрос с тем же `Idempotency-Key`.
- Повторить тот же ключ с другим `customerRef`.

## Driving it with orders-slice-verify

Preconditions:

- `node .cursor/skills/orders-slice-verify/run.mjs` дошёл до doctor с `ok: true`.
- Фикстура отвечает на order-input этого `customerRef` состоянием `Active`.

- **Открыть готовность.** `GET /health/ready` возвращает `ready`. В `orders.orders`, `orders.order_items`, `orders.idempotency_records` и `orders.outbox_messages` ноль строк.
- **Создать без сертификата.** Соединение обрывается до HTTP.
- **Создать чужим сертификатом.** Ответ 401 `AUTHENTICATION_REQUIRED`.
- **Создать без actor context.** Ответ 401 `AUTHENTICATION_REQUIRED`.
- **Создать с телом `{}`.** Ответ 400 `VALIDATION_FAILED`. Строк по-прежнему нет.
- **Создать черновик.** Ответ 201, `status` равен `Draft`, `version` равен `1`, позиций нет. В базе одна строка с тем же `orderRef`.
- **Повторить создание.** Ответ 201, заголовок `idempotency-replayed` равен `true`, `orderRef` тот же.
- **Сменить тело при том же ключе.** Ответ 409 `IDEMPOTENCY_CONFLICT`. Строка по-прежнему одна.

## Gotchas

- Фикстура не является customer-service. Она отвечает только на один `customerRef` этого прогона.
- Черновик не пишет outbox. Событие появляется на подтверждении.
- Запрос без клиентского сертификата не имеет HTTP-статуса. В `http.ndjson` у него статус `0`.
