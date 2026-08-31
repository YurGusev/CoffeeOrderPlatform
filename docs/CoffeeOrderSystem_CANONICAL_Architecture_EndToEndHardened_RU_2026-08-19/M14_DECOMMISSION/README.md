# M14 — Legacy Decommission

## Цель

Удалить старые C# workers/routes/migrations/runtime только после zero-traffic/zero-writer evidence.

## Зависимости

M01, M07–M13

## Документы программы

- `01_LEGACY_DECOMMISSION.md`
- `02_HOSTEDSERVICE_MIGRATION_MAP.md`
- `BOUNDED_CONTEXT_CUTOVER_CHECKLIST.md`

## Definition of Done программы

C# production workloads=0, obsolete workers/flags/services удалены, migration evidence архивирован.

## Общий backlog

См. `../IMPLEMENTATION_BACKLOG_BY_PROGRAMS.md` (раздел этой программы).

## Правило выполнения

Production ownership меняется только после explicit parity/failure/recovery evidence и проверки зависимостей.

## Agent skill новой архитектуры

Основной skill: `next-legacy-decommission`.

Для значимых изменений также активировать `next-architecture-router`; для parity/cutover/rewrite — `next-verification-and-parity`. Legacy skills разрешены только как reference/evidence старой реализации.

