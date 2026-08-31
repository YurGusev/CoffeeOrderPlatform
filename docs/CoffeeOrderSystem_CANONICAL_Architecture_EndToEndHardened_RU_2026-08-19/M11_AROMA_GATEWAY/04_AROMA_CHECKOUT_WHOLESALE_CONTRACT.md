# M11. Checkout и Wholesale Contract

## 1. Checkout — profile-level process

Checkout не является `Order.Status`. Один physical supplier checkout может включать несколько Orders.

## 2. Freeze prerequisites

Перед freeze требуется:

```text
profile Active/Open/Healthy/Exclusive
orchestration lease + fencing
expected control version
expected DesiredRevision
expected successful Observed snapshot
no in-flight/UnknownOutcome mutation
no pending stable-fulfillment repair
fresh wholesale baseline GET
fresh cart GET
exact Desired == Observed
valid markup/business gates
```

Freeze выполняется local serializable transaction и создаёт immutable:

```text
CheckoutSnapshot
CheckoutLines
SourceAllocations
WholesaleBaseline
ConvergenceProofHash
DesiredRevision
ObservedSnapshotRef
FencingToken
```

Freeze **не посылает cart POST/PUT/DELETE**.

## 3. Phase

```text
Open -> CheckoutPending
```

Пока CheckoutPending, Desired-changing commands для включённых orders blocked.

## 4. Wholesale polling

Orders-owned `aroma-checkout-poller` делает safe GET wholesale list. Candidate должен быть отсутствующим в baseline и точно совпасть по frozen cart proof.

```text
0 candidates -> AwaitingWholesale
>1 -> Ambiguous / blocked
1 mismatch -> QuantityMismatch / blocked
1 exact -> WholesaleLinked
```

## 5. Exact link

В одной Orders transaction:

- link immutable wholesale snapshot;
- exclude frozen Desired sources from active cart;
- advance revisions;
- reopen profile `Open`;
- stage `InvoiceMaterializationRequested` Outbox command.

## 6. Cancel

Cancel допустим только до irreversible supplier/invoice proof. Выполняются fresh safe cart/wholesale reads и concurrency checks. После wholesale link/PDF/price proof используется compensation, не generic cancel.


## 7. Order-atomic freeze

Freeze v1 включает Order только целиком: все активные OrderItems должны иметь Ready/InSync allocation. Partial procurement одного Order запрещён normal path.

## 8. Cancel race

Algorithmic cancel/wholesale race contract: `08_CHECKOUT_CANCEL_RACE_AND_COMPENSATION.md`.
