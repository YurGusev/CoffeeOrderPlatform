# Extended end-to-end traceability matrix

| Step | Producer/runtime | Contract | Consumer | Truth/proof | Failure/recovery |
|---|---|---|---|---|---|
| Supplier price/discount | catalog-supplier-sync/Catalog | `coffee.catalog.pricing.v1` | pricing-projection | Catalog supplier fact + snapshot | replay projection |
| Product current price | Pricing | `coffee.pricing.lifecycle.v1` | Orders projection/clients | ProductPriceProjection + hash | stale Draft / reprice |
| Draft quote | Orders→Pricing | internal HTTP | pricing-api | PricingQuote | no save on failure |
| Confirm price lock | Orders | local tx | Orders | OrderPriceManifest | 409 stale |
| Excel parse | Orders Outbox | import command | order-import-worker | ImportJob/PreviewFingerprint | retry idempotent |
| Customer ambiguity | Customer resolver | ReviewTask/read model | Work Center/operator | evidence + candidate set | manual confirm/reject |
| AROMA convergence | Orders | existing cart command | aroma-convergence | Desired/Observed/Attempt | fresh GET/UnknownOutcome |
| Invoice manual | invoice-intake | artifact/fingerprint | Invoices operator workflow | validation/allocation proof | stale reject/retry |
| Actual supplier cost | Invoices | procurement-cost event | Pricing | immutable actual goods total | replay idempotent |
| Actual delivery | Operator→Pricing | client API | pricing-api | delivery cost entry | version conflict/review |
| Next coefficient | Pricing | pricing lifecycle | product projection/Orders | DeliveryCoefficientVersion | rollback to prior active version |
| Work Center | domain events | existing+new Kafka | work-center-projection | own read model | source coverage status |
| VK voice | channel-ingress | ArtifactRef | media/transcription worker | scanned artifact/transcript | quarantine/retry |
