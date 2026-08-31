# 15. Selective / Domain-Oriented Microservices

## 1. Не начинать с service-per-module

Новая TypeScript platform сначала может быть modular monolith + separate process roles.

```text
api-public / api-agent / api-internal composition roles
platform-workers
channel workloads
hermes-dispatcher
```

## 2. Extraction gate

Физический microservice создаётся, если есть измеримая причина:

- independent scale;
- independent failure domain;
- stronger security isolation;
- different release cadence;
- external provider ownership;
- different persistence lifecycle;
- different runtime/resource profile.

## 3. Приоритеты

### Сразу отдельные workloads

```text
react-web
channel ingress/egress
realtime
Hermes runtime/dispatcher
```

### Сильный business service candidate

```text
Payments
```

### Возможные следующие

```text
Catalog
Invoices
AROMA Gateway
```

Catalog может иметь отдельный `catalog-supplier-sync` Deployment/Cron-style workload до полного service extraction. Runtime role остаётся Catalog-owned и не получает отдельный data ownership.

### Orders

Оставить cohesive consistency-core до доказанной причины дробления.

## 4. Nanoservices запрещены

Не создавать:

```text
OrderItemService
IdempotencyService
OutboxService
PriceCalculationService-per-method
```

## 5. Data ownership

Microservice считается автономным только когда у него exclusive domain data ownership и отсутствует прямой cross-service SQL.

## 6. Orders AROMA roles — workloads, не microservices

```text
orders-aroma-preparation
aroma-observer
aroma-convergence
aroma-checkout-poller
```

могут быть разными Deployments ради scaling/failure isolation, но **не получают отдельный domain ownership**. Они остаются process roles Orders bounded context и используют Orders-owned persistence/transactions.

`aroma-gateway` — отдельный security/provider service candidate, но он не владеет Desired/Observed/Convergence/Checkout и не имеет Orders DB access.

Если будущая команда хочет физически выделить Orders AROMA orchestration в отдельный bounded context/DB, требуется новый ADR с доказательством, как сохраняются atomic Confirm+Desired, revisions, checkout proof и fencing. По умолчанию такое разделение запрещено.
