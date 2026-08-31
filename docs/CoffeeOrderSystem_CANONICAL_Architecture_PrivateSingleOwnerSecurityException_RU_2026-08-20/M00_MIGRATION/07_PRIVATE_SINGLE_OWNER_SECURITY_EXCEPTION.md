# M00 — Private Single-Owner Security Exception

Decision: [`DEC-PLT-M00-SEC-002`](../../adr/ADR-0015-private-single-owner-security-exception.md)<br>
Predecessor: [`DEC-PLT-M00-SEC-001`](../../adr/ADR-0014-controlled-git-history-sanitation.md)

## Purpose

This document is the narrow M00 overlay for a private, single-owner,
single-developer CoffeeOrderSystem repository. It permits a containment
cleanup ordering exception while provider rotation is deferred; it does not
change the history-sanitation strategy or expose credential evidence.

## Predicate and exact paths

All conditions are required simultaneously:

1. repository visibility is `private`;
2. the owner is the only collaborator and developer;
3. the server and development environment are single-user and not shared;
4. public visibility, additional collaborators, repository transfer/export,
   mirroring and shared deployment are prohibited until rotation;
5. #1086 remains deferred/incomplete and rotation is not claimed.

Only these exact current-tree paths may be removed before provider rotation:

```text
.env.agent
cognee-docker/.env
```

No glob, basename match, renamed path, secret value or additional artifact is
included. `python-agent/venv311` keeps the ADR-0014 order and is outside this
exception. The current-tree files are intentionally not deleted in this
Decision PR.

## Automatic expiry

The exception expires immediately when visibility becomes public, an
additional collaborator/developer/bot/shared access appears, repository
transfer/export/mirroring occurs, deployment becomes shared, scope expands, or
rotation is confirmed. After expiry, ADR-0014's
`rotation-before-current-tree-deletion` rule applies.

This overlay does not authorize #1088. History rewrite, force publication,
provider operation and all destructive approval remain separately gated.
