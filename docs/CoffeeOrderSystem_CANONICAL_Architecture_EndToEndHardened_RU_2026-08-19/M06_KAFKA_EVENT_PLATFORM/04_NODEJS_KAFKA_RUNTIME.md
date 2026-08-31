# M06. Node.js Kafka Runtime Contract

## 1. Target client

Primary candidate:

```text
@confluentinc/kafka-javascript
```

Он фиксируется dependency lock только после P0 Node24 + pnpm + Docker native compatibility spike.

## 2. Compatibility spike

Проверить:

```text
Node 24 LTS
pnpm frozen lock
production base image
native library load
produce/consume
idempotent producer
manual offset commit
rebalance
SIGTERM drain
client statistics
Kubernetes-style restart
```

Отдельно P1 проверить новый Kafka Consumer Rebalance Protocol (`group.protocol=consumer`) и возможность rollback.

## 3. Shared runtime

Business apps не реализуют raw offset/rebalance logic самостоятельно.

Создать:

```text
platform/packages/kafka-runtime/
```

с primitives:

```text
ProducerFactory
DurableConsumer
PartitionExecutor
InboxGuard
OffsetWatermark
RetryClassifier
DeadLetterPublisher
ReplayMetadata
RebalanceDrain
KafkaTelemetry
```

## 4. Producer profile

Interactive/durable producer baseline:

```text
acks = all
enable.idempotence = true
allow auto topic creation = false
stable client.id
bounded delivery/request timeout
bounded local queue
```

Producer retry покрывает broker/network delivery, но не повторяет business/provider operations.

## 5. Durable consumer fail-closed profile

Business consumers:

```text
enable.auto.commit      = false
allow.auto.create.topics = false
auto.offset.reset       = none
```

Отсутствие valid offset — operational incident/operator decision, а не silent earliest/latest reset.

## 6. Ephemeral realtime exception

Realtime invalidation:

```text
unique consumer group per replica
auto.offset.reset = latest
```

Событие является hint. Потеря history восстанавливается fresh HTTP GET.

## 7. Concurrency

Parallelism разрешён между partitions.

Внутри partition допускается bounded concurrent processing только при сохранении safe contiguous commit watermark.

Обязателен:

```text
maxInFlightPerPartition
maxCompletedAheadGap
```

При заполнении completed-ahead gap partition pause-ится до восстановления contiguous progress.

## 8. Offset commit rule

Для business DB effect:

```text
Kafka record
-> BEGIN PostgreSQL
   Inbox
   business change
   Outbox
-> COMMIT
-> safe Kafka offset commit
```

Нельзя commit offset до durable effect.

## 9. Rebalance/drain

На revoke/SIGTERM:

1. stop intake;
2. pause partitions;
3. finish/cancel bounded work;
4. commit только safe contiguous offsets;
5. disconnect consumer;
6. close DB/telemetry;
7. unfinished work остаётся replayable.

## 10. Long retries

Нельзя держать handler/partition через долгий sleep.

Длинная retry state хранится в PostgreSQL process manager (`NextAttemptAt`, attempt/status), а новый command публикуется через scheduler/outbox.

## 11. Message validation

До business handler:

```text
topic registry check
-> envelope schema
-> exact payload schema
-> message kind/type
-> size/PII guard
-> business handler
```

Invalid schema не должна попадать в domain logic.

## 12. Message size

Runtime отказывается публиковать message выше application limit из topic registry без approved override.

Большие artifacts перевозятся по reference.

## 13. Client IDs, ACL и quotas

Каждый runtime role использует собственный stable client ID и principal. Generic shared Kafka credential запрещён.

## 14. Observability

Обязательны:

```text
produce latency/error/retry
consumer lag + oldest age
processing latency
partition skew
paused partitions
rebalance metrics
commit failures
DLQ/replay activity
native RSS/client queue statistics
quota throttle time
```

## 15. Kafka transactions

Kafka transactions/EOS могут использоваться для доказанного Kafka->Kafka use case. Они не заменяют PostgreSQL Outbox и не объявляются end-to-end exactly once для CoffeeOrderSystem.
