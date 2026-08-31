---
name: next-invoices-migration
description: "Use for target Invoices ownership, immutable checkout/wholesale materialization, PDF/reconciliation, price application proof, Kafka handoff, and DB5 cutover."
---

# Invoices Migration

## Hard rules

- Normal invoice creation is triggered by `InvoiceMaterializationRequested` from immutable Orders checkout+wholesale proof, **not** simple `OrderConfirmed`.
- Invoices never reads/writes Orders DB and never calls AROMA in normal flow.
- Materialization stable identity = profile + checkoutSnapshotRef + wholesaleSnapshotRef/operationRef.
- Price result returns as event; Orders decides its own lifecycle transition.
- After applied price, generic unlink is locked; use explicit compensation/refund/correction workflows.
- Activate `next-business-orchestration` for cross-service changes.

## End-to-end closure hard rules

- `InvoiceMaterializationRequested` must carry immutable CheckoutAllocationManifest ArtifactRef + SHA-256 + byte size + schema version; refs-only payload is invalid.
- `InvoicePricesApplied` must carry bounded per-order totals/coverage hashes plus immutable full price-proof ArtifactRef.
- PDF is an Artifact Storage object, not DB blob/container file/Kafka payload.
- Compensation uses explicit command/event state machine; original allocations/proofs are append-only.
