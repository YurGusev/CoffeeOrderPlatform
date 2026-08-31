# Исполнимая спецификация PricingQuote

Статус: нормативная спецификация первого запуска. Исполнитель не выбирает
формулу, таблицы, rounding, TTL, hash, idempotency или verify semantics заново.

## 1. Граница и зависимости

`pricing-service` принадлежит bounded context `Pricing`, является единственным
writer `coffee_platform_pricing` и использует роль `coffee_pricing_rw`.

Он принимает HTTP только от `edge-gateway` и `orders-service`, а исходящий
business-вызов выполняет только к Catalog API #17:

`GET /api/internal-v1/catalog/products/{productRef}/pricing-input`.

Pricing не читает Customer, Catalog или Orders DB, не принимает цену из
браузера и не публикует Kafka в первом срезе. Customer context в первом срезе
не изменяет цену: `customerRef` сохраняется как основание и проверяется Orders,
но никаких скидок или customer-tier нет.

## 2. Политика первого запуска

В БД существует ровно одна активная policy для `RUB`. Bootstrap policy первого
запуска имеет точные значения: `markupBasisPoints=3000` (30%),
`minimumMarginMinor="0"`, `quoteTtlSeconds=900`, `quantityScale=3`,
`roundingMode=CEILING`. Они дублируются в `config/platform.yaml` и seed
migration; `pnpm config:check` требует полного совпадения. Изменение любого
значения создаёт новую `PricingPolicyVersion`, а не переписывает существующую.
Поля policy:

- `markupBasisPoints`: integer `0..100000`;
- `minimumMarginMinor`: non-negative decimal string;
- `quoteTtlSeconds`: integer `60..3600`, начальное значение `900`;
- `quantityScale`: `3`;
- `roundingMode`: `CEILING`;
- `validFrom`, optional `validTo`.

Количество на wire имеет regex `^[1-9][0-9]{0,5}(\.[0-9]{1,3})?$|^0\.(?!0{1,3}$)[0-9]{1,3}$`.
При расчёте оно преобразуется в integer `quantityMilli` без float:
`1 -> 1000`, `1.2 -> 1200`, `0.001 -> 1`. Максимум `999999.999`.

Для каждой строки Catalog возвращает `supplierUnitMinor` — цену в копейках за
одну единицу указанного `unit`. Все вычисления выполняются `bigint`:

```text
markupUnitMinor = ceil(supplierUnitMinor * (10000 + markupBasisPoints) / 10000)
unitMinor = max(markupUnitMinor, supplierUnitMinor + minimumMarginMinor)
lineTotalMinor = ceil(unitMinor * quantityMilli / 1000)
totalMinor = sum(lineTotalMinor)
```

Функция `ceil(a/b)` для неотрицательных integers равна `(a+b-1)/b`. Binary
floating point, banker's rounding и локаль-зависимое форматирование запрещены.

## 3. Миграции и таблицы

Файлы миграций:

1. `001_create_pricing_policy_versions.sql`;
2. `002_create_pricing_quotes.sql`;
3. `003_create_pricing_idempotency.sql`;
4. `004_create_pricing_audit.sql`.

### `pricing_policy_versions`

`policy_version_ref` PK (`pvr_<ULID>`), `version` bigint unique check `>0`,
`currency` check `RUB`, `markup_basis_points`, `minimum_margin_minor` bigint,
`quote_ttl_seconds`, `quantity_scale` check `=3`, `rounding_mode` check
`CEILING`, `status` check `Draft|Active|Retired`, `valid_from`, `valid_to`,
`created_at`, `created_by_actor_ref`. Partial unique index допускает одну
`Active` policy на currency. Новая policy создаётся отдельной будущей admin
задачей; #7 добавляет bootstrap policy через versioned seed migration.

### `pricing_quotes`

`quote_ref` PK (`prq_<ULID>`), `customer_ref`, `policy_version_ref` FK,
`catalog_snapshot_revision` bigint, `currency` check `RUB`, `total_minor`
bigint check `>=0`, `canonical_hash` `char(64)`, `created_at`, `expires_at`,
`actor_ref`, `correlation_id`, `request_hash char(64)`. Check:
`expires_at > created_at`. Runtime grants разрешают только INSERT/SELECT;
UPDATE/DELETE для quote tables отсутствуют.

### `pricing_quote_lines`

`quote_ref` FK, `line_number` integer `1..100`, `product_ref`, `variant_ref`,
`product_display_name`, `offer_ref`, `catalog_snapshot_revision`, `mapping_revision`, `unit`,
`quantity_milli` bigint, `supplier_unit_minor` bigint, `markup_basis_points`,
`minimum_margin_minor`, `unit_minor`, `line_total_minor`, `currency`, PK
`(quote_ref,line_number)`. Это неизменяемые основания расчёта, а не копия
Catalog tables.

### `pricing_idempotency_records`

PK `(actor_ref,idempotency_key)`, `request_hash`, `state` check
`Acquired|Completed`, `lease_until`, `quote_ref`, `response_status`,
`response_body jsonb`, `created_at`, `completed_at`. Completed response хранится
24 часа; cleanup не удаляет `pricing_quotes`.

### `pricing_audit_records`

Append-only: `audit_ref`, `action` (`QuoteCreated|QuoteVerified|QuoteRejected`),
`quote_ref`, `actor_ref`, `correlation_id`, `reason_code`, `created_at`.
Customer contact data, Authorization, secrets и raw HTTP bodies запрещены.

## 4. Создание котировки

`POST /api/client-v1/pricing/quotes`

Headers: `Authorization`, `Idempotency-Key` UUID, optional
`X-Correlation-ID`, `traceparent`. Trusted `actorRef` формирует edge; request
body не содержит actor или денежных значений.

Request:

```json
{
  "customerRef": "cus_<ULID>",
  "lines": [
    {"productRef": "prd_<ULID>", "variantRef": "var_<ULID>", "quantity": "2.500"}
  ]
}
```

`lines`: 1..100; пара `(productRef,variantRef)` уникальна. Порядок строк
значим и сохраняется. Для каждой строки Pricing вызывает Catalog pricing-input
с concurrency не более 8 и deadline 2s на вызов/5s на весь request. Network
calls выполняются до транзакции создания quote.

Catalog input принимается только если refs совпали, `availability=Available`,
mapping существует, currency `RUB`, decimal strings/refs валидны. Все строки
одного quote должны иметь одну `snapshotRevision`; иначе один bounded повтор
всего Catalog read, затем `409 CATALOG_REVISION_CHANGED`.

Idempotency algorithm:

1. нормализовать quantity в canonical decimal без trailing zeros и вычислить
   request SHA-256;
2. атомарно acquire `(actorRef,Idempotency-Key)` на 30 секунд;
3. другой request hash -> `409 IDEMPOTENCY_CONFLICT`;
4. completed -> вернуть сохранённый status/body byte-equivalent;
5. активная lease -> `409 IDEMPOTENCY_REQUEST_IN_PROGRESS`;
6. истёкшая lease с тем же hash может быть захвачена повторно;
7. после Catalog reads в одной транзакции вставить quote/lines/audit и обновить
   idempotency record в `Completed`.

Response `201 PricingQuoteResponse`: `quoteRef`, `policyVersionRef`,
`catalogSnapshotRevision`, `customerRef`, `createdAt`, `expiresAt`, `currency`,
`lines`, `totalMinor`, `hash`. Line: `lineNumber`, `productRef`, `variantRef`,
`quantity`, `unit`, `unitMinor`, `lineTotalMinor`. Supplier cost, offerRef и
policy internals публично не возвращаются.

## 5. Canonical hash

Hash — lowercase SHA-256 UTF-8 bytes канонического JSON object без поля `hash`.
Используется встроенный `node:crypto`; новая dependency не нужна.

Объект строится с ключами строго в таком порядке:

`quoteRef,policyVersionRef,catalogSnapshotRevision,customerRef,createdAt,expiresAt,currency,lines,totalMinor`.

Ключи строки строго:

`lineNumber,productRef,variantRef,productDisplayName,quantity,unit,unitMinor,lineTotalMinor`.

Строки идут по `lineNumber`; timestamps — RFC 3339 UTC с миллисекундами;
quantity canonical (`2.500 -> 2.5`); money/version — canonical decimal без
leading zeros. JSON сериализуется compact, UTF-8, без whitespace/BOM. Hash
пересчитывается из сохранённых DB facts, а не из response object клиента.

## 6. Проверка для Orders

`POST /api/internal-v1/pricing/quotes:verify`, audience только
`orders-service`, deadline 1s, без `Idempotency-Key` и без side effects кроме
append-only audit.

Request содержит `quoteRef`, `hash`, `customerRef` и `lines[]` с
`productRef`, `variantRef`, canonical `quantity`. Pricing загружает quote и
lines, пересчитывает hash, проверяет exact expected facts и `expiresAt > now()`.

`200 PricingQuoteVerificationResponse`:
`valid:true`, `quoteRef`, `policyVersionRef`, `catalogSnapshotRevision`,
`customerRef`, `expiresAt`, `currency`, authoritative lines, включая
`productDisplayName`, `offerRef` и mapping revision для Orders, и `totalMinor`.

Ошибки: `404 PRICING_QUOTE_NOT_FOUND`, `409 PRICING_QUOTE_HASH_MISMATCH`,
`409 PRICING_QUOTE_EXPIRED`, `409 PRICING_QUOTE_SCOPE_MISMATCH`,
`503 PRICING_POLICY_UNAVAILABLE`, а также общие auth/validation codes. Ошибка не
возвращает сохранённый hash или правильные ожидаемые значения.

## 7. Проверки

- property/table tests формулы на boundary values и bigint overflow guards;
- одна policy race: partial unique index не допускает две Active policies;
- PostgreSQL integration: quote/lines/audit/idempotency commit атомарны;
- UPDATE/DELETE immutable quote role получает `permission denied`;
- одинаковые DB facts дают одинаковый hash после restart/на другой locale;
- изменение каждого hash-поля меняет hash;
- idempotency: replay, conflict, in-progress, expired lease и crash recovery;
- Catalog unavailable/timeout/mixed revision не создаёт quote;
- verify: valid, unknown, altered hash, expired и scope mismatch;
- OpenAPI positive/negative fixtures и breaking-change gate;
- architecture checker запрещает Customer/Catalog/Orders imports и DB URLs;
- redaction canary отсутствует в logs/traces/errors/audit.

## 8. Не входит

Discounts, loyalty/customer tiers, promotions DSL, taxes, delivery calculation,
multi-currency, payments, invoices, dynamic repricing confirmed Orders, Kafka,
admin UI policy editor и перенос legacy pricing не входят в #7.
