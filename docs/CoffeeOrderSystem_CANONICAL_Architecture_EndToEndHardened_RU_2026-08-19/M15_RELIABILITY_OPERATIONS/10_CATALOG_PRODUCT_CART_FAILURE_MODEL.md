# M15. Catalog Product / Supplier Sync / AROMA Cart Failure Model

## 1. Supplier snapshot failures

| Failure | Required result |
|---|---|
| timeout/5xx | bounded safe-GET retry; preserve last successful Catalog projection |
| partial pages | reject entire projection |
| suspicious offer shrink | reject entire projection |
| duplicate/invalid identity | classify/review; no partial destructive inference |
| crash after GET before DB commit | retry local run; external GET may be repeated as a new safe read, no unsafe side effect |
| stale worker after lease loss | fencing prevents Catalog terminal commit |

## 2. Product projection failures

- `price <= 0` cannot overwrite valid price.
- stopped offer cannot create Product or update supplier price.
- ambiguity cannot create duplicate Product/Variant/mapping.
- same semantic state is no-op.
- manual-approved mapping survives automatic bulk resolver.

## 3. Delivery failures

Catalog Outbox/Kafka is at-least-once. Orders Inbox + source sequence/revision makes effects effectively-once.

Manual mapping commit without Outbox is a P0 defect in target implementation.

## 4. Cart safety cases

Required tests:

```text
Available -> Stopped -> Orders target zero -> physical remove verified
Stopped -> Available -> target positive only if fulfillment still eligible
Mapping A -> B -> old target zero/new target positive
Variant tombstone -> old cart key retained until zero convergence
Catalog Ready after stable fulfillment -> no re-entry to cart
Supplier price only changed -> zero AROMA mutations
stale supplier snapshot -> positive mutation blocked before provider cart request
```

## 5. Characterization parity

Current C# files named in M07 `08_LEGACY_CSHARP_CATALOG_BEHAVIOR_SOURCE_MAP.md` are behavioral evidence. Tests are the source of truth during TypeScript rewrite; do not modify characterization expectations merely to match new implementation.
