# M09. Hermes Runtime Pool: sharding, state и recovery

## 1. Почему один Hermes instance не является production topology

Hermes хранит durable transcript/session state локально. Поэтому high-throughput production нельзя строить как несколько stateless replicas, одновременно пишущих один общий SQLite файл.

Target:

```text
Hermes Dispatcher
  ├─ hermes-runtime-0 -> PVC/state.db-0
  ├─ hermes-runtime-1 -> PVC/state.db-1
  └─ hermes-runtime-N -> PVC/state.db-N
```

## 2. StatefulSet semantics

В Kubernetes Hermes runtime — stateful shard fleet:

- стабильный shard ID;
- отдельный persistent volume/state directory;
- одинаковый pinned CoffeeOrder profile/plugin contract;
- controlled drain перед scale-down;
- independent health/capacity metrics.

## 3. AgentConversationBinding

Platform PostgreSQL хранит внешний routing state:

```text
ConversationKeyHash
HermesShardId
HermesSessionId
HermesSessionKey
OwnerEpoch
State
LastSubmittedTurnSequence
LastCompletedTurnSequence
CreatedAtUtc
UpdatedAtUtc
```

Kafka не является routing directory.

## 4. Placement

Для нового conversation используется capacity-aware weighted rendezvous hashing. После первого назначения binding сохраняется; обычный scale-out не пересаживает существующие sessions.

Shard исключается из placement, если:

- not Ready;
- Draining;
- storage pressure;
- plugin/profile version mismatch;
- model route unavailable;
- capacity reject rate выше threshold.

## 5. OwnerEpoch fencing

При migration/recovery epoch увеличивается:

```text
old shard: epoch 11
new shard: epoch 12
```

Late mutation с epoch 11 отклоняется Coffee Agent API как stale owner.

## 6. AgentTurn journal

Отдельная durable state machine:

```text
TurnId
ConversationKeyHash
TurnSequence
InboundEventId
HermesShardId
HermesSessionId
HermesRunId
OwnerEpoch
Status
Attempt
SubmittedAtUtc
StartedAtUtc
CompletedAtUtc
LastErrorCode
```

Statuses:

```text
Queued
WaitingForPreviousTurn
Submitting
SubmissionUnknown
Running
WaitingApproval
WaitingCapacity
Completed
FailedTransient
FailedPermanent
Cancelled
```

## 7. One active turn per conversation

Один conversation может иметь только один mutation-capable active turn. Разные conversations обрабатываются параллельно.

## 8. Unknown submission outcome

Критическая авария:

```text
Dispatcher -> POST /v1/runs
Hermes принял run
network response потерян
```

Нельзя blind-submit второй run. Production contract фиксирован: Dispatcher использует `HermesRunAdapter.submit(turnRef, ...)`, который обязан быть идемпотентным по stable `turnRef`. Adapter использует native idempotency/run discovery pinned Hermes version; если native API этого не даёт, adapter применяет deterministic session transcript marker discovery. При `SubmissionUnknown` blind resubmit запрещён. Pinned Hermes route не получает production certification, пока crash-after-accept test не доказывает `turnRef -> exactly one effective run`.

## 9. Restart/recovery

Happy restart:

```text
same StatefulSet ordinal
same PVC
same state.db
```

После readiness существующие bindings продолжают использовать shard.

При permanent volume loss:

1. shard -> Lost;
2. affected bindings fenced новым `OwnerEpoch`;
3. создать replacement session;
4. восстановить bounded recent dialogue context;
5. business facts перечитать через tools;
6. старые tool mutations не replay'ить;
7. reopen queued turns.

## 10. Backup

Обязательны:

- SQLite-consistent backup/snapshot;
- off-node copy;
- checksum;
- backup age metric;
- периодический restore drill.

Hermes transcript backup не заменяет PostgreSQL business backup.

## 11. Scale-down

```text
AcceptingNewSessions=false
→ drain active runs
→ migrate/expire remaining sessions
→ backup
→ verify zero owned active bindings
→ remove pod/PVC according retention policy
```

Blind HPA scale-down stateful Hermes pods запрещён.


## 12. HermesRunAdapter acceptance

Adapter хранит durable `TurnSubmission(turnRef, sessionRef, attempt, hermesRunRef?, status)` в Platform PostgreSQL. После transport timeout он сначала reconcile по stable turnRef/session marker; новый POST допустим только после доказательства, что предыдущий run не был принят. Это release gate, а не optional recommendation.
