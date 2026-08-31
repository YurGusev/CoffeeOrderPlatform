# M06. Replay, DLQ и Consumer Recovery

## 1. Replay не является универсально безопасным

Каждый consumer group имеет явный `replayPolicy` в topic/consumer registry.

### Класс A — read projection

Replay обычно разрешён при idempotent/upsert projection logic.

### Класс B — pure Kafka -> Kafka transform

Replay разрешён только при стабильной output idempotency/derived message identity.

### Класс C — business DB side effect

Replay только через Inbox/eventId/current-state guards.

### Класс D — external/provider side effect

Blind replay запрещён. Требуются provider idempotency, authoritative lookup/reconciliation и UnknownOutcome policy.

## 2. ReplayJob

Production replay оформляется как управляемая операция:

```text
ReplayId
SourceTopic
ConsumerGroup
Mode
FromTimestamp/Offset
ToTimestamp/Offset
DryRun
RequestedBy
ApprovedBy
Reason
CreatedAt
StartedAt
CompletedAt
Outcome
```

Modes:

```text
ProjectionRebuild
BusinessReconcile
DLQReplay
DiagnosticDryRun
```

Ручной offset reset side-effect consumer без runbook/evidence запрещён.

## 3. Event identity при replay

Original `eventId`/`commandId` не меняется.

Replay metadata хранится отдельно:

```text
replayId
originalTopic
originalPartition
originalOffset
replayReason
```

Новый message ID при replay может обойти Inbox и повторить side effect, поэтому запрещён по умолчанию.

## 4. DLQ semantics

DLQ создаётся только если существует operator recovery path.

DLQ record содержит:

```text
original topic/partition/offset
original message identity
message type/schema version
error class/code
attempt count
first/last failure timestamp
correlation/trace identifiers
consumer group
sanitized failure diagnostics
```

Secrets/PII не добавляются в DLQ diagnostics.

## 5. DLQ не имеет auto-loop

Запрещено:

```text
DLQ
-> periodic consumer
-> source topic
-> repeat forever
```

Recovery требует inspect/classify/approve/replay.

## 6. Retry taxonomy

### Transient short retry

Разрешён внутри bounded consumer retry budget с jitter, если операция safe/idempotent.

### Long provider retry

Не блокирует partition через sleep/minutes-long handler.

Правильно:

```text
consume command
-> persist process state {NextAttemptAt, Attempt, Status}
-> commit DB + offset
-> scheduler/outbox emits next retry when due
```

Kafka не является scheduler/timer.

### Permanent/schema/business failure

Classify -> DLQ/manual review или terminal business state согласно owner policy.

## 7. Offset reset policy

Durable business consumers:

```text
enable.auto.commit = false
auto.offset.reset  = none
```

Если offsets отсутствуют/истекли, consumer fail closed и требует explicit operator decision.

`latest` разрешён только для сознательно ephemeral consumers, например realtime invalidation.

## 8. Contiguous offset memory bound

Shared consumer runtime может завершать несколько records параллельно внутри partition, но commit разрешён только по contiguous processed watermark.

Дополнительный hard limit:

```text
maxCompletedAheadGap
```

Если ранний offset завис, а окно завершённых later offsets достигает лимита:

```text
pause partition
-> дождаться gap resolution/failure classification
```

Нельзя накапливать неограниченный completed-ahead buffer.

## 9. Rebalance recovery

На revoke/shutdown:

1. stop fetching/claiming new work;
2. finish или cancel bounded in-flight work;
3. commit только safe contiguous offsets;
4. не commit uncertain effect;
5. release partition state;
6. re-assignment безопасно replays from last committed offset.

Inbox делает duplicate replay ожидаемым, а не аварией.

## 10. New Consumer Rebalance Protocol

`group.protocol=consumer` (KIP-848) рассматривается как P1 target для Kafka 4.x, но включается только после compatibility/load spike конкретного JavaScript/librdkafka client.

Spike проверяет:

- rolling deployment;
- KEDA scale up/down;
- long bounded handlers;
- partition revoke/assignment lifecycle;
- graceful drain;
- metrics;
- rollback на classic protocol.

## 11. Acceptance

Для каждого business consumer задокументированы:

- group ID;
- owner;
- max concurrency per partition;
- offset policy;
- Inbox policy;
- retry owner/budget;
- DLQ policy;
- replay policy;
- external side-effect reconciliation;
- drain/rebalance behavior;
- maxCompletedAheadGap.

## 12. Official references

- Kafka consumer configs: https://kafka.apache.org/43/generated/consumer_config.html
- Kafka Consumer Rebalance Protocol: https://kafka.apache.org/43/operations/consumer-rebalance-protocol/
