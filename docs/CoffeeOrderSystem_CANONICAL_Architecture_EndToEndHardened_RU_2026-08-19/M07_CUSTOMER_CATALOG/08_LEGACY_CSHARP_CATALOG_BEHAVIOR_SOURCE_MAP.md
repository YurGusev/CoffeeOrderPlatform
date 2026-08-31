# M07. Current C# Catalog behavior → Target TypeScript source map

Этот документ определяет, **какие current C# behaviors являются specification evidence**, чтобы агент не переписал только DTO/контроллеры и не потерял hidden business logic.

| Current source | Семантика | Target decision |
|---|---|---|
| `Catalog/Domain/Coffee.cs` | local product truth, prices, availability time, aliases/variants | переносить semantic fields/ownership; target app-owned version |
| `Catalog/Domain/CoffeeWeightVariant.cs` | package identity, piece key 0, availability | переносить |
| `Catalog/Application/Services/AvailabilityTransition.cs` | initial vs semantic availability transition | переносить 1:1 behavior |
| `Catalog/Application/UseCases/ProductsUseCase.cs` | versioned Product/Variant/Alias CRUD and destructive confirmation | переносить behavior, не EF structure |
| `Catalog/Api/ProductsController.cs` | client-v1 style error/version semantics | переносить contract semantics |
| `Catalog/Infrastructure/CatalogDbContext.cs` | availability/tombstone + Outbox generated in same SaveChanges | **критический invariant**; переносить explicit transaction/domain service |
| `Catalog/Infrastructure/Services/AromaCatalogSnapshotWorker.cs` | bounded scheduled complete supplier read | переносить как `catalog-supplier-sync` runtime role |
| `RunAromaCatalogSnapshotUseCase.cs` | lease/fence, full snapshot quality, hash, transaction pipeline | переносить algorithmically |
| `ProjectAromaSupplierAvailabilityUseCase.cs` | exact product_on_stop suspend/restore | переносить |
| `ProjectAromaCatalogMaterializationUseCase.cs` | deterministic local SKU/variant/price update + history | переносить |
| `ProjectAromaCatalogBulkMappingsUseCase.cs` | exact vendor/package/grind/family matching; manual preservation | переносить |
| `EnqueueAromaCatalogMappingFactsUseCase.cs` | immutable snapshot mapping facts/outbox | переносить через generic target Outbox/Kafka |
| `ProcessCatalogAromaOutboxUseCase.cs` | bounded delivery/self-contained source sequence | transport заменить на Outbox/CDC/Kafka; семантику idempotency сохранить |
| `Orders/ApplyCatalogAvailabilityChangeUseCase.cs` | current: idempotent availability read projection + tombstones/source sequence | переносить и усилить: tombstone/unavailable safety также должна fail-close active Desired, не только UI projection |
| `Orders/ApplyAromaCatalogMappingFactUseCase.cs` | Catalog mapping fact -> DesiredRevision/target | переносить business behavior |
| `Catalog/Infrastructure/AromaCatalogAvailabilityClient.cs` | repeatable local latest-complete-snapshot preflight; no AROMA HTTP | переносить как read-only Catalog proof |
| `Orders/RefreshAromaProductAvailabilityUseCase.cs` | pre-cart local Catalog proof -> Desired availability projection; stable fulfillment guard | переносить |
| `Orders/AromaProcurementPricingQuoteService.cs` | Draft explicit pricing from persisted Catalog facts + Orders policy | переносить |
| `Orders/RefreshDraftOrderProcurementPricesUseCase.cs` | Draft-only/version-locked reprice | переносить |
| `Catalog/Infrastructure/AromaOfferMappingRepository.UpdateManualAsync` | manual override + audit | переносить и **усилить atomic mapping Outbox** |

## Не переносить как target

```text
weekly Catalog price-list Excel runtime
per-item provider revalidation scheduler
CatalogAromaOutboxWorker polling as transport
CatalogModuleClient in-process coupling as architectural boundary
EF SaveChanges interception as единственный способ выразить business rule
```

Их behavior переносится в явные TypeScript application services + DB transaction + Outbox.

## Characterization corpus

Перед cutover обязательно зафиксировать кейсы:

1. same availability → no event;
2. availability transition → exactly one event;
3. product delete → product + all variant tombstones;
4. failed/partial/suspicious supplier snapshot → last success unchanged;
5. same content hash → no duplicate materialization;
6. positive price changed → price history once;
7. invalid/non-positive price → no overwrite;
8. stopped offer → no price update/new SKU;
9. exact new product → deterministic create;
10. ambiguous product/package/grind/family → review only;
11. manual mapping preserved against bulk resolver;
12. stop→restore preserves prior mapping state;
13. mapping fact duplicate → Orders Inbox no-op;
14. mapping remap → old/new key versions;
15. stable fulfillment + later Catalog Ready → never reintroduce to cart;
16. Draft explicit refresh updates quote/total but Confirmed order does not auto-reprice.
