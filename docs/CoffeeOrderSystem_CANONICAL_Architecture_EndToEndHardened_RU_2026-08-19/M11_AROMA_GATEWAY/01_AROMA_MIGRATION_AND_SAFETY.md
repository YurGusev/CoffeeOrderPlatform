# M11. Миграция AROMA и safety state machine

## 1. Два слоя миграции

### A1 — TypeScript AROMA Gateway

Переносится только provider protocol:

```text
auth/session/cookies
HTTP transport
provider DTO normalization
rate limiting
circuit breaker
safe GET
single explicit mutation primitive
```

C# Orders ещё владеет authoritative state machine.

### A2 — TypeScript Orders-owned AROMA process roles

После parity переносим:

```text
Desired / revisions
Observed / snapshots
Convergence
Attempt
Lease / FencingToken
UnknownOutcome
Checkout proof
Wholesale polling/link
Fulfillment projection
```

Это остаётся ownership Orders, даже если выполняется отдельными workloads.

## 2. Что НЕ переносим

Target implementation запрещает:

```text
Draft -> sendToAromaCart
AromaCartFillBatch
AromaCartFillLine
AromaCartAutoSync aggregate as authority
browser batch polling as business workflow
```

Из legacy сохраняются только characterization scenarios: baseline/target comparison, duplicate physical line detection, fresh GET proof, UnknownOutcome recovery и provider edge cases.

## 3. Kafka не является physical proof

AROMA не является producer наших domain events. Поэтому Kafka command — только durable wake-up/request. Решение о physical mutation всегда принимается из текущего Orders DB state + fresh AROMA GET.

## 4. Mutation protocol

```text
acquire DB lease/fence
-> validate current DesiredKeyVersion/target/profile axes
-> fresh product availability when target > 0
-> fresh cart GET
-> derive NoOp/Add/AbsoluteUpdate/Delete
-> persist attempt=Mutating + fence
-> final fail-closed gate
-> ONE unsafe provider request
-> fresh cart GET
-> exact equality verification
-> persist Observed/Attempt/Convergence/Fulfillment/Outbox
```

## 5. UnknownOutcome

Timeout/connection loss/auth recovery после unsafe request не означает failure. Attempt становится `UnknownOutcome`; следующий fresh GET определяет physical truth. Blind retry запрещён.

## 6. Shadow migration

TypeScript сначала вычисляет decision без mutation:

```text
same normalized state
C# authoritative decision == TS decision
```

Legacy `AromaCartFillBatch` не является parity target.

## 7. Circuit/retry ownership

- GET может иметь transport-level bounded retry.
- unsafe POST/PUT/DELETE не имеет generic HTTP retry.
- retry/business reconciliation принадлежит Orders convergence state machine.

## 8. Cutover

Unsafe mutation authority переключается только для dedicated AROMA profile/cohort после shadow parity, fault injection и explicit rollback gate.
