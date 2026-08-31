# M11. Catalog-driven AROMA Cart Safety

## 1. Scope

Этот документ связывает Catalog Product lifecycle (M07) с authoritative cart convergence (M11/M12).

Catalog не мутирует cart. Он может изменить **разрешённый target** через facts.

## 2. Inputs that may change Desired

Orders принимает:

```text
CatalogMappingChanged
CatalogAvailabilityChanged / Tombstone
```

и применяет их только через current-state guarded Desired mutation.

Price/name/description event сам по себе Desired не меняет.

## 3. Mapping fact transition table

| Catalog status | Desired resolution | Cart key | Positive contribution |
|---|---|---|---|
| Ready | Ready | required | yes if other axes allow |
| TemporarilyUnavailable | Unavailable | retain known key | no |
| MissingFromSnapshot | Unavailable/fail-closed | retain known previous key where available | no |
| RequiresManualReview | ManualReview | no active positive key; preserve previous key for target-zero convergence history | no |
| Removed/Tombstone | excluded/unavailable | previous key retained until zero convergence | no |

## 4. Positive preflight algorithm

Immediately before any physical mutation that **increases** target quantity:

1. current lease/fence must still be valid;
2. current Desired target/key version must match planned attempt;
3. Catalog preflight reads latest complete supplier snapshot proof from persisted Catalog state;
4. snapshot must be fresh under configured threshold;
5. every contributing Variant must have exact current Ready mapping and not be stopped/missing;
6. if any fact differs from Orders projection, planned attempt becomes `Superseded`/retryable and no positive provider mutation starts;
7. only then execute normal `fresh cart GET -> one mutation -> fresh cart GET`.

This replaces normal-path per-item provider catalog lookup.

## 5. Negative convergence does not require product to remain available

If Desired target decreases or becomes `0` because product stopped/remapped/deleted, Orders must still be able to remove/reduce the physical cart line using previously proven CartKey + **fresh cart GET**.

A stopped product must not block cleanup of its own stale cart quantity.

## 6. Transport failure

Catalog snapshot failure/staleness:

- never fabricates `Unavailable`;
- blocks new positive mutations after freshness threshold;
- does not delete existing Observed state;
- does not authorize blind cart cleanup unless Desired independently changed from durable facts.

## 7. Price changes

Supplier price changes do not cause:

```text
DesiredRevision
DesiredKeyVersion
Convergence target change
AROMA cart mutation
```

Price effects belong to explicit Draft quote or later invoice proof.

## 8. Manual mapping

Manual mapping semantic change must produce Catalog Outbox event immediately. Orders then remaps Desired old/new keys.

Manual mapping does not bypass positive preflight freshness.

## 9. Checkout

Frozen checkout stores immutable product/cart allocations. Later Catalog changes do not rewrite it. They may block/cause exception in future operations but never mutate historical proof.
