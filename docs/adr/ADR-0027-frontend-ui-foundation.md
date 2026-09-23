# ADR-0027: foundation операторского frontend и UI package

- Статус: техническая граница предложена; прежнее визуальное направление не принято владельцем.
- Область: browser foundation первого запуска и presentation boundary.
- Владельцы реализации: [issue #137](https://github.com/YurGusev/CoffeeOrderPlatform/issues/137), [issue #9](https://github.com/YurGusev/CoffeeOrderPlatform/issues/9) и [issue #12](https://github.com/YurGusev/CoffeeOrderPlatform/issues/12).
- Текущий визуальный ориентир: [ADR-0029](ADR-0029-selected-frontend-prototype.md) и versioned [прототип v1.1.0](../frontend/prototypes/invoice-orders-workspace/v1.1.0/README.md). [Исторический UX-документ #136](../frontend/ux/README.md) сохраняется для traceability и описания прежних flow/focus предположений, но его палитра, IBM Plex Sans и SVG не нормативны.

> Раздел **Visual contract** ниже оставлен как исторический текст #136 и в случае расхождения уступает ADR-0029. Не использовать его значения цветов, шрифтов, радиусов и layout как текущую задачу #137.

## Контекст

`apps/web` пока является Node runtime: browser entrypoint, Vite graph и UI package
не материализованы. Спецификация #9 уже определяет четыре route, один
`QueryClient`, project-owned `client-v1` transport и server-owned
`allowedActions`, но прежний путь `apps/web/src/shared/ui/**` смешивал
presentation foundation с feature application. Для #137 нужен один заранее
определённый package boundary без нового business/API owner.

Решение не меняет принятые HTTP/SSE contracts, recovery #119 или техническую
authority ADR-0025. Прямые prerequisites #9 остаются #4, #5, #7, #8, #17, #18
и #119; этот ADR не означает реализацию #9, #12 или #13.

## Решение

### Package и графы сборки

Будущий #137 создаёт workspace package `packages/platform-ui` с package name
`@coffee-platform/ui`. Package владеет только presentation primitives, design
tokens, CSS, self-hosted font declarations и package-owned inline SVG icons.
Его public props остаются business-neutral и не импортируют `Customer`, `Order`,
`Query`, contracts/generated DTO, `fetch`, server/runtime, PostgreSQL, Kafka или
provider code.

#137 разделяет два графа и два entrypoint/output:

1. Node graph сохраняет server composition root и может использовать
   `@coffee-platform/runtime`; он не импортирует browser entrypoint.
2. Browser/Vite graph содержит React shell и `@coffee-platform/ui`; он не
   импортирует Node `main.ts`, `@coffee-platform/runtime`, server adapters или
   secret/config materialization. Browser build не стирает Node output.

Проверки boundary и разрешение `@coffee-platform/ui` в architecture rules
материализует #137. Наличие этого ADR не утверждает, что package или build уже
существуют.

### Поведение, styling, формы и иконки

- `react-aria-components` задаёт доступное поведение primitives: semantic roles,
  keyboard interaction, focus management, slots и состояния.
- Tailwind v4 задаёт styling через tokens; один package-owned helper на `clsx` и
  `tailwind-merge` собирает classes адаптированных компонентов.
- Input форм хранится в local React state. React Aria предоставляет field
  behavior; #9 сопоставляет `errors[].pointer` с feature fields. UI package не
  знает pointer schema.
- Иконки `search`, `add`, `chevron`, `close`, `warning`, `refresh` поставляются
  как package-owned inline SVG 16/20px. Отдельный icon runtime запрещён.
- Заимствованный исходник компонента фиксирует upstream URL, revision, license
  notice, локальные изменения и процедуру обновления. `shadcn` CLI/registry не
  является runtime dependency.

Начальный inventory ограничен `Button`, `Link`, `Dialog`, `Field/Input`,
`Alert`, `Badge`, `Loading` и `Empty`. Нормативная таблица public
props/events/ref/composition, validation, pending/loading, dismissal/focus и точные
правила layout для 375/768/1280 находится в
[UX-контракте](../frontend/ux/README.md); #137 не придумывает второй API. Для
primitives #137 реализует default/hover/focus-visible/active/disabled/loading/
error/empty states, keyboard behavior, focus restoration, status semantics и
`prefers-reduced-motion`.

### Прямые зависимости и владение

#137 владеет только следующим прямым foundation-набором:

- `react`;
- `react-dom`;
- `@types/react`;
- `@types/react-dom`;
- `vite`;
- `react-aria-components`;
- `tailwindcss`;
- `@tailwindcss/vite`;
- `clsx`;
- `tailwind-merge`.

#9 владеет прямыми application dependencies `react-router-dom` и
`@tanstack/react-query`, а также project-owned `client-v1` transport на generated
types с runtime response validation. #9 создаёт ровно один `QueryClient`,
business routes, Problem Details mapping, static serving и feature composition.

Icon runtime, React Hook Form/RHF, Zod, Radix, Base UI, второй `QueryClient`,
второй transport path, generated SDK/client и иная state/API library запрещены.
Exact pins, запись в manifest/lockfile/toolchain registry и compatibility checks
с Node 26, React, Vite и TS7 принадлежат #137; этот ADR версии не фиксирует.

### Владение по issues

- #137: `packages/platform-ui`, browser shell/entrypoint, React/Vite/Tailwind
  foundation, CSS/font assets, icons и разделение browser/Node outputs.
- #9: Router, один `QueryClient`, project-owned fetch/client-v1 runtime
  validation, четыре business route, forms/error mapping, recovery UX и static
  serving. #9 принимает все прямые prerequisites #4/#5/#7/#8/#17/#18/#119.
- #12: один `EventSource` на tab, session lifecycle и SSE invalidation/refetch;
  event payload не становится browser business truth.
- #13: launch verification; этот ADR не является browser, accessibility,
  deployment или release evidence.

### Visual contract

Direction одна: operational / restrained data-dense console. Запрещены
editorial cream/serif direction, glass, gradients и decorative card grid.

Typography:

- `IBM Plex Sans` с Cyrillic; fallback
  `system-ui, -apple-system, "Segoe UI", Arial, sans-serif`;
- будущий #137 self-host-ит проверенные WOFF2 assets в `packages/platform-ui` и
  объявляет их через `@font-face` с `font-display: swap`;
- #137 фиксирует source URL/revision, SIL OFL 1.1 notice и SHA-256 font assets;
  remote font CDN запрещён;
- body 14px/20px, primary headings 20px/24px, labels 12px/16px; weights
  400/500/600.

Tokens:

- background `#FFFFFF`, surface `#F7F8FA`, text `#1A1D23`, muted `#5B6472`,
  border `#DDE1E7`;
- primary `#3355D1`, on-primary `#FFFFFF`;
- accent `#C2277A`, on-accent `#FFFFFF`, только selected/highlighted state;
- success background `#ECFDF3`, border `#86EFAC`, text/icon `#166534`;
- warning background `#FFFBEB`, border `#F59E0B`, text/icon `#92400E`;
- danger background `#FEF2F2`, border `#FCA5A5`, text/icon `#B91C1C`;
- focus ring `#1D4ED8`, 2px; обычный text остаётся `#1A1D23`;
- status никогда не передаётся только цветом: нужен текст и/или icon.

Spacing использует scale 4/8/12/16/20/24/32px. Default control имеет высоту
40px, compact data control — 36px, touch/dialog action target — не менее 44px.
Radius 6px, border 1px, blanket shadows запрещены. DOM/focus order совпадает с
visual order. Field validation фокусирует первое invalid поле; summary получает
focus только при отсутствии focusable field target. Dialog удерживает focus,
использует определённый в UX-контракте initial focus и возвращает его trigger;
Escape или outside-close не должны терять unsent input. Motion используется
только для state/causality: 150ms ease-out и отключение через
`prefers-reduced-motion`.

Рассчитанные contrast ratios для выбранных foreground/background pairs:
primary 6.25:1, accent 5.43:1, success 6.76:1, warning 6.84:1, danger 5.91:1,
focus 6.70:1, body text 16.88:1. Это проверка token pairs, а не WCAG/browser PASS.

## Business и recovery boundaries

Browser читает только текущие `client-v1` fields/routes/actions. Authoritative
money и totals приходят от server и не вычисляются в UI. `Order.version`
используется только как expected version команд; monotonic
`OrderCard.projectionVersion` — только для принятия GET/command/replay и SSE
refetch. Сравнивать их между собой запрещено.

`allowedActions` — единственный источник доступных action. `Blocked` и
`UnknownOutcome`, stale quote, version conflict и pending command after reload
следуют #119 и ADR-0025: нет blind mutation retry, нового idempotency key из-за
timeout или вывода об intent по похожему состоянию. AROMA Gateway остаётся
provider transport owner; browser не получает writer/actor authority.

## Рассмотренные альтернативы

1. `apps/web/src/shared/ui/**` — отклонено: presentation foundation остаётся
   связанным с feature app и не имеет проверяемой browser/package boundary.
2. Radix или Base UI рядом с React Aria — отклонено: создаёт второй behavior
   foundation и неоднозначную accessibility authority.
3. Runtime icon library — отклонено: лишняя dependency и второй styling API;
   шесть нужных icons принадлежат package.
4. RHF + Zod для локальных форм — отклонено: нет гарантии, которую нельзя дать
   local React state, React Aria и owner/runtime validation; Zod не становится
   вторым contract validator.
5. Второй `QueryClient` или generated SDK — отклонено: разрушает единый cache,
   monotonic recovery и project-owned transport boundary.
6. Remote font CDN — отклонено: ухудшает CSP, provenance и offline/static
   delivery; WOFF2 должен быть self-hosted с OFL/source evidence.

## Последствия и проверка

#137 обязан materialize package/build boundary, pins, font/license provenance,
architecture checks, browser build и component-level accessibility tests. #9
обязан реализовать feature routes и recovery semantics поверх foundation без
нового UI/transport/state path. #12 добавляет только SSE lifecycle. #13 проверяет
critical path, deep links, CSP, keyboard, screen reader, reduced motion и
rendered states.

Макеты #136 — редактируемая specification evidence, не executable frontend и не
доказательство package installation, browser rendering, WCAG, screen-reader,
compatibility, deployment или выполнения #9/#12/#13.
