---
name: react-operator-frontend
description: Создавать или проверять React SPA оператора CoffeeOrderPlatform на Effect Atom/AtomHttpApi, source client-v1 contract, server-state workflows, realtime-инвалидацию, доступность и browser tests.
---

# React-интерфейс оператора

Создавать новый frontend; legacy React служит только визуальным ориентиром.
Один Effect Runtime на browser tab предоставляет AtomHttpApi client из source
`client-v1` contract. Не добавлять TanStack Query, handwritten fetch client,
generated SDK/client или generated transport types. React Router и Playwright
не добавлять в foundation `#54`; их первый реальный caller — routes/browser
flow `#9`.

- Server owns identity, money, versions, business state, and `allowedActions`.
- Mutations carry idempotency and expected owner version.
- Render Problem Details and explicit conflict refresh choices.
- Model loading, empty, validation, unavailable, blocked, and UnknownOutcome.
- SSE invalidates/refetches; events are not browser truth.
- No blind retry for uncertain provider mutation.
- Preserve accessibility, CSP, deep links, and bundle budgets.

Прочитать `docs/launch/07_FRONTEND_CONTRACT.md`. Проверять Effect contract/artifact
drift, AtomHttpApi boundary, types/lint/unit, accessibility, CSP, deep links и
SSE; browser test обязателен только для существующего flow.
