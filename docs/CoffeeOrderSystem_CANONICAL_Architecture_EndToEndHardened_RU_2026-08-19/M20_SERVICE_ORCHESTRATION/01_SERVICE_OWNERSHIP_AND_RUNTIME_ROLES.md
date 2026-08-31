# M20. Ownership и runtime roles

Bounded context != process. Canonical executable inventory lives in `runtime-workload-registry.yml`.

## Business owners

| Owner | Truth |
|---|---|
| Customer | Customer, addresses, CustomerChannelLink |
| Catalog | Product/Variant/Alias, supplier snapshot, price, availability, mapping |
| Orders | Order lifecycle, Desired/Observed/Convergence, Checkout |
| Invoices | ClientInvoice, allocations, PDF/price proof, invoice compensation |
| Payments | PaymentIntent/WebhookInbox/Refund/provider proof |
| Channel Platform | ChannelIdentityLedger, inbound/outbound transport |
| Agent Platform | AgentTurn routing/journal, Hermes shard binding |
| AROMA Gateway | provider protocol/session only |

## Runtime principle

Несколько roles одного owner могут писать одну owner DB через отдельные least-privilege principals. Cross-owner SQL запрещён. Runtime registry сопоставляет каждый Kafka consumer group ровно одному executable role.
