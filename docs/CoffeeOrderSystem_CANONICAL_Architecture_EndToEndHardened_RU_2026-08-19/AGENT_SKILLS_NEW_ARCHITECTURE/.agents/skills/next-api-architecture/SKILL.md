---
name: next-api-architecture
description: "Use for any target CoffeeOrderSystem API change: client-v1, agent-v1, internal-v1, webhooks/callbacks, partner/provider APIs, Kafka event APIs, realtime SSE/WebSocket, OpenAPI/JSON Schema contracts, auth/trust, versioning, idempotency, UnknownOutcome, or C#→TypeScript API cutover."
---

# Next API Architecture

## Source of truth

Каноническая программа: `M19_API_ARCHITECTURE`.

Перед изменением API прочитать:

1. `M19_API_ARCHITECTURE/README.md`;
2. релевантный документ M19;
3. owning bounded-context program;
4. M03 при public route/cutover;
5. M06 при Kafka event API;
6. M15 при security/reliability/load semantics.

Если skill противоречит M19, побеждает M19 и skill должен быть обновлён.

## Use when

- создаётся/меняется `/api/client-v1`, `/api/agent-v1`, `/api/internal-v1`;
- меняется React generated OpenAPI client;
- добавляется webhook/callback;
- добавляется/меняется AROMA/VK/PSP provider API adapter;
- меняется Kafka topic/event schema/key/audience;
- меняется SSE/WebSocket contract;
- меняются auth/service identity/Channel Identity semantics;
- меняются error codes, `409`, idempotency или UnknownOutcome;
- выполняется C#→TypeScript route/API cutover;
- добавляется GraphQL/gRPC/SOAP или другой новый transport proposal.

## Classification first

Перед edits ответить:

```text
Actor: browser | Hermes | internal workload | provider | Kafka consumer
Trust surface: client-v1 | agent-v1 | internal-v1 | webhook | outbound provider | event | realtime
Transport: HTTP | SSE | WebSocket | Kafka | provider-specific
Owner bounded context: ...
Public/private: ...
Auth: ...
Idempotency/retry semantics: ...
Version/contract artifact: ...
```

Не начинать реализацию без owner/trust classification.

## Hard rules

- OpenAPI — specification format, не classification `Open API`.
- `client-v1`, `agent-v1`, `internal-v1` не объединять.
- `client-v1`, `agent-v1`, `internal-v1` имеют отдельные Node/Fastify composition roots/process roles.
- HTTP runtime использует shared Fastify factory, request/response schemas, explicit proxy trust, AbortSignal deadlines и graceful close.
- Application/domain code не делает arbitrary `fetch`; provider clients имеют fixed origin/connection pool.
- `agent-v1` и `internal-v1` не публиковать public edge.
- React не вызывает provider APIs напрямую.
- Hermes использует `agent-v1`, а не `client-v1`/admin API.
- LLM/model не выбирает customer/VK identity, arbitrary URL/method/header/provider credential.
- Provider webhook получает exact route + provider verification, а не generic untrusted webhook proxy.
- Kafka event schema считается API contract и versioned/compatible.
- Transaction-bound event = local DB + Outbox + CDC, не `commit -> producer.send()`.
- Cross-service database access не считается API и запрещён как substitute contract.
- n8n не пишет domain DB напрямую.
- Nginx владеет edge routing/coarse limits, но не business authorization.
- GraphQL/gRPC/SOAP/service-mesh-like API additions требуют measured/partner-driven ADR, не preference.

## HTTP surface rules

### `client-v1`

- browser-safe DTO;
- user/session auth;
- CSRF для cookie unsafe methods;
- explicit command endpoints для lifecycle transitions;
- server authoritative price/status/permissions/customer ownership;
- stable ProblemDetails/errorCode.

### `agent-v1`

- dedicated Hermes service identity;
- minimal capability set;
- trusted conversation/channel identity injected runtime-side;
- no arbitrary Customer selectors;
- explicit confirmation/idempotency semantics;
- tools do not auto-generate from entire OpenAPI.

### `internal-v1`

- private network;
- per-workload service identity/audience;
- no public Nginx route;
- no generic admin dump surface.

## Webhook/provider rules

Inbound webhook/callback:

```text
verify provider
validate size/schema
stable dedupe/replay identity
persist/durable accept
fast ACK
async work downstream
```

Payment redirect is not payment proof.

Outbound unsafe provider call requires idempotency/UnknownOutcome/reconciliation policy.

## Event API rules

Every Kafka event/topic declares:

- owner;
- producer/consumer audience;
- key/ordering;
- envelope/schemaVersion;
- PII classification;
- retention/replay;
- compatibility.

Event = past-tense fact. Async command = requested action. Do not blur semantics.

## Realtime rules

SSE is default for server→browser invalidation/status.

Realtime event is hint:

```text
hint -> invalidate query -> fresh client-v1 GET
```

Do not make SSE cache/business truth.

WebSocket only for real duplex need.

## Error/idempotency rules

`409` is normal concurrency/business conflict, not `500`.

Unsafe transport exception may be `UnknownOutcome`; caller does not blind retry.

Exactly one retry owner per operation. Avoid retry multiplication across edge/service/provider layers.

## Migration rules

C#→TS implementation change should preserve contract unless an independent API migration is approved.

For reads: shadow/parity/canary allowed.

For writes: HTTP route owner, DB writer owner, background worker owner and migration owner must be consistent before cutover.

React should not change URL/DTO merely because backend language changed.

## Verification

Minimum checks:

1. OpenAPI/JSON Schema validation;
2. generated client reproducibility;
3. compatibility/breaking-change check;
4. actor auth negative tests;
5. public edge negative exposure tests;
6. errorCode/idempotency/UnknownOutcome tests;
7. C#↔TS parity where migrating;
8. webhook replay/signature tests where relevant;
9. Kafka duplicate/replay/schema tests where relevant;
10. route/API-specific load profile when production path changes.

Always combine with `next-verification-and-parity` for migration/cutover.


## Node runtime coordination

Любое изменение production Node HTTP runtime также требует `next-nodejs-runtime` и M19 `10_NODEJS_HTTP_RUNTIME_CONTRACT.md`.

## Kafka hardening coordination

Asynchronous API не хранит собственный topic catalog в M19. Source of truth — M06 `kafka-topic-registry.yml`. Event и command используют разные envelopes и exact payload schemas. Key/partition/replay/DR semantics считаются API contract metadata.


## BusinessLogicHardened service graph

Если задача меняет Orders/Catalog/AROMA/Invoices/Payments interaction, дополнительно активировать `next-business-orchestration` и проверить M20. Target не имеет direct Draft `sendToAromaCart`; `Confirm -> Desired -> Convergence` является нормальным supplier path.

## Catalog/Product API

For Product/Variant/supplier-sync contracts read M19 `12_CATALOG_PRODUCT_API_CONTRACTS.md` and activate `next-catalog-product-lifecycle`. Product update/delete requires expected version; Draft pricing/internal preflight reads are read-only and Confirm never calls Catalog.

## End-to-end closure hard rules

- Exact canonical prefixes are `/api/client-v1`, `/api/agent-v1`, `/api/internal-v1`; verify against M19 OpenAPI files.
- Large manifests/documents use ArtifactRef+hash/size, not oversized HTTP/Kafka bodies.
- Payment provider webhook exact route is `/webhooks/payments/{provider}`.
