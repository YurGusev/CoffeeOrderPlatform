# M19 contract closure — absolute route authority

The only canonical HTTP prefixes are:

```text
/api/client-v1
/api/agent-v1
/api/internal-v1
```

PricingV2 examples that begin with `/client-v1` or `/internal-v1` are superseded
by the corresponding absolute route in the normative `api-contract.json`. They
are not compatibility aliases and must never be mounted or generated as a
second surface.

`api-contract.json` is the sole normative M19 registry. It classifies each
operation by actor/trust surface, bounded-context owner, capability, stale
guard, idempotency and rollback. `api-route-contracts.json` is a deterministic
compatibility projection consumed by the closure semantic verifier; it is not a
second hand-maintained authority. The three `openapi/*.json` files are
reproducible generated views and must match the same registry byte-for-byte
through the repository generator check.

The pre-closure recovered draft remains preserved in Git history (`e73f4e16`)
for recovery traceability and is not active authority.

Browser/operator commands use session authorization and CSRF for unsafe
methods. Actor identity is server-derived. Internal routes require a dedicated
service identity and audience. Agent routes remain a separately allowlisted
Hermes surface. Public edge exposure is permitted only for `client-v1`.

No runtime or Nginx route changes are authorized by this document.
