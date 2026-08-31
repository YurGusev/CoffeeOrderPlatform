# Владение данными

## Базы данных

| База данных/схема | Writer | Сущности первого запуска |
|---|---|---|
| `customer` | customer-service | Customer, Address, ChannelLink |
| `catalog` | catalog services | Product, Variant, SupplierSnapshot, OfferMapping, Availability |
| `pricing` | pricing-service | PricingPolicyVersion, PricingQuote |
| `orders` | Orders runtimes | Order, OrderItem, History, Desired, Observed, ConvergenceAttempt, MutationReservation, Outbox, Inbox |
| `integration` | aroma-gateway | encrypted session metadata, provider operation journal |

No service receives write credentials for another owner's database. Read
models use events or explicit owner APIs; cross-owner SQL is forbidden.

## Границы транзакций

`Confirm` transaction:

```text
Order status/version
+ immutable item/product/price snapshots
+ Desired contribution/revision
+ Order history/audit
+ Outbox records
```

It contains no external HTTP and no distributed transaction.

Convergence transaction boundaries are short. Network I/O is surrounded by
durable attempt/reservation states; database locks are not held across provider
HTTP calls.

## Минимальные индексы и ограничения

- unique idempotency owner/scope/key;
- unique active convergence lease per order/cart scope;
- monotonic fence epoch;
- unique provider operation reference;
- OrderVersion optimistic concurrency;
- unique Catalog snapshot generation and mapping identity;
- Outbox publish state and Inbox event ID uniqueness.
