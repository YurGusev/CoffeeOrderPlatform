# Discount, delivery and markup formulas

Let:

- `L` = supplier list unit price;
- `D_base` = base discount (30%);
- `D_special` = explicit AROMA product/offer discount if rule applies;
- `C` = delivery coefficient;
- `M` = markup;
- `Q` = quantity.

## Effective discount

```text
if applicable SpecialSupplierDiscountRule exists:
    D = D_special
else:
    D = D_base
```

Special 10% overrides base 30%. Special 35% overrides base 30%. No stacking, no `max()`.

For conditional supplier rules, applicability uses full quote context (`quantity`, eligible total weight/amount as defined by supplier rule), not only single package weight.

## Price

```text
SupplierNetUnitPrice = round4(L * (1 - D / 100))
DeliveryUnitPrice    = round4(SupplierNetUnitPrice * C / 100)
LandedUnitCost       = round4(SupplierNetUnitPrice + DeliveryUnitPrice)
CustomerUnitPrice    = round2(LandedUnitCost * (1 + M / 100))
LineTotal            = round2(CustomerUnitPrice * Q)
OrderTotal           = round2(sum(LineTotal))
```

Normal markup values: `5,6,7,8,9,10%`. `0%` only AuthorizedException with actor/reason.

All API money/percent values are decimal strings; PostgreSQL uses `numeric`, TypeScript uses Decimal library, not binary JS `number` arithmetic.
