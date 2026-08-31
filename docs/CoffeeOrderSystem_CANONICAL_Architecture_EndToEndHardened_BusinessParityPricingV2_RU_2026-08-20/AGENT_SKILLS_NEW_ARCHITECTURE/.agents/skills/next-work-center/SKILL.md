# Skill: next-work-center

## Purpose
Operational read model, deterministic queues and owner-command routing.

## Canonical rules

- Read `BASELINE_LOCK.json` and `REVISION_MANIFEST.yml` first.
- Do not reintroduce behavior marked `INTENTIONAL_CHANGE` or `RETIRE` in `M16_CICD_SUPPLY_CHAIN/characterization-registry.yml`.
- Preserve bounded-context ownership and no cross-owner DB writes.
- Add/modify tests before deleting legacy characterization anchors.
