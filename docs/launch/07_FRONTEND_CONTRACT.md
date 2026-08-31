# Frontend Contract

## Recommendation

Build a new React application against `client-v1`. Existing CoffeeOrderSystem
React is UX/reference material only; reuse visually independent components
after dependency review, not its API/state layer.

## Launch routes

```text
/app/customers
/app/catalog
/app/orders/new
/app/orders/:orderRef
```

## Order creation flow

1. select/create customer;
2. search persisted Catalog;
3. add product and request PricingQuote;
4. edit Draft;
5. confirm with expected version and idempotency key;
6. navigate to Order Card;
7. subscribe to SSE invalidations and refetch the owner resource.

## Required UI states

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

## Frontend foundation

- React Router;
- TanStack Query for server state;
- generated OpenAPI client;
- accessible forms and keyboard navigation;
- Playwright critical-path E2E;
- CSP and immutable static assets;
- API mocks generated from the same contracts for parallel frontend work.

