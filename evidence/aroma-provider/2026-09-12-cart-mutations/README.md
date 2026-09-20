# AROMA: согласованная проверка корзины 12 сентября 2026

Статус: bounded characterization выполнена. **Корзина восстановлена:** последний
полный GET пуст и равен начальному JSON. Заказы, счета, checkout, оплата и профиль
не изменялись. Это исследование provider behavior, а не приёмка production #10.

## Сценарий и факты

Пользователь отдельно разрешил [подготовленный сценарий](../2026-09-12-adapter-preflight/README.md).
Один offer `C-200-26`, упаковка 200 г, зерновой, `packing=Aroma`, `grind_id`
не передавался. ID получен из свежего каталога; raw ID из старых captures не использовался.

| Запрос | Status | Последующий отдельный GET |
|---|---:|---|
| POST cart: `quantity=1`, form-urlencoded | 200 | Одна строка, quantity=1, packing=Aroma, grind_id=null |
| PUT созданной строки: `quantity=2`, JSON | 200 | Та же строка, quantity=2 |
| Повторный запланированный PUT: `quantity=2` | 200 | Та же строка, quantity=2; увеличения нет |
| POST того же offer: `quantity=1` | 422 | Строка осталась с quantity=2, дубль не появился |
| DELETE созданной строки | 200 | Пустая корзина |
| DELETE того же уже удалённого ID | 404 | Пустая корзина |

Ответ duplicate POST содержит `error: "Товар уже в корзине"`. Исходное значение
`errors.offer_id` заменено sanitizer по имени поля; точный текст этого вложенного
сообщения не сохранён. DELETE missing вернул JSON `error` о ненайденном CartItem.
HTTP 404 не превращается автоматически в production acknowledgement: здесь
подтверждено только удаление именно test-owned ID и отсутствие изменений по GET.
Произвольный 404, 422 или 2xx на другом payload этим не классифицирован.

Успешные mutation responses содержали полную `products` форму, совпавшую с
отдельным последующим GET. Это последовательное наблюдение в одной учётной
записи, а не доказательство атомарности response/GET при чужих изменениях.

## Денежные поля и количество

| Поле | quantity=1 | quantity=2 |
|---|---:|---:|
| `products[0].price` | 620 | 1240 |
| `products[0].total_with_discount` | 434 | 868 |
| `products[0].discount_value` | 30 | 30 |
| `products[0].offer.price` | 852.6 | 852.6 |
| `prices.weights.kofe` | 200 | 400 |
| `prices.total.default` | 620 | 1240 |
| `prices.total.promo` | 434 | 868 |

В выбранном offer одна единица quantity соответствует наблюдаемому весу 200,
две — 400; это согласуется с названием упаковки 200 г. Цена строки зависит от
количества и отличается от вложенной `offer.price`. Нельзя читать цену единицы
из `products[].price` без учёта quantity или подменять её `offer.price`.
Расчёт 620 × 0.7 = 434 согласуется с наблюдаемой скидкой 30, но не определяет
все discount rules. Валюта, денежный scale, НДС и глобальный price basis не
доказаны. API вернул дробный `offer.price`, поэтому integer-only decoder этого
поля отверг бы наблюдаемый ответ.

## Прерывание и очистка

Первый скрипт ожидал 2xx на каждом mutation step и остановился на полностью
полученном 422 повторного POST. Два GET подтвердили неизменную тестовую строку;
повторного POST не было. Cookie jar первого процесса уже был очищен.

Для согласованного cleanup выполнен второй login из того же canonical
development scope. Это отклонение от запланированного одного login,
зафиксированное отдельно в report. Перед DELETE полный raw hash нового GET
совпал с hash последнего pre-cleanup GET. Дополнительно проверены единственная
строка, vendor code, quantity=2, packing и grind_id. Удалён только этот ID.

Всего **2 login, 10 GET, 6 cart mutations**. Лимиты мутаций 7 и GET 12 соблюдены.
Redirects запрещены, TLS verification включена, размер ответа ≤2 MiB,
timeout login 20 секунд, других запросов 15 секунд. Automatic retry отсутствует.
Credentials раскрывались только в памяти из canonical encrypted inventory;
cookie jars очищены, logout не выполнялся. Никаких provider requests к dev host.

## Evidence и ограничения

[report.json](report.json) содержит порядок запросов, timestamps, status, размеры,
raw/sanitized SHA-256 и ссылки на **14 обезличенных полных cart responses**.
JSON fields/types/arrays сохранены, ID values заменены согласованными
псевдонимами. Таблица соответствия не сохранена. Это sanitized captures, а не
байтово идентичные wire bodies и не полная schema поставщика.

Подтверждены только этот offer, `packing=Aroma`, quantities 1/2 и описанные
set/add/delete responses. Не подтверждены min/max/step, дробный quantity, другие
packing/grind combinations, чужие/неоднозначные строки, expiry/refresh, ошибки
после возможного dispatch, полный Catalog export и его денежная нормализация.

Production adapters/wiring в этом этапе не изменялись. Неподтверждённые свойства
остаются закрытыми для production; исследовательский скрипт не является adapter.
Commit, push, merge и deployment не выполнялись.
