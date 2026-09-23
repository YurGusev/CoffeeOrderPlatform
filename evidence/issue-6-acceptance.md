# Issue #6 — свидетельства приёмки

База: `origin/develop@4b2cad1dab30af66ad0b2fe64da280222e506574`; ветка `feature/6-catalog-batch-ingestion`. Коммит `89b4779e6cb976f2c03b3c9ace211c59e293a48b` опубликован и является текущим `HEAD`; PR #145 открыт в `develop`. Слияние не выполнялось. Реальных запросов к AROMA и мутаций не выполнялось.

## Реализованные границы

- Ровно три миграции Catalog создают шесть постоянных staging-таблиц, принадлежащих issue. Права Catalog import распространяются на эти таблицы; создавать TEMP-таблицы может только владелец, а постоянный DDL запрещён для `coffee_catalog_import_rw`.
- Gateway и importer используют общие canonical JSON/SHA-256 helpers `aroma-v1` и golden vectors. Отсутствующие необязательные свойства остаются отличимыми от JSON `[]`; денежные значения остаются десятичным текстом.
- Importer создаёт `Created` до HTTP, применяет единый общий deadline импорта, проверяет сгенерированные записи InternalApiV1 NDJSON и дожидается чистого EOF перед переходом в `Received`. Финальная проверка повторно сверяет долговечные ordinals/counts пакет за пакетом до короткого guarded transition.
- Точный повтор batch проверяется под generation lock до expected sequence; конфликтующий повтор надёжно отклоняет `Receiving` с `BATCH_HASH_CONFLICT`, не понижая terminal generations. Для неизвестных результатов `COMMIT` операций create, started, нового или ранее повторённого batch, Received и rejection выполняются точные durable rereads, специфичные для операции. Потеря подтверждения успешного terminal-перехода не приводит к повторному экспорту или понижению `Received`; для заведомо незафиксированного перехода фиксируется известная ошибка, а не `OutcomeUnknown`.
- Возможность TEMP-table проверяется во время выполнения по дескрипторам таблицы, столбцов и SQL-типов, а не только через TypeScript. Записи provider `snapshot-failed` надёжно отклоняются после чистого EOF и приводят к неуспешным запускам scheduler.
- Recovery выполняется перед каждым экспортом и честно отклоняет неполные generations; ошибка БД блокирует экспорт, а каждый последующий обход использует новый `snapshotRef`. Readiness требует завершённого startup recovery и работающего scheduler supervisor. Монотонный scheduler с интервалом 3,600,000 ms запускается сразу при старте, работает в одном экземпляре и пропускает занятый запуск вместо постановки в очередь.
- #16 получает только staging со статусом `Received`, правила reconstruction, contract/hash helpers и vectors. Active tables, activation, events, новый HTTP endpoint, cross-app runtime import и мутации чужих сервисов не добавлялись.

## Снятые до реализации RED-свидетельства

Каждая команда завершилась с кодом `1`, пропусков не было:

- `pnpm test:catalog-ingestion` — `ERR_MODULE_NOT_FOUND` для `@coffee-platform/contracts-aroma-v1`.
- `pnpm test:catalog-stream` — отсутствовал `apps/catalog-supplier-sync/dist/ndjson-reader.js`.
- `pnpm test:catalog-copy` — отсутствовали shared contract package/live proof.
- `pnpm test:catalog-recovery` — отсутствовал `scripts/catalog-recovery-live-proof.mjs`.

## Устранение замечаний ревью (2026-09-21)

Для всех пяти предоставленных замечаний, остаточного observability P2 и последующего terminal-memory P2 имеются локальные закрывающие изменения кода/тестов/свидетельств в `evidence/issue-6-review-remediation.md`; свежие receipts команд находятся в `evidence/issue-6-review-checks.json`. В отчёте зафиксированы RED, специфичные для ревью, реальный SIGKILL/restart через production composition и mTLS InternalApi fixture, readiness 503→200, spans stream/generation/validation/COPY/transaction, безопасные correlation fields, измерения batch-duration и stream/COPY backpressure, linear framing и проверка большого fragmented stream с задержкой persistence, а также production-проверка `complete()` для 131,072 различных batch manifests при ограничении retained-heap-growth в 4 MiB.

Последняя проверка запускает реальное хранилище с ленивыми SQL fixtures (не PostgreSQL capacity); наблюдавшийся максимальный retained growth составил 161,296 bytes, а исходный RED до исправления сохранён. HTTPS fixture — не развернутые `api-internal`, Gateway или provider; capacity test использует контролируемый persistence seam, а не полноценный load benchmark базы данных/provider. Эти явные границы заменяют более широкие трактовки прежних свидетельств о restart/load.

## Итоговые проверки Catalog

В ранее зафиксированных финальных запусках после правок наблюдались следующие результаты:

- `pnpm test:catalog-ingestion`: 6 passed, 0 failed, **0 skipped**;
- `pnpm test:catalog-stream`: 21 passed, 0 failed, **0 skipped**;
- `pnpm test:catalog-copy`: проверка PostgreSQL COPY/migration/reconstruction на одноразовой БД, 1 passed, 0 failed, **0 skipped**;
- `pnpm test:catalog-recovery`: проверка PostgreSQL recovery/ack-loss на одноразовой БД, 1 passed, 0 failed, **0 skipped**;
- `pnpm lint` и `pnpm typecheck`: exit 0.

Live gates запускали PostgreSQL `17.11` в одноразовых контейнерах с уникальными именами, проверяли настоящий migration runner и runtime role через `@coffee-platform/database` и удаляли контейнеры в `finally`. Для проверки recovery подтверждения `COMMIT` операций create/started/batch/terminal/reject терялись через repository TCP blackhole proxy, после чего результат сверялся долговечным owner-local reread. Сбой terminal перехода инициировался на четвёртом `COMMIT`; независимая проверка подтверждала долговечный `Received` до reconciliation и отсутствие повторного экспорта. Потеря ACK при повторе более раннего batch оставляла состояние `Receiving` с уже увеличенным `next_batch_number`. Negative-проверки terminal-перехода доказали, что изменение durable ordinal и независимого пересчёта строк не позволяет перейти в `Received`. Fixtures проходили через типизированную границу InternalApiV1 client. Ни в одном live gate Catalog нет пути prerequisite skip.

## Проверки репозитория

Ранее зафиксированные свежие результаты:

- `pnpm check` — PASS: authority, совместимость toolchain/Node 26, config, contract lint/generation/breaking/tests, architecture, rule parity, lint, typecheck и набор из 393 тестов репозитория.
- `pnpm contracts:check-generated` — PASS, побайтно идентичный digest `f6ff9ea5c04796695f1e8c2aafb20950950ea739596a93f5bb533b6bab92102e`.
- `pnpm config:check` — PASS, 15 runtimes.
- `pnpm architecture:check` — PASS с Dependency Cruiser 18.2.0.
- `pnpm typecheck` — PASS.
- `pnpm lint` — PASS с deny-warnings.
- `pnpm test` — PASS: 393 tests, 377 passed, 0 failed, 16 skipped.
- `pnpm db:smoke` — PASS: проверены 5 database configs и 15 services.
- `git diff --check` — PASS.

Первая попытка `pnpm check` завершилась ошибкой в не относящейся к задаче проверке AROMA binding saturation (`DB_POOL_EXHAUSTED`); её отдельный повтор и точный повтор полной проверки завершились успешно, без изменений кода или timeout. Неуспешный receipt сохранён.

16 глобальных пропусков относятся к ранее существовавшим live lanes: один AROMA journal live test, один database foundation live test и четырнадцать Customer live tests, которым нужны scoped database, mTLS, log или unknown-COMMIT fixtures. Четыре Catalog gates сообщают ноль пропусков.

## Обязательная проверка Compose

`pnpm test:compose-smoke -- --recovery-proof --no-build --project-name
coffee-issue6-final-observability` завершилась успешно. Проверка создала одноразовые ресурсы PostgreSQL и Kafka, применила три миграции Catalog до запуска runtime, запустила все 15 runtimes и сгенерированную локальную HTTPS provider fixture и наблюдала их в healthy-состоянии. Она проверила восстановление database/Kafka/native и graceful shutdown, после чего удалила ограниченные по scope containers, volumes, networks, tmpfs secrets и fixture.

DNS провайдера был привязан только к локальной fixture в Docker-сети с `internal: true`, поэтому выход к публичному provider был невозможен. В receipt зафиксированы один login и один Catalog request к fixture, а счётчики cart и mutation равны нулю; реальных запросов к AROMA и мутаций не выполнялось. Это заменяет ранние попытки с отсутствующим SOPS и ограниченным `--stub-secrets`: одного timeout было недостаточно, чтобы признать внешнюю блокировку доказанной.

## Дополнительное закрытие критериев 22 сентября 2026 года

- `failure_code` принимает только закрытый набор безопасных кодов. Ошибки схемы, порядка, batch gap/chain, source identity, terminal counts/hash и provider terminal code остаются различимыми; SQL, `Error.message` и тело ответа провайдера не сохраняются.
- `DB_QUERY_FAILED` преобразуется в `IMPORT_DB_ROLLED_BACK` только после наблюдаемого успешного `ROLLBACK`. Перед terminal `Rejected` выполняется guarded reread. Потеря соединения, неизвестный `COMMIT`/`ROLLBACK` и ошибка reconciliation read сохраняют неопределённость результата и не разрешают terminal write.
- Ошибки HTTP status/content-type и отказ чтения response body до `started` дают только `HTTP_BEFORE_STARTED`. Ошибка best-effort `body.cancel()` не подменяет исходный безопасный transport code.
- Live PostgreSQL proof вызывает cancellation и source error после получения первого COPY chunk, проверяет уничтожение source, работоспособность pool и неизменность шести таблиц. Post-merge сценарий наблюдает четыре merge и SQLSTATE `42501` на вставке manifest, затем подтверждает полный rollback.
- Migration proof применяет `0001`, затем `0002`/`0003` вперёд, сохраняет `Created`, `Receiving`, `Received`, `Rejected`, подтверждает repeat no-op и `MIGRATION_CHECKSUM_DRIFT`. Checksummed migrations не менялись.
- ACL proof подключается с настоящей ролью `coffee_catalog_import_rw`: TEMP разрешён, девять запрещённых операций возвращают `42501`. Запрет доступа к чужим БД доказан не structural-планом `pnpm db:smoke`, а четырьмя фактическими `Client.connect()` к чужим БД; каждый отказ вернул `42501`.
- Существующий architecture checker проверяет пять запрещённых для importer направлений и разрешённые package imports.

Receipt `evidence/issue-6-terminal-checks/final-verification-20260922.log` фиксирует Catalog `9/56/1/1`, architecture `42`, repository `437 total / 421 passed / 0 failed / 16` существующих opt-in skips, а также успешные `pnpm check`, `pnpm db:smoke` и `git diff --check`. `pnpm db:smoke` учитывается только как structural smoke; проверка foreign `CONNECT` находится в live Catalog harness того же receipt.

Receipt `evidence/issue-6-terminal-checks/fresh-image-provenance-20260922.json` фиксирует base SHA, прежний `HEAD` только как базу незакоммиченного на тот момент diff, `dirtyTree=true`, отсутствие финального implementation commit на момент создания receipt и SHA-256 parity четырёх фактически собранных host/image artifacts. Recovery proof на 15 уникальных image tags прошёл с fixture `login=1`, `catalog=1`, `cart/post/put/delete=0`. После исправления Kafka recreation удаляет anonymous image volume через `docker compose rm --volumes`; финальная проверка обнаружила ноль project containers/volumes/networks, tmpfs fixture directories, generated project override files и соответствующих dangling anonymous volumes.

## Локальная проверка 23 сентября 2026 года

На незакоммиченном продолжении ветки PR #145 добавлена связанная проверка в
`test:catalog-copy`. Она использует настоящий локальный HTTP-ответ, клиент
`InternalCatalogClient`, производственный `runCatalogImport` и PostgreSQL COPY.
После наблюдения активного COPY остановка ресурса БД и отмена импорта приводят
к досрочному закрытию тела HTTP-ответа, уничтожению обоих источников, ошибке
`DB_INTERRUPTED`, откату пакета во всех шести таблицах, освобождению соединения
и завершению до 40-секундного лимита. В повторном запуске `pnpm test:catalog-copy`
получено **1 passed, 0 failed, 0 skipped**; в диагностике указан
`shutdownMs=85.88837699999931`. `pnpm test:catalog-stream`,
`pnpm test:catalog-recovery` и `pnpm test:catalog-ingestion` также прошли
(**56/1/9 passed**, без пропусков). Первые две попытки новой проверки выявили
невалидную тестовую запись HTTP и неверную точку сравнения состояния до пакета;
после их исправления повторный прогон прошёл. Это локальное доказательство,
а не свежая сборка Compose, CI или проверка развёрнутого `api-internal`.

## Откат

До merge не применять миграции в постоянной среде. Если понадобится остановить работу над опубликованной веткой, сначала согласовать закрытие PR и судьбу ветки; одноразовые контейнеры, принадлежащие issue, удалить после проверок. После применения миграций использовать исправление вперёд; не переписывать checksummed migrations.

Приведённые receipts фиксируют исторические прогоны, а не повторную проверку каждого сценария на текущем `HEAD` PR #145. Слияние, CI, production deployment и реальные запросы или мутации AROMA здесь не подтверждаются.
