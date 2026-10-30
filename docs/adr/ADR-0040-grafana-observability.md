# ADR-0040: отдельные Grafana, Loki, Prometheus и Tempo

Дата: 29.10.2026. Решение владельца: переход разрешён в [#210](https://github.com/YurGusev/CoffeeOrderPlatform/issues/210).
Статус реализации: проверяется; этот ADR не является runtime/security admission.

## Решение

Один Compose содержит отдельные Grafana, Loki, Prometheus и Tempo с одним
Collector. Сохраняются Pino stdout, единственный filelog-путь, OTLP traces/metrics,
correlation/redaction и независимость business readiness от telemetry outage.
Собственная сборка vendor Rust/Go не нужна. Все настройки задаёт
`config/platform.yaml`, exact images — `config/toolchain-versions.json`, секреты —
существующий SOPS/trusted-bootstrap путь. Generated configs/provisioning не
становятся второй authority.

DNS для OTLP trace и metric exporters выполняет собственный IPv4 resolver:
системный `dns.lookup` делит пул libuv с другими операциями процесса.
Воспроизведение с отсутствующим Collector показало readiness deadlines при
healthy API только после включения telemetry SDK. Resolver не использует
`/etc/hosts`, поэтому Collector получает штатный DNS alias в IPv4-сети Compose;
при остановке telemetry его незавершённые запросы отменяются. Это сохраняет
исходный readiness deadline и не меняет business HTTP clients.

Готовый Alloy 1.21.3 выбран кандидатом Collector после проверки поставленного
бинарника и image: `go-jose/v4 4.1.6`, Trivy 0 HIGH/0 CRITICAL. Найдены также
22 MEDIUM, 4 LOW и 3 UNKNOWN: их нельзя описывать как отсутствие CVE. Runtime
эквивалентность и окончательный G12 требуют отдельной проверки одного candidate.
Contrib 0.164.0 проверен и отклонён: поставленный бинарник содержит 4.1.5 и
CVE-2026-116587 HIGH. Владелец отклонил VEX для этой уязвимости; скрытого ignore нет.

Alloy работает из единственного generated native config. Прототип официальной
конверсии не сохранил обязательные auth/filelog настройки, поэтому автоматическая
конверсия и fallback-формат не являются production путём. Filesystem/HTTP probes
используют встроенные средства Alloy; native nginx receiver сохраняет измерения
`stub_status`, но его Alloy wrapper имеет experimental status. Это ограничение
фиксируется и проверяется на exact pinned artifact перед обновлением.

HTTP UI, readiness и служебная диагностика Alloy слушают только container loopback.
Приложения получают только аутентифицированный OTLP ingress. Самометрики собираются
внутри Alloy. Backend APIs и локальный alert sink не публикуются на host; debug,
внешние usage reports и внешние notifications выключены. Grafana anonymous access
запрещён; admin password получает только его scoped materialization.

Очередь Alloy exporter увеличена до 2048 items при двух consumers после воспроизведённых enqueue losses на 512. Для Prometheus задано ограниченное 30-минутное окно приёма out-of-order OTLP samples: Изолированный runtime-прогон показал такие samples при нулевом стандартном окне. [Документация Prometheus](https://prometheus.io/docs/guides/opentelemetry/#enable-out-of-order-ingestion) описывает эту настройку. Причина конкретного HTTP 400 не доказана; компонентное сравнение не заменяет проверки памяти и полного G14.

Tempo получает `telemetry.tempo.finishOnShutdownTimeoutMs: 10000`, который renderer
передаёт в native `backend_worker.finish_on_shutdown_timeout`. Стандартные 30 секунд
этого worker превысили внешний `platform.shutdownGraceMs: 30000`: реальная остановка
заняла 30396 мс с exit 0. С native 10s остановка заняла 11129 мс, тот же trace
прочитан после restart. [Закреплённый worker](https://github.com/grafana/tempo/blob/a0826bc9eb8397d614dde91fb00b3809835b7e52/modules/backendworker/backendworker.go#L633-L655)
отменяет контекст незавершённого задания по этому таймеру; полные persistence,
checkpointed crash, retention и restore остаются обязательными проверками.

## Хранение и изменение G14

Владелец явно согласовал отдельные ограниченные persistent volumes, три дня
retention, проверку штатных отказов/recovery и alert на 80% заполнения. У Loki
WAL настроен native threshold 0.8. Для Prometheus/Tempo не заявляется несуществующий
native HTTP 503 при 80%; это заменяет только OpenObserve-specific disk критерий.
Нового ingest proxy/circuit breaker нет.

Проверка disk pressure обязана подтвердить native отказ и восстановление
каждого из четырёх backend на отдельном ограниченном томе. Для Prometheus
проверяются native WAL failure counter и точный sample: HTTP 200 при полном
диске не гарантирует успешный Commit. Для Grafana и Tempo нужны соответственно
SQLite-full и WAL ENOSPC. После освобождения места прежний и новый маркеры
должны читаться в том же процессе; общий успешный статус без результатов
всех четырёх backend не принимается.

Grafana получает минимум 512 MiB. Реальный прогон с 256 MiB зафиксировал
OOM/restart, поэтому проверяется также неизменность исходного процесса до
плановых restart. Последующий healthy не является доказательством отсутствия
OOM; 512 MiB остаются проверяемым бюджетом, а не обещанием ёмкости под любой
нагрузкой.

Тома предоставляют POSIX filesystem с реальным ограничением объёма. Loki
WAL/chunks/index/compactor, Prometheus TSDB/WAL, Tempo blocks/WAL/live-store/scheduler
и Grafana database остаются внутри своих томов. NTFS не используется напрямую
как TSDB filesystem. Filesystem receiver видит read-only mounts telemetry томов;
он не получает host root или Docker socket.

Пять прежних alert rules сохраняют deployment scoping, пороги и окна 5m/2m/5%.
Дополнительный disk alert использует реальную filesystem utilization и отдельное
каноническое окно `alerts.diskUsage.forMs`; алерт не объявляется ingestion guard.
Локальный webhook sink принимает только ожидаемые состояния и ограниченные
идентификаторы, сохраняет ограниченные ротируемые записи.

Tempo local backend применяется в однохостовом контуре. Upstream относит его к
evaluation/development и рекомендует object storage для production; эта миграция
не добавляет HA/object-storage service и не обещает соответствующих гарантий.
Фактическая сохранность после restart/recreate/checkpointed crash, retention,
restore и capacity должны быть доказаны отдельно, а не выведены из настройки пути.

## Приёмка и границы

Перед мерджем нужны реальный G12, Compose/G14, все применимые 15-runtime metrics,
native nginx, три сигнала и same-trace path, шесть alert episodes, outage/loss,
memory/retry/stop, persistence/retention/restore и проверка прав/сетей. Любой
обязательный FAIL/NOT_RUN блокирует допуск. Старые handoff и пользовательские
данные не удаляются; новый Operations handoff принадлежит #210 и становится
входом #13. Полная launch-приёмка #13 не подменяется этим ADR.

OIDC/JWKS рассмотрен отдельно: текущий `browserOidc: null` не означает готового
production IdP. Для Grafana возможно использование того же будущего IdP с
проверкой подписи ID token и явным role mapping. Новый IdP и изменение producer
authentication этим решением не вводятся; scoped bearer token сохраняется.

## Согласованная поставка и security admission

30.10.2026 владелец явно согласовал готовый официальный Tempo `3.2.0-dev`
из commit `a0826bc` и Grafana Slim 13.3.0 с готовыми подписанными Loki 13.2.5,
Prometheus 13.2.5 и Tempo 13.4.1 plugins. Tempo 3.1.1 с `go-jose 4.1.4` и
полный Grafana 13.3.0 с 39 HIGH в bundled plugins исключены из выбранной поставки.
Vendor Rust/Go не компилируется: target Grafana копирует проверенное содержимое
трёх ZIP в `/opt/grafana/plugins`, вне persistent `/var/lib/grafana`.
Финальный image ID приходит из G12 receipt, официальный slim pin является base.

Разрешение ограничено CVE-2026-21728 и CVE-2026-28377 для exact Tempo plugin
binary `292f1875dbcc18125701cca2762da7e65300a4ca3ea3c4105f24b7cd57694588`.
Независимая проверка связала подписанный binary с module checksum
`h1:BphMCaYqWY+j1fdRPNFPkYE4A4QIev1KlHjRkSVJ8O4=`, отсутствием replacement
и exact commit `bcfe9f230c1de0f79cfd2110b38062e0f41c81e9`. Его исходники содержат
оба fixes: `650eb1985a0776789c8564122990f588a742356f` и
`bb8ca663db34a0980c9758b40d918fda3b4dbec3`. Это artifact-specific already-fixed
классификация; воспроизводимая компиляция vendor binary не заявляется.

Единственная policy — `verification.securityScan.approvedFixed`: пустой набор
или ровно два согласованных CVE. BOM хранит exact ZIP/manifest/binary hashes,
ключ подписи и module identity. Изменение BOM не расширяет закрытый approved
набор. G12 сохраняет raw HIGH, отдельно фиксирует resolvedFixed и unresolvedHigh,
проверяет физические файлы финального OCI и связывает решение с exact candidate,
run, manifest/platform и image ID. Любой иной HIGH, CRITICAL или несовпадение
identity блокирует допуск. VEX для неисправленной `go-jose 4.1.5` запрещён.
MEDIUM/LOW/UNKNOWN остаются в отчётах; «0 CVE» не утверждается.

Диагностические prototypes подтвердили три сигнала, подписи plugins, запрос
метрики через Grafana и stop/recreate Grafana на том же fixture volume. Они
не имеют G12 BuildKit attestation. Полные G12/G14, runtime matrix,
persistence/TTL/restore и accepted handoff #210 ещё должны пройти до merge.

## Источники

- [Operations contract](../operations/observability.md) и [launch specification](../launch/21_LAUNCH_VERIFICATION_SPEC.md).
- [Loki WAL и native disk threshold](https://grafana.com/docs/loki/latest/operations/storage/wal/).
- [Prometheus retention/size и POSIX storage](https://prometheus.io/docs/prometheus/latest/storage/).
- [Tempo configuration](https://grafana.com/docs/tempo/latest/configuration/).
- [Go JOSE advisory](https://github.com/go-jose/go-jose/security/advisories/GHSA-mgcc-cww5-fp2q).
- [Alloy run/HTTP flags](https://grafana.com/docs/alloy/latest/reference/cli/run/).
- [Grafana OIDC/JWKS validation](https://grafana.com/docs/grafana/latest/setup-grafana/configure-access/configure-authentication/generic-oauth/).
