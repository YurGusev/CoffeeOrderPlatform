Последняя read-only проверка: [transformed unit/identity observations 18 сентября](2026-09-18-read-only-unit-identity-observations.json). Raw bodies/identifiers, credentials, cookies и PII не сохранялись; provider mutations не выполнялись.

Последняя mutation-проверка: [согласованные cart mutations и подтверждённая очистка](2026-09-12-cart-mutations/README.md).

Актуальный следующий этап: [preflight и точный сценарий проверки adapters](2026-09-12-adapter-preflight/README.md).

# Обезличенный отчёт наблюдений AROMA

Продолжение с разрешённой учётной записью: [12 сентября — authenticated login/cart/catalog](2026-09-12-authenticated/README.md). Подтверждены доступ и пустая корзина; найдено рассогласование development credentials с рабочим encrypted import. Mutations не выполнялись.

Новое исследование: [12 сентября 2026 — bounded GET и sanitized response-body captures](2026-09-12/README.md). Оно добавляет полные JSON-структуры трёх публичных страниц каталога и unauthenticated cart 403; ограничения и происхождение описаны отдельно. Исторический отчёт ниже не меняет своей классификации.

`catalog-and-session-2026-09-08.json` — минимальная выборка live read-only
наблюдений на `https://aromateacoffee.ru`. Это преобразованный отчёт
наблюдений, а не raw capture, synthetic fixture или fixture для provider
decoder. Время указано в UTC; для каждого запроса сохранены provenance, method,
path, status, content type и полнота чтения.

Преобразования отчёта:

- raw provider product/offer IDs заменены на локальные псевдонимы `productKey`/
  `offerKey` с сохранением отношений product → offer;
- поля переименованы: `name → displayName`, `param_value → paramValue`,
  `sold_by_piece → soldByPiece`, `product_on_stop → productOnStop`,
  `show_on_wholesale → showOnWholesale`; также `id` представлен как
  `productKey` или `offerKey`;
- raw response bodies не сохранялись: они заменены сводками `responseShape`,
  counts/field names, status, content type, `bytesRead`, `bodyComplete` и
  отдельными выбранными `sample`;
- absolute pagination links сокращены до `absoluteLinkHosts`, а credentials,
  cookie values, profile values и PII удалены.

Не использовать этот JSON как образец исходного provider wire format и не
подключать его к тестам provider decoder: это transformed observation report,
а не decoder fixture. Login был разрешён только для чтения user/cart/catalog;
cart, order, payment и profile mutations не выполнялись.

Страница `/wholesale` вернула KillBot verification, поэтому отчёт не содержит
UI controls, screenshots или frontend bundle. Непустая корзина, mutation
ack/reject, missing-line outcome и quantity bounds требуют отдельного
разрешённого controlled test по плану в
`docs/launch/27_AROMA_PROVIDER_PROTOCOL.md`.

## Исправление login probe 18 сентября 2026

[Преобразованный отчёт](2026-09-18-login-probe-correction.json): предыдущие `422` вызваны неверным чтением вложенных secret fields в исследовательском скрипте, а не подтверждённым отказом действующей учётной записи. Исправленный probe получил `200` для login, catalog, cart и grinds. Production lookup не затронут. Отчёт не является wire fixture и не доказывает универсальный packing/grind mapping.
