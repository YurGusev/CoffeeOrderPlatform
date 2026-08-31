# M02 — Docker / Compose

## Цель

Сделать Docker-first reference runtime для новой платформы и side-by-side legacy/target разработки.

## Зависимости

M00

## Документы программы

- `01_DOCKER_AND_COMPOSE_REFERENCE_RUNTIME.md`
- `compose-target-skeleton.yml`

## Definition of Done программы

Все target workloads имеют immutable images/health; compose profiles поднимают platform/kafka/hermes/observability.

## Общий backlog

См. `../IMPLEMENTATION_BACKLOG_BY_PROGRAMS.md` (раздел этой программы).

## Правило выполнения

Production ownership меняется только после explicit parity/failure/recovery evidence и проверки зависимостей.

## Agent skill новой архитектуры

Основной skill: `next-docker-compose-runtime`.

Для значимых изменений также активировать `next-architecture-router`; для parity/cutover/rewrite — `next-verification-and-parity`. Legacy skills разрешены только как reference/evidence старой реализации.

