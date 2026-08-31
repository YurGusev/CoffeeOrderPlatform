# Legacy C# → Pricing v2 migration map

| Legacy behavior | Target disposition |
|---|---|
| `AromaProcurementPricingPolicyVersion` | PRESERVE semantics, move ownership to Pricing |
| `OrderItemProcurementQuote` append-only evidence | PRESERVE and extend |
| `Math.Max(groupDiscount,promotionDiscount)` | INTENTIONAL_CHANGE: product rule overrides base |
| markup selectable `1–8` | INTENTIONAL_CHANGE: `5–10` |
| zero markup authorized exception | PRESERVE |
| delivery coefficient versioned in policy | PRESERVE, split into DeliveryCoefficientVersion |
| PDF price recalculates customer selling price | INTENTIONAL_CHANGE: actual cost only after Confirm |
| `ActualPriceFromInvoice` mutated in Catalog | RETIRE cross-owner mutation |
| JS/C# decimal rounding rules | PRESERVE exact round4/round2 semantics |
