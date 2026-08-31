---
name: next-payments-platform
description: "Use for target Payments bounded context, OrderPaymentRequired handoff, provider intent/webhook/reconciliation, PaymentSucceeded facts, refunds, and audited manual payment fallback."
---

# Payments Platform

## Hard rules

- Payments owns PaymentIntent/provider proof; Orders owns Order status.
- Consume `OrderPaymentRequired`; do not query Orders inside provider webhook transaction.
- Publish verified `PaymentSucceeded`; never patch Orders directly.
- Browser redirect is not proof.
- Provider timeout => reconcile/idempotency, not blind second payment.
- Manual `Деньги собраны` is explicit manual/cash/recovery mode, not fake provider success.
- Activate `next-business-orchestration` for cross-service changes.

## End-to-end closure hard rules

- Provider webhook is a dedicated `payments-webhook` workload with verified WebhookInbox before ACK/async processing.
- Refund/cancel are explicit stable-ref commands and facts; original PaymentSucceeded remains immutable.
- Late success after cancellation never resurrects Order; refund/incident policy decides next step.
