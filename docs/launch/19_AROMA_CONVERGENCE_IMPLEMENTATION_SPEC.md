# Исполнимая спецификация Orders-owned AROMA convergence

Статус: нормативная спецификация issue #11. Исполнитель не выбирает scope,
таблицы, lease/fence, порядок внешних вызовов или recovery semantics заново.

## 1. Один physical cart scope

В первом запуске существует один scope `cartScopeRef="aroma-primary"`,
соответствующий одному AROMA account/cart. Несколько Confirmed Orders дают
вклады в один Desired cart; независимый convergence «по одному Order» запрещён,
потому что он перезаписывал бы вклад остальных заказов.

#8 при Confirm сохраняет immutable `order_desired_contributions` и публикует
только `OrderConfirmed.v1`. #11 агрегирует все актуальные contributions в
`cart_desired_revisions`; только после commit новой cart revision публикуется
`AromaConvergenceRequested.v1`.

## 2. Runtime и роли

| Runtime | Читает | Пишет | HTTP |
|---|---|---|---|
| `orders-aroma-preparation` / `coffee_orders_prepare_rw` | Order contributions/items, mapping projection, Inbox | mapping projection, cart Desired, Inbox, Outbox | нет |
| `aroma-observer` / `coffee_orders_observer_rw` | current Desired, Inbox | Observed, Inbox, Outbox | только safe cart GET |
| `aroma-convergence` / `coffee_orders_convergence_rw` | Desired/Observed/mapping, Inbox | Attempt/Lease/Fence/Reservation/Observed/Inbox/Outbox | typed cart GET/set/remove |

Ни один runtime не получает provider credentials или Integration/Catalog DB.

## 3. Миграции #11

1. `007_create_orders_inbox.sql`;
2. `008_create_catalog_mapping_projection.sql`;
3. `009_create_cart_desired.sql`;
4. `010_create_cart_observed.sql`;
5. `011_create_convergence_attempts.sql`;
6. `012_create_convergence_leases.sql`;
7. `013_create_mutation_reservations.sql`.
8. `014_create_order_aroma_projections.sql`.

### Inbox и mapping projection

`inbox_messages`: PK `(consumer_name,message_id)`, message type/key/version,
payload hash, received/processed timestamps и result. Один message с другим
payload hash -> quarantine `MESSAGE_ID_PAYLOAD_CONFLICT`.

`catalog_mapping_projection`: PK `(product_ref,variant_ref)`, `offer_ref`
nullable, `mapping_revision`, `catalog_snapshot_revision`, `mapping_state`
`Active|Missing|Stopped`, `availability` `Available|Unavailable|Stopped`,
`effective_at`, `source_message_id`. Update только если incoming revision больше;
equal+same payload = no-op, lower = stale no-op, equal+different = quarantine.

### Cart Desired

`cart_desired_revisions`: PK `(cart_scope_ref,desired_revision bigint)`,
`state Current|Superseded`, `desired_hash`, `source_max_order_version`,
`created_at`; partial unique один Current на scope.

`cart_desired_lines`: PK `(cart_scope_ref,desired_revision,offer_ref)`,
`quantity_milli bigint >0`, `contribution_hash`, `contributing_order_refs jsonb`.
Refs в JSON отсортированы; rows сортируются по `offer_ref` для hash.

Blocked contributions хранятся в `cart_desired_blockers`: product/variant/order,
code `MAPPING_MISSING|MAPPING_STOPPED|PRODUCT_UNAVAILABLE`, mapping revision.
Они не превращаются в provider line и не удаляют прежний Desired до commit
полностью вычисленной новой revision.

### Observed

`cart_observed_revisions`: PK `(cart_scope_ref,observed_revision bigint)`,
`provider_snapshot_ref`, `cart_fingerprint`, `captured_at`, `saved_at`,
`source_attempt_ref`, `fence_epoch`; один Current. `complete` всегда true:
partial/failed GET вообще не создаёт revision.

`cart_observed_lines`: PK `(cart_scope_ref,observed_revision,offer_ref)`,
`quantity_milli bigint >0`, sanitized line hash. Отсутствующий offer означает
quantity zero только после complete snapshot.

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
`offer_ref`, `observed_before_milli`, `desired_milli`, `request_hash`, state
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
2. для каждой contribution использовать offer из подтверждённого snapshot,
   пока mapping Active/Available и revision не объявила его Stopped/Missing;
3. агрегировать `quantityMilli` по offerRef с bigint overflow guard;
4. сформировать blockers для недопустимых положительных quantities;
5. вычислить canonical Desired hash;
6. если hash совпал с Current — завершить Inbox без новой revision/event;
7. иначе одной transaction Supersede old, Insert next revision/lines/blockers,
   Outbox `AromaConvergenceRequested.v1(reason=OrderConfirmed|CatalogChanged)`;
8. commit Kafka offset только после transaction commit.

## 5. Safe observer

Gateway `getCartSnapshot()` возвращает только complete typed response:
`providerSnapshotRef`, `capturedAt`, `cartFingerprint`, `lines[]` с unique
`offerRef` и positive canonical quantity. Deadline 10s, максимум два GET
attempts с delay 250ms только до получения response bytes.

Observer валидирует schema, uniqueness, count/fingerprint и сохраняет новую
Observed revision одной transaction вместе с Inbox/Outbox
`AromaObservationChanged.v1`. Failed/partial/invalid/timeout GET записывает
sanitized operational failure, но не создаёт пустой Observed и не меняет Current.

## 6. Lease и fence

Acquire выполняется одной SQL statement/transaction только если lease отсутствует
или `expires_at <= transaction_timestamp()`:

```text
owner_instance_id = новый UUID
fence_epoch = previous + 1 (или 1)
expires_at = transaction_timestamp() + 30s
```

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
4. Если Observed равен Desired по всем offers/quantities, сохранить
   `NoOpInSync`, событие `InSync`, освободить lease; mutations=0.
5. Если есть blockers, Attempt=`Blocked`; positive mutation для blocked mapping
   запрещена.
6. Выбрать ровно одну разницу: offers сортируются lexicographic; первый diff.
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
    wake-up. В этой Attempt второй diff не исправляется.
13. Terminal Attempt + reservation + Observed(optional) + Outbox пишутся одной
    transaction; lease освобождается conditional UPDATE.

## 8. Recovery UnknownOutcome

Новая Attempt всегда начинает с fresh GET. Для незавершённой reservation:

- physical line равна `desiredMilli` -> `RecoveredApplied`, mutation=0;
- physical line равна `observedBeforeMilli` -> `RecoveredNotApplied`; после
  полного сравнения новая Attempt может создать новый operationRef/mutation;
- другое значение -> сохранить новое Observed, оставить blocker
  `AROMA_EXTERNAL_CHANGE`, mutation=0 до следующего explicit/durable wake-up.

Старый `operationRef` никогда не отправляется повторно. Kafka replay только
будит state machine и не является разрешением mutation.

## 9. Reconciliation command

`POST /api/client-v1/orders/{orderRef}/commands/request-aroma-reconciliation`
реализуется в `orders-service`, но входит в #11.

Body `{expectedVersion,reason}`; Idempotency-Key обязателен. Transaction:
Order lock, Confirmed/status/version/action check, version +1, History
`ReconciliationRequested`, Outbox `AromaConvergenceRequested.v1` reason
`OperatorRequested`, completed idempotency. Команда не меняет Desired/Observed,
не получает lease и не вызывает Gateway. Exact replay возвращает исходный 202.

## 10. Events и Order Card

### Per-Order projection

Cart result никогда не подменяет Order state напрямую. Orders DB содержит
`cart_desired_order_facts(cart_scope_ref,desired_revision,order_ref,
contribution_revision,contribution_hash)` и
`order_aroma_projections(cart_scope_ref,order_ref,projection_version,
desired_revision,desired_hash,observed_revision,observed_cart_fingerprint,
verified_desired_revision,verified_desired_hash,verified_observed_revision,
verified_cart_fingerprint,attempt_ref,fence_epoch,state,blocker_codes,
changed_at,source_message_id)`.

Impacted Orders — объединение order refs прежней и новой Desired revision;
поэтому remap/remove не теряет заказ, исчезнувший из Current. В terminal
transaction worker пересчитывает каждую проекцию, увеличивает её собственный
`projection_version` только при material change и пишет по одному
`RealtimeInvalidated.v1` с `subjectRef=orderRef` и
`ownerVersion=projectionVersion`. Это не `Order.version`: AROMA меняется без
команды над aggregate.

`InSync` допустим только для terminal `NoOpInSync|VerifiedInSync`, когда current
Desired revision/hash совпадают с verified Desired, complete Current Observed
revision/fingerprint — с verified Observed, fence относится к Attempt, нет
blocker/UnknownOutcome, а contribution revision/hash конкретного Order актуальны.
Числовое равенство Desired и Observed revisions ничего не доказывает.

`AromaObservationChanged.v1` публикуется только после complete Observed commit.
`AromaConvergenceChanged.v1` публикуется для terminal Attempt. Payload не
содержит cart lines; только refs/revisions/state/blocker codes/fingerprint.
`RealtimeInvalidated.v1` лишь инвалидирует Order Card.

Order Card использует precedence и `allowedActions` из Orders specification.
`InSync` разрешён только для current Desired + complete Current Observed +
current fence terminal proof.

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
