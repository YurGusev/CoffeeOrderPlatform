# ADR-0027: foundation операторского frontend и UI package

- Статус: техническая граница предложена в опубликованном `develop`; прежнее визуальное направление больше не действует.
- Область: browser foundation первого запуска и presentation boundary.
- Владельцы реализации: [issue #137](https://github.com/YurGusev/CoffeeOrderPlatform/issues/137), [issue #9](https://github.com/YurGusev/CoffeeOrderPlatform/issues/9) и [issue #12](https://github.com/YurGusev/CoffeeOrderPlatform/issues/12).
- Текущий визуальный ориентир: [ADR-0029](ADR-0029-selected-frontend-prototype.md) и versioned [прототип v1.1.0](../frontend/prototypes/invoice-orders-workspace/v1.1.0/README.md). [Исторический UX-документ #136](../frontend/ux/README.md) сохраняется для traceability и описания прежних flow/focus предположений, но его палитра, IBM Plex Sans и SVG не нормативны.

Текущий visual contract задаёт только ADR-0029 и versioned прототип v1.1.0;
исторические значения #136 остаются в UX-документе, но здесь не повторяются.

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
`Alert`, `Badge`, `Loading` и `Empty`. Таблица public
props/events/ref/composition и поведения validation, pending/loading,
dismissal/focus в [UX-контракте #136](../frontend/ux/README.md) сохраняется как
технический inventory для #137, но его прежние палитра, шрифт и точные layout
правила не действуют. Текущий visual/layout для desktop определяют
[ADR-0029](ADR-0029-selected-frontend-prototype.md) и v1.1.0; 375/768 reflow
требует отдельной проверки #9/#13 по launch contracts. #137 не придумывает
второй API. Для
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

#### Узкое исключение совместимости TypeScript 7

Для #137 явно разрешено одно type-only исключение: pnpm patch для
`@react-types/shared@3.36.1`, транзитивной declaration-зависимости
`react-aria-components@1.21.1`. Исключение ограничено шестью optional
ARIA/DOM properties, не меняет runtime/framework behavior, public API, schema,
wire format или application code и не является разрешением патчить React Aria
или другой framework source.

Исключение действительно только при одновременных условиях: upstream revision,
license, patch hash и rationale зафиксированы в
`packages/platform-ui/THIRD_PARTY_NOTICES.md`; `skipLibCheck` остаётся `false`;
UI и browser graphs проходят отдельный `tsc --noEmit`; patch удаляется после
появления совместимого upstream declaration. Любое другое framework patch,
runtime patch или suppression type errors требует отдельного ADR/issue.

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

### Визуальное направление и технические гарантии

Точные токены, шрифты, размеры и layout для всей SPA определяет
[ADR-0029](ADR-0029-selected-frontend-prototype.md) с прототипом v1.1.0.
#137 self-host-ит проверенные WOFF2 в `packages/platform-ui` через `@font-face`
с `font-display: swap`, фиксирует source revision, SHA-256 и licence notice;
внешний font CDN запрещён.

Статус не передаётся только цветом: нужен текст или значок. DOM/focus order
совпадает с визуальным порядком; field validation фокусирует первое invalid
поле, dialog удерживает focus и не теряет несохранённый ввод при Escape/outside.
Motion отключается через `prefers-reduced-motion`. Контрастность и поведение
нужно проверить на выбранной палитре; старые расчёты для светлых SVG не являются
browser/WCAG PASS новой темы.

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
