# Метаданные runtime-образов

Canonical runtime-сборка выполняется через `tools/docker-build.mjs` с `--load`.
Для этого существующего пути без явного custom output wrapper выбирает Docker
exporter с `source-date-epoch=0,rewrite-timestamp=true`. G12 использует те же
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
репозиториях OS-пакетов. Перед запуском обязателен G12 с фактическим SBOM,
проверкой точных IDs, provenance и прежней политикой HIGH/CRITICAL. Парный
экспорт и qualification подтверждаются фактическим runtime evidence;
само наличие exporter options не является PASS.

G12 получает CVE DB из `ghcr.io/aquasecurity/trivy-db`, а Java DB — из
`mirror.gcr.io/aquasec/trivy-java-db`. Другие repositories и fallback не
разрешены; остальные требования к сканированию остаются прежними.
Источник Java DB отдельно согласован владельцем 4 ноября 2026 и указан в
[исходниках Trivy 0.76.1](https://github.com/aquasecurity/trivy/blob/v0.76.1/pkg/javadb/client.go#L27-L33).

Основание: [pnpm #9474](https://github.com/pnpm/pnpm/issues/9474),
[modules manifest pnpm 11.24.0](https://github.com/pnpm/pnpm/blob/v11.24.0/pnpm11/installing/modules-yaml/src/index.ts),
[BuildKit 0.32.2 exporter options](https://github.com/moby/buildkit/blob/v0.32.2/exporter/containerimage/opts.go)
и [Docker cache invalidation](https://docs.docker.com/build/cache/invalidation/).
