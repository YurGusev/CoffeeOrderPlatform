# M15. Orders/AROMA failure model и SLO

## 1. Отдельные SLO

Не измерять «Order success» одним статусом. Минимум:

```text
order_confirm_commit_latency
aroma_preparation_age
catalog_mapping_pending_age
observed_freshness_age
convergence_pending_age
unknown_outcome_age
blocked_convergence_count
checkout_frozen_age
wholesale_link_age
invoice_materialization_age
awaiting_customer_payment_age
```

## 2. Confirmation availability

Catalog/AROMA outage не должен автоматически делать Confirm unavailable, если local business gates выполняются. Confirm commits PendingMapping/Unavailable-known state and durable work; external resolution происходит async.

## 3. Provider outage

- safe reads fail -> Observed сохраняется, становится stale;
- positive mutation fail-closed;
- uncertain unsafe request -> UnknownOutcome;
- payment/provider outages не переписывают Order business truth.

## 4. Poison work

Blocked/manual review state не должен бесконечно retry storm'ить provider. Требуется operator-visible reason code + bounded retry policy.

## 5. Recovery

Safe recovery действия:

- request fresh observation;
- replay idempotent local/Kafka projection;
- resolve Catalog mapping;
- repair local Desired projection;
- reconcile payment/invoice facts.

Unsafe mutation replay без fresh physical proof запрещён.
