# Владение данными

## Базы данных

Физический PostgreSQL-сервер уже существует. Таблица описывает отдельные
логические БД новой платформы на этом сервере; legacy `coffeeorderdb` в неё не
входит и новой платформой не изменяется. Точные имена БД, роли и проверка прав
описаны в [документе существующей БД](09_EXISTING_DATABASE_AND_VERSIONS.md).

| База данных/схема | Writer | Сущности первого запуска |
|---|---|---|
| `coffee_platform_customer` | customer-service | Customer, Address, ChannelLink |
| `coffee_platform_catalog` | catalog services | Product, Variant, SupplierSnapshot, OfferMapping, Availability |
| `coffee_platform_pricing` | pricing-service | PricingPolicyVersion, PricingQuote |
| `coffee_platform_orders` | Orders runtimes | Order, OrderItem, History, Desired, Observed, ConvergenceAttempt, MutationReservation, Outbox, Inbox |
| `coffee_platform_integration` | aroma-gateway | encrypted session metadata, provider operation journal |

Ни один сервис не получает права записи в БД другого владельца. Read models
используют события или явные owner API; межвладельческий SQL запрещён.

## Границы транзакций

Транзакция `Confirm`:

```text
Order status/version
+ immutable item/product/price snapshots
+ Desired contribution/revision
+ Order history/audit
+ Outbox records
```

В ней нет внешнего HTTP или распределённой транзакции.

Транзакции convergence остаются короткими. Сетевой I/O окружён долговечными
состояниями attempt/reservation; блокировки БД не удерживаются во время HTTP-
вызовов провайдера.

## Минимальные индексы и ограничения

- unique idempotency owner/scope/key;
- unique active convergence lease per order/cart scope;
- monotonic fence epoch;
- unique provider operation reference;
- OrderVersion optimistic concurrency;
- unique Catalog snapshot generation and mapping identity;
- Outbox publish state and Inbox event ID uniqueness.
