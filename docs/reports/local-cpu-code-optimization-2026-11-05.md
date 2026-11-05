# Оптимизация служебного CPU в коде — 5 ноября 2026

В исходниках устранены две подтверждённые избыточные операции: повторная
нормализация чувствительных имён в redaction и повторные Kafka pause/resume
при неизменном состоянии приёма. Изменения проверены локально. Рабочие образы
не пересобирались и не заменялись; это не замер общего CPU сервера после deployment.

Предшествующее применение healthcheck 30s/5s и сравнение CPU всей машины
описаны в [отдельном отчёте](local-cpu-analysis-2026-11-05.md).

## Маскирование логов и трассировок

`packages/platform-observability/src/index.ts`: прежний `shouldRedact` для
каждого поля снова проходил по списку чувствительных имён, выполняя для каждого
имени regexp replace и lowercase. Этот путь вызывается логированием Pino,
child bindings и sanitizer экспорта OTel spans, events и links.

Теперь стандартный список нормализуется один раз при загрузке модуля,
пользовательский список — один раз на вызов redaction. Ключ каждого поля
по-прежнему нормализуется, matching остаётся substring matching. Custom lists
не кешируются по ссылке: их изменение между вызовами учитывается. Сохранены
ограничения глубины/массивов, защита от циклов, обработка Error, req/res и
правила маскирования.

В существующий тест `observability uses Pino and redacts nested
request/provider/PII/error canaries` добавлены вложенный custom-list сценарий
с разными регистрами/разделителями и изменение списка между вызовами.
Старые проверки отсутствия canary в сериализованных логах сохранены.

Один fixture записи с типичными runtime/DB span attributes и искусственными
чувствительными значениями, 3000 прогревочных вызовов, затем 5 раундов по
10 000 вызовов. Сравнивались baseline и изменённый скомпилированные модули;
CPU profiles снимались встроенным
[Node Inspector Profiler](https://nodejs.org/api/inspector.html#cpu-profiler).
Медиана CPU-времени на 10 000 записей: **1350,125 → 363,327 мс**,
то есть **−73,09% / ускорение 3,72 раза**. Это результат функции redaction
на данном fixture, а не процент экономии всех сервисов.

## Управление приёмом Kafka

`packages/platform-kafka-runtime/src/index.ts`, цикл `runGroup`: каждый
poll вызывал `pause()` или `resume()` даже при прежнем состоянии очереди.
Native adapter передаёт это в librdkafka. В исходниках установленного пакета
`@confluentinc/kafka-javascript@1.10.0` это реальный переход в native client,
а не чистая проверка флага в JavaScript. Пустой consumer poll ограничен 10 мс,
поэтому такая работа повторялась около 100 раз в секунду на consumer group.

Теперь pause/resume отправляются при изменении состояния. Состояние
сбрасывается при новой фазе группы и при назначении партиций, чтобы старый
pause не переносился на новое назначение. Сам poll и его бюджеты, callback
обработки commit/rebalance, ACK ordering, Outbox/Inbox и бизнес-циклы не менялись.

Расширен существующий тест нормального rebalance и восстановления после
ошибки назначения: пустые polls, заполненная очередь, однократная пауза,
продолжение callback polling при паузе, resume после нового назначения и
новый consumer после ошибки. До исправления тест воспроизводил лишнюю работу:
**21 resume вместо 1** до первого обработчика. После исправления весь
`tests/kafka/runtime.test.mjs` прошёл **18/18**, без skips.

Дополнительно выполнен изолированный native A/B с одним consumer и четырьмя
партициями. Использованы прежний установленный Node image и встроенный
[librdkafka mock cluster](https://github.com/confluentinc/librdkafka/blob/master/src/rdkafka_mock.h),
`--network none`, read-only root и tmpfs. Контейнеры не получали рабочие
scoped secrets и не подключались к рабочему Kafka. Mock metadata назначает
партиции, поэтому этот замер не заменяет настоящий group rebalance proof.

Исходник baseline взят из снимка непосредственно перед исправлением, TypeScript
типы удалены штатным `stripTypeScriptTypes`; изменённый вариант взят из TS7
build. Dependencies и native adapter обоих вариантов одинаковы. После
назначения и двух секунд прогрева каждый вариант измерялся по 20 секунд.

| Метрика native fixture                |         До |      После |
| ------------------------------------- | ---------: | ---------: |
| CPU процесса за 20 с                  | 525,005 мс | 411,528 мс |
| Пустые polls                          |       1937 |       1946 |
| Вызовы resume в установившемся режиме |       1937 |          0 |
| Восстановления consumer               |          0 |          0 |
| Последняя ошибка                      |       null |       null |

CPU-время этого процесса уменьшилось на **21,61%** при близком числе polls.
Переносить эту величину на все сервисы или сервер без deployment и нового
замера нельзя. Один A/B, без доверительного интервала; тест не измеряет
throughput, TLS/SASL, реальные broker failures или доставку бизнес-сообщений.

## Проверки и evidence

```bash
pnpm exec tsc -b packages/platform-observability packages/platform-kafka-runtime --pretty false
node --test tests/kafka/runtime.test.mjs
node --test --test-name-pattern='observability uses Pino|observability preserves valid correlation|database, HTTP and Outbox telemetry' packages/platform-testing/test/platform-packages.test.mjs
pnpm exec oxlint --type-aware --deny-warnings packages/platform-observability/src/index.ts packages/platform-kafka-runtime/src/index.ts packages/platform-testing/test/platform-packages.test.mjs tests/kafka/runtime.test.mjs
```

TypeScript build и scoped lint успешны. Kafka: 18/18 PASS; observability:
3/3 PASS, включая owner parentage, bounded metrics и payload privacy.
Prettier и `git diff --check` проверены для изменённых файлов.

Изменены только два source-файла, два существующих test-файла и этот отчёт.
Рабочая ветка уже содержала значительный WIP; он сохранён. Patch именно этих
изменений относительно исходного WIP, baseline snapshots, V8 profiles,
benchmark scripts/results и логи находятся в приватном каталоге:
`/home/yurgusev/.cache/coffee-cpu-analysis/2026-11-05/code-optimization/`.

Новые dependencies, сервисы, timer/backoff настройки и storage formats
не добавлялись. Рабочие контейнеры не перезапускались; тома и бизнес-данные
не изменялись этой задачей. Для живого сравнения требуется отдельная сборка
и развёртывание проверенных образов; полный G12/launch admission здесь не проводился.
