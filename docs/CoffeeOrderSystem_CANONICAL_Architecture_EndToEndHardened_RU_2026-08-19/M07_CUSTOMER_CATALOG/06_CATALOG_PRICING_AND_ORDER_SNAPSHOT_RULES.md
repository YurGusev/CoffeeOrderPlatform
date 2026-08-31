# M07. Catalog pricing и правила исторических Order snapshots

## 1. Четыре разных price concepts нельзя смешивать

Catalog/Orders уже содержат разные цены с разной семантикой. Target фиксирует их явно:

```text
SupplierListPrice      # факт complete AROMA catalog snapshot / Variant
Procurement/LandedPrice# Orders policy: supplier discount + delivery
CustomerUnitPrice      # Orders markup над landed/base
ActualPurchasePrice    # доказанная цена из invoice/PDF allocation
```

AROMA cart quantity convergence **не зависит** от этих цен.

## 2. Supplier price update

Только positive supplier price из complete available supplier snapshot может стать новой Catalog price truth.

Если supplier price изменился:

```text
Variant supplier/list price = new
Product canonical purchase/base fact = new (если canonical variant)
ProductPriceHistory += old/new/source/effectiveAt
```

`price <= 0`, invalid data или stopped offer рабочую цену не затирают.

## 3. Existing Orders do not auto-reprice

Catalog price change **не переписывает** автоматически:

- OrderItem snapshot;
- Confirmed Order customer price;
- frozen Checkout allocation;
- invoice/applied actual purchase price;
- completed Order history.

Иначе supplier refresh задним числом менял бы согласованный заказ клиента.

## 4. Draft explicit procurement refresh

Current C# behavior переносится:

```text
Operator opens Draft
    ↓
preview current Catalog supplier facts + Orders pricing policy
    ↓
explicit RefreshDraftProcurementPrices(expectedVersion)
    ↓
BEGIN Orders
  require Draft
  require no actual invoice/price proof
  version check
  get persisted Catalog quote facts (read-only)
  calculate group/promotion discount
  calculate delivery
  calculate landed price
  apply customer markup
  supersede previous quote
  write new quote/audit
  recalculate Order total
COMMIT
```

Target может реализовать Catalog read через same-process application contract или `HTTP-R /api/internal-v1/catalog/...`; семантика одна: **никакого provider HTTP** в Draft refresh.

## 5. Confirm does not refresh price implicitly

`ConfirmOrder` не должен неожиданно сделать supplier lookup/reprice.

Перед Confirm Orders проверяет собственный current Draft state/policy readiness. Если бизнес требует fresh quote, это должно быть отдельное explicit precondition/error (`draft_quote_stale`) и отдельный refresh command, а не hidden external call внутри Confirm transaction.

## 6. Confirmed edit and price

Если до checkout оператор добавляет/заменяет позицию Confirmed Order, change command должен получить/зафиксировать price snapshot по явной domain policy. Нельзя применять текущую Catalog price ко всем старым позициям заказа автоматически.

Рекомендуемый target rule:

- unchanged confirmed lines preserve their price snapshot;
- new confirmed line gets a new quote/snapshot at mutation time;
- quantity change preserves unit-price snapshot unless отдельная explicit reprice policy разрешена;
- любое reprice после customer confirmation требует audit reason/operator acknowledgement.

## 7. Invoice price wins only as actual procurement proof

После supplier checkout/PDF `ActualPurchasePrice` появляется из Invoices proof path. Он не обновляет global Catalog supplier price автоматически без отдельной Catalog-owned fact/decision.

Catalog `ActualPriceFromInvoice` из legacy code не должен стать hidden cross-owner writer в target architecture.

## 8. Price changes and AROMA cart

Прямой эффект:

```text
Supplier price changed
→ no DesiredRevision
→ no DesiredKeyVersion
→ no AROMA cart mutation
```

Косвенный эффект возможен только через explicit user/business action (например, Draft refresh или confirmed reprice command), но cart quantity всё равно меняется только при изменении product identity/quantity/contribution.
