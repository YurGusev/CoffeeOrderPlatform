---
name: payments-service
description: Реализовывать или проверять payment intents, provider webhooks, reconciliation, refunds, idempotency, proof и Orders handoffs CoffeeOrderPlatform.
---

# Сервис платежей

Payments владеет PaymentIntent, Attempt, WebhookInbox, Refund, provider proof и
reconciliation. Он никогда не изменяет хранилище Orders.

- Amount/currency come from durable server-owned `OrderPaymentRequired`.
- Card data never passes through business services, Kafka, logs, or Hermes.
- Browser redirect is not payment proof; authenticate webhook and reconcile.
- Provider create/refund uses stable idempotency and lookup after timeout.
- Timeout can be UnknownOutcome; never switch provider or blind-create.
- Publish verified facts asynchronously; Orders consumes them idempotently.
- Separate public webhook ingress from outbound provider workers and secrets.

Проверять duplicate/out-of-order webhooks, потерю ответа, reconciliation, гонки
refund/cancellation, forged callbacks, stale commands и восстановление после restart.
