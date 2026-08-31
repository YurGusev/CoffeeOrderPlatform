# Pricing end-to-end sequence

## Supplier update

1. Catalog supplier sync reads complete AROMA snapshot.
2. Catalog transaction updates supplier price/discount facts + Outbox.
3. `coffee.catalog.pricing.v1` reaches pricing-projection.
4. Pricing recomputes ProductPriceProjection with active policy/coefficient.
5. Pricing publishes `ProductPriceProjectionChanged`.
6. Orders pricing projection marks affected Draft quotes stale.
7. React/Hermes obtains fresh quote before Confirm.

## Confirm

1. User sees final customer line/order total.
2. Orders verifies local quote/pricing versions; no external HTTP.
3. Creates immutable OrderPriceManifest + Desired + lifecycle/outbox atomically.

## After supplier invoice and delivery

1. Invoices publishes actual supplier goods cost.
2. Orders keeps locked customer price unchanged.
3. Operator enters actual delivery for ProcurementBatch.
4. Pricing previews actual delivery coefficient.
5. Operator activates it.
6. New DeliveryCoefficientVersion becomes effective next cycle.
7. ProductPriceProjection recalculates.
8. Pricing computes actual margin for completed batch/orders.
