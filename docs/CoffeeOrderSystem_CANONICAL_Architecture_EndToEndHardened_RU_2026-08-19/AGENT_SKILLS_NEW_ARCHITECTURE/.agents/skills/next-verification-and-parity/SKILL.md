---
name: next-verification-and-parity
description: "Use before completing any new-architecture migration, route cutover, DB ownership transfer, event pipeline change, Hermes runtime change, or legacy deletion. It protects tests as source of truth and requires characterization, parity, failure, and rollback evidence."
---

# Next Architecture Verification and Parity

## Scope

Применяется вместе с program skill. Этот skill не определяет ownership — он определяет доказательства безопасности перехода.

## Core rule

**Тесты и инварианты нельзя переписывать под новую реализацию только потому, что TypeScript/Hermes/Kafka ведут себя иначе.** Сначала доказать, что старый test устарел по принятому ADR/contract, и только затем менять test отдельным осознанным diff.

## Required test layers

1. Pure domain/unit invariants.
2. Contract/schema validation.
3. PostgreSQL integration with real engine.
4. Kafka duplicate/replay/crash tests for async flows.
5. Characterization tests against C# current behavior when migrating.
6. Differential/parity tests C# vs TS for same inputs.
7. Nginx route/canary/rollback smoke.
8. Docker/Compose integration.
9. Failure injection for unsafe/external paths.
10. Browser E2E for React-visible cutovers.
11. Load/capacity tests for throughput claims.
12. Restore/recovery drill for stateful workloads.

## Migration evidence states

```text
NotCompared
ShadowMismatch
ShadowParity
Canary
Primary
SoakAccepted
LegacyRemovable
```

Нельзя перескакивать `ShadowMismatch -> Primary`.

## Differential tests

Для C#→TS business logic:

```text
same fixture/input
  -> legacy C# decision/output
  -> target TS decision/output
  -> normalized semantic diff
```

Особенно обязательно для Orders, pricing, confirmation, invoice reconciliation, AROMA Desired/Observed.

## Unknown outcome tests

Каждый unsafe I/O path должен иметь сценарий:

```text
provider/server accepted mutation
response lost
caller uncertain
```

Acceptance: нет blind retry; выполняется fresh read/reconciliation/idempotent lookup.

## Property-based candidates

- quantity/weight/grind combinations;
- Money arithmetic;
- order lifecycle transitions;
- duplicate Kafka events;
- webhook duplicates/out-of-order;
- AROMA fencing/lease epochs;
- confirmation versions;
- Hermes turn ordering.

## Cutover checklist

Перед primary:

- parity threshold accepted;
- no unexplained mismatch;
- rollback tested;
- target observability live;
- SLO baseline captured;
- target DB writer ownership clear;
- legacy writer blocked where DB5 applies;
- exact image/config/contract digests recorded.

## Final report

Указать:

- tests run;
- parity evidence;
- failure scenarios;
- load level;
- skipped checks;
- rollback path;
- reason any legacy test/contract was changed.

## BusinessLogicHardened Orders/AROMA rule

При Orders/AROMA migration target parity строится против authoritative `Confirm -> Desired -> Observed -> Convergence -> Checkout` semantics. Legacy `sendToAromaCart`/`AromaCartFillBatch` не является обязательным target behavior; из него переносятся только безопасные edge-case invariants. Service links дополнительно проверяются по M20/`next-business-orchestration`.

## Catalog Product rewrite

For M07 require characterization for availability no-op/transition, product+variant tombstones, complete snapshot rejection, positive price history, stopped offer behavior, deterministic create/mapping, manual mapping preservation/propagation, remap old/new Desired keys and explicit Draft-only price refresh.
