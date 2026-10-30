# edge-nginx

Публичный TLS-фронт. Исполняемый конфиг `apps/edge-nginx/generated/nginx.conf`.
Его собирает `tools/nginx/generate.mjs` из `contracts/openapi/client-v1.yaml`
и `config/platform.yaml`. Процесс Node и `startConfiguredRuntime` здесь не используются.
Своих событий Kafka нет.

`tests/nginx/image.test.mjs` и `tests/nginx/cutover.test.mjs` открывают nginx и
вызывают часть location. Строка ниже стоит `не покрыто`, если запрос к этому
location в `tests/nginx` не найден.

## Операции

| Операция | Источник | Покрытие |
|---|---|---|
| `GET /` отвечает 303 на `/app/customers` | `nginx.conf` | только unit/integration тесты (`tests/nginx/image.test.mjs`) |
| `GET /app/` | `nginx.conf` | только unit/integration тесты (`tests/nginx/image.test.mjs`) |
| `GET /assets/` | `nginx.conf` | только unit/integration тесты (`tests/nginx/image.test.mjs`) |
| `GET /auth/login` прокси на `edge-gateway` | OpenAPI `beginBrowserLogin`; `nginx.conf` | не покрыто |
| `GET /auth/callback` прокси на `edge-gateway` | OpenAPI `completeBrowserLogin`; `nginx.conf` | только unit/integration тесты (`tests/nginx/image.test.mjs`) |
| `GET /auth/session` прокси на `edge-gateway` | OpenAPI `getBrowserSession`; `nginx.conf` | только unit/integration тесты (`tests/nginx/image.test.mjs`) |
| `POST /auth/logout` прокси на `edge-gateway` | OpenAPI `endBrowserSession`; `nginx.conf` | только unit/integration тесты (`tests/nginx/image.test.mjs`) |
| `GET /_edge/authorize` внутренний вызов `edge-gateway` | OpenAPI `authorizeBrowserIngress`; `nginx.conf` | только unit/integration тесты (`tests/nginx/image.test.mjs`) |
| `GET /health/live` | `nginx.conf` | только unit/integration тесты (`tests/nginx/image.test.mjs`) |
| `GET /health/ready` отвечает 404 | `nginx.conf` | только unit/integration тесты (`tests/nginx/image.test.mjs`) |
| `GET /metrics` отвечает 404 | `nginx.conf` | только unit/integration тесты (`tests/nginx/image.test.mjs`) |
| `GET /nginx_status` на порту 8081 | `nginx.conf` | только unit/integration тесты (`tests/nginx/image.test.mjs`) |
| `GET /api/client-v1/customers` | OpenAPI `searchCustomers`; `generate.mjs` | не покрыто |
| `POST /api/client-v1/customers` | OpenAPI `createCustomer`; `generate.mjs` | не покрыто |
| `GET /api/client-v1/catalog/products` | OpenAPI `searchCatalogProducts`; `nginx.conf` | только unit/integration тесты (`tests/nginx/image.test.mjs`) |
| `POST /api/client-v1/pricing/quotes` | OpenAPI `createPricingQuote`; `generate.mjs` | не покрыто |
| `POST /api/client-v1/orders/drafts` | OpenAPI `createOrderDraft`; `nginx.conf` | только unit/integration тесты (`tests/nginx/image.test.mjs`, `tests/nginx/cutover.test.mjs`) |
| `PUT /api/client-v1/orders/{orderRef}/items/{itemRef}` | OpenAPI `upsertOrderItem`; `generate.mjs` | не покрыто |
| `DELETE /api/client-v1/orders/{orderRef}/items/{itemRef}` | OpenAPI `removeOrderItem`; `generate.mjs` | не покрыто |
| `POST /api/client-v1/orders/{orderRef}/commands/confirm` | OpenAPI `confirmOrder`; `generate.mjs` | не покрыто |
| `POST /api/client-v1/orders/{orderRef}/commands/request-aroma-reconciliation` | OpenAPI `requestAromaReconciliation`; `generate.mjs` | не покрыто |
| `GET /api/client-v1/orders/{orderRef}` | OpenAPI `getOrderCard`; `generate.mjs` | не покрыто |
| `GET /events` прокси на `realtime-gateway` | OpenAPI `streamOrderInvalidations`; `nginx.conf` | только unit/integration тесты (`tests/nginx/image.test.mjs`, `tests/nginx/cutover.test.mjs`) |
| префикс `/api/internal-v1/` отвечает 404 | `nginx.conf` | не покрыто |
| префикс `/api/agent-v1/` отвечает 404 | `nginx.conf` | только unit/integration тесты (`tests/nginx/image.test.mjs`) |
| пути `/api/provider`, `/admin`, `/vk`, `/psp` отвечают 404 | `nginx.conf` | не покрыто |
| прочие пути `/auth/` отвечают 404 | `nginx.conf` | не покрыто |
| прочий `location /` отвечает 404 | `nginx.conf` | только unit/integration тесты (`tests/nginx/image.test.mjs`) |

Именованные `error_page` в том же `nginx.conf` отдают problem+json для 401, 403, 429, 500, 502, 503 и 504. Отдельной строкой они не считаются: их вызывают отказы уже перечисленных location.

## События

Публикаций и потреблений нет.
