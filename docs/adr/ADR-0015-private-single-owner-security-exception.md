# ADR-0015: Allow a private single-owner current-tree security exception

Decision ID: `DEC-PLT-M00-SEC-002`<br>
Status: Historical; expired and superseded for current acceptance by `DEC-PLT-M00-SEC-003`<br>
Date: 2026-08-20<br>
Program: M00 — Architecture Foundation<br>
Parent capability: [#1077](https://github.com/YurGusev/CoffeeOrderSystem/issues/1077)<br>
Decision issue: [#1172](https://github.com/YurGusev/CoffeeOrderSystem/issues/1172)<br>
Predecessor decision: [`DEC-PLT-M00-SEC-001`](ADR-0014-controlled-git-history-sanitation.md)<br>
Target migration stage: `Authority`<br>
Test Changes Allowed: `No`

This record is retained for provenance only. Issue #1172 and this decision do
not authorize current acceptance, credential disposition, or history rewrite.

## Context

ADR-0014 establishes the safe default: provider-side credential rotation must
precede current-tree cleanup, followed by a separately approved controlled
history rewrite. The owner has requested a narrowly scoped containment option
for this repository while provider rotation remains deferred. The exception is
acceptable only while the repository, development access and server remain
private and single-owner.

This ADR is a later canonical revision, not a replacement for ADR-0014. It
must not be read as evidence that a credential was revoked, rotated or removed
from history.

## Decision

### 1. Revision-chain authority

The canonical chain is:

```text
EndToEndHardened baseline
  → BusinessParityPricingV2
  → PrivateSingleOwnerSecurityException
```

The sibling root
`docs/CoffeeOrderSystem_CANONICAL_Architecture_PrivateSingleOwnerSecurityException_RU_2026-08-20/`
is the machine-verifiable third chain member. Its version-2
`REVISION_MANIFEST.yml` explicitly supersedes only the current-tree deletion
ordering for the two exact paths below. All unlisted baseline and
BusinessParityPricingV2 rules remain normative. Existing canonical roots and
the hardening evidence root remain byte-identical.

### 2. Exact current-tree exception

Before provider rotation, current-tree deletion is permitted only for these
exact paths:

```text
.env.agent
cognee-docker/.env
```

The exception is valid only while every condition below remains true:

- repository visibility is `private`;
- the owner is the only collaborator and developer;
- the server and development environment are single-user and not shared;
- repository transfer and export are prohibited until rotation completes;
- no public or shared deployment is used;
- provider rotation remains deferred/incomplete under #1086.

This ADR does not authorize deletion in this Decision PR. It authorizes only
the later exact-path ordering decision if the owner performs #1087 under the
predicate. `python-agent/venv311` remains under ADR-0014 and is not part of
this exception.

### 3. Automatic expiry and prohibitions

The exception expires immediately, without amendment, if any of these occurs:

- visibility becomes public or otherwise ceases to be confirmed private;
- an additional collaborator, developer, bot or shared access appears;
- repository transfer, export, mirroring or shared deployment occurs;
- either exact path is renamed or the scope is expanded;
- provider rotation is confirmed, after which the normal post-rotation
  sanitation workflow applies.

After expiry, the rotation-before-current-tree-deletion rule in ADR-0014
applies again. This ADR prohibits public visibility, additional collaborators,
transfer/export and shared deployment until rotation. It does not claim #1086
complete and does not grant #1088 permission: #1088 remains a separate,
explicit destructive-approval gate.

### 4. Ownership and immutable source bytes

M00 Architecture Governance owns this documentation revision. Provider
operations remain owned by #1086; current-tree cleanup remains a separately
scoped #1087 operation; controlled history rewrite remains separately gated by
#1088. No provider API, repository visibility, collaborator, deployment,
history or secret state is changed by this ADR.

The baseline, BusinessParityPricingV2 overlay and hardening roots are not
edited, normalized or regenerated. The new root's lock, manifest and checksum
inventory are generated from its final bytes only.

### 5. Current-tree implementation actualization (#1087)

Issue #1087 applies this exception to the current tree and removes only the
two exact paths `.env.agent` and `cognee-docker/.env`. It preserves
`python-agent/venv311` as history-rewrite scope, `bin/docker-compose`, business
XLSX/PDF artifacts and all canonical release roots. The implementation adds a
redaction-safe current-tree scanner and regression matrix; scanner output is
limited to `detector`, `path` and `count`, with unsafe path characters
percent-encoded, and makes no full-history claim.

`#1086` remains deferred/incomplete and `#1088` remains separately gated.
Test Changes Allowed: Regression tests only.

## Out of scope and non-decisions

This ADR does not:

- read, print, publish or rotate a secret;
- mark #1086 complete or imply credential revocation;
- delete `.env.agent` or `cognee-docker/.env` in this PR;
- change the exact #1088 rewrite/force-push approval gate;
- authorize history rewriting, force-pushing, visibility changes,
  collaborators, transfer/export or shared deployment;
- add any path beyond the two exact current-tree paths;
- change `python-agent/venv311` ordering or any business/runtime authority.

## Rollback and STOP conditions

Rollback is removal of this later overlay and its navigation/control entries
before #1087 acts. STOP if an earlier canonical byte changes, the private
single-owner predicate cannot be evidenced, a new path is proposed, a secret
value could enter evidence, #1086 is represented as complete, or this ADR is
used as approval for #1088.

## Verification contract

Run from a clean checkout:

1. `python3 scripts/verify-canonical-release-integrity.py`;
2. compare previous-root file counts/tree digests with the locked control;
3. validate manifest version 2, exact paths, parent chain and expiry rules;
4. run `git diff --check`, UTF-8/mojibake checks and strict MkDocs when
   available.

No runtime or provider test is required; `Test Changes Allowed=No` and this
Decision changes only documentation authority and integrity controls.

## Documentation and skills impact

The canonical authority indexes, MkDocs navigation, root `CHANGELOG.md`,
`.gitattributes`, the canonical integrity control/verifier and
`next-repository-hygiene` are updated to expose and enforce this revision.
