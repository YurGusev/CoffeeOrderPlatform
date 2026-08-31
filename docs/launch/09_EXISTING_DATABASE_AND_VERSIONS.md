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

Для каждой БД создаются две роли: `<context>_migrator` для DDL и
`<runtime>_app` для runtime DML. Runtime-роль не получает `CREATEDB`,
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

Сейчас репозиторий не содержит package manifest или lockfile, поэтому точные
версии приложения ещё не являются исполнимыми pins. Таблица разделяет
подтверждённое окружение и **целевые кандидаты**, которые задача #3 обязана
проверить, записать в `config/toolchain-versions.json`, manifests и lockfile.
Только после успешного PR #3 кандидат становится утверждённым pin. В manifests
запрещены `latest`, `*`, `^` и `~`; images фиксируются также по digest.

| Компонент | Версия | Статус до PR #3 |
|---|---|---|
| PostgreSQL server | `17.11` (`17-alpine`) | подтверждено на хосте |
| Docker Engine | `29.7.2` | подтверждено на хосте |
| Docker Compose plugin | `5.4.0` | подтверждено на хосте |
| OpenAPI Specification | `3.1.0` | подтверждено каноническими контрактами |
| Node.js production | `24.20.0` LTS | целевой кандидат; проверить image digest |
| npm для Node.js | `11.19.0` | кандидат, зависит от Node image |
| Corepack | `0.35.0` | подтверждено foundation evidence; кандидат |
| pnpm | `11.22.0` | подтверждено foundation evidence; кандидат |
| TypeScript | `5.9.3` | подтверждено foundation evidence; кандидат |
| Fastify | `5.12.1` | целевой кандидат; требуется compatibility spike |
| `pg` | `8.23.0` | целевой кандидат |
| Apache Kafka broker | `4.3.1` KRaft | целевой кандидат; проверить `apache/kafka:4.3.1` и зафиксировать digest |
| `@confluentinc/kafka-javascript` | `1.10.0` | целевой кандидат; требуется compatibility spike |
| React / React DOM | `19.2.8` | подтверждено legacy UI, для нового frontend кандидат |
| React Router DOM | `7.18.3` | целевой кандидат |
| TanStack Query | `5.102.8` | целевой кандидат |
| Vite | `8.2.2` | целевой кандидат |
| Vitest | `4.1.10` | подтверждено legacy UI, для новой платформы кандидат |
| Playwright | `1.62.0` | подтверждено legacy UI, для новой платформы кандидат |
| `@fastify/swagger` | `9.8.1` | целевой кандидат |
| `openapi-typescript` | `7.13.0` | подтверждено legacy UI, кандидат |
| Spectral CLI | `6.16.3` | целевой кандидат |
| AJV | `8.20.0` | подтверждено foundation evidence; кандидат |
| Pino | `10.3.1` | целевой кандидат |
| OpenTelemetry API | `1.9.1` | целевой кандидат |
| Dependency Cruiser | `18.2.0` | целевой кандидат |
| ESLint | `10.9.1` | целевой кандидат |
| Prettier | `3.9.6` | подтверждено foundation evidence; кандидат |

Node фиксируется в `.node-version`, `package.json#engines` и Dockerfile. pnpm —
в `package.json#packageManager`. NPM-зависимости фиксируются точными версиями в
`package.json` и `pnpm-lock.yaml`. Docker/Kafka/PostgreSQL images фиксируются в
`config/toolchain-versions.json` и Compose.

Обновление любой версии выполняется отдельной веткой `chore/<issue>-upgrade-*`
от `develop`, отдельным русскоязычным issue и PR. В PR обязательны ссылки на
release notes, regenerated lockfile/SBOM, clean install, typecheck, tests,
Compose smoke и rollback на прежний pin.

## 4. Первичные источники версии

- [Архив Node.js 24](https://nodejs.org/en/download/archive/v24)
- [Документация Fastify 5](https://fastify.dev/docs/v5.7.x/)
- [Версии React](https://react.dev/versions)
- [Apache Kafka 4.3](https://kafka.apache.org/43/)
- [Загрузки Apache Kafka](https://kafka.apache.org/community/downloads/)
- [Документация PostgreSQL 17.11](https://www.postgresql.org/docs/17/)
- [Release notes TypeScript 5.9](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-9.html)
