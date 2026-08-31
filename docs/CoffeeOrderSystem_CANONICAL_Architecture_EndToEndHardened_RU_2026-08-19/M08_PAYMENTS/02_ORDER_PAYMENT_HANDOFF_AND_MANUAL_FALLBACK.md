# M08. Orders ↔ Payments handoff

## 1. PaymentRequirement identity

Orders создаёт stable `PaymentRequirementRef`, связанный с:

```text
OrderRef
OrderVersion
ClientInvoiceRef
AmountMinor
Currency
PriceProofHash
```

Эта identity попадает в `OrderPaymentRequired` и используется Payments как idempotency/business correlation key.

## 2. Orders consumer

`PaymentSucceeded` не является прямым `PATCH status=Completed`.

Orders consumer в одной transaction:

1. проверяет Inbox/EventId;
2. загружает Order;
3. проверяет `AwaitingCustomerPayment`;
4. проверяет requirement/payment correlation и сумму;
5. записывает payment proof snapshot;
6. переводит в `Completed`;
7. пишет history + Outbox `OrderCompleted`;
8. commit; затем Kafka offset commit.

Duplicate PaymentSucceeded должен быть no-op.

## 3. Conflict

Если provider success пришёл для устаревшего/другого requirement, Order не завершается молча. Событие становится operator-visible reconciliation conflict.

## 4. Refund

Refund не меняет Order lifecycle автоматически без отдельного business decision. Payments emits refund fact; Orders/оператор применяют отдельную компенсационную политику.

## 5. Manual fallback

Manual collection использует тот же Orders transition primitive с proof type `manual`, но не создаёт фиктивный PaymentIntent.
