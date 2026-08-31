# M04 — TypeScript Platform Foundation

## Цель

Создать строгий TypeScript/Node.js online runtime, общие contracts/security/DB/event abstractions и bounded contexts.

## Зависимости

M00

## Документы программы

- `01_TYPESCRIPT_PLATFORM_FOUNDATION.md`
- `02_BOUNDED_CONTEXTS_AND_SERVICE_OWNERSHIP.md`
- `03_NODEJS_TYPESCRIPT_EVENT_PLATFORM.md`
- `04_API_SURFACES_AND_CONTRACTS.md`
- `05_N8N_CONTROL_PLANE_BOUNDARY.md`
- `06_NODEJS_RUNTIME_ARCHITECTURE.md`
- `NODEJS_RUNTIME_ACCEPTANCE_CHECKLIST.md`
- `platform-tsconfig.json`

## Definition of Done программы

Strict TS, Fastify-first runtime, physical API trust separation, runtime validation, cancellation, connection/memory/event-loop budgets, Money/time/error/request-context и architecture boundaries приняты.

## Общий backlog

См. `../IMPLEMENTATION_BACKLOG_BY_PROGRAMS.md` (раздел этой программы).

## Правило выполнения

Production ownership меняется только после explicit parity/failure/recovery evidence и проверки зависимостей.

## Agent skill новой архитектуры

Основной skill: `next-typescript-platform`.

Для значимых изменений также активировать `next-architecture-router`; для parity/cutover/rewrite — `next-verification-and-parity`. Legacy skills разрешены только как reference/evidence старой реализации.



## Связь с M19 API Architecture

Полный API contract canon находится в M19; M04 реализует его TypeScript adapters/runtime validation.


## Node hardening дополнение

- `06_NODEJS_RUNTIME_ARCHITECTURE.md` — Node.js runtime contract: Fastify-first, process/trust separation, deadlines, pools, event loop, memory, SSE и graceful shutdown.


Для production Node workload также активировать `next-nodejs-runtime`.

## Business ownership

M20 является нормативной картой cross-service links. Runtime role не создаёт новый bounded context автоматически.
