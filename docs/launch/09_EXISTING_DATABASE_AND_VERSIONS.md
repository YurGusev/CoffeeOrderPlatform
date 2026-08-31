# Существующая БД и зафиксированные версии

## 1. PostgreSQL уже существует

Для локальной разработки уже используется PostgreSQL 17:

| Параметр | Значение |
|---|---|
| Контейнер | `coffee_postgres` |
| Версия сервера | PostgreSQL `17.11` |
| Образ | `postgres:17-alpine` |
| Адрес с host | `localhost:5432` |
| Адрес из общей Docker network | `coffee_postgres:5432` |
| Существующие legacy-БД | `coffeeorderdb`, `coffeeorder_staging` |

Новый репозиторий **не поднимает второй PostgreSQL-контейнер** и не включает
сервис `postgres` в свой Compose. `coffeeorderdb` принадлежит CoffeeOrderSystem:
новая платформа не создаёт в ней таблицы, не запускает в ней миграции и не
использует её как runtime-хранилище.

Следующие target-БД **ещё не существуют**. В задаче foundation их необходимо
создать на существующем PostgreSQL-сервере после проверки server identity и
явного запуска admin-only bootstrap:

| БД | Единственный владелец миграций | Runtime с правом записи |
|---|---|---|
| `coffee_platform_customer` | `customer-service` | `customer-service` |
| `coffee_platform_catalog` | `catalog-service` | `catalog-service`, `catalog-supplier-sync` через отдельные ограниченные роли |
| `coffee_platform_pricing` | `pricing-service` | `pricing-service` |
| `coffee_platform_orders` | `orders-service` | runtime Orders через отдельные роли с явным allowlist таблиц |
| `coffee_platform_integration` | `aroma-gateway` | `aroma-gateway` |

Для каждой БД создаются migration-role `<context>_migrator` для DDL и одна или
несколько явно названных runtime-ролей из нормативной спецификации сервиса.
Для Customer это `coffee_customer_migrator` и `coffee_customer_rw`.
Runtime-роль не получает `CREATEDB`,
`CREATEROLE`, DDL и права на другую БД. Пароли не хранятся в Git.

«Чужая БД» — любая БД, отсутствующая в строке runtime в таблице выше. Например,
`orders-service` не может подключаться к `coffee_platform_customer`,
`coffee_platform_catalog`, `coffee_platform_pricing` или
`coffee_platform_integration`; нужные факты он получает через owner API/events.

## 2. Проверка границ

Команда `pnpm architecture:check` должна запускать две проверки.

### 2.1. Импорты TypeScript

Dependency Cruiser читает `.dependency-cruiser.cjs` и проверяет:

- код `apps/<service>/**` не импортирует `apps/<другой-service>/**`;
- код сервиса может импортировать только `packages/contracts/**` и технические
  `packages/platform-*/**`, но не бизнес-модели другого контекста;
- запрещены общие `packages/domain`, `packages/models` и `packages/shared-business`;
- provider DTO из `aroma-gateway` не импортируются в Orders/Catalog: наружу
  выходят только утверждённые контракты;
- frontend не импортирует server runtime, SQL, migrations или provider clients.

Пример запрещённого импорта:

```ts
// apps/orders-service/src/confirm.ts
import { CustomerRepository } from '../../customer-service/src/repository.js';
```

Разрешённый вариант:

```ts
import type { CustomerSummary } from '@coffee/contracts/customer-v1';
```

В `tests/architecture/fixtures/invalid-import/` хранится минимальный намеренно
неверный граф. Тест успешен только когда checker возвращает ненулевой exit code
и называет нарушенные source/target.

### 2.2. Доступ к PostgreSQL

`scripts/check-database-ownership.mjs` читает декларативный
`config/database-ownership.json` и проверяет:

- у каждого runtime указан ровно разрешённый `DATABASE_URL_*`;
- в Compose/CI runtime не получает URL или secret чужой БД;
- SQL migrations находятся только в `apps/<owner>/migrations/`;
- migration job использует роль `<context>_migrator`, runtime — только app-role;
- строки `coffeeorderdb`, `coffeeorder_staging` и legacy connection string запрещены вне явно
  помеченных read-only characterization tests.

Статическая проверка не подключается к PostgreSQL и не заявляет, что реальные
GRANT настроены правильно. Отдельный integration test подключается по очереди
app-role каждого runtime: запись в свою БД должна быть разрешена, а попытка
`SELECT`/`INSERT` в чужую БД должна завершиться PostgreSQL `permission denied`.

Негативный fixture выдаёт `orders-service` URL Customer DB; CI обязан завершить
проверку ошибкой с текстом, содержащим runtime и запрещённую БД.

## 3. Реестр версий первого запуска

Ниже приняты точные версии первого запуска. Задача #3 обязана материализовать
их в `config/toolchain-versions.json`, manifests и lockfile и доказать
совместимость. Используется самая свежая доступная версия на дату решения;
Node.js 26 выбран осознанно, хотя ещё имеет статус Current. В manifests
запрещены `latest`, `*`, `^` и `~`; images фиксируются также по digest.

| Компонент | Принятая версия | Примечание |
|---|---|---|
| Node.js | `26.8.1` Current | production/dev/CI, без fallback на Node 24 |
| npm | `11.19.0` | версия из Node 26.8.1 distribution |
| pnpm | `11.24.0` | точный `packageManager` pin |
| TypeScript | `7.0.2` | strict, `verbatimModuleSyntax`, без downgrade |
| Fastify | `5.12.1` | полный JSON Schema request/response |
| PostgreSQL server | существующий `17.11` | временное исключение: общий legacy server; upgrade не входит в этот PR |
| `pg` | `8.23.0` | прямой driver baseline |
| Apache Kafka broker | `4.3.1` KRaft | `apache/kafka:4.3.1@sha256:<digest>` |
| `@confluentinc/kafka-javascript` | `1.10.0` | провести Node 26 compatibility test |
| React / React DOM | `19.2.8` | новый frontend |
| React Router DOM | `7.18.3` | data/router APIs только по frontend ADR |
| TanStack Query | `5.102.8` | server state |
| Vite | `8.2.2` | build/dev server |
| Vitest | `4.1.11` | unit/component tests |
| Playwright | `1.62.1` | browser E2E |
| OpenAPI Specification | `3.2.0` | проверить поддержку всем toolchain; downgrade требует ADR |
| `@fastify/swagger` | `9.8.1` | contract publication |
| `openapi-typescript` | `7.13.0` | generated client types |
| Spectral CLI | `6.16.3` | contract lint |
| AJV | `8.20.0` | runtime JSON Schema validation |
| Pino | `10.3.1` | structured logging |
| `libphonenumber-js` | `1.13.12` | Customer phone parsing, region RU, output E.164 |
| OpenTelemetry API | `1.9.1` | tracing/metrics API |
| Dependency Cruiser | `18.2.0` | architecture boundaries |
| ESLint | `10.9.1` | static checks |
| Prettier | `3.9.6` | formatting |
| SOPS | `3.13.3` | единый encrypted secrets file |
| age | `1.3.2` | recipients/identity для SOPS |
| Docker Engine | `29.7.2` | подтверждённая версия host |
| Docker Compose plugin | `5.4.0` | подтверждённая версия host |

## 4. Обязательное использование возможностей Node.js 26

- **Temporal:** новые domain timestamps, deadlines, expiry и duration реализуются
  через `Temporal.Instant`, `Temporal.Duration` и `Temporal.ZonedDateTime`.
  Создание нового business-кода на mutable `Date` запрещено architecture/lint rule.
- **Permission Model:** каждый runtime имеет декларацию разрешённых network/file/
  child-process/worker ресурсов. В dev сначала запускается `--permission-audit`,
  в integration/production — `--permission` с минимальными `--allow-*`.
- **Native TypeScript:** однофайловые repository/admin scripts без стороннего
  runtime runner могут запускаться встроенной поддержкой TypeScript. Application
  build остаётся через `tsc`; decorators/transform-dependent syntax запрещены.
- **Встроенный `node:test`:** permission, process lifecycle, AbortSignal,
  graceful shutdown и low-level HTTP tests пишутся на `node:test`; Vitest
  остаётся для domain/frontend suites.
- **Native fetch / Undici 8:** технический HTTP client строится на `fetch`,
  `AbortSignal.timeout/any`, connection pooling и diagnostics; Axios не добавляется.
- **V8 14.6:** разрешены `Map.getOrInsert`, `Map.getOrInsertComputed` и
  `Iterator.concat`, когда они уменьшают ручной mutable boilerplate. Для browser-
  кода обязательна проверка target compatibility.
- Экспериментальные FFI, Virtual File System и SQLite не применяются в production
  без отдельного ADR, threat model и failure tests.

## 5. Возможности других свежих версий

- OpenAPI 3.2 используется для `$self`, современных security/webhook описаний и
  строгой обработки external references; toolchain обязан доказать поддержку 3.2.
- Kafka 4.3.1 запускается только в KRaft; auto-topic creation выключен, новый
  consumer protocol включается только после compatibility/rebalance tests.
- TypeScript 7 используется со строгими ESM boundaries и без compatibility
  shims под старые compiler versions.
- React 19 использует Actions/transition APIs только для UI orchestration;
  server state остаётся в TanStack Query, authoritative business state — на backend.
- Fastify 5 получает полные JSON Schema для params/query/body/response и
  `diagnostics_channel`/OpenTelemetry instrumentation.
- PostgreSQL 18.6 является свежей доступной версией, но общий существующий server
  остаётся 17.11. Его upgrade — отдельное infrastructure issue с проверкой legacy;
  разработчик сервиса не обновляет общий сервер сам.

Node фиксируется в `.node-version`, `package.json#engines` и Dockerfile. pnpm —
в `package.json#packageManager`. NPM-зависимости фиксируются точными версиями в
`package.json` и `pnpm-lock.yaml`. Docker/Kafka/PostgreSQL images фиксируются в
`config/toolchain-versions.json` и Compose.

Обновление любой версии выполняется отдельной веткой `chore/<issue>-upgrade-*`
от `develop`, отдельным русскоязычным issue и PR. В PR обязательны ссылки на
release notes, regenerated lockfile/SBOM, clean install, typecheck, tests,
Compose smoke и rollback на прежний pin.

## 6. Первичные источники версии

- [Релизы Node.js](https://nodejs.org/en/blog/release)
- [Node.js 26.0.0 и новые возможности](https://nodejs.org/en/blog/release/v26.0.0)
- [Permission Model Node.js 26](https://nodejs.org/api/permissions.html)
- [Документация Fastify 5](https://fastify.dev/docs/v5.7.x/)
- [Версии React](https://react.dev/versions)
- [Apache Kafka 4.3](https://kafka.apache.org/43/)
- [Загрузки Apache Kafka](https://kafka.apache.org/community/downloads/)
- [Документация PostgreSQL 17.11](https://www.postgresql.org/docs/17/)
- [OpenAPI 3.2.0](https://spec.openapis.org/oas/v3.2.0.html)
- [TypeScript](https://www.typescriptlang.org/)
- [SOPS releases](https://github.com/getsops/sops/releases)
- [age releases](https://github.com/FiloSottile/age/releases)
