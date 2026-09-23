# ADR-0029: выбранный визуальный ориентир операторской SPA

- Статус: локальный проект решения; владелец выбрал направление 2026-09-23, публикация и приёмка реализации отдельно.
- Область: оформление всей операторской SPA первого запуска; не новые owner API или business routes.
- Источник: [`docs/frontend/prototypes/invoice-orders-workspace/v1.1.0/README.md`](../frontend/prototypes/invoice-orders-workspace/v1.1.0/README.md), local repository commit `2aa6644c9c042c7b722702e6cde31324a4057bb9`.
- Presentation provenance: CoffeeOrderSystem `develop` commit `3d4b30b1eaac14c77f41d8779f5e03c54cfacbef`, only source-identified CSS/font assets per [`source-manifest.json`](../frontend/prototypes/invoice-orders-workspace/v1.1.0/source-manifest.json).

## Решение владельца

Версия `v1.1.0` заменяет **визуальное направление** четырёх SVG из #136 для всей SPA: тёмный `--cos-*` palette, Inter Variable для текста, Manrope Variable для заголовков, оформление shell, таблиц, панелей, полей и статусов. Детали и точные размеры брать из `DESIGN.md` и `exact-source.css` этой же версии; не восстанавливать белую палитру, IBM Plex Sans и сине-пурпурные tokens из исторического #136. Новую версию прототипа создавать в отдельном каталоге, `v1.1.0` не изменять молча.

ADR-0027 продолжает задавать **техническую**, а не визуальную границу: `@coffee-platform/ui`, React Aria semantics, Tailwind v4, раздельные browser/Node graphs, один client-v1 transport у #9 и SSE у #12. Для #137 новые локальные font assets должны иметь проверяемый source revision, SHA-256 и licence notice; URL внешнего font CDN запрещён. Из legacy допустим только presentation layer, не React runtime, API, state, models или fixtures в production bundle.

## Граница приложения и приёмки

Четыре маршрута первого запуска и их server-owned поведение остаются из `docs/launch/07_FRONTEND_CONTRACT.md` и `18_FRONTEND_IMPLEMENTATION_SPEC.md`. Макет реестра `счёт → заказы → позиции`, поиск/фильтры и invoice/payment drawer **только fixture/demo**. `/app/orders` не становится production route без принятых owner projections, cursor/filter schema и стабильной Order–Invoice binding. Не строить этот список browser fan-out по Order Card, cross-owner join или mock DTO. Рабочая карточка `/app/orders/:orderRef` следует owner `OrderCardResponse` и `allowedActions`; суммы и версии не выводятся из прототипа.

Прототип проверен для desktop `>=1024px`; `375` и `430` в его evidence — диагностические ширины, **не mobile acceptance**. Требования запуска к доступности, клавиатуре, reflow, 375/768 и deep links не снимаются. Для production-экранов первой волны mobile-компоновка в новом оформлении остаётся отдельной задачей/проверкой #9/#13; прежние светлые SVG не доказывают её. Browser/accessibility/CI PASS для SPA этот ADR не объявляет.

## Применение и доказательства

Исполнитель читает как единый versioned пакет `README.md`, `AGENT_HANDOFF.md`, `DESIGN.md`, `ui-contract.json`, `COMPONENT_MAP.md` и `ACCEPTANCE.md`; сохраняет `data-ui` hooks только там, где есть реальная соответствующая поверхность. Локальная проверка 2026-09-23 в отдельном worktree на `2aa6644`: `verify-source.mjs` — 29/29 source/font assets; `verify-handoff.mjs` — 79 проверок без дефектов; `verify.mjs` — 66 assertions на трёх desktop viewport без дефектов; `served-verify.mjs` — 9 desktop и 2 диагностических mobile viewport, шесть resize-проверок без дефектов. Это доказательства **прототипа**, не работы #137/#9 или production binding.

Содержательное принятие старых светлых макетов #136 не заявляется: `evidence/handoffs/issue-136.yaml` оставляет `contentAcceptance: NOT_RUN`. Исторический handoff и hashes не переписывать. Перед merge реализации #137 обновить её visual/font evidence, повторить browser/contrast tests на новых assets, независимый review и GitHub checks; текущий PR #142 по старым tokens не удовлетворяет этому решению.
