# ADR-0017: Supplier-owned AROMA credential exception

Status: Accepted<br>
Date: 2026-08-28<br>
Decision ID: `DEC-PLT-M00-SEC-003`

## Context

The AROMA provider/manufacturer owns the login and password used by the
integration. The repository owner cannot change those values. The historical
private-single-owner exception from #1172 / ADR-0015 expired when the access
predicate changed; it is historical and is not revived by this decision.

## Decision

Add the v4 canonical revision
`CoffeeOrderSystem_CANONICAL_Architecture_SupplierOwnedCredentialException_RU_2026-08-28`.
It is an additive child of the exact `ArchitectureContractClosure` tree and
extends the canonical chain only for this bounded class:

```text
baseline → BusinessParityPricingV2 → PrivateSingleOwnerSecurityException
         → ArchitectureContractClosure → SupplierOwnedCredentialException
```

The exception covers only supplier/manufacturer-owned AROMA login/password
explicit server-side aliases (`AROMA_AUTH_EMAIL`, `AROMA_AUTH_PASSWORD`, their
profile forms, and the documented AROMA configuration aliases). Their status
is `governed-external-owner-exception`; handling is
external-owner-controlled, rotation and revocation are supplier-owner-only,
and repository-owner cleanup is prohibited while external ownership holds.
The repository owner must not mutate these credentials while that ownership
holds. Values, hashes and raw logs are prohibited in source, evidence, logs
and release artifacts. The exception must be revalidated no later than
`2026-11-28`, even if the external-owner predicate has not otherwise drifted.
The canonical integrity gate remains deterministic and validates the declared
date exactly; operational acceptance must compare that date with current time
and require new revalidation evidence after it expires.

It does not cover sessions/cookies, Gitea/CI/API, database, VK, payment,
AI/model-provider, JWT/signing or any other repository-owned credentials. Those
classes retain the #1086 completion requirements.

Operational compatibility has an exact allowlist: owner `YurGusev` and the
`project4-migrator` collaborator with `write`, `admin=false`, a protected
mode-0600 token source, no review/approval/self-approval authority and no
production credential access. Any other identity, collaborator, bot or admin
fails closed. This policy does not authorize history rewrite or production
cutover/deploy, and it does not permit mutation of supplier-owned credentials
by the repository owner.

Expiry and review triggers include visibility/access drift, collaborator
permission or token protection drift, ownership/alias/scope changes,
production/shared deployment, history rewrite/transfer/export/mirror requests,
the review date, and changes to the #1086 acceptance boundary.

This revision supersedes only the #1086 completion requirement for the
supplier-owned AROMA login/password class under the exact allowlist predicate;
it does not supersede any other #1086 class, repository security revalidation
#1077, or approval gate.

Acceptance evidence is secret-free and limited to an accepted
`repository-owner-scope-decision` plus
`supplier-ownership: external-owner-confirmed`. It records the ownership
boundary and does not claim that the provider rotated the credential.

## Consequences

The supplier credential remains an explicit, reviewable exception instead of
an implied rotation claim. Security revalidation can close the applicable
credential class without weakening unrelated credential, history, or
production controls. Current-tree hygiene remains separate from history proof.

## Verification

The machine-readable authority is
`docs/CoffeeOrderSystem_CANONICAL_Architecture_SupplierOwnedCredentialException_RU_2026-08-28/SECURITY_EXCEPTION.json`.
Run:

```bash
python3 scripts/verify-canonical-release-integrity.py
python3 scripts/test-canonical-release-integrity.py
```
