# M05 — Database Ladder

## Цель

Проверять новую реализацию на реальном PostgreSQL по лестнице DB0→DB5 и передавать ownership только после parity.

## Зависимости

M04

## Документы программы

- `01_DATABASE_MIGRATION_DB0_DB5.md`
- `database-ladder.mmd`

## Definition of Done программы

Для каждого context зафиксирован единственный writer/migration owner; DB5 cutover воспроизводим.

## Общий backlog

См. `../IMPLEMENTATION_BACKLOG_BY_PROGRAMS.md` (раздел этой программы).

## Правило выполнения

Production ownership меняется только после explicit parity/failure/recovery evidence и проверки зависимостей.

## Agent skill новой архитектуры

Основной skill: `next-postgres-migration`.

Для значимых изменений также активировать `next-architecture-router`; для parity/cutover/rewrite — `next-verification-and-parity`. Legacy skills разрешены только как reference/evidence старой реализации.

