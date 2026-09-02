# Исполнимая спецификация React-интерфейса первого запуска

Технический путь: один browser Effect runtime с `AtomHttpApi` из source
`client-v1` contract; URL/form state и business semantics ниже не изменяются.

Статус: нормативная спецификация issue #9. Исполнитель не выбирает flow,
routes, atom identities, mutation retry, conflict recovery или UI states заново.

## 1. Граница приложения

Приложение находится в `apps/web` и является новой React SPA. Browser client
использует source `client-v1` Effect Schema/HttpApi contract через
`@effect/atom-react`/`AtomHttpApi`; generated OpenAPI/JSON Schema являются только
производными artifacts. Generated SDK/client, server/runtime imports, SQL,
provider clients и собственные копии request/response DTO запрещены.

Разрешённые зависимости и версии берутся только из
`config/toolchain-versions.json`/lockfile #3: React, React Router,
`@effect/atom-react`/`AtomHttpApi`, form/schema adapter и testing stack. Новая
state library, design system или API library в #9 не добавляется.

## 2. Файлы и модули

```text
apps/web/src/
  app/router.tsx
  app/atom-runtime.ts
  api/client.ts
  api/problem-details.ts
  api/idempotency.ts
  routes/customers-page.tsx
  routes/new-order-page.tsx
  routes/catalog-page.tsx
  routes/order-card-page.tsx
  features/customers/**
  features/catalog/**
  features/pricing/**
  features/orders/**
  shared/ui/{alert,button,dialog,field,spinner}.tsx
```

`api/client.ts` собирает typed `AtomHttpApi` client из source `client-v1` Effect
Schema/HttpApi contract: same-origin base URL, credentials, correlation,
AbortSignal и runtime decode/encode. Generated SDK/client и handwritten endpoint
types запрещены.

## 3. Маршруты и переходы

### `/app/customers`

- URL state: `q` и optional opaque `cursor`;
- форма поиска: label «Поиск клиента», submit, query 2..200;
- initial state не вызывает API до 2 символов и показывает инструкцию;
- result row показывает только server response и кнопку «Выбрать»;
- «Выбрать» ведёт на `/app/orders/new?customerRef=<ref>`;
- создание открывает dialog с точными Customer fields; успешный POST закрывает
  dialog, объявляет результат и ведёт на тот же new-order route;
- cursor управляется кнопками, не infinite scroll.

### `/app/orders/new`

- требует один valid `customerRef`; отсутствующий/invalid -> link назад и
  локальная route error, API command не выполняется;
- GET Customer повторно не вызывается: экран показывает ref и предупреждает,
  что owner проверит Customer;
- кнопка «Создать черновик» один раз вызывает POST Draft;
- success заменяет history на `/app/orders/{orderRef}`;
- browser back не повторяет команду.

### `/app/catalog?orderRef=<ref>`

- требует Order Card status `Draft`; иначе redirect на Order Card с alert;
- CustomerRef берётся только из Order Card, не из URL/local storage;
- URL state: `orderRef`, `q`, `availability`, optional `cursor`;
- result row показывает owner Catalog fields, quantity input и «Добавить»;
- #9 запрашивает PricingQuote ровно для одной строки;
- после quote success выполняет PUT item с generated `itemRef`, текущей
  command `Order.version` и exact quote proof; authoritative money не пересчитывается;

Frontend хранит две независимые версии: `Order.version` используется только в
`expectedVersion` команд, `OrderCard.projectionVersion` — только для SSE
dedup/refetch. Сравнивать их между собой запрещено. `MAPPING_CHANGED` показывает
blocked state без blind retry и предлагает создать новый Draft/quote.
- success обновляет Order cache response и показывает ссылку к Order Card;
- кнопка «К заказу» ведёт на `/app/orders/{orderRef}`.

### `/app/orders/:orderRef`

- показывает Customer snapshot, items, server totals, Order status, AROMA
  status/blockers и только server `allowedActions`;
- `edit-items` -> `/app/catalog?orderRef=...`;
- `confirm` -> confirm dialog с текущей version, затем command;
- `request-aroma-reconciliation` -> dialog с reason 1..500;
- отсутствие action означает отсутствие кнопки; frontend не выводит её по
  собственному status mapping;
- после Confirm success `replace` остаётся на Order Card и cache заменяется
  response команды.

## 4. AtomHttpApi server state

Atom identities:

```text
customerSearchAtom({q,cursor,limit:20})
catalogSearchAtom({q,availability,cursor,limit:20})
orderDetailAtom(orderRef)
```

Atom identities строятся только helper-функциями. Search input debounce `300 ms`,
но API запрос выполняется по submit или изменению committed URL state, не на
каждый keypress. Previous page data не показывается как результат нового atom.

- Customer/Catalog atoms stale after `30_000 ms`, retained `300_000 ms`;
- Order atom stale immediately, retained `300_000 ms`;
- AtomHttpApi GET retry: максимум 1 только для network/502/503/504, delay 500 ms;
- 4xx не ретраятся;
- AtomHttpApi mutations не ретраятся без исключений;
- window focus не запускает автоматическое обновление ни для одной из четырёх страниц;
- #12 позже инвалидирует exact `orderDetailAtom(orderRef)` по SSE; #9 не
  интерпретирует SSE payload как business state.

#12 добавляет один EventSource на tab. `resource-invalidated.v1` инвалидирует
только exact `orderDetailAtom(orderRef)`; `stream-reset.v1` инвалидирует только
существующие Order detail atoms. Cache изменяется исключительно результатом
owner GET.

## 5. Idempotency и версия

Для каждого нажатия command создаётся `crypto.randomUUID()` один раз. Запись
`{intentFingerprint,key,startedAt}` хранится в `sessionStorage` под
`coffee.command.<route>.<resourceRef>` до определённого результата.

- timeout/network/502/503/504 считается ambiguous: кнопка автоматического
  повтора отсутствует; UI предлагает «Проверить состояние»;
- проверка делает owner GET; если эффект виден, запись удаляется;
- если эффект не виден, кнопка «Повторить тот же запрос» использует тот же key;
- definitive 2xx/4xx удаляет запись;
- другой intent никогда не использует старый key;
- secret, Authorization, request/response body и PII в storage не пишутся.

PUT/DELETE/Confirm берут expected version только из последнего успешного Order
response. При `ORDER_VERSION_CONFLICT`:

1. mutation не повторяется;
2. показать modal с server correlation id;
3. invalidate exact `orderDetailAtom(orderRef)` + refetch Order;
4. сохранить только пользовательский quantity/reason как unsent form value;
5. после refetch пользователь заново нажимает action; создаются новый intent key
   и новая expected version.

## 6. UI states и Problem Details

Каждый route имеет четыре взаимоисключающих render states: initial/loading,
success (включая empty), recoverable error, route-fatal error. Старые данные не
маскируют fatal auth/not-found.

| Code/ситуация | Точный UI |
|---|---|
| field `VALIDATION_FAILED` | inline errors по `errors[].pointer`, focus первого поля |
| `IDEMPOTENCY_CONFLICT` | alert «Этот ключ уже использован для другой команды», без retry |
| `IDEMPOTENCY_REQUEST_IN_PROGRESS` | alert + «Проверить состояние», без новой команды |
| `ORDER_VERSION_CONFLICT` | conflict modal и алгоритм раздела 5 |
| `ORDER_QUOTE_STALE` / `PRICING_QUOTE_EXPIRED` | сохранить product/quantity, вернуть в Catalog, запросить новую quote только по кнопке |
| `CATALOG_REVISION_CHANGED` | refetch Catalog, снять выбор устаревшей строки |
| `CUSTOMER_UNAVAILABLE|CATALOG_UNAVAILABLE|PRICING_POLICY_UNAVAILABLE` | owner unavailable alert, local Draft не очищать |
| `AROMA_PROVIDER_UNAVAILABLE` | Order Card остаётся видимым; status/blockers owner response, mutation-кнопку не добавлять |
| 401 | перейти на configured login route с return URL |
| 403 | экран «Недостаточно прав», без повторов |
| 404 Order | route not-found с link к Customer flow |
| malformed/non-Problem error | generic error + correlation id, technical body не показывать |

## 7. Order Card state

Frontend отображает label/description для точного server enum:

- `NotRequested` — «Синхронизация не запрошена»;
- `PendingObservation` — «Ожидается чтение корзины»;
- `OutOfSync` — «Корзина отличается»;
- `Converging` — «Корзина синхронизируется»;
- `InSync` — «Корзина синхронизирована»;
- `Blocked` — «Синхронизация заблокирована»;
- `UnknownOutcome` — «Результат изменения неизвестен».

`PendingCatalogProof` не существует в актуальном contract и запрещён exhaustive
TypeScript check. Blocker message/code показывает server response. Для
`UnknownOutcome` нет кнопки «Повторить изменение»; возможна только
server-provided reconciliation action.

`allowedActions` проходит exhaustive renderer:
`edit-items|confirm|request-aroma-reconciliation`. Неизвестное значение
логируется как contract violation, но не создаёт кнопку. Статус Order/AROMA не
используется для самостоятельного разрешения action.

## 8. Формы и доступность

- каждый input имеет visible `<label>` и связанный error через
  `aria-describedby`;
- submit доступен Enter, cancel Escape только когда не теряет committed state;
- dialog: focus trap, initial focus на heading/первое поле, возврат focus на
  trigger, `aria-modal=true`;
- loading после действия использует `aria-busy`; кнопка блокируется только для
  текущей mutation;
- результат/ошибка объявляется `role=status`/`role=alert`, без повторяющегося
  screen-reader spam;
- порядок Tab соответствует DOM; drag-only/hover-only controls запрещены;
- focus после route navigation переходит на `<h1>`;
- WCAG 2.2 AA contrast, target size и visible focus;
- money форматируется `Intl.NumberFormat('ru-RU',{style:'currency',currency:'RUB'})`
  только из authoritative minor-unit decimal string через bigint-safe helper.

## 9. Тесты

- component tests каждого route: initial/loading/empty/success/all mapped errors;
- generated MSW fixtures only; handwritten response DTO запрещён lint rule;
- Atom tests exact identities/retry/retention и запрет mutation retry;
- idempotency tests ambiguous response/same-key retry/new-intent key;
- conflict test доказывает refetch, сохранение form value и отсутствие auto replay;
- exhaustive enum/action compile tests;
- axe: 0 serious/critical violations для каждой страницы/dialog/state;
- keyboard-only flow Customer -> Draft -> Catalog -> item -> Confirm -> Card;
- Playwright: happy path, create Customer, empty results, stale quote, version
  conflict, unavailable services, Blocked и UnknownOutcome;
- deep-link/reload для каждого route;
- bundle/architecture/CSP scan: no secrets, server imports, provider URL,
  handwritten fetch/axios, DB/Kafka values;
- bundle budgets: initial JS gzip <=250 KiB, route chunk <=150 KiB; превышение
  требует отдельного issue/решения, а не поднятия лимита в #9.

## 10. Не входит

Design system, global state library, offline mutations, optimistic business
updates, automatic mutation retry, admin/analytics/Work Center, AROMA calls,
client-side price/action calculation и перенос legacy API/state кода не входят.
