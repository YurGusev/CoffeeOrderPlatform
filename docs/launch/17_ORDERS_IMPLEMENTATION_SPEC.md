# Исполнимая спецификация Orders Draft и Confirm

Статус: нормативная спецификация issue #8. Исполнитель не выбирает таблицы,
состояния, транзакции, versioning, snapshots, Desired или `allowedActions` заново.

Решением владельца от 27 сентября 2026 утверждены карта browser permissions,
проверка выбранной строки PricingQuote, отдельный Orders delegation key и
проверка identity ответа Draft. Это требования реализации #8, а не свидетельство
готовности runtime: OpenAPI, generated types, конфигурация и код должны быть
согласованно обновлены и проверены в той же ветке/PR. Исходный срез анализа —
`c88c62c91e5a6833d26c8368e3f45e78948f051c` с локальными изменениями #8.

## Уточнение для реализации #11

По решению от 28 сентября 2026 #11 расширяет persisted Order/quote proof и
contribution выбранным помолом. Точная wire-форма, forward-only migration,
сохранение старых immutable hashes и граница с #9 определены в
[контракте помола](30_AROMA_GRIND_CONTRACT_AND_PARALLEL_DELIVERY.md).
Ниже описание принятых миграций #8 сохраняет историческую структуру: новые
изменения идут последующими миграциями #11, не переписыванием #8.

## 1. Граница #8 и #11

Issue #8 реализует `orders-service`: Draft, позиции, локальные snapshots,
атомарный Confirm, immutable Order contribution, History, Idempotency, Outbox,
Order Card и public reconciliation command shell с order-level intent.

Issue #11 отдельно создаёт и использует `Observed`, `ConvergenceAttempt`,
`MutationReservation`, `Lease`, `Fence` и Inbox. Эти таблицы нельзя создавать в
#8: они принадлежат worker/convergence lifecycle #11 и имеют отдельные failure
tests. #8 читает их только после принятия #11 через owner repository для Order
Card; до этого возвращает `aroma.state=PendingObservation` для Confirmed.
В приёмке #8 проверяются контракт Card и fail-closed состояние, но физический
`InSync`/terminal proof, cart-level projection и consumer recovery не получают
статус PASS #8: это отдельные критерии #11. При этом public reconciliation
command shell, атомарный order-level intent и exact/bodyless `202` replay
остаются обязательной частью #8, а read-only projection fixture не подменяет
production projection.
Контракт order-level intent определён
[ADR-0032](../adr/ADR-0032-order-reconciliation-intent.md); cart-level
convergence по нему запускает только #11.

`orders-service` — единственный writer core Order tables. БД:
`coffee_platform_orders`; роль: `coffee_orders_service_rw`.

Шесть async use cases в `src/application/` отвечают за proof workflow,
precheck/replay и вызов owner store; `src/http/index.ts` ограничен transport,
авторизацией, декодированием контекста и отображением ошибок. Confirm use case
не получает внешних клиентов. Store до Confirm проверяет согласованность
локального агрегата, а после каждой команды отвергает несогласованный Card
в той же транзакции: переполнение суммы нескольких допустимых строк не
сохраняет Draft/History/Outbox.

В #8 `@opentelemetry/api` создаёт фиксированные route/use-case/proof/transaction/
Outbox spans и ограниченные метрики `operation/result/state`. In-process
provider/context проверяются тестами. Production provider, context manager,
exporter и Collector относятся к #64; локальные spans не подтверждают
production export.

После проверки авторизации `api-public` сохраняет входной W3C carrier; при его
отсутствии использует валидный активный server span и передаёт один carrier
в подписанном context и HTTP-заголовке. Orders после авторизации применяет то
же правило к command context для Outbox. Проверяемые входные claims при этом
не меняются. Без валидного активного span сохраняется прежний fallback.

### Приём всплеска Orders

Уточнение владельца от 14 октября 2026: owner-boundary волна 100 одновременно
начатых заказов по 10 позиций проверяется без тестовых повторов отказавших
команд. Orders pool сохраняет четыре соединения, FIFO admission до 100
ожидателей по [DB contract](05_DATA_OWNERSHIP.md). HTTP deadline 5000 ms
включает ожидание; подключение после допуска ограничено checkout 250 ms. Запросы
сверх очереди или дедлайна завершаются существующим отказом. Это ограниченное
ожидание ресурса до транзакции, а не долговечная очередь заказов или retry SQL.
Idempotency/Confirm/Outbox и неизвестный COMMIT сохраняют прежнюю семантику.
Для PUT позиции `preflightPut` объединяет read-only idempotency precheck и
существующее полное валидированное чтение Card в одной короткой транзакции.
Replay/conflict/in-progress завершаются до чтения Card и Pricing. Pricing
вызывается только после завершения транзакции и освобождения соединения;
`putItem` отдельно повторно проверяет idempotency/version и атомарно пишет
эффекты. Preflight не разрешает запись заранее и не удерживает lock во время
сетевого вызова. Ошибки idempotency lookup и ошибки Card сохраняют прежнее
раздельное отображение; неуспешное завершение транзакции запрещает Pricing.
Точный peak target и ограничения synthetic Customer/Pricing/auth перечислены в
[спецификации проверки](20_REALTIME_SSE_IMPLEMENTATION_SPEC.md#отдельная-owner-командная-волна).

## 2. Миграции #8

Файлы выполняются строго по порядку:

1. `0001_create_orders.sql`;
2. `0002_create_order_items.sql`;
3. `0003_create_order_history.sql`;
4. `0004_create_order_contributions.sql`;
5. `0005_create_orders_idempotency.sql`;
6. `0006_create_orders_outbox.sql`.

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
(`DraftCreated|ItemUpserted|ItemRemoved|OrderConfirmed|ReconciliationRequested`), `actor_ref`,
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

`orders.idempotency_records`: PK `(actor_ref,scope,idempotency_key)`, где scope —
64-символьный command scope по `26_BROWSER_COMMAND_RECOVERY.md`; exact
request hash, `Acquired|Completed`, lease 30s, response status/body, timestamps.
Completed хранится 24 часа; Order/history не удаляются cleanup.

`orders.outbox_messages`: `message_id` PK, `message_type`, `topic`,
`aggregate_ref`, `aggregate_sequence`, `owner_version`, `partition_key`,
`schema_version`, immutable `envelope_bytes`/`envelope_hash`, JSON envelope,
`payload` и `payload_hash` канонического envelope для `SqlOutboxStore.claim`,
`occurred_at`, lease/fence и publish attempts/state. Unique
`(message_type,aggregate_ref,owner_version)`.

Все producers для одного Order, включая AROMA realtime projection, выделяют
`aggregate_sequence=max+1` под существующей блокировкой parent Order. Confirm
и reconciliation не используют business version как transport sequence:
между ними могли появиться realtime events. `owner_version` и `aggregate.version`
соответствуют версии бизнес-факта либо projection, как определено событием.

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

Точный закрытый request/response выбранной строки определён в
[спецификации Pricing, раздел 6](16_PRICING_IMPLEMENTATION_SPEC.md#6-проверка-для-orders).
Pricing проверяет целостность всей сохранённой котировки, но возвращает одну
строку с исходным `lineNumber`; Orders сверяет её с `quoteLineNumber` команды,
а не с индексом массива ответа. Полный состав quote браузер не передаёт.

Browser не передаёт `displayName`, `offerRef`, money, currency, policy,
Catalog revision или expiry. Orders не вызывает Customer/Catalog/Pricing внутри
DB-транзакции и никогда не читает их БД.

## 4. HTTP-команды

Общие требования commands: Authorization, UUID `Idempotency-Key`, trusted
server actor, correlation/trace, RFC 9457. Version и money на wire — canonical
decimal strings.

### Права browser-операций

Принятая карта `operationId → x-permission` для операторского `client-v1`:

| `operationId` | `x-permission` |
|---|---|
| `createOrderDraft` | `orders:create` |
| `getOrderCard` | `orders:read:any` |
| `upsertOrderItem` | `orders:edit:any` |
| `removeOrderItem` | `orders:edit:any` |
| `confirmOrder` | `orders:confirm:any` |
| `requestAromaReconciliation` | `orders:reconcile:any` |
| `createPricingQuote` | `pricing:create` |

Последняя операция принадлежит Pricing, но необходима browser-сценарию #8.
`:any` означает явное право оператора на заказы других actors, не неявное
владение заказом. Права edit/confirm/reconcile независимы: ни одно не выдаёт
другое автоматически. Карта не распространяется на VK/agent trust surface.

Edge получает право из OpenAPI; отсутствие права по-прежнему fail-closed.
`api-public` и соответствующий owner повторно проверяют permission вместе с
transport identity и signed actor claims до business/recovery lookup.
Выдача прав использует существующий проверенный IdP/Edge mapping: никакого
автоматического grant всем вошедшим пользователям. Обычная команда и её
bodyless replay-only требуют одного текущего права; отозванное право запрещает
выдачу сохранённого ответа. Другой actor не получает чужой idempotency result,
в том числе при наличии `:any`.

В одной реализации обновить OpenAPI, generated inventory/types, проверки
Edge/api-public/owner и mapping/tests. Проверить весь browser-путь получения
quote и работы с Orders, а не только прямые вызовы `api-public`.

### `POST /api/client-v1/orders/drafts`

Body: `{ "customerRef": "cus_<ULID>" }`. После Customer order-input одной
транзакцией создаёт Order version 1, History `DraftCreated`, completed
idempotency response. Response `201 OrderCardResponse`.

Ошибки: `CUSTOMER_NOT_FOUND`, `CUSTOMER_NOT_ACTIVE`, `CUSTOMER_UNAVAILABLE`,
общие auth/validation/idempotency codes.

`api-public` проверяет identity успешного ответа: для обычного создания
`response.customer.customerRef` равен `request.body.customerRef`; несовпадение
закрывается `503 ORDERS_UNAVAILABLE` без выдачи owner body. Для маршрутов с
`orderRef` в URL ответ обязан содержать тот же `orderRef`. Непринятый/повреждённый
owner response не получает `Idempotency-Replayed: true`.

Bodyless replay-only не требует повторно присылать body: связь с исходным
Customer/result проверяет Orders по сохранённым фактам `(actorRef,scope,key)`.
Отказ адаптера после вызова owner не доказывает rollback: автоматическое
повторное создание или новый idempotency key запрещены, действует owner recovery.

Для пяти Orders commands действует bodyless `Idempotency-Replay-Only: true`
по [browser recovery](26_BROWSER_COMMAND_RECOVERY.md). Эта ветка выполняет
только owner lookup с теми же actor/scope/key после текущей авторизации,
до expectedVersion/quote checks; не вызывает Customer/Pricing, acquire,
Order write, History, Outbox или reconciliation enqueue. Command identity
включает concrete orderRef/itemRef через scope. Все сохраняемые terminal
OrderCard/ReconciliationAccepted responses содержат исходный orderRef.

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

### `POST /api/client-v1/orders/{orderRef}/commands/request-aroma-reconciliation`

Body `{expectedVersion,reason}`, обязательный `Idempotency-Key` и право
`orders:reconcile:any`. После current authorization owner сверяет
`status=Confirmed`, `expectedVersion` и разрешённое действие по подлинной
owner-local AROMA projection (`OutOfSync|Blocked|UnknownOutcome`). При
`PendingObservation` или отсутствии projection —
`409 AROMA_RECONCILIATION_NOT_ALLOWED`: состояние нельзя подделать ради `202`.

Одна Orders DB transaction сохраняет новую `version`, append-only History
`ReconciliationRequested`, один Outbox `OrderReconciliationRequested.v1`
с закрытым payload `{orderRef,orderVersion,requestedAt}`, completed
idempotency и исходный `202 ReconciliationAcceptedResponse`.
`requestedAt` — DB transaction time; `reason` не уходит в Kafka. Это только
намерение для #11: нет cartScopeRef/desiredRevision, Desired/Observed writes,
provider calls, lease, Kafka publish внутри транзакции. Обычный exact replay
и bodyless replay-only после проверки текущего права возвращают сохранённый
`202` без повторной записи/вычисления actions. До реализации projection #11
production-путь fail-closed; положительный тест #8 с контролируемой read-only
fixture не является proof производственного `OutOfSync`.

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

`orders.read_card_projection` дополнительно проверяет свежесть Observed, lease
и reservation `UnknownOutcome` при каждом GET. Без записи Card/Outbox и без
изменения projectionVersion допустимы read-time переходы `InSync→OutOfSync`,
`InSync→Converging`, `Converging→OutOfSync`, `OutOfSync→Converging`.
Unknown reservation перекрывает state/blockers значениями `UnknownOutcome`
и единственным `AROMA_UNKNOWN_OUTCOME`; recovery может снять это перекрытие
до асинхронного обновления публичной проекции. Прежние бизнес-поля Card,
AROMA revisions и lastObservedAt при этом сохраняются.

Клиент принимает эти различия только из текущего валидированного owner GET.
Command/replay response не имеет такого права: исторический ответ не должен
снимать UnknownOutcome. Read-time снятие перекрытия допускает
`PendingObservation|Converging|OutOfSync|Blocked|UnknownOutcome`;
восстановление `InSync` требует новой доказанной проекции. `allowedActions`
по-прежнему вычисляет владелец, а клиент не выводит состояние из SSE payload.

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

- Draft: `edit-items` только при `orders:edit:any`; `confirm` только при
  `orders:confirm:any`, items 1..100 и всех действующих quote proofs на DB time;
- Confirmed + `OutOfSync|Blocked|UnknownOutcome`: только
  `request-aroma-reconciliation` при `orders:reconcile:any`;
- Confirmed + `PendingObservation|Converging|InSync`: пустой массив;
- неизвестное/несогласованное внутреннее состояние fail-closed: пустой массив и
  blocker `ORDER_STATE_INCONSISTENT`.

`allowedActions` — пересечение разрешённых состоянием действий с текущими
permissions actor. Это подсказка интерфейсу, не замена независимой авторизации
команды и не повод изменять сохранённый terminal response при exact replay.

## 7. Ошибки и тесты

Стабильные codes: `ORDER_NOT_FOUND`, `ORDER_ITEM_NOT_FOUND`,
`ORDER_VERSION_CONFLICT`, `ORDER_NOT_EDITABLE`, `ORDER_EMPTY`,
`ORDER_ITEM_LIMIT_EXCEEDED`, `ORDER_QUOTE_STALE`, `ORDER_QUOTE_SCOPE_MISMATCH`,
`ORDER_DESIRED_OVERFLOW`, плюс Customer/Pricing availability и общие
idempotency/auth/validation codes.

Для четырёх отдельных причин public response и owner Problem Details используют
одинаковые пары `status`/`code`:

- `PUT item`: `409 ORDER_ITEM_LIMIT_EXCEEDED`, `409 ORDER_QUOTE_SCOPE_MISMATCH`;
- `Confirm`: `422 ORDER_EMPTY`, `422 ORDER_DESIRED_OVERFLOW`.

Существующие варианты ответа сохраняются; структура и тело запроса публичного
`PUT item` не меняются. `api-public` пропускает только пару, объявленную для
конкретной операции; неверные `status`/`code` и неизвестные причины отклоняет
без раскрытия внутренних деталей.

Обязательны:

- state-machine и `allowedActions` table tests;
- PostgreSQL clean migration/constraints/grants tests;
- concurrent PUT/DELETE/Confirm: только один expectedVersion выигрывает;
- fault injection после каждого шага Confirm: ноль partial effects;
- idempotency replay/conflict/in-progress/expired lease/crash recovery;
- expired/altered/wrong-customer/wrong-line quote rejection до item write;
- Confirm использует только persisted proof; network spy подтверждает 0 calls;
- Outbox duplicate/crash/replay сохраняет messageId и ordering;
- reconciliation: `PendingObservation` отказывает без эффектов; разрешённая
  read-only projection fixture проверяет атомарный `202`, version/History/Outbox,
  fault rollback и exact replay; cart-level consumer/recovery проверяет #11;
- Order Card query contract и отсутствие PII/provider fields;
- architecture/DB/config/redaction checks.

Дополнительные обязательные проверки утверждённого решения #8:

- все семь browser-операций имеют точные права; missing/wrong/revoked permission
  отклоняется на соответствующих границах, включая bodyless replay-only;
- успешный Draft с чужим Customer и ответы с чужим `orderRef` отклоняются;
  негативы расширяют существующий public-api test, без новой test infrastructure;
- выбранная не первая строка многопозиционного quote, подмена номера/товара/
  варианта/количества/Customer, просрочка и повреждение невыбранной строки;
- старый full-lines verify request больше не принимается; generated contracts
  и все callers согласованы с единственным выбранным путём;
- Orders scoped signing/verification и негативы по
  [service delegation](24_SERVICE_IDENTITY_AND_DELEGATION.md#orders-service-ключи-и-delegation-8);
- runtime регистрирует реальные owner handlers/stores; отдельно проверяются
  PostgreSQL concurrency/faults, loss-of-COMMIT-ack recovery и Outbox restart,
  а не только forwarding с подставным owner.
- Orders readiness-путь проверяет wrong mTLS peer, InternalApi blackhole и
  deadline/shutdown cancellation через scoped client и runtime health check.

Локальный Compose gate #8 принимает изолированный штатный `--recovery-proof`
после сборки Orders image того же среза кода: зафиксировать точную команду,
exit code, Outbox restart/no-duplicate flags и `customerIntegrationProof=false`.
Буквальный запуск без параметров не проводить с реальными credentials или
существующей PostgreSQL-сетью; изолированный proof не объявлять production
verification. Общий `pnpm test` с обязательными skipped дополнять отдельными
исполненными live проверками, а не считать skips PASS.

Порядок реализации: regression identity → permissions/private verify/scoped
keys → owner composition/lifecycle → PostgreSQL/fault/recovery acceptance →
handoff #8. Обязательные команды issue #8 и его prerequisites сохраняются;
отсутствующий runner нужно реализовать, skipped обязательная проверка — не PASS.

## 8. Не входит

AROMA GET/mutation, Observed/Attempt/Lease/Fence/Reservation, Catalog/Pricing
перерасчёт при Confirm, cancellation, checkout, fulfillment, invoice, payment,
Kafka consumer и legacy migration не входят в #8.
