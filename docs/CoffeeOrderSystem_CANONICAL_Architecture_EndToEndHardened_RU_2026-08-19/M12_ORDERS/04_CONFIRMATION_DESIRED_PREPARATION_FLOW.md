# M12. Confirm -> Desired -> Preparation

## 1. Atomic local confirmation

Нормативная transaction:

```text
BEGIN Orders DB
  lock/check Order + OrderVersion
  validate Draft/items/markup/profile gate
  Draft -> Confirmed
  append OrderStatusHistory
  upsert DesiredSource per OrderItem
  advance semantic DesiredRevision/DesiredKeyVersion
  write Outbox OrderConfirmed
  write Outbox AromaPreparationRequested
COMMIT
```

Нет Catalog/AROMA/Invoices/Payments HTTP внутри transaction.

## 2. Desired at confirmation

Если Orders уже имеет актуальный resolved mapping snapshot, source может быть `Ready`. Иначе:

```text
PendingMapping
ManualReview
Unavailable
```

Target normal AI/VK confirmation исполняется только с trusted `ChannelConfirmationProof`; такой source создаётся `Approval=Approved`. Operator source — `NotRequired`. `Approval=Pending` остаётся migration/manual-review fallback с bounded operator queue/expiry.

## 3. Kafka preparation

`coffee.aroma.preparation.commands.v1`:

```text
AromaPreparationRequested
key = OrderRef
```

Consumer `orders-aroma-preparation` перечитывает current Order/Desired; message не является snapshot authority.

## 4. Catalog resolution

Если нужный mapping отсутствует/устарел, preparation публикует:

```text
coffee.catalog.mapping.commands.v1
CatalogMappingResolutionRequested
key = CoffeeWeightVariantRef
```

Catalog resolver читает **последний complete persisted supplier snapshot** и не выполняет per-item provider HTTP. Только `catalog-supplier-sync` читает wholesale catalog через read-only AROMA Gateway capability. Resolver сохраняет mapping/availability и публикует facts.

Orders consumes:

```text
coffee.catalog.mapping.v1
coffee.catalog.availability.v1
```

и обновляет Desired through one revision primitive.

## 5. Convergence wake-up

Semantic Desired change пересчитывает cart-key target и stages `ConvergeAromaCartRequested` (Outbox -> Kafka). Consumer перечитывает current state и leases convergence row.

## 6. Idempotency

Duplicate confirmation с тем же proof/idempotency key возвращает committed outcome только если full invariant already exists: status/history/Desired/preparation identity. Partial state — conflict/repair, не silent success.


## Catalog boundary after Product hardening

`ConfirmOrder` uses only Orders-local persisted/snapshot state and never performs a Catalog/provider HTTP call. If a Variant mapping is missing, Desired remains non-contributing (`PendingMapping/ManualReview/Unavailable`) and Orders publishes asynchronous mapping-resolution work.

Catalog resolver uses its latest complete persisted supplier snapshot. A new mapping/availability fact returns through Kafka and is applied idempotently to Desired. Draft product selection/explicit procurement refresh may use synchronous Catalog reads, but this is not part of Confirm transaction.
