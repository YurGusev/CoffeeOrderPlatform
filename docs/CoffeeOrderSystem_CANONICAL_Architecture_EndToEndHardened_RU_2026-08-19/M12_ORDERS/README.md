# M12 — Orders consistency-core и перенос бизнес-логики

## Цель

Перенести не C# классы, а уже доказанную бизнес-семантику Orders/AROMA в TypeScript/Kafka architecture.

## Нормативный lifecycle

```text
Draft -> Confirmed -> AwaitingCustomerPayment -> Completed
  \          |
   \         -> Cancelled по guarded policy
    -> hard delete допустим только для Draft
```

AROMA/fulfillment/checkout/payment не добавляются в `Order.Status`.

## Главное решение

Target **не имеет** `sendToAromaCart` для Draft. `Confirm` атомарно фиксирует business intent и Desired; physical AROMA cart синхронизируется автоматически authoritative convergence engine.

## Документы

1. `01_ORDERS_MIGRATION_AND_INVARIANTS.md`
2. `02_ORDER_LIFECYCLE_STATE_MACHINE.md`
3. `03_ORDER_CARD_READ_MODEL_AND_ACTIONS.md`
4. `04_CONFIRMATION_DESIRED_PREPARATION_FLOW.md`
5. `05_CONFIRMED_ORDER_MUTATION_CANCEL_DELETE_POLICY.md`
6. `06_ORDER_INVOICE_PAYMENT_TRANSITIONS.md`
7. `07_ORDERS_AROMA_PARITY_AND_CUTOVER.md`
8. `08_LEGACY_CSHARP_BEHAVIOR_SOURCE_MAP.md`

Cross-service contract: M20. AROMA critical mechanics: M11.

- `09_CONFIRMED_ORDER_ADDITION_AND_ORDER_ATOMIC_PROCUREMENT.md`
