# Master Architecture Revision — BusinessParity + Pricing v2

Эта master-ревизия читается **вместе** с baseline EndToEndHardened, зафиксированным `BASELINE_LOCK.json`.

## Новая карта программ

Baseline `M00…M20` сохраняется. Добавлены:

- `M21_OPERATOR_WORK_CENTER` — operational decision/read product.
- `M22_PRICING` — commercial price calculation and cost/margin lifecycle.

## Новый extended happy path

```text
AROMA supplier catalog
→ Catalog supplier price + discount facts
→ Pricing ProductPriceProjection
→ Draft PricingQuote
→ Orders Draft final customer price
→ Confirm + immutable OrderPriceManifest + Desired
→ AROMA convergence
→ Checkout/Wholesale
→ Invoice actual supplier cost
→ AwaitingCustomerPayment / Payments
→ physical delivery
→ operator enters actual delivery
→ next DeliveryCoefficientVersion
→ new ProductPriceProjection for next cycle
```

## Business parity capabilities

Customer, Excel import/export, Work Center, Catalog Search, Invoice manual recovery, Hermes policy and VK media are first-class target capabilities; их удаление/упрощение без characterization evidence запрещено.

## Architectural improvement over legacy

Target сохраняет доказанные safety semantics, но не копирует известный технический долг. `INTENTIONAL_CHANGE` и `RETIRE` заданы machine-readable registry.
