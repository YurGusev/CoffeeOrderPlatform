# M20. Sync/async call graph и anti-cycle

Generated policy source: `service-interaction-policy.yml`.

## Sync reads / provider proof

Allowed synchronous boundaries are narrow: browser/agent/internal HTTP, Orders→Catalog read-only snapshots, Orders-owned AROMA attempts→Gateway, Payments→PSP provider methods, Channel→VK, artifact reads/writes.

## Async ownership handoff

```text
Catalog -> Orders        Kafka facts
Orders -> Invoices       Kafka command + immutable ArtifactRef
Invoices -> Orders       Kafka event + price-proof ArtifactRef
Orders -> Payments       Kafka payment/refund/cancel commands/facts
Payments -> Orders       Kafka verified facts
Channel -> Agent         Kafka
Agent -> Channel         Kafka
```

## No cycles

No synchronous business cycle may cross owner boundaries. Payment provider webhook is inbound `provider -> payments-webhook`, not a reverse synchronous callback into Orders.
