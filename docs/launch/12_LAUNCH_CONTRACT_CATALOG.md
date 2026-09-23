# Нормативный каталог контрактов первого запуска

Исполнитель не проектирует поля заново. Он реализует перечисленные файлы,
routes, schemas, status codes и fixtures. Изменение поля, типа, обязательности
или route требует ADR и отдельного изменения этого документа.

## 1. Файлы

```text
contracts/
  openapi/client-v1.yaml
  openapi/internal-v1.yaml
  schemas/common/problem-details.v1.schema.json
  schemas/common/message-envelope.v1.schema.json
  schemas/common/identifiers.v1.schema.json
  schemas/common/money-version-time.v1.schema.json
  schemas/events/catalog-snapshot-activated.v1.schema.json
  schemas/events/catalog-mapping-changed.v2.schema.json
  schemas/events/order-confirmed.v1.schema.json
  schemas/events/aroma-convergence-requested.v1.schema.json
  schemas/events/aroma-observation-changed.v1.schema.json
  schemas/events/aroma-convergence-changed.v1.schema.json
  schemas/events/realtime-invalidated.v1.schema.json
  manifest.yaml
  fixtures/positive/**
  fixtures/negative/**
```

OpenAPI version — `3.2.0`. JSON Schema dialect — draft 2020-12. Во всех
objects используется `additionalProperties: false`.
Эти файлы являются source authority; `packages/generated/{client,internal}-v1`
содержат только детерминированные types-only artifacts.

## 2. Общие типы

| Тип | Формат |
|---|---|
| CustomerRef | `^cus_[0-9A-HJKMNP-TV-Z]{26}$` |
| AddressRef | `^adr_[0-9A-HJKMNP-TV-Z]{26}$` |
| ChannelLinkRef | `^chl_[0-9A-HJKMNP-TV-Z]{26}$` |
| AuditRef | `^aud_[0-9A-HJKMNP-TV-Z]{26}$` |
| ProductRef | `^prd_[0-9A-HJKMNP-TV-Z]{26}$` |
| VariantRef | `^var_[0-9A-HJKMNP-TV-Z]{26}$` |
| OfferRef | `^off_[0-9A-HJKMNP-TV-Z]{26}$` |
| SnapshotRef | `^snp_[0-9A-HJKMNP-TV-Z]{26}$` |
| CartScopeRef | строковая константа `aroma-primary` в первом запуске |
| QuoteRef | `^prq_[0-9A-HJKMNP-TV-Z]{26}$` |
| OrderRef | `^ord_[0-9A-HJKMNP-TV-Z]{26}$` |
| ItemRef | `^itm_[0-9A-HJKMNP-TV-Z]{26}$` |
| MessageId | `^msg_[0-9A-HJKMNP-TV-Z]{26}$` |
| OperationRef | `^op_[0-9A-HJKMNP-TV-Z]{26}$` |
| SupplierRef | `^sup_[0-9A-HJKMNP-TV-Z]{26}$` |
| AttemptRef | `^att_[0-9A-HJKMNP-TV-Z]{26}$` |
| PolicyVersionRef | `^pvr_[0-9A-HJKMNP-TV-Z]{26}$` |
| version/revision | строка `^(0|[1-9][0-9]*)$` |
| money minor units | строка `^-?(0|[1-9][0-9]*)$` |
| QuantityDecimal | строка `^(?:[1-9][0-9]{0,5})(?:\.[0-9]{1,3})?$|^0\.(?!0{1,3}$)[0-9]{1,3}$` |
| QuantityMilli | non-negative integer decimal string `^(0|[1-9][0-9]*)$` |
| ProviderQuantity | strictly positive canonical decimal string; scale/max/step проверяются provider adapter после подтверждения provider facts |
| hash | lowercase SHA-256: `^[a-f0-9]{64}$` |
| timestamp | RFC 3339 UTC `date-time`, суффикс `Z` |
| currency | `RUB` в первом срезе |
| Idempotency-Key | UUID, header, обязателен для POST/PUT/DELETE commands |
| X-Correlation-ID | UUID; optional input, always present in response |
| traceparent | W3C Trace Context pattern |

Actor отсутствует во всех request bodies. Edge выпускает assertion с
`aud=api-public`; api-public проверяет его и по mTLS вызывает owner с коротким
delegated actor assertion `iss=api-public,aud=<owner>,originalIssuer=edge-gateway,
actorRef,permissions,operationId,correlationId,iat,exp,jti,kid`. Owner проверяет
transport caller, issuer/audience, route allowlist и permission.

### Владение и повторное использование schemas

| Schema | Определяется один раз в | Используют |
|---|---|---|
| Ref/Money/Version/Timestamp | `schemas/common/identifiers` и `money-version-time` | все HTTP/events/frontend |
| ProblemDetails | `schemas/common/problem-details` | все HTTP services и project-owned clients; `type` и `instance` — URI-reference |
| MessageEnvelope | `schemas/common/message-envelope` | все семь event schemas |
| CustomerResponse/Summary | `client-v1.yaml#/components/schemas` | Customer provider, Orders customer snapshot, React |
| CatalogProductSummary | `client-v1.yaml#/components/schemas` | Catalog provider, Pricing request UI, React |
| PricingQuoteResponse | `client-v1.yaml#/components/schemas` | Pricing provider, Orders quote proof, React |
| OrderCardResponse | `client-v1.yaml#/components/schemas` | Orders provider, React, realtime refetch test |

Consumer не копирует schema в свой каталог. Для persisted snapshot он создаёт
внутреннюю модель с явным mapper test `contract DTO → owner snapshot`; internal
model не экспортируется и не используется как HTTP/event schema.

## 3. `client-v1.yaml`

### 3.0 Read-only восстановление command result

[Browser command recovery](26_BROWSER_COMMAND_RECOVERY.md) определяет
`Idempotency-Replay-Only: true` для семи commands ниже. #4 материализует этот
режим, header/body/version constraints и typed errors в тех же operations,
переиспользуя существующие response schemas. Обычная команда без обязательного
body/version по-прежнему невалидна. GET/SSE/provider/internal paths режим не
получают; количество бизнес-events не меняется.

### 3.1 Customer

`POST /api/client-v1/customers`

- headers: `Authorization`, `Idempotency-Key`, optional `X-Correlation-ID`, `traceparent`;
- body `CustomerCreateRequest`:
  - `displayName`: required, trimmed string, 1–200;
  - `phone`: optional raw user input, string 1–64; Customer нормализует его
    `libphonenumber-js` (exact pin материализует #5 в
    `config/toolchain-versions.json` до реализации нормализации) с region `RU` и возвращает E.164;
  - `email`: optional email, max 254;
  - `address`: optional object `{line1, line2?, city, postalCode?, countryCode}`;
  - как минимум одно из `phone`/`email` обязательно;
- `201 CustomerResponse`: `customerRef`, `version`, `displayName`, `phone?`,
  `email?`, `address?`, `createdAt`, `updatedAt`;
- errors: `400 VALIDATION_FAILED`, `401 AUTHENTICATION_REQUIRED`,
  `403 ACTOR_CONTEXT_INVALID`, `409 CUSTOMER_PHONE_CONFLICT`,
  `409 CUSTOMER_EMAIL_CONFLICT`, `409 IDEMPOTENCY_CONFLICT`,
  `409 IDEMPOTENCY_REQUEST_IN_PROGRESS`.

`GET /api/client-v1/customers`

- query: `query` required 2–200; `limit` integer 1–50 default 20;
  `cursor` optional Customer-scoped opaque string max 2048;
- `200 CustomerSearchResponse`: `{items: CustomerSummary[], nextCursor: string|null}`;
- `CustomerSummary`: `customerRef`, `version`, `displayName`, masked `phone?`, masked `email?`;
- errors: `400 VALIDATION_FAILED`, `400 INVALID_CURSOR`,
  `401 AUTHENTICATION_REQUIRED`, `403 ACTOR_CONTEXT_INVALID`.

### 3.2 Catalog

`GET /api/client-v1/catalog/products`

- query: `query` required 2–200; `availability` optional enum
  `Available|Unavailable|Stopped`; `limit` 1–50 default 20; `cursor` optional
  opaque string max 512;
- `200 CatalogSearchResponse`: `{snapshotRevision, items, nextCursor}`;
- item: `productRef`, `variantRef`, `displayName`, `unit` enum
  `piece|gram|kilogram`, `availability`, `mappingAvailable` boolean,
  `imageUrl?`; provider offer/session identifiers не возвращаются;
- errors: `400 VALIDATION_FAILED`, `503 CATALOG_SNAPSHOT_INCOMPLETE`.

### 3.3 PricingQuote

`POST /api/client-v1/pricing/quotes`

- headers: Authorization + Idempotency-Key + correlation/trace;
- body: `customerRef`, `lines` array 1–100; line = `productRef`,
  `variantRef`, `quantity` positive decimal string с scale не более 3;
- `201 PricingQuoteResponse`: `quoteRef`, `policyVersionRef`,
  `catalogSnapshotRevision`, `customerRef`, `createdAt`, `expiresAt`,
  `currency: RUB`, `lines`, `totalMinor`, `hash`;
- response line: `lineNumber`, `productRef`, `variantRef`,
  `productDisplayName`, `quantity`, `unit`, `unitMinor`, `lineTotalMinor`;
- errors: `400 VALIDATION_FAILED`, `404 CATALOG_PRODUCT_NOT_FOUND`,
  `409 CATALOG_PRODUCT_UNAVAILABLE`, `409 IDEMPOTENCY_CONFLICT`.

### 3.4 Draft и позиции

`POST /api/client-v1/orders/drafts`

- body: `{customerRef}`;
- `201 OrderCardResponse` со статусом `Draft`, `version: "1"`, пустыми items;
- errors: `404 CUSTOMER_NOT_FOUND`, `409 CUSTOMER_NOT_ACTIVE`,
  `503 CUSTOMER_UNAVAILABLE`, `409 IDEMPOTENCY_CONFLICT`.

`PUT /api/client-v1/orders/{orderRef}/items/{itemRef}`

- path refs по общим patterns;
- body: `expectedVersion`, `productRef`, `variantRef`, positive `quantity`,
  `quoteRef`, `quoteLineNumber`, `quoteHash`; displayName, money, offer/mapping,
  currency и expiry во входе запрещены;
- `200 OrderCardResponse` с увеличенной version;
- errors: `404 ORDER_NOT_FOUND`, `404 CATALOG_PRODUCT_NOT_FOUND`,
  `409 ORDER_VERSION_CONFLICT`, `409 ORDER_QUOTE_STALE`,
  `409 ORDER_NOT_EDITABLE`, `409 IDEMPOTENCY_CONFLICT`.

`DELETE /api/client-v1/orders/{orderRef}/items/{itemRef}`

- headers: `Idempotency-Key`, `If-Match-Version` decimal string;
- body отсутствует;
- `200 OrderCardResponse`;
- errors: `404 ORDER_NOT_FOUND`, `404 ORDER_ITEM_NOT_FOUND`,
  `409 ORDER_VERSION_CONFLICT`, `409 ORDER_NOT_EDITABLE`.

### 3.5 Commands и Order Card

`POST /api/client-v1/orders/{orderRef}/commands/confirm`

- body: `{expectedVersion}`; provider URL/id/credential/price запрещены;
- `200 OrderCardResponse` со статусом `Confirmed`;
- errors: `404 ORDER_NOT_FOUND`, `409 ORDER_VERSION_CONFLICT`,
  `409 ORDER_QUOTE_STALE`, `422 ORDER_CONFIRMATION_REJECTED`,
  `409 IDEMPOTENCY_CONFLICT`.

`POST /api/client-v1/orders/{orderRef}/commands/request-aroma-reconciliation`

- body: `{expectedVersion, reason}`; `reason` trimmed 1–500;
- `202 ReconciliationAcceptedResponse`:
  `{orderRef, orderVersion, requestedAt, aromaState}`;
- errors: `404 ORDER_NOT_FOUND`, `409 ORDER_VERSION_CONFLICT`,
  `409 AROMA_RECONCILIATION_NOT_ALLOWED`, `409 IDEMPOTENCY_CONFLICT`.

`GET /api/client-v1/orders/{orderRef}`

- `200 OrderCardResponse`:
  - `orderRef`, `version`, `status: Draft|Confirmed`;
  - `customer: {customerRef, displayName}`;
  - `items[]: {itemRef, linePosition, productRef, variantRef, displayName,
    quantity, unit, quoteRef, quoteLineNumber, unitMinor, lineTotalMinor}`;
  - `pricing: {totalMinor, currency, quoteProofs[]}` или `null`, где proof =
    `{quoteRef, hash, expiresAt}`; несколько позиций могут ссылаться на разные
    неизменяемые quotes;
  - top-level `projectionVersion` — версия всей Order Card projection;
  - `aroma: {state, desiredRevision, observedRevision, lastObservedAt,
    blockers[]}`;
  - `allowedActions[]` enum `edit-items|confirm|request-aroma-reconciliation`;
- Aroma state enum: `NotRequested|PendingObservation|OutOfSync|Converging|InSync|Blocked|UnknownOutcome`;
- blocker: `{code, message, productRef?}`, где code включает
  `MAPPING_CHANGED|MAPPING_MISSING|MAPPING_STOPPED|PRODUCT_UNAVAILABLE`;
- errors: `404 ORDER_NOT_FOUND`.

### 3.6 SSE

`GET /events` возвращает `text/event-stream`:

```text
id: msg_01...
event: resource-invalidated.v1
retry: 3000
data: {"subjectType":"order","subjectRef":"ord_...","ownerVersion":"7","reason":"AromaStateChanged","correlationId":"..."}
```

`ownerVersion` всегда равен `OrderCard.projectionVersion`, а не command
`Order.version`. `reason`: `OrderChanged|AromaStateChanged`. Event не содержит Customer, items,
money, Desired/Observed quantities или `allowedActions`; после него клиент
выполняет owner GET.

Дополнительно разрешены только `stream-ready.v1` без `id` и
`stream-reset.v1` с `{reason:"REPLAY_UNAVAILABLE"}` без `id`; heartbeat — SSE
comment каждые 15 секунд. `Last-Event-ID`, local replay window, authorization,
fanout/backpressure и frontend invalidation заданы в
`docs/launch/20_REALTIME_SSE_IMPLEMENTATION_SPEC.md`.

## 4. `internal-v1.yaml`

Все routes private, требуют mTLS/service identity и отсутствуют в edge routing:

- `GET /api/internal-v1/catalog/products/{productRef}/variants/{variantRef}/pricing-input`;
- `GET /api/internal-v1/customers/{customerRef}/order-input`; response только
  `customerRef`, `customerVersion`, `displayName`, `state`, audience
  `orders-service`, без contacts/addresses;
- `POST /api/internal-v1/pricing/quotes:verify`; request содержит `quoteRef`,
  `hash`, `customerRef`, ожидаемые `productRef`/`variantRef`/`quantity`, response
  возвращает authoritative immutable quote facts; точная семантика задана в
  `docs/launch/16_PRICING_IMPLEMENTATION_SPEC.md`, раздел 6;
- `POST /api/internal-v1/aroma/catalog-exports` с response
  `application/x-ndjson`; точные request, record types, batch/hash limits,
  terminal semantics и audience заданы в
  `docs/launch/15_CATALOG_IMPLEMENTATION_SPEC.md`, раздел 3;
- `POST /api/internal-v1/aroma/cart-snapshots:read`;
- `POST /api/internal-v1/aroma/cart-lines/{offerRef}:set-quantity`;
- `POST /api/internal-v1/aroma/cart-lines/{offerRef}:remove`.

AROMA mutation bodies обязательно содержат `operationRef`; set quantity также
содержит non-negative decimal-string `quantity`. Произвольные URL, HTTP method,
headers или raw body в schema отсутствуют.

## 5. Problem Details

`application/problem+json` строго содержит:

```json
{
  "type": "https://errors.coffeeorderplatform.local/ORDER_VERSION_CONFLICT",
  "title": "Конфликт версии заказа",
  "status": 409,
  "code": "ORDER_VERSION_CONFLICT",
  "detail": "...",
  "instance": "/api/client-v1/orders/ord_...",
  "correlationId": "uuid",
  "errors": []
}
```

`code` и `status` обязаны совпадать с route mapping выше. Stack trace, SQL,
provider response и secret data запрещены.

## 6. Семь событий

Общий envelope каждого JSON Schema:

- `envelopeVersion: "1"`; версия wire envelope независима от версии messageType;
- `messageId`, `messageType`, `occurredAt`, `producer`;
- `correlationId` UUID, `causationId` MessageId|null, `traceparent`;
- `aggregate: {type, ref, version}`;
- `payload`; additional properties запрещены.

| messageType | Producer | Key | Payload required |
|---|---|---|---|
| `CatalogSnapshotActivated.v1` | catalog-activation-worker | supplierRef | `supplierRef`, `snapshotRef`, `snapshotRevision`, `activatedAt`, `productCount`, `variantCount`, `offerCount`, `batchCount`, `contentHash` |
| `CatalogMappingChanged.v2` | catalog-activation-worker | productRef | `productRef`, `variantRef`, `offerRef|null`, `catalogSnapshotRevision`, `mappingRevision`, `mappingState: Active|Missing|Stopped`, `availability`, `effectiveAt` |
| `OrderConfirmed.v1` | orders-service | orderRef | `orderRef`, `orderVersion`, `customerRef`, `confirmedAt`, `contributionRevision` |
| `AromaConvergenceRequested.v1` | Orders | cartScopeRef | `cartScopeRef`, `desiredRevision`, `reason: OrderConfirmed|CatalogChanged|OperatorRequested|Recovery`, `orderRef|null` |
| `AromaObservationChanged.v1` | aroma-observer/aroma-convergence | cartScopeRef | `cartScopeRef`, `observedRevision`, `observedAt`, `observationState: Complete`, `cartFingerprint` |
| `AromaConvergenceChanged.v1` | aroma-convergence | cartScopeRef | `cartScopeRef`, `desiredRevision`, `observedRevision`, `attemptRef`, `attemptState: NoOpInSync|VerifiedInSync|OutOfSync|Blocked|UnknownOutcome|Failed`, `changedAt`, `blockerCodes[]` |
| `RealtimeInvalidated.v1` | owner services | subjectRef | `subjectType: order`, `subjectRef`, `ownerVersion`, `reason: OrderChanged|AromaStateChanged` |

Catalog пишет оба события в owner Outbox **в той же транзакции**, что и
`catalog_state` pointer. `CatalogSnapshotActivated.v1` создаётся для каждой
действительно активированной revision, `CatalogMappingChanged.v2` — только для
изменившейся mapping/availability; Kafka relay сохраняет durable `messageId`
при повторной доставке. Полные `products`/`variants`/`offers` передавать в
envelope или payload нельзя. Стабильные `productRef`/`variantRef`/`offerRef`
назначаются по scoped Gateway source identity, а не по порядку batch.

Дополнительные ограничения payload:

- `productCount`: JSON integer, minimum `0`;
- `contentHash` и `cartFingerprint`: lowercase SHA-256;
- `mappingState`: `Active|Missing|Stopped`;
- conditional: `Active` требует non-null `offerRef`; `Missing|Stopped` требуют
  `offerRef=null`; остальные сочетания schema-invalid;
- convergence reason: `OrderConfirmed|CatalogChanged|OperatorRequested|Recovery`;
- projection worker единолично преобразует `observationState`/`attemptState` в
  Order Card Aroma state; producer события Card state не вычисляет;
- `blockerCodes`: unique string array, maximum 100;
- все refs/version/timestamps используют только общие `$ref`, локальное
  переопределение pattern/type запрещено meta-schema test.

Kafka event payloads не содержат credentials, phone/email/address, provider
cookies, arbitrary URLs или полную корзину.

## 7. Генерация и fixtures

- `pnpm contracts:lint` проверяет OpenAPI structure/refs и JSON Schema
  существующим AJV; второй linter/framework не требуется;
- `pnpm contracts:generate` использует `@hey-api/openapi-ts 0.0.0-next-20260824173136` только с
  `@hey-api/typescript`, outputs `packages/generated/client-v1/**` и
  `packages/generated/internal-v1/**`; exact prerelease разрешён
  [ADR-0026](../adr/ADR-0026-ts7-codegen-prerelease-admission.md);
- `output.module.extension: ".js"` задаётся явно для NodeNext; compile проверяет
  все generated-файлы, включая `index.ts`, и импорт типов через него;
- SDK/client/hooks/Zod/Axios не генерируются; project-owned browser native fetch
  client использует generated `client-v1` transport types, backend Undici clients
  — generated `internal-v1` transport types; runtime response validation обязательна;
- генератор принимается только после golden corpus используемых OpenAPI 3.2
  constructs, deterministic double generation, zero diff и `tsc 7.0.2` compile;
- `pnpm contracts:check-generated` выполняет повторную генерацию и zero diff;
- `pnpm contracts:test` проверяет positive/negative fixtures и runtime
  cross-field validation;
- `pnpm contracts:breaking` сравнивает с `origin/develop`; удаление/rename/
  required-field/type/enum narrowing/status removal блокирует PR;
- по одному positive fixture на route/status и messageType;
- negative fixtures: missing required field, additional field, invalid ref,
  numeric money/version, invalid enum, actor/provider credential in body,
  secret in event, malformed traceparent и неверный Problem status/code;
- каждый negative fixture содержит `expected-error.json` с schema path и rule ID.
