# M01. Перенос Orders UI: отказ от legacy send-to-AROMA

## 1. Copy-first всё ещё действует

Первый технический copy `src/CoffeeOrderSystem.Web -> platform/apps/web` должен доказать build/UI parity. Но target handover не консервирует legacy business architecture навсегда.

## 2. Обязательная adaptation до Orders target cutover

Удалить из target route:

```text
sendToAromaCart action/button
orderAromaCart API adapter
useOrderAromaCartFillWorkflow
batch progress/resend UI
legacy batch discovery/status polling
```

## 3. Чем заменить

Order Card получает server-derived:

```text
business status
AROMA sync summary
mapping/availability blockers
checkout status
invoice/price status
payment status
allowedActions
```

После `Confirm` UI показывает automatic sync progress, но не запускает physical mutation напрямую.

## 4. UnknownOutcome UX

```text
AROMA: Результат операции уточняется
Повторная отправка заблокирована
```

UI refresh/invalidation вызывает fresh read, не mutation retry.

## 5. Rollback

До final decommission rollback переключает whole route family на legacy React/C# artifact. Не допускается target Order Card + legacy batch writer одновременно.
