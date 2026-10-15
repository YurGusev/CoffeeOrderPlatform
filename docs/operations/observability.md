# Наблюдаемость первого запуска

Operations владеет #64 и обязательным predecessor G14 в #13. Единственный
evidence path — `pnpm test:observability` и `evidence/handoffs/issue-64.yaml`.
Наличие producer или конфигурации не означает PASS.

`pnpm test:observability` включает canonical runtime metric matrix #64 в уже
существующий Compose recovery-proof запуск через trusted programmatic hooks.
Матрица проверяет все 14 Node runtime и native nginx до стандартного Compose
cleanup; она не использует `--keep`, pinning ресурсов или отдельную параллельную
pipeline. Вызовы идут по фактическому self-mTLS пути для live/ready/text metrics
и ожидаемых 4xx. Для каждого Node runtime проверяются OTLP HTTP/error и producer
metrics. Матрица требует 10 DB-waiting, lag для двух durable Kafka consumers с
подготовленными committed offsets и 5 scoped Outbox-age series. Свежая группа
`realtime-gateway` до реального consume/commit сообщает неизвестный lag (`-1`),
поэтому cold recovery matrix отмечает её как
`ACTIVITY_DEPENDENT / NOT_ASSERTED_WITHOUT_ACTIVITY`. Обязательная G14 launch
фаза отдельно проверяет lag realtime consumer после реального consume/commit;
вместе две проверки покрывают все три configured Kafka consumer owners.
Событийные и транзакционные samples принимаются только после реальной
активности существующего owner launch: шесть ролей и SQL-backed convergence
helper; helper не заменяет постоянно работающий runtime. До default cleanup
сканируются все 15 final images по фактическим image IDs.

Проверка фиксируется полем `runtimeMetricMatrix` в результате команды. Это
functional evidence #64; оно само по себе не означает PASS полного G14 и не
доказывает capacity. #13 по-прежнему владеет launch-level full-system G14:
SLO, chaos/failure admission, capacity и сквозные browser/business/DB/Kafka/SSE
критерии. Успешная сборка образов или частичный launch path не заменяют эти
проверки.

## Authority и поток

Required `config/platform.yaml.telemetry` задаёт endpoints, streams, очереди,
таймауты, retention, disk breaker и alert windows. Schema/parser отвергают
отсутствующие поля и замораживают результат; staging/production требуют release
digest. Exact npm/image/probe refs берутся только из BOM. Install, image build
и profile checker проверяют BOM до materialization.

Node пишет Pino JSON в stdout и экспортирует OTel traces/metrics. Fastify
связывает route template, request и проверенный W3C context. Секреты, PII,
headers/body/query/SQL/provider payload редактируются до serialization.
Correlation/entity refs относятся к logs/traces, не metric labels. Native nginx
сохраняет собственный transport logger и не импортирует Node SDK. Он передаёт
валидные W3C context и client correlation UUID авторизатору; собственный
`request_id` остаётся отдельным transport identifier. Невалидные значения
не попадают в telemetry context. Приватный `stub_status` берётся только из
`telemetry.nginxStatusEndpoint` и не публикуется на host/public listener.

OpenObserve хранит OTLP metrics отдельным stream на каждое семейство. Поэтому
`streams.metrics` задаёт префикс, который Collector добавляет к имени instrument;
точка в имени нормализуется в `_`. Logs/traces используют свои configured stream
names. Native metric alerts обращаются к реальным семействам с этим префиксом.

Метрики публикуются только при наличии соответствующего owner resource:

| Instrument | Владелец / применимость |
| --- | --- |
| `runtime_http_*`, `runtime_ready`, process/producer counters | Node runtime |
| `db.client.connection.waiting`, `db.client.connection.checkout_wait`, `db.client.transaction.*` | Runtime с собственной DB; waiting отражает текущую очередь |
| `messaging.kafka.consumer.lag`, `messaging.kafka.event.age` | Зарегистрированный Kafka consumer |
| `messaging.outbox.oldest_unpublished.age`, `messaging.inbox.*` | Соответствующий Outbox/Inbox owner |
| `coffee_aroma_attempt_*`, `coffee_aroma_unknown_outcomes_current` | `aroma-convergence`; current — нерешённые outcomes, не исторический counter |
| `coffee_realtime_*` | `realtime-gateway` |
| `nginx_*` | Native `edge-nginx` через `stub_status` |

Histogram в OpenObserve материализуется семействами `_count`, `_sum`, `_bucket`.

Trusted generator выбирает точные Compose project/service/container IDs,
получает Docker LogPath и монтирует только выбранные каталоги read-only.
Collector filelog не получает Docker socket и не сканирует wildcard paths.
Docker logging rotation применяется generated override до создания контейнеров;
после recreation требуется новое discovery/generation. Collector config,
Compose override и безсекретная provenance создаются в tmpfs.

Collector применяет memory limiter, batch, конечные sending queues, timeout
и retry window. Backend network соединяет только Collector/OpenObserve;
producer ingress использует существующие private zones. Отказ telemetry
не участвует в business readiness и не разрешает business replay.
Collector экспортирует собственные queue/loss counters; nginx scrape включается
только при наличии его настоящего ID в выбранном inventory. Producer разделяет
export failure, queue overflow, serialization rejection и shutdown loss; все
счётчики process-scoped и связаны с process start time.
Native `http_check` отдельно измеряет health endpoints Collector/OpenObserve;
его status/error metrics проходят тот же configured prefix и resource mapping.
Интервал и timeout берутся из `platform.health`, business readiness их не использует.
`telemetry.openObserve.telemetryEnabled`, `mmdbDownloadEnabled` и
`modelPricingEnabled` обязательно равны `false`: backend не отправляет внешнюю
телеметрию и не загружает GeoIP или model pricing. Эти значения применяются
также в одноразовом bootstrap, без открытия egress.

## Bootstrap и storage

Collector получает `telemetry.exporterToken` и отдельный
`telemetry.openObserveIngestToken`; только trusted bootstrap получает
`telemetry.openObserveAdmin`. Отсутствие нового encrypted leaf приводит к отказу.
Два infrastructure scope заданы в `config/service-catalog.json` и закреплены
его схемой; Collector scope не допускает admin reference.
Единый SOPS source в этой задаче не изменялся; provisioning требуется отдельно.
Admin secret читается из tmpfs только seed-процессом. После успешного admin probe
bootstrap записывает маркер инициализации в volume. Обычный OpenObserve process
проверяет маркер и email, получает публичный validation marker вместо credential
и использует volume без admin mount. Validation marker не проходит аутентификацию.

OpenObserve требует AVX/AES. Published image не содержит shell/probe; read-only
static BusyBox проверяется по BOM hash. G14 допускает явный временный QEMU test
fixture с записанными version/hash; эмуляция не доказывает capacity или production
admission и удаляется после проверки.
В функциональном QEMU-прогоне лимит CPU только OpenObserve fixture равен 4 вместо
2 в нативном прогоне; configured memory limit равен 2048 MiB в обоих режимах.
Предыдущий QEMU-прогон с 512 MiB завершился OOM. Функциональный прогон проверяет
новый общий лимит; capacity и производительность на native CPU принимает #13.

Storage provisioner создаёт отдельный bounded ext4 volume на loop-backed файле.
Привилегии получает только этот init helper. Чужие volumes не переиспользуются;
fixture cleanup проверяет owner/lifecycle и не удаляет persistent storage.
Native disk breaker отклоняет ingestion выше configured watermark. Compaction
cadence, retention, finished-job wait и file deletion delay заданы в config.
Settings или ручной delete не доказывают expiry после TTL.

Buffer policy OpenObserve задана явно в `telemetry.openObserve`: общий Arrow
memtable ограничен 128 MiB при container limit 2048 MiB, один файл ограничен
8 MiB отдельно в памяти и на диске. Интервал 2 s сохраняет только уже
immutable memtables; активный файл проверяется на ротацию по возрасту каждые
30 s и при лимите 30 s может ротироваться почти через 60 s. Trusted generator
передаёт эти значения как
`ZO_MEM_TABLE_MAX_SIZE`, `ZO_MAX_FILE_SIZE_IN_MEMORY`,
`ZO_MAX_FILE_SIZE_ON_DISK`, `ZO_MEM_PERSIST_INTERVAL` и
`ZO_MAX_FILE_RETENTION_TIME` в Compose и canonical fixture из одного mapping.
Параметры закреплены в upstream
[`v1.1.0 config.rs`](https://github.com/openobserve/openobserve/blob/v1.1.0/src/config/src/config.rs#L2496-L2543),
перевод MB в байты — в
[`v1.1.0 config.rs`](https://github.com/openobserve/openobserve/blob/v1.1.0/src/config/src/config.rs#L4390-L4405),
а ротация по возрасту — в
[`v1.1.0 writer.rs`](https://github.com/openobserve/openobserve/blob/v1.1.0/src/ingester/src/writer.rs#L647-L684).
Это конечные writer limits, не capacity/SLO guarantee.

OpenObserve из принятого BOM суммирует диски всех mount points, являющихся
префиксами data directory, включая `/`. Поэтому свободное место корневого диска
также влияет на native breaker. Health probe отдельно проверяет заполнение `/data`;
bounded filesystem ограничивает telemetry независимо от свободного места хоста.
При admission проверяются оба диска; увеличение порога не заменяет очистку.

На совместимом локальном Operations-хосте подготовка выглядит так:

```sh
pnpm observability:storage --name coffee-platform-observability-data
pnpm observability:bootstrap --initialize --data-volume coffee-platform-observability-data
pnpm observability:bootstrap --collector
pnpm observability:generate --logging-only --output-dir /dev/shm/coffee-platform-observability
docker compose -f compose.yaml -f /dev/shm/coffee-platform-observability/runtime-logging.override.yaml up -d --force-recreate
pnpm observability:generate --project-name coffee-platform --data-volume coffee-platform-observability-data
```

Logging override применяется до recreation business runtimes. Затем generator
снимает актуальные IDs/LogPath и создаёт observability override; путь выводится
generator. Scoped helper передаёт единственный Collector config в root:root/0400
с CAP_CHOWN; сам Collector работает без capabilities. Создание org-scoped ingest token, stream settings
и alerts требует trusted Operations management bootstrap. Команды не являются
разрешением deployment; domain runtime management credential не получает.

## Runbook отказов

- Backend outage: проверить telemetry health и refused/failed/drop counters;
  business requests продолжаются, business effects не replay.
- Queue saturation: сопоставить configured capacity и process counters;
  diagnostics ограничены частотой и не используют падающий exporter.
- Restart: повторить discovery/generation. Counter reset связывается с process
  start; abrupt crash может оставить gap без точного durable loss count.
- Disk pressure: проверить только telemetry volume, breaker и retention jobs.
  PostgreSQL/Kafka volumes не очищаются, breaker не выключается.
- Restore: остановить telemetry, сохранить backing file отдельно, восстановить
  в новый volume, привязать loop device и проверить streams/settings. После host
  reboot требуется повторное provisioning привязки. Backup не равен restore PASS.
- SIGTERM: best-effort flush ограничен platform shutdown grace; telemetry не
  становится durable business ledger.

## Приёмка

G14 создаёт disposable run-id stack и credentials, использует только local
sink. Native scheduled alerts сохраняют окна 5m для not-ready/lag/Outbox/SSE
и 2m для UnknownOutcome, с минутной quantization и scheduler lag. Firing/resolved
связываются episode/run-id; API/query error не означает resolved.
Operations runner проверяет сервисы по их фактическим IP внутри изолированного
Docker-хоста; OpenObserve, Collector и synthetic producer не публикуют host ports.
Disk pressure заполняет только собственный fixture telemetry volume с резервом,
проверяет native отказ ingestion и generated watermark guard, затем удаляет
свой файл по inode и проверяет восстановление. Business volumes не участвуют.

В `evidence/observability/<run-id>/` сохраняются `alert-transitions.json`,
`correlation-proof.json`, `redaction-scan.json`, `queue-loss-counters.json`,
`retention-result.json`, `runtime-health-matrix.json` и `result.json`.
Любой обязательный NOT_RUN/FAIL сохраняет G14 закрытым. Handoff перечисляет
executed commands, digests и границы доказательства; synthetic fixture не
подменяет сквозной business/DB/Kafka/SSE launch trace. Runtime matrix является
functional #64 evidence; QEMU fixture может подтвердить только функциональный
путь и не является capacity или production-admission доказательством.
