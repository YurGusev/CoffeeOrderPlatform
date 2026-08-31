# M10. Invoice compensation

## 1. Orthogonal state

Invoice compensation не переписывает историю обычной materialization.

```text
None
Requested
Processing
Completed
Failed
ManualReview
```

## 2. Command

`InvoiceCompensationRequested` приходит через `coffee.invoices.commands.v1` и содержит stable `compensationRef`, invoice/checkout/order refs, reason и expected price-proof identity.

## 3. Rules

- до PDF/price proof безопасная local cancellation/unlink может быть автоматической;
- после price proof создаётся correction/credit evidence; original allocations не удаляются;
- Invoices не отменяет supplier wholesale order и не инициирует payment refund напрямую;
- duplicate compensationRef is idempotent;
- irreversible/ambiguous state -> `ManualReview`, не best-effort delete.

## 4. Events

```text
InvoiceCompensated
InvoiceCompensationFailed
```

Orders использует их только для своей compensation state; payment refund запускается отдельной Orders→Payments command.
