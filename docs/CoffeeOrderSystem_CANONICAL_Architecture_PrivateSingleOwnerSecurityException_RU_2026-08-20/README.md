# Canonical revision — Private Single-Owner Security Exception

**Date:** 2026-08-20<br>
**Decision:** [`DEC-PLT-M00-SEC-002`](../adr/ADR-0015-private-single-owner-security-exception.md)<br>
**Parent revision:** [BusinessParityPricingV2](../CoffeeOrderSystem_CANONICAL_Architecture_EndToEndHardened_BusinessParityPricingV2_RU_2026-08-20/README.md)<br>
**Baseline:** [EndToEndHardened](../CoffeeOrderSystem_CANONICAL_Architecture_EndToEndHardened_RU_2026-08-19/README.md)

This is a later, narrow canonical revision overlay. The chain is:

```text
EndToEndHardened baseline
  → BusinessParityPricingV2
  → PrivateSingleOwnerSecurityException
```

The overlay supersedes only the ordering rule for current-tree deletion of the
two exact paths below. Unlisted baseline and parent rules remain authoritative.

## Exact exception

Before provider rotation, current-tree deletion is allowed only for:

```text
.env.agent
cognee-docker/.env
```

The exception is valid only while all of these remain true:

- repository visibility is private;
- the owner is the only collaborator and developer;
- the server and development environment are single-user and not shared;
- public visibility, additional collaborators, transfer/export and shared
  deployment are prohibited until rotation;
- #1086 remains deferred/incomplete, with no claim of credential revocation.

The exception expires automatically on public visibility, collaborator or
shared-access drift, repository transfer/export/mirroring, shared deployment,
path-scope expansion, or confirmed rotation. After expiry ADR-0014's
rotation-before-current-tree-deletion rule applies again. #1088 remains a
separate destructive-approval gate.

This Decision PR does not delete either current-tree file and does not read or
publish secret values. `python-agent/venv311` remains outside this exception.

## Machine-readable release controls

- [`PREVIOUS_RELEASE_LOCK.json`](PREVIOUS_RELEASE_LOCK.json) binds the baseline,
  parent overlay and revision chain;
- [`REVISION_MANIFEST.yml`](REVISION_MANIFEST.yml) is the version-2 semantic
  overlay manifest; it intentionally has no dummy merge entries;
- [`SHA256SUMS.txt`](SHA256SUMS.txt) covers the final bytes of this root.

Verify the canonical release from the repository root:

```bash
python3 scripts/verify-canonical-release-integrity.py
```
