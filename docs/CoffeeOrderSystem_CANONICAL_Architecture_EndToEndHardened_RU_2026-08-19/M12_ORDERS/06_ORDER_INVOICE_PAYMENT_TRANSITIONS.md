# M12. Orders ↔ Checkout ↔ Invoices ↔ Payments

## 1. После convergence

`Order=Confirmed` не меняется при `AROMA InSync`. InSync — отдельная supplier-cart projection.

## 2. Checkout

Profile-level freeze создаёт immutable proof. Заказ может оставаться `Confirmed` на всём supplier procurement этапе.

## 3. Wholesale -> Invoice

Exact wholesale link stages:

```text
InvoiceMaterializationRequested
operationRef = profile + checkoutSnapshotRef + wholesaleSnapshotRef
```

Orders не создаёт ClientInvoice напрямую и не ждёт Invoices HTTP в transaction.

## 4. Invoice facts

Orders consumes idempotently:

```text
InvoiceMaterialized
InvoicePdfLinked
InvoicePricesApplied
```

и хранит только необходимые snapshots/proofs.

## 5. Price completion

`InvoicePricesApplied` переводит Order `Confirmed -> AwaitingCustomerPayment` только если:

- event correlates to current immutable checkout/wholesale/invoice proof;
- все order items покрыты exact allocations;
- prices/quantities agree;
- Inbox/event id not processed;
- current Order state eligible.

## 6. Payment

Та же Orders transaction создаёт/stages `OrderPaymentRequired` Outbox event с stable requirement identity.

Payments создает PaymentIntent; verified `PaymentSucceeded` возвращается event'ом. Orders делает `AwaitingCustomerPayment -> Completed`.

## 7. No synchronous cycle

```text
Orders -> Invoices : async command
Invoices -> Orders : async facts
Orders -> Payments : async fact
Payments -> Orders : async fact
```

UI может синхронно читать owner-specific details, но background business transaction не строит sync loop.

## 8. Order-atomic coverage

Normal v1 requires exact coverage of **all active OrderItems in one CheckoutAllocationManifest** before Invoice price proof can advance the Order. Partial procurement is not silently inferred from subset allocations.
