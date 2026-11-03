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
`sourceIdentityScheme`; optional `categoryName`, `supplierPromotions` и `grindOptions` передаются
только в typed contract. Raw provider identifiers, cookies и session ids не
передаются. `offerRef` назначается Catalog при активации.

`categoryName` — непустое название категории поставщика (1..200 символов) из
`data[].category.name`. Название, SKU и помол не используются для классификации.
Если категория или её название отсутствует либо равно `null`, поле не передаётся;
значение «Другие» не подставляется. Это display fact товара, не новая таксономия
и не часть identity hash. Разные категории одного source product внутри снимка
считаются semantic collision.

Catalog хранит название в nullable `snapshot_products.category_name` и
`products.category_name`; forward migrations `0010_catalog_category` и
`0011_active_catalog_category` разделяют staging и active schema. При durable
reconstruction SQL `NULL` восстанавливается как отсутствие `categoryName`, а не
JSON `null`: canonical bytes, batch/content hashes прежних снимков не меняются.
Активация сохраняет значение, включая перенос отсутствующих в новом снимке товаров;
`active_products` и публичный поиск показывают факт из того же поколения.

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
При повторном использовании source identity запрос binding использует её
`first_seen_snapshot_ref`, а не текущий snapshot: параллельные поколения не
меняют immutable `firstSnapshotRef` в зависимости от порядка HTTP-вызовов.

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

### Закрытая классификация отказов (#6)

`failure_code` — внутренний закрытый allowlist, а не текст исключения и не
произвольный provider/SQL code. Он не расширяет публичный HTTP/OpenAPI контракт.
`CatalogImportError` и `CatalogStreamError` несут стабильный `code`; importer
принимает только перечисленные ниже причины. `Error.message`, SQL, provider body,
credentials и неизвестные `error.code` никогда не становятся durable причиной.

| Наблюдаемый отказ | Durable `failure_code` |
|---|---|
HTTP/non-200, отсутствующий body, неверный content type до started | `CATALOG_EXPORT_HTTP_*`, `CATALOG_EXPORT_INVALID_CONTENT_TYPE` → `HTTP_BEFORE_STARTED` |
| Неверная generated record schema; неканоническая либо отрицательная цена offer | `INVALID_STREAM_SCHEMA` |
| Неверный snapshot/supplier, повторный `started`, batch/completed до `started`, любая запись после terminal | `INVALID_STREAM_SEQUENCE` |
| EOF без terminal | `INVALID_STREAM_MISSING_TERMINAL` |
| Framing: лимит строки, пустая строка, UTF-8, JSON, неполная последняя строка | `CATALOG_STREAM_LINE_TOO_LARGE`, `CATALOG_STREAM_EMPTY_LINE`, `CATALOG_STREAM_INVALID_UTF8`, `CATALOG_STREAM_INVALID_JSON`, `CATALOG_STREAM_INCOMPLETE` |
| Неизвестный не-DB отказ без доверенного bounded code | `INVALID_STREAM` |
| Число offers, лимит offers/batch/item, несовпадение canonical bytes | `BATCH_OFFER_COUNT_MISMATCH`, `BATCH_OFFER_LIMIT`, `BATCH_BYTE_LIMIT`, `ITEM_BYTE_LIMIT`, `BATCH_BYTE_COUNT_MISMATCH` |
| Пропуск номера batch | `BATCH_SEQUENCE_CONFLICT` |
| Несовпадение `previousBatchHash` нового batch | `BATCH_CHAIN_CONFLICT` |
| Неверный payload hash или конфликтующий replay (`BATCH_REPLAY_CONFLICT` внутри store) | `BATCH_HASH_CONFLICT` |
| Identity collision, включая повтор offer и несовместимые product/variant/grind facts | `SOURCE_IDENTITY_COLLISION` |
| Повреждённая durable реконструкция или ordinals | `BATCH_DURABLE_HASH_MISMATCH`, `BATCH_DURABLE_ORDINAL_MISMATCH` |
| Terminal count, chain или content hash | `TERMINAL_COUNT_MISMATCH`, `TERMINAL_CHAIN_MISMATCH`, `TERMINAL_CONTENT_HASH_MISMATCH` |
| Валидный provider terminal (допустим и до `started`) | Точный contract code: `PROVIDER_UNAVAILABLE`, `PROVIDER_TIMEOUT`, `INVALID_STREAM`, `BATCH_HASH_CONFLICT`, `SOURCE_IDENTITY_COLLISION` |
| Deadline в потоке при известном результате DB / последующее owner recovery | `IMPORT_DEADLINE_EXCEEDED` / `RECOVERY_INCOMPLETE` |
| Известная SQL-ошибка с подтверждённым `RolledBack` и успешным guard reread незавершённого собственного snapshot | `IMPORT_DB_ROLLED_BACK` |

Отрицательная цена запрещена именно Catalog ingestion policy: общий scalar schema
сам по себе не заменяет проверку non-negative canonical decimal string.
`Received` и `Rejected` неизменяемы: точный terminal replay возвращает no-op,
конфликт не заменяет state/reason. Exact batch replay проверяется также после
продвижения следующих batches и в `Received`; `Rejected` batch replay не разрешает.
Решение о terminal принимается только после чистого EOF: provider terminal с
последующей записью не считается принятым provider отказом.

Не все `DB_*` означают неопределённость. Store переводит только
`DB_QUERY_FAILED` при фактически наблюдаемом состоянии transaction `RolledBack`
в `IMPORT_DB_ROLLED_BACK`; importer затем перечитывает generation, сверяет
supplier и `Created|Receiving`, а `reject` повторно проверяет state под lock.
Connection loss, unknown COMMIT/ROLLBACK, отменённый COPY и недоступный reread
не дают права записывать ложный `Rejected`. Неизвестный исход остаётся
`OutcomeUnknown` либо исходной отменой; operation-specific reconciliation и
следующий recovery работают по durable фактам. Ошибка reread не заменяется
успешной классификацией. Никакого разбора текста SQL-ошибки для этого нет.

### Проверяемые границы хранения и imports (#6)

Importer имеет `SELECT/INSERT/UPDATE` только на `supplier_snapshots` и
`SELECT/INSERT` на остальных пяти staging/manifest таблицах. `UPDATE` для этих
пяти таблиц, `DELETE`, постоянный DDL в `catalog`/`public` не разрешены.
`TEMP` нужен transaction-local COPY; foreign database `CONNECT` запрещён.
`config/database-role-map.json` повторяет минимальные grants миграций, не
расширяет их до общего RW. Миграции 0001–0003 не переписываются.

`test:catalog-copy` использует настоящий disposable PostgreSQL и production
`createCatalogImportStore`/`defineCopy`: отмена через `AbortSignal` и ошибка
источника происходят после первого потреблённого COPY chunk. Сравниваются
полные pre/post rows всех шести таблиц, включая manifest, counters и state;
проверяются уничтожение источника, доступность pool, отсутствие active COPY /
idle-in-transaction и ограниченное завершение. Test-only observer подтверждает
все четыре merge; отзыв `INSERT` на manifest даёт наблюдённый на настоящем driver
SQLSTATE `42501`. Rollback удаляет весь новый batch, не меняя предыдущие факты.
Grant и test-local подмены восстанавливаются в `finally`; production fault hooks
отсутствуют.

Тот же harness применяет сначала 0001, сохраняет четыре состояния, затем
применяет 0002–0003 без изменения существующих rows. Повторный запуск — no-op;
изменённый SQL с **пересчитанным** checksum отклоняется против ledger как
`MIGRATION_CHECKSUM_DRIFT`, ledger остаётся неизменным. ACL/TEMP и запрещённые
операции проверяются настоящим login `coffee_catalog_import_rw` с `42501`.
Foreign CONNECT proof использует существующий live foundation/bootstrap route:
реальный login importer пробует четыре foreign databases и наблюдает `42501`.
Вывод `pnpm db:smoke` без `--execute` — только structural plan, не CONNECT proof.

Связанная проверка остановки в `test:catalog-copy` пропускает валидные записи
через `InternalCatalogClient` и настоящее тело HTTP-ответа в `runCatalogImport`.
После начала PostgreSQL COPY и занятия им одного соединения проверка
останавливает ресурс БД и отменяет сигнал импорта: читатель HTTP и источник COPY
уничтожаются, COPY завершается `DB_INTERRUPTED`, все шесть таблиц совпадают с
состоянием **перед пакетом**, соединение освобождается, активных COPY и
незавершённых транзакций нет, остановка укладывается в штатные 40 секунд.
Источник HTTP — локальный тестовый сервер, не развёрнутый `api-internal` и не
реальный провайдер; проверка не доказывает сетевую доступность production или
доставку телеметрии.

`tests/architecture/checks.test.mjs` прогоняет пять запрещённых imports из
`catalog-supplier-sync` в `catalog-activation-worker`, `api-internal`,
`orders-service`, `pricing-service`, `customer-service`, проверяя точные
`BOUND-IMPORT`, source и target. Контрольные imports versioned contracts и
разрешённых platform packages проходят существующий checker. Общие business
packages, imports реализаций соседних apps и Effect запрещены; authority —
ADR-0025, native async/AbortSignal. Public HTTP, activation/outbox и active
Catalog generation находятся за границей этих staging-проверок.

### Восстановление, готовность и ограниченная наблюдаемость (#6)

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
уникальность, foreign keys и допустимые enum/money values. Подготовка durable
source identities и `offer_binding_acks` отделена от commit: Gateway binding
выполняется только через типизированный `api-internal` mTLS client без provider
HTTP. Ответ сверяется с исходным `offerRef`, source hash и `firstSnapshotRef`;
неизвестный ответ или deadline не активирует поколение. После restart worker
повторно читает ack, а не предполагает успех внешнего вызова. Устаревшее
`Received` поколение, завершившее подготовку после более нового Active,
переходит в `Superseded` без повторного переключения pointer. Затем в одной
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

- `query`: optional; при наличии trim + Unicode NFKC + lowercase, 2..200 символов;
- `availability`: optional `Available|Unavailable|Stopped`;
- `limit`: integer 1..50, default 20;
- `cursor`: opaque base64url, max 512.

Без `query` возвращается страница активного каталога по
[ADR-0043](../adr/ADR-0043-catalog-browse-without-query.md). Явно переданный пустой
или пробельный `query` остаётся ошибкой; permission, лимиты и правила cursor
сохраняются.

Поиск читает ровно одну active revision. Keyset cursor подписан server key и
содержит `snapshotRevision`, SHA-256 нормализованных query/filter, последние
`productRef` и `variantRef`, а также SHA-256 последнего `displayNameSortKey`.
Так размер cursor остаётся ≤512 даже при имени длиной 200 Unicode-символов.
Catalog восстанавливает полный sort key по refs из той же active revision и
сверяет digest **в одном SQL statement** с чтением страницы. Отсутствующая
позиция, несовпадающий digest, другая revision или другой query/filter
возвращают `400 INVALID_CURSOR`; offset pagination запрещена.

Response: `{snapshotRevision, items, nextCursor}`. Item содержит только
`productRef`, `variantRef`, `displayName`, `unit`, `availability`,
`mappingAvailable`, `imageUrl?`, `categoryName?`, `prices?`. `offerRef`, source hashes,
provider identifiers и session data публично не возвращаются.

По решению владельца #262 каталог показывает обе цены за `unit`:
`prices: {supplierUnitMinor, saleUnitMinor, currency}` — decimal minor units,
`RUB`. API-public дополняет страницу одним readonly Pricing preview только для
`Available && mappingAvailable`; остальные строки не содержат `prices`.
Отсутствующая цена не равна нулю. `policyVersionRef` передаётся один раз на странице.
Catalog хранит supplier facts, а цену продажи вычисляет только Pricing из одной
активной policy. API root проверяет точные revision, refs, unit и полноту preview,
не вычисляет деньги и не принимает monetary facts из браузера. Ошибочный или
недоступный preview возвращает существующий `503 CATALOG_UNAVAILABLE` без частичных
цен. Catalog GET сохраняет общий deadline 1000 ms: оба owner вызова используют
один AbortSignal; начало preview не запускает новый секундный бюджет.

Если active generation отсутствует: `503 CATALOG_SNAPSHOT_INCOMPLETE`.
Если недоступны owner/БД или ответ owner не соответствует контракту:
`503 CATALOG_UNAVAILABLE`; этот отказ не означает отсутствия complete snapshot.

Исполнение #17: `api-public` проверяет actor и делегирует
`searchCatalogProducts` только `catalog-service`; owner выполняет
параметризованное чтение active views под `coffee_catalog_api_ro` без staging
fallback. Подпись cursor проверяется в Catalog, не в API-root. Разрешение
позиции cursor, чтение поисковой страницы и active metadata выполняются одним
SQL statement для исключения смешения ревизий при конкурентной активации.

### 6.2 Pricing input

`GET /api/internal-v1/catalog/products/{productRef}/variants/{variantRef}/pricing-input` доступен
audience `pricing-service` и `aroma-convergence`. Response содержит `productRef`, `variantRef`,
`offerRef`, `snapshotRevision`, `supplierUnitMinor`, `currency`, `unit`,
`availability`, `mappingRevision`, `displayName`. Pricing не читает Catalog DB
напрямую; `displayName` становится частью immutable quote/order snapshot.

`api-internal` проверяет scoped mTLS identity: Pricing дополнительно передаёт
signed delegation, а convergence не принимает входящую delegation. InternalApi
подписывает downstream original caller и делегирует `getCatalogPricingInput`
владельцу; browser audience и чужой caller отклоняются
до доступа к owner store. Этот endpoint не имеет Kafka producer или DML-пути.

Для `originalCaller=aroma-convergence` Catalog требует freshness активного
snapshot по DB clock. Миграция `0009_active_snapshot_freshness.sql` дополняет
owner read view временем начала импорта из `supplier_snapshots.created_at`:
импорт создаётся до provider export, поздняя активация не омолаживает proof.
Порог — `services.catalog-service.catalogSnapshotProof.maxAgeMs`; отсутствующий
порог, snapshot, будущая дата или превышение возраста дают
`503 CATALOG_UNAVAILABLE`. Timestamp не добавляется в HTTP response. Pricing
сохраняет прежнюю семантику. Владелец утвердил 4 октября 2026 года порог
`7 200 000 ms` (2 часа): импорт запускается ежечасно, а окно активации — до
15 минут. Возраст считают от `supplier_snapshots.created_at`, то есть от начала
импорта; поздняя активация не обновляет timestamp и не продлевает свежесть.
Если порог отсутствует в platform config, Catalog сохраняет fail-closed поведение
и возвращает convergence `503 CATALOG_UNAVAILABLE`; скрытого значения по умолчанию нет.

### 6.3. Точная active-модель

Единый Catalog migration root последовательно применяет
`0001_supplier_snapshots.sql`–`0003_snapshot_staging.sql` (#6), затем
`0004_catalog_active.sql`–`0008_catalog_active_read.sql` (#16). `0008`
дополняет активные variants и read-модель без изменения checksum уже
опубликованной `0004`; существующий ledger `0001`–`0007` обновляется вперёд.
После `0009_active_snapshot_freshness.sql` применяются category migrations
`0010_catalog_category.sql` и `0011_active_catalog_category.sql`; существующие
товары получают `NULL` без изменения прежних canonical snapshots.
Active-таблицы generation-
scoped и не перезаписываются «на месте»:

- `catalog.catalog_state(id boolean PK CHECK(id), active_snapshot_ref FK,
  active_snapshot_revision bigint, active_content_hash char(64), updated_at)`;
- `catalog.products(snapshot_ref, product_ref, display_name,
  display_name_sort_key, created_at, PK(snapshot_ref,product_ref))`;
- `catalog.variants(snapshot_ref, variant_ref, product_ref, unit, image_url,
  grind_options jsonb (NULL для отсутствующего поля, [] для пустого набора),
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
- `catalog.offer_binding_acks(snapshot_ref,source_offer_key_hash,offer_ref,
  state,first_snapshot_ref,acked_at, PK(snapshot_ref,source_offer_key_hash))`;
- `catalog.outbox_messages` с полным SQL-контрактом
  `packages/platform-outbox/src/index.ts`: `message_id`,
  `aggregate_ref`/`aggregate_sequence`, `envelope`/`payload`/`payload_hash`,
  `state`, lease/fence token и publisher attempts. Owner business state и Outbox
  фиксируются в одной транзакции.

`active_snapshot_metadata` возвращает pointer и decimal-string revision одной
строкой даже без активного поколения или товаров. API-role не читает напрямую
`catalog_state`; #17 выполняет чтения metadata и active rows в одном согласованном
снимке PostgreSQL, чтобы один response не смешивал generations. Activation блокирует state, проверяет
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
- входящий NDJSON-поток из 100 000 offers (#6 ingestion) не буферизуется целиком;
  RSS budget фиксируется в CI; это не утверждение о bounded-memory активации #16;
- oversized batch, gap, duplicate identity, conflicting hash/count/content hash
  завершаются точным code и не активируют generation;
- повтор того же batch/hash и повтор activation не создают дублей;
- API до activation видит только старую revision, после commit — только новую;
- forced crash до/после commit подтверждает atomicity и Outbox recovery;
- `pnpm architecture:check` запрещает cross-owner imports, чужие DB URLs,
  provider credentials в Catalog и полные Catalog rows в Kafka schemas;
- `pnpm db:smoke` подтверждает структурный allowlist; живые `permission denied`
  и owner-транзакции проверяются отдельно в disposable `pnpm db:live-proof`;
- generated OpenAPI/JSON Schema и breaking-change checks проходят.

Проверка #18 (`tests/catalog-pipeline/**`) разделяет независимые доказательства:
100 000 различных offers проходят 200 NDJSON batches по 500 через production
reader/importer с ограниченным fixture store; при остановленном persistence
upstream останавливается после не более двух batches, а child с 96 MiB V8 heap
измеряет RSS. Для этой новой fixture budget прироста RSS — 128 MiB; прежний
96 MiB budget для иного большого stream fixture не меняется. Это **не**
100 000 записей в PostgreSQL и не proof памяти во время SQL activation.
Отдельные live-тесты проверяют staging/activation/API и restart на disposable
PostgreSQL. Точные размеры, длительности и ограничения — в
`evidence/catalog-pipeline/README.md`; production Gateway, постоянная БД,
Kafka broker и Collector/trace backend не объявляются проверенными.

## 8. Не входит

Elasticsearch, Redis, S3/MinIO, CDC/Debezium, универсальная ETL-платформа,
delta sync без доказанного provider revision/tombstone contract, перенос legacy
таблиц и изменение корзины AROMA не входят в эту цепочку.
