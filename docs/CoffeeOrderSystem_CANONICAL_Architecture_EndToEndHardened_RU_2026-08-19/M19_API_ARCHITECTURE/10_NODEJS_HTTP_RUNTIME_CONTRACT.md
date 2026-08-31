# M19. Node.js HTTP Runtime Contract

## 1. Physical separation of API audiences

Нормативная target topology:

```text
api-public
  /api/client-v1/*

api-agent
  /api/agent-v1/*

api-internal
  /api/internal-v1/*
```

Это три отдельных Node/Fastify composition roots и deployment roles. Они используют общие application modules, но не общий route inventory/secrets/network exposure.

## 2. Public edge routing

Nginx публикует только `api-public` и exact provider callbacks. `api-agent` и `api-internal` не имеют generic public upstream path.

## 3. Fastify factory

Все HTTP apps создаются через один `platform/packages/http-runtime` factory, который задаёт:

- explicit trusted proxy chain;
- request/handler/body limits;
- request ID/correlation;
- OpenTelemetry;
- runtime JSON schemas;
- canonical ProblemDetails/error mapper;
- graceful shutdown;
- no route without response schema policy where feasible.

## 4. Runtime validation / serialization

Fastify JSON Schema используется для:

```text
params
query
headers where contract requires
body
response
```

Response schema — security boundary: projection не может случайно сериализовать весь DB object.

`agent-v1` customer resolve, например, возвращает только approved fields.

## 5. Async checks после shape validation

DB/service auth/domain lookup не выполняются внутри primary Ajv schema validation. Сначала проверяется shape, затем auth/preHandler/application use case.

## 6. Deadline propagation

HTTP handler создаёт/получает `AbortSignal` и передаёт его в application use case и downstream clients. Disconnect/timeout не должен оставлять неограниченную background работу.

Unsafe side effect после network uncertainty всё равно следует domain `UnknownOutcome`/idempotency rules; cancellation не является proof, что provider ничего не сделал.

## 7. Body size policy

Small default body limit на server. Большие upload routes имеют explicit override и отдельный processing pipeline.

Не использовать global 100MB limit для всего API.

## 8. Trust proxy

`trustProxy: true` запрещён как blanket production setting. Разрешён только exact Nginx/Ingress CIDR/hop/function configuration.

Forwarded IP/host/proto не используются как authorization authority без отдельной validation.

## 9. HTTP client boundary

Route/application code не делает arbitrary `fetch()` к provider. Использует typed provider client с fixed origin, pool, deadlines, metrics и error mapping.

## 10. ProblemDetails/error contract

Все три API surfaces сохраняют canonical categories:

```text
400 Validation
401 Unauthorized
403 Forbidden
404 NotFound
409 Conflict
429 RateLimited
5xx ExternalDependency/Internal
UnknownOutcome -> explicit stable application errorCode/status mapping
```

Точный HTTP status для конкретного UnknownOutcome определяется contract, но client никогда не получает инструкцию blind retry unsafe mutation.

## 11. Shutdown

API readiness снимается до `Fastify.close()`. После HTTP drain закрываются PostgreSQL/provider clients и telemetry exporter.
