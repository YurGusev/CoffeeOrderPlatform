# AROMA: проверка действующей учётной записи 12 сентября 2026

Пользователь разрешил использовать действующую учётную запись и выполнять тестовые запросы. Выполнены login и safe GET; set/remove, checkout, заказы, профиль, logout и refresh не вызывались. Готовность production adapter и issue #10 не заявляется.

## Результат

| Операция | Результат |
|---|---|
| Login с development-парой canonical SOPS inventory | 422, error/errors.email; текст ошибки и значения credentials не сохранены |
| Login с ранее перенесённой учётной записью System из encrypted import | 200 |
| GET `/api/v1/user` | 200; email совпал с использованной учётной записью при сравнении в памяти |
| GET `/api/v1/cart/` | 200; `products: []`, пустые массивы prices, totals default/promo равны 0 |
| GET catalog page 1, per_page=10 | 200; набор vendor codes и цены совпали с ранее полученной публичной страницей; цены равны 0 |
| GET catalog page 24, per_page=10 | 200; набор vendor codes и цены совпали с ранее полученной публичной страницей |

Всего 6 HTTP requests: две login-попытки с различными локальными источниками credentials и четыре GET. После 422 повтор той же пары не выполнялся. Сначала в памяти установлено несовпадение canonical development email/password с ранее перенесённой парой, затем проверен этот известный источник. Это не подбор учётных данных.

Origin фиксирован: `https://aromateacoffee.ru`. Redirects запрещены; TLS verification включена. Предел ответа 2 MiB, timeout login 20 секунд, GET 15 секунд. Пароль, email и cookies использовались только в памяти процесса. Cookie jar очищен; logout на сервере не вызывался. Cookie values, request bodies login и значения профиля не сохранялись. HTML/CAPTCHA не проверялись повторно.

## Найденное рассогласование credentials

Пара `environments.development.aroma.email/password` из `secrets/platform.secrets.sops.yaml` отличается от рабочего encrypted import и не прошла этот login. Другие environment credentials не проверялись.

Рабочий источник: `/home/yurgusev/.local/share/coffee-platform/imports/aroma-import.secrets.sops.yaml`, ранее сохранённый по запросу пользователя из System. Его использование ограничено исследованием. Он **не должен стать runtime fallback или вторым источником конфигурации Platform**.

После исследования пользователь отдельно разрешил исправить учётную запись. В canonical encrypted inventory обновлены только `environments.development.aroma.email` и `.password` из проверенного импорта. Остальные encrypted leaves, включая staging/production и Gateway signing/encryption keys, побайтно сохранены; изменились также служебные SOPS MAC/lastmodified. Scoped decryption/MAC verification, `pnpm config:check` и `pnpm security:secrets` прошли. Повторный provider login после копирования не выполнялся: проверено равенство новой пары успешно использованной паре. Runtime по-прежнему должен получать секреты только через config-bootstrap; сервисы не перезапускались.

## Evidence

- [report.json](report.json): точные timestamps/status/bytes, только shapes login/profile, boolean account match, сравнение цен и hashes captures.
- [cart.json](cart.json): полный JSON текущей пустой корзины.
- [catalog-page1.json](catalog-page1.json), [catalog-page24.json](catalog-page24.json): sanitized JSON страниц авторизованного каталога.

Имена полей, JSON types и массивы сохранены. Значения `id`/`*_id` заменены согласованными псевдонимами внутри этого набора; email strings редактируются. Таблица соответствия не сохранена. Псевдонимы отличаются от публичного capture set; сравнение offers выполнено по уникальным в обеих выборках `vendor_code`, с проверкой равенства множеств. Public/authenticated сравнение последовательное: оно не исключает промежуточные изменения провайдера и не доказывает отсутствие персональных цен вообще.

Cookie names/domain/path/secure/expiry отражают CookieJar после GET. HttpOnly/SameSite исключены: helper не сохранил исходное написание атрибутов, и case-sensitive lookup не доказывает их отсутствие. Этот этап не пересматривает историческое наблюдение атрибутов от 8 сентября и не задаёт session TTL.

## Что теперь можно и нельзя утверждать

Подтверждены успешный login действующей учётной записи, совпадение аккаунта, доступ к cart GET и полностью прочитанный JSON пустой корзины. Отсутствие авторизации не объясняет нулевые цены первой страницы в этих samples.

Не подтверждены:

- непустые строки корзины, uniqueness/duplicates и разрешение cart-line identity;
- валюта, scale, price basis и смысл price=0;
- quantity/packing/grind semantics и допустимые пределы;
- истечение сессии, refresh, concurrent refresh и re-auth policy;
- acknowledgement/reject и missing-line behavior для set/remove;
- полный provider-backed export и production runtime readiness.

Следующий этап: использовать captures для структурных decoder-тестов; запрашивать недостающие бизнес-факты у поставщика либо проверять их отдельным согласованным сценарием. Canonical development credentials уже исправлены последующим разрешённым изменением. Создавать непустую корзину или считать unsafe semantics доказанными по текущему пустому ответу запрещено.

Commit, push, PR, merge, deployment и изменение issue не выполнялись. Core handoff не менялся.
