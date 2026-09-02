# Исполнимая спецификация Catalog

Технический путь: Effect `Schema`/`Stream`, owner-local `Layer` и
`@effect/sql-pg`; generated contract artifacts производны и не являются runtime
source. Business semantics и limits ниже не изменяются.

Статус: нормативная спецификация первого запуска. Исполнитель не выбирает
транспорт, состояния, лимиты, владельцев или семантику событий заново.

## 1. Единая цепочка

```text
AROMA provider
  -> aroma-gateway: private HTTP NDJSON stream
  -> catalog-supplier-sync: batch validation + staging
  -> Catalog DB: Received generation
  -> catalog-activation-worker: validation + atomic activation + Outbox
  -> catalog-service: client search + private pricing input
  -> pricing-service / web / Orders
```

Полные записи каталога не передаются через Kafka. Kafka содержит только
неизменяемые факты владельца после локального commit. Между Catalog workers нет
Kafka-команды: `catalog-activation-worker` выбирает `Received` generation из
Catalog DB через `FOR UPDATE SKIP LOCKED`.

## 2. Владение и runtime

Все три Catalog runtime принадлежат bounded context `Catalog`:

| Runtime | Обязанность | БД/роль | Запрещено |
|---|---|---|---|
| `catalog-supplier-sync` | получить поток, проверить и записать staging | `coffee_platform_catalog` / `coffee_catalog_import_rw` | active tables, Outbox, публичный API |
| `catalog-activation-worker` | проверить `Received`, материализовать и активировать | `coffee_platform_catalog` / `coffee_catalog_activate_rw` | provider HTTP, public HTTP |
| `catalog-service` | читать только активное поколение и обслуживать HTTP | `coffee_platform_catalog` / `coffee_catalog_api_ro` | provider HTTP, staging writes, activation |

Секреты AROMA доступны только `aroma-gateway`. Ни один Catalog runtime не
получает URL/роль Customer, Pricing, Orders или Integration DB.

## 3. Поток Gateway -> Catalog

### 3.1 Route

`POST /api/internal-v1/aroma/catalog-exports`

- audience: только service identity `catalog-supplier-sync`;
- request: `{ "snapshotRef": "snp_<ULID>", "supplierRef": "sup_<ULID>" }`;
- response: `200 application/x-ndjson; charset=utf-8`;
- общий deadline: `15m`; idle timeout между records: `30s`;
- клиент обязан поддерживать backpressure и отменять provider request при
  разрыве соединения;
- до отправки headers ошибка возвращается как RFC 9457 Problem Details;
- после начала потока ошибка выражается terminal record `snapshot-failed` или
  аварийным закрытием. Ни один из этих вариантов не означает завершённый снимок.

### 3.2 Records

Каждая строка — один JSON object и `\n`. `streamVersion` всегда `"1"`.

1. `snapshot-started`: `snapshotRef`, `supplierRef`, `providerSnapshotRef`,
   `startedAt`.
2. `snapshot-batch`: `snapshotRef`, `batchNumber`, `offerCount`,
   `uncompressedBytes`, `batchHash`, `previousBatchHash`, `items`.
3. `snapshot-completed`: `snapshotRef`, `batchCount`, `productCount`,
   `variantCount`, `offerCount`, `contentHash`, `completedAt`.
4. `snapshot-failed`: `snapshotRef`, `code`, `failedAt`; provider body и
   credentials отсутствуют.

Один `snapshot-batch` содержит не более 500 offers и не более 2 097 152 байт
канонического несжатого JSON. `batchNumber` начинается с `0` и увеличивается на
один. `batchHash` — lowercase SHA-256 канонического `items`; `contentHash` —
SHA-256 конкатенации бинарных batch hashes в порядке `batchNumber`.

Каждый item содержит строго: `sourceProductKeyHash`, `sourceVariantKeyHash`,
`sourceOfferKeyHash`, `displayName`, `unit`, `supplierUnitMinor`, `currency`,
`availability`, `imageUrl`. Raw provider identifiers, cookies и session ids не
передаются. `offerRef` назначается Catalog при активации.

Gateway вычисляет source hashes только как
`HMAC-SHA256(catalogIdentityKeyV1, "hmac-sha256-v1\\0" + supplierRef + "\\0" +
entityType + "\\0" + NFC(rawProviderIdentifier))`. Record обязан содержать
`sourceIdentityScheme="hmac-sha256-v1"`. Key доступен только Gateway, не
совпадает с session/actor/cursor keys и не ротируется автоматически. Unique
scope — `(supplierRef,entityType,sourceHash)`; одинаковый hash с различными
semantic facts отклоняет snapshot как `SOURCE_IDENTITY_COLLISION`. Ротация key
требует отдельного ADR и alias migration; Catalog никогда не получает raw ID.

## 4. Staging и пакетный импорт

Миграции создают:

- `catalog.supplier_snapshots(snapshot_ref PK, supplier_ref,
  provider_snapshot_ref, state, next_batch_number, declared_*_count,
  received_*_count, content_hash, failure_code, created_at, received_at)`;
- `catalog.snapshot_batches(snapshot_ref, batch_number, offer_count,
  uncompressed_bytes, batch_hash, previous_batch_hash, received_at,
  PK(snapshot_ref,batch_number))`;
- `catalog.snapshot_products`, `catalog.snapshot_variants`,
  `catalog.snapshot_offers`, `catalog.snapshot_availability`, всегда с
  `snapshot_ref` в ключе.

Состояния импорта: `Created -> Receiving -> Received` или
`Created|Receiving -> Rejected`. Только terminal `snapshot-completed` может
перевести generation в `Received`.

Алгоритм каждого batch выполняется отдельной короткой транзакцией:

1. заблокировать строку snapshot;
2. проверить состояние и `batchNumber`;
3. повтор существующего номера с тем же hash считать idempotent no-op;
4. тот же номер с другим hash перевести в `Rejected/BATCH_HASH_CONFLICT`;
5. проверить лимиты, типы, identity hashes и уникальность;
6. загрузить строки через `COPY FROM STDIN`;
7. записать batch manifest и увеличить `next_batch_number`;
8. commit и только затем запросить следующий record.

При `snapshot-completed` importer проверяет непрерывный диапазон `0..N-1`, все
counts и `contentHash`. Несовпадение переводит generation в `Rejected`. Ошибка,
partial stream, timeout или restart никогда не меняют активное поколение.

## 5. Активация

Миграции создают owner tables `products`, `variants`, `offer_mappings`,
`availability`, `catalog_state`, `outbox_messages`. Worker выбирает только
`Received` generation с `FOR UPDATE SKIP LOCKED`.

До изменения active state worker повторно проверяет batches, hashes, counts,
уникальность, foreign keys и допустимые enum/money values. Затем в одной
PostgreSQL-транзакции:

1. сопоставляет source identity hashes со стабильными `productRef`,
   `variantRef`, `offerRef`;
2. материализует новое поколение;
3. переводит прежнее `Active` в `Superseded`;
4. переводит новое `Received` в `Active` и увеличивает decimal-string revision;
5. записывает Outbox.

В транзакции запрещены HTTP и Kafka. Crash до commit оставляет старое
поколение активным; crash после commit восстанавливается Outbox publisher.

`CatalogSnapshotActivated.v1` означает только: generation полностью проверена,
committed и уже видна Catalog API. Payload: `supplierRef`, `snapshotRef`,
`snapshotRevision`, `activatedAt`, `productCount`, `variantCount`, `offerCount`,
`batchCount`, `contentHash`. `CatalogMappingChanged.v2` содержит ровно
`productRef`, `variantRef`, `offerRef|null`, `catalogSnapshotRevision`,
`mappingRevision`, `mappingState`, `availability`, `effectiveAt`. Полные Catalog
rows в событиях запрещены.

JSON Schema требует: `mappingState=Active` только с non-null `offerRef`;
`Missing|Stopped` только с `offerRef=null`. Positive/negative fixtures покрывают
все допустимые и недопустимые сочетания.

## 6. Catalog HTTP API

### 6.1 Клиентский поиск

`GET /api/client-v1/catalog/products`

- `query`: required, trim + Unicode NFKC + lowercase, 2..200 символов;
- `availability`: optional `Available|Unavailable|Stopped`;
- `limit`: integer 1..50, default 20;
- `cursor`: opaque base64url, max 512.

Поиск читает ровно одну active revision. Keyset cursor подписан server key и
содержит `snapshotRevision`, SHA-256 нормализованных query/filter, последнее
`displayNameSortKey`, `productRef`, `variantRef`. Cursor другой revision или
другого запроса возвращает `400 INVALID_CURSOR`; offset pagination запрещена.

Response: `{snapshotRevision, items, nextCursor}`. Item содержит только
`productRef`, `variantRef`, `displayName`, `unit`, `availability`,
`mappingAvailable`, `imageUrl?`. `offerRef`, supplier price, source hashes,
provider identifiers и session data публично не возвращаются.

Если active generation отсутствует: `503 CATALOG_SNAPSHOT_INCOMPLETE`.

### 6.2 Pricing input

`GET /api/internal-v1/catalog/products/{productRef}/variants/{variantRef}/pricing-input` доступен
только audience `pricing-service`. Response содержит `productRef`, `variantRef`,
`offerRef`, `snapshotRevision`, `supplierUnitMinor`, `currency`, `unit`,
`availability`, `mappingRevision`, `displayName`. Pricing не читает Catalog DB
напрямую; `displayName` становится частью immutable quote/order snapshot.

## 7. Обязательная проверка

### 6.3. Точная active-модель

Миграции называются `001_catalog_import.sql`, `002_catalog_active.sql`,
`003_catalog_identity.sql`, `004_catalog_outbox.sql`, `005_catalog_grants.sql`.
Active-таблицы generation-
scoped и не перезаписываются «на месте»:

- `catalog.catalog_state(id boolean PK CHECK(id), active_snapshot_ref FK,
  active_snapshot_revision bigint, active_content_hash char(64), updated_at)`;
- `catalog.products(snapshot_ref, product_ref, display_name,
  display_name_sort_key, created_at, PK(snapshot_ref,product_ref))`;
- `catalog.variants(snapshot_ref, variant_ref, product_ref, unit, image_url,
  PK(snapshot_ref,variant_ref), FK(snapshot_ref,product_ref))`;
- `catalog.offer_mappings(snapshot_ref, variant_ref, offer_ref,
  mapping_revision bigint, mapping_state, supplier_unit_minor bigint CHECK
  (supplier_unit_minor>=0), currency char(3) CHECK(currency='RUB'), effective_at,
  PK(snapshot_ref,variant_ref), UNIQUE(snapshot_ref,offer_ref))`;
- `catalog.availability(snapshot_ref,variant_ref,state,checked_at,
  PK(snapshot_ref,variant_ref), FK(snapshot_ref,variant_ref))`;
- `catalog.source_identities(supplier_ref,entity_type,source_identity_scheme,
  source_identity_hash,stable_ref,semantic_fingerprint,first_seen_snapshot_ref,
  last_seen_snapshot_ref,state, PRIMARY KEY(supplier_ref,entity_type,
  source_identity_scheme,source_identity_hash), UNIQUE(entity_type,stable_ref))`;
- `catalog.outbox_messages(message_id PK,message_type,aggregate_ref,
  aggregate_version,partition_key,schema_version,payload,publish_state,
  attempts,next_attempt_at,occurred_at)`.

Все client/internal reads join через единственную строку `catalog_state`; один
response не смешивает generations. Activation блокирует state, проверяет
FK/count/hash/enums, переключает pointer и пишет Outbox в одной transaction.
`coffee_catalog_import_rw` имеет DML только на staging,
`coffee_catalog_activate_rw` — staging read + active/Outbox write,
`coffee_catalog_api_ro` — SELECT active views, migrator — DDL. Negative grant
tests обязаны получить PostgreSQL `permission denied` на любой иной путь.

Pricing-input читает `supplier_unit_minor/currency` только из offer mapping
текущей pointer-selected Active generation; staging fallback запрещён.

`semantic_fingerprint` включает только immutable identity relationships:
`entityType`, parent source identity и stable unit/category semantics. Цена,
availability, displayName, imageUrl и effectiveAt mutable и никогда не вызывают
`SOURCE_IDENTITY_COLLISION`; их изменение создаёт новую generation/revision.

Activation сопоставляет source identity с существующим `stable_ref`; новая
identity получает новый owner ref. Одинаковая identity с несовместимым semantic
fingerprint отклоняет generation. Full-snapshot diff выполняется против прежней
Active generation: отсутствующая identity переводится в `Missing`, явный
provider stop — `Stopped`, неизменённая identity/ref не публикует событие,
изменение mapping публикует `CatalogMappingChanged.v2` с прежним product/variant
и новым/нулевым offer. История identities не удаляется вместе с generation,
поэтому frozen contribution подтверждённого Order не теряется.

## 7. Обязательная проверка

- contract fixtures для всех NDJSON records и HTTP responses;
- поток из 100 000 offers не буферизуется целиком; RSS budget фиксируется в CI;
- oversized batch, gap, duplicate identity, conflicting hash/count/content hash
  завершаются точным code и не активируют generation;
- повтор того же batch/hash и повтор activation не создают дублей;
- API до activation видит только старую revision, после commit — только новую;
- forced crash до/после commit подтверждает atomicity и Outbox recovery;
- `pnpm architecture:check` запрещает cross-owner imports, чужие DB URLs,
  provider credentials в Catalog и полные Catalog rows в Kafka schemas;
- `pnpm db:smoke` подтверждает allowlist каждой роли и `permission denied` на
  чужие DB/tables;
- generated OpenAPI/JSON Schema и breaking-change checks проходят.

## 8. Не входит

Elasticsearch, Redis, S3/MinIO, CDC/Debezium, универсальная ETL-платформа,
delta sync без доказанного provider revision/tombstone contract, перенос legacy
таблиц и изменение корзины AROMA не входят в эту цепочку.
