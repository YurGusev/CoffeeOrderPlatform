# M08. Payments runtime topology и provider webhook

## Runtime roles

```text
payments-order-consumer   consume OrderPaymentRequired, create/reuse intent
payments-webhook          public provider webhook verification + WebhookInbox
payments-reconciliation   provider GET reconciliation / UnknownOutcome
payments-refund-worker    refund/cancel provider side effects
```

Все роли принадлежат Payments bounded context, используют отдельные DB pools/principals и Kafka ACL.

## Public webhook

Edge route:

```text
/webhooks/payments/{provider} -> payments-webhook
```

Pipeline:

```text
verify signature/source
body size/schema
stable provider event dedupe
persist WebhookInbox
fast 2xx ACK
async local processing/reconciliation
Outbox PaymentSucceeded/Failed/...
```

Browser redirect не проходит этим путём и не является proof.

## Network

`payments-webhook` принимает только edge traffic. `payments-order-consumer/reconciliation/refund-worker` public ingress не имеют.
