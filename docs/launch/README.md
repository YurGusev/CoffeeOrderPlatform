# Launch Package: React + Backend + AROMA Cart

Статус: greenfield implementation baseline для первого запуска CoffeeOrderPlatform.

Этот пакет превращает каноническую архитектуру в короткий исполнимый план. Он
не описывает миграцию с CoffeeOrderSystem, не требует совместимости с C# и не
разрешает перенос legacy `sendToAromaCart`.

## Цель первой версии

Оператор может:

1. найти или создать клиента;
2. найти товар из сохранённого каталога AROMA;
3. получить актуальную цену;
4. создать и подтвердить заказ;
5. наблюдать, как backend приводит физическую корзину AROMA к требуемому
   состоянию;
6. увидеть `InSync`, `Blocked` или `UnknownOutcome` без ручной повторной отправки.

## Состав пакета

1. [Scope and decisions](00_SCOPE_AND_DECISIONS.md)
2. [Runtime architecture](01_RUNTIME_ARCHITECTURE.md)
3. [First vertical slice](02_FIRST_VERTICAL_SLICE.md)
4. [HTTP API contract](03_HTTP_API_CONTRACT.md)
5. [AROMA cart safety](04_AROMA_CART_SAFETY.md)
6. [Data ownership](05_DATA_OWNERSHIP.md)
7. [Events and recovery](06_EVENTS_AND_RECOVERY.md)
8. [Frontend contract](07_FRONTEND_CONTRACT.md)
9. [Delivery plan](08_DELIVERY_PLAN.md)

## Canonical authority

Пакет является прикладной greenfield-проекцией и не изменяет пять immutable
canonical revision roots. При конфликте бизнес-инвариантов действуют M04,
M06, M07, M11, M12, M19, M20 и актуальные pricing/contract-closure overlays.

