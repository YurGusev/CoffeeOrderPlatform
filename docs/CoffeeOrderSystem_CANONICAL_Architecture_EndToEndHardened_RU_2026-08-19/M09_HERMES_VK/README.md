# M09 — Hermes / VK

## Цель

Построить high-throughput VK→Kafka→Hermes production runtime с trusted identity, sticky sessions и model routing.

## Зависимости

M02, M03, M04, M06, M15

## Документы программы

- `01_HERMES_AGENT_RUNTIME.md`
- `02_VK_TO_HERMES_FLOW.md`
- `03_HERMES_SHARDING_AND_RECOVERY.md`
- `04_CHANNEL_IDENTITY_AND_CUSTOMER_RESOLUTION.md`
- `05_MODEL_PROVIDER_ROUTING_POLICY.md`
- `06_EDA8_HERMES_RUNTIME_INTEGRATION.md`
- `vk-hermes.mmd`

## Definition of Done программы

EDA-080…084 выполнены, 10k→100k+ workload ladder пройден, ordering/identity/recovery invariants доказаны.

## Общий backlog

См. `../IMPLEMENTATION_BACKLOG_BY_PROGRAMS.md` (раздел этой программы).

## Правило выполнения

Production ownership меняется только после explicit parity/failure/recovery evidence и проверки зависимостей.

## Agent skill новой архитектуры

Основной skill: `next-hermes-vk-runtime`.

Для значимых изменений также активировать `next-architecture-router`; для parity/cutover/rewrite — `next-verification-and-parity`. Legacy skills разрешены только как reference/evidence старой реализации.



## Связь с M19 API Architecture

`agent-v1`, VK callback и realtime/channel API boundaries следуют M19.


Для production Node workload также активировать `next-nodejs-runtime`.

- `07_AI_VK_CONFIRMATION_AND_APPROVAL_PROOF.md`

- `08_CHANNEL_IDENTITY_BROKER_CONTRACT.md`
