# Delivery Plan

## Goal

Produce a demonstrable, production-shaped vertical slice quickly while all
unsafe provider behavior remains fail-closed.

## Days 1-2: contracts and skeleton

- repository/app/package layout;
- OpenAPI and event schemas for launch routes/messages;
- Docker Compose with PostgreSQL, Kafka and observability;
- shared HTTP, DB, Outbox/Inbox, auth and telemetry runtimes;
- React shell and generated mock client.

## Days 3-5: Customer, Catalog, Pricing

- Customer create/search;
- safe full AROMA catalog snapshot through Gateway;
- persisted product/mapping/availability search;
- PricingQuote creation and validation;
- frontend customer/catalog/order-draft screens.

## Days 6-8: Orders

- Draft/items/version/history;
- quote/product snapshots;
- atomic Confirm + Desired + Outbox;
- Order Card and SSE invalidation;
- lifecycle, idempotency and concurrency tests.

## Days 9-11: AROMA cart

- Gateway session and typed operations;
- observer;
- preparation and convergence workers;
- lease/fencing/reservation/UnknownOutcome;
- GET-mutate-GET verification and recovery tests.

## Days 12-14: hardening and demo

- E2E browser flow;
- duplicate/crash/restart/provider-timeout tests;
- dashboards and alerts;
- backup/restore smoke;
- security review of credentials and public routes;
- operator demo with a controlled provider sandbox/account.

## Launch gates

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

## Parallel work

Frontend starts on day 1 from OpenAPI mocks. Backend and provider integration
develop independently against the same contracts. AROMA live mutation remains
disabled until safety/failure tests pass; safe catalog/cart reads can be
integrated earlier.

