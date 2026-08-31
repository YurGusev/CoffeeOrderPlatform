# 09. Подключение новой платформы к PostgreSQL: DB0–DB5

## 1. Почему не ждать конца разработки

Полностью разрабатывать backend на fake repositories, а затем впервые подключать PostgreSQL рискованно: реальные constraints, lock semantics, legacy data shapes и migrations могут потребовать изменения domain/application design.

При этом давать новой платформе production write access слишком рано ещё опаснее.

Поэтому используется последовательная модель.

## 2. DB0 — Domain Only

Без БД.

Проверяются чистые правила:

```text
Money/Quantity
Order state transitions
confirmation rules
Desired calculation
payment state transitions
```

Repository ports работают через in-memory fixtures.

## 3. DB1 — Real Schema Contract

Поднимается чистый PostgreSQL с DDL, совместимым с реальной схемой:

- types;
- nullability;
- indexes;
- unique/check constraints;
- sequences/identities;
- schema names.

Никаких production credentials/data.

## 4. DB2 — Sanitized Read-Only Clone

Новая платформа получает read-only user.

Используется для:

- реальной формы данных;
- query parity;
- pagination/sorting;
- edge cases legacy records;
- latency profiling.

## 5. DB3 — Writable Shadow Clone

Копия production-like data, но изолированная.

Здесь проверяются:

- transactions;
- migrations;
- locks;
- optimistic concurrency;
- outbox/inbox;
- rollback/retry;
- deadlock behavior;
- AROMA/payment simulators.

## 6. DB4 — Production Read Shadow

Новая платформа может читать production только через специально ограниченный read role/replica.

Запрещены DDL/DML.

Использование:

- shadow request comparison;
- real-data response parity;
- capacity baseline.

Sensitive data access требует production privacy policy.

## 7. DB5 — Production Write Ownership Cutover

Переключается **один bounded context/schema**.

Пример Catalog:

```text
1. C# — единственный writer
2. TS shadow/read parity
3. freeze EF migrations для catalog
4. approved TS migration baseline
5. stop/disable C# Catalog writer paths
6. switch Nginx route owner
7. TS becomes sole catalog writer
8. monitor/soak
9. remove C# Catalog mutation path
```

## 8. One Schema — One Writer

Во время migration запрещено:

```text
C# writes catalog.*
+
TS writes catalog.*
```

одновременно, кроме строго контролируемых test/shadow copies.

## 9. Migration ownership

После DB5 schema migration toolchain тоже получает одного owner.

До cutover:

```text
EF migrations own schema
```

После:

```text
TS migration toolchain owns schema
```

Два migration histories одной schema запрещены.

## 10. Schema contract capture

Перед каждым bounded-context migration создаётся versioned snapshot:

```text
DDL
indexes
constraints
row-count ranges
representative sanitized fixtures
known anomalous states
```

## 11. Parity queries

Сравниваются не только JSON responses, но и query semantics:

```text
null handling
case/collation
ordering ties
numeric precision
UTC/local date conversion
pagination boundaries
```

## BusinessLogicHardened: Orders/AROMA state ownership

`AromaCartDesiredSource`, Observed snapshots/current rows, Convergence/Attempt, checkout/wholesale proof и fulfillment projection остаются в **Orders-owned persistence**. Отдельные `aroma-observer`/`aroma-convergence`/checkout workloads не получают собственную бизнес-БД и не создают cross-service distributed transaction.

AROMA Gateway имеет отдельное техническое session/config storage при необходимости, но **не имеет write/read authority к Orders business tables**.

При DB5 cutover ownership переключается для Orders schema целиком по consistency boundary; нельзя перенести `Order` в TS, оставив C# writer для Desired/Convergence или наоборот.
