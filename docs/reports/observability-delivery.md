# Поставка стека наблюдаемости

OpenObserve заменён готовыми Grafana, Loki, Prometheus и Tempo как четырьмя отдельными сервисами одного Compose с Alloy. Vendor Rust/Go не компилируется. Canonical config, scoped SOPS materialization, private network, producer guarantees и business ownership сохранены. Поставка: [issue #210](https://github.com/YurGusev/CoffeeOrderPlatform/issues/210), [PR #211](https://github.com/YurGusev/CoffeeOrderPlatform/pull/211), [ADR-0040](../adr/ADR-0040-grafana-observability.md), [Operations](../operations/observability.md).

## Source и результаты

Проверенный executable commit — `e6c2e7d5af9854cb625e92bd26e6022f8bad18b5` (C8). Base PR209 — `103359a8d1a1787ff5e4ebc4a522c195165b0a9b`, включённый develop — `98c8eef1da209d43f374e118c4d4107ba13fc12b`. Source identity G14 start/end/current: `836a69754d0e822469d2beb63d56406e44f7c28eaa90adca3b8678d5794d4bcc`.

Финальный delta после C8 содержит только документацию/report/handoff. Receipts сохраняют фактически проверенный SHA; новый HEAD не объявляется повторно просканированным. Проверки doc-only delta и merge фиксируются в PR. Команды ниже выполнялись в clean checkout C8, а не являются инструкцией переименовать старый context для другого HEAD.

| Проверка | Результат |
|---|---|
| `pnpm versions:check`, `pnpm config:check`, `pnpm security:secrets` | PASS |
| `pnpm lint`, включающий typecheck; `git diff --check` | PASS |
| `node --test tests/observability/alerts.test.mjs` | 38 PASS / 0 SKIP / 0 FAIL, около 3,5 s |
| Actual-source regression на C7, затем C8 | RED (`5m` вместо `30s`) → GREEN |
| Independent C8 code review | Нет P0/P1/P2; diff SHA `275739b5ffd7740110469330dbd7f6a8b1c7150995bb779ff1f5c2bee277401d` |
| [CI C8](https://github.com/YurGusev/CoffeeOrderPlatform/actions/runs/41125978538) | SUCCESS: 1496 tests / 1417 PASS / 79 SKIP / 0 FAIL; основной набор 214,994 s |
| G12 `20261030T204719Z-e6c2e7d` | Independent component PASS, 1518,287 s; 22 images + lockfile / 46 reports |
| G14 `00bf08bb-a371-4e52-b26d-23c08e06ce16` | Independent operations-component PASS, 3649,763 s; все 11 фаз PASS |

Контекст: `/home/yurgusev/.codex/worktrees/preserve-non-openobserve/CoffeeOrderPlatform/evidence/launch/20261030T204719Z-e6c2e7d/context.json`; `TMPDIR=/media/yurgusev/coffee-g12-cache-210/coffee-issue-210/tmp`. Фактические команды с этими env: `node tools/security-scan.mjs` (package script `pnpm security:scan`) и `pnpm test:observability`. Ceiling внешнего component wrapper — 5400 s; formal runner budget 1800 s не менялся.

G12 result SHA `cec88d12f3249a57b0261abe82da5d2f7ae8d500672897bc93e1969a81274e4a`. Проверены 46 report bytes/size/SHA, source/config/BOM/lock/Git archive binding, 15 runtime image IDs и физические Kafka/Grafana/storage OCI receipts. Grafana ZIP/MANIFEST/gpgv signature проверены ключом `F33B25B691074E84636570F37E4D0C6A708866E7`, exact two OpenVEX decisions совпали. Raw HIGH 2 / already-fixed 2 / unresolved HIGH 0 / CRITICAL 0; cleanupFailures/imageCleanup пусты.

G14 подтвердил три сигнала, correlation/redaction, шесть alert episodes, nginx 1→0→1, 14 Node-ролей, owner launch path, memory/outage/loss, filelog checkpoint/crash/recreate, persistence и backup/restore. Loki pressure — native WAL watermark/503/counter с recovery; ENOSPC Loki не заявляется. Grafana/Prometheus/Tempo достигли ENOSPC, подтвердили native failure, filesystem identity и old/new recovery в том же процессе без OOM. Production retention до/после восстановления: все три backend по 259200000 ms. Tempo fixture effective cleanup 30000 ms; последнее наблюдение: old trace отсутствует, fresh control виден, непрерывное отсутствие 120170 ms. Cleanup без ошибок, exact baseline: 15 containers / 22 networks / 606 volumes.

Независимые receipts: `/home/yurgusev/.cache/coffee-grafana-migration/image-admission-e6c2e7d.{json,md}` и `runtime-admission-e6c2e7d.{json,md}`. G14 artifacts находятся в `evidence/observability/00bf08bb-a371-4e52-b26d-23c08e06ce16/`; их SHA вычислены непосредственно из файлов и зафиксированы ниже. Отдельного независимого manifest ожидаемых SHA внутри result нет.

| Artifact | Bytes | SHA-256 |
|---|---:|---|
| `alert-transitions.json` | 1663 | `0b387de81441859282756e59e56460b64fbb47ad8041cb37099cbf5976b9bd24` |
| `correlation-proof.json` | 3717 | `d9ba61262b2b1cebd35ffb18d08ec9cdc8ee5ac3b55d65f2145d9e54c67c3e65` |
| `queue-loss-counters.json` | 7004 | `cb611ce31b2bfc94d1efd9dd8698d860f8ad22622004b2ae2a8ff4716db0d6ab` |
| `redaction-scan.json` | 258 | `b2623f4f622aaa8115559d77f335e5c76ead81e30b5779399ffb337bf1768cac` |
| `result.json` | 143493 | `5c5a6c58c375f57ed4edc60cfe96681bb845879d4930f7036268954df6d457c8` |
| `retention-result.json` | 8216 | `f045f1d9686c17aae6e004823b1747a73c92c9d5a03fa5221ac7bde61c87b92c` |
| `runtime-health-matrix.json` | 121820 | `7db5da89220199d31e0a9a71ef91a85bf0c8b57419bbcf4be5120c7d7cd367e4` |

## Каждая галочка issue

| № | Код/authority | Evidence |
|---|---|---|
| 1 | Base PR209/input64; Git ancestry и `evidence/handoffs/issue-64.yaml` | Ancestors и исторический input SHA проверены; сведения handoff ниже. |
| 2 | `docs/adr/ADR-0040-grafana-observability.md`, `docs/operations/observability.md`, `packages/platform-observability/src/index.ts` | Producer guarantees сохранены; signals/correlation/redaction PASS. |
| 3 | `docs/launch/13_DELIVERY_DEPENDENCY_GRAPH.md`, `21_LAUNCH_VERIFICATION_SPEC.md`, `verification/launch/v1/scenarios/preflight.mjs` | Новый handoff #210 передаёт Operations в #13, не закрывая full-system admission. |
| 4 | `config/toolchain-versions.json`, schema, `scripts/check-toolchain-versions.mjs` | Versions PASS; G12 exact amd64 IDs/manifests, реальный startup/CPU в G14. |
| 5 | `tools/observability/generate.mjs`, `health.mjs`, `tools/security-scan.mjs` | Alloy components, nginx/httpcheck, filelog recreation/crash checkpoint и exact scan PASS. |
| 6 | `config/platform.yaml`, schema, `packages/platform-config/src/index.ts`, `scripts/config-lib.mjs` | Config PASS; source/config/BOM/lock hashes связаны с G12/G14. |
| 7 | `tools/observability/{generate,storage,health}.mjs`, `tools/config-bootstrap/index.mjs` | Четыре private non-root backend, отдельные bounded volumes, finite limits/grace, scoped secrets и network isolation PASS. |
| 8 | `tools/observability/generate.mjs`, `verify.mjs`, `packages/platform-observability/src/index.ts` | Три сигнала, resource/correlation/redaction, bounded queue/retry/loss и независимость readiness от telemetry outage PASS; Docker socket отсутствует. |
| 9 | `tools/observability/{generate,alerts,verify}.mjs` | Production retention 3 дня effective/restored; четыре native pressure/recovery и alert 80% PASS. Универсальный 503 при 80% заменён решением владельца. |
| 10 | `tools/observability/{generate,storage,verify}.mjs` | Реальные WAL/TSDB/block/live-store paths, restart/recreate, checkpointed crash, old/new markers и backup/restore PASS. |
| 11 | `tools/observability/alerts.mjs`, `alert-sink.mjs`, `verify.mjs` | Все 6 firing→delivery→resolved episodes, окна/scoping и nginx 1→0→1 подтверждены. |
| 12 | `tools/security-scan.mjs`, `verified-infrastructure-image.mjs`, preflight | G12 22 images + lock / 46 reports PASS; consumers и fail-closed G00/G12 сохранены. |
| 13 | `package.json`, `tools/compose-smoke.mjs`, `tests/observability/{fixture,launch-path,runtime-matrix}.mjs`, realtime fixture | Реальный component G14, 14 Node-ролей + nginx и owner launch-path proof PASS; это не capacity proof. |
| 14 | Исполняемые `apps`, `packages`, `tools`, `scripts`, `config`, Dockerfile/package.json | Поиск OpenObserve — 0 совпадений; старые receipts, user volumes и rollback сохранены. |
| 15 | Version/config/secrets/lint/typecheck и existing tests | 38/38 affected; CI 1417 PASS / 79 SKIP / 0 FAIL; пропуски не объявлены runtime PASS. |
| 16 | `tools/observability/verify.mjs` и 7 artifacts ниже | Все 11 фаз текущего реального G14 PASS; source identity start/end/current совпали. |
| 17 | Реальный G12 текущего source и exact integration targets | Независимый audit PASS; прежние отрицательные результаты сохранены, не переименованы в C8. |
| 18 | Operations/launch/ADR, этот отчёт и `evidence/handoffs/issue-210.yaml` | Один handoff: 41 output hash, input64; actual commands/limitations и Obsidian обновлены. |
| 19 | Ветка `feature/210-grafana-observability`, PR211 → develop | Base/head/closing only210, independent reviews и проверки подтверждены; final doc-only review/CI/merge фиксируются в PR. |

## Handoff

[Новый handoff](../../evidence/handoffs/issue-210.yaml) содержит 41 output для consumer13, без self hash. Единственный input — #64: accepted merge `e6439599be85a5fc8b83d99293064e877a2ff012`, artifact `evidence/handoffs/issue-64.yaml`, исторический SHA `73283a79ba020cb126351506f324be9439975516af42a90b235d6bdf9484afae`. PR209 — base-preservation, не отдельный выдуманный issue/handoff input. Ancestry и исторический hash проверены. До report/handoff diff состоял из 50 файлов: 40 downstream artifacts и 10 existing unit tests.

## Отрицательные результаты и исправления

C7 G14 `6709be43-82d0-4a86-9bb1-6510b7add248` FAIL за 3598,358 s: 10/11 фаз PASS, только Tempo TTL timeout; SHA `01bb517446f798ce7a671f291de7c00e4c809ca55273d4d0dd1f81036048fb84`. C7 CI/G12 PASS не переименованы в C8. Более ранние C6/ENOSPC и неуспешные diagnostic attempts также сохранены.

[Exact Tempo source](https://github.com/grafana/tempo/blob/a0826bc9eb8397d614dde91fb00b3809835b7e52/modules/livestore/live_store_background.go#L215-L236) использует `live_store.flush_op_timeout` как cleanup period, а `complete_block_timeout` — возраст. No-feeder пара на fresh volumes: исходные 5m дали первое отсутствие trace на 303,393 s, поэтому обязательные следующие 120 s не помещались в deadline 360 s. Единственное изменение cleanup30s дало отсутствие 218,471→340,657 s и 13 видимых fresh controls. Restore/cleanup прошли. Полный C8 подтвердил исправление уже с историей G14; production cadence/retention, compaction, deadline6m и absence2m не менялись. Producer остановлен до retention; первоначальное предположение root об активном feeder было ошибочным и исправлено независимым review.

Loki fixture оставляет cache включённым с TTL30s; production cache1h не меняется. Native pressure сохраняет ENOSPC до запроса там, где он требуется, identity и реальный failure; освобождение блоков после SQLite rollback не отменяет уже наблюдённый отказ. Конкретный потерянный branch прежнего C6 Grafana mismatch остаётся неизвестным. SDK DNS и Convergence held-read RED/GREEN, специализированные live PG/mTLS 2/2 сохранены с собственным C6 binding; они не называются C8 runs.

Первый C8 G14 `899f4084-11e8-47b8-b0b7-69cf380f79ea` был прерван disk guard через1116,11s при rootfree36522135552B ниже guard36541335962B, без result. Root поздно прочёл wrapper и несколько минут ошибочно считал leftover containers активным прогоном; владелец уведомлён. Ownership/identity-checked cleanup независимо вернул baseline15/22/606. Ledger SHA `f8e403019cb664c43d62c7eab933806fda9eb6d303130165cd74a913a83a144a`.

Шесть старых own test images удалены без force/prune/currentC8refs, observed free delta0,322GB; шесть public ELF copies перенесены с SHA в два внешних content-addressed объекта, исходные пути — symlinks, delta2,600GB. Native03 rollback32GB/receipt сохранены, его bytes заново не читались. Archive links требуют дополнительного тома; старые custom images были recomputable cache, не exact OCI backup. Повтор стартовал при39,65GB и10/15 resident IDs; wrapper добавил2GiB start headroom и atomic live-state2s, не меняя formal thresholds. Минимум root free успешного G14 —39200169984B, disk/budget stop=false. DockerRootDir остаётся `/var/lib/docker`, overlay2; перенос BuildKit cache сам по себе не переносит runtime images. Глобальная конфигурация Docker не менялась.

Kafka receipt подтвердил ACK/new container/same volume/recovered healthy/retained record. Preparation имел три рестарта и Kafka readiness deadline в интервал recreate; native cause в доступном журнале не раскрыта. Совпадение времени не выдаётся за доказанную native-причину. Полный компонентный G14 прошёл со своими assertions; zero-restart гарантия всех Node-ролей не заявляется.

## Ограничения

- Полный #13, G00/formal launch admission, постоянный deployment, реальное наблюдение72h, capacity, HA и внешние notifications не приняты. G14 превысил formal1800s; G12 уложился, но acceptedBaseCommit=null/G00 не принят. Owner launch path — `owner-launch-path-proof-only`, `owner-launch-path-not-capacity-proof`.
- Tempo — согласованный dev/local-storage вариант. Допускается только artifact-specific already-fixed VEX `CVE-2026-21728` и `CVE-2026-28377` в точном Tempo plugin; неисправленная go-jose запрещена. Raw HIGH/UNKNOWN сохраняются, «0 CVE» не утверждается.
- Нормативный G12 scope —22 images + lock /46 reports. Supplemental PostgreSQL Debian17.11:86HIGH/2CRITICAL/9UNKNOWN (gosu/libxml2); Alpine17.11:34HIGH/1CRITICAL/3UNKNOWN. Это findings тестового инструмента, без VEX/clean-claim и без расширения G12 targets; business PostgreSQL внешний.
- BuildKit `INCOMPLETE_LOCAL_CONTEXT` дополнен immutable Git archive binding. Полной SLSA/source-to-binary completeness нет; module source ZIP/SumDB inclusion proof отдельно не сохранён.
- OTLP resolver — IPv4 DNS Compose, без `/etc/hosts`. Raw local evidence не опубликован как GitHub artifact. Пользовательские данные/volumes и исторические receipts не удалялись.

## Время и рекомендации

Affected loop — около3,5s, основной CI C8 —214,994s, G12 —25m18s. Сумма18 Buildx Duration291,173s не равна wall time;23 vuln containers65,529s,23 convert6,376s,DB download25,530s,JavaDB89,254s. Неразмеченное время не приписано IO/компиляции. G14 содержит реальные alert/fault/TTL окна и запускается для acceptance, а не после каждого сохранения файла.

Следующая оптимизация verifier — сначала монотонные timings/bytes существующих операций, затем сокращение повторных reads при сохранении fail-closed byte binding.48 проверок двух DB snapshots дают около144GiB логического чтения; физическое IO/главный bottleneck не измерены. BuildKit cache сохранён, vendor sources не компилируются, глобальный prune не использовался. Дополнительная переработка verifier в эту поставку не включена. [Docker cache guidance](https://docs.docker.com/build/cache/backends/) и [daemon storage](https://docs.docker.com/engine/daemon/) подтверждают необходимость раздельного учёта cache и runtime storage. Результаты и рекомендации сохранены в Obsidian.
