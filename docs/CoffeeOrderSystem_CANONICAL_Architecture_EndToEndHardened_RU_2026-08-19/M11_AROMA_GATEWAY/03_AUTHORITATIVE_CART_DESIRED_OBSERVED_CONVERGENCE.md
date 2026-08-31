# M11. Authoritative Cart: Desired, Observed, Convergence

## 1. Три истины нельзя смешивать

```text
Desired  = что CoffeeOrder хочет видеть в dedicated AROMA cart
Observed = что последний успешный fresh GET доказал физически
Convergence = durable процесс сведения Observed к Desired
```

`AromaOrderItemExternalState/Fulfillment` — отдельная supplier-lifecycle projection и не заменяет Desired/Observed.

## 2. Desired source

Одна source на:

```text
(ProfileName, OrderRef, OrderItemRef)
```

Содержит immutable product snapshot и независимые оси:

```text
Contribution: Quarantined | Included | Excluded
Approval: NotRequired | Pending | Approved | Rejected
Resolution: PendingMapping | Ready | ManualReview | Unavailable
Fulfillment: supplier lifecycle
```

Contribution к target:

```text
Included
AND approval in (NotRequired, Approved)
AND resolution = Ready
AND fulfillment permits active cart contribution
```

## 3. Cart key

Физическая единица convergence:

```text
ProfileName + hash(offerId, canonicalGrind, canonicalPacking)
```

Target quantity = SUM всех contributing Desired sources этого key. Не OrderId.

## 4. Revisions

- `DesiredRevision`: целый snapshot профиля, нужен checkout.
- `DesiredKeyVersion`: semantic target конкретного cart key.
- audit text/timestamp не увеличивают semantic revision.
- remap увеличивает old/new key versions.

## 5. Observed

Только successful fresh GET может:

- append sanitized snapshot;
- обновить current physical items;
- доказать absence как quantity=0;
- обновить freshness/generation.

Failed GET не очищает Observed.

## 6. Convergence

Одна durable row на `(profile, cartKeyHash)`. Содержит target/version/observed/drift/retry/lease/fence.

Attempt append-only:

```text
Leased -> Mutating -> Verified
                   -> Failed
                   -> UnknownOutcome
        -> Superseded
```

Operation identity включает:

```text
profile + cartKeyHash + desiredKeyVersion + driftGeneration + target
```

## 7. Fencing

Stale worker может иметь уже in-flight provider request, но не может commit terminal state. Перед request start выполняется final fence check; terminal write требует current fencing token.

## 8. Kafka relationship

`coffee.aroma.cart.commands.v1` содержит **hint/request to converge**, не authoritative mutation plan. Consumer всегда перечитывает current Orders state.

Payload не должен давать Gateway/consumer права доверять старому `targetQuantity` без version recheck.

## 9. Availability

Positive mutation требует fresh/acceptable supplier availability proof. `Unavailable` имеет known cart key, но contributes zero. Transport failure != unavailable.

## 10. Repair

Periodic anti-entropy repair допустим как safety net, но он работает только с local persisted truth и не заменяет primary event-driven projection.

## 11. Profile Control State

Профиль имеет независимые оси:

```text
Activation: Quarantined | Active
Phase: Open | CheckoutPending
Health: Healthy | Paused | Blocked
Authority: ExclusiveProfile
```

Unsafe mutation разрешена только:

```text
Active
AND Open
AND Healthy
AND ExclusiveProfile
AND global/provider mutation switch enabled
```

Observer safe GET продолжает работать в Quarantined/Paused/Blocked/CheckoutPending, чтобы operational state оставался наблюдаемым.

## 12. Stable supplier fulfillment contributes zero

Target сохраняет правило текущего authoritative model: состояния supplier fulfillment после ухода позиции из активной корзины (`MovedToAromaInvoice`, `InAromaInvoice`, `PdfInvoiceLinked`, `PriceAllocated`, supplier `Completed`) не участвуют в Desired target. Local repair/consumer должен детерминированно обнулять contribution и advance semantic revision только при реальном изменении.


## 13. Catalog Product facts and positive preflight

Catalog product updates are not all cart-relevant:

```text
price/name/description -> no Desired target change
availability/mapping/tombstone -> may change Desired target
```

Orders consumes Catalog semantic facts idempotently and mutates Desired through the same revision service used by Confirm/edits. A mapping remap advances old and new cart-key versions; unavailable/missing/deleted identities produce target `0` without erasing the old key before cleanup convergence.

Before a **positive** provider mutation Convergence obtains one read-only Catalog proof based on the latest complete successful supplier snapshot. Stale/unavailable proof fails closed before physical cart mutation. Normal path does not issue one provider catalog GET per OrderItem.

See `../M07_CUSTOMER_CATALOG/07_CATALOG_TO_ORDERS_AROMA_CART_REACTION.md` and `06_CATALOG_DRIVEN_CART_SAFETY.md`.
