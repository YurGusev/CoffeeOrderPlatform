# Интерактивные frontend-прототипы

Каталог хранит versioned исполняемые макеты, спецификации и проверочное evidence.
Он не является production runtime и не подключается к `apps/web`.

## Invoice and Orders Operator Workspace

- Версия: [`v1.1.0`](invoice-orders-workspace/v1.1.0/)
- Запуск: открыть `invoice-orders-workspace/v1.1.0/index.html` либо выполнить команды из локального `README.md`.
- Иерархия: `счёт → заказы счёта → раскрываемые товары заказа`.
- Статус presentation layer: выбранный reference-макет.
- Статус production binding: заблокирован отсутствующими invoice/orders/payment owner projections, перечисленными в `ui-contract.json`.
- Данные: только вымышленные fixtures.

## Правила использования

1. Реализация читает `DESIGN.md`, `ui-contract.json`, `COMPONENT_MAP.md` и `ACCEPTANCE.md` одной версии.
2. React-код использует только generated `client-v1`, server state и owner-provided `allowedActions`.
3. `prototype.js`, fixtures и legacy presentation snapshots не импортируются в production bundle.
4. Новая версия создаётся отдельным каталогом; принятая версия не изменяется молча.
5. Для issue и implementation handoff указываются versioned repository path и точный commit SHA.
