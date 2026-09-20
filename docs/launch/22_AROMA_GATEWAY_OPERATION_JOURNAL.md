# AROMA Gateway: точный журнал mutation

Статус: нормативное дополнение к issue #10/#11. Gateway владеет только
технической идемпотентностью provider-вызова; business Desired/Attempt и решение
о повторной попытке остаются в Orders.

## Хранилище

`0002_provider_mutation_journal.sql` создаёт в
`coffee_platform_integration` таблицу `provider_mutation_journal`:

`0001_provider_sessions.sql` создаёт в `coffee_platform_integration` encrypted-only
cookie storage. `ProviderSessionManager` выполняет concurrent single-flight login,
хранит decrypted cookies только в памяти Gateway и очищает их при shutdown.
`BOUNDED_LOCAL_SESSION_CACHE` ограничен 5 минутами и 32 scope entries; это локальная
reuse policy, а не provider TTL/refresh semantics. Явный expiry cookie имеет приоритет.
Для safe pre-dispatch read разрешён один bounded re-auth после подтверждённого
authentication failure; concurrent readers используют single-flight login. После
partial output или unsafe mutation dispatch re-auth/replay запрещён. Provider
TTL/refresh semantics по-прежнему не установлены. Журнал не хранит provider
session payload.

```text
operation_ref varchar(30) PRIMARY KEY; cart_scope_ref varchar(64);
operation_kind SetLineQuantity|RemoveLine; offer_ref varchar(30); quantity_milli positive bigint for Set, NULL for Remove;
source_grind_key_hash char(64) NULL — forward migration 0007;
request_hash char(64); caller_identity varchar(64); original_caller varchar(64);
operation_id varchar(128); correlation_id uuid; traceparent varchar(128);
state Reserved|Dispatched|Acknowledged|Rejected|UnknownOutcome;
reservation_owner uuid; lease_until timestamptz;
provider_status_code integer NULL; outcome_hash char(64) NULL;
failure_code varchar(64) NULL; response_status smallint NULL;
response_body_bytes bytea NULL; created_at/started_at/dispatched_at/completed_at/last_seen_at;
retention_until timestamptz NOT NULL — не ранее 90 дней после terminal completion.
```

`operation_kind` — транспортная операция Gateway: Orders `SetQuantity` отображается
в `SetLineQuantity` только при строго положительном количестве, `Remove` — в
`RemoveLine` с `NULL`. Canonical request hash включает
operation/offer/quantity, выбранный `sourceGrindKeyHash` и trusted caller; `original_caller`/`operation_id`
проверяются из signed delegation до reserve/replay.

`Dispatched` фиксируется CAS отдельной короткой transaction до unsafe HTTP.
Timeout, обрыв или невалидный ответ после dispatch дают `UnknownOutcome`.
Provider body, cookies, credentials, PII и полный cart не сохраняются.

`response_body_bytes` принимает только Gateway-generated typed response по существующему
`internal-v1` контракту: для `Acknowledged` — точный `AromaMutationResponse`, для
`Rejected` — точный RFC 9457 `ProblemDetails` с согласованными status/code. Невалидные
JSON bytes, неверные поля или несогласованный status не доходят до terminal persistence;
они маркируются как `AROMA_PROVIDER_INVALID_RESPONSE` и переводят operation в
`UnknownOutcome`.

Если COMMIT reserve возвращает `TRANSACTION_OUTCOME_UNKNOWN`, bounded reread по
`operationRef` повторяет полную `sameRequest`-проверку исходных request hash,
cart scope, operation, offer, quantity, выбранный помол и trusted caller/delegation. Чужая row
возвращает `AROMA_OPERATION_REF_CONFLICT`; она не может стать replay исходного
запроса. Отсутствующая row возвращает safe `UnknownOutcome`.

Если COMMIT transaction terminal persistence возвращает `TRANSACTION_OUTCOME_UNKNOWN`,
`ProviderMutationJournalStore` выполняет один bounded reread той же durable row по
`operationRef`, не повторяя provider dispatch. Сохранённая terminal row возвращается
как replay; если terminal row отсутствует (включая оставшуюся `Dispatched` row), наружу
возвращается safe `UnknownOutcome`. Никакой blind retry или повторная отправка provider
не допускается.

## Повтор операции

- тот же `operationRef` и другой hash/caller/operation: `409 AROMA_OPERATION_REF_CONFLICT`;
- тот же hash + `Acknowledged`: byte-equivalent сохранённый typed response без HTTP;
- тот же hash + `Rejected`: сохранённый Problem без HTTP;
- active `Reserved`: `409 AROMA_OPERATION_IN_PROGRESS` без HTTP;
- expired `Reserved`: новый owner CAS-захватывает lease и имеет право на один
  первый dispatch; loser не вызывает provider;
- `Dispatched` без terminal outcome после restart переводится в
  `UnknownOutcome` и никогда не dispatch повторно;
- `UnknownOutcome`: `409 AROMA_OPERATION_UNKNOWN_OUTCOME` без HTTP.

Gateway никогда повторно не отправляет mutation с тем же `operationRef`.
Convergence после unknown начинает новую Attempt с fresh GET и сверяет свою
reservation. Gateway не читает Orders DB. Terminal retention — 90 дней от
`completed_at` для каждой terminal transition; он превышает максимальный Orders
recovery horizon; cleanup использует только Integration-owned state/age. Orders
хранит operationRef не менее 90 дней.

## Обязательные тесты

Replay acknowledged/rejected; hash conflict, включая competing row после
неопределённого reserve COMMIT; crash до/после dispatch; lost response;
concurrent одинаковый operationRef; ровно один provider call;
redaction; Gateway без grants к Orders; Orders без grants к Integration DB.

## Выбор помола и совместимость журнала

Оператор выбирает помол через Catalog/Orders. Gateway принимает только opaque
`sourceGrindKeyHash` из своего справочника, разрешает его в raw provider ID
внутри Gateway и проверяет полный cart key до и после mutation. В fingerprint
и durable row входит выбранный hash. Тот же `operationRef` с другим помолом —
конфликт, а не replay. Acknowledgement обязан подтверждать тот же выбор.

Для запросов без помола canonical request bytes/hash сохранены; nullable
колонка не меняет старые terminal responses. Forward migration `0007` не
переписывает старые операции и не разрешает повторный dispatch.

## Исполнимое ограничение количества

Количество — целое число упаковок/штук по решению владельца. Gateway принимает
`1..Number.MAX_SAFE_INTEGER`; верхняя граница — предел точного JSON-number
представления транспорта, а не объявленный максимум AROMA. Ноль, дробь и выход
за этот предел отклоняются до reserve/dispatch. Фактические ограничения AROMA
(остаток, максимум для товара или аккаунта) не выдумываются: отказ после
возможного dispatch обрабатывается существующим durable протоколом, без retry.
Неизвестный универсальный максимум поставщика не превращается в разрешение
на округление, fractional packages или слепой повтор запроса.
