# M07 — Customer / Catalog / Products

## Цель

Перенести Customer и Catalog в новую TypeScript-платформу, **не потеряв бизнес-логику Товаров**, которая уже реализована в `develop`:

```text
local Product / Variant / Alias truth
+
complete AROMA wholesale snapshot
+
positive supplier prices
+
product_on_stop availability
+
deterministic AROMA mapping
+
durable Catalog facts
        ↓
Orders projections / Desired recalculation
        ↓
AROMA authoritative convergence
```

Catalog — не CRUD-справочник. Он является владельцем товарной идентичности и supplier facts, от которых зависят создание/редактирование Draft, доступность, mapping и возможность положительного вклада подтверждённого заказа в корзину AROMA.

## Зависимости

M03, M04, M05, M06, M11, M12, M19, M20.

## Документы программы

1. `01_CUSTOMER_CATALOG_PARITY_AND_CUTOVER.md` — migration/cutover.
2. `02_PRODUCT_DOMAIN_AND_UPDATE_SEMANTICS.md` — Product/Variant/Alias и виды обновлений.
3. `03_AROMA_SUPPLIER_CATALOG_SYNC_PIPELINE.md` — полный supplier snapshot pipeline.
4. `04_PRODUCT_VARIANT_AVAILABILITY_AND_TOMBSTONES.md` — availability/change feed/delete semantics.
5. `05_AROMA_MAPPING_LIFECYCLE.md` — deterministic/manual mapping lifecycle.
6. `06_CATALOG_PRICING_AND_ORDER_SNAPSHOT_RULES.md` — цена Catalog vs исторические Order snapshots.
7. `07_CATALOG_TO_ORDERS_AROMA_CART_REACTION.md` — как изменения Товара меняют Desired/AROMA cart.
8. `08_LEGACY_CSHARP_CATALOG_BEHAVIOR_SOURCE_MAP.md` — что именно переносить из `develop`.

## Нормативный pipeline

```text
catalog-supplier-sync
    ↓
AROMA Gateway safe complete catalog GET
    ↓
validate completeness + content hash
    ↓
Catalog transaction
    ├─ immutable snapshot/current offers/discounts
    ├─ supplier availability projection
    ├─ deterministic local product/variant materialization
    ├─ deterministic AROMA mappings
    ├─ re-apply availability for newly mapped identities
    └─ Outbox: Product/Availability/Mapping facts
          ↓
        Kafka
          ↓
Orders Inbox
    ├─ availability read projection
    └─ authoritative Desired semantic recalculation
          ↓
AROMA convergence when target changed
```

## Definition of Done

- Product/Variant/Alias ownership перенесён без semantic drift.
- Supplier sync принимает только complete successful snapshot.
- `product_on_stop`, missing mapping, mapping ambiguity и transport failure не смешиваются.
- Positive supplier price никогда не переписывает исторические Confirmed/Checkout orders автоматически.
- Draft price refresh остаётся explicit + version-protected.
- Все semantic availability/mapping changes публикуются через Catalog Outbox.
- Manual mapping больше не ждёт следующего hourly snapshot для downstream propagation.
- Product/Variant tombstone fail-closed исключает активный Desired из положительного cart target.
- Catalog не мутирует Orders DB и не вызывает AROMA cart endpoints.
- Orders positive convergence требует свежий Catalog proof перед physical cart mutation.

## Agent skills

Основные: `next-customer-catalog-migration`, `next-catalog-product-lifecycle`.

При изменении связи с Orders/AROMA обязательно: `next-business-orchestration`, `next-aroma-migration`, `next-kafka-event-platform`, `next-verification-and-parity`.


## Current behavior evidence

Cross-check источники: current `develop` Product/Catalog code плюс accepted `docs/architecture/06_aroma_hourly_catalog_sync.md` и `docs/processes/AROMA-110_hourly_catalog_sync.md`. Они используются как behavior evidence; target runtime/transport остаётся TypeScript/Kafka.

- `09_CUSTOMER_LIFECYCLE_AND_CHANNEL_LINKS.md`

- `10_CUSTOMER_PII_RETENTION_AND_CUTOVER.md`

- `11_CATALOG_CONCURRENCY_AND_OVERRIDE_EPOCH.md`

- `12_PRODUCT_PURGE_MAINTENANCE_POLICY.md`

- `13_CATALOG_SEARCH_INDEX_PROJECTION.md`
