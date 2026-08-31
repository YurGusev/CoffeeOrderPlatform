---
name: next-aroma-migration
description: "Use for target AROMA provider boundary and Orders-owned authoritative cart migration: Gateway protocol, Desired/Observed/Convergence, checkout, fencing, UnknownOutcome, and legacy cart-fill retirement."
---

# AROMA Migration and Safety

## Source of truth

`M11_AROMA_GATEWAY`, `M12_ORDERS`, `M20_SERVICE_ORCHESTRATION`.

## Hard rules

- Gateway = auth/session/HTTP/provider DTO/rate/circuit only.
- Orders = Desired/Observed/Convergence/Attempt/Lease/Fencing/UnknownOutcome/Checkout.
- Do not port `AromaCartFillBatch`, direct Draft send or browser resend workflow.
- Unsafe path: DB lease/fence -> fresh GET -> one mutation -> fresh GET -> exact verify.
- Gateway/HTTP layer never blind-retries unsafe POST/PUT/DELETE.
- Kafka command is wake-up/version hint, not physical proof/mutation authority.
- Failed GET never clears Observed; timeout after unsafe mutation => UnknownOutcome.
- Observer is read-only; checkout freeze uses safe reads only.
- Catalog Supplier Sync uses Gateway only for safe complete wholesale-catalog reads; normal mapping resolution/preflight uses persisted Catalog proof.
- Any service-link change activates `next-business-orchestration`.

## Parity

Compare TypeScript against authoritative C# convergence/checkout decisions, not legacy batch class structure.

- Catalog price changes do not change Desired/cart target; availability/mapping/tombstone facts may.
- Positive convergence requires fresh Catalog complete-snapshot proof; stopped/missing mappings fail closed.

## End-to-end closure hard rules

- Unsafe mutation requires durable MutationReservation + lease extension; new owner reconciles unresolved Mutating/UnknownOutcome before any new mutation.
- Gateway enforces method-level service audiences: catalog read-only callers cannot invoke cart mutations.
- Checkout cancel has `CancelRequested -> CancelGuard -> Cancelled|CompensationRequired` race-safe process.
