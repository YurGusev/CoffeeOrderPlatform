---
name: platform-delivery
description: Создавать или проверять Docker images, Compose-топологию, CI/CD, supply-chain controls, configuration, deployment, health gates и rollback CoffeeOrderPlatform.
---

# Поставка платформы

У каждого runtime есть воспроизводимый non-root image, явные configuration/schema,
health/readiness, resource limits, graceful stop, provenance и rollback path.

- Compose is the first executable reference topology and contains no real secrets.
- Нормативные настройки находятся только в `config/platform.yaml`; секреты —
  только в SOPS-encrypted `secrets/platform.secrets.sops.yaml`. Runtime получает
  scoped tmpfs materialization, а не общий secrets-файл.
- Pin runtime/dependency/action versions and produce lockfiles, SBOM, and image digest.
- TS7 supply-chain authority по ADR-0022 с точным исключением ADR-0026 требует ровно один
  TypeScript 7 compiler, `oxlint`, `oxlint-tsgolint` и `@hey-api/openapi-ts` с точными
  версиями из `config/toolchain-versions.json`; TS5/6 и floating pins запрещены. Compiler,
  linter и codegen присутствуют только в builder и отсутствуют в final images.
- CI validates contracts before builds, then types/lint/tests/integration/security.
- Deploy immutable digests; configuration and migrations are explicit stages.
- Never run multiple migration owners for one database.
- Promotion requires service health, dependencies, observability, and recovery evidence.
- Kubernetes follows a proven process/container split; do not invent it to fill structure.
- Repository push does not authorize deployment, registry publication, or secret mutation.

По изменению и риску выбирать проверки чистой сборки, запуска Compose, отказа
зависимости, graceful shutdown, ошибки миграции, image scan, config validation,
rollback и restore smoke.
