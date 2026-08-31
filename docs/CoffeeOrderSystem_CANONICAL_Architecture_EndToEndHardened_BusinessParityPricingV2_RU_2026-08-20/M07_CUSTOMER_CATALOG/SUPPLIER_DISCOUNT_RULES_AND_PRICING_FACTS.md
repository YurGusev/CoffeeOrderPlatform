# Supplier discount rules and pricing facts

Catalog владеет **supplier facts**, но не customer selling price.

Из AROMA complete supplier snapshot сохраняются:

```text
SupplierListPrice
ExternalProductRef / ExternalOfferRef
SupplierDiscountRule
MinimumWeight/Quantity (если есть)
Validity / observedAt
SourceSnapshotRef
ProductOnStop
```

`SupplierDiscountRule` хранит факт, что AROMA опубликовала специальную скидку. Catalog не решает, применять ли её вместо базовых 30% — это Pricing policy.

Любое semantic изменение price/discount rule публикуется через Catalog Outbox в `coffee.catalog.pricing.v1`.

Если правило имеет minimum-weight/minimum-quantity, Catalog публикует условие целиком. Нельзя проверять threshold только по весу одной фасовки без контекста количества/закупочного batch.
