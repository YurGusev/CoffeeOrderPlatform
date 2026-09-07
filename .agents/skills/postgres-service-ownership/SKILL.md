---
name: postgres-service-ownership
description: Менять PostgreSQL-схемы, миграции и транзакции.
---

# Владение PostgreSQL в сервисах

У каждого контекста один writer и владелец миграций. Остальные используют API,
события владельца и локальные projections; межвладельческий SQL запрещён.

- Version and forward-test migrations; make recovery explicit.
- One acquired connection per transaction; no network under DB locks.
- Constraints/indexes encode correctness and performance.
- Use application-owned optimistic versions on public boundaries.
- Define money, time, identity, retention, PII, and deletion semantics.
- Keep Outbox/Inbox with the owning transaction.
- Prefer visible raw SQL for locks, fencing, CTEs, and queues.
- Budget pools fleet-wide with operational headroom.

По изменению и риску выбирать проверки чистой миграции, constraints, concurrency,
deadlocks/timeouts, планов, backup и restore; выполнять их на настоящем PostgreSQL.
