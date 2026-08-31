# DeliveryCoefficient lifecycle

Initial active version: `1.3%` with source `InitialPolicy`.

После фактической поставки оператор вводит `ActualDeliveryAmount` для конкретного ProcurementBatch/WholesaleOrder. Pricing уже должен иметь immutable `ActualSupplierGoodsTotal` из Invoices.

```text
CalculatedCoefficientPercent =
  round4(ActualDeliveryAmount / ActualSupplierGoodsTotal * 100)
```

Requirements:

- same currency and amount basis;
- goods total > 0;
- delivery amount >= 0;
- actor/reason;
- expected batch/pricing version;
- preview before activation.

State:

```text
DraftCostEntry → Calculated → ReviewRequired/Ready → Activated → Superseded
```

В v1 active coefficient для следующего procurement cycle равен подтверждённому фактическому коэффициенту последней принятой поставки. Moving average/сглаживание возможно только новой PricingPolicyVersion.

Новый coefficient не меняет уже Locked Orders. Он пересчитывает ProductPriceProjection и новые/Draft quotes.
