# План реализации

## Цель

Быстро получить демонстрируемый вертикальный срез, построенный по production-
принципам, при этом любое небезопасное поведение провайдера закрывается отказом.

## Порядок поставки

Точные prerequisites и владельцы заданы в
[delivery graph](13_DELIVERY_DEPENDENCY_GRAPH.md). Календарные оценки не являются
критерием готовности или основанием пропускать gates.

1. Recovery #60, затем контракты #4 и независимое runtime/database hardening.
2. Durable delivery foundation до первого owner Outbox/Inbox; Customer и Gateway
   используют принятые HTTP/DB handoffs.
3. Catalog staging → activation → API → capacity evidence → Pricing.
4. Orders Draft/Confirm → React → fenced convergence → Realtime.
5. Operations материализует observability до полного launch verification #13.

## Условия допуска к запуску

- no public `internal-v1` or Gateway route;
- Confirm contains no provider/network call;
- no blind retry after unsafe mutation timeout;
- duplicate messages and commands have no duplicate business effect;
- stale fence cannot mutate/persist success;
- source/export amounts and versions use decimal strings;
- OpenAPI, event schemas, integration tests and Playwright pass;
- every runtime has health, metrics, trace and graceful shutdown;
- rollback is disabling convergence mutation while preserving observer and
  all durable Order/attempt state.

## Параллельная работа

Frontend #9 использует принятые contracts/mocks #4 и provider handoffs по graph.
Contract-only работа может идти параллельно runtime hardening после #60. Живая мутация
AROMA остаётся выключенной до успешных safety/failure tests; безопасные чтения
каталога и корзины можно подключить раньше.
