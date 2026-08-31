# M04. Bounded Contexts, process roles и ownership

## 1. Customer

Владеет:

- customers;
- channel identity links;
- addresses/contact profile;
- customer conditions;
- customer history summaries/projections.

Не владеет Order lifecycle или Hermes conversation state.

## 2. Catalog

Владеет:

- products/variants;
- price/availability facts;
- AROMA offer mapping;
- catalog import/snapshot;
- indexing state.

Catalog может выполнять **только safe provider reads** через AROMA Gateway для mapping/availability. Он публикует mapping/availability facts; не пишет Orders Desired и не мутирует AROMA cart.

## 3. Orders

Orders — главный consistency-core и владеет:

- `Draft`, `Confirmed`, `AwaitingCustomerPayment`, `Completed`, `Cancelled` lifecycle;
- order items/snapshots/totals/version/history;
- confirmation/idempotency proof;
- AROMA Desired sources/revisions;
- AROMA Observed projection/snapshots;
- convergence items/attempts/leases/fencing/UnknownOutcome;
- supplier fulfillment projection по order item;
- immutable checkout proof, wholesale link snapshot и checkout process state;
- минимальными foreign snapshots/references для Order Card.

AROMA state **не добавляется в `Order.Status`**.

### Orders-owned runtime roles

```text
catalog-supplier-sync      # Catalog-owned process role
orders-aroma-preparation
aroma-observer
aroma-convergence
aroma-checkout-poller
```

Это отдельные workloads, но не отдельные business owners.

## 4. Invoices

Владеет:

- local ClientInvoice lifecycle;
- invoice lines/allocations;
- PDF metadata/link proof;
- materialization inbox/idempotency;
- three-way reconciliation;
- price-application state/outbox.

Invoices не создаёт invoice из простого `OrderConfirmed`. Нормальный supplier-flow начинается с immutable Orders checkout + linked wholesale snapshot и explicit `InvoiceMaterializationRequested` command.

## 5. Payments

Владеет:

- PaymentIntent;
- PaymentAttempt;
- webhook inbox;
- refund;
- provider reconciliation;
- provider credentials.

Payments получает `OrderPaymentRequired` как бизнес-факт, не меняет Orders tables и публикует verified payment facts назад.

## 6. AROMA Gateway

AROMA Gateway — **provider integration boundary, не bounded context**.

Владеет только:

- auth/session/cookies;
- provider HTTP connection pools;
- provider DTO normalization;
- provider-specific rate limiting/circuit state;
- safe read primitives;
- explicit single mutation primitives.

Не владеет:

- Order;
- Desired/Observed;
- target quantity;
- retry decision для business mutation;
- convergence attempt;
- checkout;
- payment/invoice lifecycle.

Gateway никогда не вызывает Orders callback, чтобы «сообщить успех». Orders доказывает физический результат fresh GET.

## 7. React/Hermes

React и Hermes — actors/adapters. Они не владеют бизнес-состоянием.

- React получает server-derived `allowedActions` и Order Card projection;
- Hermes вызывает narrow `agent-v1` capabilities;
- ни один из них не имеет direct `sendToAromaCart` capability в target architecture.

## 8. One writer per truth

После extraction:

```text
Customer -> customer-owned tables
Catalog  -> catalog-owned tables
Orders   -> orders-owned tables
Invoices -> invoice-owned tables
Payments -> payment-owned tables
```

Никаких direct cross-owner `UPDATE`, cross-schema ORM navigation или shared mutable entity.

## 9. Sync/async rule

Cross-context mutation обычно идёт через Kafka command/event. Синхронный HTTP между contexts допускается только если caller немедленно нуждается в read/result и нет транзакционного цикла.

Критический exception — Orders-owned convergence вызывает AROMA Gateway синхронно для `fresh GET -> one mutation -> fresh GET`, потому что это одна external-consistency operation, а Gateway не является business owner.

## 10. Нормативная матрица

Полная матрица producers/consumers/sync dependencies находится в `M20_SERVICE_ORCHESTRATION`. Нельзя добавлять новую связь только потому, что оба modules находятся в одном monorepo.

## Catalog Product ownership clarification

Catalog Product/Variant/Alias, complete supplier snapshots, supplier list prices/history, availability and AROMA mapping are Catalog-owned. Orders owns customer/pricing-policy snapshots and all Desired/Observed/Convergence reactions. Catalog price changes do not auto-reprice confirmed orders; availability/mapping facts may change cart eligibility through Orders.

`catalog-supplier-sync` is runtime isolation inside Catalog ownership. Product/Variant/supplier snapshot/mapping/availability remain one Catalog bounded context unless a later ADR proves otherwise.
