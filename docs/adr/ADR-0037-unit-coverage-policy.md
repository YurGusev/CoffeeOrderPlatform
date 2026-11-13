# ADR-0037: Политика unit coverage критических модулей

- Статус: принято для `unit` первого запуска
- Дата: 2026-10-24
- Владелец: Platform и владельцы доменов

## Контекст

Гейт `unit` требует измеримого регрессионного сигнала для критического кода, однако
закрытые GitHub issues и архитектурные документы не задают принятого списка
модулей или порогов unit coverage. Глобальная доля может скрывать непокрытый
модуль безопасности или владения данными. Порог, выбранный после измерения,
может подогнать критерий под фактический результат.

TypeScript компилируется в JavaScript без source maps. Совмещение line coverage
исходного TypeScript с emitted JavaScript создаёт недостоверное соответствие
строк, поэтому `unit` измеряет только shipped JS в `dist`; trusted config bootstrap
измеряется как исполняемый `.mjs`. Тест, напрямую импортирующий `.ts`, не даёт
coverage emitted JS.

## Решение

Первый нормативный floor до измерений: 90% lines, 90% functions, 85% branches
для каждого изменённого критического модуля отдельно. Значения не выводятся из
текущего результата и не являются глобальной средней величиной. Они требуют
покрывать обычные ветви принятия решений и оставляют ограниченный запас для
платформенных и аварийных ветвей; высокий порог функций защищает от полностью
непроверенных handlers, а отдельный branch floor выявляет частичные проверки
ошибок и отказов. Это стартовые архитектурные минимумы, а не доказательство
корректности или достаточности тестов.

`config/platform.yaml:verification.unitCoverage` задаёт пороги, полный список
критических source/artifact roots и строгий инвентарь из 60 локальных unit suite.
Inventory включает config/bootstrap, runtime, PostgreSQL/migrations,
Outbox/Inbox/idempotency, Kafka, HTTP/security trust, Customer, весь Catalog
(service, supplier sync и cold activation), Pricing, Orders и AROMA
convergence/preparation/observer/gateway. Существующие foundation tests
проверяют platform packages через emitted artifacts; дополнительные lifecycle,
HTTP и domain suites остаются локальными и не требуют внешней БД. Расширение
включает Pricing quote/client/HTTP, Orders owner HTTP, upstream clients и
Public API, Customer normalization, а также AROMA Gateway cart mutation,
provider catalog source, production composition и HTTP routes.
Дополнительный пул проверяет Pricing proof/observability и public/internal API,
Orders Public API, а также AROMA provider source, composition и binding routes.
Strict schema и parser фиксируют форму и набор модулей. Изменения исходных
файлов сопоставляются с владельческим module root; отчёт собирается по всем
executable `.js` файлам соответствующего emitted `dist` root, включая файлы,
не загруженные тестами. `tools/config-bootstrap` остаётся исходным `.mjs`.
Сгенерированные файлы исключаются; migration SQL проверяются отдельным гейтом `migrations`.

При повторном использовании исторической preparation `migrations` допускается только
точный переход инвентаря с 48 на эти 60 suite вместе с ранее разрешённым
включением DB/Kafka isolation. Валидатор сверяет остальные байты конфигурации;
исторические SHA, bundle, server identity и факт создания ролей сохраняются.
Текущий запуск отдельно проверяет ancestry, PostgreSQL и атрибуты всех 15 ролей;
исторический PASS `migrations` не переносится на новый run.

Набор `unit` состоит только из существующих тестов, не требующих PostgreSQL,
Compose/Docker или внешнего provider. В него входит локальный `backup_restore`
`verification/launch/v1/scenarios/backup-restore.test.mjs`: PostgreSQL-клиенты и
потоки процессов подменены, а временный Git-клон и socket fixtures ограничены
локальными временными каталогами. Любой skip, todo, cancel, пустой набор или
неполный LCOV file inventory означает ошибку. Runtime context связывает тест
с candidate SHA, его accepted base и точными байтами committed
`config/platform.yaml`. Coverage evidence нельзя перенести на другой run/SHA.

Метрический источник — встроенный test runner закреплённого Node 26 и его LCOV
reporter. Новая dependency или собственный coverage engine не добавляются.

## Последствия

Некоторые критические модули могут пока не иметь тестов, импортирующих их
emitted artifacts; для них отчёт честно показывает нулевое coverage и `unit`
завершается ошибкой до закрытия пробела. Успех локального теста, выполняющего
TypeScript source напрямую, не подменяет это требование. Порог пересматривается
только отдельным архитектурным решением, а не в ответ на измеренное значение.

## Проверка

Точная launch-команда остаётся `pnpm test:unit -- --coverage`. Вне launch run
сценарий не допускает PASS `unit`, поскольку ему недостаёт проверенного context.
