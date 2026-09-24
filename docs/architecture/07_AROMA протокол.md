---
type: architecture
project: CoffeeOrderPlatform
status: reference
verified: 2026-09-22
source: "Исходники Gateway и нормативные документы; проверка чтением в локальной зоне +05"
source_commit: 4b2cad1dab30af66ad0b2fe64da280222e506574
sources:
  - docs/launch/04_AROMA_CART_SAFETY.md
  - docs/launch/19_AROMA_CONVERGENCE_IMPLEMENTATION_SPEC.md
  - docs/launch/22_AROMA_GATEWAY_OPERATION_JOURNAL.md
  - docs/launch/27_AROMA_PROVIDER_PROTOCOL.md
  - docs/launch/28_AROMA_CATALOG_PRICING_POLICY.md
  - docs/CoffeeOrderSystem_CANONICAL_Architecture_EndToEndHardened_RU_2026-08-19/M11_AROMA_GATEWAY/02_AROMA_GATEWAY_PROVIDER_CONTRACT.md
  - docs/CoffeeOrderSystem_CANONICAL_Architecture_ContractClosure_RU_2026-08-22/M20_SERVICE_ORCHESTRATION/RUNTIME_AND_INTERACTION_AUTHORITY.md
  - apps/aroma-gateway
  - packages/contracts/aroma-v1
  - tests/aroma
  - evidence/aroma-provider
---

# 07_AROMA протокол

[Проекты/CoffeeOrderPlatform/Архитектура/00_Атлас архитектуры](README.md)

> **Назначение заметки.** Зафиксировать наблюдаемый на `HEAD` протокол AROMA Gateway: границы владельцев, provider transport/session/login, точные внутренние маршруты, catalog export, source identity, pagination, grind/packing/pricing/promotions, safe cart read и guarded mutation. Нормативная спецификация и реальная реализация разделены явно.

## 1. Короткий вывод: что является фактом, а что только целью

**Реально реализовано в Gateway.** В `apps/aroma-gateway` есть композиция typed provider HTTP-клиента, session manager, encrypted session store, offer-binding store, catalog source/export, cart reader, mutation journal и typed HTTP routes. Runtime запрещает произвольный provider URL/method/body: операции задаются закрытым union-типом read/mutation и переводятся в фиксированные paths. Реальная wiring-точка создаёт клиент с HTTPS-origin, deadline профилем cart, лимитом ответа 2 MiB, ограниченной concurrency, session store, HMAC identity key и journal recovery. `apps/aroma-gateway/src/main.ts:1-14`; `apps/aroma-gateway/src/main.ts:47-113`

**Реализовано как scaffold, а не как Orders convergence.** `apps/aroma-observer`, `apps/aroma-convergence` и `apps/orders-aroma-preparation` в inspected source содержат только вызов `startConfiguredRuntime(...)`; в них нет durable Desired/Observed/Attempt/Lease/Fence state machine, provider orchestration или wake-event consumer. Поэтому наличие пакета и `start`-скрипта не является доказательством готовности convergence. `apps/aroma-observer/src/main.ts:1-3`; `apps/aroma-convergence/src/main.ts:1-3`; `apps/orders-aroma-preparation/src/main.ts:1-3`; `apps/aroma-convergence/package.json:1`; `apps/orders-aroma-preparation/package.json:1`

**Нормативные документы не приписываются runtime.** M11/M12/M20, `04_AROMA_CART_SAFETY`, `19_AROMA_CONVERGENCE_IMPLEMENTATION_SPEC` и `22_AROMA_GATEWAY_OPERATION_JOURNAL` задают ownership, safety protocol, recovery и будущую semantic state machine. Они являются reference/authority для дизайна, но не доказывают материализацию Orders-owned convergence. Сама launch-документация говорит, что A1 переносит provider protocol, а A2 отдельно переносит Desired/Observed/Convergence/Attempt/Lease/Fence/UnknownOutcome. `docs/CoffeeOrderSystem_CANONICAL_Architecture_EndToEndHardened_RU_2026-08-19/M11_AROMA_GATEWAY/01_AROMA_MIGRATION_AND_SAFETY.md:3-37`

## 2. Владельцы и capability boundary

Таблица ниже описывает нормативные полномочия; наличие rate/circuit policy в ней не означает полной реализации этого механизма. Канонические термины A1/A2 относятся к исторической формулировке источника. CoffeeOrderPlatform создаётся с нуля и не переносит runtime-код или модели legacy; из канона сохраняются бизнес-инварианты (`AGENTS.md:1-5`).

| Владелец | Разрешённое знание/действие | Явно запрещено |
|---|---|---|
| **AROMA Gateway** | credentials, login/session/cookies, typed provider transport, DTO decode/normalization, rate/concurrency guard, circuit/readiness signal, mutation journal; фиксированные safe GET и narrow mutation primitives | Desired, OrderId, decision «повторять ли mutation», Orders/Catalog DB, business events, arbitrary proxy |
| **Catalog / `catalog-supplier-sync`** | полный wholesale snapshot, completeness/hash, Product/Variant/offer facts, promotions, availability, source identity/binding registration | cart mutation, Orders DB, per-item provider lookup, изменение Order |
| **Orders** | Confirmed intent, immutable snapshots, Desired sources/revisions, Observed, Convergence, Attempt, lease/fence, UnknownOutcome, recovery and business retry | provider credentials/session, прямой provider HTTP, cross-owner DB |
| **`aroma-observer`** | только safe cart GET через Gateway | mutation |
| **`aroma-convergence`** | safe cart GET плюс узкие `set/remove` после собственной lease/fence/Desired/Catalog проверки | произвольный method/path, blind retry, использование Kafka как physical proof |

Такое разделение совпадает с M11: Gateway скрывает provider protocol и credentials, не принимает `sendOrderToCart(orderId)`, а mutation primitive делает ровно один provider request. Capability проверяется по route/method и delegation claims, не только по network source. `docs/CoffeeOrderSystem_CANONICAL_Architecture_EndToEndHardened_RU_2026-08-19/M11_AROMA_GATEWAY/02_AROMA_GATEWAY_PROVIDER_CONTRACT.md:3-19`; `docs/CoffeeOrderSystem_CANONICAL_Architecture_EndToEndHardened_RU_2026-08-19/M11_AROMA_GATEWAY/02_AROMA_GATEWAY_PROVIDER_CONTRACT.md:21-29`; `docs/CoffeeOrderSystem_CANONICAL_Architecture_EndToEndHardened_RU_2026-08-19/M11_AROMA_GATEWAY/02_AROMA_GATEWAY_PROVIDER_CONTRACT.md:58-71`

M20 фиксирует разрешённые interaction edges: Catalog получает полный safe-read snapshot, Orders convergence делает safe-read Catalog preflight, observer делает physical-cart observation, convergence использует `http-get-mutate-get`, а checkout-poller имеет отдельный wholesale safe-read. Эти edges не дают никакому runtime разрешения писать чужую БД. `docs/CoffeeOrderSystem_CANONICAL_Architecture_ContractClosure_RU_2026-08-22/M20_SERVICE_ORCHESTRATION/service-interaction-policy.closure.json:95-141`

## 3. Точные routes и provider methods

### 3.1 Internal Gateway routes

Канонический internal-v1 контракт объявляет следующие routes и operation IDs: `contracts/openapi/internal-v1.yaml:152-194`; `contracts/openapi/internal-v1.yaml:249-386`

| Route | OperationId | Caller | Side effect | Реальная проверка |
|---|---|---|---|---|
| `POST /api/internal-v1/aroma/catalog-exports` | `exportAromaCatalog` | `catalog-supplier-sync` | safe provider reads, local export persistence | `originalCaller` + exact operation ID |
| `POST /api/internal-v1/aroma/offer-bindings` | `registerAromaOfferBinding` | `catalog-activation-worker` | immutable binding registration | exact delegation and supplier |
| `POST /api/internal-v1/aroma/cart-snapshots:read` | `readAromaCartSnapshot` | `aroma-observer`, `aroma-convergence` | none at business level | safe read only |
| `POST /api/internal-v1/aroma/cart-lines/{offerRef}:set-quantity` | `setAromaCartLineQuantity` | `aroma-convergence` | unsafe provider mutation | journal + one dispatch |
| `POST /api/internal-v1/aroma/cart-lines/{offerRef}:remove` | `removeAromaCartLine` | `aroma-convergence` | unsafe provider mutation | journal + one dispatch |

В implementation Fastify регистрирует один parameterized route `/api/internal-v1/aroma/cart-lines/:mutationTarget`, затем принимает только regex `off_<ULID>:set-quantity|remove`; это runtime-представление двух canonical contract templates, не arbitrary path. `cart-snapshots:read` имеет отдельный `cartMs` deadline, export — `readMs`, mutation — `mutationMs`. `apps/aroma-gateway/src/transport/http/index.ts:121-150`; `apps/aroma-gateway/src/transport/http/index.ts:193-218`; `apps/aroma-gateway/src/transport/http/index.ts:221-236`

Публичный client/agent API не содержит provider cart routes: изменения идут explicit commands, а raw provider IDs и `sendToAromaCart` наружу запрещены. `docs/CoffeeOrderSystem_CANONICAL_Architecture_EndToEndHardened_RU_2026-08-19/M19_API_ARCHITECTURE/11_ORDER_AROMA_API_CONTRACTS.md:3-22`

### 3.2 Закрытые provider methods и paths

Provider transport принимает только следующие read operations: `cart`, `user`, `grinds`, `catalog-page`; paths строятся внутри Gateway: `/api/v1/cart/`, `/api/v1/user`, `/api/v1/catalog/grinds`, `/api/v1/catalog/wholesale/products?page=N&per_page=M`. Mutation paths — POST `/api/v1/cart/` для add, PUT/DELETE `/api/v1/cart/{cartLineId}` для set/remove. Caller не передаёт URL, headers или body произвольной формы. `apps/aroma-gateway/src/infrastructure/provider/http-client.ts:16-39`; `apps/aroma-gateway/src/infrastructure/provider/http-client.ts:75-98`

Тесты закрепляют login POST `/api/v1/auth/login`, add form-urlencoded, set JSON и DELETE; `422` декодируется с `effect: unknown` и не retry-ится. `tests/aroma/provider-http.test.mjs:446-512`; `tests/aroma/provider-http.test.mjs:514-556`

## 4. Transport, redirects, deadlines и redaction

Origin валиден только как HTTPS без явного порта, user/password, path, query или fragment; transport ставит `redirect: "manual"`, `Accept: application/json`, проверяет status/content-type/body size и abort signal. Redirect, невалидный origin, слишком большой или пустой body становятся typed `ProviderError`, а не свободным исключением с provider body. `apps/aroma-gateway/src/infrastructure/provider/http-client.ts:100-167`; `apps/aroma-gateway/src/infrastructure/provider/http-client.ts:401-480`

Login принимает credentials только внутри Gateway session manager, проверяет профиль и scoped email; cookies фильтруются по expiry, шифруются перед persistence, decrypted material остаётся в памяти Gateway и очищается при shutdown. Local cache ограничен 5 минутами и 32 scope entries; это не provider TTL/refresh contract. Concurrent acquire одного scope использует single-flight login. `apps/aroma-gateway/src/infrastructure/provider/session.ts:17-23`; `apps/aroma-gateway/src/infrastructure/provider/session.ts:193-240`; `apps/aroma-gateway/src/infrastructure/provider/session.ts:348-444`

Safe read допускает не более одной re-auth только если authentication failure произошёл до выдачи первого байта. После partial output повтор запрещён; для unsafe mutation session recovery не превращается в replay. Это важнее любой общей HTTP retry policy. `apps/aroma-gateway/src/infrastructure/provider/session.ts:242-312`; `docs/launch/22_AROMA_GATEWAY_OPERATION_JOURNAL.md:12-21`

Redaction многоуровневый: `ProviderError` не содержит provider body, caller URL, cookie или credential; telemetry фильтрует ключи/значения с `cookie|password|secret|token|authorization|credential|email|body|pii`; session store хранит только encrypted cookie material. Tests проверяют, что пароль/cookie/provider secret не появляются в error stack, persistence или span. `apps/aroma-gateway/src/domain/provider-errors.ts:15-30`; `apps/aroma-gateway/src/infrastructure/observability.ts:107-138`; `tests/aroma/gateway-operations-http.test.mjs:78-107`; `tests/aroma/provider-http.test.mjs:350-412`

Gateway deadline берётся из runtime config (`cartMs`), provider client получает timeout, max response 2 MiB и configured connections; shutdown использует abort и fail-stop destroy, не ожидая provider generator, который игнорирует cancellation. `apps/aroma-gateway/src/main.ts:38-42`; `apps/aroma-gateway/src/main.ts:59-70`; `apps/aroma-gateway/src/infrastructure/provider/session.ts:567-577`

**Rate/circuit статус.** Нормативные docs требуют bounded pools/quotas и rate/circuit ownership Gateway. В inspected implementation есть bounded Undici connections, provider-degraded readiness и typed telemetry, а также специальный bounded cart safe-read retry; отдельного публичного generic rate-limiter или самостоятельного circuit-breaker класса в `apps/aroma-gateway/src` не найдено. Поэтому rate/circuit следует считать частично реализованным transport/readiness guard, не доказанным полным policy runtime. `docs/CoffeeOrderSystem_CANONICAL_Architecture_EndToEndHardened_RU_2026-08-19/M11_AROMA_GATEWAY/02_AROMA_GATEWAY_PROVIDER_CONTRACT.md:46-56`; `apps/aroma-gateway/src/infrastructure/provider/http-client.ts:141-166`; `apps/aroma-gateway/src/infrastructure/provider/session.ts:314-317`; `apps/aroma-gateway/src/infrastructure/observability.ts:3-21`

## 5. Catalog export: pagination, identity, grind, packing, pricing, promotions

### 5.1 Пагинация и полнота

Catalog source читает страницы последовательно, держит одну decoded page, не запрашивает следующую до продвижения consumer и закрывает iterator при cancellation. Первая страница задаёт `lastPage`, `perPage`, `total`; следующие обязаны совпасть по metadata, иметь правильный `currentPage`, не быть пустыми до последней страницы и не превышать `perPage`. Завершение требует `productCount === total`; incomplete/suspicious stream должен fail closed. `apps/aroma-gateway/src/application/provider-catalog-source.ts:87-105`; `apps/aroma-gateway/src/application/provider-catalog-source.ts:172-226`; `docs/launch/27_AROMA_PROVIDER_PROTOCOL.md:69-80`

В production wiring page size равен 10. На first grounded offer Gateway лениво получает bounded grind directory, нормализует его в display name + opaque HMAC hash и передаёт только hash/display name в catalog item; raw grind ID остаётся внутренним для provider call. `apps/aroma-gateway/src/main.ts:98-113`; `apps/aroma-gateway/src/application/provider-catalog-source.ts:184-215`; `apps/aroma-gateway/src/application/provider-grinds.ts:29-72`

### 5.2 Source identity и semantic hash

`hmac-sha256-v1` фреймит `scheme\0supplierRef\0entityType\0NFC(rawProviderIdentifier)` и выдаёт ровно 64 hex. Домены `product`, `variant`, `offer`, `grind` разделены; helper не создаёт provider/Catalog ID. В нормализаторе AROMA не имеет отдельного provider variant ID: offer ID используется как source-variant key, но HMAC domain для variant и offer остаётся разным. `apps/aroma-gateway/src/domain/source-identity.ts:4-27`; `apps/aroma-gateway/src/domain/source-identity.ts:107-150`; `apps/aroma-gateway/src/application/provider-catalog-source.ts:132-142`; `tests/aroma/source-identity.test.mjs:39-80`

Binding request требует `supplierRef`, `snapshotRef`, `sourceIdentityScheme=hmac-sha256-v1` и `sourceOfferKeyHash`; raw provider offer IDs не входят в public internal DTO. Cart binding разрешается по offerRef и дополнительно проверяется полной provider identity. `contracts/openapi/internal-v1.yaml:704-733`; `apps/aroma-gateway/src/application/cart-reader.ts:10-28`; `apps/aroma-gateway/src/infrastructure/database/offer-binding-store.ts:1-60`

### 5.3 Pack/grind/quantity policy

**Фактическое ограничение mutation.** Wire-контракт допускает decimal quantity, но текущий handler отклоняет любую строку `quantity` с точкой до reserve/provider dispatch (`apps/aroma-gateway/src/transport/http/index.ts:167-175`). Целая строка затем передаётся полем `quantityMilli`; само имя не доказывает conversion ×1000. Поэтому поддержка дробного количества и согласование с planned Orders `quantity_milli` не считаются доказанными. Это намеренный fail-closed путь текущего кода, а не утверждение о всех единицах AROMA.

Decoder сохраняет provider offer `params` (в observed shape — `weight` и `is_grinded`), `packing` и `grind_id` для cart lines, но не делает из `weight` автоматически граммы/килограммы. Нормализатор платформы принимает owner policy: quantity — packages/pieces, unit — `piece`; `weight` описывает package и не меняет unit или price basis. Для `is_grinded=1` должны быть разрешённые grind options; для `0` grind не добавляется. Это безопасная локальная policy, а не доказанный универсальный provider contract. `apps/aroma-gateway/src/infrastructure/provider/decoder.ts:9-19`; `apps/aroma-gateway/src/infrastructure/provider/decoder.ts:269-329`; `apps/aroma-gateway/src/application/provider-catalog-source.ts:119-169`; `evidence/aroma-provider/2026-09-18-read-only-unit-identity-observations.json:66-101`

### 5.4 Money и promotions

Provider price проходит decimal normalization с точностью до двух знаков в minor units; output фиксирует `currency: RUB`. Discount должен быть положительным, иметь non-negative `min_weight` и RFC3339 timestamps; normalized promotion содержит basis points, minimum weight и timestamps, но не provider discount ID. Нулевая supplier price при otherwise available offer переводится в `Unavailable`. `apps/aroma-gateway/src/application/provider-catalog-source.ts:33-83`; `apps/aroma-gateway/src/application/provider-catalog-source.ts:153-169`; `apps/aroma-gateway/src/infrastructure/provider/decoder.ts:296-312`

Это не provider proof универсальных currency, scale и discount rules: historical captures не разрешают вывод quantity bounds, packing/grind mapping или production DB acceptance. `evidence/aroma-provider/2026-09-12/README.md:31-45`; `evidence/aroma-provider/2026-09-12-cart-mutations/README.md:33-52`; `evidence/aroma-provider/README.md:1-7`

## 6. Cart snapshot: safe read, completeness и redacted DTO

Gateway читает только полный cart response. Decoder различает empty/non-empty, требует `products`, `prices`, totals и проверяет уникальность cart-line IDs и полной identity `(offerId, packing, grindId)`; malformed/partial body не превращается в empty. `providerSnapshotRef` — Gateway reference `aroma-gateway:cart-body-sha256:<sha256>`; это не provider field. Normalized cart наружу отдаёт cart scope, reference, capturedAt, fingerprint и sanitized lines, не cookies, raw provider IDs, raw body или provider error text. `apps/aroma-gateway/src/infrastructure/provider/decoder.ts:9-35`; `apps/aroma-gateway/src/infrastructure/provider/decoder.ts:204-266`; `apps/aroma-gateway/src/application/cart-reader.ts:65-90`; `docs/launch/04_AROMA_CART_SAFETY.md:28-32`

Safe read route принимает только `aroma-observer` и `aroma-convergence`, использует `POST .../cart-snapshots:read`, schema-validates request/response и отвечает 503 при typed provider failure или invalid downstream DTO. Tests дополнительно запрещают spoofed headers, foreign transport identity и произвольный client actor header. `apps/aroma-gateway/src/transport/http/index.ts:127-154`; `tests/aroma/api-internal-operations.test.mjs:44-84`; `tests/aroma/safe-read-http.test.mjs:44-98`

## 7. Guarded mutation: один dispatch, journal и unknown outcome

Unsafe mutation начинается не с provider call. Gateway normalizes request, проверяет signed delegation, резервирует durable `operationRef`, затем делает safe preparation: resolve binding, resolve opaque grind hash, acquire session и fresh cart GET. Только после `markDispatched` CAS выполняется unsafe provider call; результат обязан пройти typed response validation. Ошибка после dispatch или invalid response переводит row в `UnknownOutcome`; provider mutation повторно не отправляется. `apps/aroma-gateway/src/domain/mutation-journal.ts:421-455`; `apps/aroma-gateway/src/application/provider-cart-mutator.ts:69-104`; `apps/aroma-gateway/src/application/provider-cart-mutator.ts:55-67`

Journal хранит request hash, caller/delegation identity, operation kind, offer, optional `sourceGrindKeyHash`, lease owner/until, state и typed Gateway response bytes. `Acknowledged`/`Rejected` имеют terminal retention минимум 90 дней; `UnknownOutcome` не содержит provider body. Same `operationRef` с другим hash/caller/grind — conflict; acknowledged/rejected replay отдаётся без HTTP; active reservation возвращает in-progress; unknown возвращает conflict-like safe error. `apps/aroma-gateway/migrations/0002_provider_mutation_journal.sql:3-72`; `docs/launch/22_AROMA_GATEWAY_OPERATION_JOURNAL.md:23-84`

Gateway-level journal idempotency не равна business retry. Business decision, Desired revision, fresh reconciliation и выбор следующей mutation принадлежат Orders convergence. После timeout/connection loss следующий attempt обязан сделать fresh GET и создать новую reservation; Kafka/replay не даёт права повторить старый dispatch. `docs/launch/22_AROMA_GATEWAY_OPERATION_JOURNAL.md:67-84`; `docs/launch/04_AROMA_CART_SAFETY.md:34-59`

## 8. Verification status

| Область | Статус на HEAD | Как читать результат |
|---|---|---|
| Gateway routes, typed provider transport, session, decode, redaction | **код реализации и файлы тестов существуют** | Тесты прочитаны, но не запускались заново; provider network не вызывался |
| Catalog pagination/source identity/promotions | **реальная Gateway implementation** | Implemented normalizer; completeness/persistence semantics still require owner integration |
| Cart safe read | **реальная Gateway implementation** | Complete-read and fail-closed guards present |
| Cart mutation journal | **реальная Gateway implementation** | Durable integration journal and one-dispatch executor present |
| Orders lease/fence/Desired/Observed/Attempt | **specification/scaffold only in inspected apps** | Do not claim implemented convergence |
| Evidence dated 2026-09-12/14/18 | **historical execution** | Useful provenance, not fresh acceptance and not permission to probe |

В этой заметке provider probes намеренно не запускались; credentials/session values и реальные customer/vendor data не переносились.

## Источники

| Источник | Назначение |
|---|---|
| [AGENTS.md](../../AGENTS.md) | authority package, canonical docs, ADR boundary |
| [04_AROMA_CART_SAFETY.md](../../docs/launch/04_AROMA_CART_SAFETY.md) | ownership, safe mutation protocol, redaction |
| [19_AROMA_CONVERGENCE_IMPLEMENTATION_SPEC.md](../../docs/launch/19_AROMA_CONVERGENCE_IMPLEMENTATION_SPEC.md) | journal and replay semantics |
| [22_AROMA_GATEWAY_OPERATION_JOURNAL.md](../../docs/launch/22_AROMA_GATEWAY_OPERATION_JOURNAL.md) | operation states, reservations, unknown outcome |
| [27_AROMA_PROVIDER_PROTOCOL.md](../../docs/launch/27_AROMA_PROVIDER_PROTOCOL.md) | provider catalog/availability/pagination policy |
| [M11 provider contract](../../docs/CoffeeOrderSystem_CANONICAL_Architecture_EndToEndHardened_RU_2026-08-19/M11_AROMA_GATEWAY/02_AROMA_GATEWAY_PROVIDER_CONTRACT.md) | capability boundary |
| [M20 interaction authority](../../docs/CoffeeOrderSystem_CANONICAL_Architecture_ContractClosure_RU_2026-08-22/M20_SERVICE_ORCHESTRATION/RUNTIME_AND_INTERACTION_AUTHORITY.md) | service interaction authority |
| [Gateway source](../../apps/aroma-gateway/src) | actual implementation |
| [AROMA contract package](../../packages/contracts/aroma-v1/src/index.ts) | runtime schema boundary |
| [AROMA tests](../../tests/aroma) | local verification corpus |
| [Historical evidence](../../evidence/aroma-provider) | recorded past probes, not fresh validation |


Машиночитаемые каталоги и общий manifest источников: [11_Источники и проверка](11_%D0%98%D1%81%D1%82%D0%BE%D1%87%D0%BD%D0%B8%D0%BA%D0%B8%20%D0%B8%20%D0%BF%D1%80%D0%BE%D0%B2%D0%B5%D1%80%D0%BA%D0%B0.md).
