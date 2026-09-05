# AROMA Gateway: точный журнал mutation

Статус: нормативное дополнение к issue #10/#11. Gateway владеет только
технической идемпотентностью provider-вызова; business Desired/Attempt и решение
о повторной попытке остаются в Orders.

## Хранилище

`0001_provider_sessions.sql` и `0002_provider_mutation_journal.sql` создают в
`coffee_platform_integration` таблицу `provider_mutation_journal`:

```text
operation_ref varchar(30) PRIMARY KEY; cart_scope_ref varchar(64);
operation_kind SetLineQuantity|RemoveLine; offer_ref varchar(30); quantity_milli bigint NULL;
request_hash char(64); caller_identity varchar(64); original_caller varchar(64);
operation_id varchar(128); correlation_id uuid; traceparent varchar(128);
state Reserved|Dispatched|Acknowledged|Rejected|UnknownOutcome;
reservation_owner uuid; lease_until timestamptz;
provider_status_code integer NULL; outcome_hash char(64) NULL;
failure_code varchar(64) NULL; response_status smallint NULL;
response_body_bytes bytea NULL; created_at/started_at/dispatched_at/completed_at/last_seen_at.
```

`operation_kind` — транспортная операция Gateway: Orders `SetQuantity` отображается
в `SetLineQuantity`, `Remove` — в `RemoveLine`. Canonical request hash включает
operation/offer/quantity и trusted caller; `original_caller`/`operation_id`
проверяются из signed delegation до reserve/replay.

`Dispatched` фиксируется CAS отдельной короткой transaction до unsafe HTTP.
Timeout, обрыв или невалидный ответ после dispatch дают `UnknownOutcome`.
Provider body, cookies, credentials, PII и полный cart не сохраняются.

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
reservation. Gateway не читает Orders DB. Terminal retention — 90 дней и
должен превышать максимальный Orders recovery horizon; cleanup использует
только Integration-owned state/age. Orders хранит operationRef не менее 90 дней.

## Обязательные тесты

Replay acknowledged/rejected; hash conflict; crash до/после dispatch; lost
response; concurrent одинаковый operationRef; ровно один provider call;
redaction; Gateway без grants к Orders; Orders без grants к Integration DB.
