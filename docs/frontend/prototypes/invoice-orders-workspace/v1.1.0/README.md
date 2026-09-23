# Экран «Счета и заказы» — точное оформление старого React

Интерактивный desktop-макет объединяет иерархию `счёт → заказы → товары заказа` с presentation layer старого React-приложения CoffeeOrderSystem.

Статус: выбранный versioned reference-макет с вымышленными fixtures. Он не является
production route или API contract: invoice/orders/payment binding остаётся
заблокированным contract gaps из `ui-contract.json`.

## Вход для coding-агента

Начинать с `AGENT_HANDOFF.md`. Нормативный пакет:

1. `ui-contract.json` — машинная карта surface, компонентов, action gating и contract gaps;
2. `DESIGN.md` — визуальная спецификация;
3. `COMPONENT_MAP.md` — границы React-компонентов и props;
4. `ACCEPTANCE.md` — обязательные критерии и проверки;
5. `IMPLEMENTATION_PROMPT.md` — готовое задание для AI coding agent;
6. `index.html` + `prototype.js` — исполняемый эталон с устойчивыми `data-ui` hooks.

Макет подготовлен под clean-room React-реализацию. Он не разрешает перенос legacy runtime или создание отсутствующих owner contracts.

## Источник оформления

- Репозиторий: `https://github.com/YurGusev/CoffeeOrderSystem`
- Ветка: `develop`
- Commit: `3d4b30b1eaac14c77f41d8779f5e03c54cfacbef`
- Полный список исходных CSS-файлов, их SHA-256 и правила CSS-module namespace: `source-manifest.json`

`exact-source.css` сформирован из исходных `tokens.css`, `global.css`, shell/logo, Orders workspace/table/finite variants и shared UI primitives. CSS declarations сохранены; локальные имена классов получили только детерминированный prefix, эквивалентный работе CSS Modules в React. Встроены точные variable-font файлы Inter и Manrope версии `5.3.0`, указанные в старом `package.json`.

Self-contained snapshots только presentation CSS находятся в `sources/legacy-presentation/`. Проверка source identity больше не зависит от сети, `/tmp` clone или установленного font package.

`bridge.css` содержит только компоновку новой функциональности, которой не было в read-only старой поверхности: inline-количество, прокручиваемый состав, отдельную строку итога и drawer. Все её визуальные значения используют оригинальные `--cos-*` tokens.

## Что работает

- счета верхнего уровня и вложенные заказы;
- независимое сворачивание счетов;
- отдельная группа заказов `Без счёта`;
- поиск по товару, заказу, телефону, счёту и заказчику;
- быстрые представления и статусный фильтр;
- раскрытие товаров заказа непосредственно под дочерней строкой заказа;
- изменение количества;
- замена, добавление и удаление товара;
- отмена удаления;
- пересчёт цены строки и итога заказа;
- подтверждение заказа;
- on-demand drawer корзины, счёта и оплаты;
- клавиатура: Enter/Space для раскрытия, Escape для закрытия drawer, Ctrl/Cmd+K для поиска.

Все данные вымышлены. Старые API, state management, доменные модели и runtime-код не переносились.

## Запуск и проверка

```bash
node docs/frontend/prototypes/invoice-orders-workspace/v1.1.0/verify.mjs
```

Быстрая функциональная проверка запускает локальную HTTP-поверхность и Playwright на `1366×768`, `1440×900` и `1920×1080`.

Дополнительный served-surface gate:

```bash
node docs/frontend/prototypes/invoice-orders-workspace/v1.1.0/evidence/served-verify.mjs
```

Он проверяет desktop monitor `1024×600`, `1280×720`, `1366×768`, `1440×900`, `1920×1080`, `2560×1080`, `2560×1440`, `3440×1440`, `3840×2160`, live resize между граничными и ultrawide-размерами и mobile diagnostic `375×812`, `430×932`. Gate измеряет целые товарные строки, vertical/horizontal scroll affordance реестра, scroll affordance состава, отсутствие перекрытия footer/pagination, достижимость подтверждения и document overflow.

Проверка целостности handoff для coding-агента:

```bash
node docs/frontend/prototypes/invoice-orders-workspace/v1.1.0/verify-handoff.mjs
```

Она проверяет наличие нормативных файлов, canonical project sources, `data-ui` hooks, generated `OrderCardResponse`, action union и явные contract gaps.

Открыть макет: `index.html`.
