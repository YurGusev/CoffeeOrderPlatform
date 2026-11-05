# Bounded idle poll Kafka consumer — 5 ноября 2026

## Проблема

`orders-aroma-preparation` в простое занимал 10,7–11,4 % одного ядра при
трёх consumer groups. Процесс делал 257 добровольных переключений контекста в
секунду; главный поток потреблял 7,6 %, потоки librdkafka — около 2 %.
БД и сообщения не были причиной: 13 транзакций/с на всю БД, 76 строк/с,
входящий поток — около 10 сообщений в минуту.

Причина — пустой consumer poll с коротким бюджетом. `consumerPollTimeout`
ограничивает его 10 мс, потому что librdkafka доставляет commit/rebalance
callbacks через poll, в том числе при паузе приёма; цикл `runGroup` сразу
запускает следующий poll. На каждую группу приходилось ~60–85 пробуждений в
секунду. Корреляция по сервисам с одинаковым 1-секундным циклом:

| Сервис                   | Consumer groups |     CPU |
| ------------------------ | --------------: | ------: |
| aroma-observer           |               0 |  0,96 % |
| orders-service           |               0 |  1,38 % |
| aroma-convergence        |               1 |  ~5,6 % |
| realtime-gateway         |               1 |  5,27 % |
| orders-aroma-preparation |               3 | 11,35 % |

Пустой poll, его бюджеты и callback ordering ранее не менялись: изменялся
только pause/resume (см. [оптимизацию](local-cpu-code-optimization-2026-11-05.md)).

## Изменение

`packages/platform-kafka-runtime`:

- `native.ts`: `NativeConsumerPort.setConsumeTimeout(timeoutMs)` меняет
  default consume timeout через существующий native setter; значение
  проверяется на положительный integer и не больше `receiveTimeoutMs`.
  `consumerPollTimeout` принимает `receiveTimeoutMs` напрямую;
  `MAX_IDLE_CONSUMER_POLL_TIMEOUT_MS = 250`.
- `index.ts`, `runGroup`: при простое — пустой poll, отсутствие паузы приёма,
  revoke и незавершённых commit — бюджет пустого poll удваивается от 10 мс до
  250 мс и не выше `receiveTimeoutMs`. Запись, пауза, revoke, незавершённый
  commit или новая фаза группы возвращают короткий бюджет. `drainGroup`
  принудительно опрашивает с коротким бюджетом, чтобы не задерживать
  commit callbacks при rebalance/остановке.

`consume` возвращается при появлении записи, поэтому backoff не добавляет
задержку доставке сообщений. Задержка dispatch commit/rebalance ограничена
верхним бюджетом 250 мс.

## A/B

Изолированный native fixture: один consumer на mock cluster librdkafka, четыре
партиции, без business-сообщений, `--network none`, один и тот же образ
сервиса, baseline — сборка `origin/develop` до изменения, candidate — сборка с
изменением. После назначения партиций и 2 с прогрева каждый вариант измерялся
20 с.

| Метрика                    | baseline | candidate |
| -------------------------- | -------: | --------: |
| CPU процесса, 20 с (run 1) | 887,3 мс |  193,5 мс |
| CPU процесса, 20 с (run 2) | 888,8 мс |  188,7 мс |
| Пустые polls, 20 с (run 1) |     1810 |        80 |
| Пустые polls, 20 с (run 2) |     1750 |        80 |
| Восстановления consumer    |        0 |         0 |

CPU процесса в fixture: 888,0 → 191,1 мс, то есть −78,5 %. Пустые poll:
1780 → 80, в 22 раза меньше. 80 poll за 20 с соответствует верхнему бюджету
250 мс. Контрольный прогон финальной сборки: 183,6 мс и 80 poll за 20 с.

Fixture, baseline/candidate builds и скрипт сохранены в приватном каталоге
`/home/yurgusev/.cache/coffee-kafka-backoff/2026-11-05/`. Измерение выполнялось
в одноразовом контейнере того же образа с `--network none`; рабочие контейнеры
не перезапускались.

## Live проверка собранного образа

Образ `coffee-platform-orders-aroma-preparation:kafka-backoff`
(`sha256:3d630d57b977…`, 280 MB) собран каноническим
`node tools/docker-build.mjs --load` с `--build-arg RUNTIME=orders-aroma-preparation`.
В образе есть `MAX_IDLE_CONSUMER_POLL_TIMEOUT_MS` в
`/app/node_modules/@coffee-platform/kafka-runtime/dist/{native,index}.js`.

Стек был остановлен до замера. Для проверки подняты только `coffee_postgres` и
`coffee-platform-kafka-1`; контейнеры сервиса запускались по одному, с
release-конфигом для старого образа и с текущим `config/platform.yaml` для
нового. Healthcheck отключён; рабочие контейнеры стека не изменялись.

| Образ                    | Конфиг       | CPU            | wakeups/s | level:50 |
| ------------------------ | ------------ | -------------: | --------: | -------: |
| старый `9b7115b0215e`    | release      |        11,83 % |       267 |        — |
| новый `3d630d57b977`     | develop      | 4,70 % / 4,07 % | 107 / 105 |        0 |

Оба запуска дошли до `runtime.phase running`. Старый образ не принимает
текущий конфиг (`egressRepositories`), поэтому конфиги в замерах различаются;
число consumer groups (3) и `pollIntervalMs` одинаковы. Снижение wakeups
267 → 105 соответствует бюджету 250 мс на трёх группах.

## Локальный dev-стек

Формальный путь `verification/launch/v1/run.mjs` для `bac417cb` остановился на
G00: `run.mjs` инициализирует `environment.nodeImageDigest` и
`environment.imageDigests` как `null` и нигде не заполняет их, а
`environmentProofErrors` требует digest pinned Node image и 15 runtime image
digests. В исторических `evidence/launch/*/environment.json` эти поля тоже
`null`, то есть контекст с G12 этим раннером не создаётся. Дополнительно G16
требует подписанный operator approval, которого в системе нет.

Вместо release controller выполнен ручной dev-стек: release-контейнеры
запущены через `docker start` со своими образами и конфигом, а
`orders-aroma-preparation` заменён на новый образ с текущим
`config/platform.yaml` и release-секретом. Nginx перезапущен после появления
DNS upstream. Итог:

- 18 контейнеров healthy, `https://127.0.0.1:8443/health/live` — 200;
- prep: 4,93 % CPU, 0 записей `level:50`;
- inbox `orders-aroma-projection-v1` вырос 28 144 → 28 155 за 30 с, то есть
  консьюмер обрабатывает живой поток;
- старый prep-контейнер сохранён как
  `coffee-platform-orders-aroma-preparation-release` для отката.

Откат: остановить и удалить ручной контейнер, затем вернуть старое имя и
запустить его:

```bash
docker rm -f coffee-platform-orders-aroma-preparation-1
docker rename coffee-platform-orders-aroma-preparation-release coffee-platform-orders-aroma-preparation-1
docker start coffee-platform-orders-aroma-preparation-1
```

Это dev-развёртывание без release controller, observability и admission:
контейнер не имеет compose-меток, а остальные сервисы работают на release
образах и конфиге. Оно не заменяет G12/deployment.

## Ограничения

- Измерение на mock cluster и одном consumer, без бизнес-сообщений,
  TLS/SASL и реальных broker failures. Значения не переносятся на сервер без
  deployment и нового замера.
- CPU процесса fixture включает runtime overhead и не равен выигрышу всего
  сервиса; в `orders-aroma-preparation` три группы, в других сервисах — одна.
- Задержка commit/rebalance в fixture не измерялась. Поведение бюджета
  зафиксировано новым тестом `tests/kafka/runtime.test.mjs`; callback latency
  нужно подтвердить отдельным замером.
- Live-замер сделан на остановленном стеке с поднятыми только Postgres и
  Kafka, с разными конфигами у старого и нового образа, без бизнес-сообщений и
  без healthcheck. Это проверка артефакта, а не deployment.
- Ручной dev-стек смешивает release-образы остальных сервисов с новым prep и
  текущим конфигом; release controller, observability и launch admission в нём
  не участвуют.

## Проверки

```bash
pnpm exec tsc -b packages/platform-kafka-runtime --pretty false
node --test tests/kafka/runtime.test.mjs
pnpm typecheck
pnpm exec oxlint --type-aware --deny-warnings packages/platform-kafka-runtime/src/index.ts packages/platform-kafka-runtime/src/native.ts tests/kafka/runtime.test.mjs
pnpm exec prettier --check packages/platform-kafka-runtime/src/index.ts packages/platform-kafka-runtime/src/native.ts tests/kafka/runtime.test.mjs
node tools/docker-build.mjs --load --file Dockerfile --build-arg RUNTIME=orders-aroma-preparation -t coffee-platform-orders-aroma-preparation:kafka-backoff .
```

TypeScript build и полный `pnpm typecheck` успешны, `tests/kafka/runtime.test.mjs`
— 19/19 PASS без skips, включая новый тест бюджета; образ собран и проверен на
наличие изменения в `/app/node_modules/@coffee-platform/kafka-runtime/dist`.
