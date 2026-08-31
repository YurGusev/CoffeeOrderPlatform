# M07. AROMA Offer Mapping Lifecycle

## 1. Что такое mapping

Mapping отвечает только на вопрос:

> Какой AROMA offer соответствует конкретному локальному ProductVariant?

Mapping **не является** Order, cart line или supplier fulfillment.

Stable local owner key:

```text
CoffeeWeightVariantRef
```

Provider/cart identity:

```text
ExternalOfferRef
ExternalProductRef?
VendorCode
Packing
```

Grind конкретного заказа остаётся Orders concern; mapping хранит только допустимые canonical provider identity facts.

## 2. Deterministic automatic identity

Baseline exact auto-match:

```text
VendorCode
+ package/non-weight key
+ canonical product grind class
+ ProductFamily
```

Правила:

- один local variant + один exact supplier candidate → возможно auto approve;
- collision с любой стороны → ManualReview;
- ProductFamily mismatch → не mapping;
- invalid provider parameters → review, не guess;
- manual-approved mapping имеет приоритет над automatic resolver.

## 3. Piece SKU

Internal package key `0` допустим для piece unit и не означает физический вес `0 г`.

Он не проецируется в OrderItem/Desired как physical grams.

## 4. Mapping states

Target normalized status:

```text
Ready
RequiresManualReview
TemporarilyUnavailable
MissingFromSnapshot
Removed
```

Дополнительно хранится provenance:

```text
AutoApproved | ManualApproved
match strategy
score/evidence
last verified snapshot/time
manual actor/reason
```

## 5. TemporarilyUnavailable

При exact `product_on_stop=true`:

- mapping external identity сохраняется;
- previous approved/review state сохраняется в suspended fields/history;
- mapping не участвует в positive ordering;
- это не отправляется в manual review queue.

После exact available snapshot предыдущий state восстанавливается.

## 6. Manual override — target hardening

Текущий C# сохраняет manual mapping + audit. Target усиливает его:

```text
BEGIN Catalog
  expectedVersion/current state check
  validate actor + reason
  save ManualApproved mapping
  append audit
  append CatalogMappingChanged Outbox fact
COMMIT
```

Orders должен узнать semantic mapping change сразу через Kafka, а не ждать следующего hourly supplier run.

Перед `Ready` для positive cart contribution latest complete supplier snapshot должен подтверждать, что external offer identity всё ещё существует и snapshot не stale. Если proof отсутствует, mapping может быть сохранён как manual decision, но cart path остаётся fail-closed до verification.

## 7. Remap

Если Variant меняет:

```text
old CartKey A -> new CartKey B
```

Orders consumer через `AromaCartDesiredRevisionService` обязан:

```text
A target: -source quantity
B target: +source quantity
DesiredRevision++
DesiredKeyVersion(A)++
DesiredKeyVersion(B)++
```

После этого независимые convergence rows:

```text
A: reduce/delete
B: add/update
```

Нельзя сначала удалить old key identity из Orders и только потом пытаться вспомнить, что убрать из AROMA.

## 8. Mapping event

`coffee.catalog.mapping.v1`, key=`CoffeeWeightVariantRef`.

Payload содержит:

```text
coffeeWeightVariantRef
catalogMappingRevision
supplierSnapshotRef?
observedAtUtc?
status
externalOfferRef?
externalVendorCode?
externalPacking?
reasonCode
source = SupplierSnapshot | ManualOverride | AdminRepair
```

Для `TemporarilyUnavailable`/`MissingFromSnapshot` known provider identity сохраняется, если она была доказана ранее.

## 9. Stable fulfillment guard

Catalog fact не имеет права вернуть в cart source, которая уже находится в stable supplier fulfillment (`MovedToAromaInvoice`, `InAromaInvoice`, `PdfInvoiceLinked`, `PriceAllocated`, Completed).

Orders consumer проверяет current fulfillment перед Desired mutation.

## Concurrency and immediate downstream publication

Любая semantic mapping mutation — automatic, manual, availability suspension/restore, remap или tombstone — пишет `CatalogMappingChanged` Outbox **в той же Catalog transaction**. Orders не ждёт следующего hourly snapshot, чтобы узнать о manual remap.

Manual override использует `manualOverrideEpoch` и commit-time recheck; supplier projection не может затереть более новый manual decision. См. `11_CATALOG_CONCURRENCY_AND_OVERRIDE_EPOCH.md`.
