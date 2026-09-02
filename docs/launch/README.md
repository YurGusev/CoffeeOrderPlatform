# Пакет первого запуска: React, backend и корзина AROMA

Статус: **Effect-native authority migration**. Базовый Node/Compose foundation принят в issue #3 / PR #22. До реализации launch-контрактов и бизнес-сервисов обязательна линейка #25–#32; issue #4 разблокируется только после решения `ДОПУСТИТЬ EFFECT FOUNDATION` в #32.

Этот пакет превращает каноническую архитектуру в исполнимую линию. Он не описывает миграцию с CoffeeOrderSystem, не требует совместимости с C# и не разрешает перенос legacy `sendToAromaCart`.

## Цель первой версии

Оператор может:

1. найти или создать клиента;
2. найти товар из сохранённого каталога AROMA;
3. получить актуальную цену;
4. создать и подтвердить заказ;
5. наблюдать, как backend приводит физическую корзину AROMA к требуемому состоянию;
6. увидеть `InSync`, `Blocked` или `UnknownOutcome` без ручной повторной отправки.

## Состав пакета

1. [Границы и решения](00_SCOPE_AND_DECISIONS.md)
2. [Архитектура исполнения](01_RUNTIME_ARCHITECTURE.md)
3. [Первая вертикаль](02_FIRST_VERTICAL_SLICE.md)
4. [Контракт HTTP API](03_HTTP_API_CONTRACT.md)
5. [Безопасность корзины AROMA](04_AROMA_CART_SAFETY.md)
6. [Владение данными](05_DATA_OWNERSHIP.md)
7. [События и восстановление](06_EVENTS_AND_RECOVERY.md)
8. [Контракт frontend](07_FRONTEND_CONTRACT.md)
9. [План реализации](08_DELIVERY_PLAN.md)
10. [Существующая БД и зафиксированные версии](09_EXISTING_DATABASE_AND_VERSIONS.md)
11. [Нормативный каталог runtime](10_RUNTIME_CATALOG.md)
12. [Единая конфигурация и единое хранилище секретов](11_CONFIGURATION_AND_SECRETS.md)
13. [Нормативный каталог HTTP, SSE и событийных контрактов](12_LAUNCH_CONTRACT_CATALOG.md)
14. [Единая линия реализации и зависимости задач](13_DELIVERY_DEPENDENCY_GRAPH.md)
15. [Исполнимая спецификация Customer](14_CUSTOMER_IMPLEMENTATION_SPEC.md)
16. [Исполнимая спецификация Catalog](15_CATALOG_IMPLEMENTATION_SPEC.md)
17. [Исполнимая спецификация PricingQuote](16_PRICING_IMPLEMENTATION_SPEC.md)
18. [Исполнимая спецификация Orders Draft и Confirm](17_ORDERS_IMPLEMENTATION_SPEC.md)
19. [Исполнимая спецификация React-интерфейса](18_FRONTEND_IMPLEMENTATION_SPEC.md)
20. [Исполнимая спецификация AROMA convergence](19_AROMA_CONVERGENCE_IMPLEMENTATION_SPEC.md)
21. [Исполнимая спецификация realtime SSE](20_REALTIME_SSE_IMPLEMENTATION_SPEC.md)
22. [Исполнимая спецификация итогового launch gate](21_LAUNCH_VERIFICATION_SPEC.md)
23. [AROMA Gateway: журнал mutation](22_AROMA_GATEWAY_OPERATION_JOURNAL.md)
24. [Матрица конфигурации 15 runtime](23_RUNTIME_CONFIGURATION_MATRIX.md)
25. [Service identity и delegation](24_SERVICE_IDENTITY_AND_DELEGATION.md)
26. [Rule parity Oxlint и tsgolint](25_TS7_LINT_RULE_PARITY.md)
27. [Effect-native foundation: единая техническая линия](26_EFFECT_NATIVE_FOUNDATION.md)
28. [Карта перехода downstream-задач на Effect](27_EFFECT_DOWNSTREAM_EXECUTION_MAP.md)

## Порядок силы документов

Для технической реализации после PR #22 применяется следующий порядок:

1. Machine authority `platform/runtime-foundation-decision.json` и service/DB/interaction manifests.
2. [ADR-0023](../adr/ADR-0023-effect-native-platform.md).
3. [Effect-native foundation](26_EFFECT_NATIVE_FOUNDATION.md).
4. [Единый dependency graph](13_DELIVERY_DEPENDENCY_GRAPH.md).
5. [Карта downstream-задач](27_EFFECT_DOWNSTREAM_EXECUTION_MAP.md).
6. Owner-specific business specifications и issue acceptance criteria.

Если старый launch-документ или открытая issue всё ещё упоминает Fastify, handwritten OpenAPI, Hey API, Temporal, Pino, TanStack Query, Promise-owned runtime либо direct `pg` как целевой путь, техническая формулировка считается заменённой ADR-0023 и картой перехода. Бизнес-инварианты, маршруты, ошибки, state machines, ownership, limits и failure semantics при этом сохраняются.

## Сила канонических документов

Operational delivery authority определена [ADR-0021](../adr/ADR-0021-github-operational-authority.md): используется только GitHub `YurGusev/CoffeeOrderPlatform`; другой forge не входит в workflow.

Пакет является прикладной проекцией новой системы и не изменяет пять неизменяемых канонических revision roots. Бизнес-инварианты M06/M07/M11/M12 и contract/security guarantees M19/M20 сохраняются. Production Node и physical runtime topology определяет [ADR-0019](../adr/ADR-0019-greenfield-node26-and-service-topology.md). Wire-расхождения первого запуска закрывает [ADR-0020](../adr/ADR-0020-launch-contract-closure.md). TS7 toolchain определяет [ADR-0022](../adr/ADR-0022-ts7-native-toolchain.md). Единственную Effect-native техническую платформу определяет [ADR-0023](../adr/ADR-0023-effect-native-platform.md).
