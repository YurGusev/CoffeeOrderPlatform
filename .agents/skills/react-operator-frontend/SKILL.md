---
name: react-operator-frontend
description: Менять React UI оператора, client-v1 и server state.
---

# React-интерфейс оператора

Создавать новый frontend; legacy React служит только визуальным ориентиром.
Использовать React Router, TanStack Query, project-owned browser fetch client на
generated `client-v1` transport types, доступные формы и Playwright. Generated
SDK/client запрещён; runtime response validation обязательна.

- Server owns identity, money, versions, business state, and `allowedActions`.
- Mutations carry idempotency and expected owner version.
- Render Problem Details and explicit conflict refresh choices.
- Model loading, empty, validation, unavailable, blocked, and UnknownOutcome.
- SSE invalidates/refetches; events are not browser truth.
- No blind retry for uncertain provider mutation.
- Preserve accessibility, CSP, deep links, and bundle budgets.

Прочитать `docs/launch/07_FRONTEND_CONTRACT.md`. Проверять generated transport
types drift, project-owned client boundary, types/lint/unit, mocks, Playwright,
accessibility, CSP, deep links и SSE.

Для served-surface приёмки запускать `pnpm test:web-served-surface`: mock/Vite
Playwright не заменяет production nginx → Edge/API transport proof. Разделять
fixture OIDC/owners, default-clock login и отдельный injectable expiry scenario.

После fatal Order GET 403/404 проверять отдельно older HTTP 200 и equal-version
divergent response: второй сценарий не покрывает первый. HTTP success без принятой
проекции не снимает privacy barrier. Положительно проверять равный и новый owner
GET без повторной команды; `accepted === previous` допустим для равного ответа
и сам по себе не означает отсутствие подтверждённого owner recovery.
