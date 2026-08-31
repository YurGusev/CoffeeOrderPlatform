# Интеграция с существующим task-skill-router

После принятия skills рекомендуется добавить в текущую routing matrix одну верхнеуровневую строку **до legacy backend rules**:

```text
Signal: platform/**, target edge/**, target infra/**, hermes/**, training/**,
        C#→TypeScript migration, bounded-context cutover
Skills: next-architecture-router + routed next-* program skills
Precedence: next-* target rules override legacy implementation rules
```

Для migration задачи router должен одновременно разрешать legacy skill в read/reference режиме, но target edits направлять `next-*` skills.

## Recommended checkpoint note

Агент перед edits пишет коротко:

```text
Program: Mxx
Target owner: ...
Current legacy owner: ...
Skills: next-architecture-router, next-..., next-verification-and-parity
Write zone: ...
Legacy read-only/reference zone: ...
```


## API Surface routing

Добавить сигнал:

```text
Signal: client-v1, agent-v1, internal-v1, webhook/callback, provider API, Kafka event contract, SSE/WebSocket, OpenAPI/JSON Schema
Skills: next-api-architecture + owning bounded-context skill + next-verification-and-parity for migration/cutover
Program: M19
```


## Node runtime routing

Если touched files содержат production Node/Fastify/Kafka/SSE/Hermes Dispatcher code under `platform/**`, router дополнительно активирует `next-nodejs-runtime`. Это cross-cutting runtime skill, а owning program skill остаётся активным.
