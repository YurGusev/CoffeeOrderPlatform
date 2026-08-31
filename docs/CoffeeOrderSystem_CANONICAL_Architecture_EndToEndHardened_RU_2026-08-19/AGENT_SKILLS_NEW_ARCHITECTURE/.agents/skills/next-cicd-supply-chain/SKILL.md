---
name: next-cicd-supply-chain
description: "Use for CI/CD of the new TypeScript/React/Node platform, container images, lockfiles, SBOM/provenance, security scanning, immutable deploy artifacts, schema/contract compatibility gates, and release promotion."
---

# CI/CD and Supply Chain

## Source of truth

Каноническая программа: `M16_CICD_SUPPLY_CHAIN`. Перед существенным изменением прочитать её `README.md` и релевантные нормативные документы. Если этот skill противоречит канонической программе, **побеждает каноническая программа**, а skill должен быть обновлён.

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

- новый app/package/image;
- GitHub Actions для platform;
- dependency/toolchain update;
- release/canary/promotion;
- SBOM/signing/provenance.

## Hard rules

- Production Node baseline = Node 24 LTS exact patch + digest; floating `latest`/`node:lts` не release identity.
- Workloads with native Kafka/OTel use validated glibc base by default; native-load smoke is mandatory.
- One Node application role per container; PM2/node cluster not used for normal horizontal scale.
- Confluent JS + pnpm compatibility smoke remains release gate while upstream labels pnpm support experimental.
- CI tests SIGTERM graceful shutdown and memory-limit startup for deployable Node roles.


- pnpm lockfile deterministic; не смешивать npm/yarn locks.
- Каждый deploy связывается с commit SHA + image digest + config/contract version.
- Production не использует mutable `latest` как identity.
- Contract/schema compatibility проверяется до promotion.
- Secrets не попадают в build args/logs/artifacts.
- Frontend edge pair и backend images должны иметь независимую attestation/rollback identity.
- Dependency update не bypass-ит tests/bundle/security gates.
- DB migrations — отдельный controlled job/gate, не side effect каждого pod startup.

## Workflow

1. Определить artifact graph.
2. Добавить build/test/lint/typecheck/contracts/security jobs.
3. Собрать images и SBOM/provenance.
4. Проверить migration/schema compatibility.
5. Провести ephemeral/compose smoke.
6. Продвинуть shadow→canary→production с immutable digests.
7. Сохранить rollback target.

## Минимальная проверка

Перед завершением:

1. проверить соответствие каноническому документу программы;
2. проверить, что не создана новая скрытая cross-boundary зависимость;
3. выполнить targeted unit/integration/contract tests;
4. выполнить architecture/boundary tests для затронутого слоя;
5. проверить Docker build/health, если изменён runtime workload;
6. проверить observability и failure semantics, если изменён I/O/async path;
7. явно записать skipped checks и остаточный риск.


## M19 API Architecture

M19 OpenAPI/webhook/event compatibility и public-route exposure входят в CI release gates.


## Node runtime coordination

Node runtime/container changes additionally require `next-nodejs-runtime`.

## Kafka contract/IaC coordination

Для Kafka changes обязательно применять M16 `03_KAFKA_CONTRACT_AND_IAC_GATES.md`: registry lint, production partition completeness, partition-change guard, schema compatibility, deployed-topic drift, Debezium slot/snapshot/heartbeat config validation. Application не auto-create topics и не auto-register production schemas.
