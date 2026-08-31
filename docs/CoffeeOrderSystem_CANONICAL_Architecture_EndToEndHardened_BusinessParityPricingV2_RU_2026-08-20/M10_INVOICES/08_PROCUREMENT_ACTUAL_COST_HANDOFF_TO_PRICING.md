# Procurement actual cost handoff to Pricing

После окончательной price allocation Invoices формирует неизменяемый `ProcurementGoodsCostFinalized`:

```text
ProcurementBatchRef
WholesaleOrderRef
ClientInvoiceRef(s)
Currency
GoodsAmountBasis
ActualSupplierGoodsTotal
AllocationManifestRef/hash
OccurredAt
```

Pricing использует этот факт только как cost basis для фактической доставки и margin. Он не переписывает Invoice или Order.
