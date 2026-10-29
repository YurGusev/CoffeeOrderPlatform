# G13/G15: внешний PostgreSQL вместо disposable proof container

Статус: предложение владельцу, не разрешение и не runtime PASS. Подготовлено 25 октября 2026 года после сверки всех 77 критериев #13.

## Проблема и факты

Общий launch запрещает запуск PostgreSQL container. Standalone G15 использует `postgres-proof`, поэтому даже успешный browser flow не закроет этот критерий. Standalone G18 остаётся отдельно разрешённой диагностикой и не подменяет внешний PostgreSQL G13.

На этом сервере уже есть PostgreSQL 17.11, system identifier `7613370342949990434`, контейнер `coffee_postgres` с CID `267958ce276e65d96c4a5d2cfc4541de35f9785de3dd15c04c34798cf7b1c85f` и image ID `sha256:1bea307dfb3ee30541a7acf7de14b58bcd6948da98e5d31a04c627c4d35ec64b`. Пятнадцать canonical ролей подготовлены прежним разрешённым G08. Новых ролей не требуется.

Свежая read-only сверка 25 октября 22:37 UTC: PostgreSQL подключён только к `coffee_network` (`d6e471bdc52437821abc9a060e075a153ad55003daf81eea1782d0a62f70ceb3`). Существующая `coffee_postgres_data` имеет ID `f1e587a5c52948bcf232cdc3e644859a7ed24db7dc4fd84be65f36a397cedf6a` и ноль endpoints. Это declared external data network платформы. Соединения между ними ещё нет.

## Точная граница разрешения

Предлагается разрешить только следующие два расширения для G13/G15 verification:

1. Trusted `config-bootstrap` может повторно использовать уже существующие G08 admin, migrator и runtime credentials для пяти DB, вычисленных из проверенного текущего run context. Отдельное узкое исключение — trusted admin connection к maintenance DB `postgres` только для server identity, ограниченных catalog/ownership probes и CREATE/DROP ровно этих пяти derived DB. Business/evidence queries выполняются только внутри пяти derived DB; runtime/migrator не получают доступ к maintenance DB. Проверить canonical role map, подготовительный G08 receipt, его config/bundle/server identity, ancestry и переход в G15 child только через уже разрешённый `browserOidc` diff. Прежний receipt не переписывать под новый run и не выдавать за новый G08 PASS. Admin/migrator используются только доверенным setup/evidence/cleanup кодом; runtime получает только свой scope в tmpfs. Secret values не передаются в argv/environment/логи, общий SOPS не копируется в runtime. Сам SOPS и пароли PostgreSQL не меняются.
2. После повторной проверки exact CID/image/system identifier и network IDs временно добавить этот `coffee_postgres` в существующую пустую `coffee_postgres_data` с alias `coffee_postgres`. Не перезапускать контейнер, не менять `coffee_network`, его alias/IP/default gateway, ports, volumes или server settings. Подключать к data network только предусмотренные Compose DB consumers текущего run. Provider/Internet egress, API-root secret scopes и остальные сети не расширять.

До действия требуется свежая проверка состояния. Если endpoint уже появился или network/CID/system ID изменились, остановиться и сохранить факт: не присваивать себе чужую attachment. Если результат connect неизвестен, перепроверить exact endpoint; при невозможности установить ownership — FAIL и retained resource.

Для единственного connect использовать `--alias coffee_postgres --gw-priority -1` и exact network/CID выше. Локальный Docker CLI подтвердил поддержку отрицательного `--gw-priority`: имеющаяся сеть имеет priority 0. До/после проверить, что default route PostgreSQL остался прежним; при неожиданном route change остановить trial и восстанавливать только собственную attachment после повторной identity-проверки.

## Минимальная реализация

Переиспользовать `projectLaunchDatabaseTargets` из `scripts/db-bootstrap.mjs`, существующие G08 owner/migration/identity/cleanup правила в `verification/launch/v1/scenarios/migrations.mjs` и проверку credentials из `tools/config-bootstrap/index.mjs`. Общий узкий helper допускается только для реальных callers G13 и G15; отдельного secret/config store или нового bootstrap пути ролей не создавать.

Изменить соответствующие ветки `tools/compose-smoke.mjs` и существующий G15 parent/child admission. Для G13/G15 обязательный context-bound внешний путь заменяет proof-container path целиком: без fallback, PostgreSQL container и новых ролей. Standalone G18 сохраняет свой явно ограниченный диагностический путь. Единственный committed `config/platform.yaml` остаётся authority; host/port не меняются runtime overlay. G15 меняет только разрешённый `browserOidc` blob в config-only child.

Setup создаёт только пять derived DB с canonical migrator владельцами и существующими точными grants/migrations. Повторное использование DB допустимо лишь при совпадении проверенного run ownership ledger; любое чужое или неопределённое состояние — STOP. Не выполнять CREATE/ALTER/DROP ROLE. `coffeeorderdb`, `coffeeorder_staging`, permanent `coffee_platform_*` и другие DB не открывать и не изменять; единственное maintenance-исключение `postgres` ограничено операциями пункта 1 и только trusted admin.

Сохранить `createG15OwnerEvidence`: allowlist connection target — ровно эти пять run DB. Реальные browser effects выполняются runtime roles; доверенный evidence reader проверяет только имеющиеся count/hash/recovery invariants. Контракт #119, подписи, assertions, timeouts и thresholds сохраняются.

## Проверка и cleanup

До live запуска: расширить существующие tests bootstrap, Compose topology и G15 proof/runner для wrong parent/run/SHA/config/bundle/role/server identity, forbidden DB/unknown ownership, запрета proof container, scope materialization и отказа при неполном cleanup. Negative tests запрещают любые иные connection targets, несогласованные admin operations и maintenance connection для runtime/migrator. Независимый Astra review обязателен. Новую test infrastructure и dependencies не добавлять.

Затем фактические G13 и G15 diagnostics: inventory до/после, пять run DB, owner grants, реальный Chromium/owners/Kafka, proof bindings и точные ресурсные receipts. Любая недоступность внешней DB даёт FAIL, не запускает локальный PostgreSQL fallback.

После сохранения evidence удалить только принадлежащие run пять DB после повторной проверки server identity/owner; неопределённый CREATE/COMMIT не удалять автоматически. Удалить только свои Compose ресурсы и scoped tmpfs. Отсоединить добавленный этим trial PostgreSQL endpoint лишь после удаления своих consumers и проверки, что в data network не появился чужой endpoint. При конфликте сохранить attachment и отразить retained FAIL, без force/broad cleanup. Подтвердить сохранение исходных CID/image/mounts, `coffee_network`, system ID и пятнадцати ролей.

Разрешение не устанавливает новый stack постоянно: окончательная установка после общей готовности остаётся ранее порученным отдельным шагом. G14 native AVX/AES host, реальный production IdP, G16 approval и полный G00–G19 этим планом не подменяются. GitHub mutation не разрешается.

## Почему нужно отдельное решение

Разрешённый G08 подготавливал роли и credentials для migration proof. Synthetic OIDC approval G15 определял auth fixture и run-scoped stores, но не разрешал выдавать этому child существующие G08 парольные значения или менять сетевую доступность PostgreSQL, который также обслуживает legacy. Здесь меняются назначение доверенных credentials и network trust boundary; read-only исследование такого разрешения не даёт.
