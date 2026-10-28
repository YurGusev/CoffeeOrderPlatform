# Tasty: физическая идентичность строки

Историческое наблюдение одного аккаунта 25.10.2026, не контракт поставщика и не production acceptance. [Проекция наблюдений](../../../evidence/tasty/identity/observations.json) содержит только aliases; одинаковые aliases обозначают один исходный ID только внутри этого корпуса. Синтетических случаев нет. Дата исследования: 2026-10-25T16:56:30.356Z–2026-10-25T17:16:41.670Z; у первичной заметки более точного времени нет.

| Product | Offer | Текущий row | Grind | Package | Наблюдение |
|---|---|---|---|---|---|
| product-A | offer-bean-A | row-bean-old → row-bean-new | null | package-standard | Удаление через quantity=0 и создание снова дали новый row ID. |
| product-A | offer-ground-A | row-ground-medium | grind-medium → grind-coarse | package-standard | Другая offer того же товара; адресная смена grind сохранила row ID. |
| product-A | offer-ground-A | row-ground-fine | grind-fine | package-standard | Отдельная строка другого помола одновременно с предыдущей. |
| product-A | offer-bean-A | row-bean-other | null | package-white → package-kraft | Отдельная строка другой упаковки; адресная смена сохранила row ID, стандартная строка сохранилась. |
| product-B | offer-other-B | row-other-B | null | null | Списки выбора пусты; поля в запросе отсутствовали, в ответе были null. |

`product.id` идентифицирует товар, `offers[].id` — предложение, `data[].id` — текущий адрес строки, `grinding_id` и `package_id` — её выборы. `offer_id` один не определяет физическую строку; row ID не постоянен. Null не wildcard. Отсутствующее поле запроса не равно явно переданному null: их эквивалентность не проверена. Для молотого offer пропуск `grinding_id` принялся и вернулся как grind-medium; причина не установлена, для точного намерения требуется явный выбор. Повтор с явным medium сохранил строку; это не универсальная гарантия дедупликации.

Доступные packages и grindings нужно определять по актуальному ответу конкретного offer и аккаунта. Допустимость стандартной упаковки у десяти выбранных товаров не доказывает доступность для всего каталога. Изменение упаковки у сохранённого заказа может изменить физическое исполнение; нельзя молча подменять его выбранный package. Фиксированный профиль упаковки — только предложение для будущего ADR, не доказанная универсальная возможность. Raw provider IDs не публиковать в client/events.

`NOT_PROVEN`: смена grind/package на уже существующую комбинацию, collision/automatic merge, `merge_offers`, `explode`, массовая смена, конкурентные записи, null против omission при изменении. Для каждого нужны отдельные разрешённые наблюдения с before/after; маршрут в JS сам по себе не доказывает семантику. Scope не включает binding, изменение контрактов quote/Order и новый options framework.

## Происхождение

Пути относительно корня Obsidian Vault, SHA-256 исходных файлов; они не являются хешами полного HTTP-ответа или производной проекции:

- `Проекты/CoffeeOrderPlatform/Tasty Coffee — API и авторизация.md`, разделы 3–8, 14: `e5704e3de89249e4fad8ae5f858242b68392ee61f93677c603a92fec1cda9ac6`.
- `Проекты/CoffeeOrderPlatform/Tasty Coffee — исследование API для разработки и пакетной загрузки.md`, разделы 6, 10–12: `9d00987bf84cc608b3bd6cdab044885017ea960d507e9f2c0f15fafd306c7669`.
- `Вложения/CoffeeOrderPlatform/Tasty/2026-10-25/http-evidence.json`, `steps[15..22]` (`changedRows`, labels и статусы): `4b9c132523826de7528adef56fe98fe9fd1d1c3a468be07f06dddeac341eb9ce`.
- `Вложения/CoffeeOrderPlatform/Tasty/2026-10-25/developer-fixtures.json`, `products[0].offers`, `cartTen.data[0]`: `9841fe68dd3db866344d7dd6a5e97d676854a2a28f191d7fbfd5dcbadbb620db`.

Источники — заметки и выбранные поля сохранённых evidence, не raw HTTP bodies. Связь product-A с offers взята из fixtures и раздела 11 исследования; проекция after/before не является replay-командой. Хеш самой проекции записан в handoff #182.
