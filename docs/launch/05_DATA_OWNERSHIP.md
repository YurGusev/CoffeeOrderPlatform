# Владение данными

## Базы данных

Физический PostgreSQL-сервер уже существует. Таблица описывает отдельные
логические БД новой платформы на этом сервере; legacy `coffeeorderdb` в неё не
входит и новой платформой не изменяется. Точные имена БД, роли и проверка прав
описаны в [документе существующей БД](09_EXISTING_DATABASE_AND_VERSIONS.md).

| База данных/схема | Writer | Сущности первого запуска |
|---|---|---|
| `coffee_platform_customer` | customer-service | Customer, Address, ChannelLink |
| `coffee_platform_catalog` | Catalog owner: `catalog-supplier-sync` пишет только staging, `catalog-activation-worker` — active/identity/Outbox | Product, Variant, SupplierSnapshot, OfferMapping, Availability, SourceIdentity, Outbox |
| `coffee_platform_pricing` | pricing-service | PricingPolicyVersion, PricingQuote |
| `coffee_platform_orders` | Orders runtimes | Order, OrderItem, History, Desired, `cart_desired_order_facts`, Observed, ConvergenceAttempt, MutationReservation, `order_aroma_projections`, Outbox, Inbox |
| `coffee_platform_integration` | aroma-gateway | encrypted session metadata, provider operation journal |

Ни один сервис не получает права записи в БД другого владельца. Read models
используют события или явные owner API; межвладельческий SQL запрещён.

Catalog API читает только pointer-selected `active_*` views через
`coffee_catalog_api_ro`; миграции `0001`–`0007` принадлежат одному
`catalog-service` migrator. `Received` staging не виден клиенту до commit,
переключение `catalog_state` и запись owner Outbox атомарны; Gateway binding
проходит вне этой транзакции через `api-internal`.

Core Order tables пишет только `orders-service`. Cart Desired и
`order_aroma_projections` пишет только `orders-aroma-preparation`; observer и
convergence публикуют owner facts, но не per-Order realtime и не обновляют Card
projection напрямую.

## Границы транзакций

Транзакция `Confirm`:

```text
Order status/version
+ immutable item/product/price snapshots
+ immutable Order contribution
+ Order history/audit
+ Outbox records
```

В ней нет внешнего HTTP или распределённой транзакции.

Транзакции convergence остаются короткими. Сетевой I/O окружён долговечными
состояниями attempt/reservation; блокировки БД не удерживаются во время HTTP-
вызовов провайдера.

## Минимальные индексы и ограничения

- unique idempotency owner/scope/key;
- unique active convergence lease per order/cart scope;
- monotonic fence epoch;
- unique provider operation reference;
- OrderVersion optimistic concurrency;
- unique Catalog snapshot generation and mapping identity;
- Outbox publish state and Inbox event ID uniqueness.

## DB foundation #62: owner adapter и SQL contract

`@coffee-platform/database` владеет pool, terminal deadlines, состоянием
транзакции, release/destroy и required health check. Runtime создаёт только
свой pool из `config/platform.yaml` и scoped secret materialization. DB
ownership задают `database-role-map.json` и PostgreSQL grants. Application
handlers не импортируют `pg`, приватные DB modules или SQL factory; factory
доступен только infrastructure/repositories владельца и foundation packages.

`platform-migrations.applyMigrations` проверяет immutable checksum и применённый
prefix под owner-local advisory transaction lock. Создание ledger, DDL и
checksum rows атомарны. Drift, пустой checksum, orphan/non-prefix и ошибка DDL
останавливают запуск; callback нельзя использовать для COMMIT/ROLLBACK.
Мигратор использует отдельные owner credentials, не runtime writer role.
Ledger `platform_schema_migrations` расположен в схеме владельца.

`defineCopy` принимает фиксированные schema/table/columns владельца и Readable,
сохраняет stream backpressure через Node pipeline и сообщает typed interruption
или connection failure. COPY выполняется в той же opaque transaction; callback
не получает stream драйвера или raw client. Повреждённый/прерванный COPY не
считается подтверждённым rollback до command tag `ROLLBACK`.

SQL contract для последующих owner migrations (это документация, не migration):

```sql
CREATE TABLE <owner_schema>.idempotency_records (
  actor_ref text NOT NULL,
  scope text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  state text NOT NULL CHECK (state IN ('Acquired', 'Completed')),
  lease_owner text NOT NULL,
  lease_until timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  response_status integer,
  response_body jsonb,
  resource_ref text,
  PRIMARY KEY (actor_ref, scope, idempotency_key),
  CHECK (expires_at >= lease_until AND lease_until > created_at),
  CHECK ((state = 'Acquired' AND response_status IS NULL AND completed_at IS NULL)
    OR (state = 'Completed' AND response_status BETWEEN 100 AND 599
      AND response_body IS NOT NULL AND completed_at IS NOT NULL))
);
```

JSON `null` — допустимый terminal body. Canonical hash рекурсивно упорядочивает
ключи JSON objects, сохраняет порядок arrays и запрещает не-JSON значения.
Время создания/lease/retention явно передаёт owner clock; expiry при completion
сверяется с текущим временем PostgreSQL. Completed rows не удаляются в acquire:
retention cleanup и reconciliation принадлежат владельцу и не должны уничтожать
незавершённый unknown intent.

Customer (#5), Pricing (#7, имя `pricing_idempotency_records`), Orders (#8 и
последующие owner commands) создают собственные таблицы в своих migrations.
Catalog и Integration добавляют их только вместе с требующим этого owner
command и явными grants в role map. Foundation не создаёт business schemas,
repositories, Inbox/Outbox или общий изменяемый schema. #63 получает только
opaque transaction/idempotency boundary; Kafka delivery остаётся в #63.

Fleet admission: `56 steady + 8 one-at-a-time rollout + 32 reserve = 96`.
Это явное уменьшение Orders pool `12 → 4`, не автоматическое увеличение сервера.
Ожидающие checkout ограничены pool cap и конечным budget. Saturation считает
`database.metrics().saturationTotal`; краткая занятость всех соединений не
обнуляет последнее подтверждённое health. Настоящий bounded health failure
делает owner dependency failed; успешный SELECT восстанавливает её без restart.

Для #64 доступны machine codes `DB_POOL_EXHAUSTED`, `DB_INVALID_CONFIGURATION`,
`DB_CONNECTION_LOST`, `DB_QUERY_TIMEOUT`, `DB_QUERY_FAILED`, `DB_INTERRUPTED`,
`DB_ROLLBACK_FAILED`, `TRANSACTION_OUTCOME_UNKNOWN`, `DB_INVALID_TRANSITION`,
`DB_TRANSACTION_ROLLED_BACK`, `DB_STOPPED`; `sqlState` только безопасный PG code,
`previousCode` — предыдущий DB code. Correlation fields: `correlationId`,
`causationId`, `traceparent`; SQL, параметры, credentials и payload не входят в
errors/metrics. Pool gauges: active, idle, waiting, pending; counter:
saturationTotal. Metric labels ограничиваются runtime и перечисленными codes,
correlation identifiers не становятся labels.

`startConfiguredRuntime` передаёт owner composition третий аргумент
`configure(app, signal, database?)`: это тот же opaque Database, который
регистрируется в lifecycle/readiness. Второй pool для repository не создаётся.
При ошибке configuration/startup созданный pool уничтожается автоматически.

`sslMode: prefer` сначала запрашивает TLS; fallback в plaintext допустим только
после явного отказа SSL negotiation сервером, до authentication/BEGIN и внутри
checkout budget. Ошибка сертификата не включает fallback. `require` и
`verify-full` требуют TLS с проверкой сертификата. Этот handshake fallback не
является retry SQL/COMMIT и не меняет unknown-outcome policy.
