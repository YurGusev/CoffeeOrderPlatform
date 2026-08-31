# M19. HTTP surfaces: `client-v1`, `agent-v1`, `internal-v1`

## 1. Почему три surface

Один универсальный HTTP API создаёт чрезмерные полномочия. React, Hermes и внутренние services — разные actors.

```text
/api/client-v1   human/browser UX
/api/agent-v1    bounded AI seller capabilities
/api/internal-v1 workload/control-plane operations
```

Они могут вызывать одни и те же application use cases, но **не обязаны иметь одинаковые DTO, auth или доступные operations**.

## 2. `client-v1`

### Consumer

```text
platform/apps/web (React)
```

### Public path

```text
/api/client-v1/*
```

### Responsibilities

- operator/customer-facing reads;
- browser-safe commands;
- user/session authorization;
- CSRF protection для cookie-authenticated unsafe operations;
- ProblemDetails/errorCode;
- version/rowVersion/confirmation proof where required.

### Запрещено доверять browser

- authoritative price/total;
- lifecycle status;
- permissions/role;
- Customer ownership;
- payment success;
- AROMA state;
- provider IDs as authority;
- audit actor field supplied by browser.

### Command design

Не разрешать generic lifecycle patch:

```text
PATCH /orders/{id} { status: "Completed" }
```

Использовать explicit command:

```text
POST /api/client-v1/orders/{orderRef}/commands/confirm
POST /api/client-v1/orders/{orderRef}/commands/cancel
```

или resource-specific semantics, где state transition очевиден и server-owned.

## 3. `agent-v1`

### Consumer

```text
Hermes CoffeeOrder Plugin only
```

### Exposure

Private network only. Public Nginx route отсутствует.

### Authentication

- dedicated service identity;
- short-lived/rotatable service credential;
- trusted `conversationRef` / `channelIdentityRef` injected by plugin/runtime;
- `OwnerEpoch`/session binding checks where mutation safety requires them.

### Capability design

Agent tool surface маленький и ручной/allowlisted:

```text
resolve_current_customer()
get_current_customer_profile()
get_recent_order_pattern()
search_products(...)
get_current_order()
add_order_item(...)
update_order_item(...)
remove_order_item(...)
get_order_summary()
prepare_confirmation()
confirm_current_order(proof)
```

Не генерировать автоматически tools из всей OpenAPI.

### Identity rule

Model не передаёт:

```text
customerId
vk_user_id
peer_id
arbitrary channelIdentityRef
```

`resolve_current_customer()` не принимает identity argument. Plugin injects trusted transport context.

### Forbidden agent powers

- arbitrary HTTP URL/method/header;
- DB access;
- AROMA credentials;
- payment provider credentials;
- admin API;
- cross-customer selector;
- direct lifecycle/status mutation.

## 4. `internal-v1`

### Consumers

- channel identity broker/client;
- internal operational services;
- migration/reconciliation workflows;
- bounded n8n control-plane commands where explicitly allowed.

### Exposure

Private service network only.

### Examples

```text
POST /api/internal-v1/channel-identities/attest
POST /api/internal-v1/reconciliation/orders/{ref}/run
GET  /api/internal-v1/operations/health-detail
```

Не использовать `internal-v1` как свалку для любых endpoint'ов. Каждая operation должна иметь owner и explicit service audience.

## 5. Code organization и physical runtime separation

Рекомендуемая TypeScript структура:

```text
platform/apps/
  api-public/       # mounts client-v1 adapters only
  api-agent/        # mounts agent-v1 adapters only
  api-internal/     # mounts internal-v1 adapters only

platform/modules/orders/
  application/
  domain/
  infrastructure/
  adapters/http/client-v1/
  adapters/http/agent-v1/
  adapters/http/internal-v1/
```

HTTP adapters могут различаться, application use cases остаются едиными. Разные trust surfaces не обязаны жить в одном Node process. Полный runtime contract — `10_NODEJS_HTTP_RUNTIME_CONTRACT.md`.

## 6. API → domain rule

```text
HTTP adapter
   ↓ validate actor/shape
Application use case
   ↓
Domain invariant
   ↓
Owned repository/transaction
```

Controller/route handler не:

- пишет SQL;
- orchestration нескольких repositories без use-case abstraction;
- публикует Kafka после commit напрямую;
- принимает business state от caller как authority.

## 7. Response minimization

Каждый actor получает только необходимый projection.

Например agent customer resolve:

```json
{
  "status": "found",
  "customerRef": "cus_x",
  "displayName": "Юрий",
  "active": true,
  "canOrder": true
}
```

Не возвращать весь Customer row, внутренние IDs и PII только потому, что они доступны backend.


## 8. Orders/AROMA target surface

Для Orders target API отсутствует direct Draft-to-AROMA command. `Confirm` фиксирует local intent; AROMA synchronization — server-owned async process.

`client-v1` и `agent-v1` не expose provider mutation IDs/methods. Recovery/admin AROMA operations принадлежат internal/admin surface и всё равно проходят Orders state-machine gates.

Подробный contract — `11_ORDER_AROMA_API_CONTRACTS.md`.
