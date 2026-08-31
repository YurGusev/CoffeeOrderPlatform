# M19. Errors, Idempotency и UnknownOutcome

## 1. Stable error taxonomy

Все HTTP actor surfaces используют общую семантику ошибок, даже если DTO projection отличается.

```text
Validation
NotFound
Unauthorized
Forbidden
Conflict
RateLimited
ExternalDependency
UnknownOutcome
Internal
```

## 2. Problem response

Рекомендуемая форма:

```json
{
  "type": "https://coffee/errors/order-version-conflict",
  "title": "Conflict",
  "status": 409,
  "errorCode": "order_version_conflict",
  "traceId": "...",
  "details": {}
}
```

Не отдавать stack trace/provider secret/raw SQL.

## 3. `409 Conflict`

`409` — нормальный domain concurrency outcome для:

- `rowVersion` mismatch;
- stale confirmation proof;
- current-state conflict;
- ownership/runtime epoch conflict.

Клиент должен fresh-read, а не blind retry.

## 4. Idempotency

Idempotency key обязателен для operations, которые могут быть replayed transport/runtime layer и имеют side effect.

Ключ должен быть server/transport-derived там, где caller не должен выбирать scope.

Примеры:

```text
payment create/refund
agent order mutation
channel delivery
provider command
Kafka consumer eventId Inbox
```

## 5. Retry ownership

Каждая операция имеет один явный retry owner.

Не допускается cascade:

```text
Nginx retry x3
Node retry x3
Hermes retry x3
API retry x3
provider retry x3
```

Retry policy учитывает total deadline, jitter, idempotency и provider semantics.

## 6. UnknownOutcome

UnknownOutcome означает:

> side effect мог произойти, но вызывающий слой не имеет доказательства результата.

Примеры:

- payment create accepted, response lost;
- AROMA unsafe mutation accepted, connection lost;
- Hermes run accepted, dispatcher lost `run_id` response;
- unsafe browser command timed out after server may have committed.

## 7. Правило UnknownOutcome

Не:

```text
unknown -> retry same unsafe command immediately
```

А:

```text
unknown
 -> persist uncertain state
 -> fresh read/reconciliation/provider lookup
 -> prove outcome
 -> only then decide next action
```

## 8. HTTP status mapping

Не обязательно вводить нестандартный HTTP status для UnknownOutcome. Допустим стабильный application `errorCode`/accepted operation state, главное — одинаковая semantics для caller и no-blind-retry policy.

## 9. Browser behavior

React после unsafe unknown result:

- не показывает «не выполнено» как факт;
- не повторяет POST автоматически;
- выполняет fresh authoritative read;
- блокирует/объясняет повтор до resolution, если операция high-risk.

## 10. Hermes behavior

Hermes tool result должен явно различать:

```text
success
business conflict
retryable read failure
unsafe outcome unknown
```

Модель не должна интерпретировать transport exception как доказательство того, что mutation не произошёл.
