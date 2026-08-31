---
name: invoices-service
description: Реализовывать или проверять приём invoices, allocation, materialization, document proof, применение цен, reconciliation и compensation в CoffeeOrderPlatform.
---

# Сервис счетов

Invoices владеет ClientInvoice, lines, allocations, метаданными документов,
неизменяемым price proof, materialization Inbox, reconciliation и compensation state.

- Normal creation starts from immutable Orders checkout/allocation proof, not
  a bare `OrderConfirmed` event.
- Validate ArtifactRef/hash and complete order coverage without cross-owner SQL.
- Keep document parsing/scanning in bounded workers, not API request paths.
- Persist owner state and Outbox atomically; consume commands idempotently.
- Unknown or partial supplier documents require explicit review/recovery state.
- Price facts return to Orders through verified immutable owner facts.

Проверять duplicate materialization, stale fingerprints, allocation sums,
malformed documents, crash/restart, полноту price proof, compensation и replay.
