# Восстановление команд браузера первого запуска

Статус: нормативное уточнение #119 для contracts #4, Customer #5, Pricing #7,
Orders #8, Frontend #9 и acceptance #13. Runtime handlers создают эти owners
после своих prerequisites. Этот документ не означает их реализацию.

## 1. Проблема и решение

Ответ на POST Customer, Draft или PricingQuote может потеряться после commit,
когда браузер ещё не знает resourceRef. Поиск по имени/телефону и отсутствие
строки в карточке не доказывают исход конкретного intent. Browser хранит только
метаданные intent, поэтому после reload исходный body тоже может отсутствовать.

Все семь browser commands из [HTTP каталога](03_HTTP_API_CONTRACT.md) принимают
явный режим `Idempotency-Replay-Only: true`. Это read-only lookup уже принятого
intent через тот же owner endpoint, а не повтор команды. Новый API endpoint,
таблица, process, retry framework или общий журнал не создаются.

Семь commands: создание Customer, создание PricingQuote, создание Draft,
PUT item, DELETE item, Confirm и request-aroma-reconciliation. Это точная
allowlist; provider/internal endpoints данный header не принимают.

## 2. Wire и доверие

- Обычный режим: header отсутствует; действуют прежние обязательные body,
  expectedVersion и `If-Match-Version` для DELETE.
- Read-only режим: header имеет ровно `true`, `Idempotency-Key` обязателен,
  HTTP method и concrete path совпадают с исходной командой; request body
  отсутствует. `If-Match-Version` не передаётся: новая команда не выполняется.
- Любое другое значение header, body bytes или `If-Match-Version` в read-only
  режиме — `400 VALIDATION_FAILED`. Validation не вызывает acquire/effect.
- Edge/api-public пропускают header только для семи client-v1 commands. Actor
  по-прежнему создаётся server middleware, никогда не читается из storage/body.
- Owner требует текущую авторизацию исходной команды и доступа к её resource,
  transport/delegation audience, scope и actor. При отозванном доступе старый
  response не возвращается. Key другого actor не раскрывает его результат.
- Identity lookup совпадает с original command identity `(actorRef,scope,key)`.
  Для всех семи commands `scope = lowercase hex SHA-256(UTF-8(method + "\n" +
  canonicalPath))`, где method uppercase, canonicalPath — literal `/api/client-v1`
  path с валидированными concrete refs, без origin/query/trailing slash. Scope
  всегда 64 ASCII символа и одинаков для обычного и read-only режима.
  #4 предоставляет golden vectors; #5/#7/#8 используют этот scope в owner migrations
  вместо старых произвольных operation labels/route_key. Это pre-implementation
  уточнение, не миграция уже работающей бизнес-БД.
  UUID не становится глобальным capability для чтения чужих данных.
- Новый browser fingerprint не сравнивается с нормализованным owner request hash:
  body отсутствует и это не команда. Identity и текущая авторизация обязательны.

#4 описывает header и оба режима в существующем OpenAPI operation, переиспользуя
его response schemas. Request body формально optional только ради read-only
ветки; route validation ОБЯЗАНА отклонять bodyless обычный POST/PUT. Cross-field
header/body/version constraints проверяются одинаково на api-public и owner,
с positive/negative golden fixtures. Types-only generation не считается
доказательством проверки этих условий во время исполнения.

## 3. Owner lookup

Read-only ветка выбирается до command acquire и до текущей проверки версии,
quote expiry, Catalog reads, Customer snapshot или AROMA reconciliation enqueue.
Owner использует read-only `IdempotencyStore.get` accepted #62 в собственной
БД. Это не новый foundation API и не межвладельческий SQL.

| Durable запись | Результат lookup | Действия браузера |
|---|---|---|
| `Completed`, сохранённый response доступен в retention | `Idempotency-Replayed: true`, сохранённые terminal HTTP status и schema-valid body; новый correlation header относится к текущему lookup | Закрыть pending intent; принять response по правилам актуальности ниже |
| `Acquired`, включая expired lease | `409 IDEMPOTENCY_REQUEST_IN_PROGRESS` | Сохранить key, предложить повторную проверку состояния |
| Запись отсутствует или Completed response больше не хранится | `410 IDEMPOTENCY_RESULT_NOT_RETAINED` | Оставить unresolved intent, показать необходимость owner recovery; не создавать новый key автоматически |
| БД недоступна/lookup неоднозначен | `503 IDEMPOTENCY_LOOKUP_UNAVAILABLE` | Сохранить pending intent; проверить позже явным действием |
| Повреждённый Completed/невалидный stored response | `500 IDEMPOTENCY_RESULT_INVALID` | Сохранить pending intent; безопасная ошибка и correlation id, без raw body |

`Idempotency-Replayed: true` возвращается только для успешно прочитанного
Completed record, включая сохранённый terminal business rejection. На ошибках
самого lookup этого header нет. #9 закрывает intent по этой комбинации
header + валидный terminal response, а не по HTTP status lookup. Успешный 2xx
lookup без marker считается protocol error и сохраняет pending intent.

Результат lookup всегда имеет `Cache-Control: no-store`. При lookup не
сохраняются заново status/body, lease или retention; нет acquire, takeover,
complete, provider call, business audit/event/Outbox write. Допустима обычная
редактированная telemetry текущего HTTP запроса без key/body/PII.

`410` не доказывает отсутствие эффекта: запись могла быть удалена после
retention, а business object сохранён. Истечение Acquired не является
разрешением retry. Владельцы #5/#7/#8 применяют принятую #62 outcome/recovery
семантику; старые инструкции автоматического lease takeover не действуют.

Сохранённый Customer/Draft response обязан содержать исходный resourceRef.
PricingQuote может уже истечь: lookup возвращает факт старого результата,
а новый quote создаётся только новым явным intent после его разрешения.
`202 ReconciliationAcceptedResponse` означает принятую reconciliation-команду,
а не завершённую синхронизацию AROMA; после него браузер делает Order GET.

## 4. Browser intent

`api/idempotency.ts` хранит versioned sessionStorage record только с `key`,
allowlisted method/concrete path, canonical browser fingerprint, createdAt,
state и с #159 — server-derived `actorRef` из точного защищённого
`GET /auth/session`. Storage key строится по UUID intent, а не неизвестному
resourceRef. Перед отправкой новой команды #9 получает текущий actorRef через
no-store session status; недоступный/401 status не разрешает команду без
доверенной привязки intent. Browser storage не предоставляет полномочия:
Edge/owner повторно проверяют actor и permissions на каждом запросе.
Customer/Pricing/Draft не требуют resourceRef до первого успешного ответа.
Body, contact details, цены, quote payload и credentials не сохраняются.
Fingerprint нужен для проверки exact payload при явном обычном повторении
в живой форме; fingerprint не позволяет восстановить payload после reload.

- Перед command отправкой записать intent; duplicate click не создаёт второй.
- Definitive command success/business rejection завершает intent.
- `IDEMPOTENCY_REQUEST_IN_PROGRESS`, network/timeout, неизвестный 5xx и ошибки
  lookup остаются non-terminal. Классификация по protocol code/mode, не `status < 500`.
- Ambiguous command предлагает «Проверить результат команды»: один явный
  read-only запрос с прежним key/path/method, без body и automatic retries.
- После reload восстановить только валидные метаданные и показать pending intent;
  lookup запускается по кнопке, не on mount.
- Неизвестное/повреждённое storage не используется как URL/команда. Показать
  «Данные восстановления недоступны», не выдавая очистку за отсутствие эффекта.
- Возраст записи сам по себе не разрешает новую команду. Открытый unresolved
  intent сохраняется до terminal результата; при исчерпанном retention остаётся
  инструкция owner recovery, а не кнопка повторной отправки с новым key.
- Проверка owner GET для известного orderRef полезна для текущего экрана, но
  похожее состояние не считается доказательством завершения данного intent.
- Явный повтор исходной mutation возможен лишь при сохранённом exact payload,
  разрешённом owner recovery и прежнем key; read-only lookup сам такого
  разрешения не предоставляет. Unsafe AROMA retry отсутствует всегда.

Обычный 400 validation до выполнения завершает данный запрос; 401/403 блокирует
доступ, но сам по себе **не** подтверждает исход ранее отправленного ambiguous
intent. На 401/session expiry #9 немедленно скрывает private cache и формы,
отменяет reads, #12 закрывает EventSource. Метаданные уже отправленного
unresolved intent остаются в этой вкладке **заблокированными** до reauth,
без отправки команды, автоматического lookup или отображения private данных.
Если повторный `GET /auth/session` после login возвращает того же actorRef,
оператор может **явно** запустить существующий bodyless replay-only lookup с
прежним key/method/path, новым session CSRF header и без `If-Match-Version`;
owner заново проверяет actor/scope/permissions. Новый actorRef, потеря
метаданных, 401/403 при lookup или невозможность доказать привязку → никакого
replay; показать неизвестный исход и owner recovery, очистить прежнюю private
metadata перед работой нового пользователя. Отсутствие metadata не означает,
что исходная команда не выполнилась. При явном logout/смене пользователя #9
предупреждает об unresolved intent, затем очищает query/mutation cache, формы
и sessionStorage metadata; #12 закрывает EventSource. Pending intent никогда
не переносится к новому actor и не исполняется автоматически. Потеря
вкладки/storage требует owner recovery. Server-side auth/CSRF/session issuance
не заменяются browser checks; клиентский actorRef — только guard приватности.

## 5. Актуальность Order Card

Любой GET, command response или replay проходит runtime validation и один
owner-specific порядок принятия в существующий QueryClient:

1. Проверить exact orderRef и текущую application session; ответ отменённой или
   предыдущей сессии не попадает в cache.
2. Сравнить только `OrderCard.projectionVersion` как bigint-safe decimal.
3. Меньшая версия не заменяет большую; равная идентичная карточка — no-op.
   Равная версия с иным содержимым карточки — protocol error и явный owner refetch.
   Transport correlation metadata в сравнение карточки не входит.
4. Большая версия полностью заменяет карточку. Смешивания полей двух response нет.
5. После Completed lookup с OrderCard выполнить exact owner GET: historical replay
   подтверждает результат intent, но не обещает актуальное состояние заказа.

Команды используют только `Order.version` последней принятой карточки. Ни
монотонный cache, ни `allowedActions` не заменяют server version/permission check.
Перед mutation отменить старый query; cancellation не заменяет version guard.
При временной ошибке повторного GET, например 503, сохранить карточку с явным
признаком недоступной проверки, не показывая исторический replay как подтверждённое
текущее состояние. Отказ 403 или отсутствие ресурса 404 должны попасть в exact
Order query: cached карточка и действия скрываются по route-fatal guard.

## 6. Handoffs и обязательное доказательство

| Issue | Реализуемый output |
|---|---|
| #4 | Header/body/version constraints, typed errors и runtime fixtures семи operations |
| #5 | Customer read-only lookup и сохранённый CustomerResponse, без повторного создания |
| #7 | Pricing lookup, включая истёкший quote; новый quote не создаётся lookup |
| #8 | Пять Orders operations и exact scoped lookup; сохранённая карточка/accepted response |
| #9 | Pending intent до resourceRef, actor binding через `GET /auth/session`, expiry/401 freeze, explicit same-actor bodyless recovery, terminal classifier и monotonic cache |
| #12 | Первичная синхронизация/refetch после открытия SSE, та же cache/session policy |
| #13 | Потерянные ответы Customer/Draft/Quote, reload, owner restart и отсутствие дублирующих эффектов |

Обязательные tests расширяют существующие targets соответствующих задач:
bodyless normal command rejected; replay-only с body/version rejected; Completed
replay без owner writes; active/expired Acquired; missing/expired result; DB
unavailable; invalid stored response; forged actor/scope/path; revoked permission;
PII/key redaction; reload до resourceRef; repeated check без второго эффекта;
старый GET/replay после новой карточки; ответ предыдущей сессии; accepted
reconciliation не отображается как InSync. Дополнительно #9/#13 проверяют:
401 после отправленного intent не превращается в terminal result; reauth того
же actor разрешает только явный read-only lookup; другой actor и lost metadata
не получают прежний result и требуют owner recovery; logout чистит metadata.
