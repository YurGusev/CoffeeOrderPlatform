# M15. Failure Recovery и Disaster Recovery

## 1. Цель

Распределённая архитектура считается готовой только если определены не только happy path, но и восстановление после потери процесса, узла, очереди, storage и внешнего provider.

## 2. Классы отказов

```text
process crash
pod/node loss
network timeout/partition
Kafka unavailable/rebalance
Debezium stopped/WAL grows
PostgreSQL unavailable/slow
Hermes shard/PVC loss
model provider 429/5xx
VK outbound throttling
AROMA unknown mutation outcome
payment provider uncertain outcome
Nginx target failure
```

## 3. PostgreSQL

Определить и регулярно проверять:

- backup schedule;
- PITR;
- RPO/RTO;
- restore procedure;
- restore test на отдельном environment;
- ownership/migration manifests;
- DB credentials/secrets recovery.

Backup без restore drill не считается доказанным DR.

## 4. Kafka

Kafka local durability и disaster recovery рассматриваются отдельно.

Version-controlled desired state включает:

- KRaft controller/broker topology intent;
- topic registry, production partitions, RF/minISR/retention;
- ACL/principals/quotas;
- schemas/compatibility policies;
- consumer group recovery/replay policies;
- Kafka Connect/Debezium configs без secrets;
- cross-cluster DR config, если включён.

Critical production baseline — M06 `05_KAFKA_PRODUCTION_CLUSTER_CONTRACT.md`.

RF3/minISR2 защищает от bounded broker failure, но не от полной потери cluster/site. Если business RPO требует, используется MirrorMaker2/managed equivalent; asynchronous mirroring не трактуется как RPO=0.

Для уже ACK'ed external ingress (например VK callback после Kafka produce) отдельно фиксируется допустимый RPO. Если нужен RPO=0 при полной потере Kafka cluster, требуется отдельный durable-intake ADR до provider ACK.

Kafka event log не заменяет PostgreSQL backup.

## 5. Debezium

Alert/recovery contract включает:

```text
connector down
source lag growing
heartbeat stale
replication slot/WAL retained bytes growing
connector queue saturation
outbox oldest unpublished age growing
```

Connector recovery следует M06 `08_DEBEZIUM_PRODUCTION_CONTRACT.md`: unique slot/publication, explicit snapshot policy, heartbeat/WAL guard, bounded queue. Domain code не публикует event повторно вручную для компенсации CDC без explicit recovery plan.

## 6. Hermes

Каждый shard:

- per-shard persistent state;
- consistent backup/snapshot;
- restore drill;
- external `AgentConversationBinding`/`AgentTurn` journal;
- `OwnerEpoch` fencing.

При потере transcript business truth восстанавливается fresh reads через tools; side effects из старой истории не replay'ятся.

## 7. AROMA UnknownOutcome

Timeout после unsafe mutation не означает failure и не означает success.

```text
request sent
response lost
→ UnknownOutcome
→ fresh GET/reconciliation
→ only then next decision
```

Kafka delivery не решает эту неопределённость.

## 8. Payments

Аналогично:

- stable idempotency key;
- provider payment ID/retrieval;
- signed webhook inbox;
- reconciliation;
- no blind create on timeout.

## 9. Nginx rollback

До DB5 route canary может быстро вернуться на legacy target. После несовместимой DB5 migration rollback должен быть forward-compatible release, а не возврат старого writer.

## 10. DR drills

Минимальные регулярные упражнения:

1. restore PostgreSQL clone;
2. stop Debezium, проверить WAL retention/heartbeat и восстановить без потери outbox;
3. kill Kafka broker и доказать RF/minISR behavior;
4. kill KRaft controller и доказать quorum recovery;
5. выполнить consumer crash after DB commit/before offset commit;
6. проверить lost-offset fail-closed/replay runbook;
7. выполнить Kafka DR failover drill, если DR tier включён;
8. kill Hermes shard;
9. lose Hermes PVC in staging and reconstruct bounded session;
10. force AROMA timeout after accepted mutation;
11. simulate provider payment response loss;
12. swap Nginx target/rollback;
13. restore immutable frontend artifact.
