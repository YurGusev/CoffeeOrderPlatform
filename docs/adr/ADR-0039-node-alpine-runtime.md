# ADR-0039: Alpine как production image для Node.js 26

Decision ID: `ADR-COP-NODE-ALPINE-001`

Status: Accepted

Date: `2026-10-29`

Supersedes: ADR-0019 только в части production Node image.

Does not modify: версия Node/npm/Corepack/pnpm, 15 runtime, service ownership,
trust roots, topology, канонические revision roots и остальные решения ADR-0019.

## Контекст

В 15 Node-based образах Trixie диагностика G12 показала по 56 HIGH и 3 CRITICAL
OS findings; после доступных обновлений четырёх пакетов остались бы 44 HIGH.
Официальный Alpine image с той же версией Node имел два HIGH finding для
`libcrypto3` и `libssl3`, устраняемых обновлением существующих пакетов.
Владелец разрешил перейти на
официальный `node:26.8.1-alpine` при сохранении Node 26.8.1 и точной OCI identity.
Выбранный index digest —
`sha256:2d984a15c9b54fd0aeb608b8e0d0d83529eb34d2966db27a1fb4f1edc3d298a3`,
`linux/amd64` manifest —
`sha256:ad6400dee476b06e82d0ee3a088e2d7555f6e6569c346e61d69e14d0f19e8c2b`.

## Решение

- Production Node image для build и 14 Node runtime —
  `node:26.8.1-alpine@sha256:2d984a15c9b54fd0aeb608b8e0d0d83529eb34d2966db27a1fb4f1edc3d298a3`.
- Все C/C++ зависимости и Confluent native addon собираются внутри того же
  закреплённого musl-based Node image; `librdkafka` остаётся отдельно собранной
  динамической библиотекой.
- Dockerfile использует APK вместо APT для существующих build/runtime packages.
  Node runtime явно запрашивает обновление существующих `libcrypto3` и
  `libssl3` из подписанного v3.24 repository; отдельная диагностическая
  инвентаризация не исполняется во время сборки.
- `browserHelperNodeImage` остаётся закреплённым Trixie image: G15 browser
  helper использует GNU userspace. `CUSTOMER_TEST_IMAGE` в Compose smoke
  остаётся отдельной test dependency, не production authority.
- Node/npm/Corepack/pnpm pins, application topology, OpenObserve Rust artifact и
  прочие решения ADR-0019 не меняются.
- Этот перенос ограничен build stage и 14 Node runtime. Новые OpenObserve
  storage-helper/native-image stages здесь не добавляются.

## Ограничения evidence

Отдельный diagnostic Trivy report
`node-alpine-patched-os-diagnostic-01/out/vulnerabilities.json` имеет SHA-256
`8fa95f29cfc4b355190711c13c3d8d17fd863e20df20df2bc1a02d5151728bd1`.
Он описывает Alpine 3.24.1 с 18 системными APK до и после отдельного обновления
только `libcrypto3`/`libssl3` до `3.5.9-r0`: число пакетов осталось 18. Это
результат диагностического образа, а не assertion production Dockerfile. В этом
диагностическом срезе нет HIGH/CRITICAL OS findings; остаются один MEDIUM
finding для zlib и два UNKNOWN для musl. Это evidence только об OS packages,
не доказательство безопасности всего образа, Node ABI или совместимости
native workloads.

До допуска production каждый runtime всё ещё должен пройти exact-image build,
native addon load/ABI smoke, workload tests, security scan, SBOM и provenance
gates ADR-0019. Изменение базового libc требует повторить эти проверки; один
успешный build или OS scan их не заменяет.

## Откат

Возврат production image к Trixie требует нового принятого решения и повторной
сверки toolchain BOM, foundation authority, Dockerfile и validators. Отдельный
G15 browser helper остаётся на Trixie независимо от rollback production image.
