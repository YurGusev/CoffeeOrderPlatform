---
name: next-customer-catalog-migration
description: "Use for target Customer/Catalog migration and cutover. For Product/Variant/supplier snapshot/pricing/availability/mapping business logic also activate next-catalog-product-lifecycle."
---

# Customer / Catalog Migration

## Catalog hard rules

- Catalog owns Product/Variant/Alias, supplier snapshots/prices, mapping and availability. Supplier-sync may call AROMA Gateway only for safe complete-catalog reads.
- `ConfirmOrder` must not synchronously depend on Catalog.
- Missing mapping -> async `CatalogMappingResolutionRequested` -> resolve from persisted complete supplier snapshot -> mapping/availability facts -> Orders Desired refresh.
- Transport failure != TemporarilyUnavailable.
- Catalog never writes Orders Desired or mutates AROMA cart.
- Activate `next-business-orchestration` for service-link changes.

- Product price change never auto-reprices Confirmed Orders or directly changes AROMA cart target.
- Activate `next-catalog-product-lifecycle` for Product/Variant/supplier-sync work.

## Customer hard rules

- Channel Platform owns ChannelIdentityLedger; Customer owns CustomerChannelLink only.
- One active Customer link per ChannelIdentityRef; identityEpoch change requires revalidation.
- Customer lifecycle is Active/Deactivated/Merged; normal hard delete is forbidden.
- Delivery addresses are versioned and Orders store immutable snapshots.
