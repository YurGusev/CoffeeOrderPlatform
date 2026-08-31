# M06. Event/Command Envelopes и Schema Governance

## 1. Два разных wire contracts

Integration event и integration command больше не используют один неоднозначный `messageKind` envelope.

Используются два schemas:

```text
integration-event-envelope.schema.json
integration-command-envelope.schema.json
```

## 2. Integration Event envelope

Event описывает уже произошедший факт:

```json
{
  "eventId": "evt_x",
  "eventType": "OrderConfirmed",
  "schemaVersion": 1,
  "occurredAtUtc": "2026-08-19T00:00:00Z",
  "producer": "orders",
  "aggregateType": "order",
  "aggregateId": "ord_x",
  "aggregateVersion": 17,
  "correlationId": "cor_x",
  "causationId": "cmd_x",
  "traceparent": null,
  "payload": {}
}
```

### `aggregateVersion`

Для lifecycle events aggregateVersion обязателен и монотонно отражает authoritative aggregate revision/version на момент публикации.

Consumer projection может использовать его для обнаружения stale/reordered replay:

```text
received aggregateVersion <= localAppliedVersion
-> stale/duplicate according to consumer policy
```

`aggregateVersion` не заменяет Inbox/eventId dedupe.

## 3. Integration Command envelope

Command описывает просьбу выполнить действие:

```json
{
  "commandId": "cmd_x",
  "commandType": "AgentTurnRequested",
  "schemaVersion": 1,
  "requestedAtUtc": "2026-08-19T00:00:00Z",
  "producer": "channel-intake",
  "targetType": "conversation",
  "targetId": "conv_hash",
  "idempotencyKey": "stable-operation-key",
  "deadlineAtUtc": "2026-08-19T00:01:00Z",
  "correlationId": "cor_x",
  "causationId": "evt_x",
  "traceparent": null,
  "payload": {}
}
```

`idempotencyKey` обязателен для side-effecting integration commands.

Expired `deadlineAtUtc` command не должна бесконечно исполняться как свежая. Consumer применяет command-specific expiry/reconciliation rule.

## 4. Payload schemas

Envelope validation недостаточен.

Каждый message type имеет отдельную payload schema:

```text
schemas/events/orders/OrderConfirmed.v1.schema.json
schemas/commands/agent/AgentTurnRequested.v1.schema.json
...
```

Wire contract = envelope schema + exact payload schema.

`payload: object` не считается полноценной contract validation.

## 5. Compatibility rules

Additive change допустим только если:

- новое поле optional или имеет безопасный default;
- semantics старого поля не меняется;
- consumer tolerates unknown enum/field согласно contract;
- key/money/unit/identity semantics неизменны.

Breaking change:

- смена key semantics;
- удаление required field;
- изменение значения существующего поля;
- смена money/unit representation;
- смена identity/audience semantics;
- event превращается в command или наоборот.

Breaking contract получает новую major family или новую message schema version с контролируемой migration strategy.

## 6. Git contract registry

Git остаётся source of truth:

```text
PR
-> schema change
-> lint/validation
-> compatibility check
-> consumer impact report
-> approval
-> runtime registry publish (если используется)
-> deploy
```

Producer не имеет права самостоятельно регистрировать произвольную production schema во время request processing.

## 7. Runtime Schema Registry

Runtime Schema Registry является P1 усилением при независимых deployment cadence и росте количества producers/consumers.

Допустимы реализации с JSON Schema compatibility enforcement. Confluent Schema Registry является reference implementation, но не обязательным vendor lock.

Для critical streams предпочтительны transitive compatibility policies (`BACKWARD_TRANSITIVE` или `FULL_TRANSITIVE`) после отдельного решения по upgrade order.

Git schema и runtime registered schema должны иметь deterministic identity/hash и проверяться CI.

## 8. Trace context

`traceparent` передаётся как technical metadata и не используется как business identity/idempotency key.

## 9. PII

Schemas должны явно запрещать secrets и минимизировать customer/provider data. Generic agent topics не содержат raw provider credentials/cookies/card data и не передают произвольные HTTP headers.

## 10. Acceptance

Каждый production message type имеет:

1. owner;
2. event/command classification;
3. topic;
4. partition key semantics;
5. envelope schema;
6. payload schema;
7. compatibility tests;
8. PII classification;
9. replay policy;
10. example fixture.

## 11. Official references

- Confluent Schema Registry compatibility: https://docs.confluent.io/platform/current/schema-registry/fundamentals/schema-evolution.html
- Apache Kafka API/contracts: https://kafka.apache.org/43/apis/
