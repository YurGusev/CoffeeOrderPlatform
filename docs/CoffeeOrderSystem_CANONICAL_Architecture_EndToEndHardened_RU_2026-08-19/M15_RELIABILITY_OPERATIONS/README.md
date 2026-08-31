# M15 — Reliability / Operations

## Цель

Сделать capacity, backpressure, observability, security, testing, DR и runbooks сквозными гарантиями.

## Зависимости

Стартует с M00 и сопровождает все программы

## Документы программы

- `01_CAPACITY_BACKPRESSURE_AND_RESILIENCE.md`
- `02_OBSERVABILITY_AND_SLO.md`
- `03_SECURITY_AND_TRUST_BOUNDARIES.md`
- `04_TESTING_PARITY_CHAOS_AND_FORMAL.md`
- `05_FAILURE_RECOVERY_AND_DR.md`
- `06_OPERATIONS_RUNBOOK.md`
- `07_NODEJS_RUNTIME_SLO_AND_CAPACITY.md`
- `08_KAFKA_PLATFORM_SLO_AND_RECOVERY.md`

## Definition of Done программы

SLO/alerts/fault tests/restore drills/runbooks являются release gates; Node ELU/RSS/connection/SSE budgets и Kafka broker/partition/consumer/Debezium/DR SLI входят в обязательный capacity profile.

## Общий backlog

См. `../IMPLEMENTATION_BACKLOG_BY_PROGRAMS.md` (раздел этой программы).

## Правило выполнения

Production ownership меняется только после explicit parity/failure/recovery evidence и проверки зависимостей.

## Agent skill новой архитектуры

Основной skill: `next-reliability-operations`.

Для значимых изменений также активировать `next-architecture-router`; для parity/cutover/rewrite — `next-verification-and-parity`. Legacy skills разрешены только как reference/evidence старой реализации.



## Связь с M19 API Architecture

API SLO/auth/error/idempotency/load gates определяются M19 и проверяются M15.


## Node hardening дополнение

- `07_NODEJS_RUNTIME_SLO_AND_CAPACITY.md`
- `08_KAFKA_PLATFORM_SLO_AND_RECOVERY.md` — Node-specific SLO/capacity: ELU, event-loop delay, RSS/native memory, DB/provider/SSE budgets.


Для production Node workload также активировать `next-nodejs-runtime`.

## Kafka hardening дополнение

- `08_KAFKA_PLATFORM_SLO_AND_RECOVERY.md` — broker/partition/consumer/Debezium SLI, capacity, RPO/RTO, release gates.

Kafka platform changes требуют совместного применения `next-kafka-event-platform`.

- `10_CATALOG_PRODUCT_CART_FAILURE_MODEL.md` — supplier snapshot/Product/mapping/availability failure semantics and cart reaction tests.

- `11_BUSINESS_SLO_RPO_RTO_V1.md`

- `12_PRIVACY_RETENTION_AND_TRAINING_EXPORT.md`
