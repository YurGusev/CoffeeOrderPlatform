# Наблюдаемость первого запуска

Operations сохраняет producer и runtime contract #64. [ADR-0040](../adr/ADR-0040-grafana-observability.md) и #210 заменяют только его OpenObserve-специфическую реализацию: один Alloy Collector, Grafana, Loki, Prometheus и Tempo. Реализация #210 проверяется; наличие конфигурации и частичных component checks не означает принятия #210 или PASS G12/G14. Исторический `evidence/handoffs/issue-64.yaml` не переписывается. После приёмки #210 его новый handoff станет обязательным input полного launch gate #13; собственные component proofs #210 выполняются до merge и не зависят от будущего принятого handoff.

## Поток и границы

`config/platform.yaml.telemetry` задаёт endpoints, очереди, лимиты, retention и alert windows; exact image refs и probe hash находятся в `config/toolchain-versions.json`. Generated provisioning и Compose override не являются второй authority. Node пишет Pino JSON в stdout и экспортирует OTel metrics/traces. Fastify связывает route template, request и проверенный W3C context. Секреты, PII, headers, body, query, SQL и provider payload редактируются до serialization. Correlation/entity refs принадлежат logs/traces, а не metric labels. HTTP client span заканчивается после response headers; чтение и отмена body остаются у caller. Outbox outcomes `unknown` и `failed` помечают delivery/poll spans как ошибки, `ack` оставляет статус unset.

Native nginx сохраняет собственный transport logger, передаёт валидные W3C context и client correlation UUID авторизатору; его `request_id` остаётся отдельным transport identifier. Невалидный context не попадает в telemetry. Private `telemetry.nginxStatusEndpoint` не публикуется на host; Alloy собирает `stub_status` через nginx receiver. Его Alloy wrapper имеет experimental status и требует проверки exact pinned artifact при обновлении.

Метрики публикуются только при наличии owner resource:

| Instrument | Владелец / применимость |
| --- | --- |
| `runtime_http_*`, `runtime_ready`, process/producer counters | Node runtime |
| `db.client.connection.waiting`, `db.client.connection.checkout_wait`, `db.client.transaction.*` | Runtime с собственной DB; waiting отражает текущую очередь |
| `messaging.kafka.consumer.lag`, `messaging.kafka.event.age` | Зарегистрированный Kafka consumer |
| `messaging.outbox.oldest_unpublished.age`, `messaging.inbox.*` | Соответствующий Outbox/Inbox owner |
| `coffee_aroma_attempt_*`, `coffee_aroma_unknown_outcomes_current` | `aroma-convergence`; current — нерешённые outcomes, не исторический counter |
| `coffee_realtime_*` | `realtime-gateway` |
| `nginx_*` | Native `edge-nginx` через private `stub_status` |
| `probe_success` | Health probes Alloy; nginx availability принадлежит `edge-nginx` |

`messaging.inbox.received.age` измеряет путь от получения Kafka record до входа в Inbox после checkout owner DB transaction, без времени handler; `messaging.kafka.event.age` отдельно измеряет возраст от `occurredAt`. Histogram в Prometheus представляется семействами `_count`, `_sum`, `_bucket`.

Trusted generator выбирает точные Compose project/service/container IDs и Docker LogPath и монтирует только выбранные каталоги read-only; Collector не получает Docker socket и не сканирует wildcard paths. Docker logging rotation задаётся generated override до создания runtime; после recreation требуется новое discovery/generation. Filelog offsets находятся в отдельном Compose volume `collector_checkpoints` (`/var/lib/alloy/file_storage`); при штатном restart известные файлы продолжаются с checkpoint, неизвестные читаются с начала. Downstream failure, rotation или удаление log-файла могут дать пропуск или дубликат: exactly-once не обещается. Retry ограничен `retryWindowMs`, затем batch отбрасывается. Pino drop counter не измеряет потери Docker non-blocking buffer.

Collector применяет memory limiter, batch, конечные queues, timeout и retry; producer отдельно учитывает export failure, queue overflow, serialization rejection и shutdown loss. Counters process-scoped и связаны с process start. Лимит Go memory limiter 256 MiB со spike 64 MiB и cgroup 1024 MiB — разные ограничения, не capacity proof. Telemetry outage не участвует в business readiness и не разрешает business replay. Stop и flush ограничены `platform.shutdownGraceMs`.

Alloy UI, readiness и диагностика доступны только на loopback контейнера; producer OTLP ingress аутентифицирован scoped bearer token. Grafana и backend API не публикуют host ports; anonymous Grafana выключен. Внешние usage reports, Grafana update checks и plugin preinstall выключены (`GF_PLUGINS_PREINSTALL_DISABLED=true`); notifications идут в локальный ограниченный sink. Grafana работает как UID 472, Loki и Tempo как 10001, Prometheus как 65534; Alloy использует UID 0 без capabilities для доступа к выбранным log paths. Read-only mounts четырёх telemetry volumes позволяют Alloy измерять filesystem, не открывая host root.

## Образы и G12

Grafana собирается только из готового official slim и трёх подписанных ZIP;
Go/Rust не компилируются. Её финальный image ID и ID storage-helper берутся из
проверенных G12 receipts. Slim ref в BOM является base. Plugins находятся в
`/opt/grafana/plugins`, данные — в `/var/lib/grafana`; обновление image не должно
использовать старые binaries из data volume. Tempo использует согласованный
готовый dev image по immutable digest; его стабильность проверяется G14.

Policy `verification.securityScan.approvedFixed` разрешает только два указанных
в ADR-0040 already-fixed Tempo findings для exact artifact identity. Raw scan и
UNKNOWN сохраняются. Изменение package/version/hash, иной HIGH/CRITICAL или
несогласованные evidence завершаются FAIL. Перед запуском G13/G14 фактические
ID всех 14 Node images и nginx сравниваются с проверенными G12 IDs; rebuild
сам по себе не доказывает равенство. Непрохождение проверки останавливает startup.

## Хранение и подготовка

Четыре отдельных bounded ext4 volume принадлежат Grafana, Loki, Prometheus и Tempo; Loki/Prometheus/Tempo настроены на retention 3 дня. Только storage init helper получает привилегии. NTFS не используется непосредственно как TSDB filesystem. После reboot provisioner может восстановить loop attachment к сохранённому backing file только при отсутствии ссылок контейнеров; чужие volumes он не переиспользует. Не удаляйте persistent volumes или business storage при cleanup. Recovery и restore требуют отдельной проверки, сохранённый файл сам по себе не является restore PASS.

При наличии разрешения на локальную подготовку предусмотрены следующие CLI. Имена относятся только к собственным telemetry volumes; helper сверяет owner и lifecycle. Bootstrap использует SOPS через trusted materialization, не выдавая общий secrets-файл runtime. Development leaf `telemetry.grafanaAdmin` создан через trusted bootstrap; staging и production не изменены. Для нового development окружения предусмотрена явная идемпотентная команда `pnpm observability:bootstrap --provision-development-grafana-admin`: существующий ключ не ротируется, другое окружение отвергается. Обычная materialization не создаёт секреты автоматически. Storage и generator требуют законный G12 context (`COFFEE_LAUNCH_CONTEXT_FILE`); постоянный alert-sink использует его просканированный hardened storage-helper image по frozen ID.

```sh
pnpm observability:storage --store grafana --name coffee-observability-grafana-data
pnpm observability:storage --store loki --name coffee-observability-loki-data
pnpm observability:storage --store prometheus --name coffee-observability-prometheus-data
pnpm observability:storage --store tempo --name coffee-observability-tempo-data
pnpm observability:bootstrap
pnpm observability:generate --logging-only --output-dir /dev/shm/coffee-platform-observability
pnpm observability:generate --project-name coffee-platform --grafana-volume coffee-observability-grafana-data --loki-volume coffee-observability-loki-data --prometheus-volume coffee-observability-prometheus-data --tempo-volume coffee-observability-tempo-data
```

Logging override применяется до создания или recreation выбранных runtime; затем generator обнаруживает фактические IDs и LogPath. Он проверяет BOM probe, materialized secrets и владельцев томов, создаёт configs/provisioning и `provenance.json` в tmpfs и выводит путь override. Без соответствующих контейнеров и secret этот шаг не является готовым deployment. Для проверки Collector используется `node tools/observability/health.mjs --collector-container <container>` из среды, где доступны backend endpoints; Collector probe выполняется внутри контейнера.

Loki WAL использует native `disk_full_threshold: 0.8`; отдельный disk alert срабатывает по фактическому filesystem utilization при 80%. Prometheus retention size ограничен 80% configured объёма. Для Prometheus и Tempo не заявляется универсальный native HTTP 503 при 80%. Alert не является ingestion guard. Tempo local backend предназначен upstream для evaluation/development; этот однохостовый вариант не обещает HA или object storage.

## Alerts и проверка

Пять правил ограничены `deployment_environment`, `service_namespace` и `service_version`: not-ready, consumer lag и Outbox age используют окно 5m; UnknownOutcome — 2m; SSE drop rate — 5m с порогом 5%. `notReady` учитывает Node `runtime_ready` и native nginx `probe_success`, включая отсутствие обязательной серии. Шестое правило проверяет заполнение каждого telemetry volume с `alerts.diskUsage.forMs`. Ошибка query не считается resolved. Firing и resolved должны относиться к одному episode; локальный sink хранит ограниченные ротируемые записи.

`pnpm test:observability` запускает disposable run-id proof и сохраняет результаты в `evidence/observability/<run-id>/`: `alert-transitions.json`, `correlation-proof.json`, `redaction-scan.json`, `queue-loss-counters.json`, `retention-result.json`, `runtime-health-matrix.json` и `result.json`. Любой обязательный FAIL/NOT_RUN блокирует G14. Проверяются три сигнала и same-trace correlation, redaction, шесть alert episodes, outage/loss, memory/retry/stop, права и сети, persistence и восстановление после disk pressure. Проверка TTL в bounded fixture profile не доказывает истечение реальных 72 часов; сохранность после restart/recreate/checkpointed crash и restore требуют собственного evidence.

Runtime metric matrix охватывает 14 Node runtime и native nginx до штатного cleanup: self-mTLS live/ready/text metrics и ожидаемые 4xx, OTLP HTTP/error и producer metrics, 10 DB-waiting, lag двух durable Kafka consumers с committed offsets и пять scoped Outbox-age series. Cold `realtime-gateway` до consume/commit имеет неизвестный lag (`-1`), отмеченный `ACTIVITY_DEPENDENT / NOT_ASSERTED_WITHOUT_ACTIVITY`; launch-фаза проверяет его после реальной активности. Событийные и транзакционные samples требуют активности шести owner roles и SQL-backed convergence helper, который не заменяет постоянный runtime. Сканируются 15 final images по фактическим IDs.

G14 выбирает `--observability-fixture` через programmatic hooks: отдельный
PostgreSQL с PGDATA в tmpfs 512 MiB, временный Kafka и локальный simulated
provider. Проверенный G12 context остаётся у host verifier; fixture runtime
его не получает. Этот режим не читает G08 credentials и не подтверждает
изоляцию существующей business БД. Обычный recovery-proof сохраняет свои
launch guards. Отдельный launch-path использует тот же pinned PostgreSQL
fixture image и ограниченный tmpfs.

Convergence helper удерживает periodic exporter до подтверждения в Prometheus: `unknown_outcomes_current=1` перед recovery, затем `unknown_outcomes_current=0` и `recovered_applied=1` перед остановкой. Каждая фаза подтверждается run-scoped checkpoint в `/results`; локальные значения и `forceFlush` не доказывают доставку. Истечение bounded ожидания завершает proof с FAIL и cleanup.

Частичные component checks readiness/auth/provisioning четырёх backend и Alloy не заменяют формальные G12/G14, полный 15-runtime matrix, persistence, TTL и restore: они пока не подтверждены. #13 отдельно принимает full-system SLO, chaos/failure, capacity и сквозные browser/business/DB/Kafka/SSE критерии. При отказе проверяйте health и loss counters, не повторяйте business effects; при disk pressure освобождайте только собственные telemetry данные и проверяйте восстановление. Не удаляйте `collector_checkpoints` при обычном restart.

Для изолированного G12/G14 можно задать системный `TMPDIR` на отдельном доступном
хранилище; это operational locator временных файлов. G12 сохраняет требование
20 GiB свободного места. G14 размещает там backing-файлы восьми disposable
ext4 fixtures и backup-архивы; secret configs остаются в `/dev/shm`. Конечные
TSDB/WAL volumes являются ограниченными ext4, NTFS не используется напрямую
как TSDB filesystem. Production provisioning без fixture placement не меняется.
