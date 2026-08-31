# M11. Checkout cancel / wholesale race

## State machine

```text
Frozen/AwaitingWholesale
  -> CancelRequested
  -> CancelGuard
  -> Cancelled

Frozen/AwaitingWholesale
  -> WholesaleLinked

CancelRequested/CancelGuard
  -> CompensationRequired   # wholesale appears during/after cancel race
```

## Cancel algorithm

1. acquire profile orchestration lease/fence;
2. Orders transaction marks `CancelRequested(expectedCheckoutVersion)`;
3. fresh wholesale GET against frozen baseline;
4. if exact new wholesale candidate exists -> `WholesaleLinked/CompensationRequired`, cancel rejected;
5. fresh cart GET + verify no unsafe mutation/UnknownOutcome and frozen proof not superseded;
6. second fresh wholesale GET immediately before local transition;
7. if still absent -> reopen profile and enter `CancelGuard`;
8. keep wholesale polling during configurable guard window (baseline 15 minutes);
9. no candidate through guard -> `Cancelled` terminal;
10. late exact candidate -> `CompensationRequired`, never silently ignored.

## Supplier irreversibility

Once wholesale proof exists, generic checkout cancel cannot delete history. Operator sees explicit compensation workflow linking Orders/Invoices/Payments and supplier-side manual resolution when provider lacks cancellation API.

## Order mutation

During `CancelRequested/CancelGuard` Desired-changing Order commands remain blocked. They resume only after terminal `Cancelled` and profile Open.
