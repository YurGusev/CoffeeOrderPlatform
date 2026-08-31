# M13 — Kubernetes / Selective Microservices

## Цель

Перенести доказанные Docker workloads в Kubernetes и извлекать сервисы только по operational reason.

## Зависимости

M02, M04, M06, M15

## Документы программы

- `01_MICROSERVICES_EXTRACTION_STRATEGY.md`
- `02_KUBERNETES_TARGET_RUNTIME.md`

## Definition of Done программы

Multi-node deployment, probes, network policy, autoscaling, Hermes StatefulSet/drain доказаны.

## Общий backlog

См. `../IMPLEMENTATION_BACKLOG_BY_PROGRAMS.md` (раздел этой программы).

## Правило выполнения

Production ownership меняется только после explicit parity/failure/recovery evidence и проверки зависимостей.

## Agent skill новой архитектуры

Основной skill: `next-kubernetes-microservices`.

Для значимых изменений также активировать `next-architecture-router`; для parity/cutover/rewrite — `next-verification-and-parity`. Legacy skills разрешены только как reference/evidence старой реализации.



Для production Node workload также активировать `next-nodejs-runtime`.
