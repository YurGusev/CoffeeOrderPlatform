# ADR-0019: Node.js 26, trust roots и owner-runtime topology

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
- сохранить owner-сервисы владельцами business behavior/DB, а public/internal
  trust surfaces физически отделить stateless composition roots.

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

До первого production допуска каждый из 15 runtime обязан пройти на exact
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

### 2. Пятнадцать физических runtime

Первый запуск содержит ровно следующие самостоятельные Node processes:

1. `edge-gateway`;
2. `api-public`;
3. `api-internal`;
4. `web`;
5. `customer-service`;
6. `catalog-service`;
7. `catalog-supplier-sync`;
8. `catalog-activation-worker`;
9. `pricing-service`;
10. `orders-service`;
11. `orders-aroma-preparation`;
12. `aroma-observer`;
13. `aroma-convergence`;
14. `aroma-gateway`;
15. `realtime-gateway`.

Owner services являются отдельными network services/workers, а не модулями
общего API process. Один container содержит один process role. Масштабирование —
replicas, не PM2/`node:cluster`.

### 3. Stateless trust composition roots

M19 surfaces сохраняются как contract/security classifications:

- `client-v1`: `edge-gateway -> api-public -> owner service`;
- `internal-v1`: caller -> `api-internal` -> owner/Gateway;
- `agent-v1`: отсутствует и disabled в первом запуске;
- provider surface: только `aroma-gateway` → allowlisted AROMA origin;
- realtime: только `/events` через edge.

`api-public` монтирует только `client-v1`, проверяет actor context и transport
schemas, но не имеет DB/Kafka/provider credentials и business decisions.
`api-internal` монтирует только `internal-v1`, проверяет mTLS caller allowlist и
выпускает короткий signed delegation context с original caller/operation/target.
Он не имеет DB/Kafka/provider credentials и не повторяет mutations.

`api-agent` остаётся deployable role со state `planned`, `implemented=false`,
`deployedInFirstLaunch=false`; в count 15 и Compose не входит.
`config-bootstrap` — trusted initialization/provisioning role, не long-running
runtime. Ни один owner service не публикуется Browser/Edge напрямую.

### 4. `implemented` transition

ADR-0018 `implemented=false` для `api-public/api-internal` снимается только их
принятыми implementation PR; `api-agent` сохраняет false. Для CoffeeOrderPlatform
runtime становится `implemented=true` только когда одновременно существуют:

- source root и composition root;
- service-catalog/interaction/DB/secret entries;
- exact image/toolchain identity;
- contracts и negative exposure tests;
- health/readiness/graceful shutdown;
- workload evidence и accepted PR.

Создание пустого каталога не является implementation.

### 5. Machine-readable authority

До runtime-кода задача #19 обязана создать foundation/topology authority:

- `platform/runtime-foundation-decision.json` и JSON Schema;
- `platform/launch-v1-runtime-profile.json` и JSON Schema;
- `platform/target-layout.json` и JSON Schema;
- validators и negative fixtures в `scripts/`/`tests/authority/`;

- соответствующие schemas/validators/negative fixtures.

После принятия #19 задача #2 создаёт `config/service-catalog.json`,
`config/service-interactions.json`, `config/database-ownership.json` и
architecture checker. #3 материализует toolchain/platform config/Compose.

Runtime profile содержит для каждого из 15 имён: `owner`, `m20RoleRef` либо
явное `launch-v1-only`, `networkZone`, `dbPrincipal`, `httpSurfaces`,
`secretRefs`, `implemented`. Совпадение с M20 нельзя выводить по похожему имени.
До принятого implementation PR значение `implemented=false`.

До их materialization разрешена только документационная работа #14/#2/#3;
runtime feature branches #5–#18 не начинаются.

## Последствия

- Node 26 становится осознанной production authority, а не случайным
  расхождением с M04.
- Network/service overhead 15 процессов принимается ради trust/owner isolation.
- `agent-v1` не реализуется и не получает listener/route/secret.
- Edge остаётся transport/auth boundary, но не composition root бизнес-кода.
- Любое добавление шестнадцатого runtime, общего business API process или новой trust
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

`authority:check` сравнивает точное множество 15 runtime, наличие
`api-public/api-internal`, отсутствие `api-agent` в Compose, его
`implemented=false`, Node/pnpm identities и
наличие всех machine manifests. Пока #2/#3 не завершены, проверка обязана
fail-closed, а не считать документы реализацией.
