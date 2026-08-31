---
name: next-business-orchestration
description: "Use for any new-architecture task that changes how Orders, Catalog, AROMA Gateway, Invoices, Payments, React/Hermes or Kafka call each other, exchange commands/events, own process state, or recover cross-service workflows. M20 is the source of truth."
---

# Business Orchestration and Service Graph

## Source of truth

Read `M20_SERVICE_ORCHESTRATION` plus owning programs before edits.

## Use when

- adding/changing HTTP client between services;
- adding Kafka producer/consumer or command/event;
- moving a worker into its own deployment;
- Orders/AROMA/Invoice/Payment end-to-end flow;
- deciding whether logic belongs to Gateway or business context.

## Hard rules

- Runtime role != bounded context.
- Orders owns Desired/Observed/Convergence/Fulfillment/Checkout even when workers are separate pods.
- AROMA Gateway owns provider transport only and has no Orders DB credential.
- Confirm transaction performs no Catalog/AROMA/Invoices/Payments HTTP.
- No synchronous business cycles `A -> B -> A`.
- Orders↔Invoices and Orders↔Payments state transitions use durable async contracts.
- Catalog Supplier Sync may use AROMA Gateway only for a safe complete-catalog read; mapping resolver uses persisted snapshot and Catalog never mutates cart.
- Convergence may call Gateway synchronously because GET-mutate-GET is one Orders-owned external consistency attempt.
- New cross-service edge requires updating M20 matrix/diagram/tests.

## Stop conditions

Stop if proposed design needs:

- direct cross-owner DB write/read as mutation shortcut;
- Gateway callback into Orders;
- `OrderConfirmed -> create invoice` before checkout/wholesale proof;
- Payments direct status patch in Orders;
- direct React/Hermes/n8n provider mutation;
- splitting Orders AROMA state into another owner just because it has a separate deployment.

## Verification

- architecture dependency graph;
- Kafka ACL/producers/consumers match matrix;
- no new sync cycle;
- failure/replay semantics documented;
- owning program and M20 both updated.

- Orders Draft may read Catalog synchronously for product snapshot/explicit procurement pricing; Orders Confirm may not.
- Orders Convergence may synchronously read Catalog latest-complete-snapshot proof before positive mutation; there is no reverse callback.

## End-to-end closure hard rules

- Validate every consumer group against `runtime-workload-registry.yml`.
- Normal v1 procurement cardinality is Order-atomic.
- Orders→Invoices uses immutable allocation artifact; Invoices→Orders uses price-proof artifact and per-order summary.
- Payment provider inbound webhook and outbound provider calls are separate directed edges.
- Direct BC Outbox→`coffee.realtime.invalidate.v1` is the only realtime invalidation model.
