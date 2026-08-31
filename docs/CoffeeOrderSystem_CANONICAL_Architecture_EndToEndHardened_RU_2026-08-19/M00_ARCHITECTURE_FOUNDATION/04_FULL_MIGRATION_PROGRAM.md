# 22. Полная программа миграции C# → TypeScript

## 1. Стратегия

Это **parallel clean-room rebuild + strangler cutover**, а не branch rewrite.

```text
Current C# production remains authority
        |
        +--> target platform develops independently
        |
        +--> parity/shadow/canary
        |
        +--> bounded context ownership transfer
        v
C# production workload -> 0
```

## 2. Phase P0 — repository/platform foundation

Создать:

```text
platform/
infra/compose/
hermes/
training/
```

Добавить strict TS/pnpm/architecture guardrails.

Production routing не меняется.

## 3. Phase P1 — React copy/handover

Скопировать `src/CoffeeOrderSystem.Web` -> `platform/apps/web`.

Сохранить behavior. Отвязать API generation от `.NET obj`.

Собрать новый immutable `platform-web` image.

## 4. Phase P2 — Docker reference runtime

Поднять side-by-side:

```text
coffee-edge
old reactweb
platform-web
legacy C# API
platform API skeleton
PostgreSQL clone
```

## 5. Phase P3 — frontend web cutover

Nginx:

```text
/app/* -> platform-web
```

API пока остаётся C#.

После soak заморозить старый React source.

## 6. Phase P4 — contracts + DB1

Создать language-neutral contracts и real DDL test database.

Новая platform не пишет production.

## 7. Phase P5 — Customer/Catalog read parity

Реализовать TS reads на sanitized clone, затем production read-shadow.

Nginx production API routes всё ещё legacy.

## 8. Phase P6 — Payments target-native

Новый Payments сразу строить на TS в isolated DB/test provider.

Это первый полностью target-native business context.

## 9. Phase P7 — Kafka/Debezium foundation

Local/test сначала:

```text
Postgres outbox -> WAL -> Debezium -> Kafka
```

Ввести canonical envelope, Inbox, replay tests, monitoring.

## 10. Phase P8 — Node channel/realtime/Hermes orchestration

```text
VK -> Node -> Kafka -> Hermes Dispatcher -> Hermes
```

Без переноса Orders authority.

## 11. Phase P9 — Catalog production read canary

Nginx route family переключается малыми cohort/route gates.

Catalog TS ещё не writer.

## 12. Phase P10 — Catalog DB5 ownership

Freeze legacy Catalog writes/migrations, TS становится единственным writer `catalog.*`.

После soak удалить legacy Catalog mutation paths.

## 13. Phase P11 — Payments production

После provider/security/reconciliation evidence Payments выходит production.

## 14. Phase P12 — Invoices migration

Read parity -> shadow writes on clone -> event parity -> DB ownership cutover.

PDF/CPU-heavy operations могут остаться отдельным worker workload.

## 15. Phase P13 — AROMA Gateway transport

Перенос provider protocol на TS gateway.

C# Orders пока владеет Desired/Observed/UnknownOutcome.

## 16. Phase P14 — Orders read parity

Все Orders reads реализуются в TS против clone/prod read-shadow.

Особое внимание grouped invoice/order projections, pagination, current Draft.

## 17. Phase P15 — Orders Draft mutations

Сначала TS decision shadow. Затем controlled Draft write cohort.

Confirmation/AROMA ещё остаются legacy owner.

## 18. Phase P16 — Confirmation

Перенос exact summary/proof/version/idempotency protocol.

No blind retry.

## 19. Phase P17 — AROMA state machine

Самый рискованный этап:

```text
Desired
Observed
Lease
Fencing
UnknownOutcome
Checkout
```

Только после property/parity/fault tests.

## 20. Phase P18 — Orders DB ownership

TS становится единственным Orders writer. Legacy route rollback возможен только в пределах forward-compatible contract; нельзя возвращать старый writer после несовместимой migration.

## 21. Phase P19 — C# traffic -> zero

Nginx metrics должны показывать 0 production API traffic на legacy C#.

Все consumers/workers C# выключены.

## 22. Phase P20 — legacy decommission

Удаление:

- C# API/runtime;
- old migrations после archive/evidence;
- old React copy;
- obsolete Compose services;
- legacy feature flags;
- duplicated docs/tests.

## 23. Phase P21 — Kubernetes scale-out

Kubernetes может начаться раньше для stateless workloads, но финальная multi-node production topology вводится только после Docker/process isolation и operational evidence.

## 24. Никогда не делать

```text
big-bang C# off / TS on
```

```text
C# и TS одновременно writers одной schema
```

```text
frontend rewrite + backend rewrite + SSR одновременно
```

```text
Kafka как единственное доказательство external provider state
```
