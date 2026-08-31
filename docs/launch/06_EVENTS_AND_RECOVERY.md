# Events and Recovery

## Launch contracts

| Message | Kind | Producer | Consumer | Key |
|---|---|---|---|---|
| `CatalogSnapshotCompleted` | event | catalog-supplier-sync | catalog-service | supplierRef |
| `CatalogMappingChanged` | event | catalog-service | orders-aroma-preparation | productRef |
| `OrderConfirmed` | event | orders-service | orders-aroma-preparation | orderRef |
| `AromaConvergenceRequested` | command | Orders | aroma-convergence | orderRef |
| `AromaObservationChanged` | event | aroma-observer/convergence | Orders projections | orderRef |
| `AromaConvergenceChanged` | event | aroma-convergence | realtime projection | orderRef |
| `RealtimeInvalidated` | event | owners | realtime-gateway | subjectRef |

Every contract has versioned JSON Schema, `messageId`, `occurredAt`, trace,
causation, correlation and owner-defined aggregate version where applicable.

## Delivery semantics

- business state and Outbox are written in one owner transaction;
- transport is at-least-once;
- consumers validate schema before Inbox/business effects;
- Inbox + current-state guard provides effectively-once business behavior;
- offsets commit only after durable processing;
- out-of-order events cannot roll back newer owner versions.

## Retry policy

- transient safe reads: bounded exponential retry with deadline;
- invalid schema: quarantine/DLQ, no retry loop;
- unsafe AROMA mutation: no transport retry; reconcile from reservation + GET;
- long delay: durable scheduled state, never consumer sleep;
- replay preserves original message and operation IDs.

## Required failure tests

1. duplicate `OrderConfirmed`;
2. crash after DB commit before Kafka offset;
3. stale/out-of-order Catalog mapping;
4. lease expiry during convergence;
5. stale fence trying to persist success;
6. provider accepted mutation but response was lost;
7. failed verification GET;
8. service restart with unfinished MutationReservation;

