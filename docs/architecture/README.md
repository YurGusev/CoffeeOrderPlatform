---
type: architecture
project: CoffeeOrderPlatform
status: reference
verified: 2026-09-22
source: "Локальный репозиторий; точные файлы и строки указаны в тексте"
---
# Атлас архитектуры CoffeeOrderPlatform

[Документы первого запуска](../launch/README.md) · [Источники и проверка](11_%D0%98%D1%81%D1%82%D0%BE%D1%87%D0%BD%D0%B8%D0%BA%D0%B8%20%D0%B8%20%D0%BF%D1%80%D0%BE%D0%B2%D0%B5%D1%80%D0%BA%D0%B0.md)

## Область и точность среза

Это подробная архитектурная карта **новой CoffeeOrderPlatform**, а не миграционный план CoffeeOrderSystem и не копия всего репозитория. Здесь собраны границы сервисов, бизнес-сценарии, runtime composition, физические SQL-схемы и логические ссылки, HTTP/Kafka/SSE, протокол AROMA, безопасная сходимость корзины, frontend/каналы, инфраструктура и проверки.

- Источник: GitHub `YurGusev/CoffeeOrderPlatform`.
- Accepted base: `4b2cad1dab30af66ad0b2fe64da280222e506574` (`develop`).
- Дата исследования: **22 сентября 2026 года (+05)**.
- При публикации все 173 источника сверены с accepted base. Из исходного рабочего среза исключена локальная дополнительная строка навигации `docs/launch/README.md`; номера строк и hash этого файла приведены к accepted base. Остальные 172 файла совпадают побайтно.
- Личные заметки, настройки Obsidian/Hermes, пользовательские макеты и незакоммиченные навыки не публикуются.
- Manifest относится к исходным файлам accepted base, а не к self commit публикуемого атласа. Атлас — производное описание; код, контракты и нормативные документы сохраняют authority.
- Это source-level исследование. Наличие таблицы в SQL не утверждает, что она создана на сервере. Наличие handler не подтверждает runtime acceptance. Status `reference` в frontmatter не означает product PASS.

## Как читать статусы

| Обозначение в тексте | Значение |
|---|---|
| `implemented-in-code`, «материализовано» | Найден конкретный код, SQL или контракт. Проверено существование и содержание; не обязательно запуск |
| `contract-only` | Есть wire-schema/каталог, но бизнес-handler или собранный путь не подтверждён |
| `stub`, `scaffold` | Есть composition root/health/заглушка, но не ожидаемое business behavior |
| `spec`, `planned` | Нормативный или будущий путь без подтверждённой реализации |
| `historical evidence` | Сохранённый отчёт прошлого запуска, применим только к его SHA/окружению |
| `unknown`, «не проверено» | Источников или текущей проверки недостаточно |

Не смешивать эти статусы в одной диаграмме без легенды. Отдельно различать **бизнес-владельца**, **runtime**, **DB owner**, **SQL schema**, **DB role** и **доступ transport caller**: эти множества не совпадают.

## Состав атласа

| Глава | Что в ней искать |
|---|---|
| [01_Границы и runtime](01_%D0%93%D1%80%D0%B0%D0%BD%D0%B8%D1%86%D1%8B%20%D0%B8%20runtime.md) | Bounded contexts, 15 launch runtime, composition roots, код против каркасов |
| [02_Бизнес-сценарии](02_%D0%91%D0%B8%D0%B7%D0%BD%D0%B5%D1%81-%D1%81%D1%86%D0%B5%D0%BD%D0%B0%D1%80%D0%B8%D0%B8.md) | Customer → Catalog → PricingQuote → Draft/Confirm, Orders, вторая волна |
| [03_Данные и владение](03_%D0%94%D0%B0%D0%BD%D0%BD%D1%8B%D0%B5%20%D0%B8%20%D0%B2%D0%BB%D0%B0%D0%B4%D0%B5%D0%BD%D0%B8%D0%B5.md) | Пять owner DB, роли, writers, ограничения SQL, pool и transaction guarantees |
| [04_Схема PostgreSQL](04_%D0%A1%D1%85%D0%B5%D0%BC%D0%B0%20PostgreSQL.md) | Фактические migrations, таблицы, ключи, constraints, индексы, физические ER-связи |
| [05_HTTP и события](05_HTTP%20%D0%B8%20%D1%81%D0%BE%D0%B1%D1%8B%D1%82%D0%B8%D1%8F.md) | Routes и trust surfaces, schema/catalog, Kafka contracts, Inbox/Outbox, SSE |
| [06_Frontend и каналы](06_Frontend%20%D0%B8%20%D0%BA%D0%B0%D0%BD%D0%B0%D0%BB%D1%8B.md) | React/client-v1/server-state/allowedActions, текущий web и планы каналов |
| [07_AROMA протокол](07_AROMA%20%D0%BF%D1%80%D0%BE%D1%82%D0%BE%D0%BA%D0%BE%D0%BB.md) | Session/login, export/catalog, source identity, grind/packing, safe reads и mutations |
| [08_AROMA сходимость](08_AROMA%20%D1%81%D1%85%D0%BE%D0%B4%D0%B8%D0%BC%D0%BE%D1%81%D1%82%D1%8C.md) | Desired/Observed, lease/fence, Attempt/Reservation, journal и UnknownOutcome |
| [09_Инфраструктура и безопасность](09_%D0%98%D0%BD%D1%84%D1%80%D0%B0%D1%81%D1%82%D1%80%D1%83%D0%BA%D1%82%D1%83%D1%80%D0%B0%20%D0%B8%20%D0%B1%D0%B5%D0%B7%D0%BE%D0%BF%D0%B0%D1%81%D0%BD%D0%BE%D1%81%D1%82%D1%8C.md) | Compose, сети, TLS/mTLS, secrets, permissions, pinned build и runtime budgets |
| [10_Надёжность и приёмка](10_%D0%9D%D0%B0%D0%B4%D1%91%D0%B6%D0%BD%D0%BE%D1%81%D1%82%D1%8C%20%D0%B8%20%D0%BF%D1%80%D0%B8%D1%91%D0%BC%D0%BA%D0%B0.md) | Lifecycle, recovery, telemetry, G00–G19, sandbox/backup/rollback |
| [11_Источники и проверка](11_%D0%98%D1%81%D1%82%D0%BE%D1%87%D0%BD%D0%B8%D0%BA%D0%B8%20%D0%B8%20%D0%BF%D1%80%D0%BE%D0%B2%D0%B5%D1%80%D0%BA%D0%B0.md) | Источники с hashes, структурированные inventories, воспроизводимая проверка и обновление |
| [12_Расхождения и незавершённое](12_%D0%A0%D0%B0%D1%81%D1%85%D0%BE%D0%B6%D0%B4%D0%B5%D0%BD%D0%B8%D1%8F%20%D0%B8%20%D0%BD%D0%B5%D0%B7%D0%B0%D0%B2%D0%B5%D1%80%D1%88%D1%91%D0%BD%D0%BD%D0%BE%D0%B5.md) | Найденные несовпадения спецификаций и кода, ограничения полноты |

## Архитектура в одном чтении

1. **PostgreSQL хранит бизнес-истину**, а каждый bounded context владеет своим изменяемым состоянием и восстановлением. Общий PostgreSQL server не разрешает межвладельческий SQL.
2. **HTTP обслуживает немедленные операции**, Kafka — долговечные asynchronous commands/events; Inbox/Outbox защищают эффекты при повторной доставке. SSE — сигнал перечитать ресурс, а не источник истины.
3. **Customer, Catalog, Pricing и Orders — разные владельцы.** PricingQuote фиксирует расчёт; Orders владеет подтверждением и business intent, а не перекладывает его на UI.
4. **AROMA Gateway владеет provider transport**, sessions, bindings и integration operation journal. **Orders владеет convergence** физической корзины к Desired. Сеть и название `aroma-*` не превращают workers в владельцев Integration DB.
5. **Provider timeout не доказывает отсутствия эффекта.** Fresh complete GET, fencing, reservation и journal нужны именно против повторной небезопасной мутации и stale writers.
6. **UI работает с client-v1 и server state**, показывает allowedActions и конфликты; не воспроизводит business rules и не ходит напрямую в AROMA/owner SQL.
7. **Конфигурация и secrets централизованы по authority, но распределены по доступу**: runtime получает только свою materialization. Public, agent, internal, webhook, realtime и provider surfaces разделяются явно.

Эти опорные правила задаёт `AGENTS.md`; прикладное развитие — `docs/launch/README.md:11-21,58-90`. Главы ниже проверяют, что из них материализовано в данном дереве.

## Authority и исторические границы

Операционная authority — GitHub `YurGusev/CoffeeOrderPlatform`, ADR-0021. `develop` — постоянная база разработки; `main` — стабильная линия. Runtime technology authority — ADR-0025, которая supersede-ит Effect-направление ADR-0024/#48–#55; toolchain/codegen authority — ADR-0022 с конкретными поздними исключениями. Нельзя выдавать исторические ADR за действующее решение только потому, что файл существует.

Пять canonical revision roots сохраняют исходный язык и контрольные суммы. Их названия с CoffeeOrderSystem — происхождение спецификаций, а не разрешение на импорт legacy runtime или DB-моделей. Новые исполнимые решения живут в обычных русских ADR, service/platform/launch документах. Источники: `AGENTS.md`; `docs/launch/README.md:57-89`.

Реализация идёт по `docs/launch/13_DELIVERY_DEPENDENCY_GRAPH.md`, а не по наличию запускаемого скелета. В частности foundation #3 или recovery #60 не равны завершённым durable guarantees и полной первой вертикали. Номера issue здесь — навигация в документах среза; актуальное remote-состояние повторно проверяется в GitHub.

## Использование и актуализация

При вопросе о БД читать главы 03–04 и соответствующие migrations; о провайдере — 07–08; о UI — 06 и UX authority. Не загружать все главы в каждый чат. Перед изменением поведения сверять исходники и hashes: атлас помогает найти authority, но не подменяет её.

После значимого изменения обновлять затронутую главу, её доказательства и взаимные связи в том же рабочем цикле. Детальная процедура — [11_Источники и проверка](11_%D0%98%D1%81%D1%82%D0%BE%D1%87%D0%BD%D0%B8%D0%BA%D0%B8%20%D0%B8%20%D0%BF%D1%80%D0%BE%D0%B2%D0%B5%D1%80%D0%BA%D0%B0.md). Пользовательская приёмка не заменяется автоматическими PASS.
