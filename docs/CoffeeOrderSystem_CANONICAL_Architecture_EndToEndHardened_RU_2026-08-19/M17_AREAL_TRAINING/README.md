# M17 — AReaL Training-only

## Цель

Отделить будущий model-training lifecycle от production Hermes runtime.

## Зависимости

M09 + накопленные sanitized trajectories

## Документы программы

- `01_AREAL_TRAINING_AND_MODEL_LIFECYCLE.md`
- `02_EXISTING_AREAL_PROGRAM_RESCOPING.md`

## Definition of Done программы

Dataset/evaluator/model registry и offline→shadow→canary promotion, без live weight updates.

## Общий backlog

См. `../IMPLEMENTATION_BACKLOG_BY_PROGRAMS.md` (раздел этой программы).

## Правило выполнения

Production ownership меняется только после explicit parity/failure/recovery evidence и проверки зависимостей.

## Agent skill новой архитектуры

Основной skill: `next-areal-training`.

Для значимых изменений также активировать `next-architecture-router`; для parity/cutover/rewrite — `next-verification-and-parity`. Legacy skills разрешены только как reference/evidence старой реализации.

