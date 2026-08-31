# M09 / EDA-8. Hermes Runtime Integration

Этот документ сохраняет ранее согласованную нумерацию EDA-080…084, но в актуальной Hermes/TypeScript архитектуре.

## EDA-080 — `coffee.agent.turn.requested.v1`

Реализовать versioned Kafka command contract:

- key = `ConversationKeyHash`;
- stable `eventId`/`turnId`;
- `turnSequence`;
- opaque `channelIdentityRef`;
- sanitized user input;
- correlation/trace context;
- никаких raw Customer/VK IDs, контролируемых LLM.

## EDA-081 — Coffee Hermes Dispatcher (TypeScript)

Реализовать TypeScript service:

```text
Kafka consume
→ AgentTurn journal
→ one-active-turn gate
→ AgentConversationBinding
→ choose sticky Hermes shard
→ POST /v1/runs
→ monitor/reconcile
```

Требования:

- keyed sequencing;
- bounded concurrency;
- graceful Kafka rebalance/drain;
- safe offset handling;
- `SubmissionUnknown` recovery;
- capacity-aware shard routing.

## EDA-082 — Hermes Runtime Pool и session binding

Реализовать:

- pinned CoffeeOrder Hermes profile;
- StatefulSet/per-shard persistent state;
- `AgentConversationBinding`;
- `OwnerEpoch` fencing;
- shard registry/health/capacity;
- state-aware scale-out/scale-down;
- backup/restore drill;
- no shared writable SQLite.

## EDA-083 — `AgentTurnCompleted/Failed`

Нормализовать terminal outcome:

```text
Hermes run completion
→ AgentTurn terminal state
→ Outbox/Kafka AgentTurnCompleted|Failed
→ response mapper
→ coffee.channels.outbound.v1
```

Late/stale result не отправляется пользователю после owner/sequence change.

## EDA-084 — load/performance/failure test

Сначала model stub, затем реальные providers.

Ladder:

```text
10k conversation keys
25k
50k
100k+
```

Отдельно повышать messages/sec, turn duration, tools/turn, provider latency и failure rate до saturation knee.

Acceptance:

- lost accepted messages = 0;
- cross-identity leakage = 0;
- ordering violations = 0;
- duplicate business mutation = 0;
- backlog восстанавливается после burst;
- shard failure/rebalance/restart безопасны.

## Mapping на migration backlog

```text
EDA-080 ~ M902/M601-M602
EDA-081 ~ M903-M904
EDA-082 ~ M905
EDA-083 ~ M907 + event mapping
EDA-084 ~ M908
```


## Node runtime requirement

TypeScript Channel Ingress/Egress и Hermes Dispatcher следуют M04 Node.js Runtime Contract и M06 Node.js Kafka Runtime: one process per role, bounded pools/concurrency, AbortSignal deadlines, ELU/RSS metrics и graceful Kafka/HTTP drain.
