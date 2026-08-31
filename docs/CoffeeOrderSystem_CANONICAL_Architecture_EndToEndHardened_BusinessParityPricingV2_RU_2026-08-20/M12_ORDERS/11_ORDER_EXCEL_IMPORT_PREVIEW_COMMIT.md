# Order Excel Import — Preview / Review / Commit

## Async parse

```text
POST import artifact
→ Artifact Storage quarantine/scan
→ ImportJob + Outbox
→ order-import-worker
→ parse
→ Customer resolver
→ OrderImportProductMatcher(Catalog)
→ strict validation
→ PreviewPlan
```

Preview содержит rows, warnings, unresolved customer/product choices, proposed pricing quotes и deterministic `previewFingerprint`.

## Operator overrides

Manual customer/product selection и force-create являются отдельными versioned overrides. Они входят в новый fingerprint.

## Commit

Commit принимает `ImportJobRef`, `previewFingerprint`, `expectedRevision`. Если preview stale — reject. Commit создаёт Draft Orders атомарно по выбранной commit scope; partial hidden insert запрещён.

Тяжёлый XLSX parsing не выполняется в API event loop.

## Artifact gate

`order-import-worker` начинает parse только при `ArtifactScanStatus=Clean`; Pending/Quarantined/Infected блокируют job.
