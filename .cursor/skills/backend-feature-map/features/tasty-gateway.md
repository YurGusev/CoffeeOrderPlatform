# tasty-gateway

Клиент чтения Tasty Coffee. Каталога `apps/tasty-gateway` нет в
`config/service-catalog.json` и нет в списке runtime `config/platform.yaml`.
`main.ts` и входящих маршрутов нет. Контракта `*-v1` для этих путей нет.
Исходящие вызовы собирает `apps/tasty-gateway/src/infrastructure/provider/http-client.ts`
на хост `api.tastycoffee.ru`.

## Операции

| Операция | Источник | Покрытие |
|---|---|---|
| исходящий `POST /api/v1/auth/login` | `http-client.ts` `login` | только unit/integration тесты (`tests/tasty/provider-http.test.mjs`) |
| исходящий `GET /api/v1/catalog/products` | `http-client.ts` `read("catalog")` | только unit/integration тесты (`tests/tasty/provider-http.test.mjs`) |
| исходящий `GET /api/v1/catalog/cart` | `http-client.ts` `read("cart")` | только unit/integration тесты (`tests/tasty/provider-http.test.mjs`) |

Разбор ответов лежит в `catalog-decoder.ts` и `cart-decoder.ts`. Их проверяют
`tests/tasty/catalog-decoder.test.mjs` и `tests/tasty/cart-decoder.test.mjs`.
Сессию проверяет `tests/tasty/provider-session.test.mjs`.

## События

Публикаций и потреблений в коде каталога нет.
