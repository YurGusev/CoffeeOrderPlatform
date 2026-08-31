# M20. End-to-end Order fulfillment orchestration

```text
1. Channel/React -> Draft
2. trusted confirmation -> Orders Confirmed + Desired
3. Orders preparation -> Catalog mapping command if needed
4. Catalog persisted snapshot -> mapping/availability facts
5. Orders Desired target -> AROMA Convergence
6. InSync + all active Order lines ready -> Order-atomic Checkout Freeze
7. Orders writes CheckoutAllocationManifest Artifact
8. Wholesale exact link -> InvoiceMaterializationRequested
9. Invoices validates manifest, creates allocations, links/scans PDF
10. Invoices writes InvoicePriceProofManifest + InvoicePricesApplied
11. Orders validates complete order coverage -> AwaitingCustomerPayment + OrderPaymentRequired
12. Payments creates intent, provider webhook/reconciliation verifies
13. PaymentSucceeded -> Orders Completed
```

Compensation paths use explicit invoice/payment commands; no owner rewrites another owner's DB.
