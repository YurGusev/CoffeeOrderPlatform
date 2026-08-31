# ProductPriceProjection

Projection key = `ProductVariantRef`.

Fields:

```text
supplierListUnitPrice
baseDiscountPercent
specialDiscountRuleRef / specialDiscountPercent
resolvedDiscountPercent / source
supplierNetUnitPrice
activeDeliveryCoefficientVersionRef / percent
deliveryUnitPrice
landedUnitCost
defaultMarkupPercent
recommendedCustomerUnitPrice
catalogSnapshotRef
pricingPolicyVersionRef
pricingVersion
pricingHash
calculatedAt
state = Current|Stale|Unresolved|Unavailable
requiresProcurementContext
```

Projection recomputes on supplier price/discount fact, PricingPolicy or DeliveryCoefficient activation.

Если special discount имеет quantity/weight threshold, product card показывает one-unit/default context и `requiresProcurementContext=true`; authoritative Order quote пересчитывается с фактическим context.

## Markup resolution

Target поддерживает `OrderItemMarkupSnapshot`. Precedence:

```text
OrderItem operator override
→ ProductVariant/Product default
→ Category default
→ Order default
→ Global default 5%
```

В v1 UI разрешает 5–10%. Источник resolved markup сохраняется в quote/OrderItem snapshot.
