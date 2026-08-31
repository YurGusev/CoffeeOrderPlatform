# First Vertical Slice

## Happy path

```text
1. React creates/selects Customer.
2. React searches Catalog persisted snapshot.
3. React requests PricingQuote.
4. React creates Draft Order with quoteRef/hash and product snapshot.
5. React confirms Draft with expected OrderVersion and Idempotency-Key.
6. Orders transaction writes Confirmed + Desired + history + Outbox.
7. Orders preparation verifies persisted Catalog mapping/availability facts.
8. Convergence acquires lease/fence and invokes AROMA Gateway.
9. Gateway performs fresh GET -> at most one mutation -> fresh GET.
10. Orders stores Observed and Convergence result.
11. Realtime invalidation refreshes Order Card in React.
```

## User-visible states

Order lifecycle:

```text
Draft -> Confirmed
```

AROMA state is orthogonal:

```text
PendingCatalogProof
PendingObservation
OutOfSync
Converging
InSync
Blocked
UnknownOutcome
```

## Acceptance scenario

Given a complete Catalog snapshot and valid AROMA mapping, when an operator
confirms a Draft, then the HTTP response is returned after the local Orders
transaction only. The UI subsequently receives invalidation and eventually
shows `InSync` with desired and observed quantities equal.

If the mutation response is lost, the UI shows `UnknownOutcome`; the system
performs a fresh observation before allowing a new mutation. The operator has
no generic “send again” action.

