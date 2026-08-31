# M20. Catalog/Product service connections

## 1. Allowed synchronous reads

Orders may synchronously read Catalog in **read-only, user/safety bounded operations**:

```text
Orders Draft create/edit -> Catalog product/variant snapshot
Orders Draft pricing preview/refresh -> Catalog persisted procurement quote facts
Orders Convergence positive preflight -> Catalog latest complete supplier snapshot proof
```

These reads have no reverse callback and therefore do not form a sync cycle.

## 2. Forbidden synchronous dependency

```text
ConfirmOrder -> Catalog HTTP        DENY
Catalog event handler -> Orders HTTP DENY
Catalog -> Orders DB                DENY
Catalog -> AROMA cart               DENY
```

## 3. Supplier boundary

Only Catalog-owned supplier-sync role performs normal AROMA Catalog provider read:

```text
catalog-supplier-sync -> AROMA Gateway -> complete wholesale GET
```

Mapping resolver uses persisted snapshot, not N per-item provider requests.

## 4. Async facts

Catalog publishes:

```text
coffee.catalog.products.v1
coffee.catalog.availability.v1
coffee.catalog.mapping.v1
```

Orders consumes only facts it owns reactions for. Catalog does not publish mutation commands into Orders business state.

## 5. AROMA cart consequence

Catalog change never directly calls AROMA cart.

```text
Catalog fact
 -> Orders Inbox
 -> Desired revision/target if semantic
 -> Orders Convergence
 -> AROMA Gateway GET/mutate/GET
```
