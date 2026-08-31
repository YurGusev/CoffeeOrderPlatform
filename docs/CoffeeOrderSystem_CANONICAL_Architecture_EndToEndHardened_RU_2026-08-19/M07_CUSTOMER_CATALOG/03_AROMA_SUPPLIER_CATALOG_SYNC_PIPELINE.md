# M07. AROMA Supplier Catalog Sync — нормативный pipeline обновления Товаров

## 1. Зачем нужен отдельный supplier-sync process

AROMA wholesale catalog сообщает operational supplier facts:

```text
offer/product identity
vendor_code
package/grind parameters
wholesale list price
product_on_stop
promotion/discount rules
```

Эти данные обновляют Catalog, **но не являются командой на изменение Order или AROMA cart**.

## 2. Runtime role

Target role:

```text
catalog-supplier-sync
```

Это Catalog-owned worker/Cron-style scheduled workload. Он использует собственный Catalog DB principal и AROMA Gateway safe-read capability.

Он не имеет:

- Orders DB credentials;
- AROMA cart mutation capability;
- Invoices/Payments access.

## 3. Exact flow

```text
schedule / Admin explicit refresh
        ↓
Catalog DB: acquire lease + fencing token
        ↓
AROMA Gateway: GET complete wholesale catalog (all pages)
        ↓
normalize + validate completeness + content hash
        ↓
failed/partial/suspicious shrink?
    ├─ yes -> record failed/rejected run; preserve last success
    └─ no
        ↓
BEGIN Catalog transaction
        │
        ├─ fence recheck
        ├─ immutable snapshot (new hash only)
        ├─ current offers projection
        ├─ current promotion/discount projection
        ├─ supplier availability projection
        ├─ deterministic Product/Variant materialization
        ├─ deterministic AROMA bulk mapping
        ├─ re-apply availability for newly mapped identities
        ├─ Outbox: Product facts
        ├─ Outbox: Availability facts
        └─ Outbox: Mapping facts
COMMIT
        ↓
Debezium/Kafka
```

External GET находится **вне** retryable DB transaction. DB execution retry не повторяет supplier HTTP read.

## 4. Complete snapshot quality gate

Snapshot не меняет current Catalog, если не доказано:

1. все страницы прочитаны успешно;
2. provider IDs/offer identities валидны;
3. нормализованная identity уникальна;
4. offer count выше minimum;
5. shrink относительно последнего complete success не ниже configured threshold;
6. parsing/duplicate/invalid values классифицированы reason codes.

`failed GET`, `partial snapshot`, `suspicious shrink` сохраняют предыдущий current projection.

## 5. Content hash / idempotency

Canonical content hash покрывает supplier facts, которые влияют на бизнес, включая promotions.

Same hash:

- фиксирует successful heartbeat/freshness;
- не создаёт новую product price history;
- не создаёт duplicate mapping business change;
- не должен повторно менять Orders Desired.

## 6. Current offers projection

После complete success current projection заменяется атомарно.

Provider может заменить `ExternalOfferId`, сохранив vendor code. Target должен разрешать этот legit remap только через complete-snapshot identity rules; старый offer нельзя удалить до подтверждения полноты snapshot.

## 7. Materialization order

Нормативный порядок после snapshot persistence:

```text
A. availability for known mappings
B. product/variant + price materialization
C. deterministic bulk mapping
D. availability re-projection for new mappings
E. downstream facts/outbox
```

Пункт D критичен: если в этом же run появилась новая exact mapping для stopped offer, она должна сразу получить `TemporarilyUnavailable`, а не стать положительным cart candidate до следующего часа.

## 8. Product/price materialization

Supplier offer может обновить/создать local Product только при deterministic proof.

### Existing exact identity

Приоритет:

1. approved active exact mapping;
2. unique exact local `SupplierArticle == vendor_code` + package identity.

### New Product

Автосоздание допустимо только если однозначно известны:

- supported ProductFamily/category;
- product name;
- vendor code;
- package identity;
- grind semantics;
- positive supplier price.

Иначе создаётся review/staging record, а не duplicate/guess Product.

### Price

`price <= 0` никогда не затирает рабочую цену. Positive change:

- обновляет Variant supplier/list price;
- обновляет canonical Product purchase/base fact при canonical variant;
- добавляет `ProductPriceHistory` с old/new/source/effectiveAt.

Stopped offer (`product_on_stop=true`) не обновляет цену и не создаёт новый SKU.

## 9. Mapping materialization

Exact matching key:

```text
normalized vendor code
+ package/non-weight key
+ canonical grind
+ ProductFamily
```

Manual-approved mapping имеет приоритет и не переписывается bulk resolver.

Collision/ambiguity → `PendingReview/ManualReview`, не auto-match.

## 10. Supplier availability

`product_on_stop=true`:

- сохраняет previous mapping review/active state;
- переводит mapping в `TemporarilyUnavailable`;
- делает variant unavailable;
- product availability выводится из вариантов;
- manual review **не создаётся**, потому что identity известна.

Поздний exact available snapshot восстанавливает сохранённое mapping state.

## 11. Outbox boundary

Catalog transaction **не вызывает Orders**.

После commit только Outbox/CDC публикует:

```text
coffee.catalog.products.v1
coffee.catalog.availability.v1
coffee.catalog.mapping.v1
```

Manual mapping mutation обязана использовать тот же Outbox semantic path; ждать следующего scheduled snapshot для Orders propagation запрещено.

## 12. Что не переносится

Не переносить как primary runtime:

- weekly Catalog price-list Excel import;
- per-item scheduled provider revalidation;
- direct Catalog→Orders callback;
- mapping resolver, который делает N provider requests на N order lines.

Полный supplier snapshot — target operational source. Order Excel/import и Invoice PDF — другие bounded workflows.

## Coalesced on-demand refresh on stale preflight

Hourly schedule remains normal source. If Orders positive-cart preflight sees snapshot Stale/Unavailable, it fails closed and may publish `CatalogRefreshRequested` to `coffee.catalog.sync.commands.v1`.

`catalog-supplier-sync` coalesces commands by the same lease and minimum interval; 100 stale cart keys cannot create 100 provider GETs. Resolver/convergence never performs per-item provider lookup while waiting.
