# AROMA: ограниченная read-only проверка 12 сентября 2026

Статус: исследование формы ответов. Production adapter и полная готовность #10 не подтверждены.

## Scope и происхождение

Выполнены **5 последовательных GET** на `https://aromateacoffee.ru` из бюджета 12 запросов. TLS verification включена, redirects запрещены, timeout каждого запроса 15 секунд, предел ответа 2 MiB. Cookie jar не использовался. Login/refresh, set/remove, заказы и профиль не вызывались. Credentials не расшифровывались.

Открытых браузерных tabs со scoped-сессией не найдено. Наличие encrypted email/password не считается наличием действующей сессии. Поэтому authenticated cart/session behavior в этом этапе не исследовалось.

Точные UTC timestamps, пути, статусы, размеры, hashes и классификация старых samples: [report.json](report.json).

## Что найдено в существующих материалах

- Отчёт `../catalog-and-session-2026-09-08.json` преобразован: переименованы поля, полные тела отсутствуют. Он не является decoder fixture.
- В `CoffeeOrderSystem/docs/Интеграция/samples` найдены **пять** catalog/cart JSON samples, включая успешное добавление строки и ошибки 403/422. README System называет их реальными ответами. Но сами файлы не содержат времени, полного запроса, авторизации и доказательства полноты capture. Это исторические примеры с неполным provenance, а не подтверждение актуальных mutation semantics.
- Старый catalog sample содержит сокращённый набор полей, в частности без `price`; его нельзя объявить полной схемой текущего ответа. Legacy runtime-код и fixtures в Platform не переносились.

## Свежие наблюдения

| Запрос | Результат | Что подтверждает |
|---|---|---|
| catalog page=1, per_page=10 | 200, 167195 bytes, 10 products / 10 offers | Публичный доступ в этом запросе; все наблюдённые цены равны 0 |
| catalog page=24, per_page=10 | 200, 106378 bytes, 10 products / 16 offers | Ненулевые целочисленные цены; `preview` бывает объектом; есть непустой `discount` |
| catalog page=47, per_page=10 | 200, 171671 bytes, 6 products / 24 offers | Последняя страница по `meta`; наблюдены оба значения `product_on_stop` |
| `/wholesale` | 200 text/html, KillBot | UI недоступен для проверки price/unit/quantity controls; challenge не обходился |
| `/api/v1/cart/` без Cookie | 403 application/json | Отказ unauthenticated-запросу; состояние корзины неизвестно |

Всего выбрано 26 products / 50 offers. Это три страницы, **не полный каталог**. Во всех трёх ответах `total=466`, `last_page=47`; совпадение metadata не доказывает snapshot isolation или стабильность страниц при изменении каталога.

Структурные факты:

- Корень каталога: `data`, `links`, `meta`. `offers[].price` в выборке — JSON integer. Отдельных currency/unit/scale в прочитанных product/offer objects не обнаружено.
- `preview` — `null` либо объект с `path`, `title`, `description`; `photos` — массив объектов с такими полями. Нельзя считать preview обязательной строкой.
- Пагинационные ссылки, `meta.path` и наблюдённые media URLs используют `dev.aromateacoffee.ru`. Они сохранены в captures, но **не запрашивались**. Автоматическое следование нарушило бы согласованный fixed origin.
- `discount` бывает пустым или непустым массивом. Наблюдённый элемент содержит `id`, `created_at`, `updated_at`, `product_id`, `user_id: null`, `min_weight: 0`, `discount: 10`. Значение 10 само по себе не доказывает процент, применимость скидки или формулу расчёта.
- `product_on_stop` наблюдён как true/false; `show_on_wholesale` во всех samples true, `sold_by_piece` false. Нельзя выводить полную модель availability или правила quantity из этих трёх flags.

## Пригодность captures

[page1.json](page1.json), [page24.json](page24.json), [page47.json](page47.json) и [cart-public.json](cart-public.json) сохраняют полную полученную JSON-структуру: поля не переименованы, элементы не выброшены, JSON types сохранены.

Санитизация: ненулевые integer/string значения полей `id` и `*_id` заменены согласованными псевдонимами с сохранением типа и равенства между captures. Таблица соответствия не сохранялась. Публичные названия, описания, vendor codes и media URLs сохранены; значения email не найдены. Headers с cookies/auth не сохранялись, HTML challenge не включён. Поэтому это **sanitized response-body captures**, не byte-identical wire bytes. Hashes raw body и сохранённого файла разделены в report.

Captures пригодны для characterization-тестов наблюдённой структуры. Они не задают полную обязательную provider schema и не разрешают production normalization. Связь псевдонимов ID с ID, закодированными в публичных vendor codes/URLs, не моделируется; такие отношения по этим fixtures не проверять.

## Решения для следующего этапа

| Область | Что можно делать | Что остаётся заблокированным |
|---|---|---|
| Decoder структуры | Использовать эти captures для проверки JSON shapes, nullability и pagination metadata | Полная схема всех категорий, обязательность полей и negative/incomplete corpus |
| Деньги | Сохранить факт числового price в evidence | Currency, scale, basis упаковка/вес, zero-price semantics, скидки и округление |
| Изображения | Учесть object/null preview и media paths | Policy получения/выдачи изображений с другого origin; не расширять egress автоматически |
| Identity | Исследовать offer/params по сохранённой структуре | Полнота variant/packing/grind identity; production binding population |
| Snapshot | Проверять согласованность page/meta | Provider consistency; определить authority `providerSnapshotRef`, не требуя одноимённого поля у поставщика без основания |
| Session/cart | Зафиксировать unauthenticated 403 | Действующая scoped-сессия или отдельно разрешённый login; непустой cart, duplicates и completeness |
| Set/remove | Использовать старые samples только как исторические свидетельства | Endpoints/payload/acknowledgement/missing-line semantics требуют спецификации или отдельной контролируемой проверки мутаций |

Для следующей authenticated проверки требуется доступная scoped-сессия либо разрешение на один штатный login в прежнюю учётную запись. Read-only GET не докажет set/remove semantics. Повторять публичные запросы без нового вопроса к данным не требуется.

Новые runtime routes/adapters, contracts и зависимости в этой работе не создавались. Commit, push, PR, merge, deployment и изменение issue не выполнялись. Handoff core #10 не переоформлялся в production acceptance.
