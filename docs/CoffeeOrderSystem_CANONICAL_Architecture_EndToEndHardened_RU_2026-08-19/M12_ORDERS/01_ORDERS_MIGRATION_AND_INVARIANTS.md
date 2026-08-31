# M12. Orders — финальный consistency-core migration

## 1. Почему Orders мигрирует последним

Orders связывает самые опасные invariants:

```text
Draft/edit/version
explicit confirmation
OrderItems snapshots/totals
AROMA Desired/Observed/Convergence
supplier fulfillment
checkout/wholesale proof
invoice price proof
payment requirement/completion
UnknownOutcome
```

Языковой rewrite не должен менять semantics.

## 2. Target ownership

После DB5 TypeScript Orders — единственный writer `orders.*` и владелец:

- Order lifecycle/history/version;
- item snapshots/totals;
- confirmation proof/idempotency;
- AROMA Desired/Observed/Convergence/Attempt/Lease/Fencing;
- supplier fulfillment projection;
- checkout/wholesale snapshot/process manager;
- minimal invoice/payment snapshots used by Order Card.

## 3. Five-state-machine rule

Нельзя смешивать:

1. Order lifecycle;
2. AROMA desired/convergence;
3. OrderItem supplier fulfillment;
4. Checkout lifecycle;
5. Payment lifecycle.

Order может быть `Confirmed`, пока AROMA `Pending`, `Blocked` или `UnknownOutcome`. Это не contradiction.

## 4. Migration stages

```text
O0 characterization corpus authoritative C# model
O1 target read model / Order Card parity
O2 Draft pure decisions shadow
O3 Draft write canary
O4 Confirm + Desired atomic parity
O5 Catalog preparation/mapping event parity
O6 Observed/convergence decision shadow (no mutation)
O7 dedicated AROMA test profile mutation canary
O8 Checkout/wholesale parity
O9 Invoices/price/payment handoff parity
O10 DB5 Orders ownership cutover
O11 remove legacy Order writer + sendToAromaCart/batch surfaces
```

## 5. Dual execution без dual write

```text
same command/state fixture
  ├─ legacy authoritative C# -> current result
  └─ TypeScript             -> shadow decision only
```

Comparison target — authoritative Desired/Observed/Convergence model, **не legacy batch implementation**.

## 6. Confirmation invariant

`Confirm` — единственный normal transition `Draft -> Confirmed`. Transaction не вызывает Catalog/AROMA/Invoices/Payments. Она фиксирует local business state, Desired и Outbox.

## 7. Versioning

Target вводит application-owned `OrderVersion BIGINT`; публичный expected version больше не зависит от PostgreSQL `xmin`. Integration events имеют `aggregateVersion`.

## 8. Money

`number` не используется для денежных calculations. Domain использует minor-unit bigint/decimal; JSON contract кодирует безопасно.

## 9. AROMA

Physical provider state никогда не выводится из Kafka status или successful POST response. Только fresh successful GET обновляет Observed.

## 10. Service relationships

Полный allowed graph — M20. Особенно запрещено выполнять sync cross-owner HTTP внутри Order transaction.
