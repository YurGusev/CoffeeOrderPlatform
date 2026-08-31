# Order Forms and Excel exports

Large export — async Job:

```text
CreateExportJob
→ snapshot query plan
→ order-export-worker
→ generate XLSX/PDF
→ Artifact Storage
→ signed/authorized download ref
```

Server-side limits: date range, rows, orders, items, output size. Timezone/business-date semantics фиксированы в job snapshot. Artifact имеет retention and audit metadata.
