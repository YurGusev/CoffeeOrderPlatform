# Карта React-компонентов

Имена рекомендуемые. Coding-агент может согласовать их с существующей структурой проекта, но не должен объединять owner fetching, mutation lifecycle и presentation в один компонент.

## Дерево и границы

| Регион / `data-ui` | React-компонент | Ответственность | Не владеет |
|---|---|---|---|
| `operator-shell` | `OperatorShell` | sidebar, mobile header, workspace slot | Orders data |
| `page-header` | `OrdersPageHeader` | title, description, global status | query/mutation |
| `orders-toolbar` | `OrdersToolbar` | filters, saved view inputs, command triggers | фильтрация owner data без list contract |
| `invoice-registry` | `InvoiceRegistry` | table viewport, invoice groups, pagination slot | Order Card mutations |
| `invoice-group-row` | `InvoiceGroupRow` | invoice disclosure, invoice status/payment/aggregate, order children slot | client-side invoice aggregation |
| `order-row` | `OrderRow` | summary projection, disclosure, row action | authoritative calculations |
| `order-composer` | `ExpandedOrderComposer` | compose item/summary regions; action gating | network transport |
| `order-items-scroll` | `BoundedOrderItemsViewport` | fit whole rows to live viewport; own scroll | clipping rows under footer |
| `items-scroll-hint` | `ItemsScrollContinuation` | announce hidden lines; next/start actions | changing item order |
| `order-items` | `OrderItemsTable` | render ordered owner lines | sorting/repricing |
| `order-item` | `OrderItemRow` | item values/actions | product lookup |
| `quantity-control` | `QuantityControl` | bounded editable quantity draft | authoritative quantity |
| `order-summary` | `OrderSummary` | pricing total, state, confirm action | sum from UI rows |
| `drawer` | `DrawerHost` | modal semantics, focus lifecycle | domain mutation |
| — | `ItemEditorDrawer` | product/variant/quantity/quote selection | Catalog truth |
| `open-order-workflow` | `OrderWorkflowDrawer` | on-demand AROMA/invoice/payment composition | cross-owner joining |
| `orders-pagination` | `CursorPagination` | cursor controls and page size | offset emulation |
| `registry-scroll-hint` | `RegistryScrollContinuation` | disclose invoices/orders below and status/action columns to the right; axis controls | pagination semantics |
| `toast` | `TransientStatus` | non-authoritative short announcements | command completion truth |

## Props и события

### `OrdersWorkspaceScreen`

```ts
type OrdersWorkspaceScreenProps = {
  registry: InvoiceOrdersRegistryState;
  filters: OrdersFilterState;
  expandedInvoiceRefs: ReadonlySet<string>;
  expandedOrderRef: string | null;
  onFiltersChange(next: OrdersFilterState): void;
  onToggleInvoice(invoiceRef: string): void;
  onToggleOrder(orderRef: string): void;
  onNextPage(): void;
  onPreviousPage(): void;
};
```

`InvoiceOrdersRegistryState` должен приходить из принятого owner projection contract. Не выводить invoice groups из browser fan-out карточек заказов и не агрегировать payment/amount в браузере.

### `InvoiceGroupRow`

```ts
type InvoiceGroupRowProps = {
  invoice: InvoiceRegistryGroup;
  expanded: boolean;
  onToggle(): void;
  children: React.ReactNode;
};
```

`InvoiceRegistryGroup` — имя shape из будущего accepted contract, а не разрешение создать локальный production DTO. Группа содержит stable internal invoice identity, display number, owner status/payment/total и упорядоченные order summaries. `Без счёта` моделируется явным projection state, а не вымышленным invoice ref.

### `ExpandedOrderComposer`

```ts
type ExpandedOrderComposerProps = {
  order: OrderCardResponse;
  commandState: OrderCommandState;
  onEditItem(itemRef: string): void;
  onRemoveItem(itemRef: string): void;
  onAddItem(): void;
  onConfirm(): void;
  onOpenWorkflow(): void;
};
```

Компонент получает уже runtime-validated `OrderCardResponse`. Внутри не создаётся частичный локальный DTO.

### `OrderItemRow`

```ts
type OrderItemRowProps = {
  item: OrderCardResponse["items"][number];
  canEdit: boolean;
  pendingAction: null | "update" | "remove";
  onEdit(): void;
  onRemove(): void;
};
```

Цена и line total форматируются из minor-unit decimal string. Quantity отображается как decimal string и валидируется по unit.

### `QuantityControl`

Draft в контроле — только user input. Изменение server resource происходит явным save/upsert command после актуального PricingQuote.

```ts
type QuantityControlProps = {
  value: string;
  unit: "piece" | "gram" | "kilogram";
  disabled: boolean;
  invalidMessage?: string;
  onChange(value: string): void;
  onCommit(): void;
};
```

Не преобразовывать decimal quantity в IEEE-754 float для command payload.

### `OrderSummary`

```ts
type OrderSummaryProps = {
  pricing: OrderCardResponse["pricing"];
  status: OrderCardResponse["status"];
  canConfirm: boolean;
  pending: boolean;
  onConfirm(): void;
};
```

Если `pricing === null`, показать explicit `Цена не рассчитана`; не суммировать строки.

### `ItemEditorDrawer`

```ts
type ItemEditorDrawerProps = {
  open: boolean;
  orderVersion: string;
  mode: "add" | "replace" | "quantity";
  initialItem?: OrderCardResponse["items"][number];
  quoteState: PricingQuoteState;
  onSubmit(input: ItemEditorInput): void;
  onRequestClose(reason: "escape" | "scrim" | "button"): void;
};
```

При dirty input закрытие требует explicit discard decision. Один Escape закрывает только верхний overlay.

### `OrderWorkflowDrawer`

```ts
type OrderWorkflowDrawerProps = {
  aroma: OrderCardResponse["aroma"];
  invoiceProjection: InvoiceProjectionState;
  paymentProjection: PaymentProjectionState;
  canRequestReconciliation: boolean;
  onRequestReconciliation(reason: string): void;
};
```

`InvoiceProjectionState` и `PaymentProjectionState` — placeholder interface в fixture/story до появления owner contracts. Их нельзя экспортировать как production DTO.

## View model rules

View models разрешены только как pure projections validated owner responses:

```ts
type OrderCardView = {
  orderRef: string;
  statusLabel: string;
  customerLabel: string;
  totalLabel: string | null;
  aromaLabel: string;
  canEditItems: boolean;
  canConfirm: boolean;
  canRequestReconciliation: boolean;
};
```

- `can*` вычисляются только через membership в `allowedActions`;
- status label не управляет доступностью действия;
- totals не пересчитываются;
- version/projectionVersion не скрываются от command/query layer;
- blockers рендерятся из owner response без локального code mapping, который теряет message.

## State ownership

| State | Owner |
|---|---|
| Order Card data | TanStack Query cache scoped to authenticated session |
| invoice → orders registry | accepted owner projection; не browser join |
| filter form draft | route/search params или local reducer |
| expanded invoice groups | local UI state keyed by stable invoice identity |
| expanded row | local UI state keyed by `orderRef` |
| drawer open/mode | local UI state |
| mutation pending/unknown | command hook, не toast |
| money/status/action | server response |
| saved views | отдельный accepted contract; в mock локально |
| invoice/payment | соответствующий owner projection |

## Stable selectors

Production Playwright должен использовать `role`, accessible name и `data-ui`, а не CSS Modules classes. Полный список опубликован в `ui-contract.json`.

Ключевые selectors:

```text
[data-ui="invoice-registry"]
[data-ui="invoice-group-row"]
[data-ui="order-row"]
[data-ui="order-composer"]
[data-ui="order-item"]
[data-ui="quantity-control"]
[data-ui="edit-order-item"]
[data-ui="remove-order-item"]
[data-ui="confirm-order"]
[data-ui="drawer"]
```
