# Исполнимая спецификация Customer первого запуска

Статус: нормативная спецификация задачи #5. Разработчик реализует перечисленные
структуры, алгоритмы и проверки без самостоятельного выбора схемы данных или
поведения API. Изменение контракта требует отдельного ADR и одновременного
изменения OpenAPI, этой спецификации и тестовых fixtures.

## 1. Граница и состав runtime

Владелец данных и кода — `customer-service`. Runtime предоставляет только:

- `POST /api/client-v1/customers`;
- `GET /api/client-v1/customers`;
- `GET /api/internal-v1/customers/{customerRef}/order-input`;
- `GET /health/live` и `GET /health/ready`.

Он не вызывает Catalog, Pricing, Orders или AROMA, не читает Kafka и не
публикует событий в первом срезе. Публичные маршруты доступны браузеру только
через edge; сам контейнер не публикует host-port.

## 2. Обязательные файлы реализации

```text
apps/customer-service/
  src/main.ts
  src/config.ts
  src/domain/customer.ts
  src/application/create-customer.ts
  src/application/search-customers.ts
  src/http/post-customer.ts
  src/http/get-customers.ts
  src/http/get-customer-order-input.ts
  src/infrastructure/postgres/customer-repository.ts
  src/infrastructure/postgres/idempotency-repository.ts
  src/infrastructure/logging/customer-redaction.ts
  migrations/0001_customer_schema.sql
  migrations/0002_customer_indexes.sql
  test/unit/customer-normalization.test.ts
  test/integration/customer-migrations.test.ts
  test/integration/create-customer.test.ts
  test/integration/search-customers.test.ts
  test/integration/customer-db-permissions.test.ts
  test/security/customer-log-redaction.test.ts
```

HTTP DTO импортируются только из сгенерированного
`packages/contracts/customer-v1`. Сервисные domain и persistence-типы наружу
не экспортируются.

## 3. База данных и роли

- server: существующий PostgreSQL `coffee_postgres:5432`, версия `17.11`;
- database: новая `coffee_platform_customer`, которую provision-задача #3
  создаёт до начала #5;
- schema: `customer`;
- runtime role: `coffee_customer_rw`: `CONNECT`, `USAGE customer`,
  `SELECT/INSERT/UPDATE` только на таблицы ниже, без `CREATE` и `ALTER`;
- migration role: `coffee_customer_migrator`: владелец schema и DDL;
- запрещены подключения к `coffeeorderdb`, `coffeeorder_staging` и БД других
  владельцев.

Миграция `0001_customer_schema.sql` создаёт следующие таблицы.

### `customer.customers`

| Столбец | PostgreSQL type | Правило |
|---|---|---|
| `customer_ref` | `varchar(30)` | PK; `^cus_[0-9A-HJKMNP-TV-Z]{26}$` |
| `version` | `bigint` | `NOT NULL DEFAULT 1 CHECK (version > 0)` |
| `display_name` | `varchar(200)` | нормализованное отображаемое значение |
| `display_name_search` | `varchar(200)` | lowercase NFC для поиска |
| `phone_e164` | `varchar(16)` | nullable; E.164 |
| `email_normalized` | `varchar(254)` | nullable; lowercase NFC |
| `status` | `varchar(16)` | `Active` в первом срезе; CHECK |
| `created_at`, `updated_at` | `timestamptz` | UTC, server time |
| `created_by_actor_ref`, `updated_by_actor_ref` | `varchar(128)` | проверенный actor edge |

CHECK требует хотя бы одно из `phone_e164`/`email_normalized`.

### `customer.addresses`

| Столбец | PostgreSQL type | Правило |
|---|---|---|
| `address_ref` | `varchar(30)` | PK; `adr_` + ULID |
| `customer_ref` | `varchar(30)` | FK на customers, `ON DELETE RESTRICT` |
| `kind` | `varchar(16)` | только `Delivery` |
| `line1`, `line2` | `varchar(200)` | `line1` обязателен; `line2` nullable |
| `city` | `varchar(120)` | обязателен |
| `postal_code` | `varchar(20)` | nullable |
| `country_code` | `char(2)` | ISO 3166-1 alpha-2; default `RU` |
| `version` | `bigint` | `NOT NULL DEFAULT 1 CHECK (version > 0)` |
| `is_active` | `boolean` | `NOT NULL DEFAULT true` |
| audit columns | как у customers | UTC и проверенный actor |

В первом срезе у клиента не более одного активного delivery-адреса.

### `customer.channel_links`

| Столбец | PostgreSQL type | Правило |
|---|---|---|
| `channel_link_ref` | `varchar(30)` | PK; `chl_` + ULID |
| `customer_ref` | `varchar(30)` | FK, `ON DELETE RESTRICT` |
| `provider` | `varchar(16)` | `Web` или `VK` |
| `external_subject_hash` | `char(64)` | SHA-256 lowercase; сырой ID не хранить |
| `status` | `varchar(16)` | `Active` или `Revoked` |
| audit columns | как у customers | UTC и проверенный actor |

Маршруты первого среза не создают channel link. Таблица является подготовленной
точкой владения для будущего channel API; прямой SQL из другого runtime запрещён.

### `customer.idempotency_records`

| Столбец | PostgreSQL type | Правило |
|---|---|---|
| `actor_ref`, `scope`, `idempotency_key` | `varchar(64)`, `varchar(64)`, `uuid` | составной PK; scope `customers:create` |
| `request_hash` | `char(64)` | SHA-256 канонического нормализованного body |
| `state` | `varchar(16)` | `Acquired` или `Completed` |
| `lease_owner` | `uuid` | владелец незавершённой попытки |
| `lease_until` | `timestamptz` | 30 секунд от acquire |
| `response_status` | `smallint` | nullable до завершения |
| `response_body` | `jsonb` | nullable до завершения |
| `resource_ref` | `varchar(30)` | nullable до завершения |
| `created_at`, `expires_at` | `timestamptz` | retention 24 часа |

### `customer.audit_log`

Append-only таблица: `audit_ref` (`aud_` + ULID, PK), `customer_ref`,
`operation` (в #5 только `CustomerCreated`), `actor_ref`, `correlation_id uuid`,
`occurred_at timestamptz`, `before_hash char(64) NULL`, `after_hash char(64)`.
PII и HTTP body в audit log не записываются.

`0002_customer_indexes.sql` создаёт:

- unique partial index на `phone_e164` для `status = 'Active' AND phone_e164 IS NOT NULL`;
- unique partial index на `email_normalized` для активных non-null e-mail;
- unique partial index на `(provider, external_subject_hash)` для active link;
- unique partial index на `customer_ref` для одного active delivery address;
- B-tree index `(display_name_search text_pattern_ops, customer_ref)`;
- B-tree indexes `(phone_e164, customer_ref)` и `(email_normalized, customer_ref)`;
- index `idempotency_records(expires_at)` для удаления истёкших записей.

## 4. Нормализация

`displayName`: Unicode NFC → trim → последовательность Unicode whitespace
заменить одним ASCII space. После преобразования длина 1–200.

Телефон нормализуется `libphonenumber-js@1.13.12` с default region `RU`:

1. принять строку длиной не более 64 символов;
2. разобрать библиотекой, проверить `isValid()`;
3. сохранить и вернуть только `number` в E.164;
4. не пытаться исправлять невалидный номер эвристиками.

E-mail: Unicode NFC → trim → lowercase всей строки → проверка формата и длины
не более 254. Международные домены перед проверкой переводятся в ASCII через
`domainToASCII`; локальная часть не преобразуется и в первом срезе допускает
только ASCII. Адресные строки: NFC → trim → схлопывание whitespace; пустой
`line2`/`postalCode` превращается в `null`; `countryCode` — uppercase.

## 5. `POST /api/client-v1/customers`

Точный request/response определяется `client-v1.yaml`. Максимальный body —
`16 KiB`, deadline — `2 s`. `Authorization` проверяет edge; клиентский
`actorRef`, `X-Actor-*` и service headers edge удаляет. Customer принимает
только подписанный internal actor context, проверяет signature/audience/expiry
и записывает его `actorRef`. Отсутствующий или неверный контекст —
`401 AUTHENTICATION_REQUIRED` или `403 ACTOR_CONTEXT_INVALID` до открытия
транзакции.

Алгоритм обработчика:

1. Валидировать schema и нормализовать body.
2. Канонически сериализовать нормализованный body (ключи lexicographic, без
   insignificant whitespace) и вычислить SHA-256 `request_hash`.
3. Короткой транзакцией по exact key `(actor_ref,scope,idempotency_key)`
   выполнить atomic acquire: вставить `Acquired` с новым
   `lease_owner` и `lease_until=transaction_timestamp()+30s`. При конфликте:
   другой hash → `409 IDEMPOTENCY_CONFLICT`; `Completed` → byte-for-byte replay;
   активная lease → `409 IDEMPOTENCY_REQUEST_IN_PROGRESS`; истёкшую lease с тем
   же hash разрешено забрать условным `UPDATE ... WHERE lease_until<=now()`.
   Одинаковый UUID другого actor — независимый key и не раскрывает response.
4. Открыть business transaction `READ COMMITTED`, timeout `1500 ms`; заново
   заблокировать idempotency row и доказать совпадение `lease_owner`, hash и
   неистёкшую lease. Сетевые вызовы внутри неё запрещены.
5. Сервером сгенерировать monotonic ULID и `customerRef = cus_<ULID>`; при
   наличии address создать `adr_<ULID>`.
6. Вставить Customer, optional Address и audit row.
7. Сформировать `201 CustomerResponse`, записать status/body/resource в
   idempotency row как `Completed` и commit.
8. Нарушение phone unique index вернуть как `409 CUSTOMER_PHONE_CONFLICT`,
   e-mail index — `409 CUSTOMER_EMAIL_CONFLICT`; не выполнять предварительный
   `SELECT` как доказательство уникальности.
9. Ошибка business transaction откатывает Customer, Address и audit, но
   оставляет durable `Acquired` до истечения lease; повтор безопасно продолжает
   с тем же hash. Cleanup удаляет только незавершённые записи старше 24 часов.

`version` начинается с PostgreSQL `bigint 1`, но в HTTP возвращается строкой
`"1"`. Timestamp возвращается в UTC с `Z`.

## 6. `GET /api/client-v1/customers`

Максимальный URL — `2 KiB`, deadline — `1 s`, `limit` default `20`, диапазон
`1..50`. Нормализованный `query` имеет длину `2..200`. Режим определяется
детерминированно:

- успешно разобран как телефон — exact match по `phone_e164`;
- содержит `@` — exact match по `email_normalized`, невалидный e-mail даёт 400;
- иначе — case-insensitive prefix по `display_name_search` с экранированием
  `%`, `_` и `\\`; full-text/fuzzy/substring поиск в #5 запрещён.

Выбираются только `Active`, порядок всегда
`(display_name_search ASC, customer_ref ASC)`. Cursor — base64url без padding
от canonical JSON
`{"v":1,"queryHash":"64-hex","name":"...","customerRef":"cus_..."}`.
Следующая страница использует tuple `>` и запрашивает `limit + 1`; offset
pagination запрещена. Повреждённый cursor, неизвестная версия или cursor от
другого нормализованного query дают `400 INVALID_CURSOR`. `queryHash` —
SHA-256 нормализованного query.

Ответ `CustomerSummary` возвращает имя, `customerRef`, string version и только
masked контакты: телефон `+7******1234`, e-mail `a***@example.com`.

## 6.1. Private Customer snapshot для Orders

`GET /api/internal-v1/customers/{customerRef}/order-input` доступен только
service identity/audience `orders-service`, deadline `1 s`. Он читает owner row
и возвращает строго `customerRef`, decimal-string `customerVersion`,
`displayName`, `state: Active|Inactive`. Телефон, e-mail, адрес, channel links и
audit data не возвращаются. Неизвестный ref — `404 CUSTOMER_NOT_FOUND`;
неактивный Customer возвращается как `200 state=Inactive`, а решение запретить
Draft принимает Orders. Browser/edge route к этому endpoint отсутствует.

## 7. Ошибки и логирование

Все ошибки — RFC 9457 `application/problem+json` по общей schema:

| HTTP | code | Условие |
|---|---|---|
| 400 | `VALIDATION_FAILED` | body/query/header не соответствует schema |
| 400 | `INVALID_CURSOR` | cursor неверен или относится к другому query |
| 401 | `AUTHENTICATION_REQUIRED` | отсутствует проверенная identity |
| 403 | `ACTOR_CONTEXT_INVALID` | actor context неверен или просрочен |
| 409 | `CUSTOMER_PHONE_CONFLICT` | активный клиент уже владеет телефоном |
| 409 | `CUSTOMER_EMAIL_CONFLICT` | активный клиент уже владеет e-mail |
| 409 | `IDEMPOTENCY_CONFLICT` | ключ уже использован с другим body |
| 409 | `IDEMPOTENCY_REQUEST_IN_PROGRESS` | тот же запрос ещё выполняется |
| 500 | `INTERNAL_ERROR` | безопасная неожиданная ошибка |

Логи содержат route, status, duration, `customerRef` после создания,
`correlationId`, trace id и actorRef. Запрещены body, address, raw query,
phone/e-mail, Authorization, actor signature, DB URL/password и полный
Idempotency-Key. Для диагностики ключа разрешён только SHA-256. Pino redact
paths и serializers закрывают request headers/body и error cause; stack/SQL
не попадают в публичный Problem Details.

## 8. Обязательные тесты и критерии приёмки

PR не принимается без следующих тестов на настоящем PostgreSQL 17.11:

1. Чистая миграция создаёт точные columns/checks/indexes/GRANT; повторный запуск
   migration runner не меняет schema.
2. Табличные unit-тесты нормализации покрывают RU/international phone, e-mail,
   Unicode whitespace/NFC и invalid inputs.
3. Успешный POST создаёт ровно Customer, optional Address, audit и completed
   idempotency row; все refs/patterns/version/timestamps соответствуют contract.
4. Повтор с тем же key/body возвращает тот же status и byte-identical body и
   не создаёт строк. Тот же key с другим normalized body даёт
   `IDEMPOTENCY_CONFLICT`.
5. Два конкурентных POST с одинаковым phone и разными keys дают ровно один 201
   и один `CUSTOMER_PHONE_CONFLICT`; аналогичный тест обязателен для e-mail.
6. Fault injection после каждой записи доказывает полный rollback без orphan
   Address, audit или Customer.
7. Поиск отдельно проверяет phone/e-mail/name, `limit + 1`, две страницы без
   пропусков/дубликатов, escaped wildcard и invalid/cross-query cursor.
8. Spoofed actor headers не меняют actor; missing/bad signed context даёт
   401/403 и ноль SQL writes.
9. PII canary помещает уникальные phone/e-mail/address/password/token/key в
   запрос и ошибку; ни один canary не найден в logs, traces и Problem Details.
10. `coffee_customer_rw` выполняет разрешённые операции, не выполняет DDL и
    получает `permission denied` для Catalog/Orders DB.
11. Contract provider tests валидируют каждый status/body/header против
    generated OpenAPI schemas и positive/negative fixtures задачи #4.
12. `pnpm architecture:check` запрещает Customer imports чужого runtime,
    `internal/domain/infrastructure/repositories`, чужие DB URLs и legacy DB.

Evidence записывается в `evidence/handoffs/issue-5.yaml`: commit SHA, migration
checksums, команды и результаты тестов, OpenAPI artifact hash, DB role/schema,
известные ограничения. Документация, код, миграции и тесты доставляются одним
PR из `feature/5-customer-service` в `develop`.

## 9. Явно не входит в #5

CRM, loyalty, marketing, удаление/слияние клиента, импорт legacy-данных,
редактирование Customer, auth-provider, fuzzy/full-text search, публичный
ChannelLink API, Kafka events, общая Customer DB для других сервисов и любые
подключения к AROMA.
