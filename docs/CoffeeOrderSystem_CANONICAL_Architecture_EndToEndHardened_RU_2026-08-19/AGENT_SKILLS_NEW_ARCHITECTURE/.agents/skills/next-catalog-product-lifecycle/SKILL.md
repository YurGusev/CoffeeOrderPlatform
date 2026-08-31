---
name: next-catalog-product-lifecycle
description: Use for target Catalog Product/Variant/Alias mutations, complete AROMA supplier-catalog synchronization, supplier pricing, availability/tombstones, deterministic mappings, Catalog Outbox facts, Draft pricing reads, or Catalog-driven Orders Desired/AROMA cart reactions.
---

# Catalog Product Lifecycle

## Source of truth

Read `M07_CUSTOMER_CATALOG` first. For cart impact also read M11 `06_CATALOG_DRIVEN_CART_SAFETY.md` and M20.

## Hard rules

- Catalog owns Product/Variant/Alias, supplier snapshots/prices, availability and mapping.
- Product price/name changes do not silently rewrite Confirmed Order snapshots or Desired target.
- Availability/mapping/tombstone facts may change active Orders Desired, but only Orders owns that reaction.
- Complete successful supplier snapshot is the operational AROMA catalog proof; failed/partial/suspicious reads preserve prior truth.
- `product_on_stop=true` is `TemporarilyUnavailable`, not ManualReview.
- `MissingFromSnapshot` is distinct from product_on_stop; only a validated complete snapshot may produce it.
- Positive supplier price only; stopped/invalid/zero price does not overwrite working price or create SKU.
- Auto-create Product/Variant only from deterministic category/vendor/package/grind identity.
- Automatic mapping identity includes vendor code + package/non-weight key + canonical grind + ProductFamily.
- Manual-approved mapping has priority over automatic mapping.
- Every semantic manual/automatic mapping change writes Catalog Outbox in the same transaction.
- Availability transition/delete writes product/variant availability/tombstone Outbox in the same transaction.
- Product/Variant tombstone must allow Orders to converge old AROMA key to target zero before identity GC.
- Draft pricing refresh is explicit, stale-protected and reads persisted Catalog facts only.
- Confirm transaction never calls Catalog.
- Normal mapping resolver does not perform per-item provider HTTP; it uses persisted complete snapshot.
- Catalog never calls AROMA cart endpoints or writes Orders DB.

## Verification

Required characterization/property cases include stop/restore, same-state no-op, product+variant tombstone, suspicious snapshot shrink, price history, invalid price preservation, deterministic create, mapping collision/manual preservation, remap old/new keys, duplicate events, stable-fulfillment guard, and Draft-only pricing refresh.

## End-to-end closure hard rules

- Separate `OperatorEnabled` from supplier availability; derive `EffectiveOrderability` instead of one ambiguous IsAvailable flag.
- Separate SupplierListPrice provenance from operator/customer reference price.
- Manual mapping increments override epoch and publishes Outbox in same transaction; supplier projection rechecks epoch/row lock before commit.
- Public production DeleteAll is forbidden; purge is maintenance-only.
- Search indexing consumes `coffee.catalog.products.v1`; no separate indexing command/event topics in baseline.
