# Наблюдаемость первого запуска

Очередь каждого Alloy exporter ограничена 2048 items при двух consumers. В отдельном сравнении 512 items давали enqueue losses, а 2048 устранили их на проверенной нагрузке. Prometheus принимает OTLP samples с нарушенным порядком в окне до 30 минут (`telemetry.prometheus.outOfOrderWindowMs`): Изолированный runtime-прогон зафиксировал out-of-order samples при стандартном нулевом окне. Ограничение потребления памяти и полное runtime-поведение остаются предметом G14, а не следуют из component test. Настройка окна следует [рекомендации Prometheus для OpenTelemetry](https://prometheus.io/docs/guides/opentelemetry/#enable-out-of-order-ingestion).

Operations сохраняет producer и runtime contract #64. [ADR-0040](../adr/ADR-0040-grafana-observability.md) и #210 заменяют только его OpenObserve-специфическую реализацию: один Alloy Collector, Grafana, Loki, Prometheus и Tempo. Реализация #210 проверяется; наличие конфигурации и частичных component checks не означает принятия #210 или PASS G12/G14. Исторический `evidence/handoffs/issue-64.yaml` не переписывается. После приёмки #210 его новый handoff станет обязательным input полного launch gate #13; собственные component proofs #210 выполняются до merge и не зависят от будущего принятого handoff.

OTLP trace и metric exporters используют собственный IPv4 DNS resolver, который отменяется при остановке telemetry. Они не занимают общий пул `dns.lookup`: в реальном воспроизведении недоступное имя Collector с telemetry SDK задерживало DNS и readiness, хотя целевой API оставался healthy. [Node DNS](https://nodejs.org/docs/latest-v26.x/api/dns.html#implementation-considerations) различает системный lookup и сетевой resolver. Для Collector требуется DNS alias `otel-collector` в IPv4-сети Compose; `/etc/hosts` этим resolver не учитывается. Изменение DNS относится только к экспортёрам; секундный readiness deadline сохраняется.

Observer и Convergence используют по два HTTP-соединения: одно длительное бизнес-чтение не занимает единственное соединение, необходимое readiness. Их supervisor выполняет не более одного бизнес-чтения одновременно. Проверка удерживает настоящий запрос реальной composition и отдельно проверяет readiness, deadline, отмену и shutdown; это не объяснение стартового сбоя при пустой очереди.

## Поток и границы

`config/platform.yaml.telemetry` задаёт endpoints, очереди, лимиты, retention и alert windows; exact image refs и probe hash находятся в `config/toolchain-versions.json`. Generated provisioning и Compose override не являются второй authority. Node пишет Pino JSON в stdout и экспортирует OTel metrics/traces. Fastify связывает route template, request и проверенный W3C context. Секреты, PII, headers, body, query, SQL и provider payload редактируются до serialization. Correlation/entity refs принадлежат logs/traces, а не metric labels. HTTP client span заканчивается после response headers; чтение и отмена body остаются у caller. Outbox outcomes `unknown` и `failed` помечают delivery/poll spans как ошибки, `ack` оставляет статус unset.

Native nginx сохраняет собственный transport logger, передаёт валидные W3C context и client correlation UUID авторизатору; его `request_id` остаётся отдельным transport identifier. Невалидный context не попадает в telemetry. Private `telemetry.nginxStatusEndpoint` не публикуется на host; Alloy собирает `stub_status` через nginx receiver. Его Alloy wrapper имеет experimental status и требует проверки exact pinned artifact при обновлении.

Метрики публикуются только при наличии owner resource:

| Instrument                                                                                      | Владелец / применимость                                                     |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `runtime_http_*`, `runtime_ready`, process/producer counters                                    | Node runtime                                                                |
| `db.client.connection.waiting`, `db.client.connection.checkout_wait`, `db.client.transaction.*` | Runtime с собственной DB; waiting отражает текущую очередь                  |
| `messaging.kafka.consumer.lag`, `messaging.kafka.event.age`                                     | Зарегистрированный Kafka consumer                                           |
| `messaging.outbox.oldest_unpublished.age`, `messaging.inbox.*`                                  | Соответствующий Outbox/Inbox owner                                          |
| `coffee_aroma_attempt_*`, `coffee_aroma_unknown_outcomes_current`                               | `aroma-convergence`; current — нерешённые outcomes, не исторический counter |
| `coffee_realtime_*`                                                                             | `realtime-gateway`                                                          |
| `nginx_*`                                                                                       | Native `edge-nginx` через private `stub_status`                             |
| `probe_success`                                                                                 | Health probes Alloy; nginx availability принадлежит `edge-nginx`            |

`messaging.inbox.received.age` измеряет путь от получения Kafka record до входа в Inbox после checkout owner DB transaction, без времени handler; `messaging.kafka.event.age` отдельно измеряет возраст от `occurredAt`. Histogram в Prometheus представляется семействами `_count`, `_sum`, `_bucket`.

Trusted generator выбирает точные Compose project/service/container IDs и Docker LogPath и монтирует только выбранные каталоги read-only; Collector не получает Docker socket и не сканирует wildcard paths. Docker logging rotation задаётся generated override до создания runtime; после recreation требуется новое discovery/generation. Filelog offsets находятся в отдельном Compose volume `collector_checkpoints` (`/var/lib/alloy/file_storage`); при штатном restart известные файлы продолжаются с checkpoint, неизвестные читаются с начала. Downstream failure, rotation или удаление log-файла могут дать пропуск или дубликат: exactly-once не обещается. Retry ограничен `retryWindowMs`, затем batch отбрасывается. Pino drop counter не измеряет потери Docker non-blocking buffer.

Collector применяет memory limiter, batch, конечные queues, timeout и retry; producer отдельно учитывает export failure, queue overflow, serialization rejection и shutdown loss. Counters process-scoped и связаны с process start. Лимит Go memory limiter 256 MiB со spike 64 MiB и cgroup 1024 MiB — разные ограничения, не capacity proof. Telemetry outage не участвует в business readiness и не разрешает business replay. Stop и flush ограничены `platform.shutdownGraceMs`.

Alloy UI, readiness и диагностика доступны только на loopback контейнера; producer OTLP ingress аутентифицирован scoped bearer token. Grafana и backend API не публикуют host ports; anonymous Grafana выключен. Внешние usage reports, Grafana update checks и plugin preinstall выключены (`GF_PLUGINS_PREINSTALL_DISABLED=true`); notifications идут в локальный ограниченный sink. Grafana работает как UID 472, Loki и Tempo как 10001, Prometheus как 65534; Alloy использует UID 0 без capabilities для доступа к выбранным log paths. Read-only mounts четырёх telemetry volumes позволяют Alloy измерять filesystem, не открывая host root.

В memory proof сохраняются канонические лимиты и bounded pressure. Собственный
Tempo временно приостанавливается, чтобы exporter queue действительно удерживала
данные. После валидного 503/OTLP 14 Tempo возобновляется до проверки счётчика;
`finally` также восстанавливает его при ошибке. Проверка требует роста refused и
accepted counters, того же процесса без OOM и recovery trace в Tempo. Прогресс
нагрузки и результаты остановки сохраняются также при FAIL.

Native `backend_worker.finish_on_shutdown_timeout` берётся из
`telemetry.tempo.finishOnShutdownTimeoutMs` (10000 мс), оставляя запас внутри
общего grace 30000 мс. Проверяется реальная остановка и чтение сохранённого trace;
успешный idle marker не подменяет обязательные persistence/retention/restore.

Readiness `aroma-observer` и его единственный business read используют два
соединения внутреннего HTTP client. Это позволяет проверке с deadline 1 секунда
выполняться во время долгого business read. Проба остаётся аутентифицированной;
недоступный upstream по-прежнему делает readiness неготовой.

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

Лимит Grafana составляет 512 MiB: прежние 256 MiB привели к OOM и автоматическому restart в реальном прогоне. Это [минимум upstream](https://grafana.com/docs/grafana/latest/setup-grafana/installation/), достаточность которого проверяется под полной нагрузкой. Проверка сравнивает исходные container ID, StartedAt и RestartCount до намеренных restart: последующий healthy и сброшенный OOMKilled не скрывают аварийный перезапуск.

Штатный отказ каждого backend проверяется отдельно на его собственном ограниченном томе. Для Grafana требуется ошибка SQLite при заполнении, для Tempo — ошибка записи WAL; после освобождения места должны читаться прежний и новый маркеры в том же процессе. Prometheus 3.15.1 может вернуть HTTP 200 при ошибке Commit: [OTLP handler](https://github.com/prometheus/prometheus/blob/v3.15.1/storage/remote/write_otlp_handler.go#L114-L193) не передаёт ошибку из defer в возвращаемое значение. Поэтому проверка требует рост `prometheus_tsdb_wal_writes_failed_total` и отсутствие точного sample под давлением, затем сохранность старого и доступность нового sample без дальнейшего роста ошибок после освобождения места. HTTP 200 сам по себе не подтверждает сохранение метрики. Общий G14 и его artifacts требуют PASS всех четырёх backend; один успешный Loki proof недостаточен.

## Alerts и проверка

Пять правил ограничены `deployment_environment`, `service_namespace` и `service_version`: not-ready, consumer lag и Outbox age используют окно 5m; UnknownOutcome — 2m; SSE drop rate — 5m с порогом 5%. `notReady` учитывает Node `runtime_ready` и native nginx `probe_success`, включая отсутствие обязательной серии. Шестое правило проверяет заполнение каждого telemetry volume с `alerts.diskUsage.forMs`. Ошибка query не считается resolved. Firing и resolved должны относиться к одному episode; локальный sink хранит ограниченные ротируемые записи.

`pnpm test:observability` запускает disposable run-id proof и сохраняет результаты в `evidence/observability/<run-id>/`: `alert-transitions.json`, `correlation-proof.json`, `redaction-scan.json`, `queue-loss-counters.json`, `retention-result.json`, `runtime-health-matrix.json` и `result.json`. Любой обязательный FAIL/NOT_RUN блокирует G14. Проверяются три сигнала и same-trace correlation, redaction, шесть alert episodes, outage/loss, memory/retry/stop, права и сети, persistence и восстановление после disk pressure. Проверка TTL в bounded fixture profile не доказывает истечение реальных 72 часов; сохранность после restart/recreate/checkpointed crash и restore требуют собственного evidence.

Loki retention fixture сохраняет включённый embedded chunk cache и сокращает только его TTL до 30 секунд вместе с остальными тестовыми интервалами. Стандартный часовой TTL мог возвращать удалённый chunk из кеша дольше шестиминутного proof; парные native опыты подтвердили отсутствие старого маркера при сохранности свежего с TTL 30 секунд. Effective настройки проверяются до нагрузки и после восстановления исходного профиля; production retention и cache TTL не меняются. При timeout сохраняются последние наблюдения compactor и old/current controls.

Tempo TTL fixture сокращает также `live_store.flush_op_timeout` до 30 секунд: в закреплённом [upstream](https://github.com/grafana/tempo/blob/a0826bc9eb8397d614dde91fb00b3809835b7e52/modules/livestore/live_store_background.go#L215-L236) это период cleanup, а `complete_block_timeout` задаёт возраст блока. С исходным cleanup 5 минут marker исчез лишь на 303-й секунде, поэтому обязательные следующие 2 минуты отсутствия не помещались в 6 минут. Парный опыт с единственным изменением cleanup подтвердил 122 секунды отсутствия и 13 свежих controls. Effective cadence и восстановление исходного значения проверяются; последние Tempo observations сохраняются. Production retention/cadence, compaction, deadline и required absence window не меняются; producer остановлен до retention.

Disk proof сначала достигает ENOSPC и нулевого `bavail`, затем требует настоящий native failure. После подтверждённой ошибки [SQLite может откатить транзакцию](https://www.sqlite.org/lang_transaction.html#response_to_errors_within_a_transaction) и освободить блоки; положительный post-request `bavail` сам по себе не отменяет наблюдённый отказ. Identity файловой системы проверяется всегда. Снимок и native failure записываются до assertions; точное удаление собственного filler, чтение старого и нового маркеров, тот же процесс и отсутствие OOM остаются обязательными.

G12 имеет установленный scope 22 images + lockfile / 46 reports. Дополнительный scan временного PostgreSQL fixture хранится отдельно: Debian 17.11 дал 86 HIGH / 2 CRITICAL, проверенный кандидат 17.11 Alpine — 34 HIGH / 1 CRITICAL. Это findings тестового инструмента, не допуск или VEX и не изменение G12 targets; fixture не объявляется clean. PostgreSQL business storage остаётся внешним. Полные raw результаты и ограничения указываются в delivery report.

Runtime metric matrix охватывает 14 Node runtime и native nginx до штатного cleanup: self-mTLS live/ready/text metrics и ожидаемые 4xx, OTLP HTTP/error и producer metrics, 10 DB-waiting, lag двух durable Kafka consumers с committed offsets и пять scoped Outbox-age series. Cold `realtime-gateway` до consume/commit имеет неизвестный lag (`-1`), отмеченный `ACTIVITY_DEPENDENT / NOT_ASSERTED_WITHOUT_ACTIVITY`; launch-фаза проверяет его после реальной активности. Событийные и транзакционные samples требуют активности шести owner roles и SQL-backed convergence helper, который не заменяет постоянный runtime. Сканируются 15 final images по фактическим IDs.

G14 выбирает `--observability-fixture` через programmatic hooks: отдельный
PostgreSQL с PGDATA в tmpfs 512 MiB, временный Kafka и локальный simulated
provider. Проверенный G12 context остаётся у host verifier; fixture runtime
его не получает. Этот режим не читает G08 credentials и не подтверждает
изоляцию существующей business БД. Обычный recovery-proof сохраняет свои
launch guards. Отдельный launch-path использует тот же pinned PostgreSQL
fixture image и ограниченный tmpfs.

Component Orders owners получают canonical `config/database-ownership.json`
через read-only mount с проверкой hash и role-local доступа. Это не создаёт launch
identity; G15 context монтируется только при подтверждённой identity. Launch-path
продолжает использовать собственный PostgreSQL fixture.

Convergence helper удерживает periodic exporter до подтверждения в Prometheus: `unknown_outcomes_current=1` перед recovery, затем `unknown_outcomes_current=0` и `recovered_applied=1` перед остановкой. Каждая фаза подтверждается run-scoped checkpoint в `/results`; локальные значения и `forceFlush` не доказывают доставку. Истечение bounded ожидания завершает proof с FAIL и cleanup.

Компонентная поставка #210 подтверждена на `e6c2e7d`: G12 и изолированный G14, 15-runtime matrix, persistence, TTL и restore прошли независимую проверку; точные команды, hashes и ограничения приведены в [отчёте](../reports/observability-delivery.md), outputs — в [handoff](../../evidence/handoffs/issue-210.yaml). Это не формальный launch admission G00/G12/G14. #13 отдельно принимает full-system SLO, chaos/failure, capacity и сквозные browser/business/DB/Kafka/SSE критерии. При отказе проверяйте health и loss counters, не повторяйте business effects; при disk pressure освобождайте только собственные telemetry данные и проверяйте восстановление. Не удаляйте `collector_checkpoints` при обычном restart.

Для изолированного G12/G14 можно задать системный `TMPDIR` на отдельном доступном
хранилище; это operational locator временных файлов. G12 сохраняет требование
20 GiB свободного места. G14 размещает там backing-файлы восьми disposable
ext4 fixtures и backup-архивы; secret configs остаются в `/dev/shm`. Конечные
TSDB/WAL volumes являются ограниченными ext4, NTFS не используется напрямую
как TSDB filesystem. Production provisioning без fixture placement не меняется.

Для компонентного CLI нужен `umask 022`, чтобы non-root backend мог читать
сгенерированные несекретные configs; секретные файлы получают отдельные строгие
права trusted bootstrap. Входные `config/platform.yaml`,
`config/toolchain-versions.json` и `pnpm-lock.yaml` должны иметь mode 0644 для
проверяемого G12 binding. Журнал запуска хранится отдельно с mode 0600.
