# Контракт frontend

## Рекомендация

Создать новое React-приложение поверх `client-v1`. React из CoffeeOrderSystem
используется только как источник UX-решений. После проверки зависимостей можно
брать визуально независимые компоненты, но не его API/state слой.

## Маршруты первого запуска

```text
/app/customers
/app/catalog
/app/orders/new
/app/orders/:orderRef
```

## Сценарий создания заказа

1. select/create customer;
2. search persisted Catalog;
3. add product and request PricingQuote;
4. edit Draft;
5. confirm with expected version and idempotency key;
6. navigate to Order Card;
7. subscribe to SSE invalidations and refetch the owner resource.

## Обязательные состояния UI

- loading, empty, validation and Problem Details;
- stale quote;
- optimistic concurrency conflict with explicit refresh;
- pending Catalog proof;
- AROMA OutOfSync/Converging/InSync;
- Blocked with owner-provided reason;
- UnknownOutcome with no blind retry button;
- provider unavailable while local Order remains durable.

The browser never calculates authoritative totals, selects actor identity,
calls AROMA directly or synthesizes allowed actions.

## Основа frontend

- React Router;
- TanStack Query for server state;
- generated OpenAPI client;
- accessible forms and keyboard navigation;
- Playwright critical-path E2E;
- CSP and immutable static assets;
- API mocks generated from the same contracts for parallel frontend work.
