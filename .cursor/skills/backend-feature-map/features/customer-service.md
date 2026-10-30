# customer-service

Владелец клиента. Контракт `packages/contracts/customer-v1` и пути из
`contracts/openapi/client-v1.yaml` и `contracts/openapi/internal-v1.yaml`.
Маршруты регистрирует `apps/customer-service/src/http/index.ts`.
В `config/platform.yaml` у сервиса `kafka.producers` и `kafka.consumers` пустые.

Живой навык [customer-slice-verify](../../customer-slice-verify/SKILL.md)
запускает `node tools/grokverify-customer.mjs` против процесса
`customer-service` и базы `coffee_platform_customer`.

## Операции

| Операция | Источник | Покрытие |
|---|---|---|
| `POST /api/client-v1/customers` | OpenAPI `createCustomer`; `http/index.ts` | проверяется живым навыком customer-slice-verify |
| `GET /api/client-v1/customers` | OpenAPI `searchCustomers`; `http/index.ts` | проверяется живым навыком customer-slice-verify |
| `GET /api/internal-v1/customers/:customerRef/order-input` | OpenAPI `getCustomerOrderInput`; `http/index.ts` | только unit/integration тесты (`tests/customer/customer-http.test.mjs`, `tests/customer/customer-live.test.mjs`) |
| `GET /health/live` | `packages/platform-runtime/src/index.ts` | только unit/integration тесты (`tests/runtime/lifecycle.test.mjs`) |
| `GET /health/ready` | `packages/platform-runtime/src/index.ts` | проверяется живым навыком customer-slice-verify |
| `GET /metrics` | `packages/platform-runtime/src/index.ts` | только unit/integration тесты (`tests/runtime/lifecycle.test.mjs`) |

Навык вызывает `GET /health/ready`, поиск по имени и `POST /api/client-v1/customers`.
В создание входят отказы без клиентского сертификата, с чужим SPIFFE, без actor
context и с пустым телом, повтор того же ключа и повтор того же email.
Сценарий `order-input` в `tools/grokverify-customer.mjs` записывается как
`not-covered` и HTTP не вызывает. Пагинацию курсором навык не вызывает. Её
проходит `tests/customer/customer-live.test.mjs`.

`GET /health/live` и `GET /metrics` навык не вызывает.
`tests/runtime/lifecycle.test.mjs` проверяет регистратор runtime и процесс
`customer-service` не запускает.

## События

Публикаций и потреблений в коде сервиса нет.
