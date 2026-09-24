---
type: architecture
project: CoffeeOrderPlatform
status: reference
verified: 2026-09-22
source: "Канонические инварианты, launch-спецификация и исходники; локальная зона +05"
source_commit: 4b2cad1dab30af66ad0b2fe64da280222e506574
sources:
  - docs/launch/04_AROMA_CART_SAFETY.md
  - docs/launch/19_AROMA_CONVERGENCE_IMPLEMENTATION_SPEC.md
  - docs/launch/22_AROMA_GATEWAY_OPERATION_JOURNAL.md
  - docs/CoffeeOrderSystem_CANONICAL_Architecture_EndToEndHardened_RU_2026-08-19/M11_AROMA_GATEWAY/03_AUTHORITATIVE_CART_DESIRED_OBSERVED_CONVERGENCE.md
  - docs/CoffeeOrderSystem_CANONICAL_Architecture_EndToEndHardened_RU_2026-08-19/M12_ORDERS/01_ORDERS_MIGRATION_AND_INVARIANTS.md
  - docs/CoffeeOrderSystem_CANONICAL_Architecture_EndToEndHardened_RU_2026-08-19/M12_ORDERS/02_ORDER_LIFECYCLE_STATE_MACHINE.md
  - docs/CoffeeOrderSystem_CANONICAL_Architecture_EndToEndHardened_RU_2026-08-19/M07_CUSTOMER_CATALOG/05_AROMA_MAPPING_LIFECYCLE.md
  - docs/CoffeeOrderSystem_CANONICAL_Architecture_EndToEndHardened_RU_2026-08-19/M07_CUSTOMER_CATALOG/07_CATALOG_TO_ORDERS_AROMA_CART_REACTION.md
  - docs/CoffeeOrderSystem_CANONICAL_Architecture_ContractClosure_RU_2026-08-22/M20_SERVICE_ORCHESTRATION/service-interaction-policy.closure.json
  - apps/aroma-gateway
  - apps/aroma-observer
  - apps/aroma-convergence
  - apps/orders-aroma-preparation
  - packages/contracts/aroma-v1
  - contracts/schemas/events
  - tests/aroma
  - evidence/aroma-provider
---

# 08_AROMA сходимость

[Проекты/CoffeeOrderPlatform/Архитектура/00_Атлас архитектуры](README.md)

> **Главное правило.** `Desired` — бизнес-намерение, `Observed` — последний успешный полный fresh GET, `Convergence` — процесс их сведения. Kafka и provider response без GET не physical proof. `docs/CoffeeOrderSystem_CANONICAL_Architecture_EndToEndHardened_RU_2026-08-19/M11_AROMA_GATEWAY/03_AUTHORITATIVE_CART_DESIRED_OBSERVED_CONVERGENCE.md:3-11`; `docs/CoffeeOrderSystem_CANONICAL_Architecture_EndToEndHardened_RU_2026-08-19/M12_ORDERS/01_ORDERS_MIGRATION_AND_INVARIANTS.md:72-90`

## 1. Статус реализации: не смешивать Gateway и Orders convergence

| Слой | Что найдено на HEAD | Вывод |
|---|---|---|
| **AROMA Gateway** | Реальные typed routes, provider transport/session, complete catalog source, cart decoder/reader, binding store и durable provider mutation journal | Можно описывать как существующую техническую implementation boundary |
| **`aroma-observer`** | Только `startConfiguredRuntime("aroma-observer")` | Runtime scaffold; durable observer/projection не доказан |
| **`aroma-convergence`** | Только `startConfiguredRuntime("aroma-convergence")` | Orders-owned convergence не материализована в inspected source |
| **`orders-aroma-preparation`** | Только `startConfiguredRuntime("orders-aroma-preparation")` | Preparation workload scaffold, не semantic Orders state machine |
| **Contracts/events** | JSON Schema для wake/request, observation and convergence facts | Wire contract/reference, не evidence обработки |
| **Historical evidence** | Dated provider probes 12/14/18 September | Recorded past execution; не fresh validation, не acceptance |

Такое разделение обязательно: launch migration A1 переносит только provider protocol, а A2 отдельно переносит Desired/revisions, Observed/snapshots, Convergence, Attempt, Lease/FencingToken и UnknownOutcome в Orders ownership. `docs/CoffeeOrderSystem_CANONICAL_Architecture_EndToEndHardened_RU_2026-08-19/M11_AROMA_GATEWAY/01_AROMA_MIGRATION_AND_SAFETY.md:3-37`

## 2. Desired: откуда берётся target

> **Каноническая модель и первый запуск — разные уровни.** Ниже понятия `ProfileName`, `DesiredKeyVersion`, `cartKeyHash` и канонические состояния объясняют исходные бизнес-инварианты; они не являются именами materialized launch-таблиц или точным wire-контрактом. Первый запуск специфицирует один `cartScopeRef="aroma-primary"`, Desired/Observed lines с ключом `(cart_scope_ref, revision, offer_ref)`, lease на весь cart scope и собственный enum Attempt. Confirm пишет immutable contribution; `orders-aroma-preparation` строит cart-level Desired после commit. В launch при изменении mapping Confirmed Order **не remap-ится автоматически**: другой offer блокируется кодом `MAPPING_CHANGED`, требуя нового Draft/quote либо будущей явной replacement-команды. Источник: `docs/launch/19_AROMA_CONVERGENCE_IMPLEMENTATION_SPEC.md:6-16,51-94,106-123`.

### 2.1 Source, axes и contribution

Orders хранит одну Desired source на `(ProfileName, OrderRef, OrderItemRef)`. Источник содержит immutable product snapshot и независимые оси `Contribution`, `Approval`, `Resolution`, `Fulfillment`. Положительная contribution существует только при `Included`, `Approval ∈ {NotRequired, Approved}`, `Resolution=Ready` и active-cart-eligible fulfillment. `Confirmed` Order не означает, что cart уже синхронизирован. `docs/CoffeeOrderSystem_CANONICAL_Architecture_EndToEndHardened_RU_2026-08-19/M11_AROMA_GATEWAY/03_AUTHORITATIVE_CART_DESIRED_OBSERVED_CONVERGENCE.md:13-37`; `docs/CoffeeOrderSystem_CANONICAL_Architecture_EndToEndHardened_RU_2026-08-19/M12_ORDERS/02_ORDER_LIFECYCLE_STATE_MACHINE.md:13-21`

Business lifecycle и supplier/cart state независимы. Нельзя переводить Order обратно в Draft из-за provider timeout, Catalog stop или `UnknownOutcome`; Orders может быть `Confirmed`, пока AROMA `Pending`, `Blocked` или `UnknownOutcome`. Cancellation — explicit guarded command, который удаляет/excludes Desired source через revision service, а physical cleanup происходит после commit через convergence. `docs/CoffeeOrderSystem_CANONICAL_Architecture_EndToEndHardened_RU_2026-08-19/M12_ORDERS/01_ORDERS_MIGRATION_AND_INVARIANTS.md:33-43`; `docs/CoffeeOrderSystem_CANONICAL_Architecture_EndToEndHardened_RU_2026-08-19/M12_ORDERS/02_ORDER_LIFECYCLE_STATE_MACHINE.md:51-63`

### 2.2 Semantic cart key и source hash

Физическая единица сведения — `ProfileName + hash(offerId, canonicalGrind, canonicalPacking)`. Target quantity равен сумме всех contributing Desired sources этого key, а не сумме по OrderId. Semantic revisions разделены: `DesiredRevision` — snapshot профиля, `DesiredKeyVersion` — версия конкретного cart key; audit text/time не должны менять semantic revision. Operation identity включает profile, cart key hash, desired key version, drift generation и target. `docs/CoffeeOrderSystem_CANONICAL_Architecture_EndToEndHardened_RU_2026-08-19/M11_AROMA_GATEWAY/03_AUTHORITATIVE_CART_DESIRED_OBSERVED_CONVERGENCE.md:39-54`; `docs/CoffeeOrderSystem_CANONICAL_Architecture_EndToEndHardened_RU_2026-08-19/M11_AROMA_GATEWAY/03_AUTHORITATIVE_CART_DESIRED_OBSERVED_CONVERGENCE.md:67-84`

Catalog source identity — не provider ID в Orders. Gateway вычисляет HMAC proof для product/variant/offer/grind, а Catalog по спецификации хранит opaque hashes, snapshot provenance и approved mapping. Provider offer ID используется как source-variant key из-за отсутствия отдельного provider variant ID, но domain-separated HMAC разделяет variant и offer. Каноническая модель описывает remap `A → B` как изменение обоих key с сохранением старого для cleanup. **Это не поведение Confirmed Order первого запуска:** launch сохраняет frozen offer и выставляет blocker, а автоматический remap запрещает. Источники: `apps/aroma-gateway/src/domain/source-identity.ts:107-150`; `apps/aroma-gateway/src/application/provider-catalog-source.ts:132-142`; `docs/CoffeeOrderSystem_CANONICAL_Architecture_EndToEndHardened_RU_2026-08-19/M07_CUSTOMER_CATALOG/05_AROMA_MAPPING_LIFECYCLE.md:104-129`; `docs/launch/19_AROMA_CONVERGENCE_IMPLEMENTATION_SPEC.md:106-123`.

### 2.3 Catalog proof перед положительной mutation

`target > 0` не разрешает mutation само по себе. Convergence получает один read-only Catalog proof: latest complete successful supplier snapshot, `snapshotRef`, `observedAtUtc`, freshness threshold, exact mappings and availability facts. Stale/unavailable/missing/manual-review proof fail closed до cart GET; mapping changed supersedes planned target; stopped product даёт target 0. Per-item provider catalog lookup запрещён. `docs/CoffeeOrderSystem_CANONICAL_Architecture_EndToEndHardened_RU_2026-08-19/M07_CUSTOMER_CATALOG/07_CATALOG_TO_ORDERS_AROMA_CART_REACTION.md:119-142`; `docs/CoffeeOrderSystem_CANONICAL_Architecture_EndToEndHardened_RU_2026-08-19/M11_AROMA_GATEWAY/03_AUTHORITATIVE_CART_DESIRED_OBSERVED_CONVERGENCE.md:132-145`

## 3. Observed: что считается доказательством

Observed обновляется только успешным полным fresh GET: snapshot, physical items, absence as quantity 0, freshness/generation. Failed или partial GET никогда не очищает старое Observed и никогда не создаёт новый empty-cart fact. Gateway decoder именно поэтому проверяет полный cart shape, totals, prices, line uniqueness and full identity `(offer, packing, grind)`. `docs/CoffeeOrderSystem_CANONICAL_Architecture_EndToEndHardened_RU_2026-08-19/M11_AROMA_GATEWAY/03_AUTHORITATIVE_CART_DESIRED_OBSERVED_CONVERGENCE.md:56-65`; `apps/aroma-gateway/src/infrastructure/provider/decoder.ts:204-266`; `tests/aroma/provider-decoder.test.mjs:13-42`

Provider snapshot reference и semantic fingerprint различаются. `providerSnapshotRef` — Gateway-generated reference из SHA-256 полного raw body; `cartFingerprint` — contract hash normalized cart. Raw body/cookies/provider IDs не выходят в DTO. Это даёт два разных вопроса: «какой полный body был прочитан Gateway» и «какая нормализованная cart shape наблюдалась». `docs/launch/04_AROMA_CART_SAFETY.md:28-32`; `contracts/openapi/internal-v1.yaml:924-945`; `apps/aroma-gateway/src/application/cart-reader.ts:65-90`

## 4. Lease, fence и operation journal

### 4.1 Orders lease/fence

Одна durable convergence row существует на `(profile, cartKeyHash)` и хранит target, semantic version, observed, drift, retry, lease и fence. Attempt append-only имеет состояния `Leased → Mutating → Verified`, а также `Failed`, `UnknownOutcome`, `Superseded`. Stale worker может иметь in-flight HTTP request, но не может commit terminal state: final fence check требуется перед request, а terminal write требует current fencing token. `docs/CoffeeOrderSystem_CANONICAL_Architecture_EndToEndHardened_RU_2026-08-19/M11_AROMA_GATEWAY/03_AUTHORITATIVE_CART_DESIRED_OBSERVED_CONVERGENCE.md:67-88`

Lease/fence выбирают owner и делают старого worker бессильным после takeover; любая запись Orders state требует current fence. Это нормативное требование, а inspected `aroma-convergence` source его пока не материализует. `docs/launch/04_AROMA_CART_SAFETY.md:34-59`; `apps/aroma-convergence/src/main.ts:1-3`

### 4.2 Gateway journal

Gateway journal — отдельная техническая идемпотентность provider dispatch, не Orders business attempt. Row хранит `operationRef`, cart scope, `SetLineQuantity|RemoveLine`, offer, optional `sourceGrindKeyHash`, canonical request hash, signed caller/delegation metadata, reservation owner/lease, state и typed Gateway response. Terminal response retention — не менее 90 дней; provider body, cookies, credentials и full cart не сохраняются. Источники: `docs/launch/22_AROMA_GATEWAY_OPERATION_JOURNAL.md:7-45,79-84`; `apps/aroma-gateway/migrations/0002_provider_mutation_journal.sql:3-72`; `apps/aroma-gateway/migrations/0007_provider_mutation_grind.sql:1-3`.

`Reserved → Dispatched` выполняется CAS в короткой DB transaction перед unsafe HTTP. `Acknowledged` и `Rejected` сохраняют только валидированный typed internal response; invalid JSON/fields/status получают `AROMA_PROVIDER_INVALID_RESPONSE` и становятся `UnknownOutcome`. Если commit reserve/terminal persistence даёт `TRANSACTION_OUTCOME_UNKNOWN`, выполняется один bounded reread той же row; provider dispatch повторно не выполняется. Источники: `docs/launch/22_AROMA_GATEWAY_OPERATION_JOURNAL.md:43-65`; `apps/aroma-gateway/src/infrastructure/database/provider-mutation-journal.ts:342-352,433-464`.

### 4.3 Два уровня operation identity

1. **Каноническая Orders semantic identity:** profile + cart key + DesiredKeyVersion + drift generation + target. Она объясняет исходное требование; launch вместо её буквального переноса использует cart-scope Attempt/Desired revision и unique reservation на Attempt по `docs/launch/19_AROMA_CONVERGENCE_IMPLEMENTATION_SPEC.md:79-94`.
2. **Gateway transport identity:** `operationRef` + canonical request hash + caller/delegation + optional grind hash. Она защищает один unsafe provider dispatch.

Один и тот же `operationRef` с другим offer/quantity/grind/caller — `AROMA_OPERATION_REF_CONFLICT`; same hash terminal replay возвращает сохранённый typed result без provider HTTP; `UnknownOutcome` не replay-ится. Следующий Orders Attempt должен быть новой semantic reconciliation, а не повтором старого transport operation. `docs/launch/22_AROMA_GATEWAY_OPERATION_JOURNAL.md:37-45`; `docs/launch/22_AROMA_GATEWAY_OPERATION_JOURNAL.md:67-84`

## 5. Нормальная последовательность сведения

Нормальный путь не пытается «дожать» provider одним POST. Он повторно проверяет локальные authority и physical truth на каждой опасной границе. `docs/launch/04_AROMA_CART_SAFETY.md:34-47`

```mermaid
sequenceDiagram
    participant O as Orders convergence
    participant C as Catalog persisted proof
    participant G as AROMA Gateway
    participant P as AROMA provider
    participant D as Orders DB

    O->>D: acquire lease + monotonic fence
    O->>D: read current DesiredRevision/KeyVersion/target
    O->>C: one safe complete-snapshot preflight
    C-->>O: valid mapping/availability proof
    O->>G: POST cart-snapshots:read
    G->>P: GET /api/v1/cart/
    P-->>G: complete cart body
    G-->>O: sanitized snapshot + fingerprint
    O->>D: persist Observed with current fence
    alt target == observed
        O->>D: Attempt=NoOpInSync / VerifiedInSync
    else deterministic drift
        O->>D: reserve one semantic Attempt
        O->>G: POST cart-lines/{offerRef}:set-quantity or :remove
        G->>G: reserve operationRef; CAS Reserved→Dispatched
        G->>P: exactly one POST/PUT/DELETE
        P-->>G: typed response
        G-->>O: Acknowledged or Rejected
        O->>G: POST cart-snapshots:read
        G->>P: fresh GET /api/v1/cart/
        P-->>G: complete cart body
        G-->>O: verified snapshot
        O->>D: persist Observed/Attempt/Convergence with fence
    end
```

Даже `Acknowledged` не означает физическую истину: только второй fresh GET может перевести Observed и convergence в verified state. Если target стал obsolete между preflight и dispatch, final fence/version gate должен остановить request; Kafka hint не заменяет перечитывание Orders state. `docs/CoffeeOrderSystem_CANONICAL_Architecture_EndToEndHardened_RU_2026-08-19/M11_AROMA_GATEWAY/03_AUTHORITATIVE_CART_DESIRED_OBSERVED_CONVERGENCE.md:86-94`; `docs/CoffeeOrderSystem_CANONICAL_Architecture_EndToEndHardened_RU_2026-08-19/M12_ORDERS/01_ORDERS_MIGRATION_AND_INVARIANTS.md:84-90`

## 6. Неопределённый исход: timeout, потерянный ответ и неизвестный COMMIT

Ambiguous failure имеет минимум три варианта: provider применил mutation и потерял ответ; не применил; DB commit результата неизвестен. Все три классифицируются fail-closed как `UnknownOutcome`, пока новый fresh GET не установит physical truth. Ни при каких обстоятельствах нельзя blind retry старого operationRef или сразу отправить обратную mutation. `docs/launch/04_AROMA_CART_SAFETY.md:49-59`; `docs/launch/22_AROMA_GATEWAY_OPERATION_JOURNAL.md:54-84`

```mermaid
sequenceDiagram
    participant O as Orders convergence
    participant G as Gateway + journal
    participant P as Provider
    participant D as Orders DB

    O->>G: mutation with new operationRef
    G->>G: Reserved→Dispatched CAS
    G->>P: one unsafe request
    P--xG: timeout / connection loss / invalid response
    G->>G: Dispatched→UnknownOutcome
    G-->>O: 409 AROMA_OPERATION_UNKNOWN_OUTCOME
    O->>D: Attempt=UnknownOutcome; preserve old Observed
    Note over O,D: no blind retry; Kafka remains wake/version hint only
    O->>G: later fresh cart snapshot read
    G->>P: GET /api/v1/cart/
    P-->>G: complete snapshot or read failure
    alt complete GET proves target
        G-->>O: observed equals desired
        O->>D: VerifiedInSync with current fence
    else complete GET proves old/other state
        G-->>O: observed drift
        O->>D: reserve a NEW Attempt and NEW operationRef
        O->>G: at most one next mutation after all gates
    else GET fails or partial
        G-->>O: safe read failure
        O->>D: keep Observed; remain UnknownOutcome/Blocked
    end
```

После потерянного ответа mutation transport не повторяется. Повторная аутентификация допустима только для отдельного safe read до выдачи байтов, а не для replay mutation. Если исход reserve или terminal DB COMMIT неизвестен, Gateway ограниченно перечитывает row по тому же `operationRef`, сверяет полный request hash/delegation и возвращает safe `UnknownOutcome`, если durable proof не найден. Источники: `docs/launch/22_AROMA_GATEWAY_OPERATION_JOURNAL.md:17-21,54-65`; `apps/aroma-gateway/src/infrastructure/provider/session.ts:242-312`.

## 7. Wake events, deadlines, rate/circuit и no blind retry

### Wake events

`AromaConvergenceRequested.v1` несёт `cartScopeRef`, `desiredRevision`, reason (`OrderConfirmed`, `CatalogChanged`, `OperatorRequested`, `Recovery`) и optional orderRef. Это durable request/hint, не mutation plan: consumer обязан перечитать current Orders state. `AromaObservationChanged.v1` разрешён только для `Complete` observation и fingerprint; `AromaConvergenceChanged.v1` сообщает attempt outcome (`NoOpInSync`, `VerifiedInSync`, `OutOfSync`, `Blocked`, `UnknownOutcome`, `Failed`). `contracts/schemas/events/aroma-convergence-requested.v1.schema.json:1-32`; `contracts/schemas/events/aroma-observation-changed.v1.schema.json:1-28`; `contracts/schemas/events/aroma-convergence-changed.v1.schema.json:1-38`

Duplicate/out-of-order/replay events не могут подменить Desired revision, target or Catalog proof. Catalog publishes facts; Orders decides whether the fact changes Desired; only Orders convergence mutates physical cart. `docs/CoffeeOrderSystem_CANONICAL_Architecture_EndToEndHardened_RU_2026-08-19/M07_CUSTOMER_CATALOG/07_CATALOG_TO_ORDERS_AROMA_CART_REACTION.md:3-21`; `docs/CoffeeOrderSystem_CANONICAL_Architecture_EndToEndHardened_RU_2026-08-19/M07_CUSTOMER_CATALOG/07_CATALOG_TO_ORDERS_AROMA_CART_REACTION.md:154-164`

### Deadlines

Route deadlines и provider timeout ограничивают одну попытку; они не являются разрешением на retry. Runtime deadline должен abort-ить request, а journal/Attempt должен записать typed failure or unknown. Долгая recovery — durable state, не удержание HTTP request. Safe-read retry ограничен pre-body cart-read path; mutation business retry остаётся Orders. `apps/aroma-gateway/src/transport/http/index.ts:121-150`; `apps/aroma-gateway/src/infrastructure/provider/http-client.ts:100-105`; `apps/aroma-gateway/src/infrastructure/provider/http-client.ts:489-521`; `docs/launch/04_AROMA_CART_SAFETY.md:49-59`

### Rate/circuit

Gateway должен быть choke point для provider concurrency. На HEAD видны bounded connections, degraded readiness и telemetry; explicit standalone rate limiter/circuit breaker не найден. Точные thresholds/backoff остаются acceptance item. `docs/CoffeeOrderSystem_CANONICAL_Architecture_EndToEndHardened_RU_2026-08-19/M11_AROMA_GATEWAY/02_AROMA_GATEWAY_PROVIDER_CONTRACT.md:46-56`; `apps/aroma-gateway/src/main.ts:59-70`; `apps/aroma-gateway/src/infrastructure/provider/session.ts:314-317`

### No blind retry

- GET может иметь bounded transport retry до выдачи body; cart-only retry не распространяется на catalog/user/mutation. `apps/aroma-gateway/src/infrastructure/provider/http-client.ts:489-521`; `tests/aroma/provider-http.test.mjs:237-266`
- Unsafe POST/PUT/DELETE generic retry запрещён; `422` имеет unknown effect и не является автоматически безопасным no-op. `tests/aroma/provider-decoder.test.mjs:87-94`; `tests/aroma/provider-http.test.mjs:544-556`
- После timeout/partial output/invalid response — `UnknownOutcome`, fresh GET first. `docs/launch/22_AROMA_GATEWAY_OPERATION_JOURNAL.md:43-84`
- Failed GET не очищает Observed. `docs/launch/04_AROMA_CART_SAFETY.md:52-59`

## 8. Матрица ответственности

| Решение | Единственный владелец | Gateway может помочь | Что не должно происходить |
|---|---|---|---|
| Product/offer/grind identity | Catalog + Gateway source boundary | HMAC/source proof, typed export | Orders не угадывает raw IDs |
| Desired target/revision | Orders | ничего не вычисляет за Orders | Gateway не принимает `orderId` command |
| Observed physical truth | Orders projection from Gateway complete GET | decode, fingerprint, redacted DTO | Kafka/POST response как truth |
| Lease/fence | Orders | Gateway journal reservation only | stale worker terminal write |
| Provider operationRef | Gateway journal | hash/delegation/one dispatch | Orders DB read from Gateway |
| Business retry/reconciliation | Orders convergence | typed UnknownOutcome and fresh read | blind replay |
| Credentials/session/login | Gateway | encrypted storage, single-flight, reauth safe-read | Browser/Hermes/Orders credentials |
| Provider rate/circuit | Gateway boundary | bounded transport/readiness | worker fan-out напрямую |
| Catalog availability proof | Catalog persisted snapshot | safe export/binding | per-item live provider lookup |
| Wake event | Owner Outbox producer + Orders consumer | event transport | event payload as mutation plan; CDC не заявлен как реализованный launch-путь |

M12 сохраняет Orders как владельца `orders.*`, включая Desired/Observed/Convergence/Attempt/Lease/Fencing и checkout proof. Для первого запуска точнее говорить: Confirm фиксирует local Order state + immutable contribution + Outbox; cart-level Desired строит preparation после commit. Confirm не вызывает AROMA. Источники: `docs/launch/19_AROMA_CONVERGENCE_IMPLEMENTATION_SPEC.md:13-16`; `docs/CoffeeOrderSystem_CANONICAL_Architecture_EndToEndHardened_RU_2026-08-19/M12_ORDERS/01_ORDERS_MIGRATION_AND_INVARIANTS.md:21-31,72-90`.

## 9. Существенные расхождения и пробелы приёмки

1. **Orders convergence scaffold.** Gateway primitives не означают, что `aroma-convergence` уже читает Desired, делает Catalog proof, пишет Observed или публикует facts.
2. **Rate/circuit gap.** Bounded connections/readiness есть, explicit thresholds/backoff не найдены.
3. **Provider semantics ограничены.** Historical reports не доказывают quantity bounds, currency/scale, packing/grind mapping, expiry/refresh и post-dispatch guarantees. `evidence/aroma-provider/2026-09-12-cart-mutations/README.md:72-87`; `evidence/aroma-provider/2026-09-18-read-only-unit-identity-observations.json:93-101`
4. **Evidence historical.** Данные 12/14/18 сентября — provenance, не fresh acceptance; provider probes в этой задаче не запускались. `evidence/aroma-provider/README.md:1-13`; `evidence/aroma-provider/2026-09-14-pricing-observations.json:1-6`
5. **Приёмка неопределённых исходов.** Требуется актуальное evidence для lost response, stale fence, lease expiry, restart with Dispatched, partial GET, operationRef conflict и exactly-one provider call. Часть Gateway-тестов существует в репозитории; они не запускались заново в этом аудите и не доказывают ещё не реализованную Orders convergence. `docs/launch/22_AROMA_GATEWAY_OPERATION_JOURNAL.md:86-91`; `docs/launch/04_AROMA_CART_SAFETY.md:52-59`

## 10. Итоговая формула

`Desired revision + current Catalog proof + current lease/fence + fresh complete Observed` разрешают **не более одной** deterministic mutation. Затем нужен fresh verification GET. При любой неопределённости сохраняется последняя доказанная Observed, attempt становится `UnknownOutcome` или `Blocked`, а следующий шаг — новая reconciliation, не blind retry. `docs/launch/04_AROMA_CART_SAFETY.md:34-59`; `docs/CoffeeOrderSystem_CANONICAL_Architecture_EndToEndHardened_RU_2026-08-19/M11_AROMA_GATEWAY/03_AUTHORITATIVE_CART_DESIRED_OBSERVED_CONVERGENCE.md:56-88`

## Источники

| Источник | Назначение |
|---|---|
| [M11 Desired/Observed](../../docs/CoffeeOrderSystem_CANONICAL_Architecture_EndToEndHardened_RU_2026-08-19/M11_AROMA_GATEWAY/03_AUTHORITATIVE_CART_DESIRED_OBSERVED_CONVERGENCE.md) | authoritative cart semantics |
| [M12 invariants](../../docs/CoffeeOrderSystem_CANONICAL_Architecture_EndToEndHardened_RU_2026-08-19/M12_ORDERS/01_ORDERS_MIGRATION_AND_INVARIANTS.md) | Orders ownership and Confirm isolation |
| [M12 lifecycle](../../docs/CoffeeOrderSystem_CANONICAL_Architecture_EndToEndHardened_RU_2026-08-19/M12_ORDERS/02_ORDER_LIFECYCLE_STATE_MACHINE.md) | independent lifecycle states |
| [M07 mapping](../../docs/CoffeeOrderSystem_CANONICAL_Architecture_EndToEndHardened_RU_2026-08-19/M07_CUSTOMER_CATALOG/05_AROMA_MAPPING_LIFECYCLE.md) | remap, mapping and availability |
| [M07 reaction](../../docs/CoffeeOrderSystem_CANONICAL_Architecture_EndToEndHardened_RU_2026-08-19/M07_CUSTOMER_CATALOG/07_CATALOG_TO_ORDERS_AROMA_CART_REACTION.md) | Catalog→Orders→cart reaction |
| [04 safety](../../docs/launch/04_AROMA_CART_SAFETY.md) | fail-closed mutation protocol |
| [19 convergence spec](../../docs/launch/19_AROMA_CONVERGENCE_IMPLEMENTATION_SPEC.md) | migration and protocol target |
| [22 journal](../../docs/launch/22_AROMA_GATEWAY_OPERATION_JOURNAL.md) | durable operation semantics |
| [AROMA event schemas](../../contracts/schemas/events) | wake/observation/convergence wire shapes |
| [Gateway source](../../apps/aroma-gateway/src) | actual implementation boundary |
| [Convergence scaffold](../../apps/aroma-convergence/src/main.ts) | explicit non-implementation evidence |
| [Preparation scaffold](../../apps/orders-aroma-preparation/src/main.ts) | explicit non-implementation evidence |
| [Historical evidence](../../evidence/aroma-provider) | recorded historical execution only |


Машиночитаемые каталоги и общий manifest источников: [11_Источники и проверка](11_%D0%98%D1%81%D1%82%D0%BE%D1%87%D0%BD%D0%B8%D0%BA%D0%B8%20%D0%B8%20%D0%BF%D1%80%D0%BE%D0%B2%D0%B5%D1%80%D0%BA%D0%B0.md).
