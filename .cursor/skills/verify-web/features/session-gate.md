# Вход без сессии

Пока `GET /auth/session` не вернул живую сессию, оператор видит загрузку,
требование входа или недоступность проверки. Рабочие страницы в этом
состоянии не рисуются. Так устроен `SessionBoundary` в `session.tsx`.

## Sub-features

- `session-root` проверяется навыком. Путь `/` показывает «Требуется вход».
- `session-customers-closed` проверяется навыком. Путь `/app/customers` не показывает поиск.
- `session-catalog-closed` проверяется навыком. Путь `/app/catalog` не показывает каталог.
- `session-new-order-closed` проверяется навыком. Путь `/app/orders/new` не показывает новый заказ.
- `session-order-closed` проверяется навыком. Путь `/app/orders/not-an-order` не показывает карточку.
- `session-unknown-closed` проверяется навыком. Путь `/no-such-page` не показывает «Маршрут не найден».
- `session-loading` не покрыто. Текст «Проверяем сессию оператора».
- `session-unavailable` не покрыто. Текст «Не удалось проверить сессию» и кнопка «Повторить проверку».
- `root-redirect` не покрыто. После сессии `/` заменяется на `/app/customers`.
- `app-index-redirect` не покрыто. После сессии индекс `/app` заменяется на `/app/customers`.

## How to get to it (user POV)

- Открыть `/`.
- Открыть любой путь `/app/...` до входа.
- Открыть адрес, которого нет в маршрутах, до входа.
- Перейти по ссылке «Войти через защищённый контур». Этот прогон переход не выполняет. Vite не содержит страницу входа.

## Driving it with verify-web

Preconditions:

- `node .cursor/skills/verify-web/run.mjs` дошёл до doctor с `ok: true`.
- В контексте браузера нет cookie сессии.

- **Открыть `/`.** Скрипт открывает origin этого прогона. Виден текст «Требуется вход». Ссылка «Войти через защищённый контур» ведёт на `/auth/login?returnTo=%2Fapp%2Fcustomers`. В тексте нет «Клиенты» и «Начните поиск клиента». Кнопки «Выйти» нет. Снимок `screenshots/session-root.png`.
- **Открыть `/app/customers`.** Тот же экран входа. `returnTo` равен `/app/customers`. В тексте нет «Начните поиск клиента» и «Новый клиент». Снимок `screenshots/session-customers-closed.png`.
- **Открыть `/app/catalog`.** `returnTo` равен `/app/catalog`. В тексте нет «Поиск товаров» и «Не выбран заказ». Снимок `screenshots/session-catalog-closed.png`.
- **Открыть `/app/orders/new`.** `returnTo` равен `/app/orders/new`. В тексте нет «Новый заказ» и «Сначала выберите клиента». Снимок `screenshots/session-new-order-closed.png`.
- **Открыть `/app/orders/not-an-order`.** `returnTo` равен `/app/orders/not-an-order`. В тексте нет «Заказ не найден», «Состав заказа» и «Некорректный orderRef». Снимок `screenshots/session-order-closed.png`.
- **Открыть `/no-such-page`.** Путь не начинается с `/app/`, поэтому `returnTo` равен `/app/customers`. В тексте нет «Маршрут не найден». Снимок `screenshots/session-unknown-closed.png`.
- **Зафиксировать title.** На каждом из этих экранов `document.title` равен `CoffeeOrderPlatform — Оператор`.

## Gotchas

- Ответ Vite на `GET /auth/session` имеет статус 404 и не является JSON сессии. Строка попадает в `browser.log`. Клиент получает protocol error, не HTTP 500. Поэтому виден «Требуется вход», а не «Не удалось проверить сессию».
- Надпись загрузки может исчезнуть до снимка. Её отсутствие в png не является ни провалом, ни доказательством `session-loading`.
- Экран входа не доказывает фичи клиентов, каталога, заказа, 404 и оболочки.
- Редирект с `/` в коде стоит внутри `SessionBoundary` и без сессии не выполняется.
- Не подменять `/auth/session` ответом 200 внутри этого рычага.
