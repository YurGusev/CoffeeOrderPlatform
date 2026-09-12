# Исполнимая спецификация React-интерфейса первого запуска

Статус: нормативная спецификация issue #9. Исполнитель не выбирает flow,
routes, query keys, mutation retry, conflict recovery или UI states заново.
[Восстановление browser commands](26_BROWSER_COMMAND_RECOVERY.md) определяет
read-only lookup, terminal outcomes и единый порядок принятия Order Card.
[ADR-0027](../adr/ADR-0027-frontend-ui-foundation.md) определяет foundation,
границу `@coffee-platform/ui` и dependency ownership; визуальные tokens и
editable mockups находятся в [UX-контракте](../frontend/ux/README.md).

## 1. Граница приложения

Приложение находится в `apps/web` и является новой React SPA. Project-owned
browser fetch client использует только generated `client-v1` transport types и
runtime response validation. Generated SDK/client, server/runtime imports, SQL,
provider clients и собственные копии request/response DTO запрещены.

#137 материализует `packages/platform-ui` / `@coffee-platform/ui`, browser shell,
раздельные browser/Node build graphs и прямые dependencies `react`, `react-dom`,
`@types/react`, `@types/react-dom`, `vite`, `react-aria-components`, `tailwindcss`,
`@tailwindcss/vite`, `clsx`, `tailwind-merge`. Exact pins и compatibility checks
остаются #137 work.

#9 принимает все прямые prerequisites #4/#5/#7/#8/#17/#18/#119 и владеет только
application dependencies `react-router-dom`, `@tanstack/react-query` и
project-owned `client-v1` transport/runtime validation. Icon runtime, RHF, Zod,
Radix, Base UI, второй `QueryClient`, второй transport path, generated SDK/client,
новая global state или API library запрещены. Input forms используют local React
state; React Aria задаёт behavior, а не второй contract/schema owner.

## 2. Файлы и модули

```text
apps/web/src/
  app/router.tsx
  app/query-client.ts
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
```

`api/client.ts` реализует project-owned browser fetch client: same-origin base
URL, credentials, correlation, AbortSignal и runtime response validation. Он
использует generated `client-v1` transport types; generated SDK/client и
handwritten endpoint types запрещены.

Feature application импортирует business-neutral primitives из
`@coffee-platform/ui`; локальный второй каталог UI primitives запрещён. Package
не импортирует feature models, contracts/generated DTO, Router/Query, `fetch`,
Node runtime или provider code. Package-owned inline SVG icons ограничены
`search|add|chevron|close|warning|refresh`.

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
- success принимает Order response через monotonic projectionVersion guard и показывает ссылку к Order Card;
- кнопка «К заказу» ведёт на `/app/orders/{orderRef}`.

### `/app/orders/:orderRef`

- показывает Customer snapshot, items, server totals, Order status, AROMA
  status/blockers и только server `allowedActions`;
- `edit-items` разрешает управление строками Draft в карточке и переход в каталог;
- изменение quantity существующей строки сохраняет её `itemRef`; кнопка
  «Получить цену и сохранить» сначала получает новую quote, а только после
  успешной quote выполняет PUT с последней `Order.version` и exact proof;
  соседние строки не меняются. При stale/failed quote PUT не выполняется.
  Новая строка получает новый `itemRef` только один раз на intent;
- удаление строки требует подтверждения, DELETE с прежним `itemRef`,
  `If-Match-Version` и одним key; после success обновляются server totals;
- изменение/удаление доступны только при server `edit-items`; conflict сохраняет
  unsent quantity и требует нового review. Confirmed edits принадлежат W3;
- `confirm` -> confirm dialog с текущей version, затем command;
- `request-aroma-reconciliation` -> только для Confirmed +
  `OutOfSync|Blocked|UnknownOutcome`: dialog с reason 1..500; Draft и
  Confirmed `PendingObservation|Converging|InSync` не показывают control;
- отсутствие action означает отсутствие кнопки; frontend не выводит её по
  собственному status mapping;
- после Confirm success `replace` остаётся на Order Card; response проходит
  тот же monotonic guard, что GET и replay. Старый ответ не откатывает карточку.

## 4. TanStack Query

Query keys:

```text
['customers','search',{q,cursor,limit:20}]
['catalog','search',{orderRef,q,availability,cursor,limit:20}]
['orders','detail',orderRef]
```

Keys строятся только helper-функциями. Search input debounce `300 ms`, но API
запрос выполняется по submit или изменению committed URL state, не на каждый
keypress. Previous page data не показывается как результат нового query.

- Customer/Catalog `staleTime=30_000`, `gcTime=300_000`;
- Order `staleTime=0`, `gcTime=300_000`;
- GET retry: максимум 1 только для network/502/503/504, delay 500 ms;
- 4xx не ретраятся;
- mutations: `retry=false` без исключений;
- `refetchOnWindowFocus=false` для всех четырёх страниц;
- #12 позже инвалидирует `['orders','detail',orderRef]` по SSE; #9 не
  интерпретирует SSE payload как business state.

#12 добавляет один EventSource на tab. `resource-invalidated.v1` инвалидирует
только exact Order query; `stream-reset.v1` инвалидирует только существующие
Order detail queries. Cache принимает только schema-valid owner GET/command response через общий
monotonic guard; SSE payload никогда не записывается в cache.

## 5. Idempotency и версия

На один user intent один раз создаётся `crypto.randomUUID()`. Versioned
sessionStorage хранит только key/method/path/fingerprint/createdAt/state под
ключом UUID intent; body, PII, credentials, цены и quote payload запрещены.
Pre-resource Customer/Draft/Quote не требуют неизвестного resourceRef.

Ambiguous response, expired lease и `IDEMPOTENCY_REQUEST_IN_PROGRESS` сохраняют
pending key. «Проверить результат команды» делает bodyless read-only lookup
по [единому протоколу](26_BROWSER_COMMAND_RECOVERY.md), в том числе после reload.
Нет автоматического replay, нового key из-за timeout или вывода об исходе по
похожему состоянию карточки. Terminal classifier учитывает operation mode/code,
а не весь класс HTTP 4xx. Lookup 410/503/invalid-result не разрешает новый intent.

Каждый GET/command/replay сравнивается по `OrderCard.projectionVersion`; поздний
старый response не заменяет новый. Completed lookup закрывает intent, после
чего exact owner GET обновляет карточку; свежесть и результат команды различны.

PUT/DELETE/Confirm берут expected version только из последнего успешного Order
response. При `ORDER_VERSION_CONFLICT`:

1. mutation не повторяется;
2. показать modal с server correlation id;
3. `invalidateQueries` + exact refetch Order;
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
| `IDEMPOTENCY_REQUEST_IN_PROGRESS` | сохранить pending key; «Проверить результат команды», без новой команды |
| `IDEMPOTENCY_RESULT_NOT_RETAINED` | unresolved intent; owner recovery, без нового key |
| `IDEMPOTENCY_LOOKUP_UNAVAILABLE` / `IDEMPOTENCY_RESULT_INVALID` | сохранить pending key, безопасная ошибка и correlation id |
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

## 8. Формы, primitives, focus и narrow layout

Public props/events/ref/composition, validation, pending, dismissal и focus для
`Button`, `Link`, `Dialog`, `Field/Input`, `Alert`, `Badge`, `Loading`, `Empty`
зафиксированы в таблице [UX-контракта](../frontend/ux/README.md). #137 реализует
этот API без второго локального набора primitives; #9 композирует business forms,
Router и Query поверх него.

- visual contract один: operational/restrained console, IBM Plex Sans с
  Russian/Cyrillic, self-hosted будущим #137 WOFF2 через
  `@font-face`/`font-display: swap` и OFL/source revision/SHA-256 evidence;
  remote font CDN запрещён;
- colors, 4px spacing scale, 36/40/44px control sizes, 6px radius, 1px border и
  2px `#1D4ED8` focus ring берутся без переопределения из UX-контракта; status не
  передаётся только цветом;
- каждый input имеет visible `<label>` и связанный error через
  `aria-describedby`;
- после failed submit field `VALIDATION_FAILED` фокус получает первое invalid
  поле в DOM order; summary объявляется, но получает programmatic focus только
  если `errors[].pointer` не даёт focusable field target;
- Customer create dialog: initial focus на первом пустом required поле; return на
  «Создать клиента», а после success route focus переходит на `<h1>` New Order;
- Confirm dialog: initial focus на «Отмена»; return на «Подтвердить заказ»;
- delete-item dialog: initial focus на «Отмена»; return на trigger «Удалить», а
  после удаления строки — на heading «Позиции»;
- reconciliation dialog: initial focus на поле reason; его validation 1..500
  фокусирует это поле; return на «Проверить синхронизацию»;
- conflict dialog: initial focus на heading, unsent input сохраняется; после exact
  refetch focus возвращается к исходному action для явного нового intent;
- dialog использует focus trap и `aria-modal=true`; Escape/outside close допустим
  только без pending command и без потери unsent input, иначе требуется explicit
  cancel/stay action;
- loading после действия использует `aria-busy`; кнопка блокируется только для
  текущей mutation; результат/ошибка объявляется `role=status`/`role=alert` без
  повторяющегося screen-reader spam;
- порядок Tab соответствует DOM; drag-only/hover-only controls запрещены; focus
  после route navigation переходит на `<h1>`;
- motion ограничен state/causality, 150ms ease-out и отключается через
  `prefers-reduced-motion`;
- money форматируется `Intl.NumberFormat('ru-RU',{style:'currency',currency:'RUB'})`
  только из authoritative minor-unit decimal string через bigint-safe helper.

Responsive contract имеет ровно три диапазона, подробно определённые в
UX-контракте и обязательные для #137/#9:

- `375–767px`: верхняя modal navigation вместо sidebar; Customers/Catalog/Order
  tables становятся карточками без изменения DOM order; dialog имеет
  `width:calc(100vw - 32px)` и внутренний vertical scroll; action bar sticky и
  складывается в одну колонку; page horizontal overflow запрещён;
- `768–1279px`: compact top navigation; secondary cell metadata переносится, но
  quantity/actions не скрываются; dialog не шире `min(640px, calc(100vw - 48px))`;
  action bars wrap; только table wrapper может иметь keyboard-accessible
  horizontal scroll;
- `>=1280px`: постоянная sidebar, полные columns, inline action bars; command
  dialogs не шире 640px, Customer dialog — 1000px; обязательный action text не
  обрезается и не заменяется ellipsis.

Widths 375, 768 и 1280, а также 400% zoom/reflow наблюдает #13. Эти требования не
являются заявлением WCAG/browser PASS до materialized UI и фактических проверок.

### #137 package/build handoff for #9

`#9` imports presentation primitives only from `@coffee-platform/ui` and imports
the package stylesheet as `@coffee-platform/ui/styles.css`; it does not create a
second `apps/web/src/shared/ui` implementation. The supported foundation API and
native ref contracts are documented in `packages/platform-ui/README.md`.

The local browser workflow is `pnpm dev:browser`; the deterministic production
workflow is `pnpm web:build`, which first builds `@coffee-platform/ui` and then
emits `apps/web/dist/browser`. The existing Node entry remains a separate
`apps/web/dist/main.js` artifact. Generated `dist` output is verification-only.
Scenario-only invalid/disabled/dirty/pending Dialog states belong to the
test-only Vite harness under `apps/web/test`; production `App` remains neutral.
`pnpm browser:bundle:check` measures and fails on the summed gzip size of the
production initial JS files at the `250 KiB` budget; the observed baseline is
recorded in handoff #137.

## 9. Доставка и граница сессии

#9 материализует `GET /app/** -> web:3000` по runtime profile: Edge передаёт
SPA document, web возвращает index.html для app deep links. `/` ведёт в Customer
flow. Отсутствующий `/assets/**` возвращает 404, API/events/internal/provider paths
никогда не получают HTML fallback. HTML revalidation/no-store и immutable hashed
assets проверяются в image/Compose; наличие health endpoint не доказывает SPA.
Node entrypoint и browser entrypoint имеют раздельные build graphs; browser не
импортирует текущий server `main.ts`/platform-runtime.

При logout/смене пользователя отменить pending reads, очистить query/mutation
cache, формы и sessionStorage; поздние responses прошлой сессии отбрасываются.
401 немедленно скрывает защищённые данные. Pending intent не исполняется после
reauth автоматически; потеря local recovery при выходе явно объясняется согласно
[recovery policy](26_BROWSER_COMMAND_RECOVERY.md). Login return URL допускает
только локальный `/app/` path. #12 связывает EventSource с тем же lifecycle.

## 10. Тесты

- component tests каждого route: initial/loading/empty/success/all mapped errors;
- generated MSW fixtures only; handwritten response DTO запрещён lint rule;
- Query tests exact keys/retry/staleTime и запрет mutation retry;
- idempotency: потерянные Customer/Draft/Quote response, reload до resourceRef,
  read-only recovery без body/owner writes, non-terminal 409/410/503;
- Draft item: изменить quantity с прежним itemRef, удалить строку, отменить dialog,
  conflict/duplicate click/ambiguous delete не теряет intent и соседние строки;
- late GET/replay не откатывает projectionVersion; stale session response отброшен;
- conflict test доказывает refetch, сохранение form value и отсутствие auto replay;
- exhaustive enum/action compile tests;
- axe: 0 serious/critical violations для каждой страницы/dialog/state;
- keyboard-only flow Customer -> Draft -> Catalog -> item -> Confirm -> Card;
- Playwright: happy path, create Customer, empty results, stale quote, version
  conflict, unavailable services, Blocked и UnknownOutcome;
- deep-link/reload каждого route через Edge; missing asset/API не возвращает HTML;
- logout/401/session switch очищает private cache и не повторяет pending commands;
- bundle/architecture/CSP scan: no secrets, server imports, provider URL,
  fetch вне project-owned api/client.ts, Axios, DB/Kafka values;
- bundle budgets: initial JS gzip <=250 KiB, route chunk <=150 KiB; превышение
  требует отдельного issue/решения, а не поднятия лимита в #9.

## 11. Не входит

Создание второго design system вне принадлежащего #137 `@coffee-platform/ui`,
global state library, offline mutations, optimistic business updates, automatic
mutation retry, admin/analytics/Work Center, AROMA calls, client-side
price/action calculation и перенос legacy API/state кода не входят. Эта
спецификация не означает, что #9, #12 или #13 уже реализованы.
