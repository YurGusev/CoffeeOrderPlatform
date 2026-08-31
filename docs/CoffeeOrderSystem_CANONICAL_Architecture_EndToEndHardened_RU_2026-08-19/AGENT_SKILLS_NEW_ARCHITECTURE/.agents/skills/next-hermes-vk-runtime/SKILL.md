---
name: next-hermes-vk-runtime
description: "Use for Hermes production runtime, VK/channel ingress/egress, Channel Identity, Hermes Dispatcher, EDA-080..084, session sharding/recovery, provider routing, and CoffeeOrder plugin boundary."
---

# Hermes and VK Runtime

## Source of truth

Каноническая программа: `M09_HERMES_VK`. Перед существенным изменением прочитать её `README.md` и релевантные нормативные документы. Если этот skill противоречит канонической программе, **побеждает каноническая программа**, а skill должен быть обновлён.

## Область действия

Этот skill относится **только к новой архитектуре CoffeeOrderSystem**. Нормативная зона записи:

```text
platform/**
edge/**          # только target/strangler изменения
infra/**         # новая Docker/Kafka/Debezium/Kubernetes topology
hermes/**
training/**
```

`src/**` является legacy/reference-зоной. Изменять `src/**` разрешено только когда задача явно требует characterization/parity instrumentation, migration adapter, rollback support или удаления legacy после принятого cutover. Нельзя использовать legacy C# архитектуру как шаблон для target-кода.

Новая platform не должна импортировать runtime-код, сборки или внутренние типы из `src/**`. Разрешены только language-neutral contracts, наблюдаемое поведение, database schema evidence и characterization tests.

## Use when

- Hermes Runtime/Dispatcher/plugin;
- VK Callback/egress/realtime ordering;
- channel identity/customer resolution;
- AgentTurnRequested/Completed/Failed;
- model provider routing/fallback.

## Hard rules

- Hermes = production agent runtime; AReaL не входит в serving path.
- Coffee DB = business truth; Hermes state.db = transcript/session runtime only.
- Production Coffee Hermes profile изолирован от developer Hermes.
- Разрешены только CoffeeOrder tools; terminal/file/browser/arbitrary HTTP/general MCP/delegation/code execution выключены.
- Model не выбирает `vk_user_id/customerId`; `resolve_current_customer()` использует trusted opaque channelIdentityRef из transport context.
- Hermes fleet = stateful shards с отдельным PVC/state.db; общий writable SQLite запрещён.
- Persist `AgentConversationBinding` + `OwnerEpoch` вне Hermes.
- Один active mutation-capable turn на conversation; разные conversations параллельны.
- Для high-throughput использовать durable AgentTurn journal и Runs API; не держать Kafka partition заблокированной на весь LLM turn.
- Provider fallback не повторяет уже выполненные business mutations.

## Workflow

1. EDA-080: contract `coffee.agent.turn.requested.v1`.
2. EDA-081: TS Hermes Dispatcher + durable turn journal.
3. EDA-082: shard/session binding, sticky placement, drain/recovery.
4. EDA-083: stable completion/failure outcomes → channel reply.
5. EDA-084: load test model stub + 10k/25k/50k/100k conversation ladder.
6. Проверить identity spoofing, shard loss, submission unknown, provider 429/timeout, replay.

## Минимальная проверка

Перед завершением:

1. проверить соответствие каноническому документу программы;
2. проверить, что не создана новая скрытая cross-boundary зависимость;
3. выполнить targeted unit/integration/contract tests;
4. выполнить architecture/boundary tests для затронутого слоя;
5. проверить Docker build/health, если изменён runtime workload;
6. проверить observability и failure semantics, если изменён I/O/async path;
7. явно записать skipped checks и остаточный риск.


## M19 API Architecture

Hermes `agent-v1`, VK callback и realtime/channel contracts следуют M19 API surface rules.


## Node runtime coordination

TypeScript `channel-ingress`, `channel-egress` и `hermes-dispatcher` дополнительно требуют `next-nodejs-runtime`: bounded pools/concurrency, AbortSignal/deadlines, event-loop/RSS metrics, graceful drain и shared Kafka runtime.

## End-to-end closure hard rules

- Runtime chain includes `channel-identity-broker`, `channel-intake`, `channel-response-mapper`, `hermes-runtime`; do not bypass them.
- `AgentTurnFailed` must reach response mapper with sanitized fallback reply.
- `HermesRunAdapter.submit(turnRef)` is idempotent/reconcilable; `SubmissionUnknown` never blind-resubmits.
- Normal AI/VK confirmation uses structured `ChannelConfirmationProof`; free-text/model decision alone cannot confirm supplier intent.
