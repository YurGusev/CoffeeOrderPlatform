# M16. Semantic Architecture Validation

Syntax validation alone is insufficient. CI runs `semantic-architecture-validator.py` and blocks merge/deploy on cross-document drift.

Validator enforces at least:

1. every canonical Kafka topic has explicit positive production partition count;
2. every topic has message-specific payload schema(s);
3. every MessageType schema is registered and has a validating positive fixture;
4. every durable consumer group maps to exactly one runtime role;
5. every `productionCritical` runtime role exists in Compose reference topology;
6. runtime registry has owner/DB/permissions/concurrency/drain/network/SLO fields;
7. domain topics do not implement a second realtime fanout model;
8. separate/deferred Catalog indexing topics do not reappear;
9. BIGINT/UInt64 versions/revisions/sequences/epochs do not use unsafe unbounded JSON integers;
10. exact OpenAPI prefixes remain `/api/client-v1`, `/api/agent-v1`, `/api/internal-v1`;
11. required `AddConfirmedOrderItem` and Channel Identity routes exist;
12. Checkout→Invoice and Invoice→Orders schemas remain self-contained via immutable manifests;
13. PSP outbound and provider-webhook inbound edges are separate;
14. allowed synchronous service graph has no cycle.

`PASS` means **specification-level structural/semantic consistency**, not production certification. M15 load/DR/provider/chaos evidence remains a separate release gate.
