# Срез customer-service: справочник

## Граница

Один процесс `customer-service` (`node apps/customer-service/dist/main.js`) и
одна база `coffee_platform_customer`. Имя базы и порт `4101` читаются из
`config/platform.yaml`. Хост Postgres в конфиге зафиксирован как
`coffee_postgres`; рычаг даёт это имя алиасом в своей сети, а не записью в
`/etc/hosts` и не портом `5432` хоста.

Роль runtime берётся из `GRANT USAGE ON SCHEMA customer TO ...` в миграциях.
Пароль роли и ключи mTLS создаются на прогон, пишутся в каталог
`/tmp/grokverify-customer-<run-id>/` с режимом `0400` и удаляются при
остановке. В evidence их нет.

## Команда

```bash
node tools/grokverify-customer.mjs
node tools/grokverify-customer.mjs --keep
node tools/grokverify-customer.mjs --down <run-id>
```

| Код | Значение |
|---|---|
| 0 | покрытые сценарии прошли, срез удалён |
| 1 | сценарий, старт или аргументы не прошли; если контейнеры успели появиться, срез удалён |

`--keep` оставляет контейнеры. Перед следующим обычным запуском его не
обязательно гасить: у нового прогона другое имя. Оставленный прогон всё равно
нужно снять `--down`, чтобы не занимать память.

run-id имеет вид `20261026t102400z-ab12cd`.

## Docker

| Объект | Имя |
|---|---|
| проект Compose | `grokverify-customer-<run-id>` |
| сеть | `grokverify-customer-<run-id>-net` |
| Postgres | `grokverify-customer-<run-id>-postgres` |
| сервис | `grokverify-customer-<run-id>-customer` |

Метки: `com.coffee.grokverify=customer`, `com.coffee.grokverify.run=<run-id>`.
Данные Postgres лежат в tmpfs `PGDATA=/var/lib/postgresql/grokverify`.
Порт сервиса: `127.0.0.1:<18410-18480> → 4101`. Порт Postgres не публикуется.

Образы закреплены в `tools/grokverify-customer.mjs`: Postgres 17.11-alpine и
Node 26.8.1-bookworm-slim с теми же digest, что toolchain. Рычаг не удаляет
образы и не делает `docker prune`.

## Evidence

`evidence/grokverify/` в `.gitignore`.

| Файл | Содержимое |
|---|---|
| `result.json` | `status`: `pass` или `fail`; список сценариев |
| `http.ndjson` | одна строка на запрос: scenario, method, path, status, request, response |
| `db.json` | после сценария: customers, audits, idempotencyCompleted, idempotencyRows, customerRef, status, version, emailMatches |
| `service.log` | журнал процесса после удаления PEM и паролей |
| `environment.json` | образы, порт, commit, dirty |
| `run.json` | имена контейнеров для `--down` |

`emailMatches: true` значит, что нормализованный email строки совпал с телом
создания. Сам адрес в `db.json` не пишется. В `http.ndjson` адрес тестовый,
вида `grok-<suffix>@example.test`.

Первые строки `startup` с `ECONNRESET` — опрос `GET /health/ready` до того,
как порт принял TLS. В `service.log` ожидается `OTEL_EXPORT_FAILED`:
коллектора в этом срезе нет, экспорт телеметрии best-effort. Итог прогона —
`status` в `result.json`, не отсутствие этого предупреждения.

## Сценарии скрипта

| id | Что утверждается |
|---|---|
| `empty-ready` | `GET /health/ready` → 200 `ready`; поиск по имени → `items: []`; в базе 0 строк |
| `create-customer` | без клиентского сертификата соединение рвётся; чужой SPIFFE и запрос без actor context → 401 `AUTHENTICATION_REQUIRED`; `{}` → 400 `VALIDATION_FAILED`; затем `POST /api/client-v1/customers` → 201, одна строка `Active`, один audit, одна Completed-идемпотентность |
| `search-customer` | тот же `customerRef`, email и телефон в ответе маскированы, `nextCursor: null` |
| `replay-create` | тот же ключ и то же тело → 201 и `idempotency-replayed: true`; другое тело с тем же ключом → 409 `IDEMPOTENCY_CONFLICT`; строка одна |
| `duplicate-email` | новый ключ, тот же email, другой телефон → 409 `CUSTOMER_EMAIL_CONFLICT`; строка одна |
| `order-input` | в скрипте не исполняется, в `result.json` стоит `not-covered` |

## Как расширять

Новый SQL в `apps/customer-service/migrations/` подхватывается по имени файла
на пустой базе. Роль в `GRANT USAGE ON SCHEMA customer` должна существовать
одной строкой, её создаёт рычаг до применения файлов.

Новый сценарий — функция рядом с `search-customer` в
`tools/grokverify-customer.mjs` и строка в карте `SKILL.md`. Сценарий обязан
проверять и HTTP, и `db.json`. Не добавлять второй сервис и не подключаться к
чужой сети или к `coffee_postgres` на хосте.

Следующая граница, когда этот срез уже зелёный: `api-internal` →
`GET /api/internal-v1/customers/:customerRef/order-input`. Это отдельный рычаг,
не разрастание текущего до всего launch gate.
