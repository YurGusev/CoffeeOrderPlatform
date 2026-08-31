# AROMA Gateway: точный журнал mutation

Статус: нормативное дополнение к issue #10/#11. Gateway владеет только
технической идемпотентностью provider-вызова; business Desired/Attempt и решение
о повторной попытке остаются в Orders.

## Хранилище

`001_provider_sessions.sql` и `002_provider_mutation_journal.sql` создают в
`coffee_platform_integration` таблицу `provider_mutation_journal`:

```text
operation_ref varchar(30) PRIMARY KEY; cart_scope_ref varchar(64);
action SetQuantity|Remove; offer_ref varchar(30); quantity_milli bigint NULL;
request_hash char(64); correlation_id uuid; traceparent varchar(128);
state Prepared|Dispatched|Acknowledged|Rejected|UnknownOutcome;
provider_status_code integer NULL; outcome_hash char(64) NULL;
failure_code varchar(64) NULL; created_at/dispatched_at/completed_at/last_seen_at.
```

`Dispatched` фиксируется отдельной короткой transaction до unsafe HTTP.
Timeout, обрыв или невалидный ответ после dispatch дают `UnknownOutcome`.
Provider body, cookies, credentials, PII и полный cart не сохраняются.

## Повтор операции

- тот же `operationRef` и другой hash: `409 AROMA_OPERATION_REF_CONFLICT`;
- тот же hash + `Acknowledged`: сохранённый typed response без HTTP;
- тот же hash + `Rejected`: сохранённый Problem без HTTP;
- `Prepared|Dispatched`: `409 AROMA_OPERATION_IN_PROGRESS` без HTTP;
- `UnknownOutcome`: `409 AROMA_OPERATION_UNKNOWN_OUTCOME` без HTTP.

Gateway никогда повторно не отправляет mutation с тем же `operationRef`.
Convergence после unknown начинает новую Attempt с fresh GET и сверяет свою
reservation. Retention terminal rows — 30 дней; удаление разрешено только после
проверки отсутствия незавершённой Orders reservation.

## Обязательные тесты

Replay acknowledged/rejected; hash conflict; crash до/после dispatch; lost
response; concurrent одинаковый operationRef; ровно один provider call;
redaction; Gateway без grants к Orders; Orders без grants к Integration DB.
