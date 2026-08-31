# Conflict Matrix: новые и legacy skills

## Правило приоритета

Когда задача касается target-архитектуры, `next-*` skill является нормативным. Legacy skill разрешён только как источник поведения старой системы.

| Legacy skill/правило | Target replacement | Допустимое использование legacy |
|---|---|---|
| `modular-monolith-architecture` | `next-architecture-foundation`, `next-typescript-platform` | изучить C# owner/invariants для migration |
| `module-boundaries-and-contracts` | `next-typescript-platform`, `next-kafka-event-platform` | извлечь текущие contracts/snapshots |
| `efcore-postgres-modules` | `next-postgres-migration` | понять EF schema/migrations до DB5 |
| `reliable-integration-outbox` | `next-kafka-event-platform`, `next-aroma-migration` | извлечь idempotency/UnknownOutcome invariants |
| `aroma-integration-development` | `next-aroma-migration` | characterization старого AROMA path |
| `react-frontend-development` (`src/...Web`) | `next-react-handover` | только baseline существующего React до handover |
| `blazor-*` | none in target | rollback/reference до удаления legacy |
| old AI/VK skills | `next-hermes-vk-runtime` | только понять current flows и удалить их безопасно |

## Запрещённые конфликты

Если legacy skill говорит:

```text
write target runtime code in src/**
C# modular monolith is final target
React production host must remain under src/**
AReaL is production runtime
```

это правило считается superseded для новой архитектуры.


## API-specific supersession

| Legacy/старое правило | Target replacement |
|---|---|
| один generic `/api` для browser/agent/internal | `next-api-architecture`: separate `client-v1`/`agent-v1`/`internal-v1` |
| React client генерируется из ASP.NET `obj/openapi` | language-neutral M19 contract registry |
| agent tools могут отражать весь OpenAPI | explicit Hermes capability allowlist |
| provider callback = обычный controller endpoint | exact verified webhook/callback surface |
| Kafka topic = только transport detail | versioned asynchronous API contract |


## Node runtime authority

Ни один legacy .NET/HostedService/old React build skill не определяет production Node process model. Для target Node workloads authority: `next-nodejs-runtime` + owning next-* skill.

## BusinessLogicHardened conflicts

| Legacy concept/skill behavior | Target authority |
|---|---|
| `react-frontend-development` legacy `sendToAromaCart` workflow | `next-react-handover` + M01/M12: remove from target |
| `aroma-integration-development` batch/cart-fill orchestration | `next-aroma-migration`: Desired/Observed/Convergence only |
| Modular-monolith AROMA code co-located with Orders API process | M20: separate runtime roles, same Orders ownership |
| `OrderConfirmed` as invoice trigger | M10/M20: immutable checkout+wholesale materialization command |
| manual payment collection as only happy path | M08: verified Payments lifecycle; manual is explicit fallback |


## CatalogHardened conflicts

| Legacy concept/behavior | Target authority |
|---|---|
| `CoffeeController`/generic Catalog CRUD as full Product semantics | `next-catalog-product-lifecycle` + M07 versioned Product/Variant rules |
| per-item AROMA mapping/provider revalidation | complete supplier snapshot + persisted mapping resolver |
| manual mapping save without immediate downstream fact | mapping + audit + Outbox in one Catalog transaction |
| Catalog price update silently rewriting Orders | explicit Draft pricing only; Confirmed snapshots historical |
| Product/Variant delete with downstream identity loss | availability/mapping tombstone + Orders target-zero convergence before key GC |
