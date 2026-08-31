# M06. Topic Registry, partitions, retention и quotas

## 1. Production registry is explicit

`kafka-topic-registry.yml` уже содержит explicit `productionPartitions` для каждого canonical topic. `null` запрещён semantic validator'ом.

Initial counts — **v1 capacity baseline**, не доказанная финальная производительность. До first production cutover load tests должны доказать per-partition headroom. После cutover count не меняется casually; capacity topology change получает новый topic/version/migration plan.

## 2. Autoscaling

KEDA/HPA scale consumer replicas, но не partitions:

```text
max useful replicas <= partitions
```

## 3. Retention

Registry содержит `productionRetentionHours`. UGC/possible-PII channel/agent payloads baseline = 7 days; ephemeral realtime = 1 hour; financial/domain facts retain longer.

## 4. Durability

`critical` => RF3/minISR2/acks=all/idempotent producer. Catalog availability/mapping classified critical because they can remove active supplier target.

## 5. Quotas

Per-runtime client IDs and quotas isolate Tier-A channel traffic from replay/background consumers. Replay tooling receives stricter quota than online producers.

## 6. Message size

Application max serialized Kafka payload = 256 KiB. PDF/Excel/audio/large allocation manifests use ArtifactRef.
