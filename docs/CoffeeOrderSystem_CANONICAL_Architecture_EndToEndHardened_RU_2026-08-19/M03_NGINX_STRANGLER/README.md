# M03 — Nginx Strangler Edge

## Цель

Использовать public `coffee-edge` как контролируемый переключатель frontend и backend route families.

## Зависимости

M00, M02

## Документы программы

- `01_NGINX_EDGE_AND_STRANGLER.md`
- `02_ROUTE_CUTOVER_RUNBOOK.md`
- `migration-strangler.mmd`
- `nginx-strangler-example.conf`

## Definition of Done программы

Canary/rollback/route ownership работают по family, internal routes не публикуются.

## Общий backlog

См. `../IMPLEMENTATION_BACKLOG_BY_PROGRAMS.md` (раздел этой программы).

## Правило выполнения

Production ownership меняется только после explicit parity/failure/recovery evidence и проверки зависимостей.

## Agent skill новой архитектуры

Основной skill: `next-nginx-strangler`.

Для значимых изменений также активировать `next-architecture-router`; для parity/cutover/rewrite — `next-verification-and-parity`. Legacy skills разрешены только как reference/evidence старой реализации.



## Связь с M19 API Architecture

Public/private route allowlist и API surface classification следуют M19; edge не должен публиковать `agent-v1`/`internal-v1`.
