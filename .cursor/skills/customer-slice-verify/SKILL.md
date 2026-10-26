---
name: customer-slice-verify
description: Проверить customer-service живым прогоном против его PostgreSQL, а не только unit-тестами. Use when a change to customer HTTP, customer migrations, or the customer database boundary must be shown working end to end.
---

# Проверка среза customer-service

Срез один: процесс `customer-service` и база `coffee_platform_customer`.
Рычаг поднимает их с пустыми данными, вызывает реальный HTTPS-контракт и
сверяет строки владельца. Каталог, заказы, Kafka, nginx и api-public этим
прогоном не покрываются.

Запускать после изменений `apps/customer-service`, его миграций или контракта
`client-v1` customers. Не запускать вместо unit-тестов и не направлять на уже
работающие контейнеры.

## Запуск

Из корня репозитория:

```bash
node tools/grokverify-customer.mjs
```

Нужны Node 26.8.1, pnpm и Docker. Скрипт сам ставит зависимости и собирает
`apps/customer-service`, если `dist` ещё нет. Порт выбирается из 18410–18480
на `127.0.0.1`. Postgres наружу не публикуется. Проект Compose называется
`grokverify-customer-<run-id>`.

Повторный запуск создаёт новый run-id и новую пустую базу. Код выхода `0` —
все покрытые сценарии прошли. `1` — сбой. Контейнеры, сеть и tmpfs этого
run-id удаляются в конце, в том числе после ошибки.

Если процесс убили до очистки:

```bash
node tools/grokverify-customer.mjs --down <run-id>
```

`--down` удаляет только контейнеры, сеть и тома с меткой
`com.coffee.grokverify=customer` и этим run-id. Чужие Docker-объекты не
трогает. Глобальный `docker prune` не использовать.

## Как читать результат

Каталог `evidence/grokverify/<run-id>/` в git не входит.

- `result.json` — `status` и сценарии. Это итог.
- `http.ndjson` — метод, путь, статус и тело. Заголовков доверия там нет.
- `db.json` — счётчики строк после сценариев и совпал ли email. Самого email в этом файле нет.
- `service.log` — stdout сервиса после вырезания ключевого материала.
- `run.json` — имена контейнеров и порт, без паролей.

`pass` при пустой базе и нулевых счётчиках до создания, одной строке клиента,
одной записи аудита и одной завершённой идемпотентности после создания и
после повторного email. Отличие от этого — отказ сценария, даже если HTTP-код
«похож».

Состав файлов, метки и как добавить сценарий — в [reference.md](reference.md).

## Карта сценариев

| Сценарий | Статус |
|---|---|
| Пустая база: сервис готов, поиск ничего не находит | covered |
| Создание клиента сохраняет строку владельца | covered |
| Поиск по имени возвращает этого клиента | covered |
| Повтор того же создания не создаёт вторую строку | covered |
| Тот же email повторно отклоняется | covered |
| Внутренний order-input для Orders | not covered |

В создание входят и отказы: нет клиентского сертификата, сертификат другого
сервиса, нет actor context, пустое тело. Они не пишут строки.

## Чего этот срез не делает

Не поднимает api-public, edge-nginx, каталог, цены, заказы, Kafka и AROMA.
Не проверяет пагинацию курсором, адрес доставки и internal order-input.
Не заменяет `pnpm test:customer-integration` и launch gate.
