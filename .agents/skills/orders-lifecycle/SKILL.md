---
name: orders-lifecycle
description: Реализовывать или проверять lifecycle Orders, versioning, snapshots, confirmation, Desired/Observed корзины, checkout handoffs и защищённые команды CoffeeOrderPlatform.
---

# Жизненный цикл Orders

Lifecycle: `Draft -> Confirmed -> AwaitingCustomerPayment -> Completed` и
защищённый `Cancelled`. AROMA, fulfillment, checkout, invoice и payment —
ортогональные состояния процессов.

- Draft hard delete is allowed; confirmed records use commands/compensation.
- Confirm validates persisted snapshots locally and atomically writes status,
  version, history, Desired, and Outbox.
- Confirm makes no Catalog, Pricing, AROMA, Invoice, or Payment network call.
- Orders owns Desired, Observed, Convergence, Attempt, Lease, Fence,
  UnknownOutcome, fulfillment, and checkout proof.
- Physical truth requires fresh successful observation.
- Post-confirm changes require commands and expected version.

Проверять transitions, idempotency, concurrency, snapshots, Desired revisions,
duplicate/out-of-order facts, cancellation и изоляцию Confirm.
