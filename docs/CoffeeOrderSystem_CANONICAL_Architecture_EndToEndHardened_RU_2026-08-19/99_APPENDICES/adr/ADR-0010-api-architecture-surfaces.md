# ADR-0010 — Разделить API по actor/trust surface и transport

**Статус:** Accepted  
**Программа:** M19 API Architecture

## Решение

CoffeeOrderSystem не использует один универсальный `/api` для всех callers. Нормативные HTTP surfaces:

```text
/api/client-v1/*   React/browser
/api/agent-v1/*    Hermes CoffeeOrder plugin, private
/api/internal-v1/* internal workloads/control plane, private
```

External callbacks имеют отдельные exact webhook/channel routes, outbound AROMA/VK/PSP calls принадлежат provider adapters, Kafka topics/events являются versioned asynchronous APIs, realtime operator stream использует SSE по умолчанию.

OpenAPI является language-neutral HTTP contract description, а не типом «Open API».

## Причины

- разные actor/trust/authorization models;
- least privilege для Hermes;
- private internal API без accidental edge exposure;
- стабильный contract при C#→TypeScript strangler migration;
- единый versioning/compatibility layer для HTTP/event/webhook contracts;
- явные idempotency/UnknownOutcome semantics.

## Последствия

- нужен contract registry и CI compatibility;
- Nginx route inventory становится security artifact;
- generated React client перестаёт зависеть от ASP.NET `obj`;
- agent tools создаются только из approved capability allowlist;
- Kafka schema changes проходят API governance.

## Не выбрано

- один generic public `/api`;
- автоматический OpenAPI→all Hermes tools;
- GraphQL/gRPC/SOAP как default internal stack;
- cross-service DB access как integration contract.
