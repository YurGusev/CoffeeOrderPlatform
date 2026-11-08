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
несогласованные evidence завершаются FAIL.

Отдельное правило #277 допускает только восемь точных бинарников для
CVE-2026-78661 как `not_affected` / `vulnerable_code_not_present` по
[согласованному proof и identity contract](runtime-images.md). Оно не расширяет
`approvedFixed`: raw HIGH сохраняются, `resolvedFixed` и `resolvedNotAffected`
разделены; неизвестные или изменённые identity/finding остаются unresolved.
Сохранённый OpenVEX не заменяет независимый пересчёт reader.

Перед запуском G13/G14 фактические
ID всех 14 Node images и nginx сравниваются с проверенными G12 IDs; rebuild
сам по себе не доказывает равенство. Непрохождение проверки останавливает startup.

## Хранение и подготовка

Четыре отдельных bounded ext4 volume принадлежат Grafana, Loki, Prometheus и Tempo; Loki/Prometheus/Tempo настроены на retention 3 дня. Только storage init helper получает привилегии. NTFS не используется непосредственно как TSDB filesystem. После reboot provisioner может восстановить loop attachment к сохранённому backing file только при отсутствии ссылок контейнеров; чужие volumes он не переиспользует. Не удаляйте persistent volumes или business storage при cleanup. При rebind provisioner может удалить и создать заново только Docker-запись собственного data-volume; backing volume и файл с данными сохраняются. Recovery и restore требуют отдельной проверки, сохранённый файл сам по себе не является restore PASS.

При наличии разрешения на локальную подготовку предусмотрены следующие CLI. Имена относятся только к собственным telemetry volumes; helper сверяет owner и lifecycle. Bootstrap использует SOPS через trusted materialization, не выдавая общий secrets-файл runtime. Development leaf `telemetry.grafanaAdmin` создан через trusted bootstrap; staging и production не изменены. Для нового development окружения предусмотрена явная идемпотентная команда `pnpm observability:bootstrap --provision-development-grafana-admin`: существующий ключ не ротируется, другое окружение отвергается. Обычная materialization не создаёт секреты автоматически. Storage и generator требуют законный G12 context (`COFFEE_LAUNCH_CONTEXT_FILE`); постоянный alert-sink использует его просканированный hardened storage-helper image по frozen ID.

```sh
pnpm observability:storage --store grafana --name coffee-observability-grafana-data
pnpm observability:storage --store loki --name coffee-observability-loki-data
pnpm observability:storage --store prometheus --name coffee-observability-prometheus-data
pnpm observability:storage --store tempo --name coffee-observability-tempo-data
env -u COFFEE_LAUNCH_CONTEXT_FILE pnpm observability:bootstrap
pnpm observability:generate --logging-only --output-dir /dev/shm/coffee-platform-observability
pnpm observability:generate --project-name coffee-platform --grafana-volume coffee-observability-grafana-data --loki-volume coffee-observability-loki-data --prometheus-volume coffee-observability-prometheus-data --tempo-volume coffee-observability-tempo-data
```

Logging override применяется до создания или recreation выбранных runtime; затем generator обнаруживает фактические IDs и LogPath. Он проверяет BOM probe, materialized secrets и владельцев томов, создаёт configs/provisioning и `provenance.json` в tmpfs и выводит путь override. Отсутствующие и остановленные роли пропускаются; дубликат или неверный Docker identity/LogPath прекращает генерацию. При пустом списке Collector принимает authenticated OTLP metrics/traces, но filelog, nginx receiver и logs pipeline отсутствуют. Данных логов приложения до обнаружения его контейнеров нет. При пустом наборе Collector подключается только к private `coffee_observability`; после обнаружения приложений он подключается к требуемым producer-сетям. Перед использованием generator сверяет Compose project/network labels и `internal` у существующих сетей и отказывается от чужих. Формальная runtime matrix по-прежнему требует все 15 ролей. Для проверки Collector используется `node tools/observability/health.mjs --collector-container <container>` из среды, где доступны backend endpoints; Collector probe выполняется внутри контейнера.

### Постоянный запуск на сервере

Используйте постоянный checkout принятого commit с установленными frozen dependencies и сохранённым локальным G12 context/evidence для этого же checkout и SHA. `COFFEE_LAUNCH_CONTEXT_FILE` указывает на его абсолютный `evidence/launch/<run-id>/context.json`; этот locator не является config или секретом. Перед запуском pinned образы Loki/Prometheus/Tempo и проверенные G12 image ID Collector, Grafana и storage-helper должны уже присутствовать локально. Lifecycle и generator не загружают эти образы из G12 evidence, а helper containers запускаются с `--pull=never`. Проверенный storage-helper выполняет также операции ownership; его фактический image ID фиксируется в provenance. Collector также применяется по проверенному G12 image ID; provenance связывает его с receipt, исходным commit и run. Для ранее принятого observability release без формата collector receipt refresh использует его неизменённый generator и pinned BOM reference с проверкой фактического image ID; новый release требует receipt без fallback. Путь `/usr/bin/busybox` сверяется с SHA-256 в BOM. На сервере `node` должен совпадать с точной версией в toolchain; age key должен быть доступен trusted bootstrap. G12 component evidence не становится формальным launch admission.

```sh
export COFFEE_LAUNCH_CONTEXT_FILE=/полный/путь/к/evidence/launch/ID/context.json
node tools/observability/service.mjs start
node tools/observability/service.mjs stop
```

`start` сверяет G12, BOM probe, конфигурацию, свободное место root и identity собственных контейнеров/volumes; до остановки он также материализует только Collector/Grafana secrets в tmpfs. Затем останавливает и удаляет только свои контейнеры, восстанавливает четыре loop attachment, генерирует config и поднимает указанные telemetry services. Kafka, PostgreSQL и owner runtime им не запускаются. `stop` удаляет только те же контейнеры. Данные четырёх backend и checkpoint volume сохраняются. Secret materialization выполняется trusted config-bootstrap; дополнительный encrypted inventory и файлы паролей не создаются.

Для восстановления после перезагрузки можно установить user unit ниже, заменив пути на абсолютные пути постоянного checkout и его G12 context. На этом сервере user linger включён. Unit выполняет только подготовку и запуск; Docker использует `on-failure` для перезапуска backend при ненулевом выходе. Контейнеры не стартуют автоматически до восстановления tmpfs/loop устройств; при обычном выходе с кодом 0 автоматический restart не обещается. Docker предупреждает о конфликте двух менеджеров перезапуска: oneshot unit не мониторит отдельно работающие контейнеры. Реальная перезагрузка сервера и её длительность требуют отдельного доказательства.

```ini
[Unit]
Description=Coffee observability
StartLimitIntervalSec=300
StartLimitBurst=6

[Service]
Type=oneshot
RemainAfterExit=yes
Restart=on-failure
RestartSec=10
WorkingDirectory=/полный/путь/к/постоянному/checkout
Environment=PATH=/home/yurgusev/.local/usr/bin:/home/yurgusev/.local/bin:/usr/bin:/bin
Environment=COFFEE_LAUNCH_CONTEXT_FILE=/полный/путь/к/evidence/launch/ID/context.json
ExecStart=/home/yurgusev/.local/usr/bin/node /полный/путь/к/checkout/tools/observability/service.mjs start
ExecStop=/home/yurgusev/.local/usr/bin/node /полный/путь/к/checkout/tools/observability/service.mjs stop
TimeoutStartSec=180
TimeoutStopSec=120

[Install]
WantedBy=default.target
```

После сохранения файла как `~/.config/systemd/user/coffee-observability.service` выполните `systemctl --user daemon-reload` и `systemctl --user enable --now coffee-observability.service`. Не перезапускайте Docker daemon и чужие сервисы ради этой установки. Alert sink хранит события в ограниченном tmpfs: при пересоздании sink эти записи теряются, но данные четырёх backend остаются в persistent volumes.

После создания или recreation owner приложений повторно запустите проверенный lifecycle:

```sh
node tools/observability/service.mjs start
```

Команда заново обнаруживает точные container IDs и LogPath и привязывает к ним filelog. Она кратковременно перезапускает все шесть telemetry services, сохраняя данные четырёх backend и checkpoint volume. До повторного запуска данные новых экземпляров не поступают; автоматическое обнаружение не заявляется.

Loki WAL использует native `disk_full_threshold: 0.8`; отдельный disk alert срабатывает по фактическому filesystem utilization при 80%. Prometheus retention size ограничен 80% configured объёма. Для Prometheus и Tempo не заявляется универсальный native HTTP 503 при 80%. Alert не является ingestion guard. Tempo local backend предназначен upstream для evaluation/development; этот однохостовый вариант не обещает HA или object storage.

Лимит Grafana составляет 512 MiB: прежние 256 MiB привели к OOM и автоматическому restart в реальном прогоне. Это [минимум upstream](https://grafana.com/docs/grafana/latest/setup-grafana/installation/), достаточность которого проверяется под полной нагрузкой. Проверка сравнивает исходные container ID, StartedAt и RestartCount до намеренных restart: последующий healthy и сброшенный OOMKilled не скрывают аварийный перезапуск.

Штатный отказ каждого backend проверяется отдельно на его собственном ограниченном томе. Для Grafana требуется ошибка SQLite при заполнении, для Tempo — ошибка записи WAL; после освобождения места должны читаться прежний и новый маркеры в том же процессе. Prometheus 3.15.1 может вернуть HTTP 200 при ошибке Commit: [OTLP handler](https://github.com/prometheus/prometheus/blob/v3.15.1/storage/remote/write_otlp_handler.go#L114-L193) не передаёт ошибку из defer в возвращаемое значение. Поэтому проверка требует рост `prometheus_tsdb_wal_writes_failed_total` и отсутствие точного sample под давлением, затем сохранность старого и доступность нового sample без дальнейшего роста ошибок после освобождения места. HTTP 200 сам по себе не подтверждает сохранение метрики. Общий G14 и его artifacts требуют PASS всех четырёх backend; один успешный Loki proof недостаточен.

## Alerts и проверка

Пять правил ограничены `deployment_environment`, `service_namespace` и `service_version`: not-ready, consumer lag и Outbox age используют окно 5m; UnknownOutcome — 2m; SSE drop rate — 5m с порогом 5%. `notReady` учитывает Node `runtime_ready` и native nginx `probe_success`, включая отсутствие обязательной серии. Шестое правило проверяет заполнение каждого telemetry volume с `alerts.diskUsage.forMs`. Ошибка query не считается resolved. Firing и resolved должны относиться к одному episode; локальный sink хранит ограниченные ротируемые записи.

`pnpm test:observability` запускает disposable run-id proof и сохраняет результаты в `evidence/observability/<run-id>/`; формальный запуск также сохраняет их в `evidence/launch/<run-id>/gates/G14_OBSERVABILITY/artifacts/observability/`. Файлы: `alert-transitions.json`, `correlation-proof.json`, `redaction-scan.json`, `queue-loss-counters.json`, `retention-result.json`, `runtime-health-matrix.json` и `result.json`. Любой обязательный FAIL/NOT_RUN блокирует G14. Проверяются три сигнала и same-trace correlation, redaction, шесть alert episodes, outage/loss, memory/retry/stop, права и сети, persistence и восстановление после disk pressure. Проверка TTL в bounded fixture profile не доказывает истечение реальных 72 часов; сохранность после restart/recreate/checkpointed crash и restore требуют собственного evidence.

Loki retention fixture сохраняет включённый embedded chunk cache и сокращает только его TTL до 30 секунд вместе с остальными тестовыми интервалами. Стандартный часовой TTL мог возвращать удалённый chunk из кеша дольше шестиминутного proof; парные native опыты подтвердили отсутствие старого маркера при сохранности свежего с TTL 30 секунд. Effective настройки проверяются до нагрузки и после восстановления исходного профиля; production retention и cache TTL не меняются. При timeout сохраняются последние наблюдения compactor и old/current controls.

Tempo TTL fixture сокращает также `live_store.flush_op_timeout` до 30 секунд: в закреплённом [upstream](https://github.com/grafana/tempo/blob/a0826bc9eb8397d614dde91fb00b3809835b7e52/modules/livestore/live_store_background.go#L215-L236) это период cleanup, а `complete_block_timeout` задаёт возраст блока. С исходным cleanup 5 минут marker исчез лишь на 303-й секунде, поэтому обязательные следующие 2 минуты отсутствия не помещались в 6 минут. Парный опыт с единственным изменением cleanup подтвердил 122 секунды отсутствия и 13 свежих controls. Effective cadence и восстановление исходного значения проверяются; последние Tempo observations сохраняются. Production retention/cadence, compaction, deadline и required absence window не меняются; producer остановлен до retention.

Disk proof сначала достигает ENOSPC и нулевого `bavail`, затем требует настоящий native failure. После подтверждённой ошибки [SQLite может откатить транзакцию](https://www.sqlite.org/lang_transaction.html#response_to_errors_within_a_transaction) и освободить блоки; положительный post-request `bavail` сам по себе не отменяет наблюдённый отказ. Identity файловой системы проверяется всегда. Снимок и native failure записываются до assertions; точное удаление собственного filler, чтение старого и нового маркеров, тот же процесс и отсутствие OOM остаются обязательными.

G12 имеет установленный scope 22 images + lockfile / 46 reports. Дополнительный scan временного PostgreSQL fixture хранится отдельно: Debian 17.11 дал 86 HIGH / 2 CRITICAL, проверенный кандидат 17.11 Alpine — 34 HIGH / 1 CRITICAL. Это findings тестового инструмента, не допуск или VEX и не изменение G12 targets; fixture не объявляется clean. PostgreSQL business storage остаётся внешним. Полные raw результаты и ограничения указываются в delivery report.

Runtime metric matrix охватывает 14 Node runtime и native nginx до штатного cleanup: self-mTLS live/ready/text metrics и ожидаемые 4xx, OTLP HTTP/error и producer metrics, 10 DB-waiting, lag двух durable Kafka consumers с committed offsets и пять scoped Outbox-age series. Cold `realtime-gateway` до consume/commit имеет неизвестный lag (`-1`), отмеченный `ACTIVITY_DEPENDENT / NOT_ASSERTED_WITHOUT_ACTIVITY`; launch-фаза проверяет его после реальной активности. Событийные и транзакционные samples требуют активности шести owner roles и SQL-backed convergence helper, который не заменяет постоянный runtime. Сканируются 15 final images по фактическим IDs.

Формальный G14 использует подготовленный G08 PostgreSQL и пять баз, имена
которых выведены из launch run ID и владельцев `customer`, `catalog`, `pricing`,
`orders`, `integration`. Используются существующие scoped роли; удаление этих
баз допускается только после подтверждённой остановки потребителей. При
неподтверждённой очистке базы и receipt сохраняются для разбора. Временные Kafka
и simulated provider остаются частью проверки.

Для согласованной браузерной корреляции G14 и для G15 используется отдельный
OIDC-only child с подтверждённой связью с parent candidate; Kafka image допускается
по проверенному G12 parent. В компонентном диагностическом режиме
`--observability-fixture` по-прежнему использует отдельный PostgreSQL с PGDATA в
tmpfs 512 MiB и не подтверждает изоляцию существующей business БД. Компонентные
Orders owners получают canonical `config/database-ownership.json` через
read-only mount с проверкой hash и role-local доступа. Этот режим не создаёт
launch identity. Формальные full-system SLO, chaos и capacity остаются
`NOT_RUN` до отдельного подтверждения.

Браузерный subproof G14 выполняет один Confirm через UI и связывает его CID с
Published Outbox, Processed Inbox, SSE frame и последующим owner GET. До Confirm
он проверяет hash загруженного child config, отключённые provider mutations и
изолированную provider fixture. Если Recovery опередил consumer или cleanup не
подтверждён, этот путь не принимается. Отдельный synthetic ingress остаётся
component diagnostic и не подтверждает browser correlation. При отсутствии
доказанной общей W3C-трассы child packet сохраняется с `traceStatus: NOT_PROVEN`;
это не PASS полного G14 и не заменяет SLO, chaos или capacity.

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
