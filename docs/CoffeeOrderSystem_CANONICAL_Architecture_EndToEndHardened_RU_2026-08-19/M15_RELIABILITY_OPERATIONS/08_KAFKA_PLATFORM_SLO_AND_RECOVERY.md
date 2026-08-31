# M15. Kafka Platform SLO, Capacity и Recovery

## 1. Scope

Этот документ переводит M06 contracts в operational SLI/SLO/recovery gates.

## 2. User-impact SLI

Kafka оценивается не только broker uptime.

Обязательные user/business-impact SLI:

```text
channel durable-accept latency
oldest unprocessed Tier-A ingress age
oldest business command age
oldest domain lifecycle consumer age
Debezium outbox publication age
DLQ oldest age
replay job age
```

## 3. Broker health SLI

```text
UnderReplicatedPartitions
UnderMinIsrPartitionCount
OfflinePartitionsCount
ISR shrink/expand rate
controller quorum health/lag
produce/fetch request latency
request queue
request handler idle
broker disk free/growth
quota throttle time
```

## 4. Partition-level SLI

Average topic lag недостаточен.

Для critical topics видеть:

```text
records/sec per partition
bytes/sec per partition
lag per partition
oldest age per partition
processing latency per partition
```

Это обнаруживает hot key/partition skew.

## 5. Consumer group SLI

```text
assignment state
rebalance count/rate/latency
commit rate/failures
fetch rate
paused partitions
processing failures
DLQ rate
maxCompletedAheadGap usage
```

## 6. Debezium/Connect SLI

```text
connector status
source lag
heartbeat age
retained WAL bytes/age
queue record/byte utilization
outbox oldest unpublished age
Connect internal topic health
```

## 7. Capacity model

Для каждого production topic before cutover:

```text
peak records/sec
peak bytes/sec
serialized p50/p95/p99 message size
measured records/sec/partition
consumer processing p95
expected growth factor
headroom
chosen partitions
```

Partition count не меняется автоматически после cutover.

## 8. DR SLO

Отдельно определить:

```text
Kafka cluster RPO/RTO
Tier-A ACKed ingress RPO/RTO
Debezium/Connect recovery objective
Schema Registry recovery objective
consumer offset/checkpoint recovery objective
```

RF3/minISR2 защищает от bounded broker failure, а не от полной потери site/cluster.

## 9. Cross-cluster DR

Если RPO требует, MirrorMaker2/managed equivalent реплицирует approved critical topics и consumer offset/checkpoint metadata в DR cluster.

Async replication не объявляется RPO=0.

## 10. Release gates

Kafka-affecting release блокируется, если:

- critical topic registry не совпадает с deployed config;
- production partitions не зафиксированы;
- minISR/RF нарушены;
- required schema compatibility не проходит;
- Debezium slot/WAL alarm unhealthy;
- oldest-event-age превышает release gate;
- replay/DLQ recovery path отсутствует;
- failure drill для изменённого critical path не выполнен.
