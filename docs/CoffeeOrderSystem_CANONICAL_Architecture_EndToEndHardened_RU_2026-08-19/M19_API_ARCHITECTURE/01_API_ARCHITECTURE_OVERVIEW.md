# M19. API Architecture — обзор и карта

## 1. Почему нужна отдельная API-архитектура

В новой CoffeeOrderSystem API — не один `/api` controller host. Система имеет несколько actors, trust boundaries и transport semantics:

```text
Browser / React
Hermes Agent
Internal services
n8n control plane
VK callback
Payment provider webhook
AROMA/VK/PSP outbound calls
Kafka consumers/producers
Realtime browser subscriptions
```

Если все они используют один DTO/auth/routing surface, возникают:

- privilege leakage;
- чрезмерно широкие agent tools;
- public exposure internal endpoints;
- невозможность независимо version/canary contracts;
- смешение sync HTTP и async event semantics;
- migration coupling между C# и TypeScript.

Поэтому API architecture является отдельной program-level concern.

## 2. Двухмерная модель

### Ось A — actor/trust surface

| Surface | Actor | Trust model | Public exposure |
|---|---|---|---|
| `client-v1` | React/browser operator | authenticated user/session + CSRF | через `coffee-edge` |
| `agent-v1` | Hermes CoffeeOrder plugin | service identity + trusted conversation context | private |
| `internal-v1` | platform services / bounded control plane | workload/service identity | private |
| Channel callback | VK/provider | provider verification | narrow public route |
| Payment webhook | PSP | provider signature/secret + reconciliation | narrow public route |
| Provider API | Coffee service → provider | provider credential/session | outbound only |
| Kafka API | services | Kafka principal + topic ACL | private |
| Realtime | React/browser | short-lived user-scoped authorization | через edge |

### Ось B — transport

| Transport | Use |
|---|---|
| HTTP/JSON | immediate authoritative command/query result |
| SSE | server→browser invalidation/status stream |
| WebSocket | future true duplex web-chat only when justified |
| Kafka | durable asynchronous facts/commands/fan-out/replay |
| Provider protocol | AROMA/VK/PSP external boundary; adapter normalizes internally |

## 3. Target topology

```mermaid
flowchart TB
  Browser[Browser / React]
  VK[VK]
  PSP[Payment Provider]
  Edge[coffee-edge\nPUBLIC Nginx]
  Web[platform-web\nINTERNAL Nginx]
  APIP[api-public\nclient-v1]
  APIA[api-agent\nagent-v1]
  APII[api-internal\ninternal-v1]
  RT[Realtime Gateway]
  CIN[Channel Ingress]
  Pay[Payments]
  Hermes[Hermes Runtime]
  Plugin[CoffeeOrder Plugin]
  Kafka[(Kafka)]
  AromaGW[AROMA Gateway]
  Aroma[AROMA]

  Browser --> Edge
  Edge -->|/app/*| Web
  Web --> Browser
  Browser -->|/api/client-v1/*| Edge
  Edge --> APIP
  Browser -->|/events| Edge
  Edge --> RT

  Hermes --> Plugin
  Plugin -->|/api/agent-v1/* private| APIA

  VK -->|/channels/vk/callback| Edge
  Edge --> CIN
  CIN --> Kafka

  PSP -->|/payments/webhooks/{provider}| Edge
  Edge --> Pay

  APIP --> Kafka
  Kafka --> APII
  Pay --> Kafka
  Kafka --> RT

  APIP --> AromaGW
  AromaGW --> Aroma
  Pay -->|provider API| PSP
```

## 4. Public edge route inventory

Public `coffee-edge` должен иметь allowlist, а не catch-all proxy к внутренним приложениям.

### Разрешено публично

```text
/app/*
/api/client-v1/*
/events
/channels/vk/callback       # exact/bounded
/payments/webhooks/<known-provider>  # exact/bounded
/healthz                    # edge health only, no internals
```

### Не публикуется

```text
/api/agent-v1/*
/api/internal-v1/*
Kafka brokers
Kafka Connect admin REST
PostgreSQL
Hermes internal API
provider admin endpoints
Prometheus/Grafana admin routes unless separately protected
```

## 5. OpenAPI terminology

В этой архитектуре:

```text
OpenAPI = specification format / contract artifact
```

Не использовать `Open API` как classification `public API`, чтобы не смешивать понятия.

## 6. REST как default HTTP style

Основной HTTP contract:

```text
HTTP/JSON + OpenAPI
```

Причины:

- понятный browser/generated-client path;
- простая Nginx migration/canary routing;
- удобный Hermes plugin mapping;
- обычные provider/adaptor semantics;
- высокий observability/debuggability;
- отсутствие необходимости добавлять второй query/runtime layer.

## 7. GraphQL policy

GraphQL **не используется по умолчанию**.

Не добавлять GraphQL только потому, что Control Tower хочет несколько видов данных. Сначала:

- specialized read model/projection;
- purpose-built grouped endpoint;
- REST query resources.

GraphQL требует ADR только после доказательства, что variation/query-composition pressure существенно превышает стоимость нового auth/cache/N+1/schema/runtime слоя.

## 8. SOAP policy

SOAP не используется внутри CoffeeOrderSystem.

Если внешний партнёр требует SOAP:

```text
Partner SOAP
    ↓
Provider Adapter/Gateway
    ↓
normal internal typed contract
```

SOAP DTO/semantics не должны проникать в Orders/Catalog/Payments domain.

## 9. gRPC policy

gRPC не является default internal transport. Ввести только при measured need для высокочастотного service-to-service RPC, streaming/binary contract или generated polyglot clients.

Kafka остаётся async backbone, HTTP остаётся default immediate RPC.

## 10. Database boundary

Запрещён паттерн:

```text
Service A -> SELECT/UPDATE service_b.tables
```

Cross-context API выполняется через:

1. local in-process/public module contract, пока contexts находятся в одном process;
2. explicit internal HTTP API, если service extracted;
3. Kafka event/API для asynchronous facts;
4. local projection/snapshot.

## 11. API ownership

Каждый endpoint/event имеет ровно одного contract owner:

```text
owner bounded context
actor
transport
version
schema
security classification
idempotency semantics
SLO
```

Без owner endpoint/topic не допускается в production.


## 12. API composition roots

`client-v1`, `agent-v1`, `internal-v1` реализуются отдельными `api-public`, `api-agent`, `api-internal` Node/Fastify processes. Общими остаются application/domain modules, а не HTTP process/trust boundary.
