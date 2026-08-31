# M04. Граница n8n Control Plane

## 1. Роль

n8n остаётся automation/control-plane инструментом, а не domain runtime и не realtime transport.

Подходящие задачи:

- scheduled/manual workflows;
- operator approvals;
- отчёты/уведомления;
- administrative orchestration;
- low-frequency integrations;
- human-in-the-loop flows.

## 2. Запрещено

n8n не должен:

- писать напрямую domain PostgreSQL tables;
- заменять Kafka high-throughput consumers;
- быть VK realtime gateway;
- хранить Order/Payment/AROMA business truth;
- использовать browser `client-v1` как admin/service API или обходить approved `internal-v1`/explicit control command contract;
- исполнять AROMA mutation без owning state-machine.

## 3. Интеграция

```text
n8n
→ authenticated `internal-v1` Platform API / explicit admin commands
→ optional Kafka command only через утверждённый producer contract
```

Все mutation semantics и idempotency остаются в owning bounded context.


## 4. API authority

M19 определяет n8n как private internal/control-plane actor. Любой n8n endpoint/command имеет explicit workload audience и service auth; direct domain DB access запрещён.
