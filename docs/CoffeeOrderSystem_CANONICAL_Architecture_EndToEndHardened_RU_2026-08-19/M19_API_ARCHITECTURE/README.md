# M19 — API Architecture

## Цель программы

Сформировать единый нормативный API-слой новой CoffeeOrderSystem, который остаётся стабильным при миграции `src/C# -> platform/TypeScript`, разделяет actors/trust zones и не смешивает HTTP, webhook, realtime и Kafka contracts.

## Каноническая классификация

API классифицируется по **двум независимым осям**:

1. **Actor / trust surface** — кто вызывает контракт:
   - Browser / operator;
   - Hermes agent runtime;
   - internal service/control plane;
   - external provider callback/webhook;
   - outbound partner/provider;
   - asynchronous service/event consumer.
2. **Transport** — как передаётся контракт:
   - HTTP/JSON REST;
   - SSE;
   - WebSocket, только при реальной duplex-потребности;
   - Kafka;
   - provider-specific HTTP/SOAP/etc на adapter boundary.

`OpenAPI` — не тип API и не synonym `Open API`. В CoffeeOrderSystem OpenAPI является **language-neutral contract description** для HTTP surfaces.

## Нормативные surfaces

```text
/api/client-v1      React/browser
/api/agent-v1       Hermes CoffeeOrder plugin
/api/internal-v1    service-to-service + bounded control plane
/channels/...   provider callback ingress, например VK
/payments/webhooks/... provider-specific payment callbacks
/events         React realtime SSE
Kafka topics    asynchronous integration API
provider clients outbound AROMA/VK/PSP partner APIs
```

## Hard rules

- `client-v1`, `agent-v1` и `internal-v1` имеют разные actor/trust models и не объединяются в один универсальный API.
- `internal-v1` не публикуется public Nginx edge без отдельного ADR/security review.
- Browser никогда не вызывает AROMA/PSP/VK provider APIs напрямую.
- Hermes не вызывает `client-v1`; он работает только через минимальный `agent-v1` capability surface.
- Model/user text не выбирает `customerId`, `vkUserId`, arbitrary URL/method/header или provider credential.
- Transaction-bound domain events публикуются через local DB transaction + Outbox + CDC, а не через `commit -> producer.send()`.
- Kafka event schema является API contract и проходит compatibility/versioning gates наравне с OpenAPI.
- `service -> database` не считается cross-service API. Каждый bounded context пишет только собственные schema/tables.
- Nginx выполняет edge routing/security/canary/rollback, но не business authorization или customer/order decisions.
- n8n использует explicit internal/control API или approved commands; direct domain-table writes запрещены.
- SOAP/GraphQL/gRPC допускаются только по отдельному measured/partner-driven ADR; они не являются default stack.

## Документы программы

1. `01_API_ARCHITECTURE_OVERVIEW.md` — полная карта API и ownership.
2. `02_HTTP_SURFACES_CLIENT_AGENT_INTERNAL.md` — три основных HTTP surface.
3. `03_WEBHOOK_CALLBACK_AND_PARTNER_APIS.md` — VK/payment callbacks и outbound providers.
4. `04_EVENT_AND_REALTIME_APIS.md` — Kafka + SSE/WebSocket.
5. `05_CONTRACT_REGISTRY_AND_VERSIONING.md` — OpenAPI/JSON Schema/event contracts/versioning.
6. `06_IDENTITY_AUTHORIZATION_AND_TRUST.md` — actor identity, service auth, channel identity.
7. `07_ERRORS_IDEMPOTENCY_AND_UNKNOWN_OUTCOME.md` — error model, conflict/retry semantics.
8. `08_API_MIGRATION_STRANGLER_AND_COMPATIBILITY.md` — C#→TS route migration без client rewrite.
9. `09_API_TESTING_AND_ACCEPTANCE.md` — contract/security/parity/load gates.
10. `10_NODEJS_HTTP_RUNTIME_CONTRACT.md` — physical Fastify runtimes, schemas, proxy trust, deadlines и lifecycle.
11. `11_ORDER_AROMA_API_CONTRACTS.md` — Orders/AROMA client contracts.
12. `12_CATALOG_PRODUCT_API_CONTRACTS.md` — Product/Variant, supplier-sync, mapping и Orders read contracts.

## Dependencies

M19 опирается на:

- M00 — architecture ownership;
- M03 — Nginx Strangler;
- M04 — TypeScript platform foundation;
- M05 — DB ownership;
- M06 — Kafka/Outbox/CDC;
- M15 — security/reliability/observability;
- M16 — CI/CD contract gates.

M19 является обязательным contract source для M01, M07, M08, M09, M10, M11, M12 и n8n boundary M04.

## Definition of Done

- опубликованы separate `client-v1`, `agent-v1`, `internal-v1` OpenAPI artifacts;
- webhook schemas/provider verification contracts формализованы;
- Kafka event APIs зарегистрированы и versioned;
- React generation не зависит от C# build directory;
- Hermes tool surface генерируется/регистрируется только из approved capability set, а не из всей OpenAPI;
- public Nginx route inventory содержит только разрешённые public surfaces;
- internal API negative exposure test проходит;
- actor/service auth matrix покрыта tests;
- `409`, rate limit, provider failure и `UnknownOutcome` имеют стабильную семантику;
- contract compatibility CI блокирует breaking changes без explicit new version/ADR;
- route cutover C#→TS не требует изменения browser URL/contract;
- `client-v1`, `agent-v1`, `internal-v1` физически разведены в `api-public`, `api-agent`, `api-internal` Node runtimes.


## Agent skill

Основной skill: `next-api-architecture`. Для C#→TS route/contract migration также активировать `next-verification-and-parity` и skill owning bounded context.


## Node hardening дополнение

- `10_NODEJS_HTTP_RUNTIME_CONTRACT.md` — Physical api-public/api-agent/api-internal Fastify runtime, schemas, proxy trust, deadlines and HTTP lifecycle.


Для production Node workload также активировать `next-nodejs-runtime`.

## Kafka hardening

Asynchronous API source of truth: M06 `kafka-topic-registry.yml`, separate event/command envelopes, payload schemas, partition/replay/DR policies. M19 не поддерживает отдельный дублирующий topic catalog.

## Orders/AROMA

`11_ORDER_AROMA_API_CONTRACTS.md` фиксирует отсутствие direct Draft-to-AROMA API и server-owned sync projection.

- `13_OPENAPI_CANONICAL_ROUTES.md`
