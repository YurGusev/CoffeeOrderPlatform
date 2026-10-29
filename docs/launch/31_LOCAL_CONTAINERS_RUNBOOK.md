# Локальное управление контейнерами двух CoffeeOrder-систем

Команда `coffee-containers` установлена в `/home/yurgusev/.local/bin` ссылкой на
`tools/coffee-containers.sh`. Она выбирает **существующие** контейнеры по Compose
labels, независимо от рабочего каталога терминала и исходного worktree.
Она не выполняет `up`, сборки, миграции, deployment и не читает секреты.

| Группа     | Состав                                                  |
| ---------- | ------------------------------------------------------- |
| `platform` | Compose-проект `coffee-platform`                        |
| `legacy`   | `coffeeordersystem`, кроме общего PostgreSQL            |
| `db`       | Только `coffeeordersystem/postgres` (`coffee_postgres`) |
| `n8n`      | Compose-проект `n8n`                                    |
| `gitea`    | Compose-проект `gitea-test`                             |

```bash
coffee-containers legacy status
coffee-containers legacy stop
coffee-containers legacy start
coffee-containers platform status
```

`legacy start` запускает только существующий API; UI/ML и остальные отключённые
legacy-компоненты автоматически не включаются. Другие группы запускают все свои
существующие контейнеры. Если контейнеров нет, `start` завершается с ошибкой: новый
запуск выполняется отдельно из постоянного Compose-каталога после проверки
конфигурации и scoped secrets. Для платформы это `config-bootstrap` и tmpfs,
а не копирование общего SOPS-файла в контейнеры.

`remove` удаляет контейнеры группы только после их остановки. Все volumes и сети
сохраняются; writable layers контейнеров удаляются. В команду нельзя передать
`--volumes` или `--force`. Удаление/остановка `db` — отдельное явное действие:
PostgreSQL является зависимостью обеих систем. VPN/Tailscale и BuildKit не входят
в управляемые группы и при отключении Coffee-приложений остаются доступны.

## Постоянные окружения и тесты

Основная платформа запускается из `/home/yurgusev/CoffeeOrderPlatform/compose.yaml`
под именем `coffee-platform`. Основная legacy-система — из
`/home/yurgusev/CoffeeOrderSystem/docker-compose.yml` с текущим локальным override
под именем `coffeeordersystem`. Существующие legacy-контейнеры ещё могут иметь
labels от старых worktree/tmp-каталогов: их выравнивание требует отдельно
подготовленного пересоздания с проверкой конфигурации и сохранением volumes.
Команда управления не пересоздаёт их и не объявляет такое выравнивание выполненным.

Для #13 после готовности разработки требуется постоянная установка на этом
сервере с проверкой фактического состояния. Проверки disposable-окружения сами
по себе не подтверждают такую установку. Перед постоянной установкой требуется свежая проверка фактического состояния этого сервера.

При постоянной установке необходимо проверить identity выбранного PostgreSQL,
15 canonical ролей, пять `coffee_platform_*` БД и их владельцев, owner migration
ledgers и точные table/column grants. Затем проверить подключение PostgreSQL к
ожидаемой сети, scoped secrets в tmpfs, Kafka, health/readiness и ingress
постоянного проекта `coffee-platform`. Результат фиксируется отдельным
санитизированным attestation без паролей и строк подключения. Временные run DB,
контейнеры и volumes удаляются после проверок; постоянные роли, БД и ресурсы
установленной платформы сохраняются. Действующий legacy-сервис и его данные
не изменяются этим шагом.

`tools/compose-smoke.mjs` выбирает уникальное имя проекта; занятое имя и имена
основных Coffee-проектов запрещены. Все smoke-режимы используют project-scoped
сети; topology-only режим сохраняет pre-existing external PostgreSQL network,
а DB/provider proofs используют изолированную PostgreSQL-сеть и fixture-БД.
Kafka volume также project-scoped.

После обычного smoke-запуска удаляются его контейнеры/volumes и только runtime
image tags, успешно собранные этим запуском, в том числе при частичной ошибке
сборки. Общие nginx/base images и BuildKit cache сохраняются. `--keep` сохраняет
окружение и образы; `--no-build` не удаляет заимствованные образы. Image cleanup
не использует `--force`; если удалить образ нельзя, выводится предупреждение.

Незнакомые непустые volumes не очищать через общий `docker volume prune`.
Диски и их разделы этот workflow не меняет.
