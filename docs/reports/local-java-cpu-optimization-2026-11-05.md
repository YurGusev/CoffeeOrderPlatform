# Пики Java CPU: причина и применённая оптимизация — 5 ноября 2026

Периодические пики создаёт **`org.apache.kafka.tools.BrokerApiVersionsCommand`**,
который Docker запускает как Kafka healthcheck. Оптимизация применена к этому
короткому процессу: CPU-время проверки уменьшилось на **59,01%**. Основные
JVM Kafka и Keycloak не получили новые JVM flags. Все сервисы healthy.

Итог состояния — **PASS_WITH_EXCEPTION**: во время первого пересоздания Kafka
один раз автоматически перезапустился `orders-aroma-preparation`; остальные
39 контейнеров не перезапускались. Все 37 томов сохранены, включая оба
CoffeeOrderDb и все 33 именованных тома.

## Что именно запускалось

В исходном 45-секундном наблюдении пойманы healthcheck PID `2958694`
и `2960721` внутри `coffee-platform-kafka-1`. Их main class —
`org.apache.kafka.tools.BrokerApiVersionsCommand`; heap flag `-Xmx256M`.
Это отдельные JVM рядом с постоянным брокером `kafka.Kafka`.

Проверка выполняет Kafka API request через `localhost:9092` с существующим
`/etc/kafka/secrets/client.properties`, TLS/SASL и реальным exit status.
Interval уже был 30s, start_interval 5s; увеличение интервала ранее уменьшило
частоту, но сохранило стоимость каждого запуска.

`kafka-run-class.sh` по умолчанию задавал для короткой CLI server JVM tuning:
G1 GC, C1/C2 tiered JIT и пулы исходя из всех доступных CPU. В пойманных
запусках C2 занимал около 2,05–2,13 CPU-секунды, C1 — 0,92–0,98 секунды.
Их сумма — примерно половина полного CPU-времени проверки. GC-потоки в этих
запусках занимали лишь десятки миллисекунд: основной подтверждённый расход
связан с запуском и компиляцией, а не с длительной сборкой мусора.

В том же интервале постоянный Kafka broker потребил 2,70 CPU-секунды за 45 с,
Keycloak — 0,06. Краткий пик хоста достиг **54,34%** и совпал с CLI JVM.

## Исправление

В `compose.yaml` изменена только команда Kafka healthcheck. Префикс
`KAFKA_JVM_PERFORMANCE_OPTS='…'` задаёт параметры только дочерней CLI:

```text
-XX:+UseSerialGC
-XX:TieredStopAtLevel=1
-XX:ActiveProcessorCount=1
-XX:SharedArchiveFile=/opt/kafka/kafka.jsa
-XX:CICompilerCount=1
-Xbatch
```

Сохранены C1, один compiler thread, ожидание завершения компиляции вместо
параллельного прогрева C2 и рассчитанные на один CPU JVM pools. Используется
уже существующий read-only CDS archive установленного образа, 52 МиБ.
Новый cache, dependency или сервис не создавался.

Значение ActiveProcessorCount — JVM sizing hint, не жёсткая CPU quota.
`-Xbatch` уменьшает одновременную работу приложения и compiler threads;
семантика описана в
[документации Java](https://docs.oracle.com/en/java/javase/25/docs/specs/man/java.html).
Поддержка flags проверена непосредственно в установленном Temurin 21.0.12.1.
При смене pinned Kafka image нужно перепроверить CDS path и успешный healthcheck.

Основной broker сохранил прежний command line `-Xms1G -Xmx1G` и свой CDS flag;
его GC/JIT режим не менялся. Интервалы 30s/5s, timeout 5s, start_period 30s,
retries 12, TLS/SASL и содержимое credentials не менялись.

## Измерения

По три успешных запуска штатной команды до и окончательной команды после,
Bash `time` внутри того же работающего Kafka-контейнера, без перезапуска
брокера между этими прямыми A/B probes. CPU — сумма user + system всех
дочерних процессов команды. Значения в таблице — медианы.

| На одну проверку |      До |   После |
| ---------------- | ------: | ------: |
| CPU-время        | 5,962 с | 2,444 с |
| Реальное время   | 3,202 с | 2,786 с |

CPU уменьшился на **59,01%**, wall time — на **12,99%**. Все пробы завершились
кодом 0, результат укладывается в прежний timeout 5s.

Первый вариант без ограничения C1/background compilation уже уменьшал
CPU-время, но оставлял параллельный пик. В дополнительном процессе с шагом
100 мс его наблюдаемый максимум был 189,4% одного логического CPU, у
окончательного варианта — 109,6%, p95 99,7%. Это наблюдение, не CPU hard cap.
Основная CLI-работа сохранилась; уменьшены лишний прогрев и одновременность.

Отдельные 45-секундные наблюдения штатных Docker healthchecks после прогрева:

| Метрика всей машины                   |     До | Окончательный вариант |
| ------------------------------------- | -----: | --------------------: |
| Пик CPU в окне CLI                    | 54,34% |                41,39% |
| Пик вне CLI                           | 36,02% |                40,78% |
| Средняя занятость CPU                 | 24,62% |                25,25% |
| Поймано полных/частичных CLI запусков |      2 |                     1 |

Фоновая активность и фаза проверок различались; брокер после пересоздания
также прогревался. Снижение среднего CPU всей машины этим сравнением
**не доказано**. Достовернее прямое CPU-время команды и исчезновение C2
из проверочной JVM. Пики других процессов остаются. Изменение не обещает
постоянную общую нагрузку ниже 20%.

## Применение и сохранность

Бинарный image ID сохранён:
`sha256:aea48123e3deea4b7a995c0f44d1f70c19626814be1db363591640a187d3941c`.
Только Kafka пересоздавалась штатным Compose, с `--no-build --no-deps --pull
never --wait --wait-timeout 180`. Первое применение 14:53:46–14:54:02 +05:00,
уточнение compiler/background режима — 15:04:03–15:04:21. Обе команды успешны.
Immutable frozen controller/release manifest не редактировались.

Для установленного release команда сохранена в существующем последнем override
`/home/yurgusev/coffee-platform/runtime/overrides/healthcheck-30s.json`.
Предварительно проверено, что merged Compose отличается только Kafka
healthcheck command. У текущего исходного `compose.yaml` новая команда задана
непосредственно. При ручном пересоздании frozen release нужно сохранять его
последний override из config_files labels.

В 14:53:55 readiness `orders-aroma-preparation` зафиксировал
`dependency=kafka`, `code=RUNTIME_READINESS_DEADLINE`. Процесс автоматически
перезапустился один раз в прежнем контейнере и образе; StartedAt
14:54:01, RestartCount=1. Вторая смена Kafka healthcheck новых перезапусков
этого сервиса не вызвала. Изменение политики readiness/recovery не входило
в эту оптимизацию.

Другие 39 контейнеров сохранили ID, PID/startTicks, StartedAt, RestartCount
и состояние, включая 14 ранее остановленных. PostgreSQL, BuildKit и
наблюдаемость не перезапускались. Mount sources Kafka совпадают с исходными;
все 37 томов сохранили имена и полные Docker metadata, включая два CoffeeOrderDb
и 33 именованных тома. SQL/checksum бизнес-данных не выполнялись.

## Проверки и evidence

В существующую Compose topology проверку добавлены assertions для scoped JVM
flags и прежнего client config path; проверено отсутствие global JVM override
в broker environment. Три узких теста — **3/3 PASS**:

```bash
node --test --test-name-pattern='Compose materializes 14 Node runtimes, native nginx, and Kafka|Kafka requires the verified G12 artifact|Kafka data uses a project-scoped named volume' tests/compose/topology.test.mjs
pnpm exec prettier --check compose.yaml tests/compose/topology.test.mjs docs/reports/local-java-cpu-optimization-2026-11-05.md
git diff --check -- compose.yaml tests/compose/topology.test.mjs docs/reports/local-java-cpu-optimization-2026-11-05.md
```

Отрицательная read-only проба с отсутствующим client properties вернула exit 1,
то есть команда не выдаёт отсутствие конфигурации за healthy. Последующие
штатные проверки и все работающие сервисы healthy.

Baseline source snapshots, собственный patch поверх существующего WIP,
sanitized Java/thread samples, A/B results, apply receipts и volume/container
verification находятся в `/home/yurgusev/.cache/coffee-java-cpu/2026-11-05/`.
Ключевые файлы: `spike-baseline.json`, `spike-final.json`, `command-ab.json`,
`foreground-ab.json`, `peak-options-comparison.json`, `comparison.json`,
`apply-receipt-v1.json`, `apply-receipt.json`, `post-apply-verification.json`.

Полный нагрузочный тест, G12/launch admission и тесты бизнес-потока не выполнялись.
Ранее подготовленные source-оптимизации redaction и Kafka pause/resume
на рабочие образы этим шагом не развёртывались.
