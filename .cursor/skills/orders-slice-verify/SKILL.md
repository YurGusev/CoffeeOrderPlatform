---
name: orders-slice-verify
description: Проверить orders-service живым прогоном против его PostgreSQL и Kafka, а не только unit-тестами. Use when a change to orders HTTP, orders migrations, or the orders database boundary must be shown working end to end.
---

# Проверка среза orders-service

Срез один: процесс `orders-service`, база `coffee_platform_orders` и брокер
Kafka, в который этот процесс публикует outbox. Рычаг поднимает их с пустыми
данными, вызывает реальный mTLS-контракт и сверяет строки владельца и
доставку `OrderConfirmed.v1`.

Запускать после изменений `apps/orders-service`, его миграций или контракта
`orders-v1`. Не запускать вместо unit-тестов и не направлять на уже
работающие контейнеры.

Жизненный цикл, идемпотентность команд и граница Desired/Observed описаны в
[orders-lifecycle](../../../.agents/skills/orders-lifecycle/SKILL.md).
Доставка outbox описана в
[event-driven-services](../../../.agents/skills/event-driven-services/SKILL.md).
Миграции и роль базы описаны в
[postgres-service-ownership](../../../.agents/skills/postgres-service-ownership/SKILL.md).
HTTP и trust surface описаны в
[http-api-contracts](../../../.agents/skills/http-api-contracts/SKILL.md).
Процесс, deadline и readiness описаны в
[node-service-runtime](../../../.agents/skills/node-service-runtime/SKILL.md).
Отказы, восстановление и SLO описаны в
[reliability-verification](../../../.agents/skills/reliability-verification/SKILL.md).
Этот рычаг их не повторяет.

## Launch

Из корня репозитория:

```bash
node .cursor/skills/orders-slice-verify/run.mjs
```

Нужны Node 26.8.1, pnpm, Docker, `openssl`, `keytool`, `python3`, `make` и
`g++`. Перед контейнерами скрипт запускает инкрементальный
`tsc -b apps/orders-service`. Процесс `orders-service` в сети Compose
запускает тот же бинарник Node, которым запущен скрипт, через
`/lib64/ld-linux-x86-64.so.2` и `/lib/x86_64-linux-gnu` хоста. Так нативный
модуль `@confluentinc/kafka-javascript`, собранный этим Node, загружается
рядом с Postgres и Kafka. Образ `node:26.8.1-bookworm-slim` остаётся у
фикстуры `api-internal`. Если модуль ещё не загружается, скрипт один раз
собирает уже объявленную зависимость на хосте. На время сборки `PATH`
начинается с каталога навыка: `ar-mri` прячет `+` в путях pnpm от `ar -M`.
Новую зависимость он не добавляет.

Порт сервиса выбирается из 18510–18580 на `127.0.0.1`. Postgres и Kafka
наружу не публикуются. Проект Compose называется
`orders-slice-verify-<run-id>`. Секреты прогона пишутся только в проверенный
tmpfs `/dev/shm`.

Готовность наступает, когда `GET /health/ready` возвращает 200 `ready` и
`runtime` равен `orders-service`. Для этого уже живы Postgres с применёнными
миграциями, брокер SASL_SSL и фикстура `api-internal`.

Повторный запуск создаёт новый run-id и новую пустую базу. Код выхода `0`
значит, что все обязательные сценарии прошли. Код `1` значит сбой. Контейнеры,
сеть и tmpfs этого run-id удаляются в конце, в том числе после ошибки.
Каталог evidence остаётся.

## Doctor

Doctor выполняется внутри того же запуска, до сценариев. Отдельной команды нет.
Смотреть `evidence/orders-slice-verify/<run-id>/doctor.json`.

Прогон стоит продолжать только если одновременно верно всё ниже.

- `httpStatus` равен 200.
- `runtime` равен `orders-service`.
- `readyStatus` равен `ready`.
- `portOwned` равен true. Слушает контейнер с меткой этого run-id.

Если doctor не сошёлся, сценарии не запускаются, в `result.json` статус `fail`.

## Drive

Клиент говорит с сервисом по mTLS от имени `api-public`. Заголовок
`x-actor-context` подписан ключом этого прогона. Идентификаторы клиента,
товара и котировки взяты из `tests/orders/upstream-clients.test.mjs`.

Фикстура `api-internal` отвечает только на `GET /health/ready`,
`GET /api/internal-v1/customers/:customerRef/order-input` и
`POST /api/internal-v1/pricing/quotes:verify`. Это не Customer, не Pricing и
не поставщик. Aroma и TastyCoffee скрипт не вызывает.

Обязательные сценарии идут по порядку. Сбой останавливает следующие и
помечает их `not-run`. Непокрытые сценарии код `0` не превращают в код `1`.

| Сценарий | Что обязано совпасть |
|---|---|
| `empty-ready` | сервис готов, в базе нет заказов, позиций, идемпотентности и outbox |
| `create-draft` | без клиентского сертификата соединение рвётся; чужой сертификат и запрос без actor context → 401; `{}` → 400; затем 201, одна строка `Draft` версии `1` |
| `replay-draft` | тот же ключ и то же тело → 201 и `idempotency-replayed: true`; другое тело → 409 `IDEMPOTENCY_CONFLICT`; строка одна |
| `put-item` | 200, одна позиция, имя из фикстуры цены |
| `get-card` | тот же `orderRef`, `Draft`, одна позиция, `aroma.state` равен `NotRequested` |
| `delete-item` | 200, позиций нет, outbox пуст |
| `confirm-empty` | 422 `ORDER_EMPTY`, статус остаётся `Draft`, новая строка идемпотентности не остаётся |
| `confirm-order` | 200 `Confirmed`; повтор того же ключа помечен replay; другое тело → 409; outbox `OrderConfirmed.v1` в состоянии `Published`; то же сообщение читается из `coffee.orders.lifecycle.v1` |
| `reconcile-blocked` | 409 `AROMA_RECONCILIATION_NOT_ALLOWED`; второй записи outbox нет |

## Evidence

Каталог `evidence/orders-slice-verify/<run-id>/` в git не входит. Очистка его не удаляет.

- `result.json` хранит `status`, `passed`, `failed`, `notCovered` и сценарии. `pass` пишется только когда все обязательные сценарии уже прошли. Промежуточная запись имеет статус `incomplete`. Сбой имеет статус `fail`.
- `http.ndjson` хранит метод, путь, статус и тело. Заголовков доверия там нет.
- `db.json` хранит счётчики строк, статус заказа, тип outbox и совпало ли сообщение Kafka с `orderRef`.
- `doctor.json`, `run.json`, `environment.json`, `service.log`, `fixture.log` и `kafka.log` описывают процесс, порт и commit. Паролей в них нет.

`pass` при одном подтверждённом заказе и одном опубликованном `OrderConfirmed.v1` не доказывает успешную сверку, inbox, `/health/live` и `/metrics`.

## Cleanup

Скрипт в `finally` удаляет контейнеры, сеть и тома только с меткой
`com.coffee.slice=orders` и этим run-id. Чужой Docker-объект не удаляет.
Глобальный `docker prune` не использовать.

Если процесс убили до очистки:

```bash
node .cursor/skills/orders-slice-verify/run.mjs --down <run-id>
```

Evidence остаётся на месте.

## Helpers

Исполняемый файл `.cursor/skills/orders-slice-verify/run.mjs`.
Фикстура внутреннего API лежит рядом в `internal-fixture.mjs` и запускается
только контейнером этого прогона.

```bash
node .cursor/skills/orders-slice-verify/run.mjs
node .cursor/skills/orders-slice-verify/run.mjs --down <run-id>
```

| Код | Значение |
|---|---|
| 0 | обязательные сценарии прошли, срез удалён, evidence на месте |
| 1 | старт, doctor, сценарий или аргументы не прошли; свой срез удалён, если успел подняться |

## Карта сценариев

| Сценарий | Статус |
|---|---|
| Пустая база и готовность | проверяется навыком |
| Создание черновика и отказы доверия | проверяется навыком |
| Повтор создания и конфликт идемпотентности | проверяется навыком |
| Запись позиции | проверяется навыком |
| Чтение карточки | проверяется навыком |
| Удаление позиции | проверяется навыком |
| Отказ подтвердить пустой черновик | проверяется навыком |
| Подтверждение, повтор команды и `OrderConfirmed.v1` в Kafka | проверяется навыком |
| Отказ сверки до наблюдения | проверяется навыком |
| Успешный запрос сверки и `OrderReconciliationRequested.v1` | не покрыто |
| `GET /health/live` | не покрыто |
| `GET /metrics` | не покрыто |
| Разбор inbox | не покрыто |

Идентификаторы лежат в `run.mjs` и в файлах `features/`. Когда маршрут в коде
изменился, карту правит следующий прогон `maintain-verification-skill`. Этот
рычаг сам карту не переписывает.

## Чего этот срез не делает

Не поднимает api-public, edge-nginx, Customer, Catalog, Pricing, Aroma Gateway
и TastyCoffee. Не подтверждает заказ у поставщика. Не заменяет
`pnpm test` и launch gate.
