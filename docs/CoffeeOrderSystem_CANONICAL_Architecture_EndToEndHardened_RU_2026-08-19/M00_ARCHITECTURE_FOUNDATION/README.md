# M00 — Architecture Foundation

## Цель

Зафиксировать каноническую целевую архитектуру, clean-room границу, языки/runtime ownership и общий порядок миграции.

## Зависимости

—

## Документы программы

- `01_ARCHITECTURE_DECISION_SUMMARY.md`
- `02_CLEAN_ROOM_REPOSITORY_LAYOUT.md`
- `03_TARGET_SYSTEM_ARCHITECTURE.md`
- `04_FULL_MIGRATION_PROGRAM.md`
- `05_LANGUAGE_AND_RUNTIME_OWNERSHIP.md`
- `06_ARCHITECTURE_SUPERSESSION_MAP.md`
- `target-platform.mmd`
- `target-repository-layout.txt`

## Definition of Done программы

Создан `/platform`, приняты ADR, устранены противоречащие старые target-решения.

## Общий backlog

См. `../IMPLEMENTATION_BACKLOG_BY_PROGRAMS.md` (раздел этой программы).

## Правило выполнения

Production ownership меняется только после explicit parity/failure/recovery evidence и проверки зависимостей.

## Agent skill новой архитектуры

Основной skill: `next-architecture-foundation`.

Для значимых изменений также активировать `next-architecture-router`; для parity/cutover/rewrite — `next-verification-and-parity`. Legacy skills разрешены только как reference/evidence старой реализации.



## API canon

M19_API_ARCHITECTURE является отдельным cross-cutting normative program и расширяет target architecture этой программы.

## BusinessLogicHardened revision

M11/M12/M20 now define the canonical Orders→AROMA→Invoices→Payments lifecycle. Direct Draft `sendToAromaCart` is legacy-only and must not reappear in `platform/**`.
