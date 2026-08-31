# Manual allocation and three-way reconciliation

Auto allocation разрешён только при deterministic exact proof. Иначе создаётся `InvoiceManualAllocationTask`.

Three-way comparison:

```text
Checkout allocation manifest
↔ Wholesale supplier snapshot
↔ PDF invoice lines
```

Manual allocation сохраняет actor/reason и exact quantities. Sum allocations каждого OrderItem должна равняться expected procured quantity до price application.

Retry price application идемпотентен по immutable operation key. Unlink после price application выполняется compensation process, не delete rows.
