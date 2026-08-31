# M14. Карта миграции HostedService/BackgroundService

Цель — не переносить poller один-в-один, а сохранить business semantics в правильном runtime/transport.

## Orders / AROMA

| Legacy/current component | Target |
|---|---|
| `AromaOrderPrepareCommandWorker` | `orders-aroma-preparation` Kafka consumer; DB poller удалить |
| `AromaCartFillCommandWorker` | **DELETE legacy** |
| `AromaCartFillBatchWorker` | **DELETE legacy**, target не имеет batch model |
| `AromaCartAutoSyncWorker` | **DELETE legacy** |
| `AromaAuthoritativeCartObserverWorker` | `aroma-observer` Orders-owned process role; safe GET only |
| `AromaAuthoritativeCartConvergenceWorker` | `aroma-convergence` Orders-owned Kafka-trigger + DB state machine |
| `AromaAuthoritativeStableFulfillmentRepairWorker` | event-driven projection + periodic anti-entropy safety net |
| `AromaCheckoutWholesalePollingService` | `aroma-checkout-poller`; safe external polling until provider event exists |
| `AromaCheckoutInvoiceMaterializationWorker` | replace DB worker transport with `InvoiceMaterializationRequested` Kafka command |
| `AromaScheduledCartVerificationService` | DELETE legacy after authoritative observer/convergence |
| `AromaScheduledFullFulfillmentReconciliationService` | CronJob/reconciliation safety net |
| `AromaSyncLogRetentionService` | CronJob |
| `AromaSessionMaintenanceService` | Gateway/session maintenance role |
| `OrderAvailabilityProjectionWorker` | Kafka primary projection + periodic repair |

## Frontend/API legacy

Удалить после target Orders authority:

```text
sendToAromaCart capability
/send-to-aroma-cart endpoints
React orderAromaCart client/hook/progress workflow
AromaCartFillBatch status UI
```

## AI legacy

| Component | Target |
|---|---|
| `AiToolProviderBootstrapper` | delete after Hermes plugin cutover |
| `AiRunWatchdogWorker` | Hermes/Dispatcher run lifecycle |
| `AiRetentionWorker` | temporary Cron then delete |
| `AiOutboxWorker` | Outbox -> Debezium -> Kafka |

## Catalog

| Component | Target |
|---|---|
| `AromaCatalogSnapshotWorker` | `catalog-supplier-sync` target workload: complete safe supplier snapshot + Catalog transaction |
| `CatalogAromaOutboxWorker` | delete; generic Catalog Outbox + Debezium + Kafka owns delivery |
| `ProductEmbeddingIndexWorker` | Kafka indexing workload |

## VK

| Component | Target |
|---|---|
| `VkLongPollWorker` | remove after Callback cutover |
| `VkInboundWorker` | Channel Ingress + Kafka |
| `VkVoiceTranscriptionWorker` | Kafka STT workload |
| `VkOutboundSenderWorker` | Channel Egress |

## Invoices

| Component | Target |
|---|---|
| `InvoiceOutboxWorker` | Outbox+Debezium+Kafka; domain guards retained |

## Decommission evidence

Worker/surface/table удаляется только когда:

- target path owns traffic;
- zero legacy queued work;
- no second writer/side-effect owner;
- rollback is bounded route/profile rollback, not dual writer;
- required audit/history retained;
- characterization scenarios ported where valuable.
