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
| `coffee_platform_catalog` | `catalog_migrator` | `catalog-service` (read-only), `catalog-supplier-sync` (staging writer), `catalog-activation-worker` (active/Outbox writer) через отдельные роли |
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

## 3. Canonical toolchain registry

Exact runtime, package, image and tool pins имеют единственный authoring source:
`config/toolchain-versions.json`. Этот документ и compatibility matrix содержат
только проверяемые refs/projections; manifests, lockfile и images обязаны
materialize registry без собственных choices. Foundation ссылается на registry
через `runtime.*Ref`, `productionImage.referenceRef` и
`effectPlatformDecision.bomRef`.

Registry включает сохранённые Node/TypeScript/Oxlint/PostgreSQL/Kafka/React/Vite/
Vitest/Playwright pins и Effect package BOM. Диапазоны и `latest` запрещены.
OpenAPI generated artifact имеет версию 3.1; его source — Effect Schema/HttpApi.
Effect upgrades выполняются отдельным platform-only issue/PR без business changes.

`config/node26-compatibility-matrix.json` проверяет platform/runtime probes и
каждый package через `registryRef`; numeric version map в matrix запрещён.
`config/toolchain-versions.schema.json` проверяет структуру и формат, а не
дублирует exact pins.

## 4. Effect-native runtime baseline

- Backend использует ESM/erasable TypeScript и owner-local Effect composition.
- Process roots запускают `NodeRuntime`, `Layer.launch` и `Scope`; resources
  освобождаются scope finalizers.
- Request/event/config/provider data декодируются Effect Schema.
- HTTP строится на `HttpApi`/`HttpRouter`/`HttpClient`; events и SSE используют
  bounded Effect Streams.
- PostgreSQL application access идёт через `@effect/sql-pg` и Coffee
  transaction policy; durable state не заменяется process-local memory.
- Kafka driver скрыт в `platform-kafka-runtime`; offsets подтверждаются после
  durable DB outcome.
- Browser remote state использует `@effect/atom-react`/`AtomHttpApi`; frames
  SSE только инвалидируют resource и запускают refetch.
- Permission Model, scoped tmpfs secrets, network segmentation и non-root
  containers сохраняются.

## 5. Parameter authority

- Fixed topology, ownership, trust и network claims принадлежат service/DB/
  interaction/connectivity manifests.
- Mutable non-secret runtime values принадлежат только `config/platform.yaml`,
  валидируемому `config/platform.schema.json`.
- Secret values принадлежат только encrypted
  `secrets/platform.secrets.sops.yaml`; runtime получает scoped `secretRefs`.
- Exact versions принадлежат только `config/toolchain-versions.json`; manifests,
  overrides, lockfile и compatibility matrix — materialized projections.
- `docs/launch/23_RUNTIME_CONFIGURATION_MATRIX.md` ссылается на config и
  registry и не создаёт скрытых defaults.
- `.env`, service-local config и скрытые runtime defaults запрещены.
- Effect peer policy: Redis не устанавливается и `NodeRedis` не импортируется;
  accepted non-optional peer остаётся единственным documented exception.
- Contract/API/event payloads и DB schemas/roles не изменяются этой authority task.

## 6. Проверяемые источники

- [ADR-0024 Effect-native platform](../adr/ADR-0024-effect-native-platform.md)
- [ADR-0019 runtime/topology](../adr/ADR-0019-greenfield-node26-and-service-topology.md)
- [ADR-0022 TS7-native toolchain](../adr/ADR-0022-ts7-native-toolchain.md)
- [toolchain registry](../../config/toolchain-versions.json)
- [compatibility matrix](../../config/node26-compatibility-matrix.json)
