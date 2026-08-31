# M12. Добавление позиции после Confirmed и Order-atomic procurement

## 1. Принятое решение

Для первой production-версии закупка **атомарна на уровне Order**:

> один Order не делится между несколькими обычными supplier checkout/invoice/payment cycles.

Это означает: в Checkout можно заморозить Order только тогда, когда **все его активные позиции** готовы к одной закупке.

```text
Order 101
├─ Ethiopia ×2   Ready/InSync
└─ Kenya ×1      Unavailable

=> Order 101 целиком НЕ входит в Checkout
```

Оператор либо ждёт восстановления Kenya, либо удаляет/заменяет позицию явной командой, либо отменяет Order. Partial line-level procurement откладывается отдельным ADR и потребует модели `Order -> N CheckoutAllocations -> N InvoiceAllocations -> N PaymentRequirements`.

## 2. Добавление товара после Confirmed

Пока Order=`Confirmed` и он **не входит в frozen/CheckoutPending/WholesaleLinked proof**, оператор может выполнить:

```text
POST /api/client-v1/orders/{orderRef}/commands/add-item
```

Команда `AddConfirmedOrderItem` содержит:

```text
orderRef
expectedOrderVersion         # decimal string UInt64 wire type
productRef
variantRef
quantity
selectedGrindRef?
actor
reason
```

Browser не передаёт authoritative цену/mapping/AROMA offer.

## 3. Pre-transaction Catalog read

Orders до локальной transaction получает один bounded current Catalog snapshot для `variantRef`:

```text
Product/Variant identity
EffectiveOrderability
CatalogSnapshotRef
SupplierListPrice
SupplierPriceObservedAt
ProductFamily
mapping readiness summary
```

Это **local persisted Catalog read**, не AROMA provider lookup. Snapshot ref сохраняется как provenance новой строки.

Если `EffectiveOrderability != Orderable`, команда fail-closed. Для известных `PendingMapping/UnknownAvailability` UI показывает blocker; оператор не может обойти его raw AROMA ID.

## 4. Atomic Orders transaction

После Catalog read:

```text
BEGIN Orders DB
  lock Order
  verify expectedOrderVersion
  verify Order=Confirmed
  verify no Checkout/Frozen/Wholesale/Invoice gate
  add OrderItem snapshot
  persist procurement quote/provenance for new item
  recalculate customer total
  create/update DesiredSource
  advance DesiredRevision/DesiredKeyVersion
  append OrderHistory
  append Outbox OrderChanged/AromaPreparationRequested
COMMIT
```

Никакого AROMA HTTP внутри transaction.

После commit обычный `Desired -> Convergence` доводит физическую корзину до нового target.

## 5. Existing Confirmed items

Для уже подтверждённых строк Catalog price/name change не переписывает snapshot. `changeConfirmedQuantity` меняет количество и customer total по сохранённой unit-price semantics; если business хочет применить новую закупочную цену, оператор использует отдельный explicit repricing workflow до Checkout.

Новая позиция является новым business intent и поэтому использует текущий Catalog quote snapshot на момент добавления.

## 6. После Freeze

Если клиент хочет добавить товар после `CheckoutPending/Frozen`, текущий Order не изменяется. Создаётся новый связанный Order:

```text
RelatedOrderRef = originalOrderRef
Reason = CustomerAdditionAfterFreeze
```

Он проходит независимый `Draft -> Confirmed -> Checkout -> Invoice -> Payment` цикл.

## 7. Checkout eligibility

Order участвует в freeze только если для **каждой активной строки**:

- business line не cancelled/removed;
- confirmation/approval proof valid;
- mapping Ready;
- supplier availability Available;
- Desired contribution > 0;
- convergence `InSync` для соответствующего CartKey;
- нет `UnknownOutcome`/manual review;
- нет stable fulfillment из другого checkout;
- order-level price/markup gates valid.

Это предотвращает скрытую частичную закупку.
