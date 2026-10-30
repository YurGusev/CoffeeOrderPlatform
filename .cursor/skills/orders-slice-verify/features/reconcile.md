# Сверка AROMA

Подтверждённый заказ без наблюдения не принимает команду сверки. Успешная
сверка требует проекцию, которую этот процесс не создаёт.

## Sub-features

- `reconcile-blocked` проверяется навыком. `POST .../commands/request-aroma-reconciliation` возвращает 409 `AROMA_RECONCILIATION_NOT_ALLOWED`.
- `reconcile-accepted` не покрыто. Успех пишет `OrderReconciliationRequested.v1` только из состояний `OutOfSync`, `Blocked` или `UnknownOutcome`.

## How to get to it (user POV)

- Иметь подтверждённый заказ этого прогона.
- Запросить сверку с `expectedVersion` и причиной.
- Успешный путь открывается только после проекции другого процесса.

## Driving it with orders-slice-verify

Preconditions:

- Сценарий `confirm-order` уже прошёл. Статус `Confirmed`, в outbox одно сообщение.

- **Запросить сверку.** Ответ 409 `AROMA_RECONCILIATION_NOT_ALLOWED`. Статус и версия не меняются. В outbox по-прежнему только `OrderConfirmed.v1`.
- **Не подменять проекцию.** Вставка строки `order_aroma_projections` от имени этого прогона не считается проверкой сверки.

## Gotchas

- Карточка при этом показывает `PendingObservation`. Команда сверки это состояние отвергает.
- Поставщик Aroma не вызывается ни на отказе, ни как обход.
- Событие `OrderReconciliationRequested.v1` этим прогоном не публикуется.
