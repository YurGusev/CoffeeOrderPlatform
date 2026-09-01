# ADR-0018: M04 Node runtime and physical API composition roots

Decision ID: `ADR-PLT-M04-RUNTIME-001`
Status: `Accepted`
Acceptance: `accepted-independent-review`
Date: `2026-08-29`
Program: `M04 TypeScript Platform Foundation`
Parent issue: `#1196`
Decision issue: `#1203`
Contract ID: `decision-v1`
Target migration stage: `Authority`
Requirements: `REQ-PLT-M04-001`, `M410`
Approver: `Codex root orchestrator (independent non-author reviewer)`
Companion schema: `platform-runtime-foundation-decision-v1` (version 1)
Companion SHA-256: `42e9802d75d9ee3f42bcc541707541bc47afe9d6425fca184ee009f7c831d5f3`
Canonical release: `Baseline 2026-08-19 + BusinessParityPricingV2 2026-08-20 + PrivateOwnerSecurity 2026-08-20 + ArchitectureContractClosure 2026-08-22 + SupplierOwnedCredentialException 2026-08-28 (v4)`

## Context

M04 already defines a TypeScript/Node.js target, but the repository needs one
machine-checkable decision to bind the foundation toolchain, production runtime
authority, framework/process model, physical API trust roots, and the narrow
filesystem transition needed by the next M04 delivery. This decision is
specification and repository-governance evidence only. It does not implement a
runtime, authorize production, or replace the M00/M04/M15/M19/M20 authorities.

The accepted foundation/CI toolchain is Node.js `26.8.1` (`lts=false`), npm `11.19.0`,
standalone Corepack `0.35.0`, and pnpm `11.22.0`. That identity is
not a production-runtime decision. Production Node workloads remain on Node.js
24 LTS and need workload-specific evidence before any runtime authority can
change.

The normalized authority fields bound by the companion are:

```text
Foundation Node.js: `26.8.1` (`lts=false`)
Foundation npm: `11.19.0`
Foundation Corepack: `0.35.0`
Foundation pnpm: `11.22.0`
Production Node line: `Node.js 24 LTS`
Production exact patch per workload: `required`
Production glibc image digest per workload: `required`
Node 26 production authority: `separate-upgrade-adr-and-workload-evidence-required`
```

The M19 authority has exactly three API audiences. They must be separate
physical composition roots so a public-edge routing mistake cannot expose a
private route inventory, service identity, or secret set. The current
schema-v3 target layout records all three matching deployable roles as planned
and `implemented=false`, and the three paths are absent. This issue leaves that
pre-transition state unchanged; #1204 is the only consumer of the exact
structural-placeholder transition below.

## Decision

### 1. Separate foundation and production runtime authorities

The machine-readable companion at
[`platform/runtime-foundation-decision.json`](../../platform/runtime-foundation-decision.json)
is the repository-owned contract for this decision. Its dependency-free
validator is
[`validate-platform-runtime-foundation-decision.py`](../../scripts/validate-platform-runtime-foundation-decision.py).
The validator checks this ADR's normalized decision metadata, companion hash,
toolchain split, framework/process policy, trust roots, M20 bindings, and the
two complete layout states.

Foundation and isolated CI use exactly:

| Tool | Identity | Authority |
|---|---|---|
| Node.js | `26.8.1` (`lts=false`) | foundation and isolated CI only |
| npm | `11.19.0` | foundation and isolated CI only |
| Corepack | standalone `0.35.0` | foundation and isolated CI only |
| pnpm | `11.22.0` | foundation and isolated CI only |

Production Node workloads remain on **Node.js 24 LTS**. Every production
workload Delivery must pin a currently supported exact Node 24 patch and a
glibc image digest, then provide native-dependency, memory-limit, runtime
metrics, and SIGTERM evidence. Node 26 production use requires a separate
explicit upgrade ADR and workload evidence; this foundation decision cannot be
cited as production authority. Floating runtime identities such as `node:24`,
`node:26`, `node:lts`, `node:current`, `node:latest`, `current`, and `latest`
are forbidden for accepted runtime images.

### 2. Framework and process model

The baseline is **Fastify-first**, with project-owned modules/use cases and
explicit composition roots. NestJS is not part of the foundation: a later use
of NestJS requires a separate ADR proving a missing capability and its
operational cost. Strict TypeScript, `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`, runtime boundary schemas, typed fixed-origin
clients, `AbortSignal`/deadline propagation, bounded pools/concurrency, and
fail-fast handling of fatal unknown process state remain mandatory.

One Node process represents one container/pod role. PM2 cluster, `node:cluster`,
mixed unrelated application roles in one normal target container, and a generic
`platform-api` process are rejected. Horizontal scale is expressed as
container/pod replicas after workload-specific capacity and failure evidence.

### 3. Three physical trust roots

The exact roots and route surfaces are:

| Composition root | Allowed canonical surface | Public edge |
|---|---|---|
| `platform/apps/api-public` | `/api/client-v1/**` only | eligible only after a separate edge/cutover gate |
| `platform/apps/api-agent` | `/api/agent-v1/**` only | forbidden; private |
| `platform/apps/api-internal` | `/api/internal-v1/**` only | forbidden; private |

These are three physical processes/roles, not aliases in one generic process.
They do not share route inventories, secrets, network exposure, or service
identities. Common public application contracts may be consumed later, while
private-root internals remain private. Suffix-only aliases such as
`/client-v1/**`, `/agent-v1/**`, or `/internal-v1/**` are not canonical.

### 4. Exact schema-v3 transition for #1204

The transition keeps `platform/target-layout.json` at `schemaVersion=3` and is
atomic with creation of all three directories. #1203 itself changes neither
`target-layout.json` nor the filesystem. #1204 may move the repository from
the complete **pre-transition** state to the complete **post-transition** state
only as one change:

1. Add exactly `platform/apps/api-public`,
   `platform/apps/api-agent`, and `platform/apps/api-internal` to
   `structuralSubtrees`, each with
   `classification=planned-structural-path`, `state=present`, and
   `implemented=false`.
2. Create exactly those three physical directories together.
3. Keep the `runtimeRoles` parent at
   `classification=deployable-runtime-role`, `state=planned`,
   `implemented=false`.
4. Keep each matching runtime-role item `implemented=false` and preserve its
   canonical M20 owner, path, and `productionCritical` value.
5. Change no other structural subtree, module, package, integration, collision,
   or runtime-role item.

The three `present` structural entries are compile-only composition-root
scaffolds, using the existing `hermes/runtime` overlap precedent. They do not
claim an HTTP listener, deployable image, readiness, production authority, or
completed workload. Any partial/mixed filesystem or manifest state is invalid.
Any future `implemented=true` transition requires a new accepted superseding
Decision and workload Evidence.

The validator recognizes exactly these states:

- `pre-transition`: all three structural entries and directories are absent;
  the matching roles remain planned and `implemented=false`.
- `post-transition`: all three structural entries and directories are present
  together, with the exact structural and M20 role values above; every matching
  role remains `implemented=false`.

## Rationale

The foundation toolchain can use the already accepted Node 26 reproducibility
evidence without silently promoting a non-LTS line to production. Fastify and
project-owned composition preserve the target's existing module boundaries
without introducing a second dependency-injection model. Physical roots enforce
the M19 audience boundary even when edge configuration is wrong. Structural
placeholders let #1204 establish compile-time ownership without confusing a
directory with a deployable workload or production evidence.

## Alternatives

1. Keep only prose in canonical M04. Rejected because prose cannot machine-bind
   the active Node split or the future filesystem transition.
2. Fastify-first with project-owned modules and three roots. Proposed because it
   matches M04/M19 and minimizes a second framework model.
3. NestJS as the foundation. Rejected unless a later ADR proves a missing
   capability and operational benefit.
4. One generic API process with logical route prefixes. Rejected because an edge
   mistake could expose private route inventories and secrets.
5. Promote Node 26.8.1 directly to production. Rejected because the accepted
   release is non-LTS and lacks per-workload image, native, and runtime evidence.
6. Set the three runtime roles `implemented=true` when directories appear.
   Rejected because compile-only composition roots are not deployable runtime
   implementations.
7. Use schema-v3 structural placeholders while runtime roles remain planned and
   false. Proposed because it matches the `hermes/runtime` precedent and gives
   #1204 a narrow reversible transition.

## Consequences

The repository has one explicit, testable authority split and a fail-closed
contract for the only layout transition authorized by this decision. #1204 can
create compile-only roots without creating a runtime or weakening M20 role
ownership. Production image selection, Node 24 patch/digest, capacity budgets,
native compatibility, deployment, edge exposure, and workload implementation
remain separately gated. The validator intentionally duplicates only the
minimum decision contract and canonical M20 identity needed to fail closed; it
does not become a second canonical architecture root.

## Independent acceptance

The Codex root orchestrator independently reviewed the artifacts authored by
the delegated `luna_worker` against issue #1203, the active v4 canonical
chain, M04/M15 Node authority, the v3 M19 route authority, and the materialized
M20 runtime-role registry. The reviewer accepted the alternatives,
consequences, exact three-root schema-v3 transition, Node 26 foundation/CI
versus Node 24 LTS production split, compatibility, rollback, and STOP
conditions after reproducing the decision, target-layout, canonical-integrity,
routing, workspace-CI, and exact Node/Corepack/pnpm verification profiles. The
reviewer did not author the ADR, companion, validator, tests, or CI changes.

## Compatibility

This decision is compatible with M00 language/runtime ownership, M04 Node
runtime architecture, M15 Node SLO/capacity, M19 API route authority, and the
materialized v3 M20 runtime registry. It preserves the accepted Node 26
foundation/CI identity and the Node 24 LTS production baseline. It adds no
package, runtime, route, image, database, Kafka, provider, Docker, deployment,
or legacy dependency. It leaves canonical and accepted evidence roots
byte-identical.

## Rollout

Rollout changes repository decision authority only. The integration line is
GitHub `develop`; this issue's change is one documentation and
contract PR linked to #1203. The ADR index, companion, dependency-free
validator, focused negative/state-transition tests, CI invocation, and active
platform documentation are updated together. #1196, #1204, and #1205 are
related issues and are not closed by this decision. #1204 remains blocked until
independent acceptance of this ADR and companion.

## Rollback

Before #1204 consumes this decision, rollback is one revert removing the ADR
index entry, companion, validator/tests, CI integration, and directly related
active-doc changes; no runtime or data rollback is needed. After #1204 or a
later delivery consumes it, stop rollout and revert or supersede downstream
deliveries in reverse dependency order, restore a complete accepted layout
state, and only then revert or supersede this decision. Reverting ADR-0018 alone
while a dependent delivery remains is forbidden.

## STOP conditions

STOP when an accepted M00/M16/M19 source is missing, stale, or unreproducible;
independent approval is absent; a new framework, broker, cache, database
technology, public private-surface exposure, or production Node 26 authority
is requested; roots or `/api` prefixes are mixed or incomplete; the layout
transition is partial or unrelated; a runtime role becomes `implemented=true`
without a new accepted superseding Decision and workload Evidence; scope reaches
target-layout, planned API directories, runtime dependencies,
Docker/deployment, production operations, legacy code, or immutable canonical/
evidence artifacts; or legacy Project parent, membership, mapping, or parity is
ambiguous.

## Verification

From a fresh full-history checkout, run the dependency-free decision validator
and focused negative tests, followed by target-layout and workspace-CI checks.
Then run the canonical integrity/routing checks and the platform foundation
preflight where the exact Node/Corepack/pnpm identities are available. The
validator and tests must prove the current repository is in complete
pre-transition state and that mutations for every listed negative case fail
closed. No check in this ADR authorizes a listener, deployment, data write,
provider operation, route cutover, or production promotion.

Required commands are:

```text
python3 scripts/validate-platform-runtime-foundation-decision.py
python3 scripts/test-platform-runtime-foundation-decision.py
python3 scripts/validate-platform-target-layout.py
python3 scripts/test-platform-target-layout.py
python3 scripts/test-platform-workspace-ci.py
python3 scripts/validate-platform-issue-contracts.py
python3 scripts/generate-architecture-closure-openapi.py --check
python3 scripts/validate-architecture-contract-closure.py
python3 scripts/verify-canonical-release-integrity.py
python3 scripts/test-canonical-release-integrity.py
python3 scripts/test-platform-agent-routing.py
gh repo view YurGusev/CoffeeOrderPlatform
python3 scripts/check-skill-catalog.py
```

Independent non-author review is recorded above. Merge, issue status, Project
status, and successful CI alone are not decision acceptance evidence.
