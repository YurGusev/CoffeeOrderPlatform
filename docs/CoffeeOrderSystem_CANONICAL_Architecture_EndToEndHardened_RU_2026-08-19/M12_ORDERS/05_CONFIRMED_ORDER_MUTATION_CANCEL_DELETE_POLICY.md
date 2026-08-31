# M12. Политика изменений Confirmed Order

## 1. Запрет возврата в Draft

После confirmation business intent уже опубликован. Исправления не делают `Confirmed -> Draft` и не вызывают legacy resend.

## 2. Explicit item commands

До irreversible checkout/fulfillment gates могут существовать:

```text
addConfirmedItem
removeConfirmedItem
changeConfirmedQuantity
replaceConfirmedItem      # только если отдельный contract действительно нужен
cancelOrder
```

Каждый command:

- expected OrderVersion;
- actor + reason;
- current checkout/fulfillment/invoice gates;
- mutation Order + Desired/history в одной Orders transaction;
- Outbox;
- no AROMA HTTP.

Convergence приводит physical cart к новому target после commit.

## 3. Remove item

Удаление confirmed item разрешено только если нет stable supplier/invoice/price proof. Desired source удаляется через revision service; target key может стать zero.

## 4. Cancel order

### До checkout freeze

Можно отменить: Desired становится zero/excluded, convergence убирает contribution физически.

### CheckoutPending/Frozen

Нельзя менять отдельный Order в обход checkout. Сначала guarded checkout cancel/profile recovery, затем Order cancellation.

### WholesaleLinked / invoice materialized

Generic cancel запрещён. Нужна explicit compensation policy между Orders/Invoices.

### AwaitingCustomerPayment / Completed

Обычный delete/cancel не используется. Refund/correction — отдельные business workflows.

## 5. Hard delete

Нормальная пользовательская hard delete разрешена только Draft.

Confirmed/Cancelled/Completed — durable business/audit record. Admin retention/purge, если когда-либо нужен, является отдельной offline policy и не вызывает provider side effects.

## 6. Bulk actions

Bulk delete/edit не реализуется browser loop'ом. Server предварительно валидирует версии и state gates; операция либо имеет чёткую partial-result semantics, либо atomic bounded batch.


## Catalog changes versus confirmed-order snapshots

Confirmed OrderItem product/price snapshots are historical business facts and do not silently track Catalog description/price changes.

Operational supplier facts are different: mapping/availability/tombstone events may change the OrderItem's **ability to contribute to AROMA Desired** while preserving the customer-order snapshot. `product_on_stop`, remap or delete therefore can make AROMA target zero without changing `Order.Status=Confirmed`.


## 7. Order-atomic procurement

Normal v1 procurement не делит один Order между checkout/invoice cycles. Все активные строки должны быть Ready/InSync до freeze; additions после freeze создаются новым related Order. Детали: `09_CONFIRMED_ORDER_ADDITION_AND_ORDER_ATOMIC_PROCUREMENT.md`.
