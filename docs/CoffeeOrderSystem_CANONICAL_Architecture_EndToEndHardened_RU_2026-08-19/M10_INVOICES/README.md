# M10 — Invoices

## Цель

Перенести invoice lifecycle/materialization/reconciliation и отделить тяжёлые worker workloads.

## Зависимости

M04, M05, M06, M07

## Документы программы

- `01_INVOICES_MIGRATION.md`

## Definition of Done программы

Invoices DB5 ownership, event parity и legacy Invoice worker removal.

## Общий backlog

См. `../IMPLEMENTATION_BACKLOG_BY_PROGRAMS.md` (раздел этой программы).

## Правило выполнения

Production ownership меняется только после explicit parity/failure/recovery evidence и проверки зависимостей.

## Agent skill новой архитектуры

Основной skill: `next-invoices-migration`.

Для значимых изменений также активировать `next-architecture-router`; для parity/cutover/rewrite — `next-verification-and-parity`. Legacy skills разрешены только как reference/evidence старой реализации.


## Checkout handoff

Normal invoice materialization начинается с immutable checkout/wholesale command, не с простого `OrderConfirmed`.

## End-to-end hardening additions

- `03_ALLOCATION_MANIFEST_AND_PRICE_PROOF_CONTRACT.md` closes Orders→Invoices without cross-owner reads.
- `04_INVOICE_COMPENSATION_STATE_MACHINE.md` defines post-procurement correction facts.
