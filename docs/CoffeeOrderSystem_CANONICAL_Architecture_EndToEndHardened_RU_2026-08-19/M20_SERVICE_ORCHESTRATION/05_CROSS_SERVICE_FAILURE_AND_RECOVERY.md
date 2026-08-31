# M20. Cross-service failure/recovery

## 1. Catalog unavailable

Confirm не откатывается. Desired остаётся PendingMapping/known state. Preparation retries bounded; operator видит blocker.

## 2. AROMA unavailable before mutation

No mutation. Observed ages to stale, convergence pending/retrying/blocked.

## 3. AROMA response lost after mutation

`UnknownOutcome`. No automatic second unsafe request until fresh GET.

## 4. Kafka duplicate/replay

Every side-effect consumer uses Inbox/idempotency/current version. Provider side effects additionally require DB state/fresh proof.

## 5. Invoice command duplicated

Stable checkout/wholesale operationRef resumes same invoice. Payload mismatch with same identity -> conflict.

## 6. Payment webhook duplicated

Webhook Inbox + PaymentIntent state makes duplicate no-op; PaymentSucceeded duplicate is also Inbox-idempotent in Orders.

## 7. Cross-service outage

No service changes another owner's state «для компенсации» через DB. Compensation is explicit command/event workflow.

## 8. Recovery priority

```text
fresh read / reconcile
before
retry side effect
```

## 9. Payment/cancellation race

Verified payment после уже committed cancellation не переводит Order обратно в active/completed автоматически. Orders фиксирует reconciliation conflict, Payments сохраняет provider proof, после чего запускается explicit refund/manual resolution. Duplicate/out-of-order event не должен менять lifecycle без current-state gate.
