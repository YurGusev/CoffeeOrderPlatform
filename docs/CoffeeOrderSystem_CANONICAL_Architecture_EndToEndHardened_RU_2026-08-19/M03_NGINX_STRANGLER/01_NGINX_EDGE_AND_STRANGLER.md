# 04. Nginx Edge и Strangler migration

## 1. Роль

`coffee-edge` остаётся единственной публичной application-plane точкой входа.

```text
Internet
   ↓
Nginx
   ├─ /app/*         -> platform-web
   ├─ /api/client-v1/catalog/* -> legacy или platform
   ├─ /api/client-v1/orders/*  -> legacy или platform
   ├─ /events/*      -> realtime-gateway
   └─ /channels/*    -> channel-ingress
```

## 2. Strangler как главный migration mechanism

Для каждой backend family:

```text
catalog_backend_target
customers_backend_target
orders_backend_target
invoices_backend_target
payments_backend_target
```

Target:

```text
legacy
platform
```

Canary может использовать отдельный route/controlled cohort, но **не** user-controlled header, который позволяет обойти authorization.

## 3. Почему public Nginx не заменяется внутренним `platform-web`

Nginx — edge/reverse proxy/load balancer. platform-web — внутренний web delivery host. Их responsibilities не совпадают.

## 4. Route-scoped body limits

Не использовать один глобальный 100MB limit для всего приложения.

Принцип:

```text
VK callback       -> малый лимит
client-v1 JSON    -> малый/средний
invoice upload    -> большой route-specific
price-list upload -> большой route-specific
```

## 5. Rate limiting

Edge делает coarse protection:

- public API request burst;
- callback abuse;
- connection admission.

Domain/provider rate limit остаётся внутри owning service.

## 6. Upstreams

Production route family может иметь несколько replicas:

```nginx
upstream api_public {
    least_conn;
    server api-public-1:3000;
    server api-public-2:3000;
}
```

Конкретная конфигурация генерируется окружением/Kubernetes ingress integration.

## 7. Realtime proxying

SSE требует длинных HTTP response lifetimes и соответствующих buffering/timeouts.

WebSocket требует корректной передачи Upgrade/Connection headers.

Realtime paths настраиваются отдельно от обычного API.

## 8. Capacity

Текущие connection limits не копируются автоматически в target. Перед high-concurrency cutover измеряются:

```text
worker_processes
worker_connections
file descriptor limit
memory per connection
upstream keepalive
SSE/WS lifetime
```

## 9. Rollback

Rollback route family не меняет БД. Он только возвращает request routing к предыдущему authoritative runtime **если schema ownership совместим с rollback**.

После необратимого DB migration route rollback запрещён без отдельного forward-compatible rollback contract.

## 10. Security

Nginx:

- очищает/создаёт trusted `X-Forwarded-*` chain;
- не доверяет caller-supplied internal headers;
- не публикует `/api/internal-v1/*` и `/api/agent-v1/*`;
- выдаёт security headers;
- скрывает internal topology.


## 11. API surface authority

Public/private API route inventory определяется M19_API_ARCHITECTURE. Edge публикует только allowlisted public client/webhook/realtime surfaces.


## 12. Physical API roles

Public edge routes `client-v1` только в `api-public`. `api-agent` и `api-internal` не являются public upstream groups.
