# Позиция черновика

Оператор добавляет одну позицию в черновик, читает карточку и удаляет позицию.
Цена приходит из фикстуры проверки котировки, не из pricing-service.

## Sub-features

- `put-item` проверяется навыком. `PUT /api/client-v1/orders/:orderRef/items/:itemRef` сохраняет одну позицию.
- `get-card` проверяется навыком. `GET /api/client-v1/orders/:orderRef` возвращает тот же черновик.
- `delete-item` проверяется навыком. `DELETE` той же позиции оставляет черновик пустым.

## How to get to it (user POV)

- Иметь черновик из сценария создания.
- Записать позицию с `expectedVersion` текущей версии.
- Прочитать карточку по `orderRef`.
- Удалить позицию с заголовком `if-match-version`.

## Driving it with orders-slice-verify

Preconditions:

- Сценарий `replay-draft` уже прошёл, в `world` есть `orderRef` и версия `1`.
- Фикстура на `POST /api/internal-v1/pricing/quotes:verify` возвращает ту же позицию, количество и будущий `expiresAt`.

- **Записать позицию.** Ответ 200, в `items` один элемент с `itemRef` прогона и именем `Slice Verify`. В `orders.order_items` одна строка, статус заказа `Draft`.
- **Прочитать карточку.** Ответ 200, тот же `orderRef`, та же версия, одна позиция, `aroma.state` равен `NotRequested`. Число строк не меняется.
- **Удалить позицию.** Ответ 200, `items` пуст. В базе позиций нет и outbox пуст.

## Gotchas

- `expectedVersion` для записи лежит в теле. Для удаления версия лежит в заголовке `if-match-version`.
- У черновика нет строки проекции AROMA, и карточка показывает `NotRequested`. Это не отказ сценария.
- Фикстура не ходит в каталог и не вызывает поставщика.
