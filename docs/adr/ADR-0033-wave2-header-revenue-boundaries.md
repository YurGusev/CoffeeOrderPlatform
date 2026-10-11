# ADR-0033: этапы Orders invoice consumer и минимальный revenue proof W2

- Статус: решение cop-architect по делегированному владельцем полномочию от
  2026-10-11; документальная поставка ожидает merge в `develop`. Не runtime admission.
- Дата: 2026-10-11. Владелец: Platform Architecture совместно с Orders,
  Invoices, Pricing и Artifact Operations.
- База сверки: `91675aaa56900613505bfbd8cd14981b07cec000`.
- Authority: [ADR-0030](ADR-0030-wave2-runtime-topology.md),
  [W2 topology](../wave-2/02_RUNTIME_TOPOLOGY.md),
  [invoice flow](../wave-2/01_AROMA_SUPPLIER_INVOICES.md),
  [W2 delivery graph](../wave-2/README.md) и
  [Artifact boundary](../CoffeeOrderSystem_CANONICAL_Architecture_EndToEndHardened_RU_2026-08-19/M04_TYPESCRIPT_PLATFORM/07_ARTIFACT_STORAGE_BOUNDARY.md).

## Контекст и граница

Ранний header должен попасть в Order Card до финансового proof, а Pricing нужен
Locked customer revenue без доступа к wholesale/provider деталям checkout.
Уточняются только этапы уже названной роли и grants существующей Artifact
инфраструктуры. 19 W2 ролей, 9 target БД, principals/pools и fleet budgets не
увеличиваются. #13 остаётся обязательным входом W2; актуальный launch registry
содержит восемь сообщений с OrderReconciliationRequested по
[ADR-0032](ADR-0032-order-reconciliation-intent.md), не исторические exact-seven.
Исторические #71 и launch handoff hashes не переписываются.

## D1: одна роль, два этапа

Единственная роль — `orders-invoice-consumer`, executable
`apps/orders-invoice-consumer/src/main.ts`, Orders principal
`coffee_orders_invoice_rw`, pool 4. Invoices пишет header/proof только в своей
БД; Orders — единственный writer своей projection/lifecycle.

1. #77 материализует выключенный scaffold и DB/network/Kafka bindings по #76.
   Это не реализация handler и не включение будущих capabilities.
2. #81 поставляет Orders-owned header handler и owner-local migrations/tests:
   проверка message identity, checkout/order correlation и invoice revision;
   Inbox + invoice summary + increment OrderCard.projectionVersion + Orders
   Outbox invalidation — одна Orders transaction. Header не создаёт payment
   requirement, не меняет payable amount и не переводит lifecycle в
   AwaitingCustomerPayment. Readiness требует Orders DB/Kafka, не будущие
   PDF store/scanner. #81/#88 не ждут #82/#83/#84.
3. #83 принимает accepted #81 handoff и расширяет тот же runtime финансовым
   InvoicePricesApplied handler. Header handler, principal и существующая
   subscription/group identity сохраняются. Добавляется только authorized
   ready read invoice-price-proof; финансовая capability требует storage
   readiness, но не grant на supplier PDF.

#76 закрепляет единственный topic/key/group/producer/consumer mapping, ordering
scope и monotonic guards. Этот ADR не придумывает wire/topic/group names;
несовместимый payload не публикуется под прежней версией. Прямая дуга #81→#83
выражает reuse уже транзитивного input через #82; обратной дуги нет.

## D2: отдельный минимальный order-revenue-proof

`order-revenue-proof.v1` — новый **target semantic artifact type**, не уже
опубликованная schema. Type/schema/version и bounded envelope материализует
#76 в единственном registry. Writer только Orders `orders-checkout-worker`;
reader только Pricing `pricing-cost-worker` с `ownerContext=Orders`,
`artifactType=order-revenue-proof`, `schemaVersion=1` и exact ready namespace.
Metadata/ACL owner — существующий `artifact-metadata-service`. Нет grants
произвольного prefix/list/download, browser, Payments, Work Center или invoice
readers на revenue bytes. Source checkout ref/hash — correlation, не capability
на чтение checkout-allocation bytes.

Proof содержит orderRef, checkoutSnapshotRef/checkout identity, frozen order
version, currency, immutable Locked customer line totals и order total,
полное line coverage/coverage hash и source snapshot proof identity. Исключены
credentials/URL, Customer PII, wholesale line payload и текущая quote. Значения
копируются из frozen Orders snapshot по принятой #75 quantity/money policy:
без новой формулы, rounding или переоценки. Сохраняются W2 JSON manifest ≤1 MiB
и сериализованный Kafka envelope+payload ≤64 KiB; oversized checkout/link
отвергается до irreversible effect.

#80 создаёт write-once bytes вне DB transaction. После повторной проверки
checkout/control version, fence и CancelGuard та же exact-link transaction
сохраняет proof refs и stages один Orders→Pricing Outbox fact вместе с invoice
materialization handoff. Rejected/stale link не публикует revenue; сохранённые
orphan bytes не business proof. Повтор identity/hash idempotent, иной hash/version
— conflict/correction без overwrite. Cleanup учитывает retention/holds и pending
intents. Pricing fetch/size/hash/type/schema validation выполняется вне DB locks;
затем Inbox + consumed proof + Pricing projection атомарны. До revenue и invoice
cost proofs маржа pending/review, missing revenue не ноль. Supplier cost/actual
delivery не изменяют Locked customer agreement.

## IO, health и enforcement

Точная matrix типов — [W2 ArtifactRef](../wave-2/02_RUNTIME_TOPOLOGY.md#artifactref-сканирование-и-восстановление).

- orders-checkout-worker: ready write checkout-allocation + revenue proof;
  без quarantine read/provider egress.
- aroma-checkout-poller: ready write только orders-invoice-source-proof;
  Gateway через internal API, без provider direct; ready storage обязателен.
- invoice-intake: ready read checkout-allocation + source-proof, без write;
  ready storage обязателен.
- invoices-command-handler: ready read checkout-allocation; без provider/Pricing grants.
- orders-invoice-consumer: header-only без artifact dependency; financial
  phase ready read только invoice-price-proof.
- pricing-cost-worker: ready read только revenue + invoice-price-proof;
  denied checkout-allocation, supplier PDF и source-proof.

#77 материализует connections/permissions и stage-specific health;
#78 — owner/type/version/namespace/hash/schema enforcement. Network membership
не generic storage capability. Trusted owner-generated JSON не ждёт scanner;
внешний uploaded JSON не становится trusted proof переименованием. External
PDF остаётся quarantine до #122, delivery #123 и financial proof #82.

## Отвергнутые варианты и будущие проверки

Отвергнуты второй header consumer в orders-service, ожидание #83 для раннего
header, Invoices writer в Orders DB, широкий Pricing checkout grant, копия
customer pricing policy, bytes в Kafka и новый service/DB.

Будущие owner acceptance обязаны доказать header без PDF/payment,
duplicate/stale revision без projection rollback, #83 reuse без потери header,
Pricing denied checkout/PDF, wrong owner/type/hash, duplicate/corrected proof,
no revenue до exact-link commit, оба порядка revenue/cost и immutable Locked
price. Это требования #76/#77/#78/#80/#81/#83/#86 и итогового #90, не выполненные
runtime tests этой документационной поставки.
