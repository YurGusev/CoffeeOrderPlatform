# Исполнимая спецификация PricingQuote

Статус: нормативная спецификация первого запуска. Исполнитель не выбирает
формулу, таблицы, rounding, TTL, hash, idempotency или verify semantics заново.

## 1. Граница и зависимости

`pricing-service` принадлежит bounded context `Pricing`, является единственным
writer `coffee_platform_pricing` и использует роль `coffee_pricing_rw`.

Client quote приходит `edge-gateway -> api-public -> pricing-service`; verify —
`orders-service -> api-internal -> pricing-service`. Исходящий business-вызов
идёт `pricing-service -> api-internal -> catalog-service` к API #17:

`GET /api/internal-v1/catalog/products/{productRef}/variants/{variantRef}/pricing-input`.

Pricing не читает Customer, Catalog или Orders DB, не принимает цену из
браузера и не публикует Kafka в первом срезе. Customer context в первом срезе
не изменяет цену: `customerRef` сохраняется как основание и проверяется Orders,
но никаких скидок или customer-tier нет.

Исполнимая композиция — `apps/pricing-service/src/main.ts`: общий Node/Fastify
runtime регистрирует owner routes из `http/index.ts`, scoped PostgreSQL pool и
типизированный HTTPS client с mTLS и подписанной service delegation до
`api-internal`. Входящие public actor context и internal service delegation
проверяются до вызова application; бизнес-расчёт и сохранение не исполняются в
API roots. Readiness зависит от owner DB, настроенного Catalog HTTPS client и доступности
активной версии policy с поддерживаемой формулой;
недоступность Catalog остаётся отказом отдельного quote request, а не
переключением на устаревшие supplier facts.

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

1. `0001_create_pricing_policy_versions.sql`;
2. `0002_create_pricing_quotes.sql`;
3. `0003_create_pricing_idempotency.sql`;
4. `0004_create_pricing_audit.sql`.

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
bigint check `>=0`, `canonical_hash` `char(64)`, `internal_proof_hash`
`char(64)`, `created_at`, `expires_at`,
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

PK `(actor_ref,scope,idempotency_key)`, где scope — 64-символьный command scope
по `26_BROWSER_COMMAND_RECOVERY.md`; `request_hash`, `state` check
`Acquired|Completed`, `lease_until`, `resource_ref` (ссылка на `quote_ref`), `response_status`,
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

Операция `createPricingQuote` требует `x-permission: pricing:create` в OpenAPI,
Edge inventory и проверках api-public/Pricing, включая replay-only. Это часть
[утверждённой browser-карты #8](17_ORDERS_IMPLEMENTATION_SPEC.md#права-browser-операций).

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
Ответ Catalog читается потоком с лимитом 64 KiB; превышение закрывает body и
возвращает безопасный `CATALOG_UNAVAILABLE` без расчёта или записи quote.

Алгоритм Idempotency:

1. Нормализовать quantity в canonical decimal без trailing zeros и вычислить
   request hash; read-only precheck
   Completed возвращает replay до Catalog reads, а mismatch hash — Conflict.
   Все Catalog reads для нового intent выполняются до owner transaction и не
   входят в read-only recovery branch. Precheck не заменяет atomic acquire.
2. В одной owner transaction выполнить acquire `(actorRef,scope,key)` через #62:
   другой hash → Conflict, Completed → сохранённый response, Acquired (включая
   expired lease) → InProgress без automatic takeover.
3. Для нового intent вставить quote/lines/audit и Completed response атомарно;
   сохранить quoteRef как resourceRef. Unknown commit проверяется owner recovery,
   а не новым запуском quote effect. Unresolved Acquired не удаляется по возрасту.

`application/create-pricing-quote.ts` нормализует запрос и завершает bounded
Catalog calls до owner transaction. Чистые `domain/pricing-formula.ts` и
`domain/quote-proof.ts` вычисляют bigint-суммы и canonical hashes;
`infrastructure/database/pricing-store.ts` использует scoped `Database`,
`defineStatement` и `withTransaction` платформенного pg adapter, а не raw `pg`
в application. Runtime role не может обновить или удалить immutable quotes.

Bodyless `Idempotency-Replay-Only: true` использует только owner lookup по
[browser recovery](26_BROWSER_COMMAND_RECOVERY.md), без Catalog read, acquire
или новой quote. Истёкший quote replay остаётся фактом старого результата;
новая quote требует отдельного явного intent. Обычный POST без body невалиден.

Response `201 PricingQuoteResponse`: `quoteRef`, `policyVersionRef`,
`catalogSnapshotRevision`, `customerRef`, `createdAt`, `expiresAt`, `currency`,
`lines`, `totalMinor`, `hash`. Line: `lineNumber`, `productRef`, `variantRef`,
`productDisplayName`, `quantity`, `unit`, `unitMinor`, `lineTotalMinor`. Supplier cost, offerRef и
policy internals публично не возвращаются.

При отсутствии активной policy create возвращает типизированный
`503 PRICING_POLICY_UNAVAILABLE`. Неизвестный исход DB COMMIT не вызывает
автоматический повтор бизнес-эффекта; клиент проверяет тот же ключ через
bodyless recovery. RFC 9457 ошибки не раскрывают supplier facts или SQL.

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

`canonical_hash` защищает публичный immutable response. Отдельный
`internal_proof_hash` использует тот же алгоритм, но дополнительно включает
`offerRef`, `mappingRevision`, `supplierUnitMinor`, `catalogSnapshotRevision`
каждой строки и все применённые policy facts. Публичный API его не выдаёт.

## 6. Проверка для Orders

`POST /api/internal-v1/pricing/quotes:verify`, audience только
`orders-service`, deadline 1s, без `Idempotency-Key` и без side effects кроме
append-only audit.

Решение владельца от 27 сентября 2026 для #8: **проверка одной выбранной строки
с обязательной проверкой целостности всей сохранённой котировки**. Это заменяет
прежний full-lines verify request; не добавляет второй endpoint или режим.

Закрытый `PricingQuoteVerifyRequest` содержит обязательные поля `quoteRef`,
`hash`, `customerRef`, `quoteLineNumber` (integer 1..100), `productRef`,
`variantRef`, canonical `quantity`. `lines[]` и другие поля запрещены.
Public `OrderItemPutRequest` не меняется: его `quoteHash` передаётся как `hash`.

Pricing загружает полную сохранённую quote и все lines, декодирует их,
пересчитывает и проверяет public hash и internal proof hash; затем проверяет
Customer, срок действия на DB time и выбирает строку по сохранённому
`lineNumber=quoteLineNumber`. Товар, вариант и количество обязаны совпасть.
Отсутствующий/подменённый номер или несовпадение expected facts — scope mismatch.
Повреждение любой строки, в том числе невыбранной, не может дать успешный proof.
Просто ослабить сравнение числа строк до произвольного подмножества запрещено.

Закрытый `200 PricingQuoteVerificationResponse` содержит обязательные
`valid:true`, `quoteRef`, `policyVersionRef`, `catalogSnapshotRevision`,
`customerRef`, `expiresAt`, `currency` и **`line`**, не `lines`/`totalMinor`.
`line` имеет существующий состав `PricingQuoteAuthoritativeLine`: `lineNumber`,
`productRef`, `variantRef`, `productDisplayName`, `offerRef`, `mappingRevision`,
`quantity`, `unit`, `supplierUnitMinor`, `unitMinor`, `lineTotalMinor`, `currency`,
`internalProofHash`. `lineNumber` сохраняет исходный номер, не перенумеровывается
в 1; `internalProofHash` относится ко всей проверенной котировке, не к новому
hash подмножества. Общий quote total не является суммой позиции Orders.

Orders сверяет quote/customer/line/product/variant/quantity/currency/expiry
с исходным запросом и сохраняет authoritative proof; private supplier/mapping
facts не выдаются браузеру. Полный quote не восстанавливается из browser body.
Лимит чтения private ответа 256 KiB сохраняется; новый ответ содержит одну
строку, превышение/невалидный JSON/shape закрываются до forwarding.

В #8 согласованно заменить OpenAPI internal-v1, runtime schemas/types,
api-internal forwarding, Pricing provider и Orders client с их тестами.
Старую реализацию и fixtures full-lines verify удалить; не вводить compatibility
union или fallback. Пока это не выполнено, действующий код старого verify не
считается реализацией утверждённого контракта. Confirm проверяет только
persisted Orders proof и не вызывает Pricing внутри транзакции.

Ошибки: `404 PRICING_QUOTE_NOT_FOUND`, `409 PRICING_QUOTE_HASH_MISMATCH`,
`409 PRICING_QUOTE_EXPIRED`, `409 PRICING_QUOTE_SCOPE_MISMATCH`,
`503 PRICING_POLICY_UNAVAILABLE`, а также общие auth/validation codes. Ошибка не
возвращает сохранённый hash или правильные ожидаемые значения.

## 7. Наблюдаемость и проверки

Owner публикует через общий runtime `/metrics` только фиксированные outcome
create, verify, Catalog read/retry и DB, время операции и bucket количества
строк. Span names фиксированы для precheck, policy lookup, Catalog child,
calculation, persistence и verify. Ни actor/customer/quote refs, ни supplier
cost, raw body или private proof не становятся metric labels или span
attributes. Реальные экспортеры и production-доставка telemetry проверяются
отдельно от локальных тестов.

- property/table tests формулы на boundary values и bigint overflow guards;
- одна policy race: partial unique index не допускает две Active policies;
- PostgreSQL integration: quote/lines/audit/idempotency commit атомарны;
- UPDATE/DELETE immutable quote role получает `permission denied`;
- одинаковые DB facts дают одинаковый hash после restart/на другой locale;
- изменение каждого hash-поля меняет hash;
- idempotency: replay, conflict, in-progress, expired lease и crash recovery;
- Catalog unavailable/timeout/mixed revision не создаёт quote;
- verify: valid, unknown, altered hash, expired и scope mismatch;
- selected-line verify #8: не первая строка многопозиционной котировки,
  неправильный номер/product/variant/quantity/customer, corruption невыбранной
  строки, отказ старому `lines[]` body и отсутствие private facts в public API;
- уникальность `(productRef,variantRef)` при создании quote сохраняется:
  дубли являются негативным/corruption fixture, не допустимой новой котировкой;
- OpenAPI positive/negative fixtures и breaking-change gate;
- architecture checker запрещает Customer/Catalog/Orders imports и DB URLs;
- redaction canary отсутствует в logs/traces/errors/audit.

## 8. Не входит

Discounts, loyalty/customer tiers, promotions DSL, taxes, delivery calculation,
multi-currency, payments, invoices, dynamic repricing confirmed Orders, Kafka,
admin UI policy editor и перенос legacy pricing не входят в #7.
