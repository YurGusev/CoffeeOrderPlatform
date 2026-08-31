# M11. Mutation Reservation поверх lease/fencing

## 1. Проблема

DB fencing не может отменить HTTP request, уже ушедший во внешнюю AROMA. Поэтому одного final fencing check недостаточно для исключения двух одновременных provider mutations после lease expiry.

## 2. Hard invariant

Перед каждой unsafe cart mutation Orders convergence создаёт **durable MutationReservation** в той же transaction, где финально проверяет fence.

```text
attemptRef
profileName
cartKeyHash
fencingToken
expectedDesiredKeyVersion
operation
baselineObservedSnapshotRef
reservedUntilUtc
providerDeadlineAtUtc
status = Mutating
```

## 3. Lease extension

Перед HTTP mutation:

```text
reservedUntilUtc >= providerDeadlineAtUtc + safetyMargin
leaseExpiresAtUtc >= reservedUntilUtc
```

Worker renews lease/reservation before call if remaining window insufficient.

## 4. New owner rule

Новый worker, даже получив новый fencing token, **не выполняет mutation**, если для CartKey есть unresolved `Mutating/UnknownOutcome` reservation.

Он входит в `ReconcileOnly`:

```text
fresh GET
compare baseline/current/target
resolve previous attempt
then and only then create new reservation
```

## 5. Crash windows

- crash before HTTP after reservation: next owner fresh GET proves no effect or detects drift;
- crash after provider accept before response: UnknownOutcome -> fresh GET;
- old worker late response: cannot persist authoritative success if fence changed.

## 6. Acceptance tests

Mandatory deterministic tests:

1. lease expires after final fence but before HTTP;
2. second worker acquires lease while first request in flight;
3. provider applies mutation but response lost;
4. process dies after reservation before request;
5. duplicate Kafka wake-ups/rebalance.

At no point may two workers concurrently issue unsafe mutation for same `(profile, cartKeyHash)`.
