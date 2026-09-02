# Исполнимая спецификация realtime SSE

Технический путь: Effect Stream через typed Kafka adapter и AtomHttpApi browser
invalidation; SSE остаётся transport-only и не становится business state.

Статус: нормативная спецификация issue #12. Исполнитель не выбирает replay,
authorization, fanout limits, AtomHttpApi invalidation или slow-client policy заново.

## 1. Архитектура

```text
owner transaction + Outbox
  -> Kafka RealtimeInvalidated.v1
  -> realtime-gateway consumer
  -> bounded in-memory replay/fanout
  -> private GET /events origin
  -> edge authenticated same-origin GET /events
  -> browser EventSource
  -> AtomHttpApi invalidate/refetch owner GET
```

`realtime-gateway` не читает owner events напрямую: consumer принимает только
`RealtimeInvalidated.v1`. Он не имеет БД, business cache или owner HTTP client.

## 2. Kafka consumer

- topic `coffee.realtime.invalidate.v1`, key=`subjectRef`;
- group `realtime-gateway-<replica-id>`;
- auto topic creation/auto commit запрещены;
- validate JSON Schema/envelope before use;
- поддерживается только `subjectType=order` в первом запуске;
- unknown type/schema -> quarantine/DLQ, не fanout;
- duplicate `messageId` в локальном replay window -> no-op;
- для одного subject событие с ownerVersion меньше/equal уже принятой версии не
  fanout, кроме equal+different payload, которое quarantine;
- offset commit после помещения события в ring buffer и fanout queues. Потеря
  in-memory события при crash безопасна благодаря reconnect reset/refetch.

## 3. Авторизация `GET /events`

Public route существует только на edge. Edge проверяет session/JWT, удаляет
client `X-Actor-*` headers и передаёт подписанный trusted actor context с
`actorRef`, permissions, expiry и audience `realtime-gateway`.

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

- сразу после connect: `event: stream-ready.v1`, data содержит только
  `connectionId`, `connectedAt`; `id` отсутствует;
- если replay невозможен: `event: stream-reset.v1`, data
  `{reason:"REPLAY_UNAVAILABLE"}`; `id` отсутствует;
- heartbeat каждые 15s — SSE comment `: heartbeat <RFC3339>`, не event и не id.

## 5. `Last-Event-ID` и replay

Каждый instance хранит ring buffer максимум 10 000 invalidations и максимум 5
минут; срабатывает первый лимит. Business state там нет.

При connect:

1. header отсутствует -> `stream-ready`, новые events;
2. valid ID найден в local ring -> replay subsequent events по порядку, затем live;
3. ID malformed или не найден (restart/другой replica/eviction) ->
   `stream-reset.v1`, затем live;
4. query parameter `lastEventId` запрещён; используется стандартный header.

Replay — оптимизация, не гарантия доставки. `stream-reset` требует безопасный
owner refetch и поэтому не нуждается в sticky session/persistent replay DB.

## 6. Fanout и backpressure

Лимиты одного instance:

- максимум 5 000 active connections; следующая получает `503
  REALTIME_CAPACITY_EXCEEDED` до SSE headers;
- per-connection queue: максимум 64 records или 256 KiB serialized, первый
  достигнутый лимит;
- socket write deadline 5s;
- max event data 2 KiB; больше -> quarantine producer event;
- heartbeat 15s; edge idle timeout минимум 45s;
- graceful shutdown 20s: перестать принимать connections, отправить
  `stream-reset`, закрыть sockets, затем consumer.

Для одного connection события одного subject coalesce в окне 250ms: оставить
наибольшую ownerVersion, а при равной — последнее по Kafka order. Coalescing не
меняет message id выбранного event.

Queue overflow, write timeout, socket error или abort немедленно удаляет
connection из registry, очищает queue/listeners/timers и закрывает socket.
Медленный клиент никогда не блокирует Kafka consumer или остальные connections.

## 7. Frontend

`apps/web/src/realtime/order-invalidations.ts` создаёт один EventSource на tab
для same-origin `/events`; credentials идут session cookie через edge. Ручной
Authorization/header actor не создаётся.

На `resource-invalidated.v1`:

1. Effect Schema validates data at runtime;
2. принять только `subjectType=order` и valid refs/version;
3. никогда не записывать payload в Order cache;
4. инвалидировать exact `orderDetailAtom(subjectRef)` и запустить активный
   refetch owner GET;
5. если cached `OrderCard.projectionVersion >= ownerVersion`, duplicate можно
   пропустить; command `Order.version` для dedup запрещён;
6. refetch response owner GET полностью заменяет cache.

На `stream-reset.v1` инвалидировать только существующие Order detail atoms и
запустить их активный refetch. Customer, Catalog и Pricing atoms не затрагиваются.

UI connection indicator: `Подключено|Переподключение|Обновление состояния`;
он не изменяет Order/AROMA state. Native reconnect использует server `retry:3000`;
отдельный retry loop запрещён. После 30s disconnected показать non-blocking
banner и кнопку owner refetch; commands остаются по своим правилам #9.

## 8. Проверки

- event contract/schema/key/version/dedup/out-of-order/quarantine tests;
- auth: no session, wrong permission/audience, forged actor headers, expired
  context и успешный reconnect re-auth;
- wire: exact headers, frames, UTF-8, heartbeat 15s, no business fields;
- Last-Event-ID found replay, malformed/missing/evicted/restart -> reset;
- frontend exact Order atom invalidation, inactive atom no eager fetch, reset
  invalidation существующих Order detail atoms и cache update только owner GET;
- duplicates/lower versions не откатывают UI;
- 5 001 connections, 65 records, >256KiB, stalled 5s, abort/shutdown: bounded
  memory и cleanup;
- soak: 5 000 connections, 100 invalidations/s, 30min; RSS/event-loop/fd budgets
  фиксируются, dropped slow clients не влияют на healthy p95;
- architecture/config/bundle/redaction: no DB, owner runtime/repository, PII,
  provider secret или business payload.

## 9. Не входит

WebSocket, GraphQL subscriptions, persistent replay DB, per-order client
subscription filters, business projection, commands over SSE, multi-tenant
authorization projection и guaranteed event delivery to browser не входят.
