# ADR-0019: Node.js 26 и физическая topology CoffeeOrderPlatform

Decision ID: `ADR-COP-RUNTIME-001`
Status: `Accepted for CoffeeOrderPlatform greenfield launch`
Date: `2026-09-01`
Supersedes: `ADR-0018` в части production Node authority, физических API roots,
`implemented=false` и состава его companion artifacts
только внутри репозитория `CoffeeOrderPlatform`.
Does not modify: неизменяемые канонические revision roots.

## Контекст

`CoffeeOrderPlatform` создаётся с нуля как отдельная система, а не как
миграционный runtime внутри `CoffeeOrderSystem/platform`. Владелец продукта
явно выбрал:

- начинать сразу с owner-oriented микросервисов;
- использовать Node.js 26 в development, CI и production;
- не собирать owner-контексты в три общих процесса `api-public`, `api-agent`,
  `api-internal`.

ADR-0018 был перенесён как clean-room evidence из другой delivery topology. Он
фиксирует Node 24 production, три physical API roots, `implemented=false` и
companion artifacts под `platform/**`, которых в новом репозитории нет. Без
явного superseding решения launch-пакет конфликтует с собственной authority.

## Решение

### 1. Production runtime

Единая runtime identity первого запуска:

| Компонент | Значение |
|---|---|
| Node.js | `26.8.1` |
| npm | `11.19.0` |
| Corepack | `0.35.0` |
| pnpm | `11.24.0` |
| Production image | `node:26.8.1-bookworm-slim@sha256:<verified-real-digest>` |

Placeholder digest не допускается в materialized #3. Один exact digest
используется в development build, CI и production images. `node:24`, floating
tags и split foundation/production запрещены.

До первого production допуска каждый из 13 runtime обязан пройти на exact
image:

- clean install/build/test;
- native dependency load/ABI smoke;
- Node Permission Model audit и enforce;
- memory-limit/OOM test;
- event-loop delay и runtime metrics test;
- SIGTERM/graceful shutdown под in-flight work;
- HTTP/Kafka/PostgreSQL client compatibility;
- SBOM, provenance и vulnerability scan.

Эти проверки материализуются в #3 и блокируются G01/G03/G10/G12/G13/G14 #13.
Непройденный workload не получает production image.

### 2. Тринадцать физических runtime

Первый запуск содержит ровно следующие самостоятельные Node processes:

1. `edge-gateway`;
2. `web`;
3. `customer-service`;
4. `catalog-service`;
5. `catalog-supplier-sync`;
6. `catalog-activation-worker`;
7. `pricing-service`;
8. `orders-service`;
9. `orders-aroma-preparation`;
10. `aroma-observer`;
11. `aroma-convergence`;
12. `aroma-gateway`;
13. `realtime-gateway`.

Owner services являются отдельными network services/workers, а не модулями
общего API process. Один container содержит один process role. Масштабирование —
replicas, не PM2/`node:cluster`.

### 3. Trust surfaces без общих composition roots

M19 surfaces сохраняются как contract/security classifications:

- `client-v1`: публично только через `edge-gateway`;
- `internal-v1`: private network + service identity/audience; edge deny-list;
- `agent-v1`: отсутствует и disabled в первом запуске;
- provider surface: только `aroma-gateway` → allowlisted AROMA origin;
- realtime: только `/events` через edge.

Каталоги/processes `api-public`, `api-agent`, `api-internal` не создаются. Их
изоляционные гарантии реализуются отдельными listeners, route inventories,
service identities, network policies, secrets scopes и architecture checks.
Ни один owner service не публикует container port наружу напрямую.

### 4. `implemented` transition

ADR-0018 `implemented=false` относится к отсутствующим `platform/apps/api-*`
roles и не блокирует 13 runtime нового репозитория. Для CoffeeOrderPlatform
runtime становится `implemented=true` только когда одновременно существуют:

- source root и composition root;
- service-catalog/interaction/DB/secret entries;
- exact image/toolchain identity;
- contracts и negative exposure tests;
- health/readiness/graceful shutdown;
- workload evidence и accepted PR.

Создание пустого каталога не является implementation.

### 5. Machine-readable authority

До runtime-кода задача #2 обязана создать новую проверяемую authority:

- `platform/runtime-foundation-decision.json` и JSON Schema;
- `platform/launch-v1-runtime-profile.json` и JSON Schema;
- `platform/target-layout.json` и JSON Schema;
- validators и negative fixtures в `scripts/`/`tests/authority/`;

- `config/service-catalog.json`;
- `config/service-interactions.json`;
- `config/database-ownership.json`;
- `config/toolchain-versions.json`;
- `config/platform.yaml`;
- соответствующие schemas/checkers.

Runtime profile содержит для каждого из 13 имён: `owner`, `m20RoleRef` либо
явное `launch-v1-only`, `networkZone`, `dbPrincipal`, `httpSurfaces`,
`secretRefs`, `implemented`. Совпадение с M20 нельзя выводить по похожему имени.
До принятого implementation PR значение `implemented=false`.

До их materialization разрешена только документационная работа #14/#2/#3;
runtime feature branches #5–#18 не начинаются.

## Последствия

- Node 26 становится осознанной production authority, а не случайным
  расхождением с M04.
- Network/service overhead 13 процессов принимается ради owner isolation.
- `agent-v1` не реализуется и не получает listener/route/secret.
- Edge остаётся transport/auth boundary, но не composition root бизнес-кода.
- Любое добавление четырнадцатого runtime, общего API process или новой trust
  surface требует отдельного ADR.

## Rollback

До runtime implementation ADR откатывается одним revert вместе с зависящими
launch-правками. После materialization сначала останавливаются feature PR,
восстанавливаются согласованные service/toolchain manifests и только затем
supersede/revert этого ADR. Молчаливый возврат отдельных workloads на Node 24
запрещён.

## Проверка

До начала #5 должны проходить:

```text
pnpm authority:check
pnpm versions:check
pnpm architecture:check
pnpm config:check
```

`authority:check` сравнивает точное множество 13 runtime, отсутствие
`api-public/api-agent/api-internal`, disabled `agent-v1`, Node/pnpm identities и
наличие всех machine manifests. Пока #2/#3 не завершены, проверка обязана
fail-closed, а не считать документы реализацией.
