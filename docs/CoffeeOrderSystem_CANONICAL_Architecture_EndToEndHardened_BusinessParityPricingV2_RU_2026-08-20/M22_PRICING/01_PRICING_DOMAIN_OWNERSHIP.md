# Pricing domain ownership

Catalog publishes supplier facts. Pricing converts them into commercial calculation. Orders stores the customer agreement snapshot.

```text
AROMA → Catalog supplier facts → Kafka → Pricing
Pricing → current ProductPriceProjection / Quotes → Orders
Orders Confirm → immutable OrderPriceManifest
Invoices → actual supplier cost → Pricing margin/recalibration
Operator actual delivery → Pricing → next DeliveryCoefficientVersion
```

No Pricing cross-owner DB access.
