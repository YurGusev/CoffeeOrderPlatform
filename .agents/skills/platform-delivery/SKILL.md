---
name: platform-delivery
description: Создавать или проверять Docker images, Compose-топологию, CI/CD, supply-chain controls, configuration, deployment, health gates и rollback CoffeeOrderPlatform.
---

# Поставка платформы

У каждого runtime есть воспроизводимый non-root image, явные configuration/schema,
health/readiness, resource limits, graceful stop, provenance и rollback path.

- Compose is the first executable reference topology and contains no real secrets.
- Pin runtime/dependency/action versions and produce lockfiles, SBOM, and image digest.
- CI validates contracts before builds, then types/lint/tests/integration/security.
- Deploy immutable digests; configuration and migrations are explicit stages.
- Never run multiple migration owners for one database.
- Promotion requires service health, dependencies, observability, and recovery evidence.
- Kubernetes follows a proven process/container split; do not invent it to fill structure.
- Repository push does not authorize deployment, registry publication, or secret mutation.

Проверять чистую сборку, запуск Compose, отказ зависимости, graceful shutdown,
ошибку миграции, image scan, config validation, rollback и restore smoke.
