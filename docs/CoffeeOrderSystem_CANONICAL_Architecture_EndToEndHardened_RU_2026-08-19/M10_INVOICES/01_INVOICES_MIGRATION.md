# M10. Миграция Invoices в TypeScript

## 1. Ownership

Invoices bounded context владеет:

- client invoice lifecycle;
- invoice lines/allocations;
- PDF metadata/materialization state;
- checkout/wholesale proof reference;
- price-application proof/commands;
- reconciliation diagnostics.

Orders владеет supplier checkout/wholesale snapshot и Order lifecycle.

## 2. Нормальный trigger invoice materialization

**Не** простой `OrderConfirmed`.

Нормальный target flow:

```text
Orders physical cart exact
-> immutable CheckoutSnapshot
-> linked exact WholesaleSnapshot
-> InvoiceMaterializationRequested
-> Invoices inbox
-> create/resume one ClientInvoice
```

Это устраняет раннее/ложное invoice formation до supplier proof.

## 3. Stable idempotency identity

```text
profile + checkoutSnapshotRef + wholesaleSnapshotRef
```

Повтор того же payload возвращает тот же invoice/result. Изменённый payload с той же identity — conflict.

## 4. Migration order

```text
I0 characterization + contracts
I1 TypeScript read parity
I2 materialization inbox parity
I3 PDF/reconciliation worker boundary
I4 Kafka command/event parity
I5 price proof parity
I6 DB5 ownership cutover
I7 remove C# InvoiceOutboxWorker/legacy writers
```

## 5. CPU-heavy PDF work

Не блокировать Node event loop. Parsing/extraction выполняются bounded worker role/process, а business state остаётся Invoices-owned PostgreSQL.

## 6. Cross-context integration

Invoices не пишет Orders tables и не вызывает AROMA.

Inbound:

```text
coffee.invoices.commands.v1
  InvoiceMaterializationRequested
```

Outbound:

```text
InvoiceMaterialized
InvoicePdfLinked
InvoicePricesApplied
InvoiceCompensationCompleted/Failed
```

Orders consumes only facts needed for its own lifecycle/projections.

## 7. Reconciliation

Kafka delivery не заменяет three-way proof. При расхождении checkout/wholesale/PDF фактов состояние остаётся operator-visible и repairable.
