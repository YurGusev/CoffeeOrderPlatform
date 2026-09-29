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
команды не предлагается. Exact GET текущей Order Card выполняется отдельно: его
ошибка оставляет последнюю независимо полученную карточку с предупреждением и
блокирует новые owner-команды до успешного обновления. Replay response никогда не
подменяет результат этого GET в current-state cache.

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