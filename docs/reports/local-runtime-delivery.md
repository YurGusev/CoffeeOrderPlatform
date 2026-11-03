# Постоянный локальный runtime и самостоятельный каталог — #254

**Runtime acceptance PASS.** CI, G12, cutover, native install/adoption и fresh browser proof относятся к frozen Source ниже. Финальный metadata HEAD CI и merge проверяются отдельно в GitHub.
Frozen Source: `7b019e3bbf791a3896dd280567dbc7222c43f0e8`. [CI 41633892098](https://github.com/YurGusev/CoffeeOrderPlatform/actions/runs/41633892098) — SUCCESS; receipt `runtime-7b019e3-ci.json`.
Развёрнутый runtime: `7b019e3bbf791a3896dd280567dbc7222c43f0e8`, release `7b019e3bbf791a3896dd280567dbc7222c43f0e8-aa4641932b568422-5a82f66aaad0`; controller `~/coffee-platform/runtime/controllers/7b019e3bbf791a3896dd280567dbc7222c43f0e8`. Исходный baseline C13 `dd87e7ce41739a9f6ba7d4c55f524f2f57b344ff` сохранён в before evidence.
PR: https://github.com/YurGusev/CoffeeOrderPlatform/pull/261; baseCommit: `6e770bef48b8a9739e2a3aea3b5f9c654a53cc71`.

## Результат и границы

Один normal start/status/stop/recover/install путь поднимает 14 Node roles, nginx, Kafka и Keycloak на существующем PostgreSQL, сохраняя наблюдаемость и данные. Owner входит через настоящий HTTPS/OIDC/PKCE; credentials остаются в SOPS/scoped tmpfs. Код и release config привязаны к frozen controller и точным проверенным image IDs.
Самостоятельный каталог показывает первую страницу активного persisted snapshot без query/orderRef, поддерживает поиск, cursor-пагинацию и Back. Add доступен только editable Draft по allowedActions; просмотр не создаёт заказ и не вызывает Pricing/provider. Authority: ADR-0042, ADR-0043, LOCAL_PLATFORM.md и действующий client-v1 контракт.
AROMA mutations выключены. Четыре durable Kafka groups один раз инициализированы оператором по отдельному разрешению; normal start не сбрасывает offsets. Bootstrap admin уже retired; новый recover/retirement не требуется.
Normal runtime acceptance не заменяет [formal #13](https://github.com/YurGusev/CoffeeOrderPlatform/issues/13): отдельные exact-candidate G00–G19 обязательны, formal допуск этим отчётом не заявляется.

## Проверки и сохранённые функциональные proofs

- Новый frozen Source: CI 41633892098 SUCCESS; canonical warm 15 завершён. G12 `20261103T124053Z-7b019e3` **PASS 1361.089 s**,24 targets / 48 reports, provenance PASS, unresolvedHigh=0 / critical=0, cleanupFailures=[]. Result SHA256 `d713ceb9fbb672690770078aa830b414948643a35d4680d8e06a931acd05cbb7`. Это normal component admission, не formal G00–G19.
- Before snapshot: **CAPTURED_DEGRADED_BASELINE**. Старые C13 `aroma-convergence`, `realtime-gateway`, `orders-aroma-preparation` running/unhealthy; остальные 20 ready. Все 72 registry Kafka offsets сохранены, active members отсутствовали. Readiness failures начались около 12:21 UTC, до G12; broker зафиксировал heartbeat expiration 12:22:33–34. Исходная причина не установлена, G12 её причиной не объявляется. После единственного cutover новый source прошёл строгую readiness: 23/23 ready, 17 product healthy; причиной старого отказа или доказанным исправлением его первопричины замена не объявляется.
- Один разрешённый customer/Confirmed order создан на Source `6fdb0ebe774749fa5d95980df3f5bff048d5d58f`. Реальный API→owner DB→Outbox→Kafka→Inbox/projection→SSE и causal GET подтверждены browser и lineage receipts. Клиент `cus_01M6FHFRWZJY5SRS6A43K3CZSN`, заказ `ord_01M6FHFS4A96CR3TX6C5WKR734`, quantity 1 сохраняются по информированному разрешению; Cancel/Delete API нет. Второй заказ не нужен.
- Customer CHECK/ICU подтверждён owner-scoped readback; existing runtime role не имеет SELECT migration ledger, его чтение не заявляется и права не расширялись.
- C13: один systemd restart PASS за 189.358 s; app availability gap upper 160.922 s, issuer 40.416 s; данные, 624 volumes, 22 protected containers, 72 offsets и retired identity/JWKS сохранены.
- C13: native maintenance no-op и отдельное natural renewal PASS. Renewal 221.841 s обновил 15 transport leaves при прежних CA/SPKI; Customer notAfter 2026-11-04T11:11:58Z; app gap upper 180.986 s, issuer 44.879 s. Последующее fresh owner login/SSE/чтение того же заказа PASS.
- C13: один controlled warning event доставлен в Loki, подтверждён Grafana query 200/visible reason и REA; повторной публикации не было. Timer enabled/active подтверждён отдельным receipt. Это не доказательство будущих срабатываний timer.
- На новом source выполнен один cutover, canonical native install/adoption и один fresh browser proof. Отдельные restart/renewal/recover и новый бизнес-сценарий не выполнялись.

## Граница переиспользования maintenance evidence

Сравнены Git objects `dd87e7ce41739a9f6ba7d4c55f524f2f57b344ff` → `7b019e3bbf791a3896dd280567dbc7222c43f0e8`: следующие 24 blobs/trees совпадают (tree связывает содержимое и modes всех вложенных файлов). Это поддерживает переиспользование указанных C13 lifecycle/maintenance proofs в неизменённой области. G12 и фактический cutover/adoption/browser proof нового source подтверждены собственными receipts; C13 image admission не переносится.

| Неизменённый путь                         | Общий Git object                           |
| ----------------------------------------- | ------------------------------------------ |
| `Dockerfile`                              | `922a698bafe24709fbf6f0b5edf5a7257138a5cf` |
| `compose.yaml`                            | `c4fb2bc3e43debf90e9d9d1d47189be95b39dc89` |
| `pnpm-lock.yaml`                          | `edfbe972986bc67daa4176b73cd898e961361013` |
| `package.json`                            | `6823a3b4705e3f9f8bedcee6d31d07c36dbfdd1a` |
| `config`                                  | `2c0c753e0c70a06c072884fb8b23ff9dba770530` |
| `secrets/platform.secrets.sops.yaml`      | `3440a8674654ae9068f3d1d05e636ac0888aae66` |
| `tools/platform-service.mjs`              | `93f8e8fa0a11f091b5218a1adfbcae28586ee9f6` |
| `tools/config-bootstrap`                  | `b0ee2894e52b207bb79c255c7a45f7401f8a3495` |
| `tools/compose-smoke.mjs`                 | `8fa591a085deee4d32b52ab40bef0894501e20b9` |
| `tools/verified-infrastructure-image.mjs` | `ac7ea7423aa39dd0d02596dabfb646af3d4a0603` |
| `tools/security-scan.mjs`                 | `ee0d7f2bb086782453f1933ff0e1151ad6cea8ff` |
| `tools/observability`                     | `0dd7779c137461e4157dfc8dd772f19ebf37bb59` |
| `scripts/config-lib.mjs`                  | `4b5961a5922b81089213a3f47ad11d4b2d1ce44d` |
| `verification/launch/v1/report.mjs`       | `dc9fe87ac32d09f85632154537ddbd254edd0f14` |
| `packages/platform-runtime`               | `d861c64a4aca698b95164083b5e3c8faa497e22b` |
| `packages/platform-security`              | `0d027308002fa73eeb254c4e62a76a8f2d16d35e` |
| `packages/platform-kafka-runtime`         | `63714ad9780a8fc188713010f782787e99089402` |
| `packages/platform-observability`         | `53585c1945b00717220466481ab6d652122a584d` |
| `packages/platform-config`                | `a0a0b8f49e639a4e9890c586e3a94112383ef598` |
| `packages/platform-database`              | `d2647a58bbbaa3740e9f0ffd9de4de8465a09ea7` |
| `apps/edge-gateway`                       | `91d85c6a3542f02e02af779d96cfe90da181e738` |
| `apps/customer-service`                   | `79da3f029be37376facc7886c9a264e992c8f3d8` |
| `apps/orders-service`                     | `03db0abaa3cf031f5a32919faf9f4d6f657e9afc` |
| `apps/realtime-gateway`                   | `cd97a67e5c961fe2465bfab0fd37d0302b0a8ee2` |

Проверка: `git diff --name-only <C13> <7b019e3> -- <перечисленные пути>` вернула пустой результат; пары `git rev-parse <source>:<path>` равны. Изменения Catalog/API/Web и contracts за этой границей покрываются новым CI и выполненным runtime/browser proof.

## Первичные receipts

Все файлы ниже сохранены локально в `/home/yurgusev/.cache/coffee-launch-delivery/`; это не загруженные GitHub artifacts. SHA256 относится к bytes receipt. Source bindings не заменены новым candidate SHA.

| Proof                                            | Receipt                                                 | Source                                     | SHA256                                                             |
| ------------------------------------------------ | ------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------ |
| CI нового frozen Source                          | `runtime-7b019e3-ci.json`                               | `7b019e3bbf791a3896dd280567dbc7222c43f0e8` | `5d96f15c144e0fafbb926497e850e7da213be9dcf745eb06fc28874d953652fc` |
| Единственный Confirmed order / API→SSE           | `runtime-one-order-6fdb0eb.json`                        | `6fdb0ebe774749fa5d95980df3f5bff048d5d58f` | `1efd43bbeb6d7407f9fe5e5e8c769b9b5da8fd449c8cda4022b7ea618c608011` |
| Owner DB/Outbox/Inbox/Kafka lineage              | `runtime-one-order-lineage-20261103T022114340Z.json`    | `6fdb0ebe774749fa5d95980df3f5bff048d5d58f` | `117d4d2a8f345f32c3be720f629357900b9f3e49d568f76e3e1e4199094f852e` |
| Installed Customer CHECK/ICU                     | `runtime-customer-delta-f6ea2db.json`                   | `f6ea2dbec9fdf8990061c52b62680157191620cf` | `98fa2796fd81b0e6ccfe184b0d81983696a6ccc0b391185f0bd6165c170f1d99` |
| Измеренный restart / persistence                 | `runtime-restart-dd87e7c-comparison.json`               | `dd87e7ce41739a9f6ba7d4c55f524f2f57b344ff` | `b2910bc10367d55d140401b2eede14a0439a14bc21a21fb1cfb78ecaec64cff9` |
| Native maintenance no-op                         | `runtime-maintenance-noop-dd87e7c.json`                 | `dd87e7ce41739a9f6ba7d4c55f524f2f57b344ff` | `ec1c3024136c44ad0b862b5b0ecafba63a7eb9bcc801e3083a4e30addd90d6e3` |
| Реальное natural renewal / persistence           | `runtime-renewal-dd87e7c-comparison.json`               | `dd87e7ce41739a9f6ba7d4c55f524f2f57b344ff` | `110c5c019ddd6bd9da236a3688a5ac8f8c7c00e6436bbdc72c8a208d4670f931` |
| Warning real Loki / Grafana / REA                | `runtime-maintenance-warning-dd87e7c-reconciled.json`   | `dd87e7ce41739a9f6ba7d4c55f524f2f57b344ff` | `014bcc7d6788aa8e64c6efa622e86024b67335292cf0145eaaef6836bfda0b9c` |
| Native timer enabled                             | `runtime-timer-dd87e7c.json`                            | `dd87e7ce41739a9f6ba7d4c55f524f2f57b344ff` | `67787d884cf4b5fb493323c9143d93645f2dbff7ba30a2d9545230117015b0c6` |
| G12 PASS / exact images                          | `runtime-7b019e3-scan-summary.json`                     | `7b019e3bbf791a3896dd280567dbc7222c43f0e8` | `92e68c1d41635030c8e8ec3499199d9a37d75e93f81ab22f6c1fd1cfea7d059b` |
| Captured degraded old baseline                   | `runtime-cutover-7b019e3-before.json`                   | `dd87e7ce41739a9f6ba7d4c55f524f2f57b344ff` | `f50b1b23213678b0f53262c2b03f1d1acc90ee959ffcdc814bb74271594f51aa` |
| Bounded old-runtime diagnosis                    | `runtime-c13-degraded-baseline-diagnosis-20261103.json` | `dd87e7ce41739a9f6ba7d4c55f524f2f57b344ff` | `1b4f7b3af10f93c568f4d7759ea1b91d6163575e301de913dd5bb394abb523ea` |
| Exact-source cutover / image IDs                 | `runtime-cutover-7b019e3.json`                          | `7b019e3bbf791a3896dd280567dbc7222c43f0e8` | `a48a1b3c9ff0f9e785a70a29f97029e8874caefbbc5f1aac374287711723aa8a` |
| Measured cutover / HTTPS downtime                | `runtime-measured-cutover-7b019e3.json`                 | `7b019e3bbf791a3896dd280567dbc7222c43f0e8` | `6eba12d6aac86f98a411c2dabc163e422e482c273ac67f8aed59f2d69484d8a4` |
| Canonical install/adoption / unchanged IDs       | `runtime-unit-install-7b019e3.json`                     | `7b019e3bbf791a3896dd280567dbc7222c43f0e8` | `c55eda52e3cac1b721e2b5f4746eb7f10d17b2905e12845b27f1ffd9d570f021` |
| Fresh OAuth/SSE/order/catalog navigation         | `runtime-browser-7b019e3-cutover.json`                  | `7b019e3bbf791a3896dd280567dbc7222c43f0e8` | `e92d9c750983c7b1349dc2fd2f775d8cf4f8fc5f84eb1d3b4daa3c70cf23f5eb` |
| After snapshot / strict readiness                | `runtime-cutover-7b019e3-after.json`                    | `7b019e3bbf791a3896dd280567dbc7222c43f0e8` | `5fc551eac8295d39de46dc3496cfb8e9daef704316a2c5734f59175fbb8df0d6` |
| Cutover persistence                              | `runtime-cutover-7b019e3-comparison.json`               | `7b019e3bbf791a3896dd280567dbc7222c43f0e8` | `7966ab7d834a3511e36fb382d216bf9e55e30b43d2d73ff2836debe1aba50a0e` |
| REA DOM/viewport, browser receipt source binding | `runtime-catalog-7b019e3-rea.json`                      | `7b019e3bbf791a3896dd280567dbc7222c43f0e8` | `667c7ebd8f7391f45dae659de2489564c1a29150e35bfa5c827faf46521a4f9e` |
| REA viewport screenshot                          | `runtime-catalog-7b019e3-rea.png`                       | `7b019e3bbf791a3896dd280567dbc7222c43f0e8` | `2fc52f1c899696ea0c8997d40c2d25aa96acfae7b058e9fecf27b8e25d7441bd` |

## Фактический итог перехода

- CLI start завершился за 944.650 s; полный measured cutover 999.309 s. HTTPS app availability gap upper 966.036 s (observed 963.940 s), issuer 842.725 s (observed 840.444 s). Во время native start потребовалась сборка 10 отсутствующих application images с обязательным совпадением scanned IDs; этот расход не относится к config-bootstrap. Быстрый бесшовный переход не заявляется.
- Canonical same-source install/adoption PASS 18.661 s: container IDs/StartedAt сохранены, второго рестарта не было. Два прежних service units архивированы и сверены; timer сохранён byte-identical enabled/active.
- After snapshot и comparison PASS: 23 ready / 17 product healthy,624 прежних volumes сохранены +1 новый anonymous volume,22 protected containers unchanged, 72 offsets nondecreasing; разрешён только readonly log rebind collector. Общая identity.json/OID/JWKS, отсутствие bootstrap env/import mounts, CA и Customer SPKI сохранены. Fresh scoped leaf Customer действует до2026-11-04T13:27:12Z; отдельного maintenance запуска не было.
- Fresh owner OAuth/HTTPS/SSE и тот же customer/Confirmed order/version 3 / quantity 1 PASS; projectionVersion может расти. Standalone Catalog snapshot 12: первая страница 20, вторая 20, search 20, Back/Forward PASS; businessCommands=[]. Add только editable Draft покрыт существующим suite и CI; в самостоятельном каталоге Add отсутствует.
- REA подтвердила 20 articles/noAdd и screenshot текущего viewport. Source независимо связан runtime/browser receipts; REA artifact identity самостоятельно не удостоверяет. Это не полнота всех browser events или экранов.

## Завершение delivery

Фактические runtime proofs завершены. Перед merge остаются review и публикация metadata/report/handoff, CI фактического final GitHub HEAD и проверка closure #254. Self-reference на несуществующий metadata commit не добавляется; runtime/G12 SHA сохраняется.

## Существенные ограничения

Полный host reboot, rollback на старый source и downgrade схем не проверены. `recover` означает retirement bootstrap-admin, а не rollback. Runtime acceptance подтверждена перечисленными receipts на момент проверки. Причина старой деградации остаётся неизвестной; длительная стабильность под будущей нагрузкой этой точечной приёмкой не доказана.
Handoff содержит 60 outputs по Git blobs frozen source, этот итоговый report с его фактическим hash и шесть ранее принятых input bindings. Итоговый metadata commit не имеет self-reference: CI его реального GitHub HEAD проверяется перед merge, а runtime/G12 остаются привязаны к своему frozen Source.
Подробная история предыдущих попыток сохранена в primary receipts и исторических backups частных drafts; старые FAIL не переписаны в PASS.
