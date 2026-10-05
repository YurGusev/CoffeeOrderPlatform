# Исполнимая спецификация Orders-owned AROMA convergence

Статус: нормативная спецификация issue #11. Исполнитель не выбирает scope,
таблицы, lease/fence, порядок внешних вызовов или recovery semantics заново.

Первый этап #11 замыкает backend-контракт помола по
[утверждённым границам #9/#11](30_AROMA_GRIND_CONTRACT_AND_PARALLEL_DELIVERY.md).
Выбор в proof/Order, физическая идентичность и дополнительные обязательные
проверки из этого документа применяются к таблицам и алгоритмам ниже.

## 1. Один physical cart scope

В первом запуске существует один scope `cartScopeRef="aroma-primary"`,
соответствующий одному AROMA account/cart. Несколько Confirmed Orders дают
вклады в один Desired cart; независимый convergence «по одному Order» запрещён,
потому что он перезаписывал бы вклад остальных заказов.

#8 при Confirm сохраняет immutable `order_desired_contributions` и публикует
`OrderConfirmed.v1`. Отдельный public reconciliation command #8 публикует
`OrderReconciliationRequested.v1` только после принятия order-level намерения.
Orders producer сериализует `confirmedAt` и `requestedAt` до миллисекунд без
округления; сохранённые `confirmed_at` и History `occurred_at` сохраняют
микросекунды. Preparation сравнивает `date_trunc('milliseconds', stored_at)`
с timestamp из события. Version/contribution/source identity и exact immutable
Outbox envelope продолжают проверяться; History/Outbox bytes не переписываются.
#11 агрегирует все актуальные contributions в
`cart_desired_revisions`; wake-up новой revision публикуется через owner Outbox.
По [ADR-0032](../adr/ADR-0032-order-reconciliation-intent.md) order-level
operator intent создаёт durable `AromaConvergenceRequested.v1` с причиной
`OperatorRequested` также при неизменившемся Desired hash: новая revision
для этого не требуется, а successful no-op вместо wake-up запрещён.
`aggregate.version`/Outbox `owner_version` такого wake-up обозначают его
уникальную позицию в owner stream и могут отличаться от `payload.desiredRevision`.
Convergence использует revision из payload только как hint и будит работу лишь
при совпадении с текущим Orders-owned `convergence_work.desired_revision`.

## 2. Runtime и роли

| Runtime | Читает | Пишет | HTTP |
|---|---|---|---|
| `orders-aroma-preparation` / `coffee_orders_prepare_rw` | Order contributions/items, mapping projection, Inbox | mapping projection, cart Desired, Inbox, Outbox | нет |
| `aroma-observer` / `coffee_orders_observer_rw` | current Desired, Inbox | Observed, Inbox, Outbox | только safe cart GET |
| `aroma-convergence` / `coffee_orders_convergence_rw` | Desired/Observed/mapping, Inbox | Attempt/Lease/Fence/Reservation/Observed/Inbox/Outbox | typed cart GET/set/remove |

Ни один runtime не получает provider credentials или Integration/Catalog DB.

## 3. Миграции #11

После `0007_order_grind_selection.sql` из этапа A, без переименования уже опубликованных миграций:

1. `0008_create_orders_inbox.sql`;
2. `0009_create_catalog_mapping_projection.sql`;
3. `0010_create_cart_desired.sql`;
4. `0011_create_cart_observed.sql`;
5. `0012_create_convergence_attempts.sql`;
6. `0013_create_convergence_leases.sql`;
7. `0014_create_mutation_reservations.sql`;
8. `0015_create_order_aroma_projections.sql`;
9. `0016_create_aroma_work_schedules.sql`;
10. `0017_allow_cart_outbox.sql`;
11. `0018_guard_order_card_projection.sql`;
12. `0019_read_guarded_aroma_card.sql`;
13. `0020_guard_cart_fact_batches.sql`;
14. `0021_optimize_observed_format_checks.sql`;
15. `0022_terminal_cart_item_rejection.sql`;
16. `0023_ascii_observed_identity.sql`.

`0023` задаёт `COLLATE "C"` для трёх ASCII-полей Observed:
`offer_ref`, `source_grind_key_hash` и `sanitized_line_hash`. Типы, accepted
bytes и форматные проверки не меняются; UNIQUE-индекс перестраивается только
для двух полей ключа, FK, append-only и Current/xmin guards сохраняются.
В rollback-пробе на одинаковом 10 000-line/1 000-wakeup NoOp workload два
замера дали медиану local Attempt 494.1 мс при default collation и 448.5 мс
при `C`; медиана только COPY составила 274.4 и 257.6 мс соответственно.
Корпус принял одинаковые 3 345 owner assignments и 52 assignment errors;
проверка 1 112 063 UTF-8 scalar values нашла ноль различий regex. Все четыре
timing samples использовали одну и ту же сборку с выключенными phase counters;
финальная сборка выполняется из production source без instrumentation. Это
сравнение малой выборки подтверждает выбранное узкое изменение, но не является
заявлением, что каждый Attempt укладывается в SLO.

Normalizer использует штатный one-shot SHA-256 с прежними canonical JSON
bytes. Evaluator выбирает lexicographic minimum среди всех различий линейным
проходом; входы по-прежнему полностью проверяются независимо от порядка строк,
включая все количества Desired.
### Inbox и mapping projection

`inbox_messages`: PK `(consumer_name,message_id)`, message type/key/version,
payload hash, received/processed timestamps и result. Один message с другим
payload hash -> quarantine `MESSAGE_ID_PAYLOAD_CONFLICT`.

`catalog_mapping_projection`: PK `(product_ref,variant_ref)`, `offer_ref`
nullable, `mapping_revision`, `catalog_snapshot_revision`, `mapping_state`
`Active|Missing|Stopped`, `availability` `Available|Unavailable|Stopped`,
`effective_at`, `source_message_id`. Update только если incoming revision больше;
equal+same payload = no-op, lower = stale no-op, equal+different = quarantine.

Permanent/invalid owner rejection откатывает всю обработку сообщения, включая
частичные owner effects и Inbox acquisition. Только после подтверждённого
rollback Kafka coordinator открывает отдельную transaction: повторно получает
Inbox lease, фиксирует terminal `Quarantined` и source-keyed quarantine с полным
envelope и причиной. `consumer_name` берётся из настроенного consumer group,
а topic/partition/offset — из реального record. Offset commit допустим только
после известного COMMIT этой transaction. Transient error, failed quarantine и
неизвестный COMMIT/ROLLBACK не разрешают offset commit; replay terminal rejection
не выполняет owner handler повторно. Ловить permanent error внутри owner
transaction и коммитить её частичные изменения запрещено.

### Cart Desired

`cart_desired_revisions`: PK `(cart_scope_ref,desired_revision bigint)`,
`state Current|Superseded`, `desired_hash`, `source_max_order_version`,
`created_at`; partial unique один Current на scope.

`cart_desired_lines`: unique key `NULLS NOT DISTINCT`
`(cart_scope_ref,desired_revision,offer_ref,source_grind_key_hash)`, optional
hash nullable; `quantity_milli bigint >0`, `contribution_hash`,
`contributing_order_refs jsonb`. Refs в JSON отсортированы; rows сортируются
по `offer_ref`, затем absence-before-hash и hash для canonical identity.

Blocked contributions хранятся в `cart_desired_blockers`: product/variant/order,
code `MAPPING_CHANGED|MAPPING_MISSING|MAPPING_STOPPED|PRODUCT_UNAVAILABLE`, mapping revision.
Они не превращаются в provider line и не удаляют прежний Desired до commit
полностью вычисленной новой revision.

### Observed

`cart_observed_revisions`: PK `(cart_scope_ref,observed_revision bigint)`,
`provider_snapshot_ref`, `cart_fingerprint`, `captured_at`, `saved_at`,
`source_kind Observer|Convergence`, nullable `source_attempt_ref`, nullable
`fence_epoch`; один Current. CHECK: Convergence требует attempt/fence, Observer
требует оба NULL. `complete` всегда true:
partial/failed GET вообще не создаёт revision.

`cart_observed_lines`: unique key `NULLS NOT DISTINCT`
`(cart_scope_ref,observed_revision,offer_ref,source_grind_key_hash)`, optional
hash nullable; `quantity_milli bigint >0`, sanitized line hash. Отсутствующий
полный line key означает quantity zero только после complete snapshot.
Convergence сохраняет нормализованный вектор одной `COPY` непосредственно в
эту таблицу, в той же transaction: FK, unique key и statement guards остаются
на пути записи. Для `NoOpInSync` Orders сравнивает полный Desired/Observed
вектор одним SQL `FULL JOIN` по ASCII offer/hash identity и exact quantity;
отсутствующий grind hash сопоставляется отдельным пустым sentinel, который
невозможен для валидного hash. Строгий boolean decoder и проверки допустимого
provider quantity обязательны. При mismatch остаётся обычный strict row decode
и бизнес-diff; ошибки SQL или декодирования не считаются равенством.

### Attempt, lease/fence и reservation

`convergence_attempts`: `attempt_ref` PK, scope, desired/observed start/end
revisions, `fence_epoch`, state
`Started|Observed|NoOpInSync|MutationReserved|MutationDispatched|VerifiedInSync|OutOfSync|Blocked|UnknownOutcome|Failed`,
selected offer/action, failure/blockers, timestamps. Terminal state immutable.

`convergence_leases`: `cart_scope_ref` PK, `owner_instance_id uuid`,
`fence_epoch bigint`, `acquired_at`, `heartbeat_at`, `expires_at`. Epoch только
увеличивается.

`mutation_reservations`: `operation_ref` PK (`op_<ULID>`), unique
`(attempt_ref)`, scope/desired revision/fence, action `SetQuantity|Remove`,
`offer_ref`, optional `source_grind_key_hash`, `observed_before_milli`,
`desired_milli`, `request_hash`, state
`Reserved|Dispatched|Acknowledged|Verified|RecoveredApplied|RecoveredNotApplied|UnknownOutcome`,
Gateway outcome hash и timestamps. Одна Attempt имеет максимум одну reservation.

## 4. Preparation

`OrderConfirmed.v1` и `CatalogMappingChanged.v2` обрабатываются одной DB
transaction: Inbox insert/lock, revision guard, projection/contribution read,
recompute и optional Desired/Outbox.

`CatalogMappingChanged.v2` обязан содержать `productRef`, `variantRef`,
`offerRef|null`, `mappingRevision`, `catalogSnapshotRevision`, `mappingState`,
`availability`, `effectiveAt`. Это малый owner fact, не полный Catalog row.

Алгоритм recompute:

1. прочитать все contributions Confirmed Orders и актуальные mapping facts;
2. для каждой contribution использовать только frozen `offerRef` подтверждённого
   Order. Текущий mapping с тем же offer и Active/Available разрешает строку;
   другой non-null offer → `MAPPING_CHANGED`; null/Missing → `MAPPING_MISSING`;
   Stopped → `MAPPING_STOPPED`; Unavailable → `PRODUCT_UNAVAILABLE`;
3. агрегировать `quantityMilli` по `(offerRef,sourceGrindKeyHash-or-absence)`
   с bigint overflow guard и точной проверкой представимости целыми упаковками;
4. сформировать blockers для недопустимых положительных quantities;
5. вычислить canonical Desired hash;
6. если hash совпал с Current — завершить Inbox без новой revision/event;
7. иначе одной transaction Supersede old, Insert next revision/lines/blockers,
   Outbox `AromaConvergenceRequested.v1(reason=OrderConfirmed|CatalogChanged)`;
8. commit Kafka offset только после transaction commit.

Confirmed Order никогда автоматически не remap на другой provider offer: quote,
unit и semantics были подтверждены для frozen mapping. Новый offer требует
нового Draft/quote либо будущей явной replacement/re-quote command.

## 5. Safe observer

Gateway `getCartSnapshot()` возвращает только complete typed response:
`providerSnapshotRef`, `capturedAt`, `cartFingerprint`, `lines[]` с unique
`offerRef` и positive canonical quantity. Deadline 10s, максимум два GET
attempts с delay 250ms только до получения response bytes.

Observer валидирует schema, uniqueness, count/fingerprint и сохраняет новую
Observed revision одной transaction вместе с Inbox/Outbox
`AromaObservationChanged.v1`. Failed/partial/invalid/timeout GET записывает
sanitized operational failure, но не создаёт пустой Observed и не меняет Current.
Для `AromaObservationChanged.v1` оба writer-а (observer и convergence) ставят
`aggregate.version` и Outbox `owner_version` равными payload `observedRevision`;
`aggregate_sequence` независимо увеличивает порядок событий этого scope.

Wire `AromaCartLine.quantity` использует `QuantityDecimal`. Общий snapshot
normalizer переводит whole/fraction отдельно через bigint в exact milli,
без floating point и округления; исходные wire quantities и fingerprint не
переписываются. Поддержка decimal observation не разрешает fractional mutation:
`providerQuantity` для Desired по-прежнему требует точного целого числа упаковок.

## 6. Lease и fence

Acquire выполняется одной SQL statement/transaction только если lease отсутствует
или `expires_at <= clock_timestamp()`:

```text
owner_instance_id = новый UUID
fence_epoch = previous + 1 (или 1)
acquired_at = heartbeat_at = один clock_timestamp() statement
expires_at = тот же clock_timestamp() + 30s
```

Acquire и heartbeat материализуют одну DB clock value для всех записываемых
timestamps в statement. Условные expiry/fence/current-Desired проверки используют
актуальный `clock_timestamp()` после ожидания блокировки.

Если lease активен у другого owner, command считается coalesced wake-up и worker
не ждёт lock/sleep. Heartbeat каждые 10s продлевает до now+30s условным UPDATE
по `(scope,owner_instance_id,fence_epoch)`.

Перед reservation, перед unsafe HTTP и перед сохранением результата выполняется
условная проверка: тот же owner/epoch, `expires_at>now`, Desired всё ещё Current.
Ноль rows означает `STALE_FENCE`; mutation не начинается, success/Observed не
сохраняется. DB lock через HTTP не удерживается.

## 7. Одна convergence Attempt

1. Acquire lease/fence; создать Attempt `Started` для current Desired.
2. Выполнить fresh safe GET через Gateway.
3. Полный GET сохранить как Observed только при current fence; Attempt=`Observed`.
4. Если нет blockers и Observed равен Desired по всем offers/quantities, сохранить
   `NoOpInSync`, событие `InSync`, освободить lease; mutations=0.
5. Если есть blockers, positive mutation запрещена. Когда все codes относятся к
   `MAPPING_CHANGED|MAPPING_MISSING|MAPPING_STOPPED|PRODUCT_UNAVAILABLE`, разрешена
   только безопасная очистка; остальные blockers запрещают любую mutation.
6. Выбрать ровно одну допустимую разницу: offers сортируются lexicographic;
   первый diff, при Catalog blockers — первый decrease/remove.
   Desired 0 -> `Remove`, иначе `SetQuantity(desiredMilli)`.
7. В короткой transaction повторно проверить lease/fence/current Desired и
   создать точную reservation `Reserved` с `operationRef`; commit.
8. Ещё раз conditional fence check; отметить `Dispatched`; выполнить ровно одну
   Gateway mutation с тем же operationRef. Automatic retry отсутствует.
9. Определённый provider reject -> Attempt `Failed|Blocked` по code, без второй
   mutation. Потеря/timeout/невалидный response -> reservation и Attempt
   `UnknownOutcome`, release lease, завершить.
10. При acknowledged response выполнить fresh verification GET.
11. Failed/partial verification GET -> `UnknownOutcome`; последнее Observed не
    очищать.
12. Complete verification сохраняется только при current fence. Если весь cart
    равен current Desired -> `VerifiedInSync`; иначе `OutOfSync` и новый durable
    wake-up. При Catalog blockers terminal остаётся `Blocked` с исходными codes;
    после подтверждённой очистки новый durable wake-up создаётся только если
    осталось другое безопасное decrease/remove. Positive-only diff не создаёт
    такой wake-up. В этой Attempt второй diff не исправляется.
13. Terminal Attempt + reservation + Observed(optional) + Outbox пишутся одной
    transaction; lease освобождается conditional UPDATE.

Уменьшение количества и remove используют прежний physical key и свежий cart GET;
недоступность товара в Catalog не блокирует cleanup.

Полный cart GET ограничен owning `aromaObservation.maxResponseBytes` либо
`aromaConvergence.maxResponseBytes` — 2 097 152 байта, как в InternalApi.
Это допускает 10 000 строк с выбранным помолом. Превышение bound остаётся
invalid response и не создаёт пустой или частичный Observed; общий HTTP request
limit не используется как лимит ответа.

Перед reservation `SetQuantity`, увеличивающего физическое количество, convergence делает read-only
owner call в Catalog `getCatalogPricingInput` и требует proof из latest complete
активного snapshot: точные product/variant/offer, `Available`, snapshot revision
не ниже локальной и точное совпадение mapping revision; выбранный grind hash должен ровно
один раз присутствовать в options. Ошибка, неполный или устаревший proof закрывает
путь в `Blocked` без mutation. Этот вызов не читает чужую БД и не обращается к
провайдеру; Orders использует только Catalog owner API.

Catalog проверяет возраст активного snapshot по DB clock относительно начала
импорта, до provider export. Порог —
`services.catalog-service.catalogSnapshotProof.maxAgeMs`; его отсутствие,
будущий timestamp, отсутствие или превышение возраста дают
`503 CATALOG_UNAVAILABLE`. Ответ не раскрывает timestamp. Проверка включается
для подписанного `originalCaller=aroma-convergence`; Pricing сохраняет прежнюю
семантику. Утверждённый предел в YAML — `7200000` мс (два часа);
отсутствие настройки по-прежнему закрывает положительные mutations.

## 8. Recovery UnknownOutcome

Новая Attempt всегда начинает с fresh GET. Для незавершённой reservation:

- physical line равна `desiredMilli` -> `RecoveredApplied`, mutation=0;
  если остаётся другой допустимый diff, новый durable wake-up продолжает
  работу отдельной Attempt. При Catalog blockers это только cleanup, а
  terminal recovery Attempt остаётся `Blocked` с исходными codes;
- physical line равна `observedBeforeMilli` -> `RecoveredNotApplied`; после
  полного сравнения новая Attempt может создать новый operationRef/mutation;
- другое значение -> сохранить новое Observed, оставить blocker
  `AROMA_EXTERNAL_CHANGE`, mutation=0 до следующего explicit/durable wake-up.

Старый `operationRef` никогда не отправляется повторно. Kafka replay только
будит state machine и не является разрешением mutation.

## 9. Reconciliation command

`POST /api/client-v1/orders/{orderRef}/commands/request-aroma-reconciliation`
реализуется и принимается в #8 через `orders-service`; #11 не реализует
второй public handler.

Body `{expectedVersion,reason}`; Idempotency-Key обязателен. Transaction:
Order lock, Confirmed/status/version/action check, version +1, History
`ReconciliationRequested`, Outbox `OrderReconciliationRequested.v1` с
`{orderRef,orderVersion,requestedAt}`, completed idempotency. Команда не меняет
Desired/Observed, не получает lease и не вызывает Gateway. Exact replay
возвращает исходный 202. Пока owner-local projection не подтверждает
`OutOfSync|Blocked|UnknownOutcome`, в том числе при `PendingObservation`,
команда отказывает без эффекта.

В #11 `orders-aroma-preparation` принимает order-level событие в прежней
`orders-aroma-preparation-v1` Inbox, связывает его с Orders History/Outbox и
проверяет **текущие** cart Desired/projection до создания отдельного
`AromaConvergenceRequested.v1(reason=OperatorRequested)` с настоящими
`cartScopeRef` и `desiredRevision`. Не потерять ожидающий intent при временном
отсутствии cart facts, duplicate/restart и Kafka retention: восстановление
через существующие History/Outbox/Inbox, без новой таблицы. Корректность
сканирования/дедупликации и cart-effect — acceptance #11, не proof #8.

## 10. Events и Order Card

### Per-Order projection

Cart result никогда не подменяет Order state напрямую. Orders DB содержит
`cart_desired_order_facts(cart_scope_ref,desired_revision,order_ref,
contribution_revision,contribution_hash)` и
`order_aroma_projections(order_ref PK/FK,cart_scope_ref,projection_version
bigint CHECK(projection_version>0),
desired_revision,desired_hash,observed_revision,observed_cart_fingerprint,
verified_desired_revision,verified_desired_hash,verified_observed_revision,
verified_cart_fingerprint,attempt_ref,verified_attempt_ref,fence_epoch,state,
blocker_codes jsonb,last_observed_at,updated_at,source_message_id)`. Unique
`(order_ref,projection_version)` хранится в append-only projection history;
Current row обновляется только через `orders.write_card_projection(orderRef,material)`.
Forward migration `0018` закрывает прямые INSERT/UPDATE projection table для
runtime-роли. Entry point сериализует изменения по Order, сравнивает material
facts без source message/timestamp metadata и увеличивает единый
`orders.orders.projection_version`; business `version` не меняется.
`orders-service` использует тот же entry point без material argument для
видимых Order commands. Неизменившаяся AROMA material projection не увеличивает
counter и не требует History/Realtime.
В таком no-op entry point возвращает текущий Card counter и прежний AROMA
snapshot, чей counter может быть меньше после Order command. Decoder требует
равенства counters для material change и `snapshot counter <= Card counter`
для no-op; snapshot из будущего всегда отклоняется.

Impacted Orders — объединение order refs прежней и новой Desired revision;
поэтому remap/remove не теряет заказ, исчезнувший из Current. Единственный
writer per-Order projection/invalidation — `orders-aroma-preparation`.
Convergence атомарно фиксирует terminal Attempt и Outbox
`AromaConvergenceChanged.v1`; preparation consumer в terminal Inbox
transaction читает актуальные Orders-owned факты, пересчитывает каждую
проекцию через этот общий entry point, сохраняет его
`projection_version` в projection history только при material change и пишет по одному
`RealtimeInvalidated.v1` с `subjectRef=orderRef` и
`ownerVersion=projectionVersion`. Это не `Order.version`: AROMA меняется без
команды над aggregate.

`InSync` допустим только для terminal `NoOpInSync|VerifiedInSync`, когда current
Desired revision/hash совпадают с verified Desired, complete Current Observed
revision/fingerprint — с verified Observed, epoch/owner Attempt совпадают с
сохранённым текущим fence, нет blocker конкретного Order и scope-wide reservation
`Reserved|Dispatched|Acknowledged|UnknownOutcome`, а contribution revision/hash
конкретного Order актуальны. Освобождение lease после terminal commit не меняет
epoch и само по себе не отменяет proof; takeover с новым epoch его отменяет.
Числовое равенство Desired и Observed revisions ничего не доказывает.

`AromaObservationChanged.v1` публикуется только после complete Observed commit.
`AromaConvergenceChanged.v1` публикуется для terminal Attempt. Payload не
содержит cart lines; только refs/revisions/state/blocker codes/fingerprint.
`RealtimeInvalidated.v1` лишь инвалидирует Order Card.

Event semantics не используют Card enum: Observation всегда
`observationState=Complete`; convergence публикует terminal `attemptState`.
Projection mapping: current verified `NoOpInSync|VerifiedInSync` → `InSync`;
`OutOfSync` → `OutOfSync`; `Blocked|Failed` → `Blocked` с code;
`UnknownOutcome` → `UnknownOutcome`. Новая complete Observation без актуального
terminal proof пересчитывается по Card precedence и сама не объявляет InSync.

Order Card использует precedence и `allowedActions` из Orders specification.
`InSync` разрешён только для current Desired + complete Current Observed +
current fence terminal proof.

Forward migration `0019` даёт `orders-service` только EXECUTE на guarded
`orders.read_card_projection(orderRef,maxSnapshotAgeMs)`, без SELECT на private
lease/reservation/Attempt tables. Проверка выполняется при каждом read: новая
Current Observation, takeover epoch, active lease, unresolved reservation,
устаревшая observation или изменившаяся Desired отменяют старый persisted
`InSync` даже до следующего preparation poll. Shared Card counter читается под
тем же parent Order lock, что и business facts. Reconciliation gate использует
этот persisted read и expected business version; test-only projection Map удалён.

Preparation и Orders API используют `aromaConvergence.maxSnapshotAgeMs` из
единого `config/platform.yaml` как окно terminal verification. Отсутствующая
composition config не разрешает `InSync`. Публичный `OrderBlocker.code` дополнен
только уже сохраняемыми stable AROMA reasons; владелец явно разрешил расширение
enum 3 октября 2026. Поля и формат Card не меняются; refs операций, hashes,
fence и raw provider bodies публично не выдаются. Codegen и repository
compatibility checks обязательны; результат этих checks не означает, что
старый strict consumer с прежним enum принимает новые значения.
Definitive Gateway rejection `404 AROMA_CART_ITEM_NOT_FOUND` сохраняется как
terminal `Blocked` с тем же публичным blocker code; generated Card validator
обязан принимать этот уже сохраняемый результат.

Все три executable `main.ts` подключают собственную composition root:
consumer-scoped Inbox по реальным configured groups, durable recover/runOnce,
bounded non-overlapping poll, scoped api-internal mTLS только для observer и
convergence, явную readiness и drain/close HTTP. `handleWake` получает Transaction
первым аргументом. Mutation capability остаётся false по умолчанию.
Каждый shared Orders Outbox relay ограничивает claim своими configured producer
topics; predecessor barrier остаётся общим по aggregate для всех topics, поэтому
другой publisher не может пропустить старое сообщение того же cart stream.
Ошибка нового owner/provider cycle не останавливает relay уже committed events.

## 11. Failure tests

- duplicate/out-of-order/conflicting Inbox messages;
- concurrent preparation recompute и no-op same hash;
- two convergence workers, lease expiry на каждом шаге и stale-fence writes;
- crash до/после Attempt, GET, reservation commit, mutation dispatch,
  acknowledgement, verification GET и terminal commit;
- lost mutation response и restart recovery без blind retry;
- failed/partial GET сохраняет прежний Observed;
- mapping Missing/Stopped/Unavailable block positive quantity;
- external cart change recovery;
- at most one mutation per Attempt asserted Gateway-side;
- DB grants/architecture/config/redaction/event contract/rebalance tests;
- capacity: до 100 Order contributions и 10 000 cart lines; один recompute <=2s,
  attempt без provider latency <=500ms.

## 12. Не входит

Checkout, supplier order submission, invoice/payment, multiple AROMA accounts,
blind mutation retry, generic workflow engine, distributed lock service,
Kafka-as-state и manual provider controls не входят в #11.
