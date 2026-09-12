# UX-контракт операторского frontend

Статус: принято владельцем для реализации #137; спецификация #136 для реализации #9/#12 и проверки #13.
SVG — редактируемые XML-макеты с вымышленными данными, а не executable frontend,
новые routes, API/schema, runtime или доказательство browser/WCAG.

Architecture authority: [ADR-0027](../../adr/ADR-0027-frontend-ui-foundation.md).
Business/wire authority остаётся в [frontend contract](../../launch/07_FRONTEND_CONTRACT.md),
[implementation spec](../../launch/18_FRONTEND_IMPLEMENTATION_SPEC.md),
[client-v1 catalog](../../launch/12_LAUNCH_CONTRACT_CATALOG.md) и
[recovery protocol](../../launch/26_BROWSER_COMMAND_RECOVERY.md). При расхождении
макета с ними действует нормативный документ или contract.

## Файлы и покрытие

| Файл | Нормативный экран | Что показано |
|---|---|---|
| [customers.svg](customers.svg) | `/app/customers` | поиск, cursor pagination, прямой выбор клиента и dialog создания с нормативными полями/inline errors |
| [new-order.svg](new-order.svg) | `/app/orders/new` | pre-Draft context клиента, missing/invalid customerRef, явное создание Draft, loading/error и ambiguous recovery до появления orderRef |
| [catalog.svg](catalog.svg) | `/app/catalog?orderRef=<ref>` | Order context, persisted Catalog, cursor pagination, quantity, добавление и возврат к Order Card |
| [order-card.svg](order-card.svg) | `/app/orders/:orderRef` | Draft editing, server totals, Confirm, delete/reconciliation dialogs, server states и recovery |

Все имена, refs, timestamps и значения вымышлены. Денежные строки — только server
values: макеты не задают формулы, округление или browser calculations. Показанные
routes уже существуют в launch authority; новые route и поля не вводятся.

## Экранные потоки и фокус

| Control | Действие / contract | Route после успеха | Следующий focus |
|---|---|---|---|
| Customers «Выбрать» | взять exact `customerRef` выбранной строки | `/app/orders/new?customerRef=<ref>` без промежуточного шага | `<h1>` New Order |
| Customers «Создать клиента» | открыть dialog; `POST /api/client-v1/customers` с `displayName` и хотя бы одним из `phone|email`, optional `address` | тот же New Order route с созданным ref | при success `<h1>` New Order; при ошибке первое invalid field |
| New Order «Создать черновик» | один `POST /api/client-v1/orders/drafts` с customerRef и одним idempotency intent | history `replace` на `/app/orders/<orderRef>` | `<h1>` Order Card |
| New Order «Проверить результат» | bodyless read-only lookup прежнего intent; не новая команда | при подтверждённом success — Order Card, иначе экран остаётся | alert результата, затем безопасная ссылка/действие |
| Catalog «Добавить» | одна quote для строки, затем PUT item с quantity, новым itemRef, expected Order.version и proof | экран остаётся; «К заказу» ведёт на `/app/orders/<orderRef>` | status добавления; затем trigger «К заказу» |
| Order Card «Получить цену и сохранить» | одна команда: получить quote для текущего quantity; только после успешной quote выполнить PUT с прежним `itemRef`, последней `Order.version` и exact proof | текущая Order Card | status результата или первое invalid field; при stale/failed quote PUT не выполняется |
| Order Card «Удалить» | открыть delete dialog; после подтверждения DELETE item | текущая Order Card | trigger удалённой строки, а если его больше нет — heading «Позиции» |
| Order Card «Подтвердить заказ» | открыть Confirm dialog; затем confirm command | `replace` текущей Order Card | status результата и затем `<h1>` |
| Order Card «Проверить синхронизацию» | только для Confirmed + `OutOfSync|Blocked|UnknownOutcome`: открыть dialog; reason 1..500; затем server command; «Отмена» закрывает dialog без command | текущая Order Card | trigger, после success — status синхронизации |

New Order заканчивается созданием пустого Draft. До успешного ответа на нём нет
orderRef, version, lines, totals или Confirm. Редактирование Draft и Confirm
принадлежат только Order Card. GET Customer на New Order не выполняется: экран
показывает ref из URL и объясняет, что owner проверит его при POST.

### Нормативные поля Customer dialog

Техническое отображение остаётся здесь, а operator labels в SVG даны по-русски:

| Label | Wire field | Правило |
|---|---|---|
| Имя | `displayName` | required, 1..200 |
| Телефон | `phone` | optional, но required вместе с отсутствующим email; input допускает ввод, server response нормализован как E.164 |
| Электронная почта | `email` | optional, но required вместе с отсутствующим phone; email, max 254 |
| Адрес, строка 1 | `address.line1` | required, если address создан; 1..200 |
| Адрес, строка 2 | `address.line2` | optional, max 200 |
| Город | `address.city` | required, если address создан; 1..100 |
| Индекс | `address.postalCode` | optional, max 32 |
| Страна | `address.countryCode` | required при address; exact `RU` |

## Единое визуальное решение

Operational restrained data-dense console: белый рабочий canvas, светлая
служебная surface, тонкие borders, одна синяя primary action и редкий magenta
accent только для выбранного состояния. Нет gradients, glass, decorative card
grid, blanket shadows или editorial cream/serif direction.

### Typography

- `IBM Plex Sans` с Russian/Cyrillic; fallback
  `system-ui, -apple-system, "Segoe UI", Arial, sans-serif`;
- body 14px/20px, primary headings 20px/24px, labels 12px/16px;
- weights 400/500/600;
- #137 self-host-ит WOFF2 в `packages/platform-ui`, объявляет `@font-face` с
  `font-display: swap` и фиксирует source URL/revision, SIL OFL 1.1 notice и
  SHA-256; remote font CDN запрещён.

### Tokens

```text
color.background        #FFFFFF
color.surface           #F7F8FA
color.text               #1A1D23
color.text.muted         #5B6472
color.border             #DDE1E7
color.primary            #3355D1
color.on-primary         #FFFFFF
color.accent             #C2277A
color.on-accent          #FFFFFF
color.success.background #ECFDF3
color.success.border     #86EFAC
color.success.text       #166534
color.warning.background #FFFBEB
color.warning.border     #F59E0B
color.warning.text       #92400E
color.danger.background  #FEF2F2
color.danger.border      #FCA5A5
color.danger.text        #B91C1C
color.focus              #1D4ED8
space                    4 / 8 / 12 / 16 / 20 / 24 / 32px
radius                   6px
border                   1px
control.default          40px
control.compact          36px
control.touch/dialog     >=44px
focus.ring               2px
motion.state             150ms ease-out
```

Рассчитанные token pairs: primary/on-primary 6.25:1, accent/on-accent 5.43:1,
success text/background 6.76:1, warning text/background 6.84:1, danger
text/background 5.91:1, focus/white 6.70:1, body text/background 16.88:1. Это
проверка token pairs, не accessibility PASS всего rendered UI.

## Public API primitives

#137 предоставляет business-neutral primitives из `@coffee-platform/ui`. React
Aria владеет semantic/keyboard/focus behavior; Tailwind v4 — styling. `ref`
передаётся на указанный semantic DOM element; business DTO, Router, Query и fetch
в package не входят.

| Primitive | Public props | Events | Ref / composition | Validation | Pending/loading | Dismissal и focus |
|---|---|---|---|---|---|---|
| `Button` | `variant: primary|secondary|danger|quiet`, `size: compact|default|touch`, `type`, `isDisabled`, `isPending`, `children`, optional package icon | `onPress` | ref → native `button`; text обязателен для standalone action; `startIcon|endIcon` только package icons | не создаёт validation; submit связывается с form | `isPending` сохраняет ширину, показывает label, ставит `aria-busy`, блокирует только этот intent | не dismisses сам; после async следует flow table |
| `Link` | `href`, `children`, `variant`, `aria-current`, optional icon | React Aria press/navigation | ref → native `a`; принимает Router link adapter без знания Router в package | malformed/absent destination не рендерится как enabled link | pending navigation объявляется route region, Link не имитирует mutation | route success focus → `<h1>`; same-page link — на target |
| `Dialog` | `title`, `children`, `isOpen|defaultOpen`, `isDismissable`, `isKeyboardDismissDisabled`, `initialFocusRef`, `returnFocusRef`, optional `description` | `onOpenChange`, `onRequestClose(reason)`, explicit confirm/cancel handlers | composition `DialogTrigger + Dialog + DialogFooter`; ref → modal container | summary/fields находятся внутри и используют Field API | pending блокирует confirm и destructive close, но не скрывает content/result | `aria-modal`, focus trap; Escape/outside only when safe; `onRequestClose` may reject `escape|outside|action`; exact focus table below |
| `Field` / `Input` | `label`, `name`, `value|defaultValue`, `isRequired`, `isDisabled`, `isInvalid`, `description`, `errorMessage`, `inputMode`, `autoComplete` | `onChange`, `onBlur`, form submit | ref → native input; composition label + input + description + error; textarea через отдельный native slot | `errors[].pointer` → exact field; `aria-invalid` и `aria-describedby`; first invalid receives focus | during own submit value stays visible; input is readonly or form-disabled only while duplicate submit would be unsafe | field error is not dismissible; correction removes it only after local/server state update |
| `Alert` | `tone: info|success|warning|danger`, `title`, `children`, `live: polite|assertive`, `isDismissible` | optional `onDismiss` | ref → `role=status` or `role=alert`; may compose one safe action | form summary links to fields; general error has no fake field | pending alert preserves context and announces one state transition | critical/unresolved alerts not dismissible; focus only when no field target or flow table explicitly requires it |
| `Badge` | `tone`, `children`, optional icon | none | ref → non-interactive status element | enum label exhaustive; unknown values fail closed outside primitive | never a spinner; pair with Loading | never dismissible/focusable; text/icon, not color alone |
| `Loading` | `label`, `size`, `isDelayed` | none | ref → status element; owner region gets `aria-busy=true` | not applicable | visible label; skeletons excluded from accessibility tree; no stale result presented as new | no focus move on start; completion announced once |
| `Empty` | `title`, `description`, optional `action` | action owns its event | ref → labelled region; action composes Button/Link | not validation; search hint may reference query requirements | never shown simultaneously with Loading/Error | no automatic focus after ordinary query; route-empty may focus heading only after navigation |

Для interactive primitives обязательны default, hover, focus-visible, active,
disabled и loading. Иконки `search|add|chevron|close|warning|refresh` —
package-owned inline SVG 16/20px, не icon runtime. Status содержит текст и/или icon
и никогда не передаётся только цветом.

## Focus, validation и dialogs

Единое правило submit: если response содержит field errors, связать их по
`errors[].pointer`, объявить общий summary и поставить focus на первое invalid
поле в DOM order. Summary получает programmatic focus только когда field target
отсутствует. Ошибка region не перехватывает focus при фоновой загрузке.

| Dialog | Initial focus | Validation | Return focus |
|---|---|---|---|
| Customer create | первое пустое required поле; после failed submit — первое invalid поле | inline у каждого field; summary focused только без field target | trigger «Создать клиента»; после success route navigation → `<h1>` New Order |
| Confirm | «Отмена» как безопасное действие | command Problem Details в alert; без field target alert/summary получает focus | trigger «Подтвердить заказ»; после success status, затем `<h1>` Order Card |
| Delete item | «Отмена» | command error в alert; no blind retry при ambiguous outcome | trigger «Удалить»; если строка удалена — heading «Позиции» |
| Reconciliation | поле «Причина проверки» | required 1..500; first invalid reason field receives focus | trigger «Проверить синхронизацию»; после success status синхронизации |
| Version conflict | heading dialog, затем явный «Обновить данные» в tab order | unsent quantity/reason сохраняется; summary focused, потому что field target не invalid | исходный action после exact refetch; пользователь отправляет новый intent явно |

Dialog удерживает focus. Escape/outside-close разрешены только если нет pending
command и закрытие не теряет unsent input; иначе доступны явные «Отмена» или
«Остаться». DOM, reading, tab и visual order совпадают. Visible focus ring — 2px
`#1D4ED8`. Motion 150ms ease-out отключается через `prefers-reduced-motion`.

## Narrow layout: точные правила

Breakpoints реализуются mobile-first без промежуточных скрытых вариантов:

| Viewport | Navigation | Tables/results | Dialogs | Action bars | Overflow |
|---|---|---|---|---|---|
| `375–767px` | sidebar заменяется верхней полосой; текущий раздел и кнопка меню имеют 44px target; открытое меню — modal navigation с initial focus на текущем пункте и возвратом на trigger | Customers/Catalog/Order items перестраиваются в карточки: label рядом со значением, action под содержимым, DOM order не меняется; pagination Previous/Next занимает две равные колонки | `width: calc(100vw - 32px)`, `max-height: calc(100dvh - 32px)`, внутренний vertical scroll; поля в одну колонку; footer actions stacked, primary последней в DOM | sticky bottom внутри main, safe-area padding; buttons в одну колонку на 375px и не перекрывают последний content | page не имеет horizontal scroll; refs/messages wrap with `overflow-wrap:anywhere`; только диагностический code block может scroll внутри себя |
| `768–1279px` | compact top navigation, все четыре route доступны без hidden hover; targets >=40px | таблицы сохраняют строки, но secondary metadata переносится под primary cell; actions/quantity не скрываются; pagination остаётся одной строкой | width `min(640px, calc(100vw - 48px))`, max-height `calc(100dvh - 48px)`; Customer address — две колонки, footer не sticky | actions wrap на следующую строку; primary стоит последней в DOM и справа в LTR layout | no page overflow; таблица может иметь internal horizontal scroll только при ширине менее содержимого, с keyboard-focusable wrapper и видимой подсказкой |
| `>=1280px` | постоянная sidebar 232–240px; main landmark занимает остаток | полные table columns, quantity/action всегда видимы; Customers state panel и Order summary могут стоять рядом | width по content contract, максимум 640px для command dialog и 1000px для Customer create; max-height `calc(100dvh - 64px)` | inline справа, без sticky positioning; gap >=12px | wrapping остаётся включённым; ни label, ни button text не обрезаются и не используют ellipsis для обязательного действия |

`375px`, `768px` и `1280px` — обязательные screenshot/reflow widths #13. При zoom
400% используется тот же 375px behavior по доступной CSS width. Dialog scrolling
никогда не прокручивает фон; initial/return focus не меняется из-за breakpoint.

## Технические annotations: server truth и mappings

Эти mappings предназначены исполнителю и не являются operator-facing copy SVG:

- `allowedActions.edit-items` → quantity controls, «Добавить из каталога»,
  «Получить цену и сохранить», «Удалить»;
- `allowedActions.confirm` → «Подтвердить заказ» и Confirm dialog;
- `allowedActions.request-aroma-reconciliation` → только для Confirmed +
  `OutOfSync|Blocked|UnknownOutcome`: «Проверить синхронизацию» и reason
  dialog; отсутствие action означает отсутствие control;
- `Order.version` используется только как expected version mutation;
- `OrderCard.projectionVersion` используется только для monotonic acceptance
  GET/command/replay; сравнивать версии между собой нельзя;
- Catalog `availability` / `mappingAvailable` определяют доступность строки по
  owner response; UI показывает «Доступен», «Нет в наличии» или
  «Продажа остановлена», не provider details;
- `NotRequested|PendingObservation|OutOfSync|Converging|InSync|Blocked|UnknownOutcome`
  отображаются как «Не запрошена», «Ожидается чтение корзины», «Корзина
  отличается», «Корзина синхронизируется», «Корзина синхронизирована»,
  «Синхронизация заблокирована», «Результат изменения неизвестен»;
- Клиентское приложение не вычисляет authoritative totals/money, business state,
  actor или action permission, не обращается к AROMA/provider и не
  интерпретирует SSE как business truth;

## Состояния и recovery

- loading сохраняет context, объявляет занятость и не подменяет результат;
- empty объясняет отсутствие records и даёт безопасный следующий шаг;
- Problem Details показывает понятный detail и correlation id без raw stack,
  provider URL, secret или payload;
- stale quote сохраняет quantity; «Получить цену и сохранить» сначала получает
  quote, затем выполняет PUT только с актуальным proof; при ошибке или истечении
  quote PUT не выполняется и пользователь явно запускает команду снова;
- version conflict сохраняет unsent input и требует exact refetch/review;
- `Blocked` показывает только owner-provided reason;
- `UnknownOutcome` не показывает blind retry mutation;
- ambiguous Customer/Draft/Quote intent хранит key/method/path/fingerprint metadata;
  «Проверить результат» выполняет один bodyless read-only lookup с прежними
  method/path/key, без automatic retry;
- `IDEMPOTENCY_RESULT_NOT_RETAINED` не означает отсутствие эффекта и не разрешает
  новый key; historical replay подтверждает intent, после него нужен owner GET;
- SSE только invalidates/refetches owner resource в одном `QueryClient`; cache,
  forms, pending intents и `EventSource` изолированы по application session.

## Ownership и ограничения evidence

#137 владеет presentation foundation, browser shell, self-hosted font/icons и
разделением browser/Node build. #9 владеет Router, одним `QueryClient`,
project-owned fetch/client-v1 runtime validation, forms/routes/recovery. #12
владеет одним `EventSource` на tab и lifecycle. #13 владеет launch acceptance.
Прямые prerequisites #9 остаются #4/#5/#7/#8/#17/#18/#119.

SVG имеют `viewBox`, `<title>`/`<desc>`, текстовые labels и editable XML. Они не
доказывают фактическую загрузку IBM Plex Sans, browser rendering, keyboard/focus,
screen-reader output, 375/768/1280 reflow, target sizes, contrast всего rendered
UI, Playwright, CSP или reduced-motion. Эти evidence появляются после
материализации #137/#9/#12 и наблюдаемых проверок #13.
