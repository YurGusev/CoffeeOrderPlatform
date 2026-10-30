# Карта проверки apps/web

Этот каталог перечисляет экраны, которые есть в `apps/web/src/browser`.
Перед прогоном прочитать указатель. Затем открыть файл фичи.

Источник маршрутов: `apps/web/src/browser/app/App.tsx`. Оболочка и сессия
лежат в `AppShell.tsx` и `session.tsx`.

## Baseline preconditions

- Запуск из корня репозитория командой `node .cursor/skills/verify-web/run.mjs`.
- Vite слушает только `127.0.0.1` на порту этого run-id.
- Контекст браузера без cookie и без `sessionStorage`.
- `packages/platform-ui/dist` уже собран. Рычаг полную сборку платформы не делает.
- Не открывать Vite, который запустил не этот прогон.

## Driving conventions

- Стабильные опоры: роль, доступное имя, видимый текст, путь маршрута.
- Координаты и порядок Tab не использовать.
- Один проход покрывает только сценарии входа без сессии.
- Сценарий со статусом `not-covered` не считать пройденным через другой путь.
- Evidence после очистки не удалять.

## Proof and skip reporting

- Для проверяемого сценария нужен и снимок действия, и текст результата.
- Доказательство UI: `screenshots/<id>.png` и `screenshots/<id>.aria.txt`.
- В `result.json` у пройденного сценария есть фактический `href` и `documentTitle`.
- Непокрытый сценарий хранит `reason`. Пропущенный из-за раннего сбоя имеет статус `not-run`.
- Код выхода `0` не означает, что непокрытые строки проверены.

## Feature entry contract

У каждой фичи один H1, короткий абзац и четыре заголовка второго уровня
в этом порядке: `Sub-features`, `How to get to it (user POV)`,
`Driving it with verify-web`, `Gotchas`.

## Features

| Фича | Сценарии | Статус |
|---|---|---|
| [Вход без сессии](./session-gate.md) | `session-root`, `session-customers-closed`, `session-catalog-closed`, `session-new-order-closed`, `session-order-closed`, `session-unknown-closed` | проверяется навыком |
| [Вход без сессии](./session-gate.md) | `session-loading`, `session-unavailable`, `root-redirect`, `app-index-redirect` | не покрыто |
| [Клиенты](./customers.md) | `customers-search`, `customers-create` | не покрыто |
| [Каталог](./catalog.md) | `catalog-without-order`, `catalog-search`, `catalog-add` | не покрыто |
| [Новый заказ](./new-order.md) | `new-order-without-customer`, `new-order-create` | не покрыто |
| [Карточка заказа](./order-card.md) | `order-card-read`, `order-card-items`, `order-card-confirm`, `order-card-reconcile` | не покрыто |
| [Неизвестный маршрут](./not-found.md) | `not-found-page` | не покрыто |
| [Оболочка](./workspace-shell.md) | `logout`, `pending-recovery`, `realtime-status` | не покрыто |

В `result.json` это 6 сценариев со статусом проверки и 19 со статусом
`not-covered`. Если числа разошлись с `run.mjs`, верным считать `run.mjs`.
