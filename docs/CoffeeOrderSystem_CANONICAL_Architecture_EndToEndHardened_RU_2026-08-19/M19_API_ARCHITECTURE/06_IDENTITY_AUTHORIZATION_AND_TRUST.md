# M19. Identity, Authorization и Trust Boundaries

## 1. Главный принцип

API authentication отвечает на вопрос **кто caller**, authorization — **что ему разрешено**, а business domain — **допустима ли операция над текущим aggregate/state**.

Эти проверки не заменяют друг друга.

## 2. Browser identity

`client-v1` использует user/session identity.

Требования:

- HttpOnly session/token delivery according accepted auth design;
- unsafe cookie-authenticated requests защищены CSRF;
- user cannot supply audit actor/role/customer ownership as authority;
- authorization проверяется backend на каждом command/read surface.

## 3. Hermes service identity

`agent-v1` принимает только CoffeeOrder Hermes workload identity.

Дополнительный trusted context:

```text
conversationRef
channelIdentityRef
OwnerEpoch/runtime binding where required
```

Этот context создаётся transport/orchestration layer, не LLM prompt.

## 4. Channel Identity

```text
VK raw sender identity
    ↓ trusted Channel Gateway / Identity Broker
opaque channelIdentityRef
    ↓
Hermes trusted session context
    ↓ resolve_current_customer()
Customer resolver
```

Model не имеет права указать другое external ID.

## 5. Internal service identity

`internal-v1` использует per-workload credentials/identity.

Не использовать один shared `INTERNAL_API_KEY` для всех services в зрелой production topology.

Authorization может ограничивать service audience:

```text
channel-ingress -> identity.attest
n8n-control     -> approved low-risk ops commands
reconciliation  -> reconciliation endpoints
```

## 6. Kafka identity

Отдельный Kafka principal на workload/group с least-privilege ACL.

Пример:

```text
channel-ingress: WRITE channels.inbound
hermes-dispatcher: READ agent.turn.requested; WRITE agent.turn.completed/failed
channel-egress: READ channels.outbound; WRITE channels.delivery
```

## 7. Provider identity

### Inbound

Provider callback/webhook проверяет provider authenticity согласно provider contract.

### Outbound

Credential хранится только в owning adapter/workload secret scope.

Ни React, ни Hermes, ни n8n не получают provider secret, если их роль этого не требует.

## 8. Public vs private route test

CI/deployment test должен fail closed, если public edge случайно начал proxy:

```text
/api/agent-v1
/api/internal-v1
Hermes admin
Kafka Connect admin
```

## 9. Authorization in Nginx

Nginx может выполнять coarse protections:

- allow route family;
- TLS;
- rate/body limits;
- trusted proxy headers.

Но business role/order/customer authorization выполняется application layer.
