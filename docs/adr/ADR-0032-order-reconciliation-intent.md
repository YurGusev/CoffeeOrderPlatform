# ADR-0032: order-level намерение повторной сверки между #8 и #11

- Статус: решение владельца для #8; становится принятой реализационной authority после merge в `develop`. Не подтверждает готовность #11 или эффект провайдера.
- Дата: 2026-09-27. Владелец: Orders.
- Контекст: [спецификация Orders](../launch/17_ORDERS_IMPLEMENTATION_SPEC.md), [спецификация convergence](../launch/19_AROMA_CONVERGENCE_IMPLEMENTATION_SPEC.md), [каталог событий](../launch/12_LAUNCH_CONTRACT_CATALOG.md) и browser recovery #60.

## Решение

Public `request-aroma-reconciliation` и его owner-local атомарная приёмка принадлежат #8. `orders-service` проверяет текущую авторизацию, `Confirmed`, ожидаемую версию и разрешённое действие по owner-local проекции. Без достоверной проекции — в том числе в `PendingObservation` до #11 — ответ `409 AROMA_RECONCILIATION_NOT_ALLOWED`, без записи события. При разрешённом `OutOfSync|Blocked|UnknownOutcome` одна PostgreSQL-транзакция увеличивает `Order.version`, пишет append-only `ReconciliationRequested` History, один Outbox и completed idempotency с исходным `202 ReconciliationAcceptedResponse`. Exact ordinary и bodyless replay после проверки текущего права возвращают сохранённый результат, не повторяя эффект.

Новый `OrderReconciliationRequested.v1` имеет закрытый payload **только** `{orderRef,orderVersion,requestedAt}`: `orderVersion` — версия после команды, `requestedAt` — DB transaction time. Envelope `aggregate={type:"Order",ref:orderRef,version:orderVersion}`; producer `orders-service`, topic `coffee.orders.lifecycle.v1`, key `orderRef`, существующая consumer group `orders-aroma-preparation-v1`. Стабильные `messageId` и envelope bytes публикует Outbox relay после COMMIT. Ни текст `reason`, ни actor/PII, ни cart facts не пересекают event boundary.

#11 принимает intent через существующие Inbox/History/Outbox, сверяет текущие authoritative cart Desired/projection и только затем создаёт **другое** событие `AromaConvergenceRequested.v1(reason=OperatorRequested)` с реальными `cartScopeRef` и `desiredRevision`. При временном отсутствии cart facts нельзя терять intent при duplicate, restart или истечении Kafka retention: #11 доказывает восстановление и дедупликацию из существующих History/Outbox/Inbox без новой таблицы. Producer #8 не делает вид, что конвергенция завершилась, не меняет Desired/Observed и не вызывает Gateway. Ограничения cart-level effect и проверка consumer — acceptance #11; тест положительного `202` с контролируемой read-only fixture в #8 не является production proof доступности действия.

## Альтернативы и последствия

Прямая публикация `AromaConvergenceRequested.v1` из HTTP-команды отвергнута: #8 не владеет достоверными cart-level фактами. Разрешить `202` в `PendingObservation` также нельзя без изменения существующих `allowedActions` и семантики состояния. Новый topic, группа, runtime или таблица для намерения не вводятся. #8 остаётся fail-closed до owner-local projection #11, сохраняя совместимость public route и точный replay; последующая #11 должна доказать durable recovery перед включением consumer.
