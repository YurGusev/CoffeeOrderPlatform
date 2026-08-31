# M16 — CI/CD / Supply Chain

## Цель

Сделать builds, contracts, containers, provenance и deployment evidence воспроизводимыми.

## Зависимости

M00, M02, M04

## Документы программы

- `01_CICD_CONTAINER_AND_SUPPLY_CHAIN.md`
- `02_NODEJS_CONTAINER_CICD_BASELINE.md`
- `03_KAFKA_CONTRACT_AND_IAC_GATES.md`

## Definition of Done программы

Pinned Node/runtime/dependencies/images, native Kafka/pnpm compatibility smoke, graceful/memory container gates, contract/architecture/security gates и immutable artifacts.

## Общий backlog

См. `../IMPLEMENTATION_BACKLOG_BY_PROGRAMS.md` (раздел этой программы).

## Правило выполнения

Production ownership меняется только после explicit parity/failure/recovery evidence и проверки зависимостей.

## Agent skill новой архитектуры

Основной skill: `next-cicd-supply-chain`.

Для значимых изменений также активировать `next-architecture-router`; для parity/cutover/rewrite — `next-verification-and-parity`. Legacy skills разрешены только как reference/evidence старой реализации.



## Связь с M19 API Architecture

OpenAPI/event/webhook compatibility и public-route inventory являются CI gates M19+M16.


## Node hardening дополнение

- `02_NODEJS_CONTAINER_CICD_BASELINE.md` — Node LTS/image/pnpm/native dependency/memory/supply-chain baseline.

Для production Node workload также активировать `next-nodejs-runtime`.

## Kafka hardening дополнение

- `03_KAFKA_CONTRACT_AND_IAC_GATES.md` — topic registry, partition-change, schema compatibility, deployed drift и Debezium IaC gates.

Kafka changes также активируют `next-kafka-event-platform`.


## Catalog contract gates

CI validates Product/Availability/Mapping payload schemas, M06 topic registry, M20 service policy, and rejects Catalog code that introduces cart mutation client or Orders DB dependency. Manual mapping/Product availability semantic changes require Outbox tests.

- `04_SEMANTIC_ARCHITECTURE_VALIDATION.md`
