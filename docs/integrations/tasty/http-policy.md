# Tasty: конкретизация изолированного HTTP-клиента #194

Статус: Accepted владельцем 28.10.2026 в текущей беседе; конкретизация ADR-0038.
Это локальная policy Integration, а не утверждение о гарантиях Tasty.

## Контракт

- `apps/tasty-gateway/src/infrastructure/provider/http-client.ts`:
  `TastyHttpClient`, `TastyHttpError`, операции `catalog`, `cart` и отдельная
  операция `login`. Origin фиксирован: `https://api.tastycoffee.ru`; пути
  `/api/v1/catalog/products`, `/api/v1/catalog/cart`, `/api/v1/auth/login`.
  Нельзя передать URL, path, query, headers или HTTP method из business caller.
- Каталог и корзина используют только GET с `Authorization: Bearer <token>`.
  Login — отдельный POST без Bearer; никакие другие POST/DELETE не существуют.
  Все операции запрещают redirects и не повторяются автоматически.
- `timeoutMs` и `maxResponseBytes` обязательны в constructor, без production
  defaults: положительные безопасные целые, `timeoutMs` не более 2147483647.
  Срок доступен для #195 через read-only `timeoutMs`. Будущий trusted composition
  root #196 берёт параметры из `config/platform.yaml`; здесь config/runtime не
  меняются. Локальный fixture задаёт 150 ms для deadline/cancellation и 5000 ms для
  функциональных ответов при лимите 64 bytes: это не production settings и не
  SLO.
- Один timeout охватывает fetch и всё чтение тела. Caller AbortSignal
  отменяет запрос. Проверяются Content-Length и фактически полученные bytes.
  Не-2xx, redirect, timeout, cancellation, transport error, oversized response,
  неправильный Content-Type/UTF-8/JSON дают безопасные typed errors. Коды:
  `TASTY_HTTP_REJECTED`, `TASTY_HTTP_REDIRECT`, `TASTY_HTTP_TIMEOUT`,
  `TASTY_HTTP_CANCELLED`, `TASTY_HTTP_TRANSPORT`, `TASTY_HTTP_TOO_LARGE`,
  `TASTY_HTTP_INVALID_JSON`, `TASTY_HTTP_INVALID_INPUT`; только rejection
  передаёт HTTP status. Ошибки не содержат token, credentials, raw body или
  исходную exception cause.
- Успех возвращает исходный JSON text: повторный JSON.parse не должен потерять
  исходные numeric lexemes перед catalog decoder #187. Это transport validation,
  а не доказательство полноты catalog/cart или account/cartScope.
- Нативный fetch и существующий node:test HTTP fixture pattern; без dependencies,
  запуска сервиса, OpenAPI, новых secrets, refresh/logout или provider calls.

## Проверка

`tests/tasty/provider-http.test.mjs`: локальный HTTP server с test-only
перенаправлением фиксированного provider URL на loopback, success/401/HTML,
invalid JSON, declared/streamed oversized body, deadline/cancellation в том числе
после headers, redirect без запроса target, transport error и secret redaction.
Тестовое перенаправление не является option production клиента.

Команды: `pnpm exec tsc -b apps/tasty-gateway --pretty false`,
`node --test tests/tasty/provider-http.test.mjs`, `pnpm typecheck`, `pnpm lint`,
`pnpm architecture:check`, `git diff --check`.

## Входы и ограничения

[ADR-0038](../../adr/ADR-0038-tasty-readonly-boundaries.md),
[session evidence #184](session.md) и
[конфигурация](../../launch/11_CONFIGURATION_AND_SECRETS.md).
Фиксированные endpoint paths сверены с сохранённым корпусом исследования.
Runtime admission, production limits и проверка account/cartScope остаются #196.
