---
name: next-postgres-migration
description: "Use for PostgreSQL DB0→DB5 migration, schema compatibility, Drizzle/node-postgres/raw SQL, transactions, migrations, single-writer ownership, and C#→TypeScript data cutover."
---

# PostgreSQL DB0→DB5 Migration

## Source of truth

Каноническая программа: `M05_DATABASE_MIGRATION`. Перед существенным изменением прочитать её `README.md` и релевантные нормативные документы. Если этот skill противоречит канонической программе, **побеждает каноническая программа**, а skill должен быть обновлён.

## Область действия

Этот skill относится **только к новой архитектуре CoffeeOrderSystem**. Нормативная зона записи:

```text
platform/**
edge/**          # только target/strangler изменения
infra/**         # новая Docker/Kafka/Debezium/Kubernetes topology
hermes/**
training/**
```

`src/**` является legacy/reference-зоной. Изменять `src/**` разрешено только когда задача явно требует characterization/parity instrumentation, migration adapter, rollback support или удаления legacy после принятого cutover. Нельзя использовать legacy C# архитектуру как шаблон для target-кода.

Новая platform не должна импортировать runtime-код, сборки или внутренние типы из `src/**`. Разрешены только language-neutral contracts, наблюдаемое поведение, database schema evidence и characterization tests.

## Use when

- новая repository/persistence model;
- чтение legacy schema из TS;
- migration ownership меняется EF→TS;
- schema cutover/read-only/shadow write;
- locks/isolation/indexes/NUMERIC/time semantics.

## Hard rules

- Один writer/migration owner на business schema в каждый момент.
- DB0 pure domain → DB1 DDL contract → DB2 sanitized clone RO → DB3 writable clone → DB4 production RO shadow → DB5 TS ownership.
- TS не получает production write до parity/cutover gate.
- Не запускать EF и TS migrations как concurrent authorities одной schema.
- Сложный locking/CTE/`FOR UPDATE SKIP LOCKED` разрешено писать raw SQL; ORM не должен скрывать semantics.
- Transaction всегда использует один acquired connection/client.
- Indexes/constraints — часть behavior contract, не только performance detail.

## Workflow

1. Экспортировать/прочитать реальный DDL и data anomalies.
2. Смоделировать TS persistence без изменения production schema.
3. Пройти DB1–DB3 integration tests.
4. DB4: read parity против C#.
5. Freeze legacy migrations для bounded schema.
6. Baseline target migrations.
7. DB5 cutover с backup/rollback и post-cutover verification.

## Минимальная проверка

Перед завершением:

1. проверить соответствие каноническому документу программы;
2. проверить, что не создана новая скрытая cross-boundary зависимость;
3. выполнить targeted unit/integration/contract tests;
4. выполнить architecture/boundary tests для затронутого слоя;
5. проверить Docker build/health, если изменён runtime workload;
6. проверить observability и failure semantics, если изменён I/O/async path;
7. явно записать skipped checks и остаточный риск.
