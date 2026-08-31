# M19. Webhook/Callback и Partner/Provider APIs

## 1. Два направления

External provider integration имеет две разные границы:

```text
Inbound provider callback/webhook
Provider -> CoffeeOrderSystem
```

и:

```text
Outbound provider API
CoffeeOrderSystem -> Provider
```

Не смешивать эти contracts с `client-v1`/`agent-v1`.

## 2. VK Callback API

### Public route

```text
POST /channels/vk/callback
```

### Owner

```text
Node/TypeScript Channel Ingress
```

### Fast path

```text
receive
→ validate provider authenticity
→ validate payload/schema/size
→ derive stable external message identity
→ attest/minimize channel identity
→ durable Kafka produce
→ provider ACK
```

Callback не ждёт Hermes/model/tool/AROMA.

### Required protections

- exact provider secret/signature semantics;
- content type/body limit;
- duplicate/replay handling;
- raw payload/PII redaction;
- stable provider event dedupe identity;
- bounded media handling;
- durable acceptance before success ACK.

## 3. Payment Webhook API

### Public route family

```text
POST /payments/webhooks/{known-provider}
```

Route создаётся только для allowlisted provider adapter.

### Owner

Payments bounded context.

### Verification

До business transition:

1. проверить signature/authenticity;
2. найти provider payment reference;
3. проверить amount/currency/order binding;
4. применить webhook inbox/idempotency;
5. при необходимости получить fresh provider state;
6. записать local payment state transactionally;
7. опубликовать `PaymentSucceeded/Failed/...` через Outbox.

Browser redirect (`success_url`) не считается proof оплаты.

## 4. AROMA outbound API

AROMA — partner/provider boundary через `AROMA Gateway`.

Gateway владеет:

- auth/session/cookies;
- provider HTTP protocol;
- provider DTO normalization;
- provider rate limits;
- circuit breaker/timeout;
- request/response sanitization;
- provider compatibility tests.

Gateway **не владеет**:

- Order truth;
- Desired/Observed convergence state;
- checkout process state;
- customer/order business authorization.

## 5. VK outbound API

Channel Egress владеет:

- VK send protocol;
- provider quotas/rate limit;
- retry-after;
- stable `deliveryId`;
- transport delivery state;
- provider-specific error mapping.

Он не принимает business decisions и не читает Orders DB напрямую.

## 6. Payment provider outbound API

Payments adapter владеет provider calls:

```text
create intent/payment
query state
capture (если применимо)
refund
```

Каждый unsafe provider request должен иметь:

- local operation idempotency key;
- provider idempotency key where supported;
- timeout/unknown outcome semantics;
- reconciliation path;
- no blind cross-provider retry after uncertain create.

## 7. Provider protocol isolation

Если provider использует REST/SOAP/custom protocol:

```text
provider protocol DTO
      ↓ adapter
internal normalized DTO/result
      ↓ application/domain
```

Provider-specific DTO не становится domain entity/event schema.

## 8. Public callback allowlist

Nginx не публикует generic:

```text
/webhooks/* -> any service
```

Используются exact route families с explicit upstream, body limit, rate policy и logging policy.
