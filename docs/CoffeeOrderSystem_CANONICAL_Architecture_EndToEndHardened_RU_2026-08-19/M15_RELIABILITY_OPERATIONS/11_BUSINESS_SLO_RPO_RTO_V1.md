# M15. Business SLO / RPO / RTO v1

**Status:** target release gates v1. Значения не означают, что система уже их достигла; cutover требует измерительного evidence.

## Latency/availability SLO

| Flow | Target |
|---|---|
| VK callback durable ACK after Kafka | p99 <= 1.5 s; 99.9% monthly |
| `ConfirmOrder` local API | p95 <= 500 ms, p99 <= 1 s |
| Confirm -> AROMA `InSync`, Catalog Fresh + provider healthy | p95 <= 30 s, p99 <= 120 s |
| Catalog successful snapshot freshness | >=99.5% time age <=90 min; hard alert at 90 min |
| Customer-visible agent text turn | p95 <= 15 s, p99 <= 30 s excluding explicit approval wait |
| Payment verified webhook -> Order Completed | p95 <= 15 s, p99 <= 60 s |
| Wholesale visible -> linked Checkout | p95 <= 2 min |
| WholesaleLinked -> InvoiceMaterialized | p95 <= 60 s |
| Invoice proof available -> AwaitingCustomerPayment | p95 <= 60 s |

## Data RPO/RTO

| Data | RPO | RTO |
|---|---:|---:|
| PostgreSQL business DBs | <= 5 min | <= 60 min |
| Kafka ACKed Tier-A ingress with DR replication | <= 60 s | <= 30 min |
| Kafka non-Tier-A streams | <= 5 min | <= 60 min |
| Artifact financial/proof objects | <= 5 min | <= 60 min |
| Hermes transcript/session state | <= 15 min | <= 60 min |

If business later requires **RPO=0 for provider-ACKed VK ingress**, current asynchronous Kafka DR is insufficient and requires a separate durable intake ledger/multi-region decision.

## Release gate

Production cutover blocked until load/failure/restore drills prove these targets or an explicit versioned exception is approved.
