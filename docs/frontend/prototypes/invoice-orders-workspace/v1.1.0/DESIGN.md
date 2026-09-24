---
name: Invoice and Orders Operator Workspace
id: orders-workspace-v1
version: 1.1.0
status: approved-reference
language: ru
surface: operator-web
implementation_mode: clean-room-react
supported_viewports:
  desktop:
    min_width: 1024
    reference: [1024x600, 1280x720, 1366x768, 1440x900, 1920x1080, 2560x1080, 2560x1440, 3440x1440, 3840x2160]
  narrow:
    status: diagnostic-only
    reference: [375x812, 430x932]
visual_source:
  repository: https://github.com/YurGusev/CoffeeOrderSystem
  branch: develop
  commit: 3d4b30b1eaac14c77f41d8779f5e03c54cfacbef
  scope: presentation-only
implementation_sources:
  - exact-source.css
  - bridge.css
  - index.html
  - prototype.js
  - ui-contract.json
  - COMPONENT_MAP.md
  - ACCEPTANCE.md
---

# Макет экрана «Счета и заказы»

Этот документ — нормативная визуальная спецификация для coding-агента. Интерактивный `index.html` является исполняемым эталоном поведения и геометрии. При расхождении порядок authority такой:

1. бизнес-инварианты и контракты `docs/launch/**`;
2. `ui-contract.json` — машинная карта компонентов, состояний и action gating;
3. этот `DESIGN.md` — визуальные и композиционные решения;
4. `index.html` — наблюдаемое взаимодействие и stable `data-ui` hooks;
5. screenshots — только evidence конкретного render, не источник бизнес-логики.

## 1. Назначение

Оператор должен в одном рабочем пространстве:

- быстро найти счёт, заказ, заказчика или товар;
- видеть первичную иерархию `счёт → заказы счёта → товары заказа`;
- сворачивать и раскрывать группу счёта;
- раскрыть ровно один заказ внутри счёта непосредственно под строкой заказа;
- увидеть состав, цену единицы, сумму строки и authoritative итог;
- добавить, заменить или удалить товар и изменить количество в Draft;
- подтвердить заказ;
- по запросу увидеть AROMA/cart, invoice и payment projections, не отнимая постоянную ширину у состава.

## 2. Визуальная система

### Цвета

| Token | Значение | Назначение |
|---|---:|---|
| `--cos-palette-canvas` | `#050915` | фон приложения |
| `--cos-palette-canvas-raised` | `#091225` | поднятая рабочая поверхность |
| `--cos-palette-panel` | `#091326` | sidebar и панели |
| `--cos-palette-panel-elevated` | `#0f1b34` | drawer и вложенные поверхности |
| `--cos-palette-table-header` | `#0d1a33` | заголовок таблицы |
| `--cos-palette-row` | `#0b1730` | строки |
| `--cos-palette-text-primary` | `#f4f6ff` | основной текст |
| `--cos-palette-text-secondary` | `#98a7c7` | вторичный текст |
| `--cos-palette-text-disabled` | `#7686a7` | disabled/meta |
| `--cos-palette-violet` | `#7c4dff` | primary action |
| `--cos-palette-violet-hover` | `#9269ff` | hover/focus accent |
| `--cos-palette-success` | `#3ddc97` | success |
| `--cos-palette-warning` | `#ffb84d` | warning |
| `--cos-palette-error` | `#ff6577` | error/destructive |

Полный нормативный набор `--cos-*` находится в `exact-source.css`; значения не переопределять локальными hex/rgb.

### Типографика

- body: `Inter Variable`, `14px / 20px`, weight `400`;
- h1: `Manrope Variable`, `28px / 36px`, weight `600`;
- h2: `Manrope Variable`, `20px / 28px`, weight `600`;
- caption: `Inter Variable`, `12px / 16px`;
- числа: tabular numerals, `14px / 20px`, weight `500`;
- деньги форматировать через bigint-safe helper из authoritative minor-unit decimal string; браузер не вычисляет бизнес-итог.

### Геометрия

- shell: sidebar `226px`, gap `14px`, outer padding `12px`;
- sidebar radius `20px`;
- toolbar radius `14px`;
- control height `36px`, compact control `32px`;
- table header `40px`, row target `48px`; demo row фактически `54px`;
- spacing scale: `4, 8, 12, 16, 24, 32, 48px`;
- drawer: `384px` на desktop, справа, высота viewport;
- inline composer: видимая ширина table viewport, высота вычисляется из живой геометрии экрана;
- composer rows: header / independently scrollable items / явный scroll affordance / summary footer;
- item viewport показывает только целые строки; частично обрезанная строка запрещена;
- footer composer не должен пересекаться с внешней pagination ни на одном проверяемом viewport.

## 3. Композиция

```text
OperatorShell
├── Sidebar
│   ├── Brand
│   ├── Navigation
│   └── OperatorProfile
└── Workspace
    ├── Breadcrumbs
    ├── InvoicesAndOrdersPageHeader
    ├── InvoicesAndOrdersToolbar
    │   ├── ToolbarActions
    │   ├── SavedViews
    │   └── OrderFilters
    └── InvoiceRegistry
        ├── InvoiceOrdersTable
        │   └── InvoiceGroup × N
        │       ├── InvoiceGroupHeader
        │       └── OrderRow × N
        │           └── ExpandedOrderComposer × 0..1
        │               ├── ComposerHeader
        │               ├── OrderItemsTable
        │               └── OrderSummary
        └── CursorPagination

Overlay layer
└── Drawer
    ├── ItemEditor | CatalogPicker | OrderWorkflow
    └── DrawerFooter
```

Группы счетов сворачиваются независимо. В production один `ExpandedOrderComposer` открыт одновременно во всём реестре. Выбор следующего заказа сворачивает предыдущий, не теряя server-confirmed state. Заказы без привязки находятся в отдельной группе `Без счёта`; это не synthetic invoice identity.

## 4. Иерархическая таблица

Invoice group — родительский disclosure row. Он показывает номер/состояние счёта, количество заказов, заказчика, оплату и authoritative aggregate только из owner projection. Под ним находятся строки заказов этого счёта. Invoice identity нельзя выводить из supplier number.

Порядок колонок строк заказа фиксирован:

1. disclosure;
2. selection;
3. Order identifier;
4. customer display name + secondary line;
5. date;
6. item count;
7. total units;
8. authoritative order total;
9. Order status;
10. AROMA/cart projection;
11. row action.

Таблица имеет `min-width: 1537px`. До `1440` горизонтальная прокрутка ограничена `OrdersRegistry`, а не документом. Если часть счетов находится ниже или колонки статусов и действий скрыты справа, отдельная строка сообщает об этом и предоставляет действия «Показать остальные» и «Показать статусы и действия». На `1920` и более широких экранах таблица помещается без горизонтальной прокрутки.

## 5. Раскрытый состав

- раскрывается непосредственно после выбранной строки;
- визуально удерживается в видимой ширине table viewport;
- содержит стабильные `itemRef`, display name, owner quantity, unit, authoritative unit price и line total;
- действия строки находятся в правой колонке: `Изменить`, `Удалить`;
- быстрый quantity control остаётся в строке, но production mutation выполняется только после получения quote и explicit save согласно frontend contract;
- удаление требует confirm dialog в production; demo undo toast не заменяет owner command recovery;
- summary показывает server total и кнопку `Подтвердить заказ` только при `allowedActions` = `confirm`.

## 6. Drawer

Drawer применяется для структурного изменения товара и on-demand деталей выбранного заказа. Привязка к счёту отображается как контекст родительской группы; payment принадлежит счёту и не вычисляется из Order status.

- initial focus: первое поле body;
- `Escape`, close button и scrim закрывают drawer только если это не теряет committed/pending intent;
- focus возвращается в trigger;
- edit и add используют одни и те же Button/Field/Select primitives;
- серверные validation errors связываются с полями через `aria-describedby`;
- drawer не является владельцем server state: после mutation принимается только schema-valid owner response.

## 7. Action gating

Production UI не выводит действия из status mapping. Разрешение приходит только с server `allowedActions`:

| UI | Требование |
|---|---|
| add/edit/quantity/delete | `edit-items` |
| confirm | `confirm` |
| request reconciliation | `request-aroma-reconciliation` |

Неизвестное action логируется как contract violation и не создаёт кнопку. `UnknownOutcome` не показывает blind retry.

## 8. Обязательные состояния

Каждая route/surface реализует взаимоисключающие состояния:

- initial/loading;
- success;
- empty;
- validation error;
- recoverable Problem Details;
- route-fatal 401/403/404;
- pending mutation;
- version conflict;
- stale quote;
- provider unavailable при сохранённой Order Card;
- AROMA `NotRequested`, `PendingObservation`, `OutOfSync`, `Converging`, `InSync`, `Blocked`, `UnknownOutcome`.

Полные тексты и переходы берутся из `docs/launch/18_FRONTEND_IMPLEMENTATION_SPEC.md`, а не из demo JavaScript.

## 9. Responsive contract

- поддерживаемая реализация — desktop monitor от `1024×600` до `3840×2160`;
- при ширине `>1024px` shell занимает ровно высоту viewport, а внутренние области прокручиваются независимо;
- на `1024×600` используется компактная shell-компоновка с вертикальной прокруткой документа без горизонтального overflow;
- `375` и `430` — diagnostic only;
- документ не должен иметь горизонтального overflow;
- широкая таблица может прокручиваться только внутри своего bounded scroller;
- inline composer автоматически пересчитывается на render и resize, показывает только целые товарные строки и не перекрывает footer/pagination;
- mobile redesign, карточный список и скрытие колонок требуют отдельного решения.

## 10. Доступность

- visible labels у всех inputs;
- disclosure сообщает `aria-expanded`;
- dialog: `aria-modal`, initial focus, focus trap в production, return focus;
- keyboard: Enter/Space раскрывают строку, Escape закрывает верхний overlay;
- видимый focus использует `--cos-focus-ring`;
- status/alert announcements не дублируются;
- formal WCAG PASS требует отдельного axe + keyboard + contrast review и здесь не заявляется.

## 11. Contract gaps

Макет показывает полный желаемый workspace, но текущий first-launch contract не предоставляет:

1. owner projection `invoice → orders` и canonical registry route;
2. cursor/filter schema для invoice registry;
3. invoice/payment projections, пригодные для группировки и статусов;
4. связь Order Card с invoice group в текущем `OrderCardResponse`.

Coding-агент не должен синтезировать их через клиентские joins, обращаться к чужим БД/API или переносить demo поля. До публикации owner contract эти элементы допустимы только в fixture/story/demo слое. Канонический первый production route — `/app/orders/:orderRef`.

## 12. Evidence

- functional matrix: `verify.mjs`;
- served-surface gate: `evidence/served-verify.mjs`;
- source identity: `verify-source.mjs` и `source-manifest.json`;
- screenshots: `evidence/served/*.png`;
- последний gate: 66 functional assertions, 5 viewports, 29/29 source assets, без console/network defects.
