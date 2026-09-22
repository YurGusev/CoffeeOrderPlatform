# Исполнимая спецификация Catalog

Статус: нормативная спецификация первого запуска. Исполнитель не выбирает
транспорт, состояния, лимиты, владельцев или семантику событий заново.

## 1. Единая цепочка

```text
AROMA provider
  -> aroma-gateway: private HTTP NDJSON stream (providerSnapshotRef=`aroma-gateway:catalog-export:${snapshotRef}`)
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

Provider credentials are the `aroma.email` and `aroma.password` secret leaves,
used with the canonical account scope `aroma-primary` and supplier
`sup_00000000000000000000000001`; Catalog never receives those credentials.


## 3. Поток Gateway -> Catalog

### 3.1 Route

`POST /api/internal-v1/aroma/catalog-exports`

- audience: только service identity `catalog-supplier-sync`;
- request: `{ "snapshotRef": "snp_<ULID>", "supplierRef": "sup_<ULID>" }`; the
  Gateway accepts only its canonical AROMA supplier `sup_00000000000000000000000001`.
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
   `startedAt`. Gateway provenance is exactly
   `aroma-gateway:catalog-export:<snapshotRef>`; it is a traversal reference, not
   a content hash.
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

Каждый item содержит обязательные `sourceProductKeyHash`,
`sourceVariantKeyHash`, `sourceOfferKeyHash`, `displayName`, `unit`,
`supplierUnitMinor`, `currency`, `availability`, `imageUrl` и
`sourceIdentityScheme`; optional `supplierPromotions` и `grindOptions` передаются
только в typed contract. Raw provider identifiers, cookies и session ids не
передаются. `offerRef` назначается Catalog при активации.

Gateway вычисляет каждый source hash только как HMAC-SHA256 с dedicated key
`aroma.catalogIdentityKeyV1`. Точное byte framing сообщения `M`:
`UTF-8("hmac-sha256-v1") || 0x00 || UTF-8(supplierRef) || 0x00 ||
UTF-8(entityType) || 0x00 || UTF-8(NFC(rawProviderIdentifier))`.
`0x00` — один literal NUL byte, а не два текстовых символа `\` и `0`.
`entityType` проходит строгий guard и принимает только `product`, `variant`,
`offer` или `grind`; `supplierRef` — canonical `sup_<ULID>`. Raw provider identifier не
trim/lowercase-ится: принимается только непустая well-formed UTF-16 строка без
NUL, затем применяется только NFC. Результат — ровно 64 lowercase hex символа.
Ключ передаётся helper отдельным typed input, не логируется, не совпадает с
session/actor/cursor keys и не ротируется автоматически. Helper создаёт только
identity proof: Catalog activation назначает owner refs, а `variantRef`/variant
ID никогда не генерируется Gateway. Gateway не пишет в Catalog DB и не передаёт
Catalog raw ID.

Record обязан содержать `sourceIdentityScheme="hmac-sha256-v1"`. Unique scope —
`(supplierRef,entityType,sourceHash)`; одинаковый hash с различными semantic facts
отклоняет snapshot как `SOURCE_IDENTITY_COLLISION`. Ротация key требует отдельного
ADR и alias migration.
Where the provider does not prove an independent variant, Gateway treats the
provider offer identifier only as the Platform source variant key for hashing;
it is not a provider-independent variant alias. Absent or unknown packing/grind
facts remain absent/unknown and are not defaulted to a known value.

### 3.3 Immutable binding перед активацией

`catalog-activation-worker` в durable preparation transaction назначает или
переиспользует `offerRef` и сохраняет задание регистрации binding. После commit
он отправляет `POST /api/internal-v1/aroma/offer-bindings` до активации поколения. Gateway
принимает binding только для `Completed` snapshot и точного
`supplierRef/sourceIdentityScheme/sourceOfferKeyHash`; ответ `Bound` и
`firstSnapshotRef` сохраняются durable. HTTP выполняется вне Catalog
transaction, а активация разрешена только после durable ack для каждого
required binding. Потерянный ответ повторяет тот же request и возвращает
immutable row.

Binding сохраняет identity proof и не означает mutation-ready. Dispatch требует
configured supplier, подтверждённую variant/packing/grind policy и свежий exact
unique cart line; до этого cart dispatch остаётся fail-closed.

### 3.4 Выбор помола оператором

Решение владельца от 18 сентября 2026: использовать все варианты справочника
помолов AROMA; оператор выбирает вариант при заказе. Gateway передаёт
`grindOptions` с `sourceGrindKeyHash` и `displayName`, не raw provider IDs.
Catalog сохраняет эти варианты вместе со снимком и отдаёт их Orders/UI в #6;
Orders фиксирует выбор в строке заказа и передаёт соответствующий hash в #11.
Это отдельная ось выбора, а не двенадцать синтетических `offerRef` одного товара.
Binding base offer остаётся неизменяемым. Отсутствие выбранного помола не
подменяется произвольным значением из справочника.

Gateway отправляет упаковку из `config.aroma.defaultPacking` (`Aroma`, решение
владельца «как в старой системе»). Это политика новых команд, а не доказательство,
что наблюдаемое provider `packing=null` означает `Aroma`. Такие строки нельзя
молча объединять. Physical cart key включает base offer, упаковку и выбранный
помол; один offer с разными помолами — разные строки.

`imageUrl=null` означает отсутствие изображения у поставщика. Catalog сохраняет
этот факт, UI использует собственный placeholder. Отсутствие фото не исключает
товар из полного снимка и не меняет его цену или доступность.

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

Состояния импорта: `Created -> Receiving -> Received|Rejected` или
`Created -> Rejected`. `Created` фиксируется до HTTP с
`provider_snapshot_ref=NULL`; provenance сохраняется только из прошедшего generated
schema `snapshot-started`. `Received` и `Rejected` terminal, а conflicting replay
не меняет terminal state.

Каждый новый batch выполняется одной короткой транзакцией:

1. до expected-number rule прочитать manifest этого `batchNumber`; exact replay
   сверить с durable reconstruction и вернуть idempotent no-op, conflict — fail closed;
2. заблокировать generation и проверить `Receiving`, `next_batch_number` и
   `previousBatchHash`;
3. проверить generated schema, raw byte limits, `offerCount` и общий canonical hash;
4. создать transaction-local `pg_temp.catalog_import_batch ON COMMIT DROP` и
   выполнить один bounded `COPY FROM STDIN` с backpressure;
5. set-based проверить references, duplicates и semantic identity collisions;
6. merge entity rows и сохранить `batch_number,item_index` исходного offer;
7. перечитать persistent rows, восстановить wire items по `item_index` и повторно
   проверить bytes/hash;
8. вставить manifest, пересчитать durable counters и commit; следующий stream
   record запрашивается только после известного результата.

SQL `NULL` отличает отсутствующие optional properties от JSONB `[]`;
`imageUrl:null` восстанавливается как обязательное поле. Money остаётся canonical
non-negative decimal string без float/×100. Grind options хранятся JSONB-фактом и
не размножают offer rows.

При `snapshot-completed` importer сначала требует чистый EOF и только затем
bounded-проходом по одному batch проверяет непрерывные durable ordinals, hash
chain, persistent reconstruction, identities, повторно вычисленные counts и
`contentHash`. Короткая locked transition в `Received` выполняется после этих
проверок; единый 15-минутный deadline ограничивает весь traversal, включая
create, HTTP, COPY, verification и terminal transition. Exact terminal replay —
no-op. Потеря ответа `COMMIT` для create, started, batch, Received и reject
разрешается operation-specific durable reread; недоступная БД оставляет
`OutcomeUnknown`, без blind retry и ложного terminal claim.
Partial stream/restart переводит только незавершённую generation в `Rejected`, а
новый traversal получает новый `snapshotRef`; активное поколение #16 не изменяется.

### Recovery, readiness и bounded observability (#6)

Перед **каждым** новым export scheduler выполняет owner-local recovery. Ошибка
recovery (включая недоступную БД после `OutcomeUnknown`) запрещает начало нового
export; очередной tick повторяет recovery, а не неизвестную provider operation.
Readiness остаётся false до завершения startup recovery и при завершении
supervisor loop; обычный отказ импорта/провайдера не означает смерть supervisor.

Importer использует существующие OTel/runtime metrics и structured logger, как
Gateway: spans `catalog.import.generation`, `.validation`, `.copy`, `.transaction`;
bounded counters batches/bytes, duration sum/count, import age и фиксированный
outcome enum. Batch counters отражают успешно reconciled stream batches, включая
exact replay, а не уникальные durable rows. Age — время с последнего успешного
импорта (до первого успеха — с запуска telemetry); `has_success` различает эти
состояния. Диагностика не содержит raw IDs, payload, SQL, error strings или secrets.

NDJSON framing проверяет бюджет до накопления фрагмента: целые строки читаются
через view, фрагментированные — через один reusable bounded buffer без повторного
копирования префикса. `test:catalog-stream` проверяет остановку upstream demand
при delayed persistence и большой фрагментированный поток в bounded-heap процессе.
`test:catalog-recovery` дополнительно убивает реальный процесс после durable batch,
запускает новый PID и проверяет recovery-before-export через production composition
с локальными bootstrap/DNS и mTLS InternalApi fixture. Это не deployment/provider
load proof. Точные наблюдения и ограничения: `evidence/issue-6-review-remediation.md`.

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
