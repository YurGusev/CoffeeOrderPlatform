# Handoff для coding-агента

## Результат

Реализовать новый React operator UI, визуально эквивалентный `index.html`, но использующий только контракты CoffeeOrderPlatform. Макет — эталон композиции и взаимодействия, не источник API, DTO или runtime-архитектуры.

## Прочитать до правок

1. `AGENTS.md`.
2. `docs/launch/07_FRONTEND_CONTRACT.md`.
3. `docs/launch/17_ORDERS_IMPLEMENTATION_SPEC.md`.
4. `docs/launch/18_FRONTEND_IMPLEMENTATION_SPEC.md`.
5. `packages/generated/client-v1/dist/types.gen.d.ts` — только актуальные generated transport types.
6. Этот каталог в порядке: `ui-contract.json` → `DESIGN.md` → `COMPONENT_MAP.md` → `ACCEPTANCE.md` → `index.html`.

## Что является готовым решением

- визуальная система, шрифты, размеры, shell, toolbar, таблица и drawer;
- модель `счёт → заказы счёта → одна раскрытая строка заказа → полноширинный состав`;
- независимое сворачивание invoice groups и отдельная группа `Без счёта`;
- inline quantity control;
- drawer для добавления/замены товара;
- явное удаление товара;
- on-demand область AROMA/invoice/payment;
- stable `data-ui` hooks;
- reference screenshots и Playwright evidence.

Не менять эти решения без отдельного UX-решения. Не «улучшать» палитру, плотность или композицию по вкусу.

## Что нельзя копировать

Из `CoffeeOrderSystem` разрешён только presentation layer, зафиксированный в `source-manifest.json`. Запрещены:

- React-компоненты старого проекта;
- legacy API/state/query code;
- доменные типы и модели;
- auth/runtime;
- endpoint names и mutation semantics;
- fixture/demo data как production data.

## Текущая граница production

Канонический route первого запуска: `/app/orders/:orderRef`.

Полный реестр на макете требует принятого owner projection contract для иерархии invoice → orders. Сейчас отсутствуют:

- `/app/orders` в каноническом route list;
- invoice/orders registry endpoint;
- cursor/filter schema;
- invoice-group и order-summary projections;
- stable связь Order Card с invoice group.

Поэтому coding-агент может:

1. реализовать чистые visual components и fixture/story surface;
2. реализовать Order Card route на `OrderCardResponse`;
3. интегрировать registry только после появления owner contract.

Запрещено собирать иерархию браузерным fan-out GET отдельных Order Card, клиентским join Invoice/Order/Payment или чтением чужих owner surfaces.

## Invoice и payment

Invoice group — верхний уровень макета; Order — дочерняя строка; товары раскрываются только под Order. Эти данные не являются полями `OrderCardResponse`.

- invoice принадлежит Invoices;
- payment принадлежит Payments;
- браузер читает только owner-derived projections;
- supplier invoice number, internal invoice ref и payment ref — разные identity;
- placeholder `—` допустим только в fixture или при явном `NotAvailable` projection state.

До принятия owner contracts coding-агент не добавляет поля invoice/payment в Orders DTO и не делает client-side join.

## Маппинг Order Card

Использовать `OrderCardResponse` без локального дубля:

| UI | Поле owner response |
|---|---|
| идентификатор | `orderRef` |
| optimistic concurrency | `version` |
| freshness | `projectionVersion` |
| статус | `status` |
| заказчик | `customer.displayName` |
| строки | `items[]` |
| цена единицы | `items[].unitMinor` |
| сумма строки | `items[].lineTotalMinor` |
| итог | `pricing.totalMinor` или явное отсутствие pricing |
| AROMA | `aroma` |
| доступные команды | `allowedActions` |

Money minor values — decimal strings. Не преобразовывать их через `Number`; использовать bigint-safe formatter. Production UI не суммирует строки для получения authoritative total.

## Action gating

- add/edit/quantity/delete видимы только при `allowedActions.includes("edit-items")`;
- confirm видим только при `allowedActions.includes("confirm")`;
- reconciliation видим только при `allowedActions.includes("request-aroma-reconciliation")`;
- unknown action не рендерится и считается contract drift;
- confirmed composition read-only;
- `UnknownOutcome` не показывает blind retry.

Каждая mutation передаёт `expectedVersion` и `Idempotency-Key`. Item upsert также передаёт quote proof. Успех mutation принимается только после runtime validation полного owner response.

## Рекомендуемая структура React

```text
apps/web/src/
├── app/
│   ├── router.tsx
│   └── shell/
├── features/orders/
│   ├── api/
│   │   ├── order-client.ts
│   │   └── order-codecs.ts
│   ├── model/
│   │   ├── money-format.ts
│   │   └── order-actions.ts
│   ├── routes/
│   │   ├── order-card-route.tsx
│   │   └── invoice-orders-registry-route.tsx   # только после owner projection contract
│   └── ui/
│       ├── orders-workspace-screen.tsx
│       ├── orders-toolbar.tsx
│       ├── invoice-registry.tsx
│       ├── invoice-group-row.tsx
│       ├── order-row.tsx
│       ├── expanded-order-composer.tsx
│       ├── order-items-table.tsx
│       ├── quantity-control.tsx
│       ├── item-editor-drawer.tsx
│       ├── order-workflow-drawer.tsx
│       └── order-summary.tsx
└── shared/ui/
    ├── button.tsx
    ├── badge.tsx
    ├── field.tsx
    ├── select.tsx
    └── drawer.tsx
```

Структура рекомендуемая, не разрешение добавить React dependency до отдельной delivery task.

## Порядок реализации

1. Подключить `exact-source.css` как project-owned visual layer или перенести declarations без изменения значений.
2. Создать finite UI primitives: Button, Badge, Field, Select, Drawer.
3. Собрать OperatorShell и статическую иерархию `InvoiceRegistry → InvoiceGroupRow → OrderRow`.
4. Добавить fixture story с состояниями из `ui-contract.json`.
5. Реализовать Order Card query через project-owned fetch client и runtime validation.
6. Реализовать mutations с expected version/idempotency/quote proof.
7. Добавить Problem Details, stale quote, conflict, provider unavailable и UnknownOutcome.
8. Добавить SSE invalidation → bounded refetch; событие не является browser truth.
9. Интегрировать invoice/orders registry только после owner projection contract.
10. Выполнить `ACCEPTANCE.md` и project checks.

## Неизменяемые проверки

- `data-ui` hooks не используют hash CSS class names;
- invoice group раскрывает только свои заказы; order disclosure раскрывает только товары этого заказа;
- раскрывается максимум один заказ;
- footer состава не пересекает внешнюю pagination;
- item scroller показывает только целые строки, а при скрытом продолжении выводит явный scroll affordance;
- registry scroller сообщает как о счетах и заказах ниже видимой области, так и о скрытых справа статусах/действиях; предоставляет отдельное действие для каждой оси;
- действия строк и подтверждение заказа остаются достижимыми на desktop monitor от `1024×600` до `3840×2160`;
- layout пересчитывается на live resize без document horizontal overflow;
- drawer initial focus, Escape, outside close и return focus проверяются;
- server state не копируется в глобальный mutable store;
- auth/session data не пишутся в `localStorage`;
- ошибки и 401/403/404 маршрутизируются по `docs/launch/18_FRONTEND_IMPLEMENTATION_SPEC.md`;
- WCAG PASS не заявляется без отдельного полного аудита.

## Definition of done

Реализация готова только когда выполнены все обязательные `ACC-*`, `INT-*`, `VIS-*` и `A11Y-*` из `ACCEPTANCE.md`, contract gaps либо закрыты owner contracts, либо соответствующие production controls отсутствуют.
