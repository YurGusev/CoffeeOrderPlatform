# M19. Catalog/Product API Contracts

## 1. Public Product surface

Target browser Product routes belong to `client-v1` and are served by `api-public`:

```text
GET    /api/client-v1/products
GET    /api/client-v1/products/{productRef}
POST   /api/client-v1/products
PUT    /api/client-v1/products/{productRef}
DELETE /api/client-v1/products/{productRef}

POST   /api/client-v1/products/{productRef}/variants
PUT    /api/client-v1/products/{productRef}/variants/{variantRef}
DELETE /api/client-v1/products/{productRef}/variants/{variantRef}

# aliases/search administration as explicit child resources
```

Mutations are Admin-only unless a narrower role is later approved.

Unsafe update/delete requires:

```text
expectedVersion
```

Stale version -> `409 catalog_product_version_conflict` / variant equivalent.

## 2. Production destructive policy

Production `client-v1` **не содержит** `DELETE all`/`commands/delete-all`.

Normal product/variant removal uses expected-version guarded soft tombstone semantics, emits Catalog availability/mapping tombstone facts and preserves audit/history.

Full catalog purge exists only as maintenance/offline procedure from `M07_CUSTOMER_CATALOG/12_PRODUCT_PURGE_MAINTENANCE_POLICY.md` and requires:

```text
maintenance mode
backup/restore point
preflight active Orders/Desired/Checkout
bounded batches/rate limits
explicit incident/change approval
post-purge projection/reconciliation evidence
```

A confirmation phrase in public HTTP is **not** sufficient authorization for production mass purge.

## 3. Internal Catalog reads for Orders

`api-internal`/same-process application contracts expose **read-only** capabilities:

```text
getProductSnapshot(productRef)
getVariantSnapshot(variantRef)
getProcurementQuoteFacts(variantRefs)
getLatestSupplierPreflightProof(variantRefs/cartKey)
```

Allowed callers:

- Orders Draft create/edit;
- explicit Draft procurement preview/refresh;
- Orders Convergence positive-mutation preflight.

These routes read only persisted Catalog state. They never trigger AROMA provider requests as a hidden side effect.

## 4. Confirm exclusion

`ConfirmOrder` must not call any Catalog HTTP route. Missing mapping/availability is represented in Desired and completed asynchronously through Catalog commands/events.

## 5. Supplier sync API

Operational/Admin control is separate from browser Product CRUD:

```text
GET  /api/internal-v1/catalog/supplier-sync/status
POST /api/internal-v1/catalog/supplier-sync/refresh   # privileged/admin control
```

Public exposure, if needed for operator UI, is through a bounded client-v1 operations adapter; it never exposes provider credential/payload.

Supplier refresh is safe-read only with respect to AROMA and cannot enable cart mutation.

## 6. Mapping API

Manual mapping action requires:

```text
mapping expectedVersion/current identity
ExternalOfferRef
VendorCode
actor
reason
```

Server validates latest complete supplier proof. Semantic mutation commits mapping + audit + Outbox together.

## 7. Event API

Source of truth is M06:

```text
coffee.catalog.products.v1
coffee.catalog.availability.v1
coffee.catalog.mapping.commands.v1
coffee.catalog.mapping.v1
```

Product price events do not authorize Orders repricing. Availability/mapping consumers still perform current-state checks.

## 8. Error model

Stable examples:

```text
catalog_product_version_conflict
catalog_variant_version_conflict
catalog_supplier_snapshot_unavailable
catalog_supplier_snapshot_stale
catalog_supplier_snapshot_incomplete
catalog_supplier_snapshot_suspicious_shrink
catalog_mapping_manual_reason_required
catalog_mapping_ambiguous
catalog_mapping_not_verified
```

Provider timeout/5xx is `ExternalDependency`, not `TemporarilyUnavailable`.

