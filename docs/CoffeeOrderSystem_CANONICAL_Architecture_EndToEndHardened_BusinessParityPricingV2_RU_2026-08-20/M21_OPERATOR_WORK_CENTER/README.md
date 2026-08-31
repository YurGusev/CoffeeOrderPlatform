# M21 — Operator Work Center

Work Center — отдельный operational product/read model, а не набор SQL-виджетов.

Он агрегирует доменные факты из Kafka и строит deterministic queues. Сам Work Center **не владеет** Orders/Catalog/Invoices/Payments state и не пишет в их БД. Action всегда вызывает command owning service.

Основные очереди:

- New/Actionable Orders;
- Draft Pricing Stale/Unresolved;
- Catalog availability impact;
- AROMA UnknownOutcome/Blocked/ManualReview;
- Customer duplicate/identity review;
- Invoice parse/allocation/reconciliation exceptions;
- Payment waiting/overdue/failure/refund;
- Delivery coefficient review;
- operational conflicts/stale commands.
