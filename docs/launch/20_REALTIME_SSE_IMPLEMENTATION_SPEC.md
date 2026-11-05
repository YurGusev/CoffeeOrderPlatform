# Исполнимая спецификация realtime SSE

Статус: нормативная спецификация issue #12. Исполнитель не выбирает replay,
authorization, fanout limits, Query invalidation или slow-client policy заново.
Wire definitions `GET /events` и `RealtimeInvalidated.v1` материализованы в
`contracts/openapi/client-v1.yaml` и
`contracts/schemas/events/realtime-invalidated.v1.schema.json`; они передают
только invalidation metadata, не business state.

### Согласованные integration seams #12

Уточнения архитектора от 7 октября 2026 закрывают границы реализации, но не
являются evidence исполнения или production admission:

- `realtime-gateway` получает только
  `security.actorContextEdgeVerificationPublicKeys` через существующий trusted
  config-bootstrap. Этот ref совпадает в `config/platform.yaml`, service catalog
  и mutable launch runtime profile. Private signing material остаётся у Edge;
  отсутствующий или неверный scoped verifier блокирует startup/receiver.
- `RealtimeBinding.decode(value, record)` получает transport record только в
  realtime branch, чтобы schema, subject и `record.key === subjectRef`
  проверялись до enqueue. Durable decoder/Inbox/transaction/offset semantics
  остальных consumers не меняются. Permanent rejection попадает в существующий
  realtime DLQ до offset commit; programming/infrastructure failure не считается
  успешным invalidation. Gateway не получает owner DB или HTTP client.
- Ранний shared runtime admission допускает только opt-in синхронный response
  для saturation. Realtime использует один typed `503
  REALTIME_CAPACITY_EXCEEDED` с correlation/no-store до SSE headers на раннем и
  handler paths. Default остальных runtime и lifecycle/startup/degraded/draining
  responses сохраняются; callback не выполняет I/O и не создаёт queue.
- Шесть команд `test:realtime-contract`, `test:realtime-auth`,
  `test:realtime-replay`, `test:realtime-backpressure`, `test:web-realtime`,
  `test:realtime-soak` обязаны иметь реальные непустые targets. Отсутствующий
  prerequisite/tooling не заменяется successful skip. Короткий transport smoke
  явно отличается от полного capacity proof.

## 1. Архитектура

```text
owner transaction + Outbox
  -> Kafka RealtimeInvalidated.v1
  -> realtime-gateway consumer
  -> bounded in-memory replay/fanout
  -> private GET /events origin
  -> edge authenticated same-origin GET /events
  -> browser EventSource
  -> TanStack Query invalidate/refetch owner GET
```

`realtime-gateway` не читает owner events напрямую: consumer принимает только
`RealtimeInvalidated.v1`. Он не имеет БД, business cache или owner HTTP client.

## 2. Kafka consumer

- topic `coffee.realtime.invalidate.v1`, key=`subjectRef`;
- один instance, group `realtime-gateway-v1`; второй instance запрещён до
  отдельного решения о fan-out и проверки multi-replica delivery;
- auto topic creation/auto commit запрещены;
- validate JSON Schema/envelope before use;
- owner aggregate binding — только `aggregate.type=Order`, как в действующем
  Orders Outbox/DDL; `aggregate.ref=payload.subjectRef=Kafka key`,
  `aggregate.version=payload.ownerVersion`. Для projection invalidation это
  `projectionVersion`, не business Order version и не версия команды.
  `OrderCard` обозначает read model, но не accepted owner wire aggregate;
  исторические immutable Outbox records не мигрируются ради consumer fixture;
- поддерживается только `subjectType=order` в первом запуске;
- unknown type/schema -> quarantine/DLQ, не fanout;
- duplicate `messageId` в локальном replay window -> no-op;
- для одного subject событие с ownerVersion меньше/equal уже принятой версии не
  fanout, кроме equal+different payload, которое quarantine;
- при равной ownerVersion сравнивается canonical payload; новый messageId или
  correlationId при том же payload не создаёт конфликт. Для прежнего messageId
  сохраняется проверка полного envelope;
- offset commit после помещения события в ring buffer и fanout queues. Потеря
  in-memory события при crash безопасна благодаря reconnect reset/refetch.

Readiness и допуск SSE начинаются только после назначения всех configured
partitions единственному fixed-group consumer. Kafka metadata connection сама
по себе не закрывает startup gap при `auto.offset.reset=latest`. Ожидание входит
в общий bounded startup lifecycle и отменяется его `AbortSignal`; отдельного
таймаута, durable offset policy или обхода авторизации не вводится.

## 3. Авторизация `GET /events`

Маршрут не принимает query-строку или объявленное request body: нарушение
возвращает `400 VALIDATION_FAILED` до SSE headers. Этот существующий ответ
объявлен в OpenAPI `client-v1`, manifest и generated transport types.

Public route существует только на edge. Edge проверяет session/JWT, удаляет
client `X-Actor-*` headers и передаёт подписанный trusted actor context с
`actorRef`, permissions, expiry и audience `realtime-gateway`.
После #162 здесь `edge` означает nginx transport с отдельным private
`edge-gateway` auth subrequest: nginx сам не валидирует browser session и не
подписывает actor. Только Edge authorizer выпускает `iss=edge-gateway`, а
realtime receiver проверяет transport SAN `edge-nginx`, audience и подпись
по [контракту #159](29_NGINX_TRANSPORT_AND_AUTH.md). Это не меняет Kafka/replay
и owner authorization ниже; #12 обязан проверить SSE через реальный nginx.
До SSE headers отказ авторизации сохраняет typed `401/403` или `503
AUTHORIZER_UNAVAILABLE` и не открывает realtime upstream. Отказ admission
отличается кодом `503 REALTIME_CAPACITY_EXCEEDED`; локальная настройка этого
ответа не отменяет общую обработку ошибок nginx.
Browser EventSource не обязан отправлять `traceparent`. При отсутствии HTTP
header receiver требует уже существующий signed no-trace sentinel Edge
`00-00000000000000000000000000000000-0000000000000000-00`; при наличии header
требуются valid non-zero trace и точное совпадение с assertion/runtime context.
Это не меняет compact Actor Context или подпись; дубликаты/несовпадения header
отклоняются, а correlation, permission, operation, audience и expiry обязательны.
После logout/401 browser сразу закрывает EventSource и private cache; до
истечения уже открытого stream realtime перепроверяет `iat/exp` каждые 30s
с тем же допуском 5s по уже полностью проверенным claims. Неизменный assertion
и фиксированный при configure набор ключей не требуют повторного декодирования
и проверки подписи; каждое новое соединение проходит полную проверку заново.
Серверная мгновенная ревокация прежнего соединения не обещается.

В первом запуске stream разрешён только actor с permission `orders:read:any`.
Query/body subject filters, actorRef, permissions и orderRef endpoint не
принимает. Поэтому клиент не может запросить чужой subject: либо server-derived
permission разрешает поток всех Order invalidations, либо соединение получает
403. При появлении scoped order permissions потребуется отдельный ADR и owner
authorization projection/API; доверять client filter запрещено.

401/403 возвращаются до SSE headers как RFC 9457. После открытия stream auth
expiry проверяется каждые 30s; expired context закрывает connection без
продления server-side. Browser переподключается через edge и проходит auth снова.

## 4. SSE wire contract

Response headers:

```text
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-cache, no-transform
Connection: keep-alive
X-Accel-Buffering: no
```

### `resource-invalidated.v1`

```text
id: msg_<ULID>
event: resource-invalidated.v1
retry: 3000
data: {"subjectType":"order","subjectRef":"ord_<ULID>","ownerVersion":"7","reason":"OrderChanged","correlationId":"<uuid>"}

```

`id` равен Kafka `messageId`. `ownerVersion` — canonical decimal string.
`reason=OrderChanged|AromaStateChanged`. Data не содержит Customer, items,
money, Desired/Observed, blockers или actions.

### Service records

- после auth, replay/reset и установки live delivery: `event: stream-ready.v1`,
  data содержит только
  `connectionId`, `connectedAt`; `id` отсутствует;
- если replay невозможен: `event: stream-reset.v1`, data
  `{reason:"REPLAY_UNAVAILABLE"}`; `id` отсутствует;
- heartbeat каждые 15s — SSE comment `: heartbeat <RFC3339>`, не event и не id.

## 5. `Last-Event-ID` и replay

Каждый instance хранит ring buffer максимум 10 000 invalidations и максимум 5
минут; срабатывает первый лимит. Business state там нет.

При connect:

1. После auth/admission получить replay boundary и подготовить connection queue;
   события после boundary не теряются между replay и подключением live.
2. Header отсутствует -> replay отсутствует; найденный ID -> subsequent replay
   по порядку; malformed/not found/restart/eviction -> `stream-reset.v1`.
3. После replay/reset и установки live delivery отправить `stream-ready.v1`,
   затем live frames. Initial owner refetch браузера начинается после ready.
4. Query parameter `lastEventId` запрещён; используется стандартный header.

Replay — оптимизация, не гарантия доставки. `stream-reset` требует безопасный
owner refetch и поэтому не нуждается в sticky session/persistent replay DB.

## 6. Fanout и backpressure

Лимиты одного instance (materialization и capacity proof принадлежат #12):

- технический максимум 512 active connections; 513-я получает `503
  REALTIME_CAPACITY_EXCEEDED` до SSE headers;
- per-connection queue: максимум 64 records или 256 KiB serialized, первый
  достигнутый лимит;
- socket write deadline 5s;
- max event data 2 KiB; больше -> quarantine producer event;
- heartbeat 15s; edge idle timeout минимум 45s;
- nginx после #162 отключает response buffering/compression/cache, проверяет
  auth до SSE headers, пропускает `Last-Event-ID`, не применяет 5s API deadline;
  nginx admission 512 streams совпадает с gateway; это защитный ceiling,
  а не число покупателей или штатная когорта оператора;
- graceful shutdown 20s: перестать принимать connections, отправить
  `stream-reset`, закрыть sockets, затем consumer.

Дополнительно #12 фиксирует process-wide queue budget, RSS/FD/container memory
и admission limits в `config/platform.yaml` с проверкой schema. Per-client maxima
не заменяют совокупный бюджет: при его исчерпании slow connections закрываются,
новые получают 503 до headers. Значения подтверждаются указанным ниже soak test.

Текущие явно заданные бюджеты `services.realtime-gateway.realtime`: совокупная
queue не более 262144 records / 67108864 bytes; ring не более 10000 records /
16777216 bytes / 300000ms. Serialized bytes учитываются вместе с количеством,
а dedup/version state ограничен тем же replay window. RSS ceiling процесса и
container memory reference — 536870912 bytes; FD ceiling — 12288; Compose CPU — 2.
Host observer сохраняет raw cgroup v2 `memory.current/max/peak`, `memory.stat`
и `memory.events` отдельно от process RSS и Docker CLI MemUsage. OOM kill event
даёт FAIL даже при ещё работающем master или stale Docker state; failure receipt
сохраняет точную роль и измеренные counters. Недоступное измерение не подменяется
нулём или RSS. Это диагностическая граница, не ослабление container/RSS budgets.
Parser и JSON Schema отклоняют неизвестные/неположительные/чрезмерные значения
и чужую runtime role, включая RSS выше536870912 и FD выше12288. nginx schema
и generator отклоняют SSE admission выше512. Parser дополнительно требует одну stateless replica,
совпадение `concurrency` с `maxConnections` и запас RSS/FD сверх queue/ring.

Reference `nginxTransport.limits` сохраняет `sseAdmissionConnections=512`:
`workerConnections=2048`, API admission 384, auth admission 320. Generator
проверяет минимум `2 × SSE + API + auth + 64` worker slots: downstream и upstream
каждого SSE учитываются отдельно, reserve нужен для health/control/reload.
Согласованный 13 октября 2026 профиль `operator-1`: одна вкладка и один live SSE
subscriber, 100 ACKed metadata invalidations/s для 100 order subjects, 30 минут.
Отдельная prephase устанавливает 512 одновременно живых streams, проверяет
typed preheader отказ 513-го и освобождает всю boundary-когорту до measurement.
Каждая из ролей nginx/realtime сохраняет 2 CPU и 512 MiB container/RSS;
nginx — 16384 FD, gateway — 12288 FD, один native nginx worker, один gateway.
Observer учитывает все процессы и поколения при HUP, не повышая budgets.
Executable isolated-5000 и full-memory override удалены; исторические FAIL и
экспериментальный ADR сохраняют статус и не доказывают новый профиль.
Deployment/production admission остаётся отдельной проверкой #13.
Typed capacity response в `/events` не превращает auth/dependency failure в
доказательство перегрузки и не добавляет retry upstream.

`nginxTransport.tls.bufferBytes=4096` задаёт downstream `ssl_buffer_size`;
schema фиксирует 4096 bytes и отклоняет другой размер или directive injection.
Это write buffer public TLS, не лимит HTTP payload и не размер upstream TLS
buffer. Ни TTL/authentication, ни resource budgets, ни acceptance thresholds не
изменяются; OOM/capacity proof не выводится из наличия этой директивы.

Для `GET /events` сохраняются `proxy_buffering off` и обычный page-sized
upstream response buffer Nginx (4 KiB в этом профиле); отдельного
`proxy_buffer_size` override нет. Отключение proxy buffering не делает этот
буфер header-only: он используется и при чтении тела upstream response.
Публичный TLS transport использует штатный Nginx из закреплённого официального
образа. Полный capacity proof должен подтвердить пригодность принятого бюджета;
отдельная оптимизация времени жизни TLS write allocation не заявляется.

Hub ставит соединение в общую очередь write-pump только один раз и выполняет
не более 64 pumps за проход `setImmediate`; следующая партия отдаёт ход Kafka,
socket I/O и auth timers. Один pump сохраняет bounded batch до 64 frames,
callback/drain ownership и исходный порядок replay/ready/live. Pending write
работа удерживает event loop до исполнения, cleanup удаляет её из очереди.
Coalescer формирует общую подборку кадров один раз, сохраняет порядок для
каждого connection и планирует его pump после постановки всей подборки.
Один encoded Buffer переиспользуется только при совпадении длины и каждого
Frame по identity и позиции; кеш содержит не более одной подборки до 64 кадров
и очищается при закрытии последнего connection, shutdown и destroy.
HTTP chunked framing и TLS выполняются публичным `ServerResponse.write(Buffer)`.
Event-loop p95 снимается между чтениями `/metrics`, после захвата непустого
окна histogram сбрасывается; sample counter накапливает реальные наблюдения.
Пустое окно сохраняет последний измеренный percentile. Preflight samples
не разбавляют следующий нагрузочный интервал.
Метрики `coffee_realtime_scheduled_connections`,
`coffee_realtime_writing_connections` и `coffee_realtime_writing_records`
разделяют очередь ожидающих pumps и кадры, удерживаемые до callback/drain;
общие queue gauges включают обе группы. После cleanup они освобождаются.

Nginx использует закреплённый официальный образ без source patches. Подготовленный
профиль фиксирует resolved image ID; запуск отклоняет его изменение.

`nginxTransport.tls.sessionCacheMiB=4` задаёт bounded shared TLS session cache
`coffee_public_tls` (schema 1–4MiB), `sessionTimeoutMinutes=5` — срок хранения
transport session (schema 1–5 минут). TLS resumption не кеширует authorization:
каждый новый HTTP/SSE request заново проверяет cookie и actor context; actor TTL
и session TTL неизменны. Resumption после HUP и HTTP headroom подтверждаются
отдельным transport proof, а не наличием директив в generated config.
Существующий upstream `realtime_gateway` хранит peer/TLS session state в
shared zone `realtime_tls_state` фиксированного размера 64KiB. Это transport
state, не auth cache; upstream verification, fresh actor context и timeout 1s
не ослабляются. API и auth upstreams этим изменением не затрагиваются.
`services.realtime-gateway.realtime.shutdownGraceMs=20000` используется и при
создании runtime identity, и при bootstrap dependencies; прочие runtime сохраняют
общий `platform.shutdownGraceMs=30000`. Schema и parser отклоняют превышение 20s.

Для одного connection события одного subject coalesce в окне 250ms: оставить
наибольшую ownerVersion, а при равной — последнее по Kafka order. Coalescing не
меняет message id выбранного event.
Replay использует те же исходные live coalescing-окна, не новое окно по времени
reconnect и не объединение всего gap. Raw records/ID остаются в bounded ring для
Last-Event-ID lookup и eviction/reset. На wire отправляются выбранные hints в
Kafka order; snapshot заканчивается sequence, зафиксированной при open. Поздний
live successor за этой границей не заменяет выбранный replay hint. Числовая ссылка
на superseding sequence хранится только в retained record, без второй queue/index.
Общая admission latency по-прежнему включает каждый полученный replay frame.

Queue overflow, write timeout, socket error или abort немедленно удаляет
connection из registry, очищает queue/listeners/timers и закрывает socket.
Медленный клиент никогда не блокирует Kafka consumer или остальные connections.
Write pump уступает I/O после максимум 64 записей непрерывного burst. ID всех
выбранных replay hints сохраняются; отложенный pump отменяется при cleanup connection.

## 7. Frontend

`apps/web/src/browser/app/OrderRealtime.tsx` создаёт один `EventSource` на вкладку/сессию
для same-origin `/events`; credentials идут session cookie через edge. Ручной
Authorization/header actor не создаётся.
`apps/web/src/realtime/order-invalidations.ts` проверяет данные по generated
каноническим `Sse*` JSON Schemas и адресно invalidates/refetches owner queries.

На `resource-invalidated.v1`:

1. runtime schema validate data;
2. принять только `subjectType=order` и valid refs/version;
3. никогда не записывать payload в Order cache;
4. вызвать `queryClient.invalidateQueries({queryKey:['orders','detail',subjectRef],exact:true,refetchType:'active'})`;
5. если cached `OrderCard.projectionVersion >= ownerVersion`, duplicate можно
   пропустить; command `Order.version` для dedup запрещён;
6. refetch response проходит общий monotonic projectionVersion guard #9;
   старый response не заменяет более новую карточку.

При равной `projectionVersion` owner GET может изменить `allowedActions`.
Дополнительно для Confirmed Card текущий валидированный GET допускает
read-time переходы `InSync→OutOfSync`, `InSync→Converging`,
`Converging→OutOfSync`, `OutOfSync→Converging` при неизменных blockers.
Он также допускает вход в `UnknownOutcome` с единственным blocker
`AROMA_UNKNOWN_OUTCOME` и снятие такого перекрытия до обновления публичной
проекции. Допустимый результат снятия —
`PendingObservation|Converging|OutOfSync|Blocked|UnknownOutcome`.
В обоих случаях остальные бизнес-поля Card, AROMA revisions и lastObservedAt
должны совпадать. Singleton blocker сам по себе не доказывает происхождение
перекрытия; разрешение действует только для authoritative owner GET.
Command/replay path сохраняет строгий guard и не снимает перекрытие по
историческому ответу. Равноверсионное восстановление InSync и остальные
расхождения остаются protocol error. SSE payload не подменяет owner GET.

На каждом `stream-ready.v1`, включая первое подключение без Last-Event-ID,
инвалидировать уже существующие Order detail queries и refetch только active.
Это закрывает окно между первоначальным GET и открытием stream, когда hint мог
быть потерян. Gateway отправляет ready после replay и установки live delivery.
Существующий replay path сохраняется; второй reconnect loop не создаётся.

На `stream-reset.v1` инвалидировать только существующие Order detail queries:
predicate key prefix `['orders','detail']`, `refetchType:'active'`. Customer,
Catalog и Pricing queries не затрагиваются.

UI connection indicator: `Подключено|Переподключение|Обновление состояния`;
он не изменяет Order/AROMA state. Native reconnect использует server `retry:3000`;
отдельный retry loop запрещён. После 30s disconnected показать non-blocking
banner и кнопку owner refetch; commands остаются по своим правилам #9.

EventSource закрывается при logout/смене application session. Handlers и refetch
прошлой сессии не могут заполнить новый cache; authority session и очищение
принадлежат #9. Сам статус «Подключено» не доказывает свежесть Order Card.

## 8. Проверки

- event contract/schema/key/version/dedup/out-of-order/quarantine tests;
- auth: no session, wrong permission/audience, forged actor headers, expired
  context и успешный reconnect re-auth;
- wire: exact headers, frames, UTF-8, heartbeat 15s, no business fields;
- Last-Event-ID found replay, malformed/missing/evicted/restart -> reset;
- frontend exact-query invalidation, inactive query no eager fetch, reset prefix
  invalidation и cache update только owner GET;
- duplicates/lower versions, late GET и historical command replay не откатывают UI;
- owner change между initial GET и первым stream-ready перечитывается;
- logout/session switch удаляет EventSource/listeners и отбрасывает late response;
- 512/513 connections, 64/65 records, 256KiB/+1 UTF-8 byte, stalled 5s, abort/shutdown: bounded
  memory и cleanup;
- soak `operator-1`: 1 subscriber, 100 invalidations/s, 100 subjects, 30min; RSS/event-loop/fd budgets
  фиксируются, dropped slow clients не влияют на healthy p95;
- architecture/config/bundle/redaction: no DB, owner runtime/repository, PII,
  provider secret или business payload.

Полный transport-inclusive proof проходит через native nginx/TLS, реальный
Edge authorizer и signed actor receiver, реальный realtime composition и Kafka
broker. Auth fixture может заменить внешний IdP, но не authorizer assertion или
consumer/queue готовыми ответами. До запуска фиксируются source/config/image
fingerprints, hardware, CPU/memory/FD/worker/queue/ring budgets и pass/fail
пороги. Начальные targets #12: healthy invalidation latency p95 ≤1000ms,
gateway event-loop p95 ≤100ms, cleanup ≤10s, shutdown ≤20s, RSS/FD в заданных
ceiling; healthy клиенты не теряют незамещённые coalescing hints молча. Это
заданные условия проверки, не уже измеренные результаты. Profile отдельно
учитывает обязательную expiry/re-auth, slow clients, reconnect/reset, 513-й
request и concurrent API/auth/health/reload/drain. Auth expiry нельзя продлевать
ради soak. Сокращённый профиль или mock PASS не доказывает operator-1/100/s/30min;
production promotion/admission остаётся отдельной приёмкой #13 и владельца.

### Настоящий owner → served browser путь

После G14, в G15 до итогового допуска проверяются три отдельных обязательных
сценария существующей owner/browser вертикали. G15 запускает их последовательно
после очистки основного browser runtime с проверенным OIDC-only child context;
отсутствие любого proof, hashes или cleanup блокирует G15.
Для G15 и nested fixture harness заранее задаётся `TMPDIR` в declared
scratch вне repository; локальная проверка использует
`TMPDIR=/home/yurgusev/.hermes/cache/scratch`. Отсутствующий `TMPDIR` не меняет
CLI guard: результат в обычном `/tmp` не считается declared scratch.
Основной `positive` использует обычный frozen transport без изменения compiled
runtime или HTTP framing. Только явно выбранный `private-eof` в изолированном
test snapshot однократно обрывает B перед blank-line delimiter, чтобы проверить
native reconnect с Last-Event-ID A и replay B. Его original/transformed hashes
фиксируются отдельно; этот отрицательный proof не доказывает обычный transport.
Сценарий `reauth` использует тот же unmodified frozen transport и одну настоящую
native EventSource вкладку. При действующих actor TTL60s/authCheck30s ожидается
естественный server auth-close; текущая OIDC cookie остаётся действительной,
без ручного login/refresh/reconnect. Gateway metric подтверждает ровно один
auth-close, браузер — новый авторизованный `/events` с200 и прежним Last-Event-ID,
второй stream-ready и успешный owner GET с монотонной projectionVersion при
неизменных business version, stored Card и Outbox. При устаревшем Observed
повторный GET возвращает `OutOfSync` с прежней projectionVersion; UI принимает
его и показывает «Есть расхождение». Receipt сохраняет semantic summary до
и после expiry. EventSource instance остаётся одной;
reauth functional window не превышает существующий smoke limit120s.
Все три сценария сверяют весь source manifest до выдачи receipt; compiled
manifest `positive`/`reauth` неизменен, у `private-eof` допустим только указанный
однофайловый transform. PASS одного сценария не заменяет остальные или full soak.
Он переиспользует existing isolated PostgreSQL/migrations и native transport
composition. Fixture подготавливает исходные Orders и provider facts; настоящий
preparation store изменяет owner projection и atomic Outbox. Native
`createKafkaRuntime.relay` читает persisted envelope через `createSqlOutboxStore`,
получает broker ACK и только затем переводит запись в `Published`. Несколько
последовательных versions одного aggregate draining-ятся отдельными relay cycles,
без обхода FIFO, leases и ACK semantics. Публикуется только owning realtime topic;
неотносящиеся provider commands остаются вне этого proof.

Production SPA строится canonical `edge-nginx` target. Browser использует настоящий
EventSource через nginx → Edge authorizer → realtime receiver. Owner GET проходит
api-public delegation, настоящий owner mTLS/HTTP handler и `OrderStore` на runtime
DB role, а не mocked response или постоянный 404. Проверяются exact persisted
messageId в metadata-only frame, новый GET, возрастающий `projectionVersion`,
неизменный command `Order.version` и переход UI/owner Card `OutOfSync` → `InSync`.
OIDC session cookie получен настоящим Edge login против synthetic IdP; event и GET
не подменяются browser interception. Наблюдатель EventSource не создаёт frames.

В той же вертикали повторно отправляются только неизменённые уже сохранённые
envelopes: текущий duplicate и старый owner version. Negative sender переиспользует
native producer; он не создаёт новых owner facts и не переписывает Outbox. Broker
ACK и committed offset exact partition подтверждают обработку каждого replay,
а не только его отправку. После graceful realtime SIGTERM/exit 0 и start настоящий
EventSource приносит `stream-reset.v1` и вызывает owner GET. Current/older replay
не вызывает дополнительных GET, Card и owner Outbox не меняются. Старый envelope
сохраняет прежний messageId: этот case доказывает безопасную stale retransmission,
но не изолирует lower-version guard от dedup; независимый lower-version guard
проверяется соответствующими contract/hub/browser unit tests.

Result, metadata receipt, native image digest/source hashes и screenshot остаются
в declared scratch. Isolated runtime, owned containers/network, auxiliary role
material и image удаляются. Это single-browser proof для material AROMA change,
duplicate/stale retransmission и одного native restart/reset, не full Orders/AROMA
composition, native upstream provider pipeline, Draft/item-edit emission, полная
failure/recovery matrix или capacity/production admission.
Owner cleanup handle регистрируется до startup side effects: ошибка startup
не теряет ownership и не заменяется ошибками teardown. Все cleanup stages
проверяются, secondary failures сохраняются в receipt и запрещают verified cleanup.
Ошибки чтения browser GET body перехватываются сразу и запрещают verified proof.
До receipt собираются observations, закрывается browser context, снимается response
listener и завершаются все captured body tasks; новый async browser read после
финальной проверки не может открыть окно для ложного verified receipt.
Business helper запрещён в full mode; `owner-browser-not-capacity-proof` никогда
не получает `launchProof=true` и не заменяет правила ниже.

### Отдельная owner-командная волна

`COFFEE_DB_LIVE_PROOF=1 node --test --test-concurrency=1 --test-name-pattern='owner peak 100' tests/orders/owner-live.test.mjs`
проверяет 100 одновременно начатых потоков заказов, один заказ и 10 позиций на поток,
через настоящие Orders routes/application/OrderStore/PostgreSQL/Outbox.
Все команды используют одну операторскую identity; 100 потоков не создают
100 браузерных пользователей или SSE подписчиков.
Synthetic Customer/Pricing/auth остаются test seams: это не public ingress,
VK/Agent/LLM E2E и не обещание 100 orders/s или capacity всей платформы.

По уточнению владельца от 14 октября 2026 каждый запрос peak-сценария
выполняется один раз: тестовые повторы `503` удалены. Orders использует
ограниченное ожидание checkout по [владеющему DB contract](05_DATA_OWNERSHIP.md):
pool max4, maxWaiting100, owner deadline5000ms включая admission и
checkout250ms на подключение после выдачи слота.
Успех требует 100 завершённых flows, 1400 успешных ответов без отказов,
нулевого saturation и освобождённых pool/queue/pending после волны. Receipt
фиксирует concurrency, все команды/отказы, elapsed, throughput и p50/p95/p99.
Независимые DB assertions требуют ровно 100 durable orders, 1000 items и
единственные history/Outbox/idempotency effects. Отдельный exact/bodyless replay
проверяет восстановление потерянного ответа COMMIT с тем же ключом; это не
автоматический повтор mutation. Browser retry policy и provider safety не меняются.
PUT использует один read-only `preflightPut` для idempotency и полного Card
read, затем Pricing вне соединения и отдельную атомарную запись. Это два
checkout вместо трёх на PUT; условия replay, validation и повторной проверки
version при записи сохраняются. Диагностические observations не выполняют
дополнительные бизнес-запросы и не меняют shared correlationId профиля.

Preparation cardinality проверяется отдельно: 100 contributions × 10 lines и
сохранённый 100×100 regression, оба с неизменным recompute budget 2s.
Seeded cardinality не доказывает командный throughput; FAIL любого regression
сохраняется как FAIL, а не скрывается новым меньшим профилем.

### Capacity и обязательный re-auth в load profile

TTL signed actor остаётся ≤60s; auth sweep и wire `retry: 3000` не обходятся.
В приёмке раздельно фиксируются boundary population 512 и preheader отказ
513-го request, её cleanup и затем 30min нагрузки 100 ACKed invalidations/s
для одной вкладки/одного subscriber и 100 order subjects со штатным reconnect.
Это не обещание непрерывно открытого TCP/SSE socket: raw `minLive`,
`maxLive`, число разрывов и reconnect сохраняются без обнуления или подмены.

Каждый client должен хотя бы один раз получить fresh admission после expiry.
Load generator сохраняет `Last-Event-ID`, ownerVersion maximum и проверяет replay;
reset без наблюдаемого owner refetch не считается успешным recovery. Fixture
reconnect loop не является вторым retry loop production browser: browser по-прежнему
использует native EventSource. Общая invalidation p95 остаётся ≤1000ms, включая
поздние live и replay frames. Coverage checkpoint фиксирует ACKed ownerVersion
maxima и сначала проверяет их через 1s. Недоставленные maxima остаются pending:
поздняя равная или большая версия закрывает ожидание, не исключаясь из latency
histogram. Все checkpoints должны завершиться в общем verification bound 14s
от отправки checkpoint (wire retry 3s + establishment 10s + первое ожидание 1s).
Этот bound ограничивает ожидание полноты тестом, а не задаёт допустимую latency
каждого hint и не продлевает re-auth deadline. Незавершённая проверка даёт
`COVERAGE_UNAVAILABLE`, а превышение p95 независимо запрещает PASS. Прежнее
немедленное объявление потери на первом 1s snapshot смешивало percentile и
полноту; из такого snapshot фактическая потеря не следует.

Для каждого gap записываются реальные close/ready timestamps и новые connectionId;
browser session сохраняет TTL 15min. Load generator повторяет настоящий OIDC
login каждые 10min для того же synthetic actor и передаёт fresh cookie worker-ам;
это не продление session и не новая функция production browser. Успешные logins
сохраняются отдельными receipts; full profile требует не менее двух за main interval.
gap p95/max и число recovered clients обязательны. Deadline восстановления состоит
из wire retry 3s и уже существующего establishment deadline 10s, не из продления
actor TTL. `coffee_realtime_auth_close_total` подтверждает причину закрытий;
наблюдённые auth closes и client disconnects обязаны совпасть в согласованном
snapshot. Unexpected/pressure close, незавершённое восстановление, отсутствие
reauth любого client, silent hint loss или превышение budget дают FAIL. Full
result без этих receipts, короткий smoke и один boundary peak не являются launch proof.

Shutdown проверяется на том же живом cohort после финального coverage/re-auth
snapshot. Workers подтверждают готовность, сохраняя sockets и отключая reconnect;
driver сверяет client population и gateway metric перед SIGTERM. Каждый client
обязан получить настоящий `stream-reset.v1`, затем server close. В receipt
сохраняются connectionId и фактические timestamps reset/close; закрытие без reset,
пустая группа, ошибка worker, timeout или принудительный client close дают FAIL.
Остановка уже пустого gateway не подтверждает loaded drain. Observer work
завершается до удаления fixture resources; ошибка измерения сохраняет FAIL.
После `finish` SSE response gateway завершает его mTLS socket через `end()`:
доставленный reset не должен оставлять idle keep-alive transport и удерживать
`server.close()` до shutdown deadline.
Hub завершает ожидание drain на первом `finish` или `close` response и удаляет
оба completion listener: успешно завершённый terminal write не должен ждать
закрытия write side peer. Stalled write по-прежнему ограничен write timeout.

`tests/realtime/soak.test.mjs` — explicit-only transport CLI, не автоматический
`node:test` suite; обычный `pnpm test` исключает этот файл и **не** доказывает
capacity. Nested `fixtures/harness.test.mjs` включён в обычный test target;
его CLI/config/manifest/cleanup regressions не запускают full soak.
CLI требует сначала создать operator-1 профиль через
`--prepare --profile operator-1 --result-dir <scratch>`, проверить
`profile-manifest.json`, затем явно передать `--prepared <scratch>` и его
`--approve-manifest <sha256>`. Короткие `--smoke` и `--fixture-check` дают только
свой scope evidence. Полный target и TTL/auth ограничения нельзя ослаблять,
а отсутствие выполненного полного прогона сохраняет capacity acceptance открытым.

## 9. Не входит

WebSocket, GraphQL subscriptions, persistent replay DB, per-order client
subscription filters, business projection, commands over SSE, multi-tenant
authorization projection и guaranteed event delivery to browser не входят.
