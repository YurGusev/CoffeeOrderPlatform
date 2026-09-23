# Acceptance matrix

Критерии относятся к будущей React-реализации. Они не утверждают, что production frontend уже существует.

## Visual fidelity

- **VIS-01** — на `1440×900` shell, sidebar, toolbar и registry соответствуют `evidence/served/desktop-1440--register.png`.
- **VIS-02** — expanded state соответствует `evidence/served/desktop-1440--expanded.png`.
- **VIS-03** — edit drawer соответствует `evidence/served/desktop-1440--edit-drawer.png`.
- **VIS-04** — используются Inter Variable `14/20` и Manrope Variable `28/36` для h1.
- **VIS-05** — только `--cos-*` tokens задают цвета, spacing, radii и elevation.
- **VIS-06** — table min width `1537px`; overflow ограничен table scroller, документ не имеет горизонтального overflow.
- **VIS-07** — inline composer удерживается в видимой ширине table viewport.
- **VIS-08** — footer composer и pagination имеют `0px` intersection на всех desktop monitor viewport от `1024×600` до `3840×2160`.
- **VIS-09** — main confirm action достижим прокруткой и проходит hit-test на smallest supported desktop.
- **VIS-10** — на `1920×1080` таблица не имеет лишнего горизонтального overflow.
- **VIS-11** — при vertical или horizontal overflow реестра видна строка продолжения: «Ниже ещё счета и заказы» и/или «Справа ещё статусы, корзина и действия»; обе кнопки прокрутки доходят до границы и возвращают к началу.
- **VIS-12** — item scroller не показывает частично обрезанные товарные строки; число partial rows равно `0` на всей viewport-матрице.
- **VIS-13** — при скрытых товарах виден отдельный scroll affordance; он доводит до последней строки и возвращает к началу.
- **VIS-14** — на desktop шире `1024px` document height равен viewport height; scroll ограничен внутренними bounded regions.
- **VIS-15** — live resize `1920×1080 → 1280×720 → 2560×1080 → 2560×1440 → 3440×1440 → 1024×600 → 3840×2160` не создаёт document horizontal overflow, clipping или рассинхронизацию scroll affordance.

## Invoice hierarchy

- **INV-01** — верхний уровень реестра состоит из invoice groups, а не из плоских заказов с колонкой счёта.
- **INV-02** — invoice group раскрывает только принадлежащие ей заказы.
- **INV-03** — order row раскрывает только товары этого заказа непосредственно под строкой заказа.
- **INV-04** — invoice groups сворачиваются независимо; при этом во всём реестре открыт максимум один Order composer.
- **INV-05** — `Без счёта` является явным projection state и не получает вымышленный invoiceRef.
- **INV-06** — поиск по invoice number возвращает группу и все подходящие дочерние заказы.
- **INV-07** — invoice status, payment и aggregate приходят из owner projection и не вычисляются из дочерних Order rows.
- **INV-08** — supplier invoice number не используется как React key или internal identity.

## Registry

- **REG-01** — список получен одним Orders-owned registry query, а не browser fan-out.
- **REG-02** — фильтры и cursor сериализуются по accepted owner contract.
- **REG-03** — отображается loading skeleton без fake rows.
- **REG-04** — empty state объясняет отсутствие результатов и позволяет сбросить фильтры.
- **REG-05** — раскрывается максимум один заказ.
- **REG-06** — переключение на другой заказ с несохранённым draft проходит через explicit discard/continue choice.
- **REG-07** — invoice identity/number, orderRef, customer, item count, owner totals, statuses и projection states доступны keyboard/screen reader.
- **REG-08** — stale page cursor не превращается в offset pagination.

`REG-01/02/08` блокированы до появления registry contract; fixture story может выполняться отдельно.

## Order composition

- **ORD-01** — состав читается из runtime-validated `OrderCardResponse`.
- **ORD-02** — line order соответствует `linePosition`.
- **ORD-03** — unit price и line total отображаются из `unitMinor`/`lineTotalMinor`.
- **ORD-04** — authoritative total берётся только из `pricing.totalMinor`.
- **ORD-05** — `pricing === null` даёт явное состояние, а не browser sum.
- **ORD-06** — decimal money и quantity не проходят через `Number`.
- **ORD-07** — add/edit/delete/quantity отсутствуют без `edit-items`.
- **ORD-08** — confirm отсутствует без `confirm`.
- **ORD-09** — reconciliation отсутствует без `request-aroma-reconciliation`.
- **ORD-10** — Confirmed composition read-only.

## Mutations

- **MUT-01** — каждая mutation передаёт `expectedVersion` и `Idempotency-Key`.
- **MUT-02** — item upsert передаёт accepted quote proof.
- **MUT-03** — success response runtime-validated до записи в Query cache.
- **MUT-04** — pending state отключает только конфликтующие actions.
- **MUT-05** — 409 version conflict предлагает `Обновить карточку`, не повторяет автоматически.
- **MUT-06** — stale quote возвращает пользователя к repricing.
- **MUT-07** — ambiguous/UnknownOutcome не показывает blind retry.
- **MUT-08** — remove требует явного подтверждения; toast не считается доказательством command success.
- **MUT-09** — поздний GET с меньшим `projectionVersion` не откатывает cache.
- **MUT-10** — SSE invalidation вызывает bounded refetch; payload события не становится browser truth.

## Drawers and focus

- **DRW-01** — initial focus находится на первом meaningful field.
- **DRW-02** — Escape закрывает только верхний overlay.
- **DRW-03** — scrim и close button используют один request-close path.
- **DRW-04** — после закрытия focus возвращается в trigger.
- **DRW-05** — focus не выходит за modal surface, пока drawer открыт.
- **DRW-06** — dirty editor требует discard confirmation.
- **DRW-07** — длинный каталог/validation errors прокручиваются внутри body, header/footer остаются доступны.
- **DRW-08** — повторное открытие после discard не восстанавливает отвергнутый draft.

## AROMA, invoice, payment

- **XPR-01** — AROMA отображает все семь owner states без сведения их к boolean.
- **XPR-02** — Blocked показывает owner blocker message.
- **XPR-03** — provider unavailable не скрывает durable Order Card.
- **XPR-04** — invoice UI не использует supplier invoice number как internal identity.
- **XPR-05** — payment UI не синтезируется из Order status.
- **XPR-06** — invoice hierarchy/payment controls отсутствуют в production, пока owner projection contracts не приняты.
- **XPR-07** — никакого direct browser call к AROMA/provider.

## Errors and recovery

- **ERR-01** — Problem Details проходит runtime validation и типизированный rendering.
- **ERR-02** — validation errors связаны с fields и имеют summary.
- **ERR-03** — 401 очищает session cache и переводит на auth flow.
- **ERR-04** — 403/404 отображаются как route state.
- **ERR-05** — initial load failure отделён от refetch failure.
- **ERR-06** — неизвестный error code не приводит к доступному destructive action.

## Accessibility and keyboard

- **A11Y-01** — видимый focus на всех interactive elements.
- **A11Y-02** — disclosure имеет accurate `aria-expanded` и accessible name.
- **A11Y-03** — inputs имеют visible labels, errors — `aria-describedby`.
- **A11Y-04** — status/toast announcements не дублируются.
- **A11Y-05** — Enter/Space раскрывают focused row без запуска вложенной кнопки.
- **A11Y-06** — click/keyboard action targets не перекрыты layers.
- **A11Y-07** — axe serious/critical findings отсутствуют либо имеют accepted exception.
- **A11Y-08** — WCAG PASS не заявляется только по axe.

## Security and frontend platform

- **SEC-01** — используется project-owned fetch client на generated transport types.
- **SEC-02** — generated SDK/runtime client не подключён.
- **SEC-03** — CSP не требует inline script/style в production build.
- **SEC-04** — auth/session state не пишется в `localStorage`.
- **SEC-05** — cache scoped by authenticated session; logout удаляет его.
- **SEC-06** — browser не выбирает actor identity.
- **SEC-07** — no cross-owner SQL/API joins in browser.

## Verification commands

### Макет

```bash
node docs/frontend/prototypes/invoice-orders-workspace/v1.1.0/verify.mjs
node docs/frontend/prototypes/invoice-orders-workspace/v1.1.0/evidence/served-verify.mjs
node docs/frontend/prototypes/invoice-orders-workspace/v1.1.0/verify-source.mjs
node docs/frontend/prototypes/invoice-orders-workspace/v1.1.0/verify-handoff.mjs
```

### Будущая React-реализация

Минимально:

```bash
pnpm run lint
pnpm run typecheck
pnpm run test
```

Дополнительно выполнить project-owned frontend build, unit/contract tests, Playwright critical paths, axe, CSP и deep-link checks, когда соответствующие scripts появятся в repository.

## Handoff gate

Coding-агент завершает задачу только если:

1. каждый применимый criterion имеет test/evidence;
2. contract gaps не замаскированы mock полями;
3. screenshots сняты после последнего CSS/font/layout изменения;
4. console/page/network errors отсутствуют;
5. preview processes остановлены;
6. все ограничения перечислены в handoff.
