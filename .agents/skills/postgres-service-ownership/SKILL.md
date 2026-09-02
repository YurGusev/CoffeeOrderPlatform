---
name: postgres-service-ownership
description: Проектировать или менять PostgreSQL schemas, migrations, transactions, locks, indexes и границы «БД на владельца» в CoffeeOrderPlatform.
---

# Владение PostgreSQL в сервисах

У каждого контекста один writer и владелец миграций. Остальные используют API,
события владельца и локальные projections; межвладельческий SQL запрещён.

Runtime-доступ выполняется через `@effect/sql-pg`; прямые `pg`/`pg-copy-streams`
допустимы только внутри реализации platform database adapter и узких admin/CLI
seams. Строки из БД декодировать Effect Schema до передачи в домен.

- Миграции именовать `NNNN_<slug>.sql`, применять последовательно и
  forward-test; rollback/recovery описывать явно.
- Одна Coffee transaction использует одно acquired connection. Ошибка до
  `COMMIT` откатывается; потеря результата `COMMIT` становится typed
  `TransactionOutcomeUnknown` и требует reconciliation, а не автоматического
  повтора. Не выполнять network I/O под DB locks.
- Constraints/indexes encode correctness and performance.
- Use application-owned optimistic versions on public boundaries.
- Define money, time, identity, retention, PII, and deletion semantics.
- Keep Outbox/Inbox/idempotency with the owning transaction; production
  in-memory durability substitutes запрещены.
- Prefer visible raw SQL for locks, fencing, CTEs, and queues.
- Budget pools fleet-wide with operational headroom.

Проверять чистую миграцию, constraints, concurrency, deadlocks/timeouts, планы,
backup и restore на настоящем PostgreSQL.
