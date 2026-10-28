# Tasty: наблюдения об авторизации и сессии

Историческая проверка одного аккаунта 25.10.2026, не официальный контракт и не production acceptance. [Обезличенные receipts](../../../evidence/tasty/session/observations.json) — производная проекция выбранных фактов, не ответы сервера. Исследование с сохранёнными receipts выполнялось в интервале 2026-10-25T16:56:30.356Z–2026-10-25T17:16:41.670Z; для первичной заметки известно только число.

| Переход или условие | Доказательство и граница |
|---|---|
| Вход `POST /auth/login` | Наблюдался 200 и получен токен; без сохранения токена или профиля в этом корпусе. |
| Авторизованный контрольный запрос | В заметке `Bearer` дал 200, `bearer` — 401. Это наблюдение конкретного запроса, не гарантия для каждого endpoint. |
| Запрос без токена | `GET /catalog/cart` получил 401; это не доказывает единую защиту всех маршрутов. |
| `expires_in` | Сервер объявил 2592000 секунд (30 суток); это объявленный TTL, а не измеренный срок жизни. |
| Фактическое expiry | `NOT_PROVEN`: нужно наблюдение запроса до и после истечения конкретного токена. |
| Refresh | `NOT_PROVEN`: нужно разрешённое наблюдение ответа и работоспособности старого/нового токена. Наличие маршрута в JS не доказывает серверное поведение. |
| Logout/revocation | `NOT_PROVEN`: нужно отдельно проверить отзыв и влияние на другие сессии; наличие маршрута в JS не доказательство. |
| Rate limits и восстановление после 401 | `NOT_PROVEN`: нужны разрешённые наблюдения ограничений и ответов; автоматический retry не следует из этого evidence. |

Для будущего read-only транспорта credentials доступны только Gateway через trusted scoped bootstrap и tmpfs; доступ к provider origin ограничивается allowlist. Catalog, Orders и browser не получают provider credentials. Текущий `readTastyCredentials` не является готовой runtime session. Эти границы следуют [конфигурации и секретам](../../launch/11_CONFIGURATION_AND_SECRETS.md) и [service identity](../../launch/24_SERVICE_IDENTITY_AND_DELEGATION.md); конкретные Tasty runtime, scopes и allowlist требуют отдельного решения; реализация и изменение SOPS/config не входят в задачу.

## Происхождение

Пути относительно корня Obsidian Vault; SHA-256 относятся к сохранённым исходным файлам, не к полным HTTP-ответам и не к производной проекции:

- `Проекты/CoffeeOrderPlatform/Tasty Coffee — API и авторизация.md`, разделы 2, 9–10, 12: `e5704e3de89249e4fad8ae5f858242b68392ee61f93677c603a92fec1cda9ac6`.
- `Проекты/CoffeeOrderPlatform/Tasty Coffee — исследование API для разработки и пакетной загрузки.md`, разделы 3 и 16: `9d00987bf84cc608b3bd6cdab044885017ea960d507e9f2c0f15fafd306c7669`.
- `Вложения/CoffeeOrderPlatform/Tasty/2026-10-25/http-evidence.json`, `authorization.method`, `authorization.successful`, `authorization.tokenType`, `authorization.expiresInSeconds`, `httpReceipts[6]` (`label`, `method`, `status`): `4b9c132523826de7528adef56fe98fe9fd1d1c3a468be07f06dddeac341eb9ce`.

Только заметки и выбранные поля сохранённого evidence; raw HTTP bodies, JS, profile и transport credentials не входят. Хеш производной проекции записан в handoff #184.
