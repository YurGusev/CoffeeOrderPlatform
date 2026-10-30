# edge-gateway

Вход браузера после nginx. Маршруты регистрирует `apps/edge-gateway/src/routes.ts`.
Они совпадают с `contracts/openapi/edge-auth-v1.yaml`. Пакет
`packages/contracts/edge-v1` указывает source `contracts/openapi/client-v1.yaml`
и реэкспортирует `@coffee-platform/generated-client-v1`. Сервис этот пакет не импортирует.
Список browser-операций для `/_edge/authorize` лежит в
`apps/edge-gateway/src/client-operations.gen.ts` и сгенерирован из `client-v1.yaml`.
В `config/platform.yaml` у сервиса `kafka.producers` и `kafka.consumers` пустые.

## Операции

| Операция | Источник | Покрытие |
|---|---|---|
| `GET /auth/login` | OpenAPI `beginBrowserLogin`; `routes.ts` | только unit/integration тесты (`tests/edge-auth/routes.test.mjs`) |
| `GET /auth/callback` | OpenAPI `completeBrowserLogin`; `routes.ts` | только unit/integration тесты (`tests/edge-auth/routes.test.mjs`) |
| `GET /auth/session` | OpenAPI `getBrowserSession`; `routes.ts` | только unit/integration тесты (`tests/edge-auth/routes.test.mjs`) |
| `POST /auth/logout` | OpenAPI `endBrowserSession`; `routes.ts` | только unit/integration тесты (`tests/edge-auth/routes.test.mjs`) |
| `GET /_edge/authorize` | OpenAPI `authorizeBrowserIngress`; `routes.ts` | только unit/integration тесты (`tests/edge-auth/routes.test.mjs`) |
| `GET /health/live` | `packages/platform-runtime/src/index.ts` | только unit/integration тесты (`tests/runtime/lifecycle.test.mjs`) |
| `GET /health/ready` | `packages/platform-runtime/src/index.ts` | только unit/integration тесты (`tests/runtime/lifecycle.test.mjs`) |
| `GET /metrics` | `packages/platform-runtime/src/index.ts` | только unit/integration тесты (`tests/runtime/lifecycle.test.mjs`) |

`tests/runtime/lifecycle.test.mjs` проверяет регистратор runtime. Процесс `edge-gateway` этот файл не запускает.

## События

Публикаций и потреблений в коде сервиса нет.
