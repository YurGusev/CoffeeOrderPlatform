# Нормативный каталог runtime первого запуска

Reference-топология #162 следует [ADR-0031](../adr/ADR-0031-nginx-transport-and-application-auth.md)
и [контракту #159](29_NGINX_TRANSPORT_AND_AUTH.md): private authorizer
`edge-gateway`, native public `edge-nginx`, static `apps/web` без Node runtime.
Итого 14 Node runtime и один native nginx; остальные роли и их API/DB/Kafka/owner
semantics не меняются. Старый Node proxy и `web` runtime не являются fallback.
Этот каталог не доказывает production IdP, сертификаты, capacity или deployment.

Исполнитель не выбирает значения этого каталога. Он переносит их в
`config/service-catalog.json`, Compose, OpenAPI, event schemas и ownership
manifests без изменения смысла. Любое отклонение требует отдельного ADR и issue.

## 1. `edge-nginx`

- **Назначение:** единственный публичный HTTPS transport; прямые immutable SPA
  assets, exact auth routes к private Edge, protected `client-v1` к `api-public`
  и `/events` к `realtime-gateway` только после private auth subrequest.
- **Владелец:** Platform Delivery/Security; прикладная identity принадлежит Edge.
- **Входящие HTTP:** только route/method inventory
  [контракта nginx](29_NGINX_TRANSPORT_AND_AUTH.md); unknown/internal/provider
  пути не получают SPA fallback.
- **Исходящие:** mTLS к `edge-gateway`, `api-public`, `realtime-gateway`;
  произвольный owner, Kafka, PostgreSQL и provider egress отсутствуют.
- **Секреты:** public TLS key/certificate и собственная scoped transport
  identity; actor signing/OIDC secret и CA private key запрещены.
- **Transport:** native non-root nginx; host publish только loopback `8443`.

## 1.1. `edge-gateway`

- **Назначение:** private application authorizer; проверяет OIDC/browser session,
  exact operation/permission/CSRF и подписывает actor assertion. Не проксирует
  business HTTP, SSE или статику.
- **Владелец:** Platform.
- **Входящие HTTP:** exact `/auth/login`, `/auth/callback`, `/auth/session`,
  `/auth/logout` и private `/_edge/authorize` только от nginx; health private.
- **Входящие события:** нет.
- **Исходящие вызовы:** только утверждённый OIDC provider/JWKS при наличии
  проверенного профиля; к business runtime исходящего транспорта нет.
- **Хранилище:** нет БД, нет persistent cache.
- **Секреты:** OIDC client secret и отдельный actor signing key, собственная
  private service identity; public TLS private key ему не выдаётся.
- **Transport:** private mTLS listener; отсутствие утверждённого IdP profile
  означает fail-closed login/authorize, а не fallback на публичный Node Edge.
- **Публичность:** host port отсутствует.

## 1.2. `api-public`

- **Назначение:** stateless composition root только для `client-v1`: actor и
  request/response schema validation, cancellation/deadline/trace propagation,
  route dispatch и transport Problem normalization.
- **Владелец:** Platform; business decisions принадлежат owner services.
- **Входящие HTTP:** полный и только inventory `client-v1.yaml` от edge.
- **Исходящие:** Customer routes → `customer-service`; Catalog search →
  `catalog-service`; quote → `pricing-service`; Orders routes → `orders-service`.
- **Хранилище/события:** DB, persistent cache и Kafka отсутствуют.
- **Секреты:** service identity, actor verification keys, отдельный public
  delegation signing key, telemetry.
- **Публичность:** private backend; browser/host port отсутствует.

## 1.3. `api-internal`

- **Назначение:** stateless composition root только для `internal-v1`; проверяет
  mTLS caller/operation allowlist и подписывает delegation context.
- **Владелец:** Platform; business decisions отсутствуют.
- **Allowlist:** Orders→Customer order-input; Pricing→Catalog pricing-input;
  Orders→Pricing verify; Catalog sync→Gateway export; Observer→Gateway cart
  read; Convergence→Gateway cart read/set/remove. Иное →
  `403 SERVICE_AUDIENCE_FORBIDDEN`.
- **Исходящие:** только exact target текущей allowlisted operation.
- **Хранилище/события:** DB, persistent cache и Kafka отсутствуют.
- **Секреты:** service identity, delegation signing key, verification keys,
  telemetry; provider credentials отсутствуют.
- **Публичность:** только private `internal-api` network.

`apps/web` остаётся исходником и browser build graph; отдельного `web` runtime,
Node entrypoint, listener или service transport secret scope больше нет.

## 3. `customer-service`

- **Назначение:** создание и поиск Customer, владение identity/contact/address/channel link.
- **Владелец:** Customer.
- **Входящие HTTP:** `POST /api/client-v1/customers`,
  `GET /api/client-v1/customers?query=` через `api-public`; private
  `GET /api/internal-v1/customers/{customerRef}/order-input` через
  `api-internal`; health endpoints.
- **Входящие события:** нет в первом срезе.
- **Исходящие вызовы:** нет синхронных межсервисных вызовов; telemetry only.
- **Хранилище:** target-БД `coffee_platform_customer`, role `coffee_customer_rw`.
- **Секреты:** только Customer DB credential, service transport identity и
  telemetry exporter credential.
- **Публичность:** private owner backend; доступен только через `api-public` и
  `api-internal` по своему route inventory.

## 4. `catalog-service`

- **Назначение:** продукты, варианты, активное поколение supplier snapshot,
  offer mapping, availability и клиентский поиск.
- **Владелец:** Catalog.
- **Входящие HTTP:** `GET /api/client-v1/catalog/products`; private
  `GET /api/internal-v1/catalog/products/{productRef}/variants/{variantRef}/pricing-input`.
- **Входящие события:** нет; HTTP читает active generation из Catalog DB.
- **Исходящие вызовы:** отсутствуют; внешних/provider HTTP и Kafka publish нет.
- **Хранилище:** target-БД `coffee_platform_catalog`, role `coffee_catalog_api_ro`,
  только active projection reads.
- **Секреты:** read-only Catalog DB, service identity и telemetry.
- **Публичность:** не public; client route только через edge, internal route только private network.

## 5. `catalog-supplier-sync`

- **Назначение:** по расписанию получать полный AROMA supplier catalog,
  валидировать поколение и передавать его Catalog owner без частичной активации.
- **Владелец:** Catalog.
- **Входящие HTTP:** только health; ручной trigger отсутствует в первом срезе.
- **Входящие события:** нет; запуск выполняет internal scheduler этого runtime,
  а не дополнительное Kafka-сообщение.
- **Исходящие вызовы:** private HTTP
  `POST /api/internal-v1/aroma/catalog-exports` к `aroma-gateway`; Kafka не
  используется для передачи batch rows или запуска внутренней активации.
- **Хранилище:** `coffee_platform_catalog`, role `coffee_catalog_import_rw`, только
  snapshot staging/import tables из allowlist.
- **Секреты:** Catalog DB и service-to-service identity; Kafka и AROMA credentials отсутствуют.
- **Публичность:** private worker; public/internal business HTTP отсутствует.

## 5.1. `catalog-activation-worker`

- **Назначение:** выбрать `Received` generation из Catalog DB, повторно проверить
  manifests/hashes/counts, материализовать owner state и атомарно переключить
  active revision вместе с Outbox.
- **Владелец:** Catalog.
- **Входящие HTTP/события:** нет; durable DB queue через
  `FOR UPDATE SKIP LOCKED`.
- **Исходящие вызовы:** Kafka `CatalogSnapshotActivated.v1` и
  `CatalogMappingChanged.v2` только через Outbox после commit.
- **Хранилище:** `coffee_platform_catalog`, role
  `coffee_catalog_activate_rw`, allowlist staging reads, active writes и Outbox.
- **Секреты:** Catalog DB, Kafka producer identity, service transport identity
  и telemetry; provider secrets отсутствуют.
- **Публичность:** private worker.

## 6. `pricing-service`

- **Назначение:** расчёт и хранение immutable `PricingQuote`, policy version и canonical hash.
- **Владелец:** Pricing.
- **Входящие HTTP:** `POST /api/client-v1/pricing/quotes`; private
  `POST /api/internal-v1/pricing/quotes:verify` для проверки сохранённого proof.
- **Входящие события:** нет в первом срезе.
- **Исходящие вызовы:** private HTTP к
  `catalog-service /api/internal-v1/catalog/products/{productRef}/variants/{variantRef}/pricing-input`.
- **Хранилище:** `coffee_platform_pricing`, role `coffee_pricing_rw`.
- **Секреты:** Pricing DB и service-to-service identity.
- **Публичность:** не public; client route через edge, verify route private only.

## 7. `orders-service`

- **Назначение:** Draft/items, quote proof, атомарный Confirm, Order contribution, history,
  idempotency и server-derived Order Card.
- **Владелец:** Orders.
- **Входящие HTTP:** draft/item/confirm/reconciliation/Order Card routes из
  `docs/launch/03_HTTP_API_CONTRACT.md`.
- **Входящие события:** нет; AROMA events принимает projection worker.
- **Исходящие вызовы:** перед Draft — private Customer order-input; перед
  PUT item — private quote verification у `pricing-service`; Kafka
  `OrderConfirmed.v1`, `AromaConvergenceRequested.v1`,
  `RealtimeInvalidated.v1`. Все private HTTP идут через `api-internal`;
  `Confirm` не выполняет HTTP.
- **Хранилище:** `coffee_platform_orders`, role `coffee_orders_service_rw`,
  allowlist core Order/Item/History/Desired/Idempotency/Outbox.
- **Секреты:** Orders DB, Kafka и service-to-service identity.
- **Публичность:** не public; client routes только через edge.

## 8. `orders-aroma-preparation`

- **Назначение:** single writer cart Desired и per-Order AROMA projection;
  преобразует Order/Catalog/Observation/Convergence facts и запускает workflow.
- **Владелец:** Orders.
- **Входящие HTTP:** только health.
- **Входящие события:** `OrderConfirmed.v1`, `CatalogMappingChanged.v2`,
  `AromaObservationChanged.v1`, `AromaConvergenceChanged.v1`.
- **Исходящие вызовы:** Kafka `AromaConvergenceRequested.v1`,
  `RealtimeInvalidated.v1`; HTTP отсутствует.
- **Хранилище:** `coffee_platform_orders`, role `coffee_orders_prepare_rw`, allowlist
  Desired/mapping/order_aroma_projections/Inbox/Outbox и необходимые reads.
- **Секреты:** Orders DB, Kafka credentials и service transport identity.
- **Публичность:** private worker.

## 9. `aroma-observer`

- **Назначение:** выполнять безопасный полный GET физической корзины и сохранять Observed.
- **Владелец:** Orders.
- **Входящие HTTP:** только health.
- **Входящие события:** Kafka отсутствует; запуск только internal durable
  schedule. `AromaConvergenceRequested.v1` потребляет только convergence.
- **Исходящие вызовы:** private HTTP
  `POST /api/internal-v1/aroma/cart-snapshots:read` через `api-internal`; Kafka
  только `AromaObservationChanged.v1`. Per-Order realtime публикует projection worker.
- **Хранилище:** `coffee_platform_orders`, role `coffee_orders_observer_rw`,
  allowlist только Observed/Inbox/Outbox; запись Attempt запрещена и принадлежит
  только `aroma-convergence`.
- **Секреты:** Orders DB, Kafka и service-to-service identity; provider secrets отсутствуют.
- **Публичность:** private worker.

## 10. `aroma-convergence`

- **Назначение:** lease/fence/reservation state machine и строго один
  GET → максимум одна mutation → GET цикл на attempt.
- **Владелец:** Orders.
- **Входящие HTTP:** только health.
- **Входящие события:** `AromaConvergenceRequested.v1`.
- **Исходящие вызовы:** private typed HTTP через `api-internal` к `aroma-gateway` для cart GET,
  set quantity и remove line; Kafka `AromaObservationChanged.v1`,
  `AromaConvergenceChanged.v1`. Per-Order realtime публикует projection worker.
- **Хранилище:** `coffee_platform_orders`, role `coffee_orders_convergence_rw`, allowlist Desired/Observed/Attempt/Lease/Fence/Reservation/Inbox/Outbox.
- **Секреты:** Orders DB, Kafka и service-to-service identity; provider secrets отсутствуют.
- **Публичность:** private worker; mutation capability доступна только этой identity.

## 11. `aroma-gateway`

- **Назначение:** AROMA login/session/cookies, allowlisted provider HTTP,
  schema mapping, rate/circuit и журнал provider operations; бизнес-решений не принимает.
- **Владелец:** Integration.
- **Входящие HTTP:** private typed routes: catalog NDJSON export, cart snapshot
  read, set line quantity, remove line; health.
- **Входящие события:** нет.
- **Исходящие вызовы:** HTTPS только к allowlisted AROMA origin.
- **Хранилище:** `coffee_platform_integration`, role `coffee_aroma_gateway_rw`.
- **Секреты:** AROMA credentials/session encryption key, Integration DB и mTLS/service identity.
- **Публичность:** private only; edge/browser/Hermes доступа не имеют.

## 12. `realtime-gateway`

- **Назначение:** авторизованный bounded SSE fanout `RealtimeInvalidated.v1` с
  кратким in-memory replay/reset fallback; не хранит business state.
- **Владелец:** Realtime.
- **Входящие HTTP:** private origin `GET /events`, публикуемый наружу только через edge.
- **Входящие события:** `RealtimeInvalidated.v1`.
- **Исходящие вызовы:** SSE к actor с permission `orders:read:any`; owner HTTP
  не вызывает, client subject filters не принимает.
- **Хранилище:** нет business DB и нет `DATABASE_URL`.
- **Секреты:** Kafka credential, service transport identity и ключ/конфигурация
  проверки trusted actor context.
- **Публичность:** browser-visible только через edge; прямой container port private.

## Проверка полноты

`scripts/check-service-catalog.mjs` должен сравнивать этот каталог с
`config/service-catalog.json`, OpenAPI, event registry, Compose, DB ownership и
secret manifests. Отсутствующее поле, лишний runtime, неизвестный route/event,
неописанный outgoing call, DB credential у runtime с `Хранилище: нет` или
публичный private endpoint завершают `pnpm architecture:check` ошибкой.
