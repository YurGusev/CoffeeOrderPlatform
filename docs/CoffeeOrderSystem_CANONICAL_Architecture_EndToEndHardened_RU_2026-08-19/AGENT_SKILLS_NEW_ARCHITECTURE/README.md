# Agent Skills — EndToEndHardened target architecture

В пакете **26 target-only `next-*` skills**. Legacy C# skills являются только behavior/reference evidence.

## Router

`next-architecture-router` выбирает owning program skill и cross-cutting contracts. Для Orders/Catalog/AROMA/Invoices/Payments включается `next-business-orchestration`; Node roles также включают `next-nodejs-runtime`; Kafka contracts — `next-kafka-event-platform`.

## New hardening

Skills синхронизированы с:

- trusted AI/VK confirmation proof;
- Order-atomic procurement + `addConfirmedItem`;
- immutable invoice/artifact manifests;
- refund/compensation;
- runtime workload registry;
- exact OpenAPI prefixes;
- 100% Kafka payload schemas/partitions;
- Catalog source separation/override epoch;
- AROMA MutationReservation;
- privacy/SLO release gates.
