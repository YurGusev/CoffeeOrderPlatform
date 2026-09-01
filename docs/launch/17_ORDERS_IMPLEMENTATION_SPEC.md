# Исполнимая спецификация Orders Draft и Confirm

Статус: нормативная спецификация issue #8. Исполнитель не выбирает таблицы,
состояния, транзакции, versioning, snapshots, Desired или `allowedActions` заново.

## 1. Граница #8 и #11

Issue #8 реализует `orders-service`: Draft, позиции, локальные snapshots,
атомарный Confirm, immutable Order contribution, History, Idempotency, Outbox и Order Card.

Issue #11 отдельно создаёт и использует `Observed`, `ConvergenceAttempt`,
`MutationReservation`, `Lease`, `Fence` и Inbox. Эти таблицы нельзя создавать в
#8: они принадлежат worker/convergence lifecycle #11 и имеют отдельные failure
tests. #8 читает их только после принятия #11 через owner repository для Order
Card; до этого возвращает `aroma.state=PendingObservation` для Confirmed.

`orders-service` — единственный writer core Order tables. БД:
`coffee_platform_orders`; роль: `coffee_orders_service_rw`.

## 2. Миграции #8

Файлы выполняются строго по порядку:

1. `001_create_orders.sql`;
2. `002_create_order_items.sql`;
3. `003_create_order_history.sql`;
4. `004_create_order_desired.sql`;
5. `005_create_orders_idempotency.sql`;
6. `006_create_orders_outbox.sql`.

### `orders.orders`

- `order_ref` PK, `ord_<ULID>`;
- `status`: `Draft|Confirmed`;
- `version bigint NOT NULL CHECK(version>0)`, начальная `1`;
- immutable customer snapshot: `customer_ref`, `customer_version`,
  `customer_display_name`;
- `currency` nullable в пустом Draft, после первой позиции только `RUB`;
- `confirmed_at` nullable, `created_at`, `updated_at`;
- `created_by_actor_ref`, `last_modified_by_actor_ref`;
- check: Draft не имеет `confirmed_at`, Confirmed обязан иметь.

### `orders.order_items`

- PK `(order_ref,item_ref)`, `item_ref=itm_<ULID>`;
- `line_position integer 1..100`, unique внутри order;
- immutable proof snapshot последней PUT-команды: `product_ref`, `variant_ref`,
  `product_display_name`, `unit`, `quantity_milli`, `quote_ref`,
  `quote_line_number`, `quote_hash`, `quote_expires_at`,
  `policy_version_ref`, `catalog_snapshot_revision`, `mapping_revision`,
  `offer_ref`, `unit_minor`, `line_total_minor`, `currency`;
- `created_at`, `updated_at`;
- максимум 100 строк обеспечивается транзакционной проверкой под lock Order;
- UPDATE/DELETE разрешён только когда parent status `Draft`; repository обязан
  использовать guarded SQL, а trigger `enforce_draft_item_mutation` является
  последней защитой от обхода.

### `orders.order_history`

Append-only: `history_ref`, `order_ref`, `order_version`, `event_type`
(`DraftCreated|ItemUpserted|ItemRemoved|OrderConfirmed`), `actor_ref`,
`correlation_id`, `occurred_at`, `facts jsonb`. `facts` содержит refs/versions и
не содержит PII, Authorization или произвольный request body. Unique
`(order_ref,order_version,event_type,item_ref-or-empty)` предотвращает дубли.

### `orders.order_desired_contributions` и строки

Header: `(order_ref,contribution_revision)` PK, `order_version`, `state=Current`,
`created_at`, unique один Current на order. Line: `offer_ref`,
`quantity_milli`, `contribution_hash`, массив отсортированных `item_ref` только
для audit. PK `(order_ref,contribution_revision,offer_ref)`.

Initial `contributionRevision="1"` создаётся только при Confirm. Строки Order с
одинаковым `offerRef` агрегируются суммой `quantityMilli`; zero отсутствует.
`contributionHash` — SHA-256 compact canonical JSON отсортированных
`itemRef/productRef/variantRef/quantityMilli/quoteRef/quoteLineNumber`.

### Idempotency и Outbox

`orders.idempotency_records`: PK `(actor_ref,route_key,idempotency_key)`, exact
request hash, `Acquired|Completed`, lease 30s, response status/body, timestamps.
Completed хранится 24 часа; Order/history не удаляются cleanup.

`orders.outbox_messages`: `message_id` PK, `message_type`, `aggregate_ref`,
`aggregate_version`, `partition_key`, `schema_version`, `payload`,
`occurred_at`, publish attempts/state. Unique
`(message_type,aggregate_ref,aggregate_version)`.

## 3. Источники доверенных snapshots

### Customer

До транзакции создания Draft Orders вызывает
`GET /api/internal-v1/customers/{customerRef}/order-input`, audience
`orders-service`, deadline 1s. Response: `customerRef`, `customerVersion`,
`displayName`, `state=Active`. Contact/address/PII не возвращаются.

### Product и цена

До транзакции PUT item Orders вызывает
`POST /api/internal-v1/pricing/quotes:verify`, передавая `quoteRef`, `hash`,
`customerRef` и ожидаемую строку `quoteLineNumber/productRef/variantRef/quantity`.
Verify response обязан вернуть authoritative `productDisplayName`, `unit`,
`offerRef`, mapping/catalog/policy revisions, money, currency и expiry.

Browser не передаёт `displayName`, `offerRef`, money, currency, policy,
Catalog revision или expiry. Orders не вызывает Customer/Catalog/Pricing внутри
DB-транзакции и никогда не читает их БД.

## 4. HTTP-команды

Общие требования commands: Authorization, UUID `Idempotency-Key`, trusted
server actor, correlation/trace, RFC 9457. Version и money на wire — canonical
decimal strings.

### `POST /api/client-v1/orders/drafts`

Body: `{ "customerRef": "cus_<ULID>" }`. После Customer order-input одной
транзакцией создаёт Order version 1, History `DraftCreated`, completed
idempotency response. Response `201 OrderCardResponse`.

Ошибки: `CUSTOMER_NOT_FOUND`, `CUSTOMER_NOT_ACTIVE`, `CUSTOMER_UNAVAILABLE`,
общие auth/validation/idempotency codes.

### `PUT /api/client-v1/orders/{orderRef}/items/{itemRef}`

`itemRef` создаётся project-owned frontend helper как ULID и становится owner
ref после успешной команды. Generated SDK/client для этого запрещён. Body:

```json
{
  "expectedVersion": "1",
  "productRef": "prd_<ULID>",
  "variantRef": "var_<ULID>",
  "quantity": "2.5",
  "quoteRef": "prq_<ULID>",
  "quoteLineNumber": 1,
  "quoteHash": "<sha256>"
}
```

После Pricing verify транзакция блокирует Order `FOR UPDATE`, проверяет Draft и
expectedVersion, upsert позиции, максимум 100 items, увеличивает Order.version
ровно на 1, пишет History и idempotency response. Повтор exact key возвращает
старый response; он не выполняет verify повторно.

### `DELETE /api/client-v1/orders/{orderRef}/items/{itemRef}`

Headers дополнительно: `If-Match-Version`. Транзакция блокирует Draft, удаляет
существующую позицию, увеличивает version, пишет History и completed response.
Несуществующая позиция: `404 ORDER_ITEM_NOT_FOUND`; команда не является silent
success.

### `POST /api/client-v1/orders/{orderRef}/commands/confirm`

Body: `{ "expectedVersion": "<decimal>" }`. Confirm не принимает customer,
items, prices, Desired или provider data.

Idempotency lookup выполняется до проверки текущей version: completed exact
replay возвращает исходный `200`, даже если Order уже Confirmed. Новый key для
Confirmed Order возвращает `409 ORDER_NOT_EDITABLE`.

## 5. Транзакция Confirm

Одна connection и одна PostgreSQL-транзакция:

1. acquire idempotency row и `SELECT orders ... FOR UPDATE`;
2. проверить `status=Draft`, expectedVersion и минимум одну/максимум 100 строк;
3. проверить для каждой сохранённой строки refs/hash format, `RUB`,
   `quote_expires_at > transaction_timestamp()`, положительное quantity и money;
4. проверить одну currency и отсутствие duplicate item/line proof;
5. агрегировать Order contribution lines по `offerRef`, проверить bigint overflow;
6. UPDATE Order: `Confirmed`, version `+1`, `confirmed_at`;
7. запретить дальнейшую мутацию snapshots правами/trigger;
8. INSERT History `OrderConfirmed` и contribution revision 1/lines;
9. INSERT Outbox только `OrderConfirmed.v1` с `contributionRevision="1"`,
   key=`orderRef`, aggregate version=new OrderVersion; convergence wake-up
   публикует preparation #11 после построения cart-level Desired;
10. сохранить completed idempotency response и commit.

В шагах 1–10 запрещены HTTP, Kafka publish, AROMA/provider calls, filesystem и
sleep. Outbox publisher работает после commit. Любая ошибка откатывает все
десять шагов.

## 6. Order Card

`GET /api/client-v1/orders/{orderRef}` выполняет один owner query/projection и
возвращает:

- Order refs/command `version`/Card `projectionVersion`/status и customer snapshot;
- items по `linePosition` с product snapshot, quantity и quote money;
- pricing: сумма `lineTotalMinor`, `RUB`, уникальные quote refs/hashes;
- `aroma`: вычисленное состояние, revisions, last observation, blockers;
- `allowedActions`, вычисленные сервером.

Никакой network call при GET нет.

`version` изменяет только `orders-service` и использует только optimistic
concurrency. `projectionVersion` — отдельная монотонная версия видимого Card;
её изменение выполняет единый Orders projection repository при Order command
или material AROMA projection change. Оба runtime вызывают один guarded SQL
entry point; прямой UPDATE projection table запрещён grants/checker. SSE
`ownerVersion` всегда равен `projectionVersion`.

AROMA state precedence:

1. Draft -> `NotRequested`;
2. Confirmed без Observed -> `PendingObservation`;
3. active Attempt `UnknownOutcome` -> `UnknownOutcome`;
4. blocker -> `Blocked`;
5. active lease/attempt -> `Converging`;
6. terminal proof `NoOpInSync|VerifiedInSync` совпадает с current Desired
   revision/hash, complete Current Observed revision/fingerprint, current fence
   и актуальной contribution Order -> `InSync`;
7. иначе -> `OutOfSync`.

До #11 доступны только первые два состояния.

`allowedActions`:

- Draft: всегда `edit-items`; `confirm` только если items 1..100 и все quote
  proofs ещё действуют на DB time;
- Confirmed + `OutOfSync|Blocked|UnknownOutcome`: только
  `request-aroma-reconciliation`;
- Confirmed + `PendingObservation|Converging|InSync`: пустой массив;
- неизвестное/несогласованное внутреннее состояние fail-closed: пустой массив и
  blocker `ORDER_STATE_INCONSISTENT`.

## 7. Ошибки и тесты

Стабильные codes: `ORDER_NOT_FOUND`, `ORDER_ITEM_NOT_FOUND`,
`ORDER_VERSION_CONFLICT`, `ORDER_NOT_EDITABLE`, `ORDER_EMPTY`,
`ORDER_ITEM_LIMIT_EXCEEDED`, `ORDER_QUOTE_STALE`, `ORDER_QUOTE_SCOPE_MISMATCH`,
`ORDER_DESIRED_OVERFLOW`, плюс Customer/Pricing availability и общие
idempotency/auth/validation codes.

Обязательны:

- state-machine и `allowedActions` table tests;
- PostgreSQL clean migration/constraints/grants tests;
- concurrent PUT/DELETE/Confirm: только один expectedVersion выигрывает;
- fault injection после каждого шага Confirm: ноль partial effects;
- idempotency replay/conflict/in-progress/expired lease/crash recovery;
- expired/altered/wrong-customer/wrong-line quote rejection до item write;
- Confirm использует только persisted proof; network spy подтверждает 0 calls;
- Outbox duplicate/crash/replay сохраняет messageId и ordering;
- Order Card query contract и отсутствие PII/provider fields;
- architecture/DB/config/redaction checks.

## 8. Не входит

AROMA GET/mutation, Observed/Attempt/Lease/Fence/Reservation, Catalog/Pricing
перерасчёт при Confirm, cancellation, checkout, fulfillment, invoice, payment,
Kafka consumer и legacy migration не входят в #8.
