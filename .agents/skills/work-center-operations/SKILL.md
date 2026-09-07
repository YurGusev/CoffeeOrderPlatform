---
name: work-center-operations
description: Менять Work Center, очереди и операторское recovery.
---

# Операции Work Center

Work Center владеет только метаданными queue/read model. Он никогда не пишет
бизнес-состояние Orders, Customer, Catalog, Pricing, Invoices, Payments или AROMA.

- Build projections from owner events with version/idempotency guards.
- Business repair routes to a typed owning-context command with authenticated
  actor, capability, reason, expected version/fingerprint, and idempotency key.
- No generic repair endpoint, universal PATCH, or direct business SQL.
- Acknowledged/Snoozed/Resolved are queue metadata, not business completion.
- Resolve business work only after consuming authoritative owner completion fact.
- UnknownOutcome requires owner/provider observation, never blind retry.

Проверять replay/rebuild, stale projection, authorization команды, audit linkage,
duplicate action, completion correlation и запрет generic mutation.
