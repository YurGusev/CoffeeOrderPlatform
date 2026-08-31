# PDF Parse → Validate → Commit workflow

Normal automatic Checkout→Wholesale→Invoice path остаётся primary. Manual path нужен для recovery/operator workflows.

```text
Upload/import PDF
→ ArtifactRef + hash + scan
→ parse worker
→ ParsedInvoiceDraft
→ compare with immutable CheckoutAllocationManifest / selected Orders evidence
→ ValidationResult
→ operator review
→ CommitValidatedInvoice
```

Parse failure не создаёт invoice truth. Commit не может использовать stale parse/validation snapshot.
