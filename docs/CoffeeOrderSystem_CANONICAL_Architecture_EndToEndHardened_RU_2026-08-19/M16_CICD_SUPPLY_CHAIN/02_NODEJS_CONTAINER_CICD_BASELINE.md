# M16. Node.js Container и CI/CD Baseline

## 1. Runtime version

Production Node workloads используют Node.js 24 LTS. Exact patch и Docker digest фиксируются release automation; floating `node:lts`/`latest` не является release identity.

## 2. Base image

Для workload'ов с native Kafka/OTel dependencies baseline:

```text
node:24-bookworm-slim@sha256:...
```

Alpine допускается после compatibility test; `platform-web` использует Node только на build stage и Nginx runtime.

## 3. One process per image

Один image запускает одну роль. Не использовать PM2/node cluster внутри container для горизонтального scale.

## 4. Build gates

Для Node deployable:

```text
corepack/pnpm frozen lock
TypeScript typecheck
ESLint
format check
unit tests
architecture/boundary tests
runtime contract tests
Docker build
image smoke
SIGTERM/graceful shutdown smoke
health/readiness smoke
```

## 5. Kafka native dependency gate

Пока upstream отмечает pnpm support Confluent JS client как experimental, CI обязан выполнять native-load smoke в production image:

```text
install frozen lock
require/import client
producer/consumer integration
container restart
rebalance
```

Любой package-manager/native break блокирует promotion.

## 6. Sync-API static rule

Server/runtime code проходит rule/check, запрещающий известные blocking sync APIs (`fs.*Sync`, `child_process.*Sync`, sync zlib/expensive crypto) кроме allowlisted build/CLI paths.

## 7. Docker memory contract

Image/deployment config имеет:

```text
container memory request/limit
V8 heap policy
Node runtime flags
termination grace
```

CI smoke проверяет запуск при целевом memory limit и корректный exit на SIGTERM.

## 8. Permission Model

P1 pipeline может запускать audit-mode test Node Permission Model. Enforce включается workload-by-workload после доказанной совместимости native addons/required filesystem paths.

## 9. Supply-chain identity

Фиксируются:

```text
Node exact version
pnpm exact version
lockfile hash
Kafka client version
Fastify version
SQL toolkit version
image digest
SBOM
source commit
```

## 10. Upgrade policy

Patch/security updates Node LTS идут automated PR с:

- full Node platform test profile;
- Docker native dependency smoke;
- Kafka compatibility;
- HTTP contract tests;
- load smoke for event-loop/RSS regression.

Major line upgrade (`24 -> 26 LTS` в будущем) — отдельный ADR/canary.
