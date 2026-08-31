# M10. Checkout Allocation Manifest и Invoice Price Proof

## 1. Решение

Invoices **не читает Orders DB**. Поэтому `InvoiceMaterializationRequested` всегда содержит immutable ArtifactRef на self-contained allocation manifest.

Inline allocations в Kafka normal path не используются: один Checkout может включать много Orders и превысить safe message budget.

## 2. CheckoutAllocationManifest.v1

Orders создаёт JSON artifact перед staging invoice command:

```text
manifestRef
checkoutSnapshotRef
profileName
checkoutVersion
convergenceProofHash
wholesaleSnapshotRef
wholesaleOrderRef
wholesaleOrderNumber
wholesaleObservedAtUtc
currency
allocations[]
```

Каждая allocation:

```text
allocationRef
orderRef
orderVersionAtCheckout
orderItemRef
cartKeyHash
externalOfferRef
externalGrindRef?
externalPacking?
quantity
wholesaleLineRef
supplierUnitPriceMinor?
```

Manifest хранится immutable в Artifact Storage; command передаёт:

```text
artifactRef
sha256
byteSize
schemaVersion=1
```

## 3. Invoices validation

Invoices command handler:

1. Inbox `invoiceOperationRef`;
2. verify ArtifactRef metadata/hash/size;
3. validate `checkout-allocation-manifest.v1` schema;
4. verify no duplicate allocationRef/orderItemRef coverage;
5. verify line quantity sums equal frozen wholesale snapshot quantities;
6. create/resume ClientInvoice + exact InvoiceAllocation;
7. store manifest hash;
8. Outbox `InvoiceMaterialized`.

No cross-owner lookup.

## 4. InvoicePriceProofManifest.v1

После PDF/wholesale price reconciliation Invoices создаёт второй immutable artifact:

```text
priceProofRef
clientInvoiceRef
checkoutSnapshotRef
wholesaleSnapshotRef
allocationManifestSha256
currency
lines[]
orders[]
```

`lines[]` содержит exact supplier line/order allocation price proof. `orders[]` содержит:

```text
orderRef
orderVersionAtCheckout
amountMinor
lineCoverageHash
allocationCount
```

## 5. InvoicePricesApplied event

Kafka event содержит bounded per-order proof summaries + ArtifactRef/hash полного manifest. Orders не должен читать Invoices DB.

Orders переводит `Confirmed -> AwaitingCustomerPayment` только если:

- orderRef/current immutable checkout correlation совпадает;
- `orderVersionAtCheckout` совпадает с frozen version;
- lineCoverageHash покрывает все активные OrderItem;
- amount/currency совпадают с verified manifest;
- duplicate EventId no-op.

## 6. Size

Manifest может быть большим, но Kafka command остаётся < 256 KiB. Artifact object max for these JSON manifests baseline: 16 MiB; превышение означает design/data anomaly и требует chunked manifest ADR, а не silent truncation.
