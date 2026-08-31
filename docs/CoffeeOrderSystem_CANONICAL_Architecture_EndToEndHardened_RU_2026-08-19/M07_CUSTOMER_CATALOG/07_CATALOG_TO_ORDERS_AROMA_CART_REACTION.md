# M07. Catalog → Orders → AROMA Cart: реакция на изменение Товара

## 1. Главный принцип

Catalog **никогда не отправляет товар в AROMA cart**.

Catalog публикует факт. Orders решает, меняет ли факт authoritative Desired. Только Orders-owned Convergence меняет physical cart через AROMA Gateway.

```text
Catalog semantic change
       ↓ Outbox/CDC
Kafka Catalog fact
       ↓
Orders Inbox + current state
       ↓
Desired semantic change?
  ├─ no  -> stop
  └─ yes -> DesiredRevision / key version / target
                    ↓
             AROMA convergence
```

## 2. Матрица реакций

| Catalog fact | Orders historical snapshot | Desired | Physical AROMA cart |
|---|---|---|---|
| Name/description changed | unchanged | unchanged | none |
| Supplier price changed | unchanged unless explicit Draft reprice | unchanged | none |
| Product/Variant availability false | preserved | source fail-closed / target 0 | reduce/delete if currently present |
| Availability restored | preserved | positive target only if approval/resolution/fulfillment still valid | add/update as needed |
| Mapping Ready | preserved | Pending/Manual → Ready | positive convergence |
| Mapping TemporarilyUnavailable | preserved | Unavailable, known key, target 0 | reduce/delete |
| Mapping MissingFromSnapshot | preserved | fail-closed target 0 | reduce/delete if old key present |
| Mapping RequiresManualReview | preserved | ManualReview, target 0 | no positive mutation |
| Mapping remapped A→B | preserved | old key decreases, new key increases | converge both keys |
| Product/Variant tombstone | preserved | exclude/fail-closed, old key target 0 | reduce/delete |
| Provider GET/parse/timeout failure | unchanged | unchanged | **no mutation caused by this failure** |

## 3. Confirmed order + supplier stop example

```text
Order 101 Confirmed: Ethiopia ×2
Order 102 Confirmed: Ethiopia ×3
CartKey X target = 5
Observed = 5

Supplier snapshot:
product_on_stop=true for mapped Variant X
        ↓
Catalog: Variant unavailable + Mapping TemporarilyUnavailable
        ↓ mapping/availability Outbox
Orders:
  source 101 target contribution -> 0
  source 102 target contribution -> 0
  CartKey X target 5 -> 0
        ↓
Convergence fresh GET
        ↓
DELETE / set quantity 0
        ↓
fresh GET proves 0
```

Orders остаются `Confirmed`. На карточке показывается supplier/Aroma status `Unavailable`; business lifecycle не откатывается в Draft.

## 4. Supplier restoration example

Later complete snapshot:

```text
product_on_stop=false
mapping previous approved state restored
        ↓
CatalogMappingChanged Ready
        ↓
Orders current-state gate:
  Order still Confirmed?
  source Included?
  Approval valid?
  fulfillment still active-cart eligible?
        ↓ yes
Target 0 -> 5
        ↓
Convergence Add/Update
```

Если позиции уже перешли в stable fulfillment/wholesale/invoice, Catalog recovery **не возвращает** их в cart.

## 5. Remap example

```text
Variant V
old offer/cart key A
new verified offer/cart key B
```

Orders applies one semantic source change:

```text
A target -= source.Quantity
B target += source.Quantity
```

AROMA attempts независимы:

```text
A: fresh GET -> reduce/delete -> fresh GET
B: fresh GET -> add/update    -> fresh GET
```

UnknownOutcome одного key не разрешает blind retry и не отменяет доказанный результат другого.

## 6. Product/Variant tombstone example

Catalog delete publishes tombstone before identity disappears downstream.

Orders must retain enough old Desired/cart-key state to converge target to 0. Нельзя сначала удалить provider identity, а затем обнаружить, что физическую строку AROMA нечем адресовать.

## 7. Positive mutation preflight

Перед `target > observed` Orders Convergence должен получить **один read-only Catalog proof** для cart key:

```text
latest complete successful supplier snapshot
snapshotRef
observedAtUtc
freshness <= configured threshold (baseline 90m until separately tuned)
exact mapping facts for contributing variants
availability != stopped/missing/manual-review
```

Этот preflight читает **Catalog persisted state**. Он не делает per-item AROMA provider request.

Outcomes:

```text
snapshot unavailable -> retryable fail-closed; no physical cart GET/mutation
snapshot stale       -> retryable fail-closed; no physical cart GET/mutation
mapping changed      -> supersede current planned target; Desired event path catches up
product stopped      -> target becomes 0/superseded; no positive mutation
proof valid          -> proceed with AROMA fresh-cart GET -> one mutation -> GET
```

## 8. Why synchronous Catalog preflight is allowed

Это read-only safety proof, а не ownership cycle:

```text
Orders Convergence -> Catalog HTTP-R/local contract
```

Catalog не вызывает Orders в ответ. Confirm transaction его не использует.

## 9. Kafka is not the mutation plan

`coffee.catalog.*` и `coffee.aroma.cart.commands.v1` могут прийти duplicate/out-of-order/replay.

Consumer обязан перечитать current Orders state. Нельзя взять старый event `Ready` и отправить ADD в AROMA без current Desired/fresh Catalog proof/fence.

## 10. Checkout boundary

После `CheckoutPending/Frozen` новые supplier/catalog changes продолжают быть observable, но frozen checkout proof не переписывается.

Если Catalog fact показывает, что current live state больше не соответствует frozen assumptions, это становится checkout/reconciliation exception. Исторический snapshot остаётся immutable.
