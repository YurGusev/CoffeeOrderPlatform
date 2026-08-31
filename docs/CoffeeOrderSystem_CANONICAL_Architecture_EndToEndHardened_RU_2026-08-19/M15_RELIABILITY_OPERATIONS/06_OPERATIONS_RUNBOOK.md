# M15. Operations Runbook

## 1. Первичная triage последовательность

При incident сначала определить слой:

```text
Edge/Web
API/domain
Kafka/CDC
Hermes/model
PostgreSQL
External provider
```

Использовать `traceId`, `correlationId`, `eventId`, `turnId`, opaque entity refs.

## 2. Kafka lag растёт

Проверить:

1. `UnderReplicatedPartitions`, `UnderMinIsrPartitionCount`, offline partitions;
2. controller/broker health и quota throttling;
3. consumer group assignment/rebalance/commit failures;
4. oldest event age и lag **per partition**;
5. hot partition/key skew;
6. handler p95/error rate и paused partitions;
7. downstream DB/provider saturation;
8. DLQ/replay/retry growth;
9. autoscaling usefulness относительно **зафиксированного** partition count.

Не увеличивать consumers бесконечно выше partition parallelism. Не увеличивать partition count как автоматическую реакцию на lag: active keyed topic требует capacity/migration decision из M06.

## 3. Debezium lag/WAL растёт

- connector status/source lag;
- heartbeat age;
- PostgreSQL replication slot confirmed/restart LSN;
- retained WAL bytes/age;
- connector bounded queue utilization;
- Kafka produce availability/quota;
- snapshot/slot/publication mismatch;
- schema/outbox incompatibility;
- disk/WAL pressure.

Не удалять replication slot и не пересоздавать connector без проверки snapshot/replay consequences.

## 4. Hermes backlog

Проверить:

```text
waiting turns
oldest turn age
active runs/shard
capacity rejects
model queue/TTFT
Coffee agent API latency
state.db latency/storage
```

Scale Hermes только вместе с model/provider capacity.

## 5. Realtime degradation

React должен иметь bounded fallback refresh/polling для critical operator state. Realtime outage не меняет business truth.

## 6. AROMA incident

При provider instability:

- снизить/остановить new mutations;
- observer/reconciliation reads оставить по policy;
- не очищать UnknownOutcome вручную без fresh evidence;
- сохранить Desired/Observed/audit state.

## 7. Payment incident

- provider webhooks/retrieval health;
- pending payment intents;
- duplicate webhook ratio;
- reconciliation backlog;
- affected Orders остаются в промежуточном состоянии, а не завершаются оптимистично.

## 8. Nginx/API canary incident

Если DB ownership ещё legacy-compatible:

```text
route target -> legacy
verify health
compare error/latency
preserve failed TS evidence
```

Если DB5 already target-owned — route rollback старого writer запрещён без compatibility proof.

## 9. Frontend artifact incident

`platform-web` stateless. Восстановить предыдущий attested immutable image/digest через edge route/deployment, не смешивая asset sets.

## 10. Incident evidence

Сохранять:

- exact image digests;
- config hash;
- topic/partition/offset or event IDs;
- DB migration version;
- provider error classifications;
- timeline;
- rollback/recovery action.

## Node.js runtime incidents

### Event loop saturation

Signals:

```text
ELU high
event-loop delay p99 rising
HTTP p99 rising
CPU may still be moderate
```

Actions:

1. identify role/pod and recent deploy;
2. inspect blocking sync/large JSON/CPU work regression;
3. reduce/admit traffic or scale replicas only if downstream budgets allow;
4. move CPU/document work out of event loop;
5. verify DB/provider pools are not the hidden queue.

### Memory growth / OOM

Inspect RSS separately from V8 heap because native Kafka/Buffer memory may dominate. Compare container limit, heap, external/ArrayBuffer and librdkafka/client queue metrics. Restart is recovery only; sustained growth requires leak/backlog correction.

### Node fatal error

Unknown `uncaughtException`/fatal state is fail-fast. Do not keep pod ready. Best-effort telemetry, exit, supervisor restart, then inspect crash loop and durable work recovery.

### Graceful rollout

Before pod termination: readiness false, stop new intake, drain bounded in-flight, persist/commit safe state, close Kafka/DB/provider clients, exit within configured grace period.


## Kafka replay/DLQ incident

- определить consumer replay class (projection/business/provider side effect);
- не менять original eventId/commandId;
- создать/использовать ReplayJob с диапазоном и dry-run;
- external side effects не replay-ить blind;
- DLQ не отправлять автоматически обратно в source;
- replay workload использует отдельный client.id/quota и не вытесняет interactive traffic.
