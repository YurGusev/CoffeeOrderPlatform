# M22 — Pricing

Pricing — отдельный bounded context, даже если в первой deployment wave несколько runtime roles могут использовать один image/repository package.

## Owns

- PricingPolicyVersion;
- base supplier discount policy (30% default);
- markup rules/defaults;
- DeliveryCoefficientVersion;
- ProductPriceProjection;
- PricingQuote / quote hash;
- ProcurementBatchDeliveryCost;
- expected/actual margin projections.

## Does not own

- supplier raw price/discount facts → Catalog;
- Order customer agreement → Orders;
- invoice truth/PDF actual supplier lines → Invoices;
- AROMA provider API → AROMA Gateway.
