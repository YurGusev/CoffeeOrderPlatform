# Архитектура исполнения

**Граница редакций:** таблица ниже описывает действующий Node-профиль #19/#3.
[ADR-0031](../adr/ADR-0031-nginx-transport-and-application-auth.md) и
[контракт #159](29_NGINX_TRANSPORT_AND_AUTH.md) задают target после #162:
`edge-nginx` принимает public TLS/static/SSE proxy, `edge-gateway` остаётся
private Node authorizer, `web` исчезает только из runtime (не из `apps/web`
browser build). До атомарного #162 таблица и active manifests не меняются;
после переключения ровно 14 Node runtime + один native nginx и те же 5 owner DB.
Все owner, API, event и durable boundaries ниже сохраняются.

## Единицы развёртывания

Точные HTTP/event contracts, исходящие вызовы, БД, роли, секреты и публичность
каждого runtime заданы в [нормативном каталоге](10_RUNTIME_CATALOG.md). Таблица
ниже является кратким индексом и не предоставляет исполнителю свободу выбирать
недостающие значения.

| Runtime | Владелец | Назначение | Доступ к данным |
|---|---|---|---|
| `edge-gateway` | Platform | TLS, auth handoff, routing, limits | none |
| `api-public` | Platform | stateless `client-v1` trust/composition root | none |
| `api-internal` | Platform | stateless `internal-v1` trust/delegation root | none |
| `web` | Frontend | React static assets | none |
| `customer-service` | Customer | customer commands/queries | customer DB |
| `catalog-service` | Catalog | products, mappings, availability | catalog DB |
| `catalog-supplier-sync` | Catalog | complete safe AROMA catalog reads | catalog DB |
| `catalog-activation-worker` | Catalog | validate/atomically activate received generations + Outbox | catalog DB |
| `pricing-service` | Pricing | quote calculation and validation | pricing DB |
| `orders-service` | Orders | Draft, Confirm, Order Card | orders DB |
| `orders-aroma-preparation` | Orders | reacts to Catalog facts, updates Desired | orders DB |
| `aroma-observer` | Orders | safe physical cart reads | orders DB |
| `aroma-convergence` | Orders | leased GET-mutate-GET attempts | orders DB |
| `aroma-gateway` | Integration | provider session and typed primitives | integration DB/cache only |
| `realtime-gateway` | Realtime | SSE invalidation fanout | no business DB |

Каждый runtime — один Node process на container. Compose новой платформы
подключает процессы к уже работающему `coffee_postgres` и не создаёт второй
PostgreSQL. Масштабирование выполняется
replicas, а не `node:cluster` или PM2.

## Границы доверия

```text
Browser -> edge -> api-public -> /api/client-v1/* -> owning services
Browser -> edge -> /events          -> realtime-gateway
Workers -> api-internal -> /api/internal-v1/* -> owning services/Gateway
api-internal -> aroma-gateway -> allowlisted provider origin
```

Edge не содержит business authorization, не обращается к PostgreSQL и не имеет
маршрута непосредственно к owner services. `api-public`/`api-internal` не имеют
business DB, Kafka или provider credentials. Delegation context позволяет
Gateway проверить transport caller, original caller и operation audience.
AROMA credentials доступны только `aroma-gateway`.

Эти trust zones не совпадают один-к-одному с Docker networks. Exact physical
attachments, отдельные `coffee_postgres_data`/`coffee_kafka_event` и инвентарь
host:port заданы в
[матрице runtime](23_RUNTIME_CONFIGURATION_MATRIX.md). Ни один новый runtime не
подключается к legacy `coffee_network`.
Ограничения общего TCP plane и действующие границы авторизации уточняет
[ADR-0041](../adr/ADR-0041-local-server-network-boundaries.md).

## Технические пакеты платформы

```text
contracts, config, database, migrations, http-runtime, http-client,
security, observability, idempotency, outbox, inbox, kafka-runtime, testing
```

Бизнес-типы не помещаются в общие пакеты. Межсервисные зависимости
разрешены только через версионированные контракты OpenAPI/JSON Schema.

## Добавление нового runtime

Каталог первого запуска является закрытым exact set. Шестнадцатый runtime не
добавляется только правкой Compose или созданием каталога. До реализации нужны:

1. отдельный принятый ADR с причиной новой process/trust/failure boundary;
2. один названный владелец данных, API, событий, retry и восстановления;
3. versioned HTTP/event contracts без межвладельческого SQL;
4. обновление service/DB/interaction/secret manifests и их JSON Schema;
5. RED tests для cross-owner import, DB claim и неизвестного interaction;
6. отдельный русскоязычный issue, ветка и PR в `develop`.

До создания workspace в #3 проверки #2 запускаются напрямую:

```text
node scripts/check-service-catalog.mjs
node scripts/check-database-ownership.mjs
node scripts/check-architecture.mjs
node --test tests/architecture/checks.test.mjs
```

#3 подключает их без изменения semantics к `pnpm architecture:check` и фиксирует
`dependency-cruiser@18.2.0` в manifest/lockfile. Второй TypeScript compiler для
Dependency Cruiser не добавляется: project-owned wrapper применяет правила к
AST dependency graph и нормализует NodeNext `.js` specifier к source `.ts`.

## Единый lifecycle после #61

Все 15 `apps/*/src/main.ts` вызывают только
`startConfiguredRuntime(runtimeName, composition?)` из `@coffee-platform/runtime`.
Он проверяет `config/platform.yaml` и scoped secrets до создания listener.
Порты, trust surfaces, DB/Kafka ownership и secret scopes не изменяются.

Состояния: `starting → running → draining → stopped`; ошибка запуска проходит
`starting → draining → stopped`. Повтор текущего перехода и повтор остановки
идемпотентны. Обратный переход выбрасывает `RuntimeError` с
`code=RUNTIME_INVALID_TRANSITION` и пишет `runtime.transition.invalid`.
`running` означает завершённый startup, но не заменяет dependency readiness.

`RuntimeComposition` содержит только `configure(app, signal)`, `readinessChecks`
и `resources`. `configure` регистрирует Fastify routes/plugins до bind; ресурсы
нельзя создавать вне зарегистрированного `RuntimeResource`. После bind runtime
последовательно вызывает `resource.start(signal)`. Ресурс записывается как owned
до вызова `start`, поэтому частичная ошибка также получает cleanup.
`health.startupGraceMs` ограничивает startup, затем применяется отдельный
`platform.shutdownGraceMs` для cleanup. После отмены startup последующие ресурсы
не запускаются; поздний listener закрывается.

`RuntimeResource` задаёт стабильное имя, optional `start(signal)`, обязательные
`stop(signal)` и синхронный `destroy()`. `destroy` должен быть идемпотентным,
неблокирующим и закрывать в том числе частично созданные sockets/pools/workers.
Owner использует signal в поддерживаемых I/O; runtime не создаёт DB/Kafka clients
и не выбирает retry. Нельзя возвращать detached work без owned cleanup.

`SIGTERM`/`SIGINT` обрабатывает только общий runtime. Он сразу снимает readiness
и admission, отменяет lifetime signal workers, вызывает Fastify close для drain
HTTP, затем `stop` ресурсов в обратном порядке. Все этапы используют один
shutdown budget. Повторный signal получает тот же результат, handlers снимаются
после завершения. При deadline или незавершённой работе runtime отменяет signals,
уничтожает tracked sockets и owned resources и возвращает `fail-stop`; рабочий
`startRuntime` завершает process с кодом 1. Native Promise не считается отменённым
только потому, что ожидание закончилось. При блокировке самого event loop границу
процесса обеспечивает container supervisor.

Для локального harness доступны `createRuntime(identity)` и
`app.runtimeController.start()/closeRuntime(signal?)`; `whenStopped` публикует
`{status: stopped | fail-stop, pending}`. Только этот harness получает fail-stop
как значение без завершения процесса. Owners закрывают runtime через
`closeRuntime`, не создавая свой shutdown controller вокруг `app.close()`.

### Readiness matrix

`configuredRuntimeIdentity(config, name, composition)` выводит обязательные
имена checks из `services[name].database` и directional `kafka.producers/consumers`, без второго реестра.

| Checks | Runtime |
|---|---|
| Только config/scoped trust и bind | `edge-gateway`, `api-public`, `api-internal`, `web` |
| `database` | `customer-service`, `catalog-service`, `catalog-supplier-sync`, `pricing-service`, `aroma-gateway` |
| `kafka` | `realtime-gateway` |
| `database`, `kafka` | `catalog-activation-worker`, `orders-service`, `orders-aroma-preparation`, `aroma-observer`, `aroma-convergence` |

Каждый обязательный check регистрирует owning composition. Отсутствующий check,
`false`, ошибка или истечение `health.timeoutMs` дают `503`. Для одного check
выполняется не более одного незавершённого probe; non-cooperative blackhole не
порождает новые promises при каждом health request. После завершения probe
следующий запрос проверяет dependency заново. Результат повторно проверяет phase,
поэтому начатый до draining probe не возвращает readiness `200` после остановки.
Поле `failureThreshold` не откладывает снятие readiness при доказанном отказе.

`/health/live` остаётся process check с `200`, `/health/ready` даёт `503` в
`starting`, `draining`, `stopped`; после закрытия listener новые TCP подключения
уже не принимаются. Health и `/metrics` обходят business admission cap.
`services[name].concurrency` ограничивает активные request operations отдельно;
исчерпание cap увеличивает `runtime_admission_rejected_total`, не подменяя
проверку DB/Kafka доступности. DB check не должен считать краткое ожидание slot
в pool доказательством отказа PostgreSQL.

До #62/#63 реальные DB/Kafka checks не подключены, поэтому соответствующие roots
ожидаемо not-ready даже при успешном bind. Это foundation contract, не admission
Compose или business delivery.

### Request context и диагностика

`request.runtimeContext` содержит correlation/trace fields, `signal`,
`deadlineUtc` и `acceptDurable()`. Deadline берётся из `services[name].deadlineMs`;
явный `null` сохраняется для `api-internal` и `realtime-gateway`. Для конкретного
route `config.runtimeDeadlineProfile` выбирает только существующее имя из
`deadlineProfiles`; неизвестный профиль блокирует регистрацию route.
Owner обязан назначить operation budget для маршрутов без общего deadline.
`platform.bodyLimitBytes` передаётся Fastify, секреты и bodies не логируются.

Преждевременный `IncomingMessage.aborted/close` отменяет input только при
`complete=false`. `ServerResponse.close` при `writableFinished=false` отменяет
ожидание ответа даже для полностью прочитанного GET. Normal finish не отменяет
signal; timers/listeners удаляются. Request deadline отменяет signal и закрывает
transport, не формируя новый public error contract. Граница known durable commit
описана в [событиях и восстановлении](06_EVENTS_AND_RECOVERY.md).

Для #64 опубликованы log events `runtime.phase`, `runtime.transition.invalid`,
`runtime.readiness.failed`, `runtime.shutdown.failed`, `runtime.stop.failed`, `runtime.destroy.failed`,
`runtime.shutdown`. Labels ограничены runtime, phase, configured dependency/resource
name; shutdown содержит `status`, `pending`, `durationMs`, signal. Correlation и
W3C traceparent остаются request log fields, не metric labels. Имена ресурсов
уникальны, состоят из `[a-z][a-z0-9-]{0,63}`; в них нельзя кодировать request IDs.
