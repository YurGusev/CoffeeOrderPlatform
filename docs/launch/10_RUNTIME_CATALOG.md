# Нормативный каталог runtime первого запуска

Исполнитель не выбирает значения этого каталога. Он переносит их в
`config/service-catalog.json`, Compose, OpenAPI, event schemas и ownership
manifests без изменения смысла. Любое отклонение требует отдельного ADR и issue.

## 1. `edge-gateway`

- **Назначение:** единственная публичная точка входа; завершает TLS, проверяет
  пользовательскую сессию/JWT, формирует trusted actor context, применяет
  request-size/rate/deadline limits и маршрутизирует запрос владельцу.
- **Владелец:** Platform.
- **Входящие HTTP:** публичные `/api/client-v1/**`, `/events`, `/health/live`.
- **Входящие события:** нет.
- **Исходящие вызовы:** HTTP к `customer-service`, `catalog-service`,
  `pricing-service`, `orders-service`; SSE proxy к `realtime-gateway`.
- **Хранилище:** нет БД, нет persistent cache.
- **Секреты:** TLS private key/certificate; OIDC/JWT verification configuration.
- **Публичность:** public internet; `internal-v1` и `aroma-gateway` не маршрутизирует.

## 2. `web`

- **Назначение:** раздача immutable assets нового React SPA.
- **Владелец:** Frontend.
- **Входящие HTTP:** публичные `GET /`, `/assets/**`, SPA fallback.
- **Входящие события:** нет.
- **Исходящие вызовы:** серверный runtime не выполняет; браузер вызывает только
  same-origin `client-v1` и `/events` через `edge-gateway`.
- **Хранилище:** нет.
- **Секреты:** нет; runtime environment не содержит API/DB/provider credentials.
- **Публичность:** public internet через edge/CDN.

## 3. `customer-service`

- **Назначение:** создание и поиск Customer, владение identity/contact/address/channel link.
- **Владелец:** Customer.
- **Входящие HTTP:** `POST /api/client-v1/customers`,
  `GET /api/client-v1/customers?query=`; health endpoints.
- **Входящие события:** нет в первом срезе.
- **Исходящие вызовы:** нет синхронных межсервисных вызовов; telemetry only.
- **Хранилище:** target-БД `coffee_platform_customer`, role `coffee_customer_rw`.
- **Секреты:** только Customer DB credential и telemetry exporter credential.
- **Публичность:** не public; доступен только через edge.

## 4. `catalog-service`

- **Назначение:** продукты, варианты, активное поколение supplier snapshot,
  offer mapping, availability и клиентский поиск.
- **Владелец:** Catalog.
- **Входящие HTTP:** `GET /api/client-v1/catalog/products`; private
  `GET /api/internal-v1/catalog/products/{productRef}/pricing-input`.
- **Входящие события:** `CatalogSnapshotCompleted.v1` от `catalog-supplier-sync`.
- **Исходящие вызовы:** Kafka events `CatalogMappingChanged.v1` и
  `RealtimeInvalidated.v1`; внешних/provider HTTP нет.
- **Хранилище:** target-БД `coffee_platform_catalog`, role `coffee_catalog_rw`.
- **Секреты:** Catalog DB и Kafka credentials.
- **Публичность:** не public; client route только через edge, internal route только private network.

## 5. `catalog-supplier-sync`

- **Назначение:** по расписанию получать полный AROMA supplier catalog,
  валидировать поколение и передавать его Catalog owner без частичной активации.
- **Владелец:** Catalog.
- **Входящие HTTP:** только health; ручной trigger отсутствует в первом срезе.
- **Входящие события:** internal durable schedule `CatalogSnapshotRefreshRequested.v1`.
- **Исходящие вызовы:** private HTTP
  `POST /api/internal-v1/aroma/catalog-snapshots:read` к `aroma-gateway`;
  Kafka `CatalogSnapshotCompleted.v1`.
- **Хранилище:** `coffee_platform_catalog`, role `coffee_catalog_rw`, только
  snapshot staging/import tables из allowlist.
- **Секреты:** Catalog DB, Kafka и service-to-service identity; AROMA credentials отсутствуют.
- **Публичность:** private worker; public/internal business HTTP отсутствует.

## 6. `pricing-service`

- **Назначение:** расчёт и хранение immutable `PricingQuote`, policy version и canonical hash.
- **Владелец:** Pricing.
- **Входящие HTTP:** `POST /api/client-v1/pricing/quotes`; private
  `POST /api/internal-v1/pricing/quotes:verify` для проверки сохранённого proof.
- **Входящие события:** нет в первом срезе.
- **Исходящие вызовы:** private HTTP к
  `catalog-service /api/internal-v1/catalog/products/{productRef}/pricing-input`.
- **Хранилище:** `coffee_platform_pricing`, role `coffee_pricing_rw`.
- **Секреты:** Pricing DB и service-to-service identity.
- **Публичность:** не public; client route через edge, verify route private only.

## 7. `orders-service`

- **Назначение:** Draft/items, quote proof, атомарный Confirm, Desired, history,
  idempotency и server-derived Order Card.
- **Владелец:** Orders.
- **Входящие HTTP:** draft/item/confirm/reconciliation/Order Card routes из
  `docs/launch/03_HTTP_API_CONTRACT.md`.
- **Входящие события:** `AromaObservationChanged.v1`,
  `AromaConvergenceChanged.v1` для owner projection.
- **Исходящие вызовы:** во время Draft/item — private quote verification у
  `pricing-service`; Kafka `OrderConfirmed.v1`, `AromaConvergenceRequested.v1`,
  `RealtimeInvalidated.v1`. `Confirm` не выполняет HTTP.
- **Хранилище:** `coffee_platform_orders`, role `coffee_orders_rw`.
- **Секреты:** Orders DB, Kafka и service-to-service identity.
- **Публичность:** не public; client routes только через edge.

## 8. `orders-aroma-preparation`

- **Назначение:** преобразовать Order/Catalog facts в актуальную Desired revision
  и запустить convergence, не обращаясь к provider.
- **Владелец:** Orders.
- **Входящие HTTP:** только health.
- **Входящие события:** `OrderConfirmed.v1`, `CatalogMappingChanged.v1`.
- **Исходящие вызовы:** Kafka `AromaConvergenceRequested.v1`,
  `RealtimeInvalidated.v1`; HTTP отсутствует.
- **Хранилище:** `coffee_platform_orders`, role `coffee_orders_rw`, allowlist
  Desired/Inbox/Outbox и необходимые order snapshot reads.
- **Секреты:** Orders DB и Kafka credentials.
- **Публичность:** private worker.

## 9. `aroma-observer`

- **Назначение:** выполнять безопасный полный GET физической корзины и сохранять Observed.
- **Владелец:** Orders.
- **Входящие HTTP:** только health.
- **Входящие события:** `AromaObservationRequested.v1` и durable schedule.
- **Исходящие вызовы:** private HTTP
  `POST /api/internal-v1/aroma/cart-snapshots:read` к `aroma-gateway`; Kafka
  `AromaObservationChanged.v1`, `RealtimeInvalidated.v1`.
- **Хранилище:** `coffee_platform_orders`, role `coffee_orders_rw`, allowlist Observed/Attempt/Inbox/Outbox.
- **Секреты:** Orders DB, Kafka и service-to-service identity; provider secrets отсутствуют.
- **Публичность:** private worker.

## 10. `aroma-convergence`

- **Назначение:** lease/fence/reservation state machine и строго один
  GET → максимум одна mutation → GET цикл на attempt.
- **Владелец:** Orders.
- **Входящие HTTP:** только health.
- **Входящие события:** `AromaConvergenceRequested.v1`.
- **Исходящие вызовы:** private typed HTTP к `aroma-gateway` для cart GET,
  set quantity и remove line; Kafka `AromaObservationChanged.v1`,
  `AromaConvergenceChanged.v1`, `RealtimeInvalidated.v1`.
- **Хранилище:** `coffee_platform_orders`, role `coffee_orders_rw`, allowlist Desired/Observed/Attempt/Lease/Fence/Reservation/Inbox/Outbox.
- **Секреты:** Orders DB, Kafka и service-to-service identity; provider secrets отсутствуют.
- **Публичность:** private worker; mutation capability доступна только этой identity.

## 11. `aroma-gateway`

- **Назначение:** AROMA login/session/cookies, allowlisted provider HTTP,
  schema mapping, rate/circuit и журнал provider operations; бизнес-решений не принимает.
- **Владелец:** Integration.
- **Входящие HTTP:** private typed routes: catalog snapshot read, cart snapshot
  read, set line quantity, remove line; health.
- **Входящие события:** нет.
- **Исходящие вызовы:** HTTPS только к allowlisted AROMA origin.
- **Хранилище:** `coffee_platform_integration`, role `coffee_aroma_gateway_rw`.
- **Секреты:** AROMA credentials/session encryption key, Integration DB и mTLS/service identity.
- **Публичность:** private only; edge/browser/Hermes доступа не имеют.

## 12. `realtime-gateway`

- **Назначение:** авторизованный SSE fanout инвалидаций; не хранит business state.
- **Владелец:** Realtime.
- **Входящие HTTP:** private origin `GET /events`, публикуемый наружу только через edge.
- **Входящие события:** `RealtimeInvalidated.v1`.
- **Исходящие вызовы:** SSE к авторизованным browser connections; owner HTTP не вызывает.
- **Хранилище:** нет business DB и нет `DATABASE_URL`.
- **Секреты:** Kafka credential и ключ/конфигурация проверки trusted actor context.
- **Публичность:** browser-visible только через edge; прямой container port private.

## Проверка полноты

`scripts/check-service-catalog.mjs` должен сравнивать этот каталог с
`config/service-catalog.json`, OpenAPI, event registry, Compose, DB ownership и
secret manifests. Отсутствующее поле, лишний runtime, неизвестный route/event,
неописанный outgoing call, DB credential у runtime с `Хранилище: нет` или
публичный private endpoint завершают `pnpm architecture:check` ошибкой.
