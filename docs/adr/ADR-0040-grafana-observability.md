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

## Хранение и изменение G14

Владелец явно согласовал отдельные ограниченные persistent volumes, три дня
retention, проверку штатных отказов/recovery и alert на 80% заполнения. У Loki
WAL настроен native threshold 0.8. Для Prometheus/Tempo не заявляется несуществующий
native HTTP 503 при 80%; это заменяет только OpenObserve-specific disk критерий.
Нового ingest proxy/circuit breaker нет.

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

## Текущий допуск и непринимаемые пока кандидаты

Свежая диагностика выявила блокеры: Tempo 3.1.1 содержит `go-jose 4.1.4`
(HIGH CVE-2026-116587), а Grafana 13.3.0 — 39 HIGH в bundled plugins.
Эти pins ещё не допущены; успешный component startup их не исправляет.

Отдельно проверены готовый официальный Tempo `3.2.0-dev` из commit `a0826bc`
(`go-jose 4.1.6`, scan 0 HIGH/CRITICAL, 1 UNKNOWN) и частный COPY-only прототип
Grafana Slim 13.3.0 с подписанными готовыми Loki 13.2.5, Prometheus 13.2.5 и
Tempo 13.4.1 plugins. Vendor-код не компилировался. Прототип получил 2 HIGH
и 10 UNKNOWN; оба HIGH указывают на Tempo pseudo-version `bcfe9f230c1d`.
В exact upstream commit подтверждены оба соответствующих исправления, но
строгий image scan остаётся отрицательным и исключения не применялись.
Путь plugins вынесен за пределы Grafana data volume в следующем частном
прототипе; его файлы побайтно совпали, отдельный новый image scan не запускался.
Это исследовательские артефакты без G12 BuildKit attestation.

Использование dev-версии Tempo и учёт исправленной pseudo-version требуют
отдельного решения владельца и независимой проверки. Они пока не заменяют
production pins и не разрешают VEX для неисправленной `go-jose 4.1.5`.
Формальные G12/G14, полная runtime matrix, persistence/TTL/restore и новый
accepted handoff #210 остаются неподтверждёнными; merge до них запрещён.

## Источники

- [Operations contract](../operations/observability.md) и [launch specification](../launch/21_LAUNCH_VERIFICATION_SPEC.md).
- [Loki WAL и native disk threshold](https://grafana.com/docs/loki/latest/operations/storage/wal/).
- [Prometheus retention/size и POSIX storage](https://prometheus.io/docs/prometheus/latest/storage/).
- [Tempo configuration](https://grafana.com/docs/tempo/latest/configuration/).
- [Go JOSE advisory](https://github.com/go-jose/go-jose/security/advisories/GHSA-mgcc-cww5-fp2q).
- [Alloy run/HTTP flags](https://grafana.com/docs/alloy/latest/reference/cli/run/).
- [Grafana OIDC/JWKS validation](https://grafana.com/docs/grafana/latest/setup-grafana/configure-access/configure-authentication/generic-oauth/).
