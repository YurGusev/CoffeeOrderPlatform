# ADR-0016: Govern clean-room migration gates and writer handoff

Decision ID: `DEC-PLT-M00-MIG-002`<br>
Status: Accepted<br>
Date: 2026-08-27<br>
Program: M00 — Architecture Foundation<br>
Parent capability: #1081<br>
Decision issue: #1104<br>
Target migration stage: `Specify`<br>
Test Changes Allowed: `No`

## Context

The clean-room migration is a staged change of implementation and ownership,
not a branch merge or a Project-board status transition. A merged pull request
proves that a reviewed change entered the repository; it does not prove
behavioral parity, rollback readiness, a schema-owner handoff or production
authority. Without a reusable decision, later domain programs could infer
authority from merge, issue status, Project status or saved progress, or could
briefly create dual writers during a migration.

M00 therefore needs one evidence-only policy for the common migration ladder.
The policy must remain bound to the accepted M00–M22 graph from #1103 and to
the active v3 M20 runtime/service closure. It must not implement a runtime,
change a schema, perform a migration, or authorize a production write.

## Decision

### 1. Decision and artifact binding

This ADR is the accepted Decision for #1104. Its machine-readable companion is
[`migration-gate-policy.json`](../../platform/evidence/migration-governance/migration-gate-policy.json),
validated by
[`validate-platform-migration-policy.py`](../../scripts/validate-platform-migration-policy.py)
against
[`migration-gate-policy.schema.json`](../../platform/evidence/migration-governance/migration-gate-policy.schema.json).
The validator requires this ADR's exact Decision ID, status, issue, target
stage and `Test Changes Allowed=No` metadata before accepting the policy.

The policy binds to the exact #1103 graph SHA-256:

```text
93a6c076617c8c99d87be1ffef8720bdd6845ad354f688e4a6c1df5348be9bce
```

The active canonical chain remains baseline → BusinessParityPricingV2 →
PrivateSingleOwnerSecurityException → ArchitectureContractClosure. M20 uses
the v3 materialized closure: schema version 3, 42 runtime roles, 53 allowed
edges, 24 denied edges, uniqueness key `from,to,mode`, no wildcard edges and
reject-on-undeclared interaction. A missing, stale or substituted graph or M20
authority fails closed.

### 2. Stage and evidence rule

The exact migration stages are:

```text
Authority → Specify → Characterize → Foundation → Implement
          → Shadow → Canary → Primary → Soak → Retire
```

Each stage has one canonical machine-readable exit gate identifier, in order:
`authority-decision-accepted`,
`specification-owner-contract-rollback-accepted`,
`characterization-accepted`, `foundation-verified`,
`implementation-without-authority`, `shadow-no-writes-mismatches-classified`,
`canary-shadow-rollback-accepted`, `primary-single-writer-authority`,
`soak-slo-recovery-accepted` and `retire-zero-use-retention-accepted`.
The human-readable exit text is bound to that exact identifier by the
validator; callers may not substitute arbitrary gate text.

Every adjacent transition requires an explicitly accepted evidence artifact.
Evidence is not inferred from a merge, issue status, Project status or saved
progress. Each entry and exit records the accepted artifact and its owner;
the policy validator rejects a skipped, reordered, duplicate or unaccepted
transition. Target-stage labels remain planning classifications until their
separate evidence is accepted.

The policy declares these evidence artifacts and their owners. A stage
entry/exit or transition may reference only one of these exact IDs and must
carry the matching owner:

| Artifact ID | Owner |
|---|---|
| `accepted-authority-decision` | `m00-architecture-governance` |
| `accepted-requirements-owner-contract-rollback` | `m00-architecture-governance` |
| `accepted-legacy-characterization-and-disposition` | `bounded-context-owner` |
| `accepted-workspace-runtime-foundation` | `m16-cicd-supply-chain` |
| `accepted-target-implementation-without-authority` | `bounded-context-owner` |
| `accepted-shadow-parity-and-mismatch-disposition` | `bounded-context-owner` |
| `accepted-shadow-and-rollback-drill` | `m15-reliability-operations` |
| `accepted-single-writer-production-authority` | `bounded-context-owner` |
| `accepted-slo-error-replay-recovery-window` | `m15-reliability-operations` |
| `accepted-zero-use-and-rollback-retention` | `m14-decommission` |

### 3. Schema and migration owner handoff

Each bounded context has exactly one approved writer for each schema at every
moment. Concurrent migrations and dual writers are forbidden. A handoff record
must contain the exact `schema`, `beforeOwner`, `afterOwner`, `migrationOwner`,
`effectiveAt` and accepted `evidence`. The safe order is:

```text
freeze-before-owner → verify-after-owner → accept-evidence → activate-after-owner
```

The policy never performs this handoff; it defines the fields and evidence that
must be present before a later bounded-context decision can claim it.

### 4. Rollback and unknown outcome

Rollback evidence is required before `Canary` and must identify all of:

- an explicit failed-gate, unexplained-mismatch, SLO or unsafe-writer trigger;
- the bounded-context owner responsible for the action;
- a bounded observation window measured from activation; and
- fresh-read reconciliation of owned state.

The shared policy uses the canonical trigger identifier
`rollback-trigger-v1` with conditions `failed-gate`,
`unexplained-parity-mismatch`, `slo-breach`, `unsafe-writer-state` and
`stale-authority-evidence`. Its accepted observation window is exactly 60
minutes from activation, bounded by a 120-minute maximum; a domain decision
may choose a stricter window but may not use an unbounded value.

An unsafe operation whose response is lost enters `UnknownOutcome`. Promotion
stops, the owner performs a fresh read/reconciliation, and no blind retry is
allowed (`blindRetry=false`). A route rollback after an incompatible DB5
change is not permission to restore the old writer without a forward-compatible
contract and accepted evidence.

### 5. Production and retirement

Production certification remains `PENDING EVIDENCE` and
`writesAllowed=false`; legacy production remains the runtime authority until a
separate accepted domain cutover. `Retire` additionally requires accepted
zero-use evidence and retention of the rollback material until the accepted
zero-use proof and rollback window are complete.

## Consequences

Migration progress is auditable and cannot be advanced by repository or board
activity alone. Domain programs must supply their own parity, failure, SLO,
recovery and ownership evidence. The policy adds no runtime dependency and
keeps all production/cutover decisions behind their existing owner gates.

## Out of scope and non-decisions

This ADR does not:

- change Project fields, issue state, pull requests or branch protection;
- perform a database migration, schema handoff, route cutover or deployment;
- authorize production writes, legacy deletion, provider operations or secret
  rotation;
- select domain-specific thresholds or replace M15/M16/M18/M20 authority; or
- modify canonical release roots, source bytes or the #1103 graph.

## Rollback and STOP conditions

Rollback is a documentation/policy revert of the scoped governance change; it
does not require a runtime or data rollback. STOP if the ADR identity, graph
SHA, active v3/M20 authority, owner handoff, rollback owner/window,
accepted-evidence threshold or retirement retention condition is ambiguous or
stale. STOP if any caller attempts to infer authority from merge or status.

## Verification contract

From a clean checkout, run:

1. `python3 scripts/validate-platform-migration-graph.py`;
2. `python3 scripts/validate-platform-migration-policy.py`;
3. `python3 scripts/validate-architecture-contract-closure.py`;
4. `python3 scripts/verify-canonical-release-integrity.py`;
5. `git diff --check` and UTF-8/documentation checks.

The policy validator must report the exact 10-stage ladder, 9 adjacent
transitions, the #1103 graph SHA and an empty error list. Negative verification
uses temporary copies/mutations outside the repository; this ADR changes no
test file and keeps `Test Changes Allowed=No`.

## Documentation and skills impact

The governance README, scripts index and the clean-room
`next-verification-and-parity`, `next-reliability-operations` and
`next-system-design-governance` skills link to the policy. They must preserve
the rule that accepted evidence, not merge/status/progress, advances a stage;
the policy validator is the read-only executable check for this decision.
