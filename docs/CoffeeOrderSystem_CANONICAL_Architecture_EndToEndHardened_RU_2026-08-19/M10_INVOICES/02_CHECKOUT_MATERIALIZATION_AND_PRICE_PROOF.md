# M10. Immutable checkout → Invoice → price proof

## 1. Input contract

Invoices получает immutable command, сформированную Orders из уже сохранённого checkout/wholesale proof. Command не требует нового AROMA read.

Минимальные поля:

```text
operationRef
checkoutSnapshotRef
wholesaleSnapshotRef
profileName
convergenceProofHash
wholesaleOrderRef/number snapshot
allocationManifest ArtifactRef + sha256 + byteSize + schemaVersion
```

## 2. No cross-read

Invoices не читает Orders DB. Если payload недостаточен, command contract исправляется; worker не делает SQL/HTTP «добор» из Orders internals.

## 3. Materialization transaction

```text
Inbox(operationRef)
+ create/resume invoice
+ exact allocations
+ reconciliation state
+ price-application Outbox
```

одна local transaction.

## 4. Price application result

После полного применения цен Invoices публикует `InvoicePricesApplied` с immutable price-proof ArtifactRef/hash и bounded per-order totals/coverage hashes. Orders повторно валидирует local correlation и только затем делает `Confirmed -> AwaitingCustomerPayment`.

## 5. Compensation

После price application обычный unlink запрещён. До применения цен compensation выполняется через explicit command/facts; повтор имеет stable identity.


Подробный wire contract: `03_ALLOCATION_MANIFEST_AND_PRICE_PROOF_CONTRACT.md`.
