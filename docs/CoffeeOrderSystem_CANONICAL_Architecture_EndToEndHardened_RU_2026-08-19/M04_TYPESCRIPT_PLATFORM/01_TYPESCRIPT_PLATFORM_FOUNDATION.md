# M04. TypeScript Platform Foundation

## 1. Нормативный baseline

```text
Node.js 24 LTS
TypeScript strict
pnpm workspace
Fastify-first HTTP runtime
PostgreSQL: node-postgres + один выбранный typed SQL toolkit + raw SQL escape hatch
Kafka: @confluentinc/kafka-javascript после P0 compatibility spike
OpenTelemetry
JSON Schema/OpenAPI runtime contracts
Vitest + integration/contract/load tests
```

Отдельный полный Node contract: [06_NODEJS_RUNTIME_ARCHITECTURE.md](06_NODEJS_RUNTIME_ARCHITECTURE.md).

## 2. Framework decision

Fastify — baseline. NestJS не входит в target foundation по умолчанию и требует отдельного ADR.

Цель — не смешивать собственную модульную структуру `apps/modules/packages` со вторым heavyweight framework module/DI layer без доказанной необходимости.

## 3. Strict compiler

Минимум:

```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true
  }
}
```

`any` запрещён без локально документированного исключения.

## 4. Runtime validation

TypeScript types не валидируют network data. Все external inputs проходят runtime validation:

```text
HTTP
Kafka
VK
Hermes
AROMA
Payment webhooks/provider responses
```

Fastify routes используют request + response JSON Schemas; Kafka/webhook contracts — canonical versioned schemas.

## 5. Money

Domain:

```text
amountMinor: bigint
```

Wire JSON/Kafka:

```text
amountMinor: decimal string
currency: RUB
```

Raw BigInt не сериализуется как обычный JSON field. Floating JS `number` не является money type.

## 6. Dates/time

```text
instant -> ISO UTC string
calendar date -> YYYY-MM-DD
local business time -> value + explicit timezone
```

## 7. Database access

- одна transaction = один acquired PostgreSQL client;
- общий `withTransaction` primitive;
- explicit pool/connection budget на fleet;
- raw SQL допускается для CTE/locks/fencing/reconciliation;
- cross-context DB access запрещён ownership tests;
- один SQL toolkit выбирается ADR до массовой реализации.

## 8. API runtime roles

Логические surfaces становятся отдельными composition roots:

```text
apps/api-public
apps/api-agent
apps/api-internal
```

Подробности — M19.

## 9. Event loop

CPU-heavy и unbounded sync work не выполняются на request/consumer event loop. Document transforms, ML и тяжёлые вычисления идут в отдельные worker workloads или bounded Worker Thread pool после benchmark.

## 10. Cancellation/deadline

Application use cases принимают `AbortSignal`/deadline context. Timeout не считается полноценным, если downstream работа продолжает бесконтрольно выполняться.

## 11. Error model

Canonical errors:

```text
Validation
NotFound
Conflict
Forbidden
Unauthorized
RateLimited
ExternalDependency
UnknownOutcome
Internal
```

Adapters mapping выполняют на boundary.

## 12. Request context

Async context хранит только technical metadata:

```text
traceId
correlationId
actor/service identity
requestId
deadline
```

Не хранить global mutable Customer/Order/transaction objects.

## 13. Network clients

Application code не использует произвольный `fetch`. Все provider calls идут через typed fixed-origin clients с bounded connection pools, deadlines, telemetry и error mapping.

## 14. Process model

```text
one Node process = one container/pod role
```

PM2/node cluster внутри обычных target containers запрещён.
