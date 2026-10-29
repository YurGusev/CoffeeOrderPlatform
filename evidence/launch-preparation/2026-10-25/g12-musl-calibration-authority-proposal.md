# G12: проверка Node 26.8.1 на Alpine после фактического FAIL Trixie

Статус: предложение владельцу; новые pins и ABI ещё не применены.
Подготовлено 25.10.2026. Предыдущее разрешение на Trixie сохраняется как история.

## Основание и результат, который требуется проверить

Фактический G12 `20261025T171921Z-3550896` сохранил 8 из 38 отчётов:
lockfile без HIGH/CRITICAL, три Node runtime image — каждый с 56 HIGH и 3 CRITICAL.
Частичная сумма HIGH168/CRITICAL9 не является результатом полного scan.
Лимит1800 секунд остановил дальнейшие сборки; cleanup независимо подтверждён.

Для части findings есть обновления Trixie, но для util-linux и curl остаются
HIGH без исправления в stable. Это подтверждают первичные
[Debian util-linux tracker](https://security-tracker.debian.org/tracker/source-package/util-linux)
и [Debian curl tracker](https://security-tracker.debian.org/tracker/source-package/curl).
Простой `apt upgrade` не обеспечивает требуемый ноль HIGH/CRITICAL.
Фактический ELF `librdkafka.so.1` требует `libcurl.so.4`; удалить эту библиотеку
без замены native path нельзя. См. `g12-runtime-binary-dependencies.json`.

Предлагается один ограниченный trial другого Linux ABI. Нулевые findings,
работоспособность и пригодность Alpine до проверки не утверждаются.

## Точные изменения и границы

1. В изолированном candidate задать `nodeImage` только в canonical
   `config/toolchain-versions.json`:
   `node:26.8.1-alpine3.24@sha256:2d984a15c9b54fd0aeb608b8e0d0d83529eb34d2966db27a1fb4f1edc3d298a3`.
   Проверенный linux/amd64 manifest:
   `sha256:ad6400dee476b06e82d0ee3a088e2d7555f6e6569c346e61d69e14d0f19e8c2b`.
   Registry bytes и хэши сохранены в `g12-alpine-research-registry.json`.
   Несовпадение index/manifest даёт STOP, подстановка другой версии запрещена.
2. Числовые версии Node26.8.1, pnpm, Confluent binding и librdkafka2.15.0
   сохраняются. Пересобрать существующие native binding/librdkafka из тех же
   исходников под musl; заменить apt build/runtime packages их Alpine
   эквивалентами только для уже используемых возможностей TLS, SASL, curl,
   zlib, zstd, lz4 и C/C++ compilation. Не отключать существующие возможности.
   Использовать только stable Alpine3.24 repositories, без edge/testing и glibc
   compatibility shim. Обновить пакеты в этой ветке через штатный `apk upgrade`;
   фактические версии и источники обязаны попасть в SBOM/provenance.
3. Все 14 Node production runtimes используют единственный Alpine путь.
   Debian/Alpine fallback и два production пути не сохраняются. Неиспользуемые
   npm/npx удаляются только из final runtime, как уже разрешено.
4. G15 Chromium helper требует glibc. Добавить один обязательный canonical
   `browserHelperNodeImage` с уже разрешённым
   `node:26.8.1-trixie-slim@sha256:c0753125a3789977aefe869cbebccf70e3cfd7ea84ca48547458f02e4f1d7146`.
   Существующий browser driver читает только этот ключ, без fallback.
   Он остаётся временным verification helper и не входит в production images.
   Это не разрешение исключать какие-либо production targets из G12.
5. Синхронизировать существующие Dockerfiles, BOM/schema/validators,
   compatibility matrix, fixtures/tests и обычную инфраструктурную документацию,
   непосредственно зависящие от этих pins/ABI. Другие dependencies, services,
   public/wire API, secrets, grants, provider policies не менять. Kafka4.3.2,
   Collector0.163.2, OpenObserve и scanner pins сохраняются.

## Существенный tradeoff

Официальный [Node Dockerfile этого релиза](https://github.com/nodejs/docker-node/blob/c4eb085/26/alpine3.24/Dockerfile)
загружает x64 musl Node из [Node.js Unofficial Builds](https://unofficial-builds.nodejs.org/)
и проверяет SHA256 `cc6a960576eeebf62d51d25ce0d138a3ca50a57e3f8f4a8bc10a3e37b15e2f63`.
Этот upstream называет сборки экспериментальными. Pin и checksum обеспечивают
identity, но не превращают такую сборку в официально поддержанный Node binary.

[Confluent1.10.0 README](https://github.com/confluentinc/confluent-kafka-javascript/blob/v1.10.0/README.md)
поддерживает Alpine/musl, однако его опубликованная Node matrix заканчивается24.
Работоспособность именно Node26 + musl должна быть доказана сборкой и реальным
producer/consumer flow. [Playwright](https://playwright.dev/docs/docker#alpine)
не поддерживает Alpine для поставляемых browser binaries, поэтому helper
получает отдельный обязательный glibc pin.

## Проверки до принятия результата

1. Проверить exact image identity и версии; собрать существующий native path,
   загрузить addon, проверить ELF dependencies и отсутствие glibc/shim.
2. Прогнать имеющиеся Node compatibility tests и реальные Kafka flows через
   scoped Compose, все runtime readiness и shutdown. Повторить G15 на glibc
   helper и G18 с теми же business/security assertions. Новую native test
   infrastructure не добавлять. Все временные ресурсы удалять по ownership.
3. Выполнить полный штатный G12:19targets/38reports. Сохранить прежние
   1800seconds, CPU2/memory2048/parallel1, minimum free disk20GiB и DB freshness24h.
   Тяжёлые gates запускать последовательно. Новый archive-mode fix сохраняет
   metadata BuildKit cache, не ослабляя hash/identity проверки.
4. Любой HIGH/CRITICAL, пропущенный target, неподтверждённая совместимость или
   timeout означает FAIL. VEX, ignore, ignore-unfixed, suppression, severity
   downgrade и удаление package metadata для обхода scanner запрещены.
5. Принять Alpine в рабочую реализацию только при успешной native calibration
   и полном G12; затем повторить затронутые gates на общем окончательном SHA.
   При провале сохранить evidence, удалить точный временный стенд и оставить
   текущую Trixie реализацию до следующего решения владельца.

Это разрешение требуется по запрету новых pins в #13 и Scope Guard AGENTS.md:
меняются Linux ABI, источник Node binary и canonical toolchain schema.
Предыдущее разрешение охватывало Trixie, а не Alpine/musl.
Trial не разрешает GitHub push/PR, production deployment или provider mutations.
G14 hardware и постоянный OIDC этим решением не разблокируются. Независимая
проверка постоянной установки на этом сервере после готовности остаётся обязательной.
