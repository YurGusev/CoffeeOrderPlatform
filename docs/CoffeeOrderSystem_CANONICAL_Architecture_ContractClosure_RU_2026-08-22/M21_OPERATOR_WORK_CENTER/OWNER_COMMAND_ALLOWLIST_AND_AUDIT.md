# M21 contract closure — typed owner commands and audit

`owner-command-matrix.json` is the closed M21 allowlist. It describes
operator-facing command authority; it does not add runtime routes, grant a
capability, execute a command, or authorize deployment/cutover.

Work Center owns queue/read-model metadata only. It never writes Orders,
Customer, Catalog, AROMA, Invoices, Payments or Pricing business state. Every
accepted action therefore names exactly one owner route and one owning bounded
context:

| Command ID | operationId | Owner route | Bounded context | Capability |
| --- | --- | --- | --- | --- |
| `reprice-draft` | `repriceDraftOrder` | `POST /api/client-v1/orders/{orderRef}/commands/reprice` | Orders | `orders.reprice-draft` |
| `resolve-customer-duplicate-link` | `customerMerge` | `POST /api/client-v1/customers/{ref}/merge` | Customer | `customer.customer-merge` |
| `request-catalog-remap` | `requestCatalogRemap` | `POST /api/client-v1/catalog/mappings/{mappingRef}/commands/remap` | Catalog | `catalog.remap` |
| `trigger-aroma-fresh-reconciliation` | `requestOrderAromaReconciliation` | `POST /api/client-v1/orders/{orderRef}/commands/request-aroma-reconciliation` | Orders | `orders.reconcile-aroma` |
| `save-manual-invoice-allocation` | `invoiceAllocations` | `POST /api/client-v1/invoices/{ref}/allocations` | Invoices | `invoices.invoice-allocations` |
| `retry-invoice-price-application` | `invoiceApplyPrices` | `POST /api/client-v1/invoices/{ref}/apply-prices` | Invoices | `invoices.invoice-apply-prices` |
| `payment-reconciliation-refund` | `refundPayment` | `POST /api/client-v1/payments/{paymentIntentRef}/commands/refund` | Payments | `payments.refund` |
| `review-activate-delivery-coefficient` | `pricingDeliveryCostActivate` | `POST /api/client-v1/pricing/procurement-batches/{batchRef}/delivery-cost/activate` | Pricing | `pricing.pricing-delivery-cost-activate` |

The routes above are the owner routes represented by the M19 closure route
authority. The existing M21 evidence supplies the closed command IDs; no
additional repair action is accepted.

## Required command metadata

Each action is rejected unless the server derives the actor from the
authenticated `client-v1` operator principal and checks the named capability.
The browser cannot choose or override the actor. The command must include a
non-empty reason, the owner’s expected version or owner-issued fingerprint,
and the `Idempotency-Key` header. `correlationId` and `causationId` are
required in the server command/envelope context, and `workCenterItemRef`
links the owner audit to the projected queue item.

The owning context performs the stale check before any business write. A
stale version/fingerprint is a rejection, not a Work Center repair. The
owner records an audit event and writes the corresponding outbox record in
the owner transaction. The matrix deliberately calls an audit event
“owner-defined command audit event”: M06 fixes the envelope/outbox semantics,
while the exact business event types remain owned by the bounded context.

Queue `Acknowledged`, `Snoozed` and `Resolved` values remain projection
metadata. A queue item is business-resolved only after Work Center consumes
the `authoritativeCompletionFact` recorded for the action. In particular,
AROMA and payment timeout/unknown-outcome states require a fresh owner or
provider read; they never receive a blind retry.

## Explicit denials

The following are deny rules, not routes to implement:

- any generic `POST /api/client-v1/work-center/**` repair endpoint or generic
  `repairWorkCenterItem` operation;
- any universal `PATCH /api/client-v1/{business-resource}/**` or
  `updateBusinessState` operation;
- any direct SQL/ORM business-state write through `work-center-db`;
- acknowledging, snoozing or resolving a queue item as business completion
  without the owner fact.

These denials preserve the M21 rule that Work Center is a read model and that
business writes go through explicit owner commands. They also preserve the
M19 rule against generic lifecycle PATCH and the M06 rule that side effects
use owner transactions/outbox and idempotent command envelopes.

## Evidence and verification

The eight IDs and their typed-owner requirement are derived from
`platform/evidence/contracts/work-center/typed-command-contract.yml` and the
M21 characterization cases `M21-REPAIR-01` through `M21-REPAIR-08`. Completion
facts point to existing M06 payload schemas or the existing M10/M22 owner
facts; no new message type is introduced here.

Run the local, directory-scoped acceptance check:

```bash
python3 docs/CoffeeOrderSystem_CANONICAL_Architecture_ContractClosure_RU_2026-08-22/M21_OPERATOR_WORK_CENTER/test_owner_command_matrix.py
```

The check accepts the complete matrix and rejects missing actor/reason/stale
guard/idempotency/trace/audit/completion/rollback metadata, an unknown action,
generic repair/PATCH mutation, and Work Center business ownership.
