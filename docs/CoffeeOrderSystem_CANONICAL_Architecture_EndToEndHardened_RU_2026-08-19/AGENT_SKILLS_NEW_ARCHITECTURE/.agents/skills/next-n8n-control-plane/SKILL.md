---
name: next-n8n-control-plane
description: "Use for n8n workflows in the new architecture: scheduled/manual automation, operator approvals, reports, notifications, administrative orchestration, and low-frequency integrations. It prevents n8n from becoming a domain runtime, realtime transport, or direct database writer."
---

# n8n Control Plane

## Source of truth

Канонический документ: `M04_TYPESCRIPT_PLATFORM/05_N8N_CONTROL_PLANE_BOUNDARY.md`.

## Область действия

Только новая архитектура. n8n является automation/control-plane инструментом рядом с `platform/**`; он не является частью domain runtime.

## Use when

- создаётся scheduled/manual n8n workflow;
- нужен operator approval/human-in-the-loop;
- отчёт/notification/admin orchestration;
- low-frequency integration через `internal-v1` Platform API;
- обсуждается публикация command/event из n8n.

## Hard rules

- n8n не пишет напрямую domain PostgreSQL tables.
- n8n не хранит Order/Payment/AROMA business truth.
- n8n не заменяет Kafka high-throughput consumers.
- n8n не является VK realtime gateway или Hermes Dispatcher.
- Mutation выполняется только через authenticated Platform API / explicit admin command.
- Kafka command из n8n допускается только через утверждённый producer contract и с idempotency semantics owning bounded context.
- n8n не выполняет AROMA mutation в обход owning state machine.
- Secrets хранятся в n8n credential mechanism/secret manager, не в workflow JSON в Git.
- Workflow retry не должен дублировать unsafe business operation: retry owner и idempotency определяет API contract.

## Workflow

1. Определить, действительно ли задача low-frequency/control-plane, а не realtime/domain.
2. Найти owning bounded context и explicit API command/query.
3. Создать минимальный workflow без business calculations.
4. Передавать correlation/idempotency references.
5. Настроить bounded timeout/retry только для безопасных transport operations.
6. Добавить audit/observable outcome и operator failure path.
7. Проверить, что workflow можно удалить без потери business truth.

## Verification

- no direct DB credentials/domain SQL;
- no public/internal auth bypass;
- duplicate workflow execution безопасен;
- API errors/409/unknown outcome не приводят к blind replay;
- workflow экспорт не содержит secrets;
- audit/correlation видимы в Platform observability.


## M19 API Architecture

n8n использует только approved `internal-v1`/control contracts по M19; direct DB writes запрещены.
