# AROMA Cart Safety

## Ownership

Orders owns business intent and recovery. AROMA Gateway owns provider transport.

```text
Orders: Desired, Observed, Convergence, Attempt, Lease, Fence, UnknownOutcome
Gateway: login/session/cookies, typed GET/mutation, rate/circuit, DTO mapping
Catalog: persisted complete snapshot, offer mapping and availability facts
```

## Provider primitives

Gateway exposes private typed operations only:

```text
getWholesaleCatalogSnapshot()
getCartSnapshot()
setCartLineQuantity(offerRef, quantity, operationRef)
removeCartLine(offerRef, operationRef)
```

It does not expose arbitrary URL/method/body and does not blind-retry unsafe
operations. Catalog identity may call only safe catalog reads. Mutation
audience is restricted to Orders convergence.

## Convergence attempt

```text
1. Acquire durable lease and monotonically increasing fence epoch.
2. Verify Desired revision is still current.
3. Verify latest complete Catalog snapshot and active mapping.
4. Reserve one exact mutation operation.
5. Fresh GET cart.
6. If already equal: persist InSync, no mutation.
7. Execute at most one mutation.
8. Fresh GET cart.
9. Persist Observed and exact verification result.
10. Complete attempt and release lease.
```

Timeout after step 7 persists `UnknownOutcome`. A new attempt must reconcile
with fresh GET and operation reservation before any further mutation.

## Failure rules

- Failed/partial GET never becomes an empty cart observation.
- Stale fence cannot persist success or start mutation.
- Mapping missing/stopped blocks positive quantity.
- A price change does not silently rewrite confirmed Order target.
- Kafka message is a wake-up/version hint, never proof of physical cart state.
- Reconciliation command cannot override safety checks.

## Secret boundary

Supplier-owned credentials remain outside Git, logs, Kafka and browser. They
are injected only into `aroma-gateway`; request/response logging is redacted.

