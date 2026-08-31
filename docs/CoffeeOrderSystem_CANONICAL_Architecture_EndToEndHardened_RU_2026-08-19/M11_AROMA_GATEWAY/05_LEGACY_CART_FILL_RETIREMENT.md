# M11. Retirement legacy `sendToAromaCart` / `AromaCartFillBatch`

## 1. Почему legacy не переносится

Legacy flow позволяет physical supplier state существовать для mutable Draft. Это создаёт две конкурирующие модели intent: Draft и cart-fill batch.

Target intent появляется только после `Confirm`.

## 2. Компоненты для decommission

После authoritative cutover удалить/закрыть target-equivalents следующих legacy concepts:

```text
SendToAromaCart endpoint/capability
AromaCartFillBatch
AromaCartFillLine
AromaCartFillLineAllocation
AromaCartFillBatchWorker
AromaCartAutoSyncWorker
StartAromaCartFillBatch*
React orderAromaCart / useOrderAromaCartFillWorkflow / progress batch UI
legacy batch status polling endpoints
```

Фактические C# таблицы удаляются только после evidence/retention gate M14.

## 3. Что сохранить как behavioral corpus

Не выбрасывать тестовые знания:

- duplicate physical line -> manual/block;
- missing cart item ID blocks update/delete;
- baseline/target/actual comparisons;
- one unsafe request per attempt;
- fresh GET after mutation;
- response-lost/UnknownOutcome cases;
- contribution changed before mutation -> no send;
- provider default packing/grind canonicalization.

Эти scenarios переписываются как characterization/property tests нового authoritative engine.

## 4. Frontend migration

Copy-first перенос React сначала может временно содержать legacy UI как compatibility code, но перед target Orders route authority:

```text
sendToAromaCart action removed
batch polling UI removed
AROMA section becomes server-derived sync/diagnostic read model
```

## 5. No hidden compatibility API

Nginx не оставляет target-visible `/send-to-aroma-cart` alias после cutover. Rollback возвращает целую legacy route family, а не смешивает target Orders с legacy batch writer.
