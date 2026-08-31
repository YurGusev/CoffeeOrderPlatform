# M08 — Payments

## Цель

Реализовать новый Payments context сразу в target TypeScript stack с provider idempotency/reconciliation.

## Зависимости

M04, M05, M06, M15

## Документы программы

- `01_PAYMENTS_ARCHITECTURE.md`

## Definition of Done программы

PaymentIntent/webhooks/refunds/reconciliation работают; provider UnknownOutcome безопасен.

## Общий backlog

См. `../IMPLEMENTATION_BACKLOG_BY_PROGRAMS.md` (раздел этой программы).

## Правило выполнения

Production ownership меняется только после explicit parity/failure/recovery evidence и проверки зависимостей.

## Agent skill новой архитектуры

Основной skill: `next-payments-platform`.

Для значимых изменений также активировать `next-architecture-router`; для parity/cutover/rewrite — `next-verification-and-parity`. Legacy skills разрешены только как reference/evidence старой реализации.



## Связь с M19 API Architecture

Payment webhooks и outbound provider APIs следуют M19 webhook/provider trust model.

## Orders handoff

Payment normal flow начинается с `OrderPaymentRequired` и заканчивается verified `PaymentSucceeded`; direct Orders DB/write callback запрещён.

## End-to-end hardening additions

- `03_REFUND_CANCELLATION_AND_COMPENSATION.md` — explicit refund/cancel state machines/contracts.
- `04_PAYMENT_RUNTIME_TOPOLOGY_AND_WEBHOOK.md` — separate inbound webhook runtime and reconciliation workers.
