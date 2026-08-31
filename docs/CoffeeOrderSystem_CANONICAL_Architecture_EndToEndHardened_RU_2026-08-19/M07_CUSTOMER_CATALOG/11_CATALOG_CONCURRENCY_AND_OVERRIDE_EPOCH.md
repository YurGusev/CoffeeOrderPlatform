# M07. Catalog concurrency: supplier snapshot vs manual override

## Problem

Supplier snapshot worker имеет lease, но оператор может менять Product/Mapping параллельно. Snapshot, прочитавший старое состояние, не должен затереть более новый manual decision.

## Mapping model

Каждый mapping имеет application-owned:

```text
mappingRevision       UInt64
manualOverrideEpoch   UInt64
supplierProjectionRevision UInt64
```

Wire format всех UInt64 — decimal string.

## Manual mutation

В одной Catalog transaction:

```text
SELECT mapping FOR UPDATE
check expected mappingRevision
manualOverrideEpoch++
apply manual mapping
mappingRevision++
audit
Outbox CatalogMappingChanged(source=ManualOverride)
COMMIT
```

## Supplier projection

Перед commit:

1. lock affected mapping rows in stable `variantRef` order;
2. re-read `manualOverrideEpoch/mappingRevision`;
3. `ManualApproved` identity never overwritten by auto resolver;
4. supplier availability may temporarily suspend availability but stores/restores exact manual identity;
5. if epoch changed since run read, recompute decision from current row or mark superseded; never publish stale mapping fact.

## Product/Variant manual state

Supplier facts never overwrite `OperatorEnabled` or manual customer-facing metadata. See Product source-separation policy.

## Tests

Property/integration tests race manual override against snapshot materialization/mapping/availability and require manual decision to win deterministically.
