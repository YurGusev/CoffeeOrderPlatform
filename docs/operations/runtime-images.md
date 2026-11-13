# Метаданные runtime-образов

Canonical runtime-сборка выполняется через `tools/docker-build.mjs` с `--load`.
Для этого существующего пути без явного custom output wrapper выбирает Docker
exporter с `source-date-epoch=0,rewrite-timestamp=true`. `supply_chain` использует те же
настройки для OCI exporter, сохраняя provenance и проверку attestation.
Параметры нормализуют время в image metadata и слоях при экспорте;
они не передаются как frontend `SOURCE_DATE_EPOCH` build argument.

Wrapper удаляет ambient `SOURCE_DATE_EPOCH` только из копии окружения этого
canonical build child: Buildx иначе автоматически превращает переменную в
frontend argument. Окружение родителя и явно выбранные custom outputs не
меняются. Normalized image timestamps могут иметь Unix epoch; фактическое
время проверки берётся из run evidence и provenance.

`pnpm deploy` подготавливает production dependencies в `/runtime`. Его
служебный `/runtime/node_modules/.modules.yaml` содержит изменяемое время
`prunedAt`; этот installer state удаляется до final COPY. Runtime запускает
Node и deployed package links, а не pnpm installer. Состав зависимостей и
проверка загрузки Kafka native addon сохраняются.

Изменение устраняет два измеренных источника расхождения image ID при
одинаковых исходниках: timestamps кешированных COPY-слоёв и installer time
в `.modules.yaml`. Проверка файлов двух нормализованных runtime-слоёв
показала 7431 одинаковых файла и ровно одно изменённое поле `/prunedAt`
в оставшемся файле; native addon был побайтово одинаков.

Это не обещание полного cold-build воспроизведения при изменившихся
репозиториях OS-пакетов. Перед запуском обязателен прогон `supply_chain` с фактическим SBOM,
проверкой точных IDs, provenance и прежней политикой HIGH/CRITICAL. Парный
экспорт и qualification подтверждаются фактическим runtime evidence;
само наличие exporter options не является PASS.

`supply_chain` получает CVE DB из `ghcr.io/aquasecurity/trivy-db`, а Java DB — из
`mirror.gcr.io/aquasec/trivy-java-db`. Другие repositories и fallback не
разрешены; остальные требования к сканированию остаются прежними.
Источник Java DB отдельно согласован владельцем 4 ноября 2026 и указан в
[исходниках Trivy 0.76.1](https://github.com/aquasecurity/trivy/blob/v0.76.1/pkg/javadb/client.go#L27-L33).

6 ноября 2026 владелец согласовал сборку `otel-collector` из прежнего
`otelCollectorImage`: удаляются только `apt` и `libapt-pkg6.0t64`, содержащие
CVE-2026-109518. Бинарник Alloy, его команда и остальные установленные пакеты
сохраняются; package inventory не скрывается. Новый источник образа не вводится.
`supply_chain` сохраняет OCI archive, provenance и отдельный проверяемый receipt
`otelCollector` тем же путём, что остальные curated infrastructure images.
Observability generate/start/refresh и гейт `observability` используют только image ID из этого
receipt с точной привязкой к source/run/config/BOM; прямой upstream fallback
удаляется. Изменение формата evidence явно согласовано владельцем. Количество
целей, HIGH/CRITICAL policy, freshness, pins и бюджеты `supply_chain` не меняются.

Слой `otel-collector` после `dpkg --purge` очищает `/var/log/dpkg.log`,
`/var/log/alternatives.log`, `/var/log/apt/*` и `/var/cache/ldconfig`: dpkg
пишет в них текущее время и пересоздаёт кеш, из-за чего image identity менялся
при каждом повторе. После очистки две независимые сборки одного pinned base
дают одинаковые config/manifest digests, а `usr/bin/alloy` сохраняет прежний
`binarySha256`. Это условие проверяется до `supply_chain`; ручная перепривязка proof к
каждому новому `imageId` не допускается.

Основание: [pnpm #9474](https://github.com/pnpm/pnpm/issues/9474),
[modules manifest pnpm 11.24.0](https://github.com/pnpm/pnpm/blob/v11.24.0/pnpm11/installing/modules-yaml/src/index.ts),
[BuildKit 0.32.2 exporter options](https://github.com/moby/buildkit/blob/v0.32.2/exporter/containerimage/opts.go)
и [Docker cache invalidation](https://docs.docker.com/build/cache/invalidation/).

8 ноября 2026 владелец согласовал устранение двух блокеров `supply_chain` в #13.
Существующие `musl`/`musl-utils` конечных Node, storage-helper и Kafka обновляются
до `muslVersion` из `config/toolchain-versions.json` (1.2.6-r3). Kafka сохраняет
полное сравнение package inventory с разрешённой дельтой; базы и остальные
пакетные изменения сохраняются. Default Dockerfile ARG проверяется относительно
BOM для обычного build path; `supply_chain` передаёт pin явно.

Для CVE-2026-78661 разрешён только `not_affected` / `vulnerable_code_not_present`
восьми исследованных Go executables: Grafana, три подписанных datasource plugins,
Alloy, Loki, Prometheus и promtool. Закоммиченный [proof profile](../../evidence/security/cve-2026-78661.json) связывает каждый
report target с точными image ID, binary SHA-256, слоем, package/version и finding
fingerprint. Его integrity проверяется отдельно. Свежий `supply_chain` повторно проверяет
identity образа и raw report; reader независимо пересчитывает decisions.
Для curated Grafana/Alloy обязательна проверенная OCI config/platform identity;
для Loki/Prometheus — закреплённые upstream reference/manifest и фактический
Docker image ID. Это повторное использование доказательства байтов неизменяемого
артефакта, а не перенос прежнего PASS `supply_chain`. Дрейф оставляет finding unresolved.

Основание — отсутствие кода затронутого HTML parser в полных восьми бинарниках,
проверенная генерация имён emitted/recorded-inline функций Go 1.26.10/1.27.3,
исходники x/net и независимые audit/review. Сохраняется существующая trust model
доверенного vendor и штатного Go compiler; независимая compiler attestation не
заявляется. У Grafana/Alloy присутствуют другие HTML функции. Module-only fallback
stripped govulncheck и exit code JSON-режима не доказывают отсутствие parser.
Raw findings сохраняются; прежние два Tempo `fixed` и восемь `not_affected`
учитываются отдельно. Общее CVE/package исключение не вводится.

Согласованное [обоснование восьми файлов](https://github.com/YurGusev/CoffeeOrderPlatform/pull/249#issuecomment-6695171131),
[описание CVE Go](https://pkg.go.dev/vuln/GO-2026-6860) и
[исправление musl](https://security.alpinelinux.org/vuln/CVE-2026-107891).
