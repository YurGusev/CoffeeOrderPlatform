# Issue #10 — локальная приёмка immutable AROMA offer binding

Статус: `local-binding-verified-full-compose-blocked`.
Это evidence только ограниченного этапа binding. Полная готовность Gateway и issue #10
не заявляется.

## Идентификация рабочего дерева

- Repository: `/home/yurgusev/CoffeeOrderPlatform`
- Branch: `feature/10-aroma-gateway`
- Base HEAD до этого этапа: `11c5c388b322bffc4717687d57a09fa493888291`
- `merge-base HEAD develop`: `11c5c388b322bffc4717687d57a09fa493888291`
- Рабочее дерево было dirty до этапа: существовали 41 modified tracked files и 7
  untracked entries. HEAD не является commit всех текущих изменений.
- Lane-owned изменения этого этапа: `tests/aroma/binding-live.test.mjs`,
  `tools/compose-smoke.mjs`, заключительный status block
  `docs/launch/27_AROMA_PROVIDER_PROTOCOL.md`, этот evidence и handoff.
  Остальные dirty files относятся к уже существовавшей реализации/изменениям и не
  были удалены, reset, stash-нуты или переписаны.

## Границы

Разрешён и проверен только локальный путь:

`catalog-activation-worker` fixture → `api-internal` → `aroma-gateway` →
disposable Integration PostgreSQL.

В текущем этапе не было обращений к сайту или API AROMA, login/refresh, provider
mutation, проверки корзины, выбора provider origin, настоящего аккаунта или
provider credentials. Не выполнялись commit, push, PR/issues mutation, merge,
deployment и переписывание истории. Synthetic completed snapshots не являются
provider captures.

## Изменения

1. В `tests/aroma/binding-live.test.mjs` добавлен явный DB barrier: holder
   transaction сначала захватывает ту же export row через `SELECT ... FOR UPDATE`,
   затем запускается contender. Обе реальные конкурентные directions и исходные
   `Promise.all` races сохранены; production timeouts и lock semantics не менялись.
2. В `tools/compose-smoke.mjs` добавлен отдельный `--aroma-binding-proof` на
   существующих Compose/CA/scoped-materialization/PostgreSQL helpers. Proof запускает
   реальные `api-internal` и `aroma-gateway`, fixture с transport identity
   `catalog-activation-worker`, native HTTPS/mTLS, server CA/SAN validation,
   API-internal delegation signing и Gateway claim checks. Gateway в этом режиме
   не подключён к provider-egress.
3. В том же harness Kafka stub refs получают сгенерированный ephemeral credential,
   а не строковый placeholder. Production health checks не ослаблялись.
4. Proof дополнительно проверяет отсутствие synthetic raw provider canary в каждом
   фактическом HTTP response body, bounded logs и sanitized output.
5. Certificate-negative proof принимает только явные TLS/certificate rejection
   codes/messages. Для untrusted client certificate `ECONNRESET` не является
   доказательством сам по себе: test-only Gateway observer требует свежий
   `tlsClientError`, связанный с тем же соединением через Gateway-tracked socket
   `remotePort`/fixture `localPort`, и непустой Gateway-side `authorizationError`
   проверки client certificate (наблюдался `UNABLE_TO_VERIFY_LEAF_SIGNATURE`).
   При отсутствии такой записи, включая ambiguous `ECONNRESET`, proof завершается
   ошибкой; timeout, DNS, connection refused и прочие network errors также остаются
   ошибкой proof. Observer выводит только sanitized category, error code,
   authorization error, sequence и transport ports; certificates и keys не выводятся.
   В observer отсутствует fallback по всем sockets: parent identity сравнивается
   только при наличии обеих сторон. Узкая regression проверяет missing `_parent`
   (включая `undefined` с обеих сторон) и unknown socket; такие случаи не создают
   association и не подтверждают certificate rejection.
6. Отдельный endpoint `aroma-proof-unreachable.invalid` обязан завершиться как
   `network-rejected`; TLS classification или HTTP response на нём проваливают proof.
7. Initial registration, exact replay и replay после Gateway restart сравнивают
   canonical response с точным нормативным binding: `offerRef`, `supplierRef`,
   `sourceIdentityScheme`, `sourceOfferKeyHash`, `firstSnapshotRef`, `state: Bound`.
8. `27_AROMA_PROVIDER_PROTOCOL.md` отделяет реализованный local binding от
   отсутствующего production completed-snapshot producer и оставшихся provider
   blockers.

## Наблюдаемые проверки

Все перечисленные ниже команды завершились exit 0, если не указано иное:

| Команда | Результат |
|---|---|
| `node --check tests/aroma/binding-live.test.mjs` | pass |
| `node --check tools/compose-smoke.mjs` | pass |
| `pnpm exec oxlint tools/compose-smoke.mjs` | pass |
| `git diff --check` | pass |
| `pnpm config:check` | `platform config: OK (15 runtimes, development)` |
| `pnpm security:secrets` | `security material: OK (development, encrypted repository leaves and runtime scopes)` |
| `pnpm authority:check` | positive acceptance passed; 4 unittest passed |
| `pnpm contracts:check-generated` | generated files byte-identical; SHA-256 `e94d2aeba945bfdd5cc66574d818352e0132b2ef783bab0f97c02a1a9ddb2465` |
| `pnpm contracts:breaking` | pass |
| `pnpm contracts:test` | pass |
| `pnpm architecture:check` | pass |
| `pnpm db:smoke` | pass |
| `pnpm typecheck` | pass |
| `pnpm lint` | pass |
| `pnpm check` | pass; nested full suite 208 tests, 193 pass, 0 fail, 15 skipped |
| `pnpm test` | first штатный run pass |
| `pnpm test` | second последовательный штатный run pass |
| `COFFEE_DB_LIVE_PROOF=1 node --test tests/aroma/binding-http.test.mjs tests/aroma/binding-live.test.mjs tests/compose/topology.test.mjs` | pass; binding-live не skipped |
| `node tools/compose-smoke.mjs --help` | pass; `--aroma-binding-proof` listed |
| `pnpm test:compose-smoke -- --aroma-binding-proof` | pass; proof non-skipped, exact normative binding body checked on baseline/replay/restart, untrusted certificate had correlated Gateway-side client-certificate verification, unavailable endpoint was `network-rejected`, cleanup completed |

Отдельная диагностическая попытка `COFFEE_DB_LIVE_PROOF=1 pnpm test` завершилась
exit 1: два lifecycle tests срабатывают на штатный guard, запрещающий глобальные
live-proof locator variables в unit suite. Поэтому live proof запускается отдельной
командой выше, а два acceptance runs — обычным `pnpm test`.

## Что доказано real container proof

`pnpm test:compose-smoke -- --aroma-binding-proof` завершился exit 0. Его
assertions наблюдаемы через успешное завершение harness и включают:

- allowed registration: HTTP `200`, durable binding, exact normative body;
- exact replay: `200`, the same exact normative body, одна связь;
- offerRef и source identity conflicts: `409`/`409`, исходная связь сохранена;
- Gateway restart replay: `200` с тем же exact normative body из disposable PostgreSQL;
- отсутствующий client certificate: explicit TLS certificate rejection до store;
- untrusted client certificate: transport rejection accepted only after a fresh,
  connection-correlated Gateway `tlsClientError` with non-empty server-side
  `authorizationError` (`UNABLE_TO_VERIFY_LEAF_SIGNATURE` in the observed fixture);
  raw/ambiguous `ECONNRESET` and arbitrary network errors do not pass;
- недоступный `.invalid` endpoint: `network-rejected`, не успешный
  certificate-negative result;
- trusted foreign service identity: `401`;
- forged/expired/wrong originalCaller/wrong operation delegation: `403` до записи;
- malformed JSON: contract `400`;
- durable binding count: `1`;
- raw provider canary отсутствует в response bodies, bounded logs и sanitized
  proof output;
- fixture использует native HTTPS sockets и реальную client/server certificate
  validation, а не `app.inject`, `verifyTransport` подмену или ручную установку
  `transportIdentity`.

Cleanup proof-owned resources завершён: disposable Compose project, disposable PostgreSQL,
fixture (`--rm`), project-owned networks/volumes и tmpfs materialization удалены;
shared `coffee_postgres_data` сохранён.

## PostgreSQL race и Compose diagnosis

До Worker A наблюдалась ошибка harness:
`expected issue10-binding-b to wait for export row lock`. Причина — отсутствие
барьера после запуска holder transaction: contender мог выполнить UPDATE до
фактического захвата holder row lock. Explicit `FOR UPDATE` barrier устранил
недетерминированность; targeted live proof и opt-in DB pair после этого прошли.

Ранее зафиксированный `bootstrap-first: Query read timeout` в текущем bounded
прогоне не воспроизведён. Его отдельная историческая причинность не объявляется
установленной и не маскируется последовательным runner.

Full topology оставлен открытым и не считается green:

- `pnpm test:compose-smoke -- --stub-secrets --no-build --project-name coffee-compose-smoke-360926-1b914da3`
  завершился exit 1 на отсутствующем image tag
  `coffee-compose-smoke-360926-1b914da3-pricing-service:latest`.
- Повторный `pnpm test:compose-smoke -- --stub-secrets --project-name coffee-compose-smoke-360926-1b914da3`
  завершился exit 1 после startup.
- Диагностический run с `--keep --no-build` завершился exit 1: Kafka и
  `api-internal` были healthy, `orders-service` — `running`, exit code `0`,
  health `unhealthy`, `/health/ready` возвращал `503`; теми же `503` были
  `catalog-service`, `customer-service`, `pricing-service` и `aroma-gateway`.
  `coffee_postgres_data` не содержал Postgres container, а
  `config/platform.yaml` задаёт database host `coffee_postgres:5432`. Поэтому
  текущий blocker — отсутствие Postgres infrastructure в topology smoke, а не
  доказанный дефект Orders business logic. `/health/ready` не делался безусловно
  успешным.

Отдельно подтверждён harness defect: до исправления Kafka runtime refs в
`--stub-secrets` получали строковый `compose-smoke-placeholder`; после исправления
Kafka в full diagnostic run стал healthy. Это не устраняет независимый DB blocker.
Все resources диагностического project удалены; shared `coffee_postgres_data`
остался.

## Secrets

Repository authority оставлена без исключения: в repository разрешён только
`secrets/platform.secrets.sops.yaml`. Import-файл не расшифровывался и не
подключался к runtime. Его зашифрованные байты были сохранены вне repository по
пути:

`/home/yurgusev/.local/share/coffee-platform/imports/aroma-import.secrets.sops.yaml`

Каталог имеет mode `0700`, файл `0600`, SHA-256:
`d165bbbab388944a8c1a5a0f77309ff0b582895053652d140de8dff30c2cd4a2`.
Исходная repository copy отсутствует; `pnpm config:check` и
`pnpm security:secrets` прошли. Содержимое, credentials и private keys в evidence
не записывались.

## Оставшаяся работа

Binding не закрывает #10 и не разблокирует #6/#11 целиком. Остались production
completed-snapshot exporter/producer, Catalog-side staging/activation и durable
binding acknowledgement, полноценные batch/content-hash/HMAC invariants, provider
session lifecycle, cart adapter и offer-to-cart-line resolution,
packing/grind/quantity semantics, durable mutation journal, UnknownOutcome/retry и
convergence. `Bound` — только durable связь `offerRef` с supplier/source hash и
первым Completed snapshot; это не Catalog activation, Orders Draft/Confirm,
cart-line readiness или provider mutation readiness.

## Будущее уточнение #10/#6/#16 (не опубликовано)

- `catalog-activation-worker` в durable preparation transaction назначает или
  переиспользует `offerRef` и сохраняет binding preparation после получения
  completed snapshot от #6.
- После commit worker вызывает `registerAromaOfferBinding`; Gateway сохраняет
  immutable binding в Integration owner DB.
- `catalog-activation-worker` сохраняет `Bound`/`firstSnapshotRef` как durable
  acknowledgement в Catalog owner DB/Outbox; activation ждёт все required
  acknowledgements до публикации активного поколения.
- Это предотвращает ложный partial activation после потерянного HTTP ответа и
  сохраняет replay/convergence invariant.

Этот текст не публиковался в GitHub/Gitea и не изменял внешние issue/PR.
