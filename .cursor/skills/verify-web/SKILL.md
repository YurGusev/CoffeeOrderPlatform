---
name: verify-web
description: Проверить операторскую SPA apps/web живым Chromium на локальном Vite, со скриншотами и кодом выхода. Use when a web screen change must be shown in a browser, or when the web feature map needs a fresh pass or not-covered count.
---

# Проверка apps/web

Срез один. Локальный Vite отдаёт `apps/web`, Playwright открывает Chromium.
Рычаг проходит экран до сессии и сохраняет скриншот каждого такого входа.
Edge-auth, Customer, Catalog, Orders, nginx и Kafka этот прогон не поднимает.

Запускать после видимого изменения `apps/web`. Не запускать вместо
`pnpm test:web-operator` и `pnpm test:playwright`. Правки интерфейса и
`client-v1` остаются в навыке
[react-operator-frontend](../../../.agents/skills/react-operator-frontend/SKILL.md).
Отказы, восстановление, security и SLO остаются в навыке
[reliability-verification](../../../.agents/skills/reliability-verification/SKILL.md).

Карта экранов лежит в [features/README.md](features/README.md). Состав
evidence и расширение сценария описаны в [reference.md](reference.md).

## Launch

Из корня репозитория:

```bash
node .cursor/skills/verify-web/run.mjs
```

Нужны Node из toolchain, pnpm, зависимости репозитория и сборка
`packages/platform-ui/dist`. Скрипт сам выбирает свободный порт на
`127.0.0.1` и запускает тот же Vite, что `pnpm dev:browser` в `apps/web`.
Порт 5173 он не занимает. Повторный запуск создаёт новый run-id и новый
процесс. Готовность наступает, когда в `vite.log` есть
`http://127.0.0.1:<port>/`, а `GET /` возвращает HTML с `#root` и title
`CoffeeOrderPlatform — Оператор`.

Код выхода `0` значит, что все сценарии со статусом проверки прошли.
Код `1` значит сбой старта, doctor или сценария. Непокрытые сценарии
код `0` не превращают в код `1`.

## Doctor

Doctor выполняется внутри того же запуска, до браузера. Отдельной команды нет.
Смотреть `evidence/web-verify/<run-id>/doctor.json`.

Прогон стоит продолжать только если одновременно верно всё ниже.

- `httpStatus` равен 200.
- `titleFound` равен true.
- `portOwned` равен true. Слушает процесс с `VERIFY_WEB_RUN=<run-id>`.
- Чужой Vite на этом порту скрипт не открывает.

Если doctor не сошёлся, браузер не запускается, в `result.json` статус `fail`.

## Drive

Браузер Chromium, headless, чистый контекст 1280 на 800, без cookie.
Первый документ ждёт текст до 120 секунд, потому что Vite собирает модули
на первом запросе. Дальше таймаут 30 секунд. `networkidle` не используется.
Сокет HMR его не отдаёт.

Скрипт открывает шесть адресов. На каждом виден текст `Требуется вход` и
ссылка `Войти через защищённый контур`. Адрес ссылки:

| Путь | `returnTo` |
|---|---|
| `/` | `/app/customers` |
| `/app/customers` | `/app/customers` |
| `/app/catalog` | `/app/catalog` |
| `/app/orders/new` | `/app/orders/new` |
| `/app/orders/not-an-order` | `/app/orders/not-an-order` |
| `/no-such-page` | `/app/customers` |

Кнопка `Выйти` и тексты закрытых экранов на этих страницах отсутствуют.
Рецепт по экранам лежит в `features/`. Экран за сессией скрипт не кликает
и не помечает пройденным.

Мок `GET /auth/session` в этот рычаг не добавлять. Такой мок уже живёт в
`apps/web/test/operator-flow.spec.ts`.

## Evidence

Каталог `evidence/web-verify/<run-id>/` в git не входит. Очистка его не удаляет.

- `result.json` хранит `status`, `passed`, `failed`, `notCovered` и сценарии.
  `pass` пишется только когда все проверяемые сценарии уже прошли.
  Промежуточная запись имеет статус `incomplete`. Сбой имеет статус `fail`.
- `screenshots/<id>.png` показывает экран после проверки.
- `screenshots/<id>.aria.txt` хранит ARIA-снимок `main`.
- `doctor.json`, `run.json`, `vite.log`, `browser.log` и `environment.json`
  описывают процесс, порт и commit. Паролей в них нет.

`pass` при шести экранах входа не доказывает поиск, создание клиента,
каталог, черновик, карточку заказа, 404, выход или realtime.

## Cleanup

Скрипт в `finally` закрывает свой Chromium и посылает `SIGTERM`, затем
`SIGKILL`, только процессам с `VERIFY_WEB_RUN` этого run-id. Чужой процесс
по имени `node` или `vite` не останавливается.

Если процесс убили до очистки:

```bash
node .cursor/skills/verify-web/run.mjs --down <run-id>
```

`--down` читает `run.json` и останавливает только помеченные процессы.
Evidence остаётся на месте.

## Helpers

Исполняемый файл `.cursor/skills/verify-web/run.mjs`.

```bash
node .cursor/skills/verify-web/run.mjs
node .cursor/skills/verify-web/run.mjs --down <run-id>
```

| Код | Значение |
|---|---|
| 0 | проверяемые сценарии прошли, Vite этого run-id остановлен, evidence на месте |
| 1 | старт, doctor, сценарий или аргументы не прошли; свой Vite остановлен, если успел подняться |

## Карта сценариев

| Сценарий | Статус |
|---|---|
| `/` показывает вход и прячет рабочее пространство | проверяется навыком |
| `/app/customers` без сессии не показывает поиск клиентов | проверяется навыком |
| `/app/catalog` без сессии не показывает каталог | проверяется навыком |
| `/app/orders/new` без сессии не показывает новый заказ | проверяется навыком |
| `/app/orders/not-an-order` без сессии не показывает карточку | проверяется навыком |
| `/no-such-page` без сессии не показывает страницу 404 | проверяется навыком |
| Надпись загрузки сессии | не покрыто |
| Экран недоступного сервера сессии | не покрыто |
| Редирект `/` и `/app` после сессии | не покрыто |
| Поиск и создание клиента | не покрыто |
| Каталог без заказа, поиск и добавление товара | не покрыто |
| Новый заказ без клиента и создание черновика | не покрыто |
| Чтение карточки, позиции, подтверждение, сверка AROMA | не покрыто |
| Страница «Маршрут не найден» | не покрыто |
| Выход, восстановление команд, статус realtime | не покрыто |

Идентификаторы и причины лежат в `run.mjs` и в файлах `features/`.
Когда экран в коде изменился, карту правит следующий прогон
`maintain-verification-skill`. Этот рычаг сам карту не переписывает.

## Чего этот срез не делает

Не поднимает nginx, `/auth/login`, owner API и SSE. Не заменяет launch gate
`pnpm test:playwright`. Не объявляет deployment.
