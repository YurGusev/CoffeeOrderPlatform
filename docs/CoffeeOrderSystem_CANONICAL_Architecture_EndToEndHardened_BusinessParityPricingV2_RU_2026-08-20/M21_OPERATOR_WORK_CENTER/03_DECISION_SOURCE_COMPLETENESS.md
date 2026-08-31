# Decision source completeness

Work Center обязан явно публиковать coverage status каждого source:

```text
Available
Degraded
Unavailable
Lagging
```

Нельзя показывать пустую очередь как «проблем нет», если source не подключён или consumer lag превышен.

Обязательные sources: Orders lifecycle/pricing, Catalog availability/mapping, AROMA events, Customer identity, Invoice events, Payments, Pricing delivery lifecycle.
