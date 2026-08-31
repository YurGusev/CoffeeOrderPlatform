# M08. Refund, payment cancellation и compensation

## 1. Payment state machines are orthogonal to Order lifecycle

PaymentIntent:

```text
Pending -> Ready -> Processing -> Succeeded | Failed | Cancelled | UnknownOutcome
```

Refund:

```text
Requested -> Processing -> Refunded | Failed | UnknownOutcome | ManualReview
```

## 2. Cancel unpaid intent

Orders compensation/cancel workflow публикует `CancelPaymentIntentRequested` с stable `cancelRef`. Payments проверяет local state и provider proof.

- already Cancelled -> idempotent success;
- already Succeeded -> intent не отменяется; возвращается conflict fact/Orders запускает refund policy;
- provider timeout -> UnknownOutcome + lookup/reconciliation.

## 3. Refund

Orders, а не Payments, принимает business decision о возврате. Команда:

```text
PaymentRefundRequested
refundRef
paymentIntentRef
paymentRequirementRef
orderRef
amountMinor
currency
compensationRef
reasonCode
```

Payments выполняет provider refund с idempotency и публикует:

```text
PaymentRefunded
PaymentRefundFailed
```

Original `PaymentSucceeded` и proof остаются immutable.

## 4. Late success after Order cancellation

Если `PaymentSucceeded` приходит после `Order=Cancelled`, Orders не воскресает Order.

- если cancellation proof содержит `refundPolicy=FullAutomatic`, Orders stages `PaymentRefundRequested`;
- иначе создаётся reconciliation incident `LatePaymentAfterCancellation`.

## 5. Order lifecycle

Refund не меняет `Completed/Cancelled` автоматически. Order Card имеет orthogonal `paymentSnapshot.refundStatus`.

## 6. Exactly-once effect

At-least-once Kafka + Payments Inbox + stable refund/cancel refs + provider idempotency/reconciliation дают effectively-once provider effect. Blind retry на другой PSP запрещён.
