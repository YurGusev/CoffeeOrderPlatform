# ADR-0013: Govern the canonical release and document ownership

Decision ID: `DEC-PLT-M00-AUTH-001`<br>
Status: Accepted<br>
Date: 2026-08-20<br>
Program: M00 — Architecture Foundation<br>
Parent capability: [#1076](https://github.com/YurGusev/CoffeeOrderSystem/issues/1076)<br>
Delivery issue: [#1082](https://github.com/YurGusev/CoffeeOrderSystem/issues/1082)<br>
Target migration stage: `Authority` (the Project `Migration Stage` remains unset until accepted linked evidence)<br>
Test Changes Allowed: `No`

## Context

The reviewed EndToEndHardened baseline and the BusinessParityPricingV2 revision
overlay are separate source releases. The repository needs one explicit authority
record before the archive-promotion work in #1070 and the navigation work in #1083
can proceed. Without this record, an agent or generated registry could mistake a
merged view, a superseded document, or cited legacy evidence for the canonical
source.

This decision governs documentation authority only. It does not transfer runtime,
business, database, production-route, or single-writer ownership.

## Decision

### 1. Canonical release identity

The canonical release is the following ordered pair:

1. Locked baseline artifact: `CoffeeOrderSystem_CANONICAL_Architecture_EndToEndHardened_WithAgentSkills_API_RU_2026-08-19.zip`.
2. Revision overlay: the 2026-08-20 `BusinessParityPricingV2` canonical revision overlay.

The locked baseline is identified by SHA-256:

```text
e869535c9c5c0f19d84ff1d2582bd541c4ed1781c44fa5d49836be85235f37f5
```

The repository-owned roots are fixed as:

```text
docs/CoffeeOrderSystem_CANONICAL_Architecture_EndToEndHardened_RU_2026-08-19/
docs/CoffeeOrderSystem_CANONICAL_Architecture_EndToEndHardened_BusinessParityPricingV2_RU_2026-08-20/
```

`BASELINE_LOCK.json` and `REVISION_MANIFEST.yml` in the BusinessParityPricingV2
root are the machine-readable release identity and overlay rules. The overlay
extends the baseline from M00–M20 to the complete M00–M22 program scope, including
`M21_OPERATOR_WORK_CENTER` and `M22_PRICING`.

### 2. Precedence

For any conflict, apply this strict precedence, from highest to lowest:

```text
2026-08-20 revision overlay
  > 2026-08-19 locked baseline
  > approved ADR or GitHub Decision/Issue
  > explicitly cited legacy evidence
```

The overlay is authoritative only for additions, replacements, merges, and
semantic supersessions declared by `REVISION_MANIFEST.yml`. An unlisted baseline
file or rule remains normative and is not silently rewritten by interpretation.

### 3. Documentation ownership and change authority

- M00 Architecture Governance owns canonical documentation authority, release
  identity, precedence, and supersession records.
- Each M00–M22 domain program retains its own business and runtime authority.
  This ADR does not create a second writer for any business schema, event, route,
  database, or production workload.
- Changes to governed authority require a scoped, reviewed pull request targeting
  `next-generation` and an explicit approved Decision, ADR, or issue scope.
- Archive promotion and byte-level publication remain owned by [#1070](https://github.com/YurGusev/CoffeeOrderSystem/issues/1070).
  Canonical navigation and quarantine of superseded guidance remain owned by
  [#1083](https://github.com/YurGusev/CoffeeOrderSystem/issues/1083).

### 4. Immutable source bytes and derived views

- Locked baseline files and revision-overlay source files are preserved byte for
  byte from their reviewed releases.
- A generated merged registry or view is a reproducible derived artifact. It must
  be stored separately from canonical source files and must never overwrite,
  normalize, or silently mutate a locked baseline or overlay source.
- Machine-readable merges are permitted only where the overlay explicitly names
  the baseline, delta, and merge key in `REVISION_MANIFEST.yml`.

### 5. Supersession

Only one of the following can supersede an earlier authority:

1. an explicit `replace`, `merge`, `add`, or `semanticSupersedes` declaration in
   `REVISION_MANIFEST.yml`;
2. an explicit supersession entry in
   `M00_ARCHITECTURE_FOUNDATION/06_ARCHITECTURE_SUPERSESSION_MAP.md`; or
3. a later approved Decision or ADR.

A document is not superseded merely because a generated view exists, a legacy
source is easier to find, or a later issue cites it without an explicit decision.

## Out of scope and non-decisions

This ADR does not:

- copy, promote, rename, normalize, or edit either governed archive;
- update root or section navigation, quarantine legacy documents, or change the
  active skill routing;
- change architecture semantics beyond accepting the already reviewed overlay;
- change runtime code, production routes, writers, databases, migrations,
  business ownership, or Project migration stage;
- close or advance the parent capability or any future Evidence/Cutover issue.

## Rollback and STOP conditions

Rollback is a documentation-only revert of the scoped governance PR. It does not
require a runtime rollback, data migration, route change, or writer transfer.

STOP rather than publishing or deriving authority if any of the following occurs:

- the baseline SHA-256 does not match `BASELINE_LOCK.json`;
- either canonical root is ambiguous or cannot be resolved in a clean checkout;
- M00–M22 coverage is incomplete, including M21 or M22;
- a generated artifact would overwrite a canonical source byte;
- ownership or precedence is ambiguous; or
- an unapproved semantic rewrite is proposed.

## Verification contract

Before archive promotion or navigation changes consume this ADR, verify:

1. `BASELINE_LOCK.json` contains the artifact identity and SHA-256 above;
2. `REVISION_MANIFEST.yml` declares `revision-over-baseline` and resolves its
   referenced overlay and machine-readable delta paths;
3. the baseline contains M00–M20 and the overlay contains M21–M22;
4. the two repository-owned canonical roots are exact and distinct;
5. source files remain byte-identical to the reviewed release inputs and generated
   views are written outside both roots;
6. Markdown links, UTF-8, and diff whitespace are clean for the governed change.

No runtime or production test is required by this Decision; `Test Changes
Allowed=No`, and the change contains no executable behavior.

## Documentation and skills impact

This ADR is the owning Decision record for #1082. The existing platform routers and
`next-*` skills already require the two canonical roots, read the lock/manifest,
and fail closed when a source is missing; no skill rule changes are required by
this acceptance. Archive placement and navigation indexes are intentionally left
to #1070 and #1083 respectively.
