# M18 — System Design Selections

## Цель

Зафиксировать только те system-design паттерны, которые усиливают CoffeeOrderSystem, и список сознательно отложенных технологий.

## Зависимости

M00

## Документы программы

- `01_SYSTEM_DESIGN_SELECTIONS.md`
- `SOURCES.md`

## Definition of Done программы

Architecture review использует capacity/ownership/backpressure/idempotency/recovery вместо technology checklist.

## Общий backlog

См. `../IMPLEMENTATION_BACKLOG_BY_PROGRAMS.md` (раздел этой программы).

## Правило выполнения

Production ownership меняется только после explicit parity/failure/recovery evidence и проверки зависимостей.

## Agent skill новой архитектуры

Основной skill: `next-system-design-governance`.

Для значимых изменений также активировать `next-architecture-router`; для parity/cutover/rewrite — `next-verification-and-parity`. Legacy skills разрешены только как reference/evidence старой реализации.

