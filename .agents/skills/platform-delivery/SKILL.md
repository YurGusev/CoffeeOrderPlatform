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
- TS7 supply-chain authority по ADR-0022 требует ровно один
  `typescript@7.0.2`, exact `oxlint@1.80.0`, `oxlint-tsgolint@7.0.2001` и
  `@hey-api/openapi-ts@0.99.0`; TS5/6 и floating pins запрещены. Compiler,
  linter и codegen присутствуют только в builder и отсутствуют в final images.
- CI validates contracts before builds, then types/lint/tests/integration/security.
- Deploy immutable digests; configuration and migrations are explicit stages.
- Never run multiple migration owners for one database.
- Promotion requires service health, dependencies, observability, and recovery evidence.
- Kubernetes follows a proven process/container split; do not invent it to fill structure.
- Repository push does not authorize deployment, registry publication, or secret mutation.

Проверять чистую сборку, запуск Compose, отказ зависимости, graceful shutdown,
ошибку миграции, image scan, config validation, rollback и restore smoke.
