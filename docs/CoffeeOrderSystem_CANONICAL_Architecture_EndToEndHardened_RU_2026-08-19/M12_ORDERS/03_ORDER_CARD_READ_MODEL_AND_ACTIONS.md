# M12. Order Card Read Model и allowed actions

## 1. Order Card — projection, а не aggregate serialization

React/Hermes не получают DB row целиком. Orders публикует actor-specific read model.

```text
OrderCard
├── business
│   ├── orderRef
│   ├── version
│   ├── status
│   ├── totals
│   └── allowedActions[]
├── customerSnapshot
├── items[]
├── aroma
│   ├── syncStatus
│   ├── desiredRevision
│   ├── observedFreshness
│   ├── lastVerifiedAt
│   ├── blockingReasons[]
│   └── itemSummary
├── checkout
│   ├── checkoutRef
│   └── status
├── procurement
│   ├── orderAtomicEligible
│   └── blockers[]
├── invoiceSnapshot
│   ├── invoiceRef/number
│   ├── priceProofStatus
│   └── allocationCoverageHash
└── paymentSnapshot
    ├── paymentRequirementRef
    └── status
```

Foreign snapshots помечаются provenance/freshness; authority остаётся у owning context.

## 2. Derived AROMA sync status

Это server-computed projection, не ещё одна authoritative state machine:

```text
NotApplicable
Preparing
AwaitingApproval
AwaitingMapping
Unavailable
Pending
InSync
Retrying
Blocked
UnknownOutcome
```

## 3. Actions: Draft

```text
open
editDraft
refreshDraftProcurementPrices
confirm
deleteDraft
```

**Нет `sendToAromaCart`.**

## 4. Actions: Confirmed

Доступны только explicit server-derived capabilities, например:

```text
open
cancelOrder
addConfirmedItem
removeConfirmedItem
changeConfirmedQuantity   # только если policy разрешает
```

Generic `editOrder` после confirmation запрещён.

## 5. Checkout/irreversible gates

Если Order входит в active CheckoutPending/frozen proof, actions, меняющие Desired, скрыты и server-side rejected независимо от UI.

После wholesale/PDF/price proof normal edit/cancel заменяется compensation workflows.

## 6. AwaitingCustomerPayment

UI показывает payment owner/status. Основной online action — открыть/продолжить payment flow. `markPaymentCollected` показывается только для разрешённого manual/cash/recovery режима.

## 7. Recovery actions

AROMA recovery отделена от Order lifecycle actions:

```text
refresh safe observation
open mapping problem
open AROMA diagnostics
```

`retry unsafe mutation` не является browser action при `UnknownOutcome`.

## 8. Realtime

Kafka/SSE только инвалидирует projection:

```text
hint -> invalidate OrderCard query -> fresh client-v1 GET
```
