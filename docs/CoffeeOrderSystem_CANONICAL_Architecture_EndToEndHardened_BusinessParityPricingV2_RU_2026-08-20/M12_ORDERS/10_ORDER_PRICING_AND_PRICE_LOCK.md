# Orders ↔ Pricing and price lock

Orders владеет договорённостью с клиентом, Pricing — правилами расчёта.

## Draft

При добавлении/замене позиции Orders получает PricingQuote и сохраняет полный quote snapshot на OrderItem. UI показывает уже итоговую `CustomerUnitPrice`, `LineTotal`, `OrderTotal`.

Draft price states:

```text
Current ↔ Stale
Current → Locked только через Confirm
Unresolved блокирует Confirm
```

## Confirm transaction

Confirm **не вызывает Pricing HTTP**. До Confirm Orders имеет локальную projection актуальных Pricing versions и quote snapshot. Транзакция проверяет:

- quote не stale;
- pricing hash/version актуальны;
- discount/delivery/markup source заполнены;
- markup разрешён;
- все items priced.

Затем создаётся immutable `OrderPriceManifest` и OrderItem snapshots переходят в Locked.

## Invoice

Фактический invoice обновляет `ActualSupplierNetUnitCost`/actual margin evidence, но не `CustomerUnitPrice` Locked order.

## Order card UI

Основной operator view обязан показывать уже финальную цену:

```text
Product / variant
2 × 758.74 ₽ = 1,517.48 ₽
```

Раскрываемая детализация: supplier list price, discount source/percent, supplier net, delivery coefficient/unit amount, landed cost, markup source/percent, customer unit price, line total, pricing version/state. Customer-facing channel может показывать только customer price/total без внутренних margin components.
