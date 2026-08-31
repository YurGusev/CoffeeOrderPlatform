---
name: next-docker-compose-runtime
description: "Use for Dockerfiles, Docker Compose profiles, local/reference runtime topology, container health, graceful shutdown, and image boundaries for the new architecture."
---

# Docker and Compose Reference Runtime

## Source of truth

Каноническая программа: `M02_DOCKER_COMPOSE`. Перед существенным изменением прочитать её `README.md` и релевантные нормативные документы. Если этот skill противоречит канонической программе, **побеждает каноническая программа**, а skill должен быть обновлён.

## Область действия

Этот skill относится **только к новой архитектуре CoffeeOrderSystem**. Нормативная зона записи:

```text
platform/**
edge/**          # только target/strangler изменения
infra/**         # новая Docker/Kafka/Debezium/Kubernetes topology
hermes/**
training/**
```

`src/**` является legacy/reference-зоной. Изменять `src/**` разрешено только когда задача явно требует characterization/parity instrumentation, migration adapter, rollback support или удаления legacy после принятого cutover. Нельзя использовать legacy C# архитектуру как шаблон для target-кода.

Новая platform не должна импортировать runtime-код, сборки или внутренние типы из `src/**`. Разрешены только language-neutral contracts, наблюдаемое поведение, database schema evidence и characterization tests.

## Use when

- добавляется новый workload/app;
- меняется Dockerfile или Compose;
- создаётся local integration topology;
- готовится component к Kubernetes.

## Hard rules

- Каждый runtime workload имеет immutable image и health semantics.
- Multi-stage build, pinned base image major/minor/digest policy по CI.
- Runtime container работает non-root, где это возможно.
- Secrets не bake-ятся в image и не коммитятся в compose.
- Compose — исполняемая reference architecture, а не случайный dev helper.
- Не расширять один гигантский compose бесконечно: использовать bounded compose files/profiles.
- Local topology должна концептуально соответствовать будущим K8s workloads.

## Workflow

1. Определить workload role: HTTP, consumer, stateful, job/cron.
2. Добавить Dockerfile с build/runtime stages.
3. Добавить health/readiness-equivalent checks.
4. Включить workload в соответствующий compose profile.
5. Добавить dependencies только по network/data need, не по convenience.
6. Запустить build + compose smoke + graceful stop/restart test.

## Минимальная проверка

Перед завершением:

1. проверить соответствие каноническому документу программы;
2. проверить, что не создана новая скрытая cross-boundary зависимость;
3. выполнить targeted unit/integration/contract tests;
4. выполнить architecture/boundary tests для затронутого слоя;
5. проверить Docker build/health, если изменён runtime workload;
6. проверить observability и failure semantics, если изменён I/O/async path;
7. явно записать skipped checks и остаточный риск.


## Node runtime coordination

Для production Node image/runtime обязательно активировать `next-nodejs-runtime`: one-process-per-container, Node 24 LTS pin/digest, memory/V8 headroom, SIGTERM drain и native dependency smoke.
