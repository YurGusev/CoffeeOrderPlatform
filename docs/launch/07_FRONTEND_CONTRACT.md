# Контракт frontend

## Authority и ownership

Первый запуск использует новую React SPA поверх `client-v1`; legacy
CoffeeOrderSystem остаётся только источником UX-наблюдений, не API/state слоя.
Техническую foundation задаёт [ADR-0027](../adr/ADR-0027-frontend-ui-foundation.md).
Визуальный ориентир всей SPA — [ADR-0029](../adr/ADR-0029-selected-frontend-prototype.md)
и versioned [прототип v1.1.0](../frontend/prototypes/invoice-orders-workspace/v1.1.0/README.md).
Светлые [SVG #136](../frontend/ux/README.md) ранее были приняты, но теперь
замещены как визуальный ориентир версией `v1.1.0`. Прототип — fixture/demo:
его invoice registry и payment drawer
не являются production route/API или browser/accessibility evidence.

- #137 владеет `packages/platform-ui` / `@coffee-platform/ui`, browser shell,
  разделением browser/Node graphs, React Aria behavior, Tailwind v4 styling,
  self-hosted Inter/Manrope font assets с source/hash/licence evidence и
  package-owned inline SVG icons.
- #9 владеет Router, одним `QueryClient`, project-owned `client-v1` transport с
  runtime response validation, forms/routes/recovery UX и static serving.
- #12 владеет одним `EventSource` на tab и invalidation/refetch lifecycle.
- #13 владеет итоговыми browser, accessibility, CSP, deep-link и release gates.

Прямые prerequisites #9 сохраняются без сокращения: #4, #5, #7, #8, #17, #18
и #119. Документы #136 не означают реализацию #9, #12 или #13.

## Маршруты первого запуска

```text
/app/customers
/app/catalog
/app/orders/new
/app/orders/:orderRef
```

Новые route не вводятся. Query parameters, exact page behavior и deep-link
semantics определяет [implementation spec](18_FRONTEND_IMPLEMENTATION_SPEC.md).
Каталог без заказа сразу показывает первую страницу доступных товаров для
просмотра; создание заказа начинается с выбора клиента.

## Сценарий создания заказа

1. select/create customer и перейти на New Order с выбранным `customerRef`;
2. явно создать Draft и открыть его Order Card;
3. из Draft открыть persisted Catalog, выбрать quantity, получить PricingQuote и
   добавить товар;
4. в Order Card изменить quantity существующей строки или удалить ошибочную
   строку;
5. confirm with expected version and idempotency key;
6. остаться на Order Card и наблюдать server state;
7. subscribe to SSE invalidations and refetch the owner resource.

## Обязательные состояния UI

- initial/loading, empty, validation и RFC 9457 Problem Details;
- stale quote с явным запросом нового quote;
- optimistic concurrency conflict с сохранением form input и explicit refresh;
- Draft и Confirmed, AROMA
  `NotRequested|PendingObservation|OutOfSync|Converging|InSync|Blocked|UnknownOutcome`;
- `Blocked` только с owner-provided reason;
- `UnknownOutcome` без blind retry button;
- provider unavailable, пока local Order остаётся durable;
- ambiguous Customer/Draft/Quote и pending intent after reload по
  [recovery protocol](26_BROWSER_COMMAND_RECOVERY.md).

Поздний GET/command/replay не откатывает `projectionVersion`; исторический
replay не заменяет current owner GET. Истёкшая lease/410 не разрешает повтор
эффекта или новый idempotency key. Сессии не делят cache, forms, pending commands
или `EventSource`.

## Server truth и client boundaries

Browser никогда не:

- вычисляет authoritative totals/money, выбирает actor identity или синтезирует
  business state/`allowedActions`;
- обращается к AROMA напрямую, использует provider URL/session/offer identifiers
  или принимает ownership writer-а;
- интерпретирует SSE payload как business truth;
- делает automatic mutation retry или выводит outcome по похожему resource.

`Order.version` используется только как expected version команд.
`OrderCard.projectionVersion` используется только для monotonic acceptance
GET/command/replay и SSE refetch; сравнивать их между собой запрещено.

## Foundation contract

`@coffee-platform/ui` — business-neutral presentation package. Он не импортирует
contracts/generated DTO, feature models, `fetch`, Router, Query, server/runtime,
SQL/Kafka или provider code. Browser graph не импортирует Node `main.ts` и
`@coffee-platform/runtime`; Node graph не импортирует browser entrypoint.

Точное владение прямыми dependencies:

- #137: `react`, `react-dom`, `@types/react`, `@types/react-dom`, `vite`,
  `react-aria-components`, `tailwindcss`, `@tailwindcss/vite`, `clsx`,
  `tailwind-merge`;
- #9: `react-router-dom`, `@tanstack/react-query`, project-owned `client-v1`
  transport/runtime validation.

Exact pins и compatibility checks остаются работой #137. Icon runtime, RHF,
Zod, Radix, Base UI, второй `QueryClient`, второй transport path и generated
SDK/client запрещены. Формы используют local React state; server validation
связывается по contract-defined `errors[].field` (`/displayName`, `/phone`,
`/email`, `/reason`); неизвестный field остаётся в общем Problem Details.

React Aria владеет semantic/keyboard/focus behavior; Tailwind v4 и tokens —
styling. Иконки `search`, `add`, `chevron`, `close`, `warning`, `refresh`
принадлежат package и встраиваются inline SVG. Typography — self-hosted
Inter Variable (body) и Manrope Variable (headings) из выбранного `v1.1.0`,
с source revision/SHA-256/licence evidence; remote font CDN запрещён.

Visual tokens берутся из `--cos-*` выбранного прототипа; behavior primitives,
keyboard/focus/reduced-motion rules и owner guards остаются обязательными.
Исторические цвета и IBM Plex Sans в [UX-документе #136](../frontend/ux/README.md)
не являются вторым visual contract. Status не передаётся только цветом;
motion отключается через `prefers-reduced-motion`; DOM/focus order совпадает
с visual order.

## Проверки реализации

#137 materialize-ит package/build boundary, pins, font/license evidence,
component behavior и architecture checks. #9 проверяет generated transport drift,
one-client boundary, runtime validation, routes/forms/Problem Details, one
`QueryClient`, mocks и bundle budgets. #12 проверяет EventSource/session
lifecycle. #13 наблюдает Playwright critical path, keyboard, screen reader,
contrast/target/reflow, reduced motion, CSP, immutable assets и deep links.
До этих проверок никакой WCAG/browser PASS не заявляется.
