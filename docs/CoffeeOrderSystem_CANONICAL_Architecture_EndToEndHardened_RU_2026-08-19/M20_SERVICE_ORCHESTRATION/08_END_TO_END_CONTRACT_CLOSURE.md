# M20. End-to-end contract closure

## Canonical happy path

```text
VK/React
 -> ChannelIdentity/Auth
 -> Draft
 -> trusted confirmation
 -> Confirmed + Desired
 -> Catalog facts
 -> AROMA Convergence
 -> Order-atomic CheckoutAllocationManifest
 -> Wholesale proof
 -> Invoice materialization
 -> InvoicePriceProofManifest
 -> AwaitingCustomerPayment
 -> PaymentIntent/Webhook/Reconciliation
 -> PaymentSucceeded
 -> Completed
```

## Self-contained handoffs

- Catalog→Orders: Kafka payload enough to update Orders-owned projection/Desired; no Catalog DB cross-read in consumer transaction.
- Orders→Invoices: immutable allocation ArtifactRef+hash is self-contained; Invoices never reads Orders DB.
- Invoices→Orders: per-order summary + immutable price-proof ArtifactRef; Orders never reads Invoices DB.
- Orders→Payments: PaymentRequirement contains authoritative amount/currency/proof refs; Payments never reads Orders DB.
- Provider callbacks: owning context Inbox first, then async facts.

## Normal procurement cardinality

`Order-atomic` v1: one Order participates in at most one active normal Checkout/Invoice/PaymentRequirement. Additions after freeze become a related new Order.

## Realtime

Only model A is canonical:

```text
bounded context transaction -> Outbox -> coffee.realtime.invalidate.v1
```

Domain topics have no `realtime-*` consumer groups. SSE event is hint; browser refetches `client-v1`.
