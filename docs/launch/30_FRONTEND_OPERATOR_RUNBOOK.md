# Эксплуатация операторской SPA первого запуска

Статус: локальная реализация issue #9; этот документ не объявляет deployment или production-приёмку.

## 1. Сборка и запуск

Из корня репозитория:

```sh
pnpm install --frozen-lockfile
pnpm web:build
pnpm browser:bundle:check
pnpm dev:browser
```

`dev:browser` предназначен для локальной проверки UI. Production-like static artifact
собирается в `apps/web/dist/browser` и включается в native nginx image через
`apps/edge-nginx/Dockerfile`. API, `/auth/*` и `/events` остаются same-origin через
nginx; отдельный Node server для SPA не запускается.

## 2. Маршруты

- `/` — HTTP redirect nginx на `/app/customers`;
- `/app/customers` — поиск и создание клиента;
- `/app/catalog?orderRef=...&q=...&availability=...&cursor=...` — поиск persisted Catalog в контексте редактируемого Draft;
- `/app/orders/new?customerRef=...` — явное создание Draft;
- `/app/orders/:orderRef` — server-owned Order Card, позиции, Confirm и AROMA state.

Для `/app/*` nginx использует fallback на `/index.html`, поэтому refresh deep link не
должен давать 404. Не добавлять route, которого нет в `docs/launch/18_FRONTEND_IMPLEMENTATION_SPEC.md`.

## 3. Авторизация и server truth

SPA начинает работу с `GET /auth/session`. При `401` показывается переход на
`/auth/login?returnTo=<локальный route>`, при `503` — отдельное fail-closed
состояние «Не удалось проверить сессию» с ручным повтором. `403` business API
не сбрасывает подтверждённую сессию: UI показывает «Недостаточно прав» для
конкретного ресурса или команды.
Actor identity берётся только из server-derived session. Browser не хранит bearer
credentials и не выбирает actor identity.

Непосредственно перед каждой business mutation browser выполняет uncached
`GET /auth/session` и сверяет `actorRef` с открытой application session. При смене,
истечении или недоступности сессии команда останавливается до создания intent и
приватный query/mutation state прежнего оператора очищается.

CSRF текущей browser session захватывается до fresh-session проверки и обязан
остаться неизменным после неё и после асинхронного создания intent. В команду и
replay отправляется только захваченное значение. Если application session или
CSRF изменились до фактической отправки, browser удаляет ещё не отправленный intent,
инвалидирует приватную границу и не выполняет owner request.

Явный выход выполняется через `POST /auth/logout` с текущим CSRF. Если в
`sessionStorage` есть незавершённые команды, UI предупреждает об удалении recovery
metadata. При смене `actorRef` приватный query cache и формы прежней сессии
размонтируются, чужая recovery metadata удаляется, а новый оператор получает
предупреждение о необходимости owner-side проверки результата.

Все API-вызовы проходят через `apps/web/src/browser/api/client.ts`. Browser отправляет
cookie credentials same-origin, а для mutation — `X-CSRF-Token` из защищённого
same-origin cookie. Отсутствие CSRF блокирует команду до `fetch`. Mutation использует
`networkMode: "always"`, поэтому offline-нажатие завершается ошибкой и не образует
очередь, автоматически исполняемую после reconnect. Ответ принимается только после runtime validation
по generated schemas; malformed response показывается как protocol error и не попадает
в cache. Для Problem Details HTTP status обязан совпадать с `problem.status`;
расхождение считается protocol error и не переводит pending intent в terminal outcome.

`Order.version` используется только как expected owner version. UI принимает GET или
command result для Order Card только если `projectionVersion` не меньше уже показанной.
Действия показываются и разрешаются только по `allowedActions`.

## 4. Неопределённый исход команды

Перед каждой business mutation вкладка сохраняет в `sessionStorage` metadata intent:
actorRef, route, method, idempotency key, request fingerprint, kind и время. Payload,
credential и произвольный URL в записи не сохраняются.

Если response потерян, получен нетерминальный 5xx или transport error:

1. не создавать новый `Idempotency-Key`;
2. не повторять effect автоматически;
3. browser повторно без cache запрашивает `/auth/session` и продолжает только при том же `actorRef`;
4. нажать **«Проверить результат команды»**;
5. browser отправит только исходный method/path и заголовки
   `Idempotency-Key` + `Idempotency-Replay-Only: true`, без request body;
6. принять terminal result только с `Idempotency-Replayed: true` и валидным schema.

`401`, `403`, `IDEMPOTENCY_CONFLICT`, `IDEMPOTENCY_REQUEST_IN_PROGRESS`, `410`,
malformed replay, неизвестный 4xx-код и временный `5xx` не доказывают исход эффекта.
Запись остаётся pending. Terminal rejection определяется allowlist известного
protocol-кода, а не всем классом 4xx. Replay разрешён только после re-auth того же
server-derived actor.

Каждый запрос получает новый `X-Correlation-ID`. Browser публикует локальный
redacted event `coffee:browser-telemetry` с именами `ui.query.result`,
`ui.command.result` или `ui.recovery.result`, нормализованными route/endpoint,
категорией результата и duration. Payload, контакты, цены и owner refs в событие не
попадают; внешний collector этим runbook не объявляется.

## 5. `UnknownOutcome` и AROMA

`UnknownOutcome` относится к состоянию owner Order Card. UI не показывает blind retry
provider mutation. Допустимы только:

- refetch текущей Order Card;
- owner action `request-aroma-reconciliation`, если оно присутствует в
  `allowedActions`;
- отображение owner-provided blocker/reason.

Browser не обращается к AROMA напрямую и не интерпретирует SSE/event payload как
business truth.

После принятого `202` reconciliation dialog закрывается и повторная отправка той же
команды не предлагается. Exact GET текущей Order Card выполняется отдельно:
ожидание, ошибка или прежняя `projectionVersion` сохраняют локальную блокировку.
Она снимается после принятия более новой owner-проекции; следующая сверка доступна
только при разрешающем состоянии и `request-aroma-reconciliation` в `allowedActions`.
Оператор открывает новый dialog и явно отправляет новый intent; автоматического
POST нет. `Order.version` остаётся expected version команды и не сравнивается с
`projectionVersion`. Replay response не подменяет результат owner GET в current-state cache.

## 6. Проверка перед поставкой

Минимальный локальный набор:

```sh
pnpm typecheck
pnpm architecture:check
pnpm lint
pnpm web:build
pnpm browser:bundle:check
pnpm test:ui
pnpm test:web-foundation
pnpm test:web-routes
pnpm test:web-queries
pnpm test:web-idempotency
pnpm test:web-accessibility
pnpm test:playwright
pnpm test:web-bundle
pnpm check
```

Browser-набор покрывает create customer → Draft → catalog/quote → item → Confirm,
fail-closed malformed response и CSRF, ambiguous command и replay-only recovery,
same-actor re-auth, actor switch/logout, offline mutation policy, query sharing/retry,
axe serious/critical, deep links и отсутствие горизонтального overflow на
375/768/1280.

## 7. Rollback static assets

Rollback выполняется заменой **всего** immutable nginx image digest на ранее принятый
image digest. Нельзя смешивать `index.html` одной сборки с hashed assets другой,
копировать отдельные JS/CSS поверх running container или откатывать только browser
bundle внутри образа.

После rollback проверить:

1. `GET /health/live`;
2. `/` → `303 /app/customers`;
3. прямой `GET /app/orders/<ref>` возвращает SPA shell, а не 404;
4. `/auth/session` и same-origin API проходят через прежнюю nginx trust boundary;
5. browser не получает старый `index.html` с отсутствующими hashed assets.

Deployment, registry publication и выбор production digest остаются отдельным решением
оператора.

## 8. Публикация #9 и согласованный consumer #11 — 4 октября 2026

Ветка `feature/9-react-operator-flow` основана на accepted
`develop@e278aeb10e57d37485542f8668f078456074b038`. Базовая реализация находится
в локальном коммите `adfca3f9df79a180ce84539c12c956e55c7e3b41`; дополнительно
в ветку перенесены ровно семь проверенных UI files из отдельного integration
checkout #9 + #11. Backend, миграции и public contract changes #11 остаются в
[PR #171](https://github.com/YurGusev/CoffeeOrderPlatform/pull/171), commit
`14ae10ea500adf2e4da4f62fa00a2676ad754503`.

UI предлагает Catalog grindOptions, передаёт optional sourceGrindKeyHash в quote
и PUT и сохраняет его при изменении количества. Card показывает frozen
grindDisplayName. При исчезновении варианта stale selection остаётся видимым,
а явный сброс возвращает omission. PRICING_GRIND_NOT_AVAILABLE завершает intent
без PUT. Validator проверяет dependentRequired hash/displayName. Исправление
CSRF browser fixture проверяет invalidation event и cleanup intent вместо
кратковременного alert; production session flow не менялся.

Fingerprint семи UI files (sorted path + NUL + sha256(file), joined LF):
`98bb2c30774b3e2480caebbd19c21a26996fda7a044b9cbbcc7c995e72c5e232`.
Он совпадает с integration source, для которого ранее получены:

- `pnpm test:web-queries`: 15/15 PASS;
- `pnpm test:web-routes`: PASS;
- `pnpm test:web-idempotency`: 6/6 unit и browser group PASS;
- `pnpm test:web-accessibility` и `pnpm test:playwright`: PASS;
- `pnpm test:web-bundle`: PASS, initial JS gzip 139524 B ≤ 256000 B;
- `pnpm lint` и `pnpm contracts:check-generated`: PASS.

Evidence integration опубликовано в
[PR #171](https://github.com/YurGusev/CoffeeOrderPlatform/blob/14ae10ea500adf2e4da4f62fa00a2676ad754503/evidence/issue-9-11-consumer.md).
Raw logs находятся локально в `/tmp/coffee-issue11-final-checks`; это mock browser
proof, а не production IdP/provider или full browser-through-Edge acceptance.

Проверка самостоятельной ветки #9 на 4 октября:
`pnpm exec tsc -b apps/web --pretty false` — FAIL (7 diagnostics: отсутствуют
grindOptions, grindDisplayName и sourceGrindKeyHash в старых generated types);
`pnpm test:web-queries` — 14/15 PASS, 1 FAIL из-за старой OrderItem schema,
которая запрещает hash вместо проверки связанного displayName. Логи:
`/tmp/coffee-issue9-publish-checks/{01-typecheck,02-queries}.log`. Это известная
зависимость нового grind consumer от ещё не merged contract delta #11.

PR #9 публикуется как Draft. Для готовности к merge после принятия #171 нужно
согласовать #9 с актуальной develop, разрешить shared manifest/lock/generator
и runtime-schema пересечения, выполнить native contracts generation/check и
повторить обязательные frontend checks на итоговой ветке. Не копировать backend
#11 или чужой manifest целиком в PR #9. Полный #11 не становится новым
первоначальным prerequisite #9; здесь требуется его конкретный contract output A.
GitHub CI, review, accepted merge и deployment этой публикацией не подтверждаются.


## 9. Исправления review #172 — 5 октября 2026

В рабочую ветку #9 интегрирован согласованный public `client-v1` contract output A
из #171: optional grind options/hash/displayName, связанная пара полей и terminal
`PRICING_GRIND_NOT_AVAILABLE`. Runtime schemas и transport types создаются штатной
генерацией из OpenAPI. InternalApi, backend и миграции #11 остаются в #171.
На этапе локальной интеграции backend producer ещё не был принят, поэтому
PR #172 оставался Draft. Состояние после принятия #171 описано в разделе 11.

Отсутствие `availability` в URL означает исходный фильтр `Available`; явный
`availability=` означает «Все» и отсутствие availability filter в API. Submit
и debounce сохраняют это различие; Back/Forward синхронизируют select с URL.
Order Card скрывает cached snapshot и действия после 403/404; временный 503
сохраняет карточку с предупреждением о свежести. Catalog также прекращает
вывод действий при ошибке чтения заказа.

`projectionVersion` защищает business representation. Orders вычисляет
`allowedActions` при чтении, поэтому истечение quote законно убирает `confirm`
без новой версии. Consumer принимает изменение только `allowedActions` при той
же версии; расхождение остальных полей отклоняет, более старую версию игнорирует.
Foundation fixture использует session expiry на час позже текущего времени.

На самостоятельной ветке #9 после исправлений прошли `pnpm versions:check`,
`pnpm typecheck`, `pnpm contracts:lint`, `pnpm contracts:check-generated`,
`pnpm contracts:breaking`, `pnpm contracts:test` (48/48),
`pnpm architecture:check`, `pnpm lint`, `pnpm test:web-queries` (15/15),
`pnpm test:web-idempotency` (6/6 unit и browser group),
`pnpm test:web-accessibility`, `pnpm test:web-foundation`,
`pnpm test:web-routes` и итоговый `pnpm test:playwright`.
`pnpm test:web-bundle`: gzip 139612 B при лимите 256000 B.
Итоговый браузерный прогон покрывает «Все» после submit/debounce/Back/Forward,
скрытие cached Card при 403/404 и сохранение карточки при 503.
Логи находятся в `/tmp/coffee-pr171-172-fixes-20261005/ui/`; предыдущие
неуспешные прогоны сохранены как история исправления тестовой синхронизации.
Это локальный browser proof с mock API. Browser-through-Edge/Compose,
production IdP/provider, deployment и accepted merge этим прогоном не проверены.

## 10. Customer search после отзыва доступа — 5 октября 2026

При refetch поиска Customer с ответом 403 экран показывает «Недостаточно прав»
и скрывает сохранённые имя, контакт, customerRef, кнопки «Выбрать» и пагинацию.
Ошибка доступа не предлагает повтор запроса.
Cached response не заменяет отказ в доступе. Временный 503 сохраняет результаты
и показывает Problem Details с возможностью повторной проверки.

Регрессия выполняет успешный поиск с контактами и nextCursor, переход через
«Выбрать» к созданию заказа, продвижение тестовых часов на 31 секунду и Back
к тому же запросу. Refetch 403 скрывает все сохранённые данные и действия.
`pnpm test:playwright` со свежей сборкой/typecheck, `pnpm lint`,
`pnpm test:web-queries` (15/15) и `pnpm browser:bundle:check` прошли;
gzip 139656 B ≤ 256000 B. Логи:
`/tmp/coffee-pr172-customer-privacy-20261005/`. Это browser proof с mock API;
browser-through-Edge и production в этой проверке не участвовали.

## 11. Смена оператора и конфликт версии в Catalog — 5 октября 2026

При смене actor отменяются только business queries. Выполняющийся запрос
`browser-session` принимает новую сессию; SessionBoundary размонтирует формы
прежнего оператора, а прежние cache и pending intents очищаются.

`ORDER_VERSION_CONFLICT` в Catalog открывает диалог с correlation ID.
Количество и выбранный помол сохраняются. Кнопка «Обновить карточку» выполняет
`invalidateQueries` для точного Order query и читает актуальный Order. Только успешный GET
закрывает конфликт; он не повторяет PUT. Следующее явное «Добавить» создаёт
новый intent и использует свежую owner version.

Producer #171 принят в `develop` commit
`2191b82ea114db8f9b1c4839773ef7ca51a204b9`. Ветка #9 согласована с этой базой;
конфликты compatibility evidence, breaking guard и указателя документации разрешены,
runtime schemas генерируются штатно с Catalog roots для browser consumer.
PR #172 остаётся Draft: browser-through-Edge/Compose served-surface acceptance
и production в текущем локальном browser proof не проверены.

На согласованной ветке прошли штатная генерация и generated drift check,
contracts lint/breaking и 49/49 контрактных тестов, полный Playwright со свежей
сборкой/typecheck, queries 15/15, idempotency 6/6 и browser group,
foundation, architecture, lint, versions и bundle check (gzip 139763 B ≤ 256000 B).
Регрессии проверяют периодический session poll через 31 секунду с новым actor
и удалением приватной формы, а также Catalog `1 → 4 → 5` с сохранением помола
и количества, без автоматического PUT и с новым ключом при явном повторе.
Логи: `/tmp/coffee-pr172-session-conflict-20261005/`.

## 12. Количество и восстановление конфликта Order Card — 5 октября 2026

Несохранённое количество не входит в Confirm. Перед подтверждением обновите
изменённые позиции или верните сохранённые значения: до этого Confirm
недоступен и экран показывает предупреждение. После прекращения редактирования
поле количества показывает owner `item.quantity`, а не локальный ввод.

При конфликте версии диалог остаётся открытым после неуспешного GET, включая
503. «Обновить карточку» повторяет только exact GET, сохраняя введённое количество.
Конфликт снимается только после успешного ответа. Следующую mutation оператор
запускает явно с версией свежей карточки; автоматического PUT нет.


## 13. Catalog search после отзыва доступа — 5 октября 2026

При refetch Catalog с ответом 403 экран показывает «Недостаточно прав» и скрывает
cached товары, количество, помол, «Добавить» и пагинацию. Это действует и при
прежнем actorRef и сохранённом праве редактирования Order. Серверный отказ
Catalog не заменяется cached результатами. Временный 503 сохраняет контекст поиска.


## 14. Перекрывающиеся команды до завершения fingerprint — 5 октября 2026

После асинхронного вычисления fingerprint `beginIntent` заново читает pending
scope. Проверка и запись intent выполняются без промежуточного `await`:
перекрывающиеся вызовы одного actor/scope получают один сохранённый intent,
только создавший его вызов отправляет новую команду. Это сохраняет прежний ключ
при повторном открытии формы, пока исходная команда не завершена.
