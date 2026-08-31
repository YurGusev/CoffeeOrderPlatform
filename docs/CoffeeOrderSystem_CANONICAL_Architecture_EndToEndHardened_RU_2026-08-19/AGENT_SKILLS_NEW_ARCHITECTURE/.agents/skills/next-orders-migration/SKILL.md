---
name: next-orders-migration
description: "Use for target Orders consistency-core: Order lifecycle/version/history, explicit Confirm, Desired/Observed/Convergence ownership, Order Card projection, checkout, invoice/payment handoffs, and final C#→TypeScript cutover."
---

# Orders Migration and Business Invariants

## Source of truth

`M12_ORDERS`, `M11_AROMA_GATEWAY`, `M20_SERVICE_ORCHESTRATION`.

## Hard rules

- Target Order lifecycle: `Draft -> Confirmed -> AwaitingCustomerPayment -> Completed`, plus guarded `Cancelled`.
- AROMA/fulfillment/checkout/payment are orthogonal state machines; never add them to `Order.Status`.
- **No target `sendToAromaCart`** and no `AromaCartFillBatch` rewrite.
- `Confirm` is local atomic transaction: status/history/Desired/revisions/Outbox; no external HTTP.
- Orders owns Desired/Observed/Convergence/Attempt/Lease/Fencing/UnknownOutcome/Checkout.
- Provider physical truth only from fresh successful AROMA GET.
- Catalog supplier price/name changes do not silently rewrite Confirmed Order snapshots.
- Catalog availability/mapping/tombstone facts may change Desired target through guarded Orders consumers; stable fulfillment can never be reintroduced.
- Positive convergence requires latest-complete Catalog supplier proof before AROMA cart mutation.
- After Confirm, no generic edit/return-to-Draft. Use explicit guarded commands.
- Hard delete normal path only for Draft; post-confirm business records use cancel/compensation.
- Target public concurrency uses application-owned OrderVersion, not permanent raw `xmin` contract.
- Invoice/Payment transitions require verified owner facts and Inbox/idempotency.
- Any service-link change activates `next-business-orchestration`.

## Migration target

Characterization compares against current authoritative Desired/Observed/Convergence/Checkout behavior. Legacy batch is only edge-case evidence.

## Required tests

- lifecycle transition matrix;
- property tests Desired contribution/revisions;
- UnknownOutcome/fencing;
- checkout freeze proof;
- invoice/price/payment correlation;
- duplicate/replay/out-of-order events;
- no cross-owner sync dependency in Confirm.

## End-to-end closure hard rules

- v1 procurement is **Order-atomic**; no hidden partial checkout/invoice coverage.
- `addConfirmedItem` is a first-class guarded command before freeze; it uses a current persisted Catalog quote snapshot, then atomically writes OrderItem + quote/provenance + Desired + history + Outbox.
- additions after freeze create a new related Order.
- AI/VK `Draft -> Confirmed` requires trusted channel proof or operator approval; LLM cannot create proof.
- Checkout→Invoice and Invoice→Orders handoffs use immutable ArtifactRef+hash manifests; cross-owner reads are forbidden.
- Wire BIGINT/UInt64 versions/revisions are decimal strings.
