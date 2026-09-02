---
name: platform-delivery
description: Создавать или проверять Docker images, Compose-топологию, supply-chain controls, configuration, deployment, health gates и rollback CoffeeOrderPlatform.
---

# Поставка платформы

У каждого runtime есть воспроизводимый non-root image, явные configuration/schema,
health/readiness, resource limits, graceful stop, provenance и rollback path.

- Compose is the first executable reference topology and contains no real secrets.
- Нормативные настройки находятся только в `config/platform.yaml`; секреты —
  только в SOPS-encrypted `secrets/platform.secrets.sops.yaml`. Runtime получает
  scoped tmpfs materialization, а не общий secrets-файл.
- `config/toolchain-versions.json` — единственное место authoring version pins;
  manifests, lockfile и checkers только materialize/проверяют registry без
  hard-coded копий. Exact pins и peer closure обязательны.
- `redis` не устанавливать и `NodeRedis` не импортировать; unused non-optional
  peer `redis` у принятого `@effect/platform-node` — единственное исключение,
  а не разрешение materialize dependency.
- Compiler, linter и contract generation присутствуют только в builder и
  отсутствуют в final images. Generated contract artifacts обязаны совпадать с
  Effect source; отдельный OpenAPI client generator не добавлять.
- Локальный repository admission проверяет contracts до build, затем
  types/lint/tests/integration/security.
- Deploy immutable digests; configuration and migrations are explicit stages.
- Never run multiple migration owners for one database.
- Promotion requires service health, dependencies, observability, and recovery evidence.
- Kubernetes follows a proven process/container split; do not invent it to fill structure.
- Repository push does not authorize deployment, registry publication, or secret mutation.

Infrastructure admission `#55` использует небольшой orchestrator существующих
checks. Полный verification framework, capacity, recovery и SLO остаются в
`#13` и не дублируются в admission gate.

Проверять чистую сборку, запуск Compose, отказ зависимости, graceful shutdown,
ошибку миграции, image scan, config validation, rollback и restore smoke.
