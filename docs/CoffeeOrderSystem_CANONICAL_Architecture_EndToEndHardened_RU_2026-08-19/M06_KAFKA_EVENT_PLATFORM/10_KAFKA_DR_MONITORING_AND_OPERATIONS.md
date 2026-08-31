# M06. Kafka DR, Monitoring и Operations

## 1. DR tiers

Kafka durability внутри одного cluster и disaster recovery между clusters — разные задачи.

### Tier 0 — development/local

Single-node/combined topology допустима только вне critical environments.

### Tier 1 — production local durability

```text
3 controllers
3+ brokers
RF3/minISR2 critical topics
rack/zone awareness
acks=all/idempotent producer
```

Защищает от bounded node failure, но не от полной потери cluster/site.

### Tier 2 — cross-cluster DR

Если business RPO/RTO требует, добавляется second Kafka cluster и asynchronous replication, например MirrorMaker 2 или managed equivalent.

MirrorMaker2 может реплицировать topics/configs, consumer groups/offset checkpoints и ACLs. Он не делает synchronous RPO=0.

## 2. External ACK durability question

Для flow:

```text
VK callback
-> Kafka durable produce
-> ACK VK
```

нужно явно определить допустимый RPO **после ACK**.

Если бизнес требует RPO=0 даже при полной потере Kafka cluster, RF3 и async MirrorMaker недостаточны. Нужен отдельный ADR, например durable intake ledger/dual durability до provider ACK или подтверждённая provider redelivery guarantee.

Нельзя скрывать этот requirement внутри Kafka tuning.

## 3. Kafka RPO/RTO

M15 хранит business-approved RPO/RTO для:

- Tier-A channel ingress;
- domain lifecycle streams;
- command streams;
- Schema Registry/Connect metadata;
- consumer offsets/checkpoints.

DR считается принятым только после failover drill и evidence.

## 4. Mandatory broker/platform metrics

Минимум:

```text
UnderReplicatedPartitions
UnderMinIsrPartitionCount
OfflinePartitionsCount
ISR shrink/expand
controller quorum health/lag
produce/fetch request latency
request queue size
request-handler idle
bytes/records in/out
broker disk usage/growth
quota throttle time
```

## 5. Consumer metrics

По consumer group/topic/partition:

```text
records lag
oldest event age
fetch rate
processing latency
failure rate
rebalance rate/count/latency
committed offset progress
paused partitions
DLQ rate
replay activity
```

`oldest event age` является более полезным user-impact indicator, чем один суммарный lag count.

## 6. Partition skew/hot-key metrics

Обязательны per-partition throughput/lag. Cluster-wide average не должен скрывать одну перегруженную partition.

## 7. Debezium/Connect metrics

M06/M15 мониторят:

```text
connector status
source lag
heartbeat age
replication-slot retained WAL bytes/age
queue records/bytes usage
Connect internal topic health
restart/error count
```

## 8. Quota monitoring

Monitor:

- producer/consumer throttle time;
- request quota throttle;
- client ID/principal causing throttle;
- background/replay workload pressure.

## 9. Operational runbooks

Обязательны runbooks:

1. broker failure;
2. controller failure;
3. under-minISR/write rejection;
4. disk pressure;
5. hot partition;
6. consumer group stuck/rebalance loop;
7. lost/expired consumer offsets;
8. DLQ growth;
9. Debezium slot/WAL growth;
10. Connect failure;
11. Schema Registry unavailable/incompatible schema;
12. primary Kafka loss / DR failover;
13. replay approval/execution/rollback.

## 10. Chaos/recovery drills

Периодически проверяются:

```text
kill broker
kill controller
isolate broker network
Kafka unavailable while DB commits continue
restart Connect/Debezium
consumer crash after DB commit before offset commit
consumer crash before DB commit
slow/poison record
quota saturation
DR cluster failover
```

## 11. Official references

- Kafka monitoring: https://kafka.apache.org/43/operations/monitoring/
- Kafka geo-replication / MirrorMaker2: https://kafka.apache.org/43/operations/geo-replication-cross-cluster-data-mirroring/
- Kafka quotas: https://kafka.apache.org/43/operations/basic-kafka-operations/
