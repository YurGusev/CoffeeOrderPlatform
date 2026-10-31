---
name: catalog-slice-verify
description: Проверить catalog-service живым прогоном против его PostgreSQL и локального Kafka, а не только unit-тестами. Use when a change to catalog HTTP, catalog migrations, or the catalog database boundary must be shown working end to end.
---

# Проверка среза catalog-service

Срез один: процесс `catalog-service` и база `coffee_platform_catalog`.
Рычаг поднимает их с пустыми данными, вызывает реальный HTTPS-контракт
`packages/contracts/catalog-v1` и сверяет строки владельца. Локальный брокер
Kafka нужен только чтобы увидеть, что этот процесс не публикует и не читает
события. Поставщик, `catalog-supplier-sync` и `catalog-activation-worker` не
поднимаются.

Запускать после изменений `apps/catalog-service`, его миграций или контракта
каталога. Не запускать вместо unit-тестов и не направлять на уже работающие
контейнеры.

Правки поведения остаются в навыках
[customer-catalog-pricing](../../../.agents/skills/customer-catalog-pricing/SKILL.md),
[http-api-contracts](../../../.agents/skills/http-api-contracts/SKILL.md),
[postgres-service-ownership](../../../.agents/skills/postgres-service-ownership/SKILL.md),
[event-driven-services](../../../.agents/skills/event-driven-services/SKILL.md),
[node-service-runtime](../../../.agents/skills/node-service-runtime/SKILL.md)
и [reliability-verification](../../../.agents/skills/reliability-verification/SKILL.md).
Карта строк лежит в
[backend-feature-map](../backend-feature-map/features/catalog-service.md).

## Launch

Из корня репозитория:

```bash
node .cursor/skills/catalog-slice-verify/run.mjs
```

Нужны Node из toolchain, pnpm, Docker и уже установленные зависимости, включая
`js-yaml`. Скрипт не запускает `pnpm install` и не пересобирает
`@confluentinc/kafka-javascript`. Перед контейнерами он каждый раз запускает
инкрементальный `tsc -b apps/catalog-service`.

Порт сервиса выбирается из 18510–18580 на `127.0.0.1` и пробрасывается в `4102`.
Postgres и Kafka наружу не публикуются. Имя Postgres в сети среза —
`coffee_postgres`, как в `config/platform.yaml`. Проект Compose называется
`catalog-slice-verify-<run-id>`. Секреты прогона пишутся только в проверенный
tmpfs `/dev/shm`. Образы PostgreSQL, Node и Kafka читаются из `config/toolchain-versions.json`.
Node-контейнер использует UID/GID запускающего пользователя; созданные файлы
секретов сохраняют владельца и права `0400`.
Слушатель брокера внутри сети — PLAINTEXT. У `catalog-service` в конфиге
`kafka.producers` и `kafka.consumers` пустые, клиент к брокеру процесс не
открывает. Платформенный SASL_SSL этот срез не воспроизводит.

Повторный запуск создаёт новый run-id и новую пустую базу. Код выхода `0` —
все исполняемые сценарии прошли. `not-covered` код не меняет. Код `1` — сбой
старта или сценария. Контейнеры, сеть и tmpfs этого run-id удаляются в конце,
в том числе после ошибки. Evidence остаётся.

Если процесс убили до очистки:

```bash
node .cursor/skills/catalog-slice-verify/run.mjs --down <run-id>
```

`--down` удаляет только контейнеры, сеть и тома с меткой `com.coffee.slice=catalog`
и этим run-id. Чужие Docker-объекты не трогает.

## Doctor

Doctor выполняется внутри того же запуска, до сценариев. Отдельной команды нет.
Смотреть `evidence/catalog-slice-verify/<run-id>/doctor.json`.

Прогон стоит продолжать только если одновременно верно всё ниже.

- Слушает `127.0.0.1` и выбранный порт, контейнер этого run-id.
- Postgres `5432` и Kafka `9092` на хост не опубликованы.
- `GET /health/ready` уже вернул `200` и `runtime` `catalog-service`.

Если doctor не сошёлся, сценарии не исполняются. В `result.json` они получают
`not-covered`, старт получает `failed`.

## Drive

Клиент — HTTPS с mTLS. Сертификаты выпускает скрипт на один прогон. Поиск идёт
сертификатом `api-public` и подписанным `x-actor-context`. Pricing-input идёт
сертификатом `api-internal` и подписанным `x-service-delegation`. Подпись берётся
из `@coffee-platform/security`. Тело ответа сверяется с
`@coffee-platform/contracts-catalog-v1`.

Фикстура активного снимка вставляется в Postgres администратором прогона после
проверки пустой базы. Это не вызов поставщика. Имена фикстуры постоянные:
`Kenya Coffee` и `Kenya Filter`.

Пустой снимок на `GET /api/client-v1/catalog/products?query=kenya` обязан вернуть
`503` `CATALOG_SNAPSHOT_INCOMPLETE` и ноль строк `catalog.products`. После
фикстуры тот же запрос с `limit=1` возвращает первую позицию и курсор, повтор с
курсором — вторую и `nextCursor: null`. `availability=Stopped` возвращает пустой
список и ту же ревизию. Чужой сертификат, запрос без actor context, короткий
`query` и неверный курсор отвергаются и строк не пишут.

`GET /api/internal-v1/catalog/products/:productRef/variants/:variantRef/pricing-input`
для `pricing-service` и для `aroma-convergence` возвращает одну и ту же фикстуру.
Чужой вызывающий, сертификат `api-public`, запрос без делегации, неверная ссылка
и отсутствующий вариант отвергаются.

`GET /health/live`, `GET /health/ready` и `GET /metrics` вызываются отдельно.

## Evidence

Каталог `evidence/catalog-slice-verify/<run-id>/` в git не входит. Очистка его
не удаляет.

- `result.json` хранит `status`, `passed`, `failed`, `notCovered` и сценарии.
  У каждого сценария статус `passed`, `failed` или `not-covered`.
  `pass` пишется только когда все исполняемые сценарии уже прошли.
  Промежуточная запись имеет статус `incomplete`. Сбой имеет статус `fail`.
- `http.ndjson` — метод, путь, статус и тело. Заголовков доверия там нет.
- `db.json` — счётчики строк и offsets. Самих секретов нет.
- `doctor.json`, `run.json`, `environment.json`, `service.log`, `kafka.log`
  описывают процесс, порт и commit. PEM и пароли из журнала вырезаются.
  В `service.log` ожидается `OTEL_EXPORT_FAILED`: коллектора в этом срезе нет.

В stdout одна строка на сценарий и итоговая строка
`<run-id> <pass|fail> <n> passed, <n> failed, <n> not-covered`.

## Cleanup

Скрипт в `finally` останавливает только свой проект Compose и затем удаляет
контейнеры, сеть и тома с метками этого run-id. Чужой контейнер по имени
`postgres` или `kafka` не останавливается. Evidence остаётся на месте.

## Helpers

Исполняемый файл `.cursor/skills/catalog-slice-verify/run.mjs`.

```bash
node .cursor/skills/catalog-slice-verify/run.mjs
node .cursor/skills/catalog-slice-verify/run.mjs --down <run-id>
```

| Код | Значение |
|---|---|
| 0 | исполняемые сценарии прошли, срез этого run-id удалён, evidence на месте |
| 1 | старт, doctor, сценарий или аргументы не прошли; свой срез удалён, если успел подняться |

## Карта сценариев

| Сценарий | Что делает прогон |
|---|---|
| `health-live` | `GET /health/live` |
| `health-ready` | `GET /health/ready` |
| `metrics` | `GET /metrics` |
| `empty-search` | пустой снимок, поиск `503`, ноль строк |
| `search-rejected` | нет сертификата, чужой SPIFFE, нет actor context, короткий запрос, неверный курсор |
| `search-page` | фикстура, первая страница, курсор, фильтр `Stopped` |
| `pricing-rejected` | чужой транспорт, нет делегации, чужой вызывающий, неверная ссылка |
| `pricing-input` | `pricing-service`, `aroma-convergence`, отсутствующий вариант |
| `outbox-silent` | `catalog.outbox_messages` пуст, роль `coffee_catalog_api_ro` не может писать |
| `kafka-silent` | offsets `coffee.catalog.snapshot.v1` и `coffee.catalog.mapping.v2` остаются `0` |
| `event-catalog-snapshot-activated` | не исполняется |
| `event-catalog-mapping-changed` | не исполняется |

Идентификаторы лежат в `run.mjs`. Статус каждого прогона печатает команда выше.
Когда маршрут в коде изменился, строку карты правит тот же PR. Этот рычаг сам
карту не переписывает. Сверка карты с кодом описана в
[backend-feature-map](../backend-feature-map/SKILL.md).

## Чего этот срез не делает

Не вызывает AROMA и не поднимает импорт или активацию. Не публикует
`CatalogSnapshotActivated.v1` и `CatalogMappingChanged.v2`. Не заменяет
`tests/catalog/catalog-owner.test.mjs` и launch gate. Не объявляет deployment.
