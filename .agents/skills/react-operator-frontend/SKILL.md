---
name: react-operator-frontend
description: Создавать или проверять новую React SPA оператора CoffeeOrderPlatform, интеграцию с generated client-v1, server-state workflows, realtime-инвалидацию, доступность и browser tests.
---

# React-интерфейс оператора

Создавать новый frontend; legacy React служит только визуальным ориентиром.
Использовать React Router, TanStack Query, generated OpenAPI clients, доступные
формы и Playwright.

- Server owns identity, money, versions, business state, and `allowedActions`.
- Mutations carry idempotency and expected owner version.
- Render Problem Details and explicit conflict refresh choices.
- Model loading, empty, validation, unavailable, blocked, and UnknownOutcome.
- SSE invalidates/refetches; events are not browser truth.
- No blind retry for uncertain provider mutation.
- Preserve accessibility, CSP, deep links, and bundle budgets.

Прочитать `docs/launch/07_FRONTEND_CONTRACT.md`. Проверять generated-client
drift, types/lint/unit, mocks, Playwright, accessibility, CSP, deep links и SSE.
