# Evidence: аудит реализации issue #11

> Локальный аудит и последующая реализация; окончательная acceptance не объявлена. Источники: `/tmp/coffee-issue-11.json` (live body/comments), `/tmp/coffee-issue11-b-audit.json` (read-only stage B audit), `/tmp/coffee-issue11-checks/status.tsv` и соответствующие логи. Начальный аудит был read-only; последующие проверки и изменения описаны в F evidence и завершающем разделе. До этапа публикации remote writes не выполнялись.

Ниже все 327 checkbox issue, по одному пункту на строку с исходным line ID. Audit B — чтение кода/тестов; его статус сам по себе не означает, что тест прошёл. Результаты из `/tmp` — исторические запуски до последних локальных исправлений и не считаются доказательством текущего рабочего дерева. Текущие статусы таблицы уточнены по F evidence; B registry сохраняет исходные findings для трассировки исправлений.

Решения владельца: для непредставимого `quantityMilli` используется `AROMA_QUANTITY_NOT_SUPPORTED`; Catalog proof делается свежим вызовом Catalog через scoped `api-internal` и fail-closed обработкой невалидного/недоступного ответа. Это supersede-ит прежнее имя blocker в body и неопределённость из B audit.

Текущий результат: запрошенные локальные gates выполнены и проверены.
Final164/165/166: Convergence93/93,capacity76/76,recovery183/183 PASS, без
пропусков; local Attempt439,868–456,387ms<=500. TTL7200000ms утверждён и
проверен. Consumer #9 интегрирован в отдельном managed checkout: contracts,
query/routes/idempotency/accessibility/full browser/bundle gates PASS.
Fresh full-build Compose167 прошёл;168:7 rounds/294mTLS200/17healthy;169:
exact cleanup и15 final exit/OOM states PASS. Readiness классифицирован как
RUNTIME_READINESS_DEADLINE зависимой Kafka-проверки, с временными фазами;
новых Preparation DB failures в capturedlogs нет. Historical096 genericDB
cause и причина двух early Prep die/start остаются неизвестными; ничего не
объявлено исправленным задним числом. Final reviewer не обнаружил нарушения
runtime/recovery-контракта: false/timeout readiness и bounded restart/fail-stop
при отказах допускаются; весь post-protocol health window прошёл.

Реализация подготовлена к публикации ветки и PR в `develop` по разрешению
владельца от 4 октября 2026. Handoff
[`evidence/handoffs/issue-11.yaml`](handoffs/issue-11.yaml) имеет статус
`ready-for-review`: локальные gates PASS, GitHub CI и accepted merge ещё не
подтверждены. Публикация не означает acceptance. Remote checkbox не менялись;
все327 пунктов сопоставлены ниже. UI delta #9 остаётся отдельным delivery.

## Исправление P1 после review PR #171 — 4 октября 2026

Проверки `confirmedAt` и `requestedAt` согласованы с миллисекундной
сериализацией настоящего Orders producer через `date_trunc` сохранённого DB
значения; exact History/version/contribution/Outbox guards сохранены. Regression
на детерминированных DB микросекундах сначала воспроизвёл оба source-invalid
quarantine. Он также выявил несовместимость no-op Card counters; decoder теперь
следует существующему SQL return contract, не принимает snapshot из будущего
и сохраняет равенство при material change.

Текущие проверки: Preparation67/67 и recovery183/183 PASS, без skipped/cancelled;
convergence464,218ms<=500; Preparation1876,574/1944,459ms<=2000. Final lint и
узкий regression PASS после явного ASCII sort comparator в test assertion.
Независимый read-only reviewer не обнаружил существенных замечаний. Исторические
Compose167–169/browser proofs не повторялись после этого fix; current proof —
реальный PostgreSQL и существующие полные business/recovery suites. F57–F59
содержат команды, результаты и границы; это не production acceptance.

## Завершённый план локальных доработок — 4 октября 2026

1. Convergence≤500ms: final164/165/166 PASS с неизменными нагрузкой/guards.
   Historical145892,607ms не воспроизведён157; причина неизвестна,
   speculative performance patch не добавлен.
2. TTL7200000ms задан в reference YAML; отсутствие/невалидность fail-closed,
   config24/Catalogactivation26 PASS. Consumer#9 final integration PASS.
3. Preparation logging содержит stage/code/valid SQLSTATE; readiness logging
   содержит RuntimeError.code. Fresh167–169 завершён; классификация F55,
   диагностические ограничения явно сохранены.
4. Final handoff/source hashes и Obsidian обновлены по фактическим receipts.
   Commit/push/PR разрешены владельцем; после публикации остаются GitHub CI,
   review и accepted merge. Merge требует отдельного разрешения.

## Карта checkbox

`E##` ссылается на реестр evidence ниже.

| Issue line | Критерий | Статус | Evidence |
|---:|---|---|---|
| 30 | Пять прямых predecessors CLOSED через merged PR в `develop`; проверены handoff и 268 несекретных ссылок на выходные артефакты на соответствующих merge-коммитах. Это проверка inputs, не PASS реализации #11. | Предпосылка из issue; не proof реализации | E11 |
| 31 | Выход A: schema/generated/owner/backend proof выбранного помола для интеграции #9; контрактные артефакты и hashes в handoff #11, без объявления полного #11 выполненным. | Локальный handoff с hashes и consumer proof подготовлен; remote acceptance отсутствует | E09; F10; F29/F32 |
| 32 | Выход B: Desired/Observed/Attempt/Lease/Fence/Reservation/projections/recovery и полный `evidence/handoffs/issue-11.yaml` для #12/#13. | Частичный handoff есть; B не принят, capacity/recovery RED | E10; F10 |
| 42 | `CatalogProductSummary.grindOptions` и `CatalogPricingInput.grindOptions` передаются из сохранённых Catalog facts: массив `{sourceGrindKeyHash,displayName}`, без raw ID/нового вызова provider. | Backend contract/owner proof и локальная интеграция consumer #9 проверены; общий gate остаётся RED | E13; F01/F08; F29/F32 |
| 43 | Optional `sourceGrindKeyHash` добавлен в `PricingQuoteCreateLine`, `OrderItemPutRequest`, expected line verify и их строгие schemas. Omission — отсутствие выбора, explicit null/пустая строка недопустимы. | Backend contract/owner proof и локальная интеграция consumer #9 проверены; общий gate остаётся RED | E13; F01/F08; F29/F32 |
| 44 | Pricing проверяет membership выбора в authoritative Catalog input, сохраняет hash+displayName snapshot, включает выбор в quote/internal proof и idempotency; выдаёт `422 PRICING_GRIND_NOT_AVAILABLE` для непредставимого выбора. Формула цены/TTL/rounding не меняются. | Backend contract/owner proof и локальная интеграция consumer #9 проверены; общий gate остаётся RED | E13; F01/F08; F29/F32 |
| 45 | `PricingQuoteLine`, verified line и `OrderItem` возвращают frozen `sourceGrindKeyHash`+`grindDisplayName` при выборе. Orders PUT сверяет exact selected-line proof; Confirm остаётся полностью локальным. | Backend contract/owner proof и локальная интеграция consumer #9 проверены; общий gate остаётся RED | E13; F01/F08; F29/F32 |
| 46 | Forward-only migrations сохраняют optional выбор в Pricing/Orders; старые immutable quote/contribution/Outbox bytes и Completed idempotency snapshots не переписываются. | Backend contract/owner proof и локальная интеграция consumer #9 проверены; общий gate остаётся RED | E13; F01/F08; F29/F32 |
| 47 | Contribution и cart line identity учитывают `(offerRef,sourceGrindKeyHash-or-absence)` при фиксированном packing `Aroma`; `UNIQUE NULLS NOT DISTINCT` исключает дубли absent key. Нельзя создавать синтетические offerRef для помолов. | Backend contract/owner proof и локальная интеграция consumer #9 проверены; общий gate остаётся RED | E13; F01/F08; F29/F32 |
| 48 | Актуализированы request/proof hashes, duplicate-line guards, generated types/runtime validators, response allowlists и tests как единый backend contract change; нет ручных shadow types/second API. | Backend contract/owner proof и локальная интеграция consumer #9 проверены; общий gate остаётся RED | E13; F01/F08; F29/F32 |
| 49 | Выполнены все тесты раздела 7 утверждённого контракта: membership, tamper, multi-grind, absent choice, unchanged old hashes/replay, SQL upgrade и isolation. | Backend contract/owner proof и локальная интеграция consumer #9 проверены; общий gate остаётся RED | E13; F01/F08; F29/F32 |
| 50 | Доказан точный перевод `quantityMilli` в целые упаковки без округления; неподдерживаемое количество сохраняет typed blocker `AROMA_QUANTITY_NOT_REPRESENTABLE`, не частичную небезопасную mutation. | Backend contract/owner proof и локальная интеграция consumer #9 проверены; общий gate остаётся RED | E13; F01/F08; F29/F32 |
| 51 | Передан частичный handoff A для browser consumer #9; он не означает PASS физической сходимости и не закрывает issue. | Локальный handoff A и consumer proof подготовлены; external передача/acceptance отсутствуют | E09; F10; F29/F32 |
| 55 | #11 пишет backend, shared OpenAPI/schemas/generated packages и относящиеся migrations/tests; #9 пишет `apps/web/**` и browser tests. Прямые изменения UI из #11 запрещены. | Scope проверен: UI paths #11 не изменены | E16; F09 |
| 56 | #9 потребляет согласованные поля из generated contracts, не создаёт свою wire-форму. Финальная приёмка выбора помола в UI требует интегрированного handoff A; независимые UI-маршруты можно реализовывать до него. | Локальный consumer compatibility proof PASS; remote acceptance отсутствует | E16; F29/F32 |
| 57 | Корневые manifest/lock/config изменяются только для заявленной части; перед интеграцией сверить с #9. Нельзя копировать целиком чужой manifest/lockfile и переписывать чужую рабочую директорию. | Local three-way integration manifest/lock/generator проверена; исходная #9 директория сохранена | E16; F29/F32 |
| 58 | Backend работа идёт в отдельном worktree `/home/yurgusev/CoffeeOrderPlatform-issue-11`, ветка `feature/11-aroma-convergence`, база `e278aeb10e57d37485542f8668f078456074b038`; основная рабочая директория занята #9. | Предпосылка отмечена в issue | E11 |
| 63 | `OrderReconciliationRequested.v1` принимается через durable Inbox по ADR-0032; `OperatorRequested` создаёт cart-level wake-up даже при прежнем Desired hash, без выдуманных refs/revisions и без потери намерения при недостатке фактов. | Реальный Orders producer, direct Inbox и restart/runOnce recovery PASS после P1 fix; accepted merge отсутствует | E01; F02; F57–F59 |
| 69 | Для одного physical cart действует общий барьер незавершённой MutationReservation, а не только уникальность reservation на Attempt. Новый fence не разрешает следующую mutation при Mutating/UnknownOutcome другой Attempt. Определяющий контракт: [M11 reservation/fencing](https://github.com/YurGusev/CoffeeOrderPlatform/blob/develop/docs/CoffeeOrderSystem_CANONICAL_Architecture_EndToEndHardened_RU_2026-08-19/M11_AROMA_GATEWAY/07_MUTATION_RESERVATION_AND_FENCING.md). | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B02; F01–F07 |
| 71 | Orders владеет всеми business decisions convergence. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B03; F01–F07 |
| 72 | Gateway владеет только provider transport/session/journal. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B03; F01–F07 |
| 73 | Один physical scope `aroma-primary`; convergence «по одному Order» запрещён. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B03; F01–F07 |
| 74 | Все Confirmed Orders текущего scope агрегируются в один Desired. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B03; F01–F07 |
| 75 | Kafka — wake-up/committed facts, не доказательство physical cart. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B03; F01–F07 |
| 76 | Только complete fresh GET создаёт Observed. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B03; F01–F07 |
| 77 | Partial/failed GET никогда не считается пустой корзиной. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B03; F01–F07 |
| 78 | Максимум одна unsafe mutation на Attempt. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B03; F01–F07 |
| 79 | Unsafe mutation automatic retry = 0. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B03; F01–F07 |
| 80 | Старый `operationRef` никогда не отправляется повторно. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B03; F01–F07 |
| 81 | Stale fence не может dispatch mutation или записать terminal success. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B03; F01–F07 |
| 82 | DB lock/transaction не удерживается через HTTP. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B03; F01–F07 |
| 83 | Confirmed frozen offer не remap автоматически. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B03; F01–F07 |
| 84 | Only `orders-aroma-preparation` materializes per-Order AROMA projection/invalidation. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B03; F01–F07 |
| 88 | Сохранить durable next wake-up/dirty state для convergence и next observation schedule в Orders DB; startup sweep и configured periodic schedule поднимают просроченную работу после restart, lease contention, OutOfSync и временного read failure без нового Kafka message. Wake-up coalescing не теряет pending work. In-memory timer только будит обработчик, не является единственным носителем расписания; параметры и limits материализуются в owning config/schema. | PASS164/166: durable restart/sweep/unknown barrier/wake coalescing | B04; F54 |
| 90 | В Orders-owned reservation schema/store сохранять cart identity, reservedUntilUtc и providerDeadlineAtUtc; атомарно проверять общий cart barrier и current fence до резервирования. Перед dispatch обеспечить reservedUntilUtc >= providerDeadlineAtUtc + configured safety margin и leaseExpiresAtUtc >= reservedUntilUtc; продлить окно при недостатке времени. Новый владелец сначала выполняет ReconcileOnly и завершает предыдущую reservation по fresh complete GET, затем получает право создать новую; stale worker не подтверждает успех. | Локальные barrier/fence/crash сценарии PASS; общий gate остаётся RED | E02; F05/F07 |
| 96 | Role `coffee_orders_prepare_rw`. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B06; F01–F07 |
| 97 | Capabilities: Orders contributions, mapping projection, Desired, Inbox, Outbox, per-Order projections. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B06; F01–F07 |
| 98 | Kafka consumers/producers только approved topics. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B06; F01–F07 |
| 99 | HTTP/provider capability отсутствует. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B06; F01–F07 |
| 100 | Единственный projection worker для OrderConfirmed, CatalogMappingChanged, Observation/Convergence facts. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B06; F01–F07 |
| 104 | Role `coffee_orders_observer_rw`. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B06; F01–F07 |
| 105 | Capabilities: durable schedule, Desired read, Observed write, Outbox producer, typed safe cart read. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B06; F01–F07 |
| 106 | Не потребляет `AromaConvergenceRequested`. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B06; F01–F07 |
| 107 | Mutation capability отсутствует. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B06; F01–F07 |
| 108 | Provider credentials/Integration DB отсутствуют. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B06; F01–F07 |
| 112 | Role `coffee_orders_convergence_rw`. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B06; F01–F07 |
| 113 | Capabilities: Desired/Observed/Attempt/Lease/Fence/Reservation/Inbox/Outbox. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B06; F01–F07 |
| 114 | Typed cart read + set/remove через `api-internal`. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B06; F01–F07 |
| 115 | Не получает provider credentials/Integration DB/Catalog DB. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B06; F01–F07 |
| 116 | Mutation authorization только delegated exact operations. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B06; F01–F07 |
| 120 | #11 добавляет единственный mutable key `services.aroma-convergence.mutationsEnabled` в `config/platform.yaml`, schema, runtime matrix и tests; fixed `mutationCapability` остаётся machine capability claim. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B07; F01–F07 |
| 121 | При `false` observer/read/recovery и durable wake-up продолжают работать, а любой provider mutation dispatch до Gateway завершается `AROMA_MUTATIONS_DISABLED`. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B07; F01–F07 |
| 122 | Existing reservation/`UnknownOutcome` не теряются; старый `operationRef` не отправляется повторно. После включения recovery начинается с fresh GET. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B07; F01–F07 |
| 123 | Значение по умолчанию не скрыто: committed launch config содержит явное `false`; включение выполняется только отдельным разрешённым config change. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B07; F01–F07 |
| 145 | Application orchestration — async functions only. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B08; F01–F07 |
| 146 | State transition/diff/hash/projection functions — pure. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B08; F01–F07 |
| 147 | Owner Stores expose exact atomic operations, not generic SQL transaction. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B08; F01–F07 |
| 148 | Root AbortController owns consumer/scheduler/heartbeat async operations; Fastify close hook aborts them. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B08; F01–F07 |
| 149 | Unowned async loops и detached Promise chains запрещены; scheduler/heartbeat привязаны к Fastify close lifecycle и AbortSignal. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B08; F01–F07 |
| 150 | No global application plugin across Orders runtimes; shared technical package only, owner DB access remains role-specific. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B08; F01–F07 |
| 156 | PK `(consumer_name,message_id)`. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B09; F01–F07 |
| 157 | Canonical payload hash/type/version/key. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B09; F01–F07 |
| 158 | Processed result/outcome and durable quarantine conflict. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B09; F01–F07 |
| 159 | Same ID/different payload cannot be normal duplicate. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B09; F01–F07 |
| 163 | Product/variant→offer facts. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B09; F01–F07 |
| 164 | Mapping/catalog revisions, mapping state, availability, effectiveAt. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B09; F01–F07 |
| 165 | Source message identity/hash. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B09; F01–F07 |
| 166 | Monotonic revision guards. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B09; F01–F07 |
| 167 | Equal revision/different facts quarantined. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B09; F01–F07 |
| 171 | Desired revisions, lines, blockers and canonical Desired hash. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B10; F01–F07 |
| 172 | One Current revision per cart scope. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B10; F01–F07 |
| 173 | Decimal/bigint exact revisions/quantities. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B10; F01–F07 |
| 174 | Preserve superseded revisions for proof/recovery. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B10; F01–F07 |
| 178 | Only complete Observed revisions/lines. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B10; F01–F07 |
| 179 | Provider snapshot ref, capturedAt, fingerprint. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B10; F01–F07 |
| 180 | Source kind `Observer\|Convergence`. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B10; F01–F07 |
| 181 | AttemptRef/fence nullable for Observer, required for Convergence source. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B10; F01–F07 |
| 182 | One Current complete revision per scope. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B10; F01–F07 |
| 186 | Exact Attempt states and immutable terminal result. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B10; F01–F07 |
| 187 | Link desired revision/hash, initial/verification Observed, owner/fence, timestamps. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B10; F01–F07 |
| 188 | Terminal states only `NoOpInSync\|VerifiedInSync\|OutOfSync\|Blocked\|UnknownOutcome\|Failed`. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B10; F01–F07 |
| 189 | One mutation reservation maximum per Attempt. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B10; F01–F07 |
| 193 | cart scope primary key. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B10; F01–F07 |
| 194 | Owner UUID. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B10; F01–F07 |
| 195 | Monotonic fence epoch. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B10; F01–F07 |
| 196 | Heartbeat/expiry timestamps. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B10; F01–F07 |
| 197 | Conditional acquire/heartbeat/release guards. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B10; F01–F07 |
| 201 | One reservation per Attempt. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B10; F01–F07 |
| 202 | Exact action `SetQuantity\|Remove`. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B10; F01–F07 |
| 203 | offerRef, optional sourceGrindKeyHash, observed-before, desired, request hash, operationRef; reservation и её hash сохраняют полный line key. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B10; F01–F07 |
| 204 | Dispatch/outcome state and Gateway result reference. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B10; F01–F07 |
| 205 | Immutable identity fields after creation. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B10; F01–F07 |
| 209 | Создать `cart_desired_order_facts`, связывающую старые/новые Desired facts с затронутыми Order refs. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B10; F01–F07 |
| 210 | Создать `order_aroma_projections` с Order Card AROMA projection и `projection_version`. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B10; F01–F07 |
| 211 | Impacted Orders = union refs из прежней и новой Desired revisions; remap/remove не теряет прежний Order impact. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B10; F01–F07 |
| 212 | Projection row содержит proof metadata для InSync без полного cart payload. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B10; F01–F07 |
| 216 | Each Orders worker role can access only its approved tables/operations. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B11; F01–F07 |
| 217 | Orders core service cannot write #11 worker tables except approved reconciliation Outbox/history paths. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B11; F01–F07 |
| 218 | Foreign DB, DDL, superuser/migrator denied. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B11; F01–F07 |
| 222 | Decode every Kafka event through JSON Schema из #4 before Inbox. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B12; F01–F07 |
| 223 | Decode every Gateway response through JSON Schema из #4. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B12; F01–F07 |
| 224 | Decode every SQL row through owner-local persistence Schema. | Локальные row-schema/owner проверки PASS; общий gate остаётся RED | E03; F01/F02 |
| 225 | Version/revision/fence/quantity not converted to unsafe number. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B12; F01–F07 |
| 226 | Expected errors use tagged Schema types. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B14; F01–F07 |
| 227 | Invalid internal row/event/response fails closed and cannot mutate projection/physical cart. | Локальные row-schema/owner проверки PASS; общий gate остаётся RED | E03; F01/F02 |
| 233 | `OrderConfirmed.v1`. | Реальный Confirm event с DB микросекундами обработан; неверный timestamp отклонён | B15; F01–F07; F57–F59 |
| 234 | `CatalogMappingChanged.v2`. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B15; F01–F07 |
| 235 | `AromaObservationChanged.v1`. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B15; F01–F07 |
| 236 | `AromaConvergenceChanged.v1`. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B15; F01–F07 |
| 237 | Unknown/eighth message type → durable quarantine. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B15; F01–F07 |
| 243 | Acquire/check Inbox row/payload hash. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B15; F01–F07 |
| 244 | Same message/same payload → durable duplicate/no business re-execution. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B15; F01–F07 |
| 245 | Same ID/different payload/type/key → quarantine. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B15; F01–F07 |
| 246 | Apply monotonic owner-fact guard. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B15; F01–F07 |
| 247 | Update projection/Desired where applicable. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B15; F01–F07 |
| 248 | Write optional Outbox facts/invalidation. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B15; F01–F07 |
| 249 | Mark Inbox processed/result. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B15; F01–F07 |
| 250 | Commit, затем Kafka offset commit. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B15; F01–F07 |
| 254 | Payload exact: productRef, variantRef, offerRef\|null, catalogSnapshotRevision, mappingRevision, mappingState, availability, effectiveAt. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B15; F01–F07 |
| 255 | Lower revision → stale no-op. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B15; F01–F07 |
| 256 | Equal revision/same facts → no-op. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B15; F01–F07 |
| 257 | Equal revision/different facts → quarantine. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B15; F01–F07 |
| 258 | Active requires non-null offerRef; Missing/Stopped requires null according contract. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B15; F01–F07 |
| 259 | Full Catalog rows never enter Orders/Kafka projection. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B15; F01–F07 |
| 263 | Read all Current Confirmed Order contributions for `aroma-primary`. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B16; F01–F07 |
| 264 | Preserve frozen offerRef/mapping/catalog/internal proof per Order. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B16; F01–F07 |
| 265 | Current mapping different from frozen offer → blocker `MAPPING_CHANGED`, no silent remap. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B16; F01–F07 |
| 266 | Missing mapping → `MAPPING_MISSING`. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B16; F01–F07 |
| 267 | Stopped mapping → `MAPPING_STOPPED`. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B16; F01–F07 |
| 268 | Product unavailable → `PRODUCT_UNAVAILABLE`. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B16; F01–F07 |
| 269 | Агрегировать `quantityMilli` по frozen `(offerRef,sourceGrindKeyHash-or-absence)` с bigint overflow guard. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B16; F01–F07 |
| 270 | Стабильный порядок по offerRef, затем отсутствие выбора перед hash; displayName не является физической identity. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B16; F01–F07 |
| 271 | Build canonical lines/blockers/order-facts hash. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B16; F01–F07 |
| 272 | Same canonical hash as Current Desired → no new revision/event. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B16; F01–F07 |
| 273 | Changed hash → one transaction supersede old, insert new Desired/lines/blockers/order facts, Outbox `AromaConvergenceRequested.v1`. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B16; F01–F07 |
| 274 | Reason only `OrderConfirmed\|CatalogChanged\|OperatorRequested` according source. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B16; F01–F07 |
| 275 | Expensive recompute/wake-up coalesces dirty scope; duplicate mapping events do not create unbounded revisions. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B16; F01–F07 |
| 279 | Observer triggered only by durable configured schedule. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B17; F01–F07 |
| 280 | Schedule state/restart semantics explicit; Kafka command not consumed. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B17; F01–F07 |
| 281 | No overlapping unbounded observations for same scope. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B17; F01–F07 |
| 282 | Safe GET deadline 10 seconds. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B17; F01–F07 |
| 283 | Max two read attempts, 250 ms delay, only before response bytes. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B17; F01–F07 |
| 284 | Retry policy imported only from read capability. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B17; F01–F07 |
| 290 | Revalidate current scope/context. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B17; F01–F07 |
| 291 | Insert next complete Observed revision/lines/fingerprint/sourceKind=Observer. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B17; F01–F07 |
| 292 | Supersede prior Current atomically. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B17; F01–F07 |
| 293 | Insert Outbox `AromaObservationChanged.v1`. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B17; F01–F07 |
| 294 | Commit before event publication. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B17; F01–F07 |
| 296 | Failed/partial/timeout/invalid GET creates no Observed. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B17; F01–F07 |
| 297 | Prior Current Observed remains unchanged. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B17; F01–F07 |
| 298 | Empty cart is valid only as complete snapshot with verified fingerprint. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B17; F01–F07 |
| 304 | Single transaction conditional acquire only if missing/expired. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B18; F01–F07 |
| 305 | New owner UUID. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B18; F01–F07 |
| 306 | Fence = previous + 1, initial 1. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B18; F01–F07 |
| 307 | Expiry = DB/process-authoritative policy `now+30s` exactly. | Локальные fake-clock/lease/heartbeat сценарии PASS; общий gate остаётся RED | E04; F05/F07 |
| 308 | Active foreign lease → coalesced wake-up/no wait/no sleep lock loop. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B18; F01–F07 |
| 309 | Acquisition does not hold lock across later HTTP. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B18; F01–F07 |
| 313 | Heartbeat operation uses AbortController and configured 10s timer; Fastify close aborts it. | Локальные fake-clock/lease/heartbeat сценарии PASS; общий gate остаётся RED | E04; F05/F07 |
| 314 | Conditional update by scope/owner/fence/not-expired. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B18; F01–F07 |
| 315 | Extend to `now+30s`. | Локальные fake-clock/lease/heartbeat сценарии PASS; общий gate остаётся RED | E04; F05/F07 |
| 316 | Zero rows emits `STALE_FENCE` and interrupts/marks Attempt path. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B18; F01–F07 |
| 317 | Heartbeat async operation terminates with Attempt lifecycle/finalizer. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B18; F01–F07 |
| 318 | Fake timers prove schedule without real waiting. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B18; F01–F07 |
| 324 | Before reservation. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B19; F01–F07 |
| 325 | Before unsafe HTTP dispatch. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B19; F01–F07 |
| 326 | Before initial Observed save when convergence-owned. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B19; F01–F07 |
| 327 | Before verification Observed save. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B19; F01–F07 |
| 328 | Before terminal Attempt/result/projection write. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B19; F01–F07 |
| 329 | Require owner/fence/not-expired/current Desired revision/hash. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B19; F01–F07 |
| 330 | Zero rows → mutation/success write forbidden. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B19; F01–F07 |
| 336 | Receive/coalesce durable wake-up for scope. | Локальные функциональные convergence сценарии PASS; общий gate RED по capacity | E14; F05/F07 |
| 337 | Acquire lease/new fence or exit coalesced. | Локальные функциональные convergence сценарии PASS; общий gate RED по capacity | E14; F05/F07 |
| 338 | Create durable Attempt linked to current Desired before provider read. | Локальные функциональные convergence сценарии PASS; общий gate RED по capacity | E14; F05/F07 |
| 339 | Start heartbeat operation bound to Attempt lifecycle. | Локальные функциональные convergence сценарии PASS; общий gate RED по capacity | E14; F05/F07 |
| 340 | Execute fresh complete safe GET through Gateway. | Локальные функциональные convergence сценарии PASS; общий gate RED по capacity | E14; F05/F07 |
| 341 | Under current fence save complete GET as Observed(source=Convergence). | Локальные функциональные convergence сценарии PASS; общий gate RED по capacity | E14; F05/F07 |
| 342 | Re-read current Desired/fence and compare full canonical cart. | Локальные функциональные convergence сценарии PASS; общий gate RED по capacity | E14; F05/F07 |
| 343 | If equal: terminal `NoOpInSync`, mutations=0, update impacted projections/invalidation. | Локальные функциональные convergence сценарии PASS; общий gate RED по capacity | E14; F05/F07 |
| 344 | If blockers: terminal `Blocked`, mutations=0. | Локальные функциональные convergence сценарии PASS; общий gate RED по capacity | E14; F05/F07 |
| 345 | Выбрать первый diff по полному стабильному line key `(offerRef,sourceGrindKeyHash-or-absence)`; desired 0=`Remove`, иначе `SetQuantity`; передать точный hash выбранной строки. | Локальные функциональные convergence сценарии PASS; общий gate RED по capacity | E14; F05/F07 |
| 346 | In short transaction fence-check and create exact mutation reservation with new operationRef. | Локальные функциональные convergence сценарии PASS; общий gate RED по capacity | E14; F05/F07 |
| 347 | Recheck fence/current Desired immediately before unsafe call; invoke Gateway mutation at most once; then fresh verification GET. | Локальные функциональные convergence сценарии PASS; общий gate RED по capacity | E14; F05/F07 |
| 348 | Under current fence persist verification Observed + terminal `VerifiedInSync` if whole cart equals current Desired, else `OutOfSync`; update projections/Outbox and release lease. | Локальные функциональные convergence сценарии PASS; общий gate RED по capacity | E14; F05/F07 |
| 352 | Complete and equal → `NoOpInSync`. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B20; F01–F07 |
| 353 | Complete with deterministic diff → reservation path. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B20; F01–F07 |
| 354 | Complete with business blocker/external ambiguity → `Blocked`/OutOfSync according exact rule, no mutation. | PASS164/166: full convergence blocker/reject scenarios | E07; F54 |
| 355 | Failed/partial/invalid/timeout → terminal `Failed` or retryable scheduling state according specification; no Observed/no mutation. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B20; F01–F07 |
| 356 | Prior Observed never cleared by failure. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B20; F01–F07 |
| 360 | Gateway exact replay result accepted without second provider call. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B20; F01–F07 |
| 361 | Definitive provider reject → `Failed`/`Blocked`, reservation terminal Rejected. | PASS164/166: full convergence blocker/reject scenarios | E06; F54 |
| 362 | Timeout/lost/invalid response → Attempt + reservation `UnknownOutcome`, release lease, no verification assumption. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B20; F01–F07 |
| 363 | Acknowledged response requires fresh verification GET. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B20; F01–F07 |
| 364 | Automatic retry of mutation absent in code/config/explicit bounded schedule. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B20; F01–F07 |
| 365 | No second mutation inside same Attempt. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B20; F01–F07 |
| 369 | Uses safe complete cart read after acknowledgement. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B20; F01–F07 |
| 370 | Failed/partial/invalid verification → `UnknownOutcome`, prior Current Observed retained. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B20; F01–F07 |
| 371 | Complete verification saved only under current fence. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B20; F01–F07 |
| 372 | Whole cart equals Current Desired → `VerifiedInSync`. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B20; F01–F07 |
| 373 | Otherwise `OutOfSync` + durable wake-up, no second mutation. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B20; F01–F07 |
| 374 | Terminal proof stores Desired hash/revision, Observed fingerprint/revision, Attempt, fence and affected contribution facts. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B20; F01–F07 |
| 380 | Physical line/cart equals desired → `RecoveredApplied`, mutations=0, continue full-cart proof. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B20; F01–F07 |
| 381 | Physical value equals observed-before → `RecoveredNotApplied`; only after full compare may create **new** reservation/new operationRef. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B20; F01–F07 |
| 382 | Physical value differs from both → save complete Observed, blocker `AROMA_EXTERNAL_CHANGE`, mutations=0. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B20; F01–F07 |
| 383 | Failed/partial GET → remain unresolved; no mutation. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B20; F01–F07 |
| 384 | Old operationRef never submitted again. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B20; F01–F07 |
| 385 | Gateway journal and Orders recovery remain separate barriers. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B20; F01–F07 |
| 386 | Recovered terminal write requires current fence/current Desired. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B20; F01–F07 |
| 392 | Consumes terminal Observation/Convergence owner facts through Inbox. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B21; F01–F07 |
| 393 | Computes impacted Order union old/new Desired order facts. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B21; F01–F07 |
| 394 | Calculates per-Order AROMA state using current contribution and cart-level proof. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B21; F01–F07 |
| 395 | Increments `projectionVersion` once per material projection change. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B21; F01–F07 |
| 396 | Writes one `RealtimeInvalidated.v1` Outbox per changed orderRef/version. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B21; F01–F07 |
| 397 | Equal facts/no material change → no projection version/event. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B21; F01–F07 |
| 398 | `ownerVersion` in realtime equals top-level `OrderCard.projectionVersion`. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B21; F01–F07 |
| 399 | Orders service only reads projection; it does not update it. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B21; F01–F07 |
| 400 | Event producer does not compute browser Card state. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B21; F01–F07 |
| 404 | Public command и Orders transaction полностью принадлежат #8; #11 не реализует второй command handler. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B22; F01–F07 |
| 405 | `aroma-convergence` потребляет committed `AromaConvergenceRequested.v1` через Inbox и запускает тот же fenced convergence path. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B22; F01–F07 |
| 406 | Поле `reason` принимает contract enum, включая `Recovery` для durable wake-up; оно не ослабляет lease/fence/reservation guards. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B22; F01–F07 |
| 410 | `AromaConvergenceRequested.v1` only after Desired/reconciliation transaction commit. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B22; F01–F07 |
| 411 | `AromaObservationChanged.v1` only after complete Observed commit. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B22; F01–F07 |
| 412 | `AromaConvergenceChanged.v1` only for terminal Attempt facts. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B22; F01–F07 |
| 413 | Event payloads contain no cart lines/provider body/credentials/PII. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B22; F01–F07 |
| 414 | `RealtimeInvalidated.v1` only projection worker, subjectRef=orderRef. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B22; F01–F07 |
| 415 | Kafka offset only after Inbox/business transaction commit. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B22; F01–F07 |
| 419 | `STALE_FENCE`. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B23; F01–F07 |
| 420 | `AROMA_EXTERNAL_CHANGE`. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B23; F01–F07 |
| 421 | `AROMA_MUTATIONS_DISABLED`. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B23; F01–F07 |
| 422 | `MAPPING_CHANGED`. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B23; F01–F07 |
| 423 | `MAPPING_MISSING`. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B23; F01–F07 |
| 424 | `MAPPING_STOPPED`. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B23; F01–F07 |
| 425 | `PRODUCT_UNAVAILABLE`. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B23; F01–F07 |
| 426 | `AROMA_UNAVAILABLE`/read failure. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B23; F01–F07 |
| 427 | `ProviderRejected`. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B23; F01–F07 |
| 428 | `UnknownOutcome`. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B23; F01–F07 |
| 429 | Inbox conflict/quarantine. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B23; F01–F07 |
| 430 | DB/TransactionOutcomeUnknown. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B23; F01–F07 |
| 431 | Errors do not expose SQL/provider body/secrets. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B23; F01–F07 |
| 435 | Spans per Inbox processing, recompute, observation, Attempt, lease/fence, reservation, provider read/mutation/verification, projection. | Локальные telemetry/lifecycle и synthetic bounded recovery PASS; не steady availability | E05; F03/F26/F27 |
| 436 | Metrics: Desired age/revisions, Observed age, Attempt outcomes, lease/fence failures, UnknownOutcome count, blockers, mutation count, recovery result. | Локальные telemetry/lifecycle и synthetic bounded recovery PASS; не steady availability | E05; F03/F26/F27 |
| 437 | Operation/order refs allowed only according trace/log policy; not unbounded metric labels. | Локальные telemetry/lifecycle и synthetic bounded recovery PASS; не steady availability | E05; F03/F26/F27 |
| 438 | Heartbeat/supervisor/consumer/scheduler health contributes readiness. | Локальные telemetry/lifecycle и synthetic bounded recovery PASS; не steady availability | E05; F03/F26/F27 |
| 439 | Provider outage may make observer/convergence not-ready/degraded but not Orders Confirm. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B25; F01–F07 |
| 440 | No PII/provider body/credentials/full event payload in logs/traces. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B25; F01–F07 |
| 444 | workflow/persistence/event-log/RPC abstractions. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B26; F01–F07 |
| 445 | In-memory Attempt/Lease/Fence/Reservation/Desired/Observed. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B26; F01–F07 |
| 446 | Generic distributed lock service. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B26; F01–F07 |
| 447 | detached Promise/setInterval/unowned background loops. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B26; F01–F07 |
| 448 | Direct provider/fetch/credentials. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B26; F01–F07 |
| 449 | Direct Catalog DB/staging access. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B26; F01–F07 |
| 450 | Per-Order physical cart convergence. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B26; F01–F07 |
| 451 | Silent offer remap. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B26; F01–F07 |
| 452 | Revision-number equality as InSync proof. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B26; F01–F07 |
| 453 | Mutation retry/reuse old operationRef. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B26; F01–F07 |
| 454 | Multiple mutations per Attempt. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B26; F01–F07 |
| 455 | DB lock across HTTP. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B26; F01–F07 |
| 456 | Checkout/supplier submission/payment/invoice/multi-account. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B26; F01–F07 |
| 460 | После restart без нового Kafka event продолжаются persisted pending convergence и periodic observation; active foreign lease и coalesced wake-up не теряют работу, UnknownOutcome сохраняет ReconcileOnly. Fake clock/startup sweep проверяет сроки без реального ожидания. | PASS164/166: durable restart/sweep/unknown barrier/wake coalescing | B27; F54 |
| 462 | Доказать canonical crash windows: lease expiry после final fence до HTTP; второй worker с новым fence при старом in-flight request; provider accepted/response lost; crash после reservation до request; duplicate wake-up/rebalance. Ни в одном сценарии две unsafe mutation одного physical cart не отправляются одновременно. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B28; F01–F07 |
| 468 | Duplicate/same payload no-op. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B29; F01–F07 |
| 469 | Same ID/different payload quarantine. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B29; F01–F07 |
| 470 | Lower/equal/conflicting revision behavior. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B29; F01–F07 |
| 471 | Concurrent recompute one canonical Current Desired. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B29; F01–F07 |
| 472 | Для обычного recompute тот же hash не создаёт revision/event; явный `OperatorRequested` по ADR-0032 всё равно создаёт durable wake-up без увеличения revision. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B29; F01–F07 |
| 473 | Frozen mapping drift blockers/no remap. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B29; F01–F07 |
| 474 | Impacted Order union/remap/remove projection. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B29; F01–F07 |
| 475 | One material change→one projection version/invalidation. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B29; F01–F07 |
| 479 | Two workers acquire: one owner. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B29; F01–F07 |
| 480 | Active foreign lease coalesces/no wait. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B29; F01–F07 |
| 481 | Expiry increments fence. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B29; F01–F07 |
| 482 | Stale fence before reservation. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B29; F01–F07 |
| 483 | Stale fence before HTTP. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B29; F01–F07 |
| 484 | Stale fence before each result write. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B29; F01–F07 |
| 485 | Heartbeat loss interrupts path. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B29; F01–F07 |
| 486 | Проверить fake clock для lease heartbeat/expiry 10s/30s на штатных Node/Fastify тестах; без Effect TestClock. | PASS164/166: exact10s/30s fake clock | E08; F54 |
| 492 | Before/after Attempt commit. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B28; F01–F07 |
| 493 | Before/after initial GET save. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B28; F01–F07 |
| 494 | Before/after reservation commit. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B28; F01–F07 |
| 495 | Before/after Gateway call dispatch. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B28; F01–F07 |
| 496 | After acknowledged response before verification. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B28; F01–F07 |
| 497 | Before/after verification save. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B28; F01–F07 |
| 498 | Before/after terminal/projection/Outbox commit. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B28; F01–F07 |
| 502 | No duplicate provider mutation. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B28; F01–F07 |
| 503 | Old operationRef not replayed. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B28; F01–F07 |
| 504 | Durable state permits deterministic recovery. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B28; F01–F07 |
| 505 | Prior complete Observed preserved on failed reads. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B28; F01–F07 |
| 509 | Complete empty/equal/different cart. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B31; F01–F07 |
| 510 | Failed/partial/invalid initial GET. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B31; F01–F07 |
| 511 | Failed/partial/invalid verification GET. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B31; F01–F07 |
| 512 | Definitive reject. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B31; F01–F07 |
| 513 | Lost mutation response. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B31; F01–F07 |
| 514 | Gateway exact replay provider calls=0. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B31; F01–F07 |
| 515 | External cart change recovery blocker. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B31; F01–F07 |
| 516 | Mutations disabled rollback mode. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B31; F01–F07 |
| 520 | 100 Order contributions. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B32; F01–F07 |
| 521 | 10,000 cart lines. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B32; F01–F07 |
| 522 | Desired recompute ≤2s under accepted environment. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B32; F01–F07 |
| 523 | Local Attempt work excluding provider latency ≤500ms. | PASS164/165/166:456,387/439,868/449,080ms; historical145 spike причина неизвестна | F54 |
| 524 | Bounded memory/async operations/queues. | Измерены heap/RSS и peak=1; отдельный согласованный memory budget не задан | B34; F06 |
| 525 | Wake-up storms coalesced. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B32; F01–F07 |
| 529 | Exact role/table grants per runtime. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B35; F01–F07 |
| 530 | Foreign DB/Orders core/provider credentials denied. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B35; F01–F07 |
| 531 | Observer mutation capability absent. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B35; F01–F07 |
| 532 | Preparation HTTP capability absent. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B35; F01–F07 |
| 533 | Convergence exact Gateway operations only. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B35; F01–F07 |
| 534 | Unsafe retry RED fixture. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B36; F01–F07 |
| 535 | PII/secret/provider-body redaction. | Код и соответствующие локальные сценарии проверены; общий gate остаётся RED | B35; F01–F07 |
| 541 | `pnpm contracts:check-generated`. | PASS текущего среза | F01 |
| 542 | `pnpm architecture:check`. | PASS текущего среза | F01 |
| 543 | `pnpm typecheck`. | PASS текущего среза | F01 |
| 544 | `pnpm lint`. | PASS текущего среза | F01 |
| 545 | `pnpm test:aroma-preparation`. | PASS147: 67/67, 0 skipped | F46 |
| 546 | `pnpm test:aroma-observer`. | PASS148:40/40, 0 skipped, lost-COMMIT recovery | F46 |
| 547 | `pnpm test:aroma-convergence`. | PASS164:93/93, 0 skipped, local456,387ms | F54 |
| 548 | `pnpm test:aroma-recovery`. | PASS166:183/183, 0 skipped, full fault matrix | F54 |
| 549 | `pnpm test:aroma-projections`. | PASS156:113/113,0skips после Card enum fix; общий performance gate открыт | B37; F44/F45 |
| 550 | `pnpm test:aroma-capacity`. | PASS165:76/76, local439,868ms / Preparation1887,330ms | F54 |
| 551 | `pnpm db:smoke`. | PASS offline SQL proof (50 assertions); не live Compose | F10 |
| 552 | `pnpm test:compose-smoke`. | Default smoke требует SOPS key; synthetic recovery 095 и post-readiness PASS | F08/F26/F27 |
| 558 | В том же implementation PR уточнить docs/launch/19_AROMA_CONVERGENCE_IMPLEMENTATION_SPEC.md и config/schema по фактическим durable schedule и cart-wide reservation guarantees; handoff issue-11.yaml содержит соответствующие crash/restart evidence для #12/#13 и последующего W2 #80. #80 не является prerequisite #11; checkout остаётся вне первой волны. | Частично реализовано | B38 |
| 562 | Переписать convergence/AROMA safety/Orders projection specifications по фактическому Fastify/pg implementation без correction-block drift. | Частично реализовано | B38 |
| 563 | Обновить config/roles/topics/secret/runtime inventory только owning scopes. | Частично реализовано | B38 |
| 564 | Создать `evidence/handoffs/issue-11.yaml` с exact predecessor SHAs, failure matrix, provider call counts, capacity и commands. | Частичный not-ready handoff создан; полного B acceptance нет | B39; F10 |
| 572 | Ветка `feature/11-aroma-convergence` только от `develop` с accepted predecessors. | Ветка и base проверены локально: feature/11-aroma-convergence, e278aeb… | E11/F09 |
| 573 | Один issue — одна ветка — один PR только в `develop`. | Не завершено: PR не создан | E15 |
| 574 | Коммиты, PR, evidence и review replies — на русском. | Evidence оформляется на русском; commit/PR review отсутствуют | E15 |
| 575 | PR содержит `Closes #11`. | Не выполнено: PR ещё не содержит Closes #11 | E15 |

## Реестр evidence

Исторические B-группы (findings до исправлений, не текущие дефекты) ссылаются на stage B audit и перечисляют исходные issue line IDs; обновлённые source paths приведены отдельно. Наличие новой реализации до повторного запуска — не PASS.

**B01 — lines 63; Реализовано по аудиту; повторная проверка текущего дерева ожидается.** apps/orders-aroma-preparation/src/infrastructure/preparation-store.ts::handle now throws transient InboxProcessingError(AROMA_RECONCILIATION_FACTS_PENDING) when no Current Desired facts exist, so Inbox/offset do not commit; durable source-Outbox pending intent is later reconstructed by runOnce. Tests/orders/aroma-preparation-live.test.mjs updated by parent to assert no Inbox/offset success and recovery after restart.

**B02 — lines 69; Реализовано по аудиту; повторная проверка текущего дерева ожидается.** apps/orders-service/migrations/0014_create_mutation_reservations.sql::orders_one_unresolved_mutation_per_scope, guard_mutation_reservation; apps/aroma-convergence/src/infrastructure/convergence-store.ts::unresolved/runOnce; tests/aroma/convergence-live.test.mjs lines 356-399

**B03 — lines 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83, 84; Реализовано по аудиту; повторная проверка текущего дерева ожидается.** apps/orders-aroma-preparation/src/domain/desired.ts::buildDesired; apps/aroma-convergence/src/infrastructure/convergence-store.ts::runOnce/saveSnapshot/check; apps/aroma-convergence/src/cart-plan.ts::firstCartDifference/reconcileReservation; owner migrations 0010-0015; tests/orders/aroma-preparation-live.test.mjs, tests/aroma/convergence-live.test.mjs, tests/aroma/observer-live.test.mjs

**B04 — lines 88; Реализовано по аудиту; повторная проверка текущего дерева ожидается.** apps/orders-service/migrations/0016_create_aroma_work_schedules.sql; apps/orders-aroma-preparation/src/infrastructure/preparation-store.ts::runOnce/recover; apps/aroma-convergence/src/infrastructure/convergence-store.ts::work/consume/deferBarrier; apps/aroma-observer/src/infrastructure/observation-store.ts::recover/runOnce; tests/aroma/observer-live.test.mjs::durable startup schedule..., tests/aroma/convergence-live.test.mjs::capacity/wake storm/restart cases

**B05 — lines 90; Частично реализовано.** apps/orders-service/migrations/0014_create_mutation_reservations.sql columns/checks/index; apps/aroma-convergence/src/infrastructure/convergence-store.ts::reserve/extend/dispatch/runOnce; tests/aroma/convergence-live.test.mjs lines 356-399, 440-453, 553-565 Finding: Cart scope barrier, deadlines, safety margin, lease extension and fresh-GET reconciliation exist. Config is 45s lease/5s heartbeat at config/platform.yaml:425, while issue requires exactly now+30s and configured 10s heartbeat (also docs/launch/19 lines 179-183).

**B06 — lines 96, 97, 98, 99, 100, 104, 105, 106, 107, 108, 112, 113, 114, 115, 116; Реализовано по аудиту; повторная проверка текущего дерева ожидается.** config/database-ownership.json; config/service-catalog.json; config/platform.yaml; config/permissions/*; migrations 0008-0016 GRANTs; three runtime-composition.ts files; tests/aroma/convergence-live.test.mjs and tests/orders/aroma-preparation-live.test.mjs prove role runtime/DB scoping and capabilities

**B07 — lines 120, 121, 122, 123; Реализовано по аудиту; повторная проверка текущего дерева ожидается.** config/platform.yaml:424-425 explicit false; config/platform.schema.json; apps/aroma-convergence/src/runtime-composition.ts:39 and convergence-store.ts::runOnce; tests/aroma/convergence-live.test.mjs lines 249-260 and 379-399

**B08 — lines 145, 146, 147, 148, 149, 150; Реализовано по аудиту; повторная проверка текущего дерева ожидается.** All three runtime-composition.ts use owned AbortController and bounded supervisor; pure helpers are desired.ts/cart-plan.ts/projection.ts; stores expose scoped operations; tests/* live runtime lifecycle cases

**B09 — lines 156, 157, 158, 159, 163, 164, 165, 166, 167; Реализовано по аудиту; повторная проверка текущего дерева ожидается.** migrations 0008/0009; packages/contracts/aroma-v1 event schema validators; apps/orders-aroma-preparation/src/application/messages.ts::decodeAromaPreparationEnvelope and preparation-store.ts::handle; tests/kafka/orders-inbox-live.test.mjs, tests/orders/aroma-preparation-live.test.mjs

**B10 — lines 171, 172, 173, 174, 178, 179, 180, 181, 182, 186, 187, 188, 189, 193, 194, 195, 196, 197, 201, 202, 203, 204, 205, 209, 210, 211, 212; Реализовано по аудиту; повторная проверка текущего дерева ожидается.** apps/orders-service/migrations/0010-0016_create_*; apps/aroma-convergence/src/infrastructure/convergence-store.ts; apps/orders-aroma-preparation/src/domain/projection.ts and preparation-store.ts::projections; tests/orders/aroma-schema.test.mjs and relevant live suites

**B11 — lines 216, 217, 218; Реализовано по аудиту; повторная проверка текущего дерева ожидается.** migrations 0008-0018 role grants/revokes; tests/orders/aroma-preparation-live.test.mjs role proofs; tests/aroma/convergence-live.test.mjs owner role fixture; tests/orders/aroma-schema.test.mjs

**B12 — lines 222, 223, 225; Реализовано по аудиту; повторная проверка текущего дерева ожидается.** application/messages.ts uses isAromaOwnerMessage (JSON Schema); Gateway clients use generated isAromaCartSnapshot/isAromaMutationResponse; bigint revisions/quantities stay strings then BigInt; malformed events/responses fail closed

**B13 — lines 224, 227; Пробел подтверждён аудитом.** packages/platform-database/src/owner.ts::execute returns result.rows as Row[] (line 21); apps/orders-aroma-preparation/src/infrastructure/preparation-store.ts, apps/aroma-observer/src/infrastructure/observation-store.ts and apps/aroma-convergence/src/infrastructure/convergence-store.ts declare generic defineStatement<Row> types but have no runtime row decoder/schema. apps/orders-service/src/infrastructure/database/row-schemas.ts has Ajv decoders only for core Orders rows, not worker rows. Finding: Corrupt/malformed owner-local rows are trusted as typed data. Add owner-local decoders at the worker Store read boundary and test invalid rows fail before write/dispatch.

**B14 — lines 226; Частично реализовано.** Worker errors are mostly string-code AromaPreparationError/GatewayClientError/OwnershipLost and SQL DatabaseTransactionError; no shared tagged persistence Schema decoder for expected row errors. GatewayProblem maps allowlisted stable codes.

**B15 — lines 233, 234, 235, 236, 237, 243, 244, 245, 246, 247, 248, 249, 250, 254, 255, 256, 257, 258, 259; Реализовано по аудиту; повторная проверка текущего дерева ожидается.** decodeAromaPreparationEnvelope, Inbox helper binding in runtime-composition.ts, preparation-store.ts::handle and revision guards; contracts/schemas/events/catalog-mapping-changed.v2.schema.json includes Active/non-null and Missing|Stopped/null conditionals; migrations enforce Active non-null; tests/orders/aroma-preparation-live.test.mjs and tests/kafka/orders-inbox-live.test.mjs

**B16 — lines 263, 264, 265, 266, 267, 268, 269, 270, 271, 272, 273, 274, 275; Реализовано по аудиту; повторная проверка текущего дерева ожидается.** apps/orders-aroma-preparation/src/domain/desired.ts::mappingBlocker/buildDesired; preparation-store.ts::prepare/request; migrations 0010; tests/orders/aroma-preparation-live.test.mjs capacity/revision/mapping/concurrent recompute cases

**B17 — lines 279, 280, 281, 282, 283, 284, 290, 291, 292, 293, 294, 296, 297, 298; Реализовано по аудиту; повторная проверка текущего дерева ожидается.** apps/aroma-observer/src/infrastructure/observation-store.ts::claim/permit/freshness/reschedule/runOnce; runtime-composition.ts supervisor; apps/aroma-observer/src/gateway-client.ts::read; tests/aroma/observer-live.test.mjs. Observer performs one bounded safe GET per due schedule (within max-two attempts).

**B18 — lines 304, 305, 306, 307, 308, 309, 313, 314, 315, 316, 317, 318; Частично реализовано.** convergence-store.ts::acquire/heartbeat/ping/finally; migration 0013 guards; convergence-live tests exercise competing owner, expiry, shutdown and heartbeat cases Finding: Safety mechanics exist, but configured convergence values differ from issue's exact 30s/10s (config/platform.yaml:425). A fake-clock test for exact 10s/30s is not present; heartbeat tests use short real timers.

**B19 — lines 324, 325, 326, 327, 328, 329, 330; Реализовано по аудиту; повторная проверка текущего дерева ожидается.** convergence-store.ts::check called around initial/verification save, reservation, dispatch and terminal; SQL guard requires owner/fence/unexpired/current desired and observed; tests/convergence-live.test.mjs invalidation cases lines 440-483, 579-595

**B20 — lines 352, 353, 354, 355, 356, 360, 362, 363, 364, 365, 369, 370, 371, 372, 373, 374, 380, 381, 382, 383, 384, 385, 386; Частично реализовано.** convergence-store.ts::runOnce/saveSnapshot/terminal/reconcileReservation; cart-plan.ts; migrations 0014; tests/aroma/convergence-live.test.mjs lines 356-424 Finding: Fresh-GET recovery, exact line key and no old operationRef replay are covered. Definitive Gateway rejection is incorrectly caught with timeout/invalid response at convergence-store.ts:391-407 and becomes UnknownOutcome. GatewayClientError distinguishes Rejected, but migration 0014 reservation state enum lacks Rejected. Required Failed/Blocked + terminal Rejected behavior/test are missing.

**B21 — lines 392, 393, 394, 395, 396, 397, 398, 399, 400; Реализовано по аудиту; повторная проверка текущего дерева ожидается.** preparation-store.ts::projections/emit; projection.ts::projectAromaCard; migration 0015 and guarded write_card_projection 0018; tests/orders/aroma-preparation-live.test.mjs and tests/orders/order-card.test.mjs

**B22 — lines 404, 405, 406, 410, 411, 412, 413, 414, 415; Реализовано по аудиту; повторная проверка текущего дерева ожидается.** Preparation binds lifecycle/facts events; convergence runtime binds only configured command consumer; durable work scan handles Recovery; owner Outbox emitted in transaction; Inbox/Kafka helpers commit offsets post transaction. Tests preparation, convergence and Kafka live suites.

**B23 — lines 419, 420, 421, 422, 423, 424, 425, 426, 427, 428, 429, 430, 431; Частично реализовано.** Stable error/blocker strings and redacted GatewayClientError, sanitized logs in runtime-composition.ts. Row-schema/expected-error typing incomplete; definitive provider reject is misclassified; no uniform tagged Schema error domain.

**B24 — lines 435, 436, 437; Пробел подтверждён аудитом.** rg for tracing/spans/counters in three worker src trees finds only one readiness gauge per runtime in runtime-composition.ts:61/64/72; no spans or business metrics specified in issue. Parent separately auditing observability.

**B25 — lines 438, 439, 440; Частично реализовано.** Each runtime has readinessChecks for supervisor and InternalApi readiness where applicable; provider exceptions fail readiness until a succeeding cycle. No spans/business metrics. Orders Confirm path remains separate from worker provider calls.

**B26 — lines 444, 445, 446, 447, 448, 449, 450, 451, 452, 453, 454, 455, 456; Реализовано по аудиту; повторная проверка текущего дерева ожидается.** Only DB-persisted durable state, scoped stores, timers, typed internal Gateway clients; no workflow/event-log abstraction, no per-Order cart convergence, no old opRef resend, no multiple mutation per Attempt; network called only outside DB transaction. Source inspection across three apps and migrations.

**B27 — lines 460; Частично реализовано.** Restart/recovery and periodic observer tests: tests/aroma/convergence-live.test.mjs 356-399; tests/aroma/observer-live.test.mjs 292-310; tests/orders/aroma-preparation-live.test.mjs 503-525. Pending work survives restart and unknown reservations reconcile. Exact fake-clock deadlines required by criterion are not tested.

**B28 — lines 462, 492, 493, 494, 495, 496, 497, 498, 502, 503, 504, 505; Частично реализовано.** convergence-live tests force restart seeds for Reserved/Dispatched/Acknowledged, response loss, shutdown and fence/expiry injection at reservation/dispatch/verification/terminal seams; observer/preparation tests cover COMMIT loss/restart Finding: Not every listed before/after durable boundary is forced (notably Attempt commit, successful initial GET saved then process death, verification save then death, projection/Outbox boundary). Existing tests cover representative recovery windows, not the full canonical matrix checkbox.

**B29 — lines 468, 469, 470, 471, 472, 473, 474, 475, 479, 480, 481, 482, 483, 484, 485; Реализовано по аудиту; повторная проверка текущего дерева ожидается.** tests/orders/aroma-preparation-live.test.mjs Inbox/recompute/projection/reconcile cases; tests/aroma/convergence-live.test.mjs competing owners, expiry, stale fences, heartbeat abort, coalescing. Line 63 no-facts outcome remains violating despite durable row test.

**B30 — lines 486; Проверка ожидается.** tests/aroma/convergence-live.test.mjs uses real short heartbeat timers (line 326); no fake timer/fake clock proof for exact 10s/30s configuration was found.

**B31 — lines 509, 510, 511, 512, 513, 514, 515, 516; Частично реализовано.** convergence-live.test.mjs covers empty/equal/different, invalid initial/verification GET, timeout/lost response, external change, mutation-disabled mode, Gateway client exact operation validation. No definitive reject behavior test; the implementation maps rejection to UnknownOutcome.

**B32 — lines 520, 521, 522, 525; Реализовано по аудиту; повторная проверка текущего дерева ожидается.** tests/orders/aroma-preparation-live.test.mjs::capacity (100 contributions, 10000 lines, ≤2s); tests/aroma/convergence-live.test.mjs::capacity (10000 lines, 1000 wakeups, one work row).

**B33 — lines 523; Пробел подтверждён аудитом.** tests/aroma/convergence-live.test.mjs capacity assertion at lines 168-186; independent lane-N receipt reports literal local Attempt 796.183871ms > 500ms (55 pass/2 fail including enclosing suite). Known failure; no rerun performed.

**B34 — lines 524; Частично реализовано.** convergence capacity test records peak provider concurrency, heap/RSS deltas and bounded line count; it only asserts provider peak=1 and workload correctness, not an accepted memory/async-operation/queue budget.

**B35 — lines 529, 530, 531, 532, 533, 535; Реализовано по аудиту; повторная проверка текущего дерева ожидается.** role grants/revokes in migrations 0008-0018; tests/orders/aroma-schema.test.mjs owner-role grants; observer runtime exposes only read client, prep has no HTTP client, convergence uses exact client methods; logs emit stable reason/name only.

**B36 — lines 534; Проверка ожидается.** No explicit architecture RED fixture for forbidden unsafe retries found. Existing gateway client makes exactly one fetch and convergence restart tests assert old operationRef not reused, which is behavioral evidence but not requested RED fixture.

**B37 — lines 541, 542, 543, 544, 545, 546, 547, 548, 549, 550, 551, 552; Проверка ожидается.** All named commands exist in package.json. This read-only audit did not execute them; no result implied. lane-N receipt already establishes convergence suite/capacity RED. Remaining command receipts must be reconciled by parent.

**B38 — lines 558, 562, 563; Частично реализовано.** docs/launch/19_AROMA_CONVERGENCE_IMPLEMENTATION_SPEC.md and config/platform.yaml/schema/runtime inventory are modified in working tree; current spec reflects durable schedule/reservation and schemas. No complete checked-in issue-11 handoff evidence.

**B39 — lines 564; Пробел подтверждён аудитом.** evidence/handoffs/issue-11.yaml does not exist in the worktree.

**E01 — No-facts transient.** `apps/orders-aroma-preparation/src/infrastructure/preparation-store.ts::handle` transient `InboxProcessingError(AROMA_RECONCILIATION_FACTS_PENDING)`; source-Outbox intent recovered by `runOnce`. Updated test: `tests/orders/aroma-preparation-live.test.mjs`. Проверка ожидается.

**E02 — Reservation/deadline config.** `config/platform.yaml` convergence config: `leaseMs: 30000`, `heartbeatIntervalMs: 10000`, `providerDeadlineMs: 10000`; related spec: `docs/launch/19_AROMA_CONVERGENCE_IMPLEMENTATION_SPEC.md`. Validation/fake-clock proof pending.

**E03 — Owner-local persistence decoders.** Worker SQL row decoders in `apps/orders-aroma-preparation/src/infrastructure/row-schemas.ts`, `apps/aroma-observer/src/infrastructure/row-schemas.ts`, `apps/aroma-convergence/src/infrastructure/row-schemas.ts`; malformed rows must fail before writes/provider dispatch. Проверка ожидается.

**E04 — 30s/10s lease and heartbeat.** Config E02; implementation in `apps/aroma-convergence/src/infrastructure/convergence-store.ts`. Exact timer proof still pending; line 486 needs fake-clock evidence.

**E05 — Observability.** New `apps/aroma-convergence/src/observability.ts`, `apps/aroma-observer/src/observability.ts`, `apps/orders-aroma-preparation/src/observability.ts`; runtime composition wires telemetry/readiness. Проверка ожидается.

**E06 — Definitive 404 rejection.** `apps/orders-service/migrations/0022_terminal_cart_item_rejection.sql` adds terminal rejection persistence; convergence store and `tests/aroma/convergence-live.test.mjs` distinguish definitive cart-item 404 Rejected/Blocked from 503 UnknownOutcome. Проверка ожидается.

**E07 — Fresh Catalog proof / fail-closed.** `apps/api-internal/src/index.ts` route `/api/internal-v1/catalog/products/:productRef/variants/:variantRef/pricing-input` permits scoped `aroma-convergence`, calls Catalog, validates 200 via `isCatalogPricingInput`, forwards allowlisted Catalog problems and maps invalid/unavailable response to 503 `CATALOG_UNAVAILABLE`; route schema includes 404/503. `apps/aroma-convergence/src/infrastructure/convergence-store.ts` checks Catalog source before positive mutation. Current security/live proof pending.

**E08 — Fake clock.** B audit found convergence heartbeat tests used short real timers and did not establish exact 10s/30s schedule; updated config alone does not satisfy fake-clock criterion.

**E09 — Stage A handoff.** Backend stage A artifacts include OpenAPI/contracts/generated packages, Catalog/Pricing/Orders implementations and forward migrations; `evidence/handoffs/issue-11.yaml` was absent at audit time. UI files are out of #11 scope.

**E10 — Full stage B handoff.** `evidence/handoffs/issue-11.yaml` was absent at audit time. Worker code/migrations implement durable state, but delivery handoff remains outstanding.

**E11 — Input/worktree metadata.** Predecessor/worktree statements are copied from live issue body; they do not prove current remote state or full #11 completion.

**E12 — Quantity blocker authority.** Approved issue comment/doc 30 uses exact milli→whole provider unit conversion and blocker `AROMA_QUANTITY_NOT_SUPPORTED`. Code paths include `apps/aroma-convergence/src/cart-plan.ts` and `apps/aroma-convergence/src/infrastructure/row-schemas.ts`; old checkbox enum is superseded.

**E13 — Stage A contract audit.** Earlier read-only audit found grind data carried through Catalog facts, Pricing quote/proof/idempotency, Orders PUT/Card/contribution and forward-only migrations. Paths include `apps/catalog-service/src/application/search-catalog.ts`, `apps/pricing-service/src/application/create-pricing-quote.ts`, `apps/orders-service/src/application/upsert-item.ts`, `apps/orders-service/src/domain/order-contribution.ts`, migrations `0007_order_grind_selection.sql` / `0005_quote_grind_selection.sql`, OpenAPI and generated schemas. Tests were not run in that audit; targeted current verification remains.

**E14 — Ordered convergence sequence.** `apps/aroma-convergence/src/infrastructure/convergence-store.ts::runOnce/saveSnapshot/reserve/dispatch` and `apps/aroma-convergence/src/cart-plan.ts::firstCartDifference`; B audit cites `tests/aroma/convergence-live.test.mjs` for sequence/recovery. Historical test failures are listed below; verify current tree.

**E15 — PR/branch delivery.** Local branch is named `feature/11-aroma-convergence`; this report does not assert accepted base/remote state. No commit or PR created in this task; PR-only criteria are pending.

**E16 — #9/#11 boundary.** #11 worktree contains backend/contracts/docs/tests changes and no `apps/web/**` paths in its status snapshot. Consumer compatibility and shared manifest/lock integration with #9 remain pending; see consumer section.

## Исторические проверки (не proof текущего дерева)

`status.tsv` сформирован `/tmp/coffee-issue11-checks/run.sh`; `0` = exit 0, `1` = ненулевой exit. Логи датированы 2026-10-03 примерно 21:24–21:39 местного времени, до последних локальных изменений. Не переносить эти статусы на текущую версию.

| Check | Exit | Исторический итог / замечание |
|---|---:|---|
| `001-contracts-lint` | 0 | exit 0 |
| `002-contracts-breaking` | 0 | exit 0 |
| `003-contracts-check-generated` | 0 | exit 0 |
| `004-contracts-test` | 0 | exit 0 |
| `005-architecture-check` | 0 | exit 0 |
| `006-typecheck` | 0 | exit 0 |
| `007-lint` | 0 | exit 0 |
| `008-aroma-preparation` | 0 | exit 0 |
| `009-aroma-observer` | 0 | exit 0 |
| `010-aroma-convergence` | 1 | FAIL: assertion `tests/aroma/convergence-live.test.mjs:591` expected undefined Current observation; not replayed after updates. |
| `011-aroma-recovery` | 1 | FAIL: recovery suite had failures; see archived log, stale result. |
| `012-aroma-projections` | 0 | exit 0 |
| `013-aroma-capacity` | 1 | FAIL: local Attempt 691.37ms > 500ms for 10,000 lines / 1,000 wakeups. |
| `014-db-smoke` | 0 | exit 0 |
| `015-compose-smoke` | 1 | FAIL: Compose image build/typecheck had TS4111 worker row-schema property diagnostics. |
| `016-catalog-activation-live` | 0 | exit 0 |
| `017-pricing-integration` | 0 | exit 0 |
| `018-orders-owner-live-tsc` | 0 | exit 0 |
| `019-orders-owner-live` | 0 | exit 0 |
| `020-orders-concurrency` | 0 | exit 0 |
| `021-compose-recovery` | 1 | FAIL: compose recovery typecheck had TS4111 row-schema diagnostics. |

## #9 consumer gaps

Сверка с `/home/yurgusev/CoffeeOrderPlatform` (feature #9): delta #11 есть в generated client-v1, но UI consumer пока не интегрирует выбор помола.

- `apps/web/src/browser/routes/CatalogPage.tsx` не показывает `grindOptions`; `apps/web/src/browser/api/remote.ts` quote/PUT inputs и payload не передают `sourceGrindKeyHash`.
- `apps/web/src/browser/routes/OrderCardPage.tsx` quantity update строит item без grind и потеряет выбор.
- `apps/web/test/operator-flow.spec.ts` mocks Catalog/quote/PUT не содержат grind и не утверждают payload; текущие browser tests не доказывают совместимость с новым wire contract.
- `apps/web/src/browser/api/schema.ts` не исполняет `dependentRequired`, поэтому hash без обязательного `grindDisplayName` может пройти локальную проверку. Старый generated `OrderBlocker` не принимает `AROMA_QUANTITY_NOT_SUPPORTED`.
- Минимальный consumer proof без casts/second DTO: проверить #9 browser consumer против #11 generated types через изолированную временную конфигурацию/temp package, затем существующие browser tests с валидным/отсутствующим выбором. Не менять и не компилировать root #9 worktree. Доказывать typed quote+PUT request, blocker union, зависимость hash→displayName и сохранение выбора при update.

## Исходный план перед реализацией (результаты ниже)

1. Повторить contracts lint/breaking/generated/test, architecture, typecheck и lint; отдельно разрешить исторические failures convergence, capacity и Compose.
2. Узко проверить обновления: no-facts transient/restart; 30s lease и 10s heartbeat fake clock; malformed owner rows fail-closed; telemetry/readiness; 404 Rejected vs 503 UnknownOutcome; свежий Catalog proof и 404/malformed/503 fail-closed.
3. Закрыть #9 consumer proof/handoff A; проверить immutable old hashes/replay, migration upgrade/owner isolation; повторить Compose recovery.
4. Создать и проверить `evidence/handoffs/issue-11.yaml`, сверить final diff/base и свежие receipts; PR/merge остаются отдельными delivery действиями согласно issue authority.

## Ограничения

На этапе начального read-only аудита создан только этот markdown. Затем выполнены описанные ниже локальные исправления и проверки; commit и remote actions не выполнялись.


## Историческое обновление после реализации и независимого ревью — 3 октября 2026

Полный issue ещё не готов к merge. Код находится в локальном незакоммиченном
worktree `feature/11-aroma-convergence` на base
`e278aeb10e57d37485542f8668f078456074b038`; remote checkbox не изменялись.

Подтверждены на текущих проверенных срезах:

- `pnpm contracts:generate`, `pnpm contracts:lint`, `pnpm contracts:breaking`,
  `pnpm contracts:check-generated`, `pnpm contracts:test`: проходят после
  exact exception для согласованного Catalog caller; fixture отвергает
  observer/future caller и auth drift. Новое исключение не разрешает другие изменения trust surface.
- `pnpm typecheck`, `pnpm architecture:check`, `pnpm lint` проходили после
  исправления Temporal и regression fixtures. Завершающие проверки после
  Catalog/Orders delta также прошли (receipts 035–044).
- Config/worker row schemas/Gateway client/Catalog root+owner tests проходят.
  Snapshot projection из SQL переносит bigint revision/fence как строки через
  `->>`, не меняет persisted JSON и сохраняет precision. Missing item после
  LEFT JOIN остаётся `found=false`; домен сохраняет `AROMA_CONTRIBUTION_INVALID`.
- Полный preparation live-набор: 56/56, без пропусков. 100 contributions /
  10 000 cart lines / 100 Cards: 1 863,15 мс при лимите 2 000 мс;
  same-hash recovery 700,84 мс. Повтор в recovery suite: 1 917,62 / 796,13 мс.
- Live convergence проверяет новый Catalog preflight, definitive 404 rejection,
  10s/30s fake clock и before/after crash matrix. Полный recovery suite ещё RED:
  175/179 PASS, capacity 685,29 мс при лимите 500 мс; один observer transaction
  завершился `TRANSACTION_OUTCOME_UNKNOWN`. Узкий полный observer parent group
  затем прошёл 25/25, включая тот же maxLines case (700,61 мс). Этот повтор
  не превращает неуспешный полный suite в PASS.
- I11-REV-001 (P1) исправлен: Orders Confirm/reconciliation и preparation realtime
  используют одну transport sequence, выделенную под parent Order lock;
  `owner_version` сохраняет соответствующую business/projection version.
  `pnpm test:orders-faults`: 5/5. Новый live regression с настоящим Confirm,
  несколькими realtime projection changes, публичным reconciliation 202,
  exact replay и следующей командой: 1/1 PASS.

I11-REV-002 (P1) устранён в коде и подтверждён независимым ревью:
Catalog проверяет supplier snapshot по PostgreSQL clock, используя import start
из owner view. Для `originalCaller=aroma-convergence` отсутствие threshold,
stale/future/missing snapshot дают `503 CATALOG_UNAVAILABLE`; Pricing прежний.
`services.catalog-service.catalogSnapshotProof.maxAgeMs` пока не задан в YAML:
конфигурационная готовность ожидает ответа владельца. До него увеличение
количества fail-closed; число не выдумывается.

Preflight относится к **увеличению** физического количества. Уменьшение и remove
не требуют доступности Catalog и используют прежний physical key + свежий cart
GET (M11/06 §5). Для увеличения неоднозначная локальная mapping projection
закрывает mutation, mapping revision должна точно совпадать с owner proof.

План до merge, в порядке зависимостей:

1. Получить согласованный `catalogSnapshotProof.maxAgeMs` и задать owning YAML;
   stale/future/missing snapshot и прежний Pricing path уже покрыты тестами.
   Пока настройки нет, увеличение количества закрыто fail-closed.
2. Довести неизменный 10 000-line convergence evaluator до ≤500 мс, сохранив FK,
   Current/xmin/immutability, fence, точные hashes и полную нагрузку. COPY-кандидат
   не дал достаточной пользы и откатан; снятие ограничений не является исправлением.
3. Классифицировать один generic Preparation `DatabaseTransactionError` из
   synthetic 095 и readiness deadline flaps; устойчивую доступность не объявлять
   по одному successful checkpoint. После performance/config изменений выполнить
   полные `test:aroma-convergence`, `test:aroma-recovery`, `test:aroma-capacity`
   и актуальный Compose gate. Current synthetic protocol и bounded readiness
   095/096 уже PASS; прежние full recovery/capacity RED не переписаны.
4. Предъявить частичный handoff A с актуальными hashes для координации #9.
   Actual #9 consumer пока несовместим: UI не передаёт выбранный hash, generated
   schemas/enum старые, browser validator не поддерживает `dependentRequired`.
   Изменения UI не входят в ветку #11; требуется согласованная интеграция #9.
5. Обновить final handoff/эту карту по будущим receipts/source fingerprint и
   повторно проверить изменённый diff. Только затем рассматривать commit,
   push и один PR в `develop` при отдельном разрешении владельца.

Дополнительное известное поведение: новый Observer revision отменяет старый
terminal InSync proof; unchanged Desired сам по себе не создаёт автоматического
wake. Автоматическая anti-entropy policy не задана однозначно; это ограничение
фиксируется отдельно и не выдаётся за подтверждённый новый дефект.

Receipts последующих проверок: `/tmp/coffee-issue11-final-checks/`. Все числа выше
относятся к указанным локальным запускам, не к production/provider или fleet SLO.

## Текущие F evidence (приоритет над исходными B findings)

- **F01:** `/tmp/coffee-issue11-final-checks/035–044`: generation/lint/breaking/check-generated,
  contract tests 48/48, typecheck, lint, architecture, config check PASS;
  config/row schema/Gateway/Catalog root+owner 54/54 PASS. Это локальные проверки.
- **F02:** preparation source и existing live tests: transient no-facts Inbox,
  owner-local strict decoders с точными bigint strings; полная проверка 027 56/56.
  Новое транспортное sequence исправление: 030 Orders faults 5/5, 034 actual
  Confirm/realtime/HTTP reconciliation 1/1. Named suite 046 `pnpm test:aroma-preparation`
  67/67, 0 skipped: recompute 1 851,95 мс ≤2 000, same-hash 748,0 мс.
- **F03:** `tests/runtime/lifecycle.test.mjs` — worker telemetry и dynamic age,
  existing runtime lifecycle 31/31. Metrics имеют фиксированные labels;
  spans не содержат сырые rows, provider bodies или exception payload.
- **F04:** 028 полный recovery: 175/179, exit 1; 029 observer parent 25/25 после
  единичного `TRANSACTION_OUTCOME_UNKNOWN`. Все writer/role/schedule/cancel/partial
  сценарии проверены, но повтор не объявляет полный recovery PASS.
- **F05:** convergence live receipt 045: barrier/fence/no-retry/reconcile-only,
  nullable-grind exact key, definitive 404 Rejected, 10s/30s fake clock, before/after
  durable crash seams проходят; capacity RED и новый proof fixture RED описаны F06/F07.
- **F06:** `pnpm test:aroma-capacity` 045 exit 1: 10 000 lines, 1 000 wakeups,
  1 work row; local Attempt 676,43 мс >500, total 687,71 / provider 11,28 мс;
  peak in-flight 1, heap +14,7 MB / peak RSS +12 160 KiB. COPY был откатан;
  FK, Current/xmin, fence, hashes и нагрузка не ослабляются.
- **F07:** fixture proof guard менял mapping facts при той же revision и получил
  законный SQLSTATE 23514. Исправлено только test setup: повышает revision.
  Увеличение требует exact Catalog proof; уменьшение/remove обходят availability
  proof, сохраняя старый key и свежий GET. Receipt 047: исправленный proof child
  и все функциональные convergence children PASS; parent всё ещё RED только
  из-за capacity. Regex повтор непреднамеренно включил весь parent: дополнительный
  capacity результат 1 197,77 мс >500 (total 1 207,89 / provider 10,12 мс).
- **F08:** owner freshness migration 0009, Catalog DB-clock gate и optional
  owning config реализованы. Независимый review I11-REV-002 закрыт для кода;
  production threshold и Compose recovery proof пока ожидаются. Текущие Stage A
  named suites: 048 `pnpm test:pricing-integration` 51/51, 049
  `pnpm test:catalog-activation-live` 26/26, 050 actual Orders owner 4/4, без skips.
- **F09:** base/branch и scope сохранены; корневая dirty #9 рабочая директория
  не менялась, `apps/web/**` и `packages/platform-ui/**` отсутствуют в #11 diff.
  GitHub checkbox/PR/branch не менялись; публикация отдельно не разрешена.

- **F10:** локальный `evidence/handoffs/issue-11.yaml` содержит 5 accepted input
  merge SHAs с hashes Git objects и реальные изменённые outputs с текущими hashes,
  commands/results/failure matrix/limitations. `not-ready-for-merge`, self commit SHA
  отсутствует. Outputs не включают secrets, UI или immutable canonical roots.
  Частичный handoff не является принятым #9 delivery и не закрывает #11.

- **F11:** I11-REV-003 (P1): valid cart 10 000 уникальных строк с выбранным
  64-hex grind проходит Gateway и InternalApi, но превышал прежний worker limit
  1 MiB. Owning обязательный `maxResponseBytes: 2097152` добавлен в обе
  worker config группы/schema/parser; оба composition roots используют его,
  не передавая transport setting в Store. Global request limit остаётся 1 MiB.
  Existing worker-client test принимает полный 10 000-line snapshot с проверенным
  fingerprint для обоих клиентов и отвергает valid JSON с размером 2 MiB +1.
  Исправлена class-specific error assertion Observer/Convergence. Receipt 054:
  HTTP clients/safe-read прошли; общий run 49/50 из-за прямого test-only import
  transitive polyfill. Этот import заменён existing canonical `nowInstant`;
  057 lifecycle 31/31, 058 lint PASS. 052 typecheck, 053 config check и 056
  architecture также PASS после owning response bound изменения. 059 config
  unit 24/24 PASS; отдельные цифры не объявляют общий recovery gate зелёным.

- **F12:** synthetic Compose receipts 051/060 exit 1: `up --detach --wait`
  не достиг all-healthy, recovery assertions ещё не запускались. Точный повтор
  `pnpm test:compose-smoke -- --recovery-proof --no-build --keep --project-name coffee-compose-smoke-2123017-35933c79`
  подтвердил restart/fail-stop Prep и Convergence; `KafkaRuntimeError` виден
  при stop, исходный code не попал в emitted logs. Observer остаётся running,
  exit 0, readiness 503. PostgreSQL healthy и Customer readiness 200.
  Redacted trace 061 не содержит secrets/env/raw rows. После диагностики
  удалены все только owned project containers/networks/volumes, proof DB,
  generated tmpfs secrets/override; общий `coffee_postgres_data` сохранён.
  Это не успешный recovery proof. Первый edge image построен до последнего
  owning response bound изменения: успешное будущее evidence требует актуальных
  source-consistent images. Bootstrap topics/offsets в runner проверяется отдельно.

- **F13:** read-only review подтвердил smoke-only bootstrap prerequisite gap:
  runner ожидал all-healthy до создания topics/offsets durable groups. Добавлен
  recovery-only staged Kafka bootstrap всех configured topics/DLQ и начальных
  offsets четырёх durable group/topic пар; production `autoOffsetReset:error`
  сохранён. Guard до provisioning отклоняет существующий exact project Kafka
  volume, чтобы reset не затронул прежние данные. `node --check` и lint 062 PASS;
  независимое review без новых findings. Повтор 063 устранил Prep/Convergence
  restart: оба running/healthy, но Observer остаётся running/503, поэтому общий
  startup RED и recovery assertions пока не достигнуты. Safe diagnostics 064.

- **F14:** Observer startup 503 локализован diagnostic 064: live 200,
  InternalApi readiness 200, safe read Rejected 503 `AROMA_PROVIDER_UNAVAILABLE`;
  Gateway allowlisted code `ProviderCartMappingMissing`, owner binding count 0.
  Recovery fake экспортирует пустой Catalog, но запускал cart с одной незнакомой
  строкой. Recovery теперь использует existing `remove-owned-get.json` (полный
  empty snapshot); cart mutation proof сохраняет `add-one-get.json`, исходные
  assertions и точные call counts. Production runtime fail-closed не меняется.
  `node --check` PASS, независимое review без замечаний; full replay ожидается.
  Empty recovery snapshot не является proof convergence непустого Desired.

- **F15:** freshness volume guard negative proof 065: повтор при существующем
  exact project Kafka volume отклонён до provisioning/reset; pre/post IDs всех 17 containers и 7 networks совпали, volume сохранён,
  новых ресурсов не создано (069). Затем только owned cleanup прошёл. После final
  fixture/guard изменения `pnpm lint` 066 PASS и `node --check tools/compose-smoke.mjs`
  PASS. Guard refusal — ожидаемый negative result, не failure recovery acceptance.

- **F16:** только ранний edge image пересобран из текущего source existing
  `tools/docker-build.mjs` (067 exit 0; common typecheck также прошёл внутри build).
  Полная новая сборка 14 images не выполнялась. Parity receipt 068: 14/14 embedded platform YAML, config/runtime compiled
  modules и полный `/app/dist` каждого runtime совпали с текущими local hashes.
  Полный fresh-volume synthetic replay ещё выполняется; parity/build сами по
  себе не означают успешного Compose recovery acceptance.

- **F17 (4 октября локально):** fresh-volume повтор 070 завершился exit 0
  по assertions existing synthetic runner: initial all-healthy, Kafka record
  сохранён через broker recreate в том же project/volume; Postgres 5 DB/10 runtime
  roles/idempotent; ordered/rebalance/quarantine/SIGTERM/unknown-offset redelivery,
  Outbox ACK-before-finalize/Orders restart и bounded paused-broker COMMIT (2 759 мс).
  Fake provider calls: login 1/catalog 1/cart 12/post 0/put 0/delete 0; real provider
  отсутствует. Однако post-run Observer running/live с readiness 503; в allowlisted
  logs есть `DatabaseTransactionError` и Kafka readiness timeout, relay failure
  не зафиксирован. Поэтому protocol assertions PASS не закрывают устойчивую
  post-recovery readiness. Bounded observation/diagnosis и shutdown/cleanup ещё
  выполняются; полный #11 acceptance не объявляется.

- **F18:** generic Observer log скрывал DB failure code. Existing failure event
  теперь логирует только finite `DatabaseTransactionError.code` и optional
  SQLSTATE `^[0-9A-Z]{5}$`; message/query/rows/stack/metadata не логируются.
  Abort suppression, failure readiness и независимый relay не меняются.
  Existing lifecycle assertion проверяет exact safe fields/no secret.
  Текущие typecheck, lifecycle 31/31, lint и architecture PASS; reviewer без findings.
  Это diagnosis improvement, а не fix причины post-recovery 503.
  Только Observer image обновляется; новый full synthetic diagnostic ожидается.
  Verified source subset fingerprint и соответствующая запись Obsidian обновлены;
  прежний image-parity receipt 068 относится к source до этой logging правки.

- **F19:** diagnostic 075 повторил synthetic recovery protocol с exit 0, но
  post-proof Observer readiness осталась 503. Typed failure log позволил
  локализовать `DB_QUERY_FAILED`, SQLSTATE `23505`. Read-only diagnostic kept
  disposable PostgreSQL подтвердил constraint
  `outbox_messages_message_type_aggregate_ref_owner_version_key` и ровно одно
  Observation событие с `owner_version=41`, `observedRevision=40`,
  `aggregate_sequence=41`. Convergence ошибочно использовал transport sequence
  вместо authoritative observation revision; следующий Observer revision 41
  конфликтовал с этим событием. Это установленная причина post-recovery failure,
  отдельная от кратковременного Kafka readiness timeout. Изменённые stored
  Outbox bytes не переписываются; повтор после исправления требует fresh proof DB.

- **F20:** minimal fix общего Observation event: Convergence использует
  `payload.observedRevision` в `owner_version` и `envelope.aggregate.version`;
  `aggregate_sequence` остаётся независимым transport counter. Terminal
  ConvergenceChanged semantics сохранены. Existing live test проверяет два
  convergence Attempt и следующий Observer: Observation revision/version
  1/2/3 при transport sequence 1/3/5, strict envelopes и terminal sequence 2/4.
  Fixture выдаёт существующей observer role CONNECT к disposable Orders DB.
  Исполнитель проверил целевые tsc и regression child, но name filter Node 26
  включил sibling capacity; эти прерванные прогоны не считаются успешным suite.
  Финальная functional проверка 081: `COFFEE_DB_LIVE_PROOF=1 node --test
  --test-concurrency=1 --test-skip-pattern='capacity:'
  tests/aroma/convergence-live.test.mjs` exit 0, 72 PASS / 0 FAIL. Capacity case
  отсутствует в TAP и workload не выполнялся; Node summary skipped=0 не означает
  capacity PASS. Source subset fingerprint:
  `88c74ae764f28d2e056d197dce4753b47966fa70cc7046ae5e5dc7098d7630c5`.

- **F21 / I11-REV-005 (P1):** related contract review подтвердил ещё один
  счётчик mismatch: preparation wake использует уникальную transport/intent
  version, но convergence decoder требовал её равенства `payload.desiredRevision`.
  Повторный OperatorRequested для неизменного Desired тогда quarantined;
  polling мог маскировать потерю wake. Provenance дополнительно искал
  `Inbox.owner_version=desiredRevision`. Producer version нельзя заменить
  Desired revision: разные operator intents столкнутся по Outbox UNIQUE.
  Исправлены consumer scope binding и поиск authoritative Desired в payload,
  без изменения wire/producers; реальные emitted wakes и Inbox/provenance
  проверяются в существующих live tests.

- **F22:** I11-REV-005 functional verification 083: existing Convergence live
  suite с `--test-skip-pattern='capacity:'` завершился exit 0, 73 PASS / 0 FAIL;
  capacity workload не запускался (filtered, Node summary skipped=0).
  Реальный `processKafkaRecord` → SQL Inbox → `handleWake` сохраняет Processed
  без quarantine при stream version != Desired; текущий DB revision guard и
  terminal event correlation/causation проверены. Source subset (12 files,
  включая convergence decoder):
  `053b31fbb182b57bb539a3be4db3ebc6030ab597aacf7872085e037470c22da2`.

- **F23:** full preparation verification 084 `pnpm test:aroma-preparation`
  exit 0, 67/67 PASS без skips. Real emitted repeated operator intents для
  неизменного Desired после observation stream advance проходят строгий
  decoder, Inbox Processed/no-quarantine. Required capacity — 100 contributions,
  10 000 lines, 100 cards: 1907,09 мс ≤2000 мс, same-hash recovery 710,34 мс.
  085 `pnpm lint` exit 0. Это не PASS convergence capacity ≤500 мс.
  Независимое повторное ревью подтвердило I11-REV-005 устранённым: type/scope
  validation, current DB Desired guard и producer wire сохранены; новых
  существенных замечаний в этом delta нет. Финальный Compose proof по текущему
  Convergence image ожидается отдельно.

- **F24:** current Convergence image build 086 exit 0; 087 config/runtime/app-dist
  parity 4/4 с текущим деревом (preceding 068: 14/14, 074: Observer rebuild).
  Fresh Compose 088 завершил Kafka retention и достиг healthy всех 17
  services, но one-shot Preparation readiness checkpoint истёк до начала
  native foundation/Outbox ACK/paused-broker assertions:
  client 900 мс < runtime/Kafka metadata deadline 1000 мс. 089/090 diagnostic:
  Observer ready/live/metrics 200, DB unique conflict отсутствует; другие 13/14
  runtimes отвечают 200. Preparation live/metrics 200; ready 503 за 1042 мс,
  200 за 561 и 1008 мс при diagnostic-only deadline 3s. Все четыре owner Kafka
  groups Stable, partitions assigned, lag=0. Это intermittent dependency
  readiness, не доказанная постоянная потеря группы. 088 exit 1 сохраняется;
  diagnostic extended deadline не считается acceptance.
- **F25:** smoke-only final checkpoint теперь переиспользует существующий
  `waitForRuntimeReadiness` с ожиданием фактического 200 в 10s polling window.
  Probe exception даёт sentinel 0, сохраняется в final cause, не превращается
  в 200/503; permanent failure завершает proof ошибкой. Live/metrics и nginx
  остаются обязательными. Production client/runtime/Kafka budgets не изменены.
  `node --check` и 091 lint PASS; independent review без существенных замечаний.
  Это eventual readiness после recovery, не proof устойчивой доступности.
  Polling deadline не является новым hard wall-clock limit для синхронного
  Docker exec; это прежнее ограничение helper. Fresh full repeat — F26/F27.

- **F26:** current-source fresh recovery proof 095
  `pnpm test:compose-smoke -- --recovery-proof --no-build --keep
  --project-name coffee-compose-smoke-2123017-35933c79` exit 0, полный JSON:
  Kafka retained record после broker recreate, 5 DB/10 runtime roles/idempotent
  migrations, native ordered/rebalance/quarantine/SIGTERM, Outbox recovery,
  paused-broker unknown offset recovery прошли. Scoped synthetic credentials,
  stub secrets отсутствуют; local fake provider calls login=1/catalog=1/cart=14,
  post=0/put=0/delete=0. Это controlled synthetic proof, не real provider
  acceptance. Post-protocol bounded readiness/log/cleanup receipt ожидается.

- **F27:** 096 post-protocol mTLS — все 14 runtimes live/ready/metrics 200/200/200
  на первой пробе с прежним 900ms client; Preparation — 776 мс. Все 17 Compose
  containers healthy. Observer logs: 0 DB/relay/readiness failures, 0 SQLSTATE23505.
  Preparation в 15m log window: 7 Kafka readiness RuntimeError и один generic
  DatabaseTransactionError; точный DB code неизвестен, ошибка не объявлена
  устранённой. Это proof eventual recovery, не steady availability.
  099 stop/down/owned cleanup: 14 runtime exit0, Kafka requested TERM143,
  OOM=false; project containers/networks/volumes=0, proof DB/tmpfs/override
  удалены, shared `coffee_postgres_data` сохранена. Remote/provider/production
  writes не выполнялись. I11-REV-005 и Observation counter fix прошли independent
  review; текущие merge gates перечислены в плане, status not-ready-for-merge.

- **F28 (4 октября 2026, повтор оставшихся gates):** 101 `pnpm typecheck`
  exit 0; 102 full runtime lifecycle — 31/31 PASS. Preparation безопасно
  классифицирует этап `recover|runOnce`, typed DB code и валидный SQLSTATE;
  raw message/query/payload не логируются. Runtime readiness сохраняет
  `RUNTIME_READINESS_DEADLINE` в allowlisted log без изменения predicate/budget.
  Историческую generic ошибку из 096 ретроспективно классифицировать нельзя:
  необходимые поля не были сохранены, прежние ресурсы очищены.
  103 capacity — exit 1: Convergence 707,685 мс >500 мс, Preparation
  2009,641 мс >2000 мс; 72 остальных проверки PASS. Native-array/unnest
  кандидат не доказал выигрыша. 104 временный профиль прежнего 10k/1k
  workload: normalization 141,34 мс, Observed SQL 422,92 мс,
  Desired query/decode/map 41,14 мс, diff 30,02 мс. Временная instrumentation
  восстановлена byte-for-byte; thresholds, workload и constraints не ослаблены.
  Это не новый capacity/recovery PASS; следующий SQL профиль ещё ожидается.

- **F29:** consumer #9 интегрируется локально в управляемом checkout
  `/home/yurgusev/.codex/worktrees/issue-9-11-integration/CoffeeOrderPlatform`
  от `adfca3f9df79a180ce84539c12c956e55c7e3b41` с backend delta #11 от
  `e278aeb10e57d37485542f8668f078456074b038`. Manifest/lock/generator объединены
  с сохранением #9 browser scripts и Catalog runtime schemas; UI paths #11
  остаются вне backend ветки. 105 frozen install, 106 generation,
  107 byte-identical generated check PASS. Client OpenAPI SHA-256
  `ac38aee5ff2f3bcf023f05e57aa59d778bf09d56c55dc50862d8bf397edc776c`
  и generated types SHA-256
  `0a80a2845bc8030473065d10fa42071505b63cadd46078cec1acf89513637be1`
  совпадают с backend input. 110 web query/schema — 15/15 PASS после build;
  108 до build не разрешал отсутствующий dist export и сохраняется как FAIL.
  109 routes: typecheck/UI/Vite build PASS, stale-grind scenario FAIL.
  Установлено отсутствие `PRICING_GRIND_NOT_AVAILABLE` в terminal create-quote
  classification browser client; исправление локально подготовлено, повтор
  routes/idempotency ожидается. Consumer acceptance пока не объявлена.

- **F30:** 114 web idempotency — Vitest 6/6 и browser flow PASS; 115 routes —
  PASS после terminal classification `PRICING_GRIND_NOT_AVAILABLE` для
  create-quote 422 и исправления test selector. Independent review выявил
  I9-11REV001: исчезнувший выбранный hash становился невидимым в Catalog.
  Исправление сохраняет видимое недоступное значение и явный выбор отсутствия;
  121 повтор выявил только неверное ожидание visibility native `<option>`.
  Проверка attached/disabled и текущего combobox value подготовлена, повтор 124
  ожидается. Замечание пока не объявлено закрытым.

- **F31:** array/unnest кандидат полностью удалён. Rollback SQL профиль 112
  сохранил FK, уникальность, Current/xmin guard и форматные проверки; сравнение
  `en_US.utf8` с `C` для строго ASCII Observed identity показало примерно
  428 →302 мс. Forward migration 0023 меняет только collation offer/hash.
  One-shot SHA-256 сохраняет exact bytes, deterministic diff выбирает minimum
  key линейно. 116 typecheck PASS; 120 schema — 40/40 PASS, включая metadata,
  accepted corpus, уникальность/FK и guards. 118 полный capacity остаётся FAIL:
  Convergence 581,170 мс >500; Preparation 2064,250 мс >2000, остальные 72 PASS.
  122 временный phase profile: Convergence 536,022 мс >500, provider 10,505 мс;
  Preparation 1923,93 мс. Instrumentation удалена с byte-for-byte восстановлением.
  Rollback probe 123 для Desired collation дал лишь около 36 мс median выигрыша;
  production Desired schema не менялась. Full recovery 119 ещё не запускался.

- **F32:** 126 `pnpm test:web-routes` PASS после exact disabled attribute и
  ожидания render settlement. Independent review I9-11REV001 — устранено,
  новых существенных замечаний нет. Query/schema 110 (15/15), idempotency 114
  (6/6 + browser) и routes 126 проверяют consumer #9 на authoritative backend
  input. Локальные source hashes и границы: [consumer proof](issue-9-11-consumer.md).
  Это local integrated browser proof; remote acceptance/merge не выполнялись.

- **F33:** 125 CPU probes отвергнуты: nullable schema union не быстрее на
  all-null workload; Object.assign хуже spread при идентичных bytes. Disposable
  owner DB direct COPY в 0023 schema: median 260,23 мс против JSONB 324,89 мс;
  один bounded chunk, exact NULL/decimal/readback, FK 23503 и statement/row
  guards сохранены. Но 127 full capacity не подтвердил end-to-end выигрыш:
  Convergence 582,053 мс >500 (provider 11,718 мс), Preparation 1896,766 мс PASS;
  70 PASS / 5 FAIL. Три additional fault-seam checks не прошли после замены
  INSERT на COPY; новый путь пока не принят. Проверка причин и phase profile
  128 ожидаются. Recovery не запускался и не объявлен PASS.

- **F34:** владелец утвердил `catalogSnapshotProof.maxAgeMs = 7200000` (2 часа).
  Значение задано в reference YAML; docs15/23 фиксируют решение 4 октября 2026,
  hourly import / 15m activation и возраст от import start. No default и
  explicit missing fail-closed сохранены; config test проверяет отсутствие
  удалением поля из clone. `mutationsEnabled=false` не менялся. Checks132/133
  ожидаются; значение не объявлено проверенным до их выполнения.

- **F35:** 132 `pnpm config:check` PASS (15 runtimes), config tests24/24 PASS;
  133 `pnpm test:catalog-activation-live` — typecheck и26/26 PASS. Утверждённый
  порог7200000ms задан только Catalog owner; no-default/missing/future/stale
  fail-closed и прежняя Pricing семантика сохранены.
  129 SQL sort rollback profile: удаление ORDER BY даёт около13ms суммарно;
  callers выбора разницы/recovery не зависят от порядка. 130 symmetric EXCEPT
  equality profile дал лишь17ms; не внедрён. 131 one-pass FULL JOIN equality
  fact — median17,86ms vs41,61ms fetch/strict decode/diff. Exact negative
  quantity/missing/extra/NULL-hash/representability cases PASS в probe;
  production implementation и полный capacity/recovery ещё ожидаются.

- **F36:** 134 полный `pnpm test:aroma-capacity` — 76/76 PASS, без пропусков:
  Convergence local424,583ms / provider10,280ms / total434,864ms; Preparation
  1998,981ms, same-hash701,16ms. Неизменные10000lines/1000wakes/1workrow/peak1
  и100contributions/100cards/0blockers. Приняты exact NoOp SQL fact, bounded
  Observed COPY и прежние guards; положительный mutation использует pure planner.
  135 integration contracts generate/check PASS, backend OpenAPI/types bytes
  совпадают с consumer input; это локальный proof, не remote acceptance.

- **F37:** 136 полный recovery181/183 FAIL: capacity418,331ms иPreparation
  1883,291ms PASS, единственный child failure — fake-clock initial lease
  30000,001ms вместо30000ms (также parent FAIL). Причина — разные PostgreSQL
  clock_timestamp вызовы для полей одной lease. Acquire/heartbeat теперь берут
  один MATERIALIZED DB clock; live expiry/fence guards сохранены, tolerance
  не введён. 137 recovery180/183 FAIL: fake-clock PASS, но capacity508,129ms
  при500ms; before verification/terminal commit fault seam не достигнут.
  Preparation1965,766ms PASS. 138/139 не запускались. Предыдущий успешный134
  не закрывает current full recovery gate; оба сбоя требуют проверки причины.

- **F38:** независимое performance/COPY/NoOp/0023/lease review не обнаружило
  новых существенных замечаний. COPY использует strict-normalized ASCII fields,
  прежнюю transaction и FK/unique/Current/xmin/fence guards; exact SQL NoOp
  разрешён после unknown barrier, при отсутствии blockers, не выбирает mutation.
  MATERIALIZED clock не замораживает live expiry checks. Reviewed store SHA256
  `58f1c180840a3f029301c5377d4c02c677300a536bc1a84771d55d4d3c56ff09`.
  Это ревью корректности текущего среза, не acceptance двух failures137;
  следующий implementation delta требует повторного review.

- **F39:** diagnostic140a/b с child-only name filter не запускали вложенный
  сценарий и не считаются proof. Parent regex140c запустил весь convergence
  parent: capacity441,061ms PASS, затем fake-clock child завис до180s timeout,
  остальные children отменены. Disposable harness после timeout удалён.
  Read-only trace подтвердил гонку fixture: heartbeatDone разрешался после
  UPDATE, до COMMIT и регистрации следующего recursive timer. setImmediate и
  SELECT1 на другом Client не являются барьером. Запланирован явный barrier
  регистрации следующего10s timer, без изменения30s/10s production contracts,
  точных assertions или tolerance. Полный gate остаётся RED до проверки fix.

- **F40:** 142 managed integration checkout: `pnpm contracts:lint`,
  `pnpm contracts:breaking`, `pnpm contracts:test`48/48,
  `pnpm versions:check`, `pnpm architecture:check`, `pnpm db:smoke` — всеPASS.
  Contracts12schemas/3OpenAPI; Node26.8.1/TS7.0.2 exactpins прежние.
  db:smoke — только structural owner-local SQL/role proof, liveDatabase=false,
  realKafka=false. Неизменные contract inputs135 проверены; общий recovery gate
  остаётся RED. Backend temporary profile удалён, store58f1 побайтно восстановлен;
  clock fixture теперь ждёт recursive timer registration, isolated child87ms PASS.
  Verification/terminal fault seam isolated1,234s PASS, hidden error137 не
  воспроизведён; diagnostic assertion сохраняет cause для следующего full run.

- **F41:** 143 rollback probe для `sanitized_line_hash COLLATE "C"`: owner
  assignments3345/3345 совпали,52 error cases/2UNKNOWN сохранены;1112063 UTF8
  scalars, regex mismatches0, char(64)/NOT NULL прежние. Первый corpus run
  остановился из-за ошибки временного harness (callback result не возвращался),
  после исправления capture повторPASS; оба disposableDB удалены.
  Чередующаяся default/C/default/C проба на каждом10000Desired/1000wakes:
  local483,0/426,3/505,2/470,6ms, COPY285,5/258,1/263,3/257,1ms.
  Two-sample median: local494,1→448,5ms (около45,7ms), COPY274,4→257,6ms.
  Small n не является final gate. Probe-only code удалён exact restore.
  Root принял минимальный кандидат: третий ASCII hash field добавить в ещё
  неопубликованную/незакоммиченную0023, не создавать0024; existing schema corpus
  и metadata расширяются, constraints/FK/current/xmin/fence/hashes прежние.
  Полные source-consistent suites после этой правки ещё ожидаются.

- **F42:** production кандидат143 принят в неопубликованную0023: C для
  offer_ref/source_grind_key_hash/sanitized_line_hash. Полный existing schema
  suite40/40 PASS: populated+clean0001..0023, owner assignments3345, UTF8
  scalar parity1112063 и constraints/grants/guards snapshots. Syntax/tsc и
  принудительный Convergence build PASS, PROFILE markers отсутствуют в dist.
  Сравнительный143 probe использовал одинаковый compiled module с inactive
  phase counters; это controlled comparison, не final uninstrumented gate.
  Migration SHA2565db599c2fdd378029a66a32f34320987aac057cf537eddbf521c0ba5e1a0386b;
  schema test5e8f7b0e675c5281786a4989ee934aba2994cd660ca45a6bdd190d593f50335f;
  clock/cause testf50acc35b9d10020c03a1e09ea0f932ded5955c83f2a220751b12a503b545c2e;
  store58f1 прежний. Все4 final paths byte-identical наложены в managed #9+#11.
  Начата unfiltered serial series144–149 с stop-on-first-failure, затем150
  canonical static checks. Никакой PASS до фактического завершения не заявлен.

- **F43:** 144 managed `pnpm test:aroma-recovery` —183/183 PASS,0skips,
  embeddedtscPASS; local433,641/provider10,444/total444,085ms,10000lines/
  1000wakes/1workrow/peak1; Preparation1857,720ms/samehash724,713ms,
  100contributions/100cards/0blockers. Exact clock, all fault matrix and
  Observer lost-COMMIT recovery PASS. Independent finaldelta review — новых
  существенных замечаний нет, reviewed hashes F42/unchangedstore58f1.
  145 named `pnpm test:aroma-convergence` —91/93 FAIL,0skips: единственный
  childfailure capacity892,607ms (provider11,371,total903,979; workload прежний).
  Queue146+ остановлена; успешный144 не закрывает capacity/reproducibility.
  Root начинает bounded cause trace CPU/SQL/waits в том же named context,
  без предположения внешней причины и без изменения порога. Независимые gates
 146–148/150–153 и freshCompose diagnosis выполняются отдельно от opencapacity.

- **F44:** 146 full projections113tests:112PASS/1FAIL,0skips; existing
  OrderCard regression обнаружил отсутствующий `AROMA_CART_ITEM_NOT_FOUND`
  в public enum при уже сохраняемом definitive404→Blocked. Preparation1895,816ms
  иschema/reconciliation частиPASS. Узкая исправленная enum/schema не добавляет
  новый physical outcome: Card теперь принимает stable reason существующего
  owner path. Правка3managedcontractfiles reconciled с backend154 nativegen;
  primary9 untouched. Backend/managed OpenAPI SHA69b4ae3c7522abcb3e8a0927552507219bbab2b5bfd34bc0c28538384c921974;
  types7e1aabbed1355a2e37f97fa142c24495febcbf5323a386a59d19012e9e6cb42e.
  Managed runtime schemas сохраняют Catalog defs; SHA369d395e54f53f63b79f935bc52e8d28ca94f3b4eca7f174a1916f1440358c26.
  155 typecheck/Card10/10 PASS; full156/remaining gates ожидаются. Новая API
  операция/поля/raw provider data не введены, UI source прежний. Generic/perf
  причина145 не установлена: предположение о missing concurrency flag опровергнуто
  первой строкой actual log, оба144/145 используют --test-concurrency=1.

- **F45:** 156 `pnpm test:aroma-projections`113/113 PASS,0skips; exact0023
  schema/guards, public Card blocker иreconciliation подтверждены. Prep capacity
 1839,477ms/2000 (100contributions/10000lines/100cards/0blockers), samehash780,118ms.
  Source20file subset FP282f53393ecebd81bc5afda02e6f74be66bc10bbc9604713176126746d23e9ea
  включает public/gencode, поэтому Card delta не скрывается прежним17fileFP.
  147/148/150/151–153 начаты последовательно; PASS до завершения не заявлен.

- **F46:** текущие named gates147 Preparation67/67 и148 Observer40/40 PASS,
  без пропусков. Preparation1880,348ms/samehash714,213ms; Observer lost-COMMIT,
  freshness/fence и owner-role recovery PASS. 150 lint обнаружил только
  no-floating-promises в test COPY-hook: rejection callback передан явно как
  `error => callback(error)`; production code, fault boundaries и assertions
  прежние. Новый test SHA91cae465…; повтор150 и consumer151–153 ожидаются.
  Current convergence145 всё ещё892,607ms, bounded CPU/SQL/wait capture ожидается.

- **F47:** 150 after-fix lint/contracts lint/breaking/48tests/check-generated/
  config15runtimes PASS; generated combined fingerprint260e58a4f5db7bae8178d2d60b32abbfdffec0d556d128606458ad7b3c2dadb1.
  151 accessibility/build PASS. 152 fullPlaywright FAIL: CSRF change during
  intent preparation waited30s for «Требуется вход» (operator-flow.spec.ts698),
  web build PASS;153 bundle не запускался. Это открытый consumer gate, причина
  исследуется. Independent additiveCard enum/test-handler review: nofindings;
  OpenAPI/types/runtime schemas/Cataloggrind dependentRequired согласованы.
  Scoped diffcheck и327 unique checkbox IDs PASS; capacity145 остаётся RED.

- **F48:** 157 один bounded named-context diagnostic с неизменными10k/1k/500ms:
  local450,599/provider10,611/total461,210ms; SQLawait349,594ms, COPY264,234ms,
  COMMIT35,941ms, Desired15,032ms, residual101,005ms; CPU168,031ms,ELU0,293,
  context switches131/1. Это diagnostic with temporary nested capacity selection,
  не полный named gate. Spike145 не воспроизведён; причина неизвестна.
  Previous wake-up inbox1000span1077,797ms вне attempt и в metric не включён.
  Temporary selector/timers удалены exactrestoretest91cae465; forcefulltscPASS,
  source/dist markers absent. Без доказанной причины новый performance patch
  не добавлен; полные finalnamed gates будут проверены после sourcefreeze/cleanup.

- **F49:** I9-11REV002 existing CSRF test oracle исправлен только в consumer
  integration: once session invalidation flag + intent cleanup wait вместо
  transient UI. Rotation/noPOST/noStorage/cookie cleanup прежние. 158 idempotency
  6/6+browser,159 fullPlaywright,153bundle139524/256000B,160lint всеPASS.
  Independent narrow review finding closed/no new findings; test SHA218c2e55…;
  UI7file currentFP98bb2c30774b3e2480caebbd19c21a26996fda7a044b9cbbcc7c995e72c5e232.
  BackendUIpaths/primary9 untouched. Fresh fullbuildCompose161 начат на sealed
  runtime/contracts source; capacitynamed final gates после exactcleanup (итог F54).

- **F50:** fresh Compose161 (full-build flags, build ещё не достигнут) projectcoffee-i11-recovery-20261004055028-3740553
  остановлен до runtime-window: runner «Query read timeout» в bootstrap временной proofDB.
  162healthwindow NOTRUN, safeevents counts0 означают отсутствие runtimeproof,
  не устранение historicalPrep096. Exit1 выводится из runnercatch/wrapperpath;
  terminalprocessreceipt недоступен. 163 trapneedsreview: ранний отказ не позволил
  снять14runtime+Kafka exit/OOMsnapshot; readonly exactownedresiduecheck PASS
  (containers/networks/proofDB/volume/tmpfs отсутствуют, sharednetwork unchanged).
  Privatecapture DockerActionexec_* содержал commandtext: allowlistfilter
  уточняется и createdartifacts sanitization выполняется, rawtokens не выводятся.
  Причина proofDBtimeout исследуется отдельно; final164–166 начинаются после
  cleanup, freshCompose требуется повторить после подтверждённой причины.

- **F51:** finalnamed164 `pnpm test:aroma-convergence`93/93 PASS,0skips,
  embeddedtscPASS. Local456,387/provider10,457/total466,844ms, unchanged10k/1k/
  peak1; all callback/shutdown/fault/lease/fence/fakeclock PASS. Это полный gate,
  а не diagnostic157. Named165capacity/166recovery ещё выполняются; historical
  145 spike892,607ms сохраняется с неизвестной причиной, не переименован вPASS.

- **F52:** finalcapacity165 `pnpm test:aroma-capacity`76/76PASS,0skips,tscPASS.
  Convergence439,868/provider10,397/total450,265ms (10k/1k/workrow1/peak1);
  Preparation1887,330ms<=2000,100contributions/100cards/0blockers, samehash722,968ms.
  166 fullrecoveryrunning; embeddedConvergence449,080msPASS, не finalfullPASS
  до получения commandexit. No newsource edits after157 capture restored.

- **F53:** readonly trace161 уточнил: plainPG «Query read timeout» возникает
  после hostconnectionretry helper, в direct bootstrap/migration query до
  buildRuntimeImages. КлиентproofDB задаётquery/statement2000ms; readyloops
  имеют собственные prefixed errors. Exactcaller неизвестен из genericcatch;
  это не runtime Preparation event. Approved следующий single diagnostic
  stage capture в existing runner с exactrestore, без изменения2sbudgets/SQL.
  PrivateDockerAction allowlist/exitstatus persistence исправляются отдельно.

- **F54:** finalunfiltered164/165/166 всеPASS безskip/cancel, embeddedtscPASS.
  164Convergence93/93 local456,387ms;165capacity76/76 local439,868ms и
  Preparation1887,330ms/samehash722,968;166fullrecovery183/183 local449,080ms
  provider11,051,total460,131,Preparation1858,619/samehash709,709. Workload10k/1k/
  row1/peak1 и100contributions/100cards/0blockers прежние. LostCOMMIT,lease/fence,
  exactclock/completefaultmatrix/ownerroles PASS. Historical145892,607ms причина
  неизвестна; successfulfinalmetrics не бессрочная SLO/remoteCI claim. Fresh
  Compose classification/health window всё ещё pending после161earlybootstrapfail.

- **F55:** fresh167 full-build/native recovery protocol observedexit0,
  projectcoffee-i11-recovery-20261004061146-3771630, dbIntegrationProoftrue,
  runtimes14. 168:98runtime rows=7rounds×14×3 scopedmTLS endpoints,294200;
  eachround17/17healthy. Sampletimestamps06:32:06–06:33:42UTC,10s pauses
  плюс выполнение probes (не ровно70s). 169:14finalruntimeexit0,Kafka143,
  15OOMfalse; exactownedcleanupPASS/sharedcoffee_postgres_datanetwork unchanged.
  SafeeventsummaryPrep0/relay0/readiness14/unparsed0; все14code
  RUNTIME_READINESS_DEADLINE/dependencykafka. Temporalgroups:10nearKafka
  recreate (одинObserverevent37msдоDockerstop),2duringpause,2Prepafterrestart
  beforehealthy. Cause задержек не доказана; window readiness failures0.
  Prep2earlydie/start пары06:28:37/42; earlierexit/OOMcause неизвестны,
  finalexit0 их не классифицирует. Historical096genericDBcauseUNKNOWN.
  Finalruntimecontractreview: новых нарушений нет; false/timeout readiness,
  bounded restart/fail-stop допускаются owningcontracts. Rawexec_* actions
  discarded доpersistence; old161artifacts sanitized. Temporaryrunner exact
  restored2f11b2c698de9376b9b5d805dd71cc12b972c8a4c0b531ec07147f6582217b69,
  node--check/diffcheckPASS. Root самостоятельно проверил98/294/17/15 counters
  иobservedexit0. Summary /tmp/coffee-issue11-final-checks/167-169-fresh-compose-summary.json.

- **F56:** Root final verification: finalprotocolJSON dbIntegrationProoftrue,
  runtimes14; native ordered/rebalance/quarantine/SIGTERM/DB-before-offset/
  OutboxACK/pausedbroker flags проверены. Fakeproviderlogin1/catalog1/cart13,
  unsafe0. Exactprojectresourcescontainers/networks0,proofPG/Kafkavolume/
  override absent, sharednetworkpresent; workertrap verifiedidentity unchanged.
  Primary tracked diff byte-identical initialsnapshotSHA970d4a9e…; backend
  иmanaged diffchecksPASS. UIpatch7files/SHAcce43a231… сохранён отдельно.
  Handoff currentoutputs пересчитаны; canonicalroots/remotecheckbox untouched.

- **F57:** P1 review PR171: Orders сохраняет DB timestamp с микросекундами,
  но `to_char(...SS.MS...)`/Temporal сериализуют confirmedAt/requestedAt до
  миллисекунд. Исправлены две SQL equality в Preparation через
  date_trunc('milliseconds',stored_at), без округления/tolerance и без изменения
  producer, immutable History/Outbox, wire/schema/migrations. Существующие seed
  fixtures также используют producer millisecond precision. Детерминированный
  isolated PG trigger задаёт `.123456`; настоящий OrderStore выдаёт `.123`.
  red.log воспроизвёл Quarantined Confirm вместо Processed; после первого SQL fix
  red-reconciliation.log воспроизвёл Quarantined intent вместо Processed.

- **F58:** После timestamp fix regression выявил AROMA_PREPARATION_DATABASE_ROW_INVALID:
  существующий write_card_projection no-op возвращает текущий Card counter и
  старый snapshot counter после core command. Row decoder следует этому contract:
  material_change=true требует equality, false допускает snapshot<=Card; positive
  int64 Schema и BigInt сохраняются, future snapshot отклонён. Existing real-store
  regression проверяет delivery двух типов, public request/replay, undelivered
  второй intent → restart/recover/runOnce, одну cart wake на каждый intent,
  Processed Inbox/0 quarantine для genuine событий, unchanged immutable History
  и source Outbox bytes/hashes. Wrong confirmedAt и несовместимые counters rejected.
  Independent read-only reviewer: существенных findings нет; tests/build не запускал.

- **F59:** /tmp/coffee-issue11-timestamp-fix: pnpm test:aroma-preparation67/67 PASS,
  pnpm test:aroma-recovery183/183 PASS,0skip/0cancel; обе команды включали tsc.
  Preparation1876.573599ms/samehash710.977253; recovery Preparation1944.458597ms/
  samehash681.570955; convergence local464.217610/provider10.804549/total475.022159ms.
  Нагрузка10000lines/1000wakes/1workrow/peak1 и thresholds unchanged. Первый lint
  FAIL require-array-sort-compare; добавлен только explicit ASCII comparator в
  assertion, runtime без изменений. pnpm lint final PASS, selected real-store
  regression green-final1/1 PASS; git diff --check и node --check PASS.
  red/failed receipts сохранены. Fresh Compose/browser после fix не повторялись;
  old167–169 proof относится к предыдущему source. Историческая generic DB error
  не классифицируется задним числом. Unsafe/provider/production mutations отсутствуют.


- **F60:** Review P2: общий blocker guard запрещал удаление/уменьшение по
  прежнему physical key после исключения недоступного вклада из Desired.
  Теперь при blockers только из `MAPPING_CHANGED|MAPPING_MISSING|MAPPING_STOPPED|
  PRODUCT_UNAVAILABLE` planner выбирает первый lexicographic cleanup diff;
  положительные изменения и смешанные hard blockers запрещены. Сохраняются
  complete fresh GET, reservation barrier, fence/current Desired checks и
  максимум одна unsafe mutation на Attempt. Catalog proof требуется только
  для положительного изменения; cleanup не меняет frozen physical key.
  Planner сохраняет прежний линейный проход и создаёт объект только для
  выбранной строки. После проверки cleanup terminal остаётся `Blocked` с
  исходными codes. Если проверка доказала применение и остался другой
  безопасный diff, существующий durable work получает следующий wake-up;
  positive-only/no diff не создаёт hot loop. После lost ACK RecoveredApplied
  остаётся reconcile-only (unsafe=0); оставшийся cleanup получает wake-up для
  отдельной Attempt с новым operationRef. Прежний operationRef не повторяется.
  RecoveredNotApplied не включает этот дополнительный cleanup wake.

- **F61:** Existing owner-role PostgreSQL/fake Gateway regression проверяет
  Remove с прежним grind hash, decrease, mixed positive-before-cleanup,
  positive-only запрет, Stopped cleanup, mixed hard blocker fail-closed и две
  устаревшие строки: две `Blocked` Attempt, по одному Remove, затем idle.
  Worker final `pnpm test:aroma-convergence`94/94 PASS (встроенный tsc),
  local Attempt437.5ms<=500. Final `pnpm test:aroma-recovery`184/184 PASS,
  0fail/skip/cancel; local Attempt430.197970ms/provider10.251678ms,
  Preparation1877.101ms<=2000/same-hash707.134ms. Raw receipts
  `/tmp/coffee-pr171-172-fixes-20261005/backend`; mutationsEnabled=false.
  Это изолированная локальная проверка; Compose/browser-through-Edge/production
  после нового cleanup fix ещё не повторялись.


- **F62:** Финальный source после recovery correction: `pnpm test:aroma-convergence`
  94/94 PASS, `pnpm test:aroma-recovery`184/184 PASS, 0fail/skip/cancel; обе
  команды включают tsc. Local Attempt453.449603ms/provider11.464204ms в
  convergence и431.726903ms/provider10.441706ms в recovery, threshold500ms;
  Preparation1843.763788ms<=2000. `pnpm lint`exit0. Отдельная capacity suite
  до последней recovery-ветки:77/77, local472.264ms/Preparation1927.484ms;
  финальный recovery повторно проверяет обе capacity нагрузки на новом source.
  Raw post-recovery-fix logs в `/tmp/coffee-pr171-172-fixes-20261005/backend`.
  Lost ACK при двух obsolete keys: первая mutation UnknownOutcome, fresh
  recovery разрешает reservation в RecoveredApplied (старый Attempt неизменен),
  unsafe=0/selected_action=null/Blocked/dirty=true; отдельная следующая Attempt
  выполняет оставшийся Remove новым operationRef, prior reservation больше не
  меняется, dirty=false и idle. Независимое повторное ревью по diff3384569:
  CLEANUP-RECOVERY-WAKE устранено, существенных новых findings нет.
  `git diff --check` PASS; generic historical DB cause остаётся UNKNOWN.
  Compose, browser-through-Edge, CI, accepted merge и deployment не подтверждены
  для нового source; реальные provider mutations не выполнялись.
