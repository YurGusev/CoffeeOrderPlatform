# ADR-0033: ограниченный эксперимент с двумя TLS-процессами realtime-gateway

- Статус: разрешённый пользователем эксперимент по #12; production-решение не принято.
- Дата: 2026-10-12. Владелец: Realtime.
- Основание: [приёмка #12](../../evidence/issue-12-analysis.md), [спецификация SSE](../launch/20_REALTIME_SSE_IMPLEMENTATION_SPEC.md), [runtime architecture](../launch/01_RUNTIME_ARCHITECTURE.md), [ADR-0018](ADR-0018-m04-node-runtime-and-composition-roots.md), [ADR-0031](ADR-0031-nginx-transport-and-application-auth.md).

## Измеренное ограничение

На единственном доступном сервере i7-930 обычный профиль 5000 клиентов с
100 Kafka ACK/s не прошёл повторную авторизацию и headroom. Разрешённые 1 GiB
памяти не устранили отказ. Отдельные диагностические сочетания initial ramp,
CPU affinity и TLS cipher preference также завершились FAIL. В последнем
контроле readiness request завершил TCP connect за 51 мс, TLS handshake — за
1848 мс, при пределе headroom 1000 мс. Это наблюдение о стадии задержки,
а не доказательство единственной причины или обещание выигрыша от процессов.

## Разрешённый эксперимент

Один контейнер `realtime-gateway` содержит один процесс владельца Kafka/replay
и ровно два процесса HTTPS/TLS. Это одна роль Realtime и один instance, а не
два независимых consumer или новая бизнес-служба. Общий cgroup остаётся
ограничен **2 CPU / 1 GiB**; FD, connections, очереди и ring не умножаются на
число процессов. Новые зависимости, серверы и публичные wire formats не вводятся.
Предварительный reference-512 smoke сохраняет общий бюджет gateway 512 MiB.

13.10.2026 пользователь отдельно разрешил ограниченный private HTTP framing
эксперимент V39. Только успешный `/events` ответ gateway→nginx может использовать
Connection:close без Transfer-Encoding:chunked: стандартный
ServerResponse.removeHeader('Transfer-Encoding') вызывается до writeHead,
write/callback/drain остаются штатными. Публичные nginx headers/framing и SSE
bytes/IDs/retry/ready/reset должны сохранить совместимость; auth/admission/
readiness errors не меняются. V38 CPU profiler и writable diagnostic file mounts
удаляются из текущего кандидата, их frozen evidence сохраняется отдельно.
Это разрешение на эксперимент, а не production adoption и не waiver acceptance.
При close-delimited HTTP EOF невозможно отличить полное тело от обрыва
([RFC9112§6.3](https://www.rfc-editor.org/rfc/rfc9112.html#section-6.3));
проверяются неполный UTF-8/JSON/SSE frame без продвижения cursor, replay/reset,
actualmTLS/nginx callback+drain/slow-reader-timeout и reset→server-close. Budget
2CPU/1GiB,5000/5001/100ACK/s/30min, TLS/auth/TTL/skew/queues/deadlines прежние.
Production/spec/schema/config/permission authority пока сохраняется.

Общий Hub ограничивает именно активные SSE streams и отклоняет 5001-й запрос
до успешных headers. Runtime middleware каждого TLS-процесса сохраняет
`concurrency=5000`; health endpoints исключены из этого счётчика. Hub не
ограничивает суммарные попытки, ещё проходящие TLS/auth до admission, поэтому
их CPU/FD/RSS входят в общие измеряемые бюджеты. Деление на 2500 на процесс
создало бы ранний отказ при неравномерном распределении и не применяется.

Владелец сохраняет единственные `realtime-gateway-v1` consumer, sequence,
deduplication, replay ring, admission и глобальный учёт очередей. Kafka offset
принимается по прежнему правилу после валидации и принятия события в ring и
очереди. TLS-процессы не создают Kafka consumers, replay ring или business cache.
Источник бизнес-истины остаётся у Orders/PostgreSQL; SSE передаёт только hints.

Первый путь реализации — публичный `node:cluster` и IPC к существующему Hub.
Каждый TLS-процесс сам выполняет TLS handshake; уже установленный TLS socket
между процессами не переносится. IPC передаёт данные SSE и подтверждение
фактической записи/`drain`, сохраняет bounded in-flight работу, atomic replay/live
boundary и общий admission до отправки успешных headers. Отправка IPC сама по
себе не подтверждает запись клиенту. Потеря процесса/канала завершает соединения
и переводит readiness в fail-closed; автоматическое масштабирование и отдельный
путь восстановления состояния не добавляются.

Новые подключения сохраняют mTLS CA/SAN/role verification и полную проверку
свежего подписанного actor context. TTL, период проверки retained claims,
reconnect с новым actor context и reset/refetch не меняются. Секреты не
публикуются в IPC/evidence. Production adoption потребует доказанной scoped
materialization и разрешений для фиксированных доверенных entrypoints;
широкое снятие Node permissions не является решением этого ADR.

Текущий `startConfiguredRuntime` одновременно создаёт Kafka и запускает listener.
В первой scratch-сборке нужны два узких изменения compiled bootstrap: родитель
подготавливает Fastify без listen, TLS-процессы пропускают создание Kafka runtime.
Остальной lifecycle и transport middleware переиспользуются. Каждый процесс
сохраняет существующую read-only materialization роли `realtime-gateway`; это
ещё не доказательство отдельного минимального secret scope TLS-процессов или
production Permission Model. В production такой bootstrap не переносится
без принятой точки разделения владения и соответствующих проверок.

Используется [`cluster.setupPrimary` с `serialization: advanced`](https://nodejs.org/download/release/v26.8.1/docs/api/cluster.html#clustersetupprimarysettings).
По [контракту Node IPC](https://nodejs.org/download/release/v26.8.1/docs/api/child_process.html#subprocesssendmessage-sendhandle-options-callback)
send callback не подтверждает выполнение записи в другом процессе. Поэтому
Hub освобождает in-flight работу только по отдельному подтверждению callback
фактического writable и его готовности после `drain`, если write вернул false.
Передача данных и дополнительные IPC-копии учитываются bounded gauges, а не
скрытой очередью вне общего бюджета.

Первый полный процессный контроль прервался при IPC reservation: projected
67121044 B превысили прежние67108864 B. Следующий ограниченный кандидат объединяет
текущие≤64 targets одного immutable Buffer в IPC batch, используя существующий
Hub dispatcher. Постоянный cache не вводится. ACK объединяет только уже
завершившиеся callback/drain; быстрый stream не ждёт медленный. Общий учёт
Hub и двух дополнительных копий на каждый pending stream сохраняется.
Batch-контроль5000 завершился FAIL по event-loop p95 TLS worker798.491ms до
первого capacity reject. Следующий scratch-контроль ограничивает child dispatch
64writes за `setImmediate`-ход, сохраняя reservation до actual callback/drain.
Выигрыш не доказан; кандидат не меняет действующую authority.

Этот кандидат прошёл реальный512/120s smoke с re-auth/HUP/loaded shutdown,
но полный5000 контроль прервался через1.600s из-за закрытия SSE. Первый
зафиксированный parent IPC capacity warning следовал после driver failure,
поэтому причина первого закрытия этим receipt не доказана. Следующий контроль
сохраняет bounded first rejection для всех Hub capacity paths и child ACK errors.
Ошибка parent error-ACK cleanup исправлена до наблюдения: pending callback и
reservation завершаются ровно один раз. Это не меняет лимиты или scheduling.

V19 full установил первый отказ на IPC reservation: projected67111552B при
лимите67108864B за126ms до наблюдения driver close. Следующий scratch-контроль
проверяет резерв до кодирования batch и временно оставляет frames в уже учтённой
очереди Hub. Actual ACK планирует пробуждение до64ожидателей через существующий
pump; callback ожидания не содержит payload. Прежний writeTimeoutMs ограничивает
ожидание и запись вместе. Окончательный reserve, slow-client overflow, worker-loss
и error close сохраняются. Новый запас памяти или queue budget не вводится;
достаточность backpressure ещё не доказана.

V20 прошёл реальный smoke 512 клиентов / 120 секунд с re-auth, HUP и loaded
shutdown. Полный контроль 5000 завершился FAIL через 2.195 секунды: event-loop
p95 владельца Kafka составил 103.809 мс при пределе 100 мс; все 5000 клиентов
ещё были живы, hard capacity rejection и child write errors отсутствовали.
Это локализует отказ в owner, но не устанавливает конкретную долгую операцию.
V21 добавляет только bounded timing существующих coalescer, dispatch, encode
и IPC стадий. Диагностика не меняет scheduling, ресурсные лимиты или критерии;
её результат не считается доказательством улучшения производительности.

V21 завершился FAIL через 1.940 секунды по hard enqueue: общий queue budget
64 MiB превышен на 17 B. Следующий ограниченный кандидат использует уже имеющееся
soft capacity ожидание для окна не более 64 незавершённых writes на каждого
TLS worker. Остальные hints остаются в учтённой Hub queue и допускают coalescing;
учёт двух дополнительных IPC-копий не уменьшается. Ожидающие соединения имеют
отдельную FIFO каждого worker, общий cap 5000 и прежний write deadline.
Release, close и shutdown освобождают slot ровно один раз; за один ход
пробуждается не более 64 callbacks. Достаточность этого кандидата не доказана.

V22 прошёл smoke 512 / 120 s, включая полный re-auth, HUP и loaded shutdown.
Full 5000 завершился FAIL через 79.700 s / 7971 ACK: headroom 1475.567 ms
при пределе 1000 ms во время re-auth. Измеренное окно не превышало 64 targets
на worker, IPC rejects/ACK errors отсутствовали, sampled queue и ресурсы
оставались в пределах бюджета. Только 257 клиентов успели восстановиться;
полные 30 минут и остальные acceptance criteria не подтверждены.
V23 с bounded aggregate TLS timing и resumption counters завершился FAIL через
76.308 s / 7631 ACK: три новых queue/write-pressure closes во время re-auth.
Успешные внутренние handshakes укладывались в 142.905 ms, resumption преобладал;
46 TLS errors не имеют timing correlation и не доказывают отсутствие задержки.
Точная причина slow-close пока неизвестна. Следующий scratch-контроль сохраняет
TLS policy и записывает первые восемь причин закрытия вместе с числовыми
per-client/global/transport очередями и возрастом существующего write deadline.
Новые timers, ресурсы, scheduling и SLO не вводятся.
V24 подтвердил семь runtime deadlines после 5000–5006 ms ожидания IPC capacity
при очередях ниже лимитов и завершился FAIL по direct gateway headroom
1080.038 ms через 77.169 s / 7717 ACK. Операция, задержавшая освобождение IPC
slot, пока не установлена. Следующий контроль меняет только внутреннюю server
cipher preference на ChaCha20-first с AES fallback; public nginx policy,
протоколы, trust checks, очередь, deadline и все критерии сохраняются.
V25 применил внутренний ChaCha на всех successful TLS 1.3 handshakes, но
завершился FAIL через 79.630 s / 7963 ACK: direct headroom 1311.648 ms.
Connect→secure занял около 1194 ms, secure→HTTP headers — 29 ms. Это локализует
задержку до TLS completion, но не разделяет preaccept/descriptor dispatch,
server handshake и client scheduling. Достаточность изменения не доказана.
В Node 26.8.1 RR descriptor handoff и FRAME_BATCH используют один ChildProcess
IPC; pending handle ACK удерживает последующие сообщения. Это механизм,
проверенный по exact runtime source, а не установленная причина V25.
V26 меняет только public cluster schedulingPolicy на SCHED_NONE до fork:
оба TLS workers принимают с общего listen handle без per-connection handoff.
Параметры V25, единственный Kafka/replay owner и все acceptance gates сохраняются.
ОС может распределять accept неравномерно; распределение и lifecycle проверяются
smoke, затем full. Private Node hooks и дополнительный observer не вводятся.
V26 smoke 512 / 120 s прошёл: полный re-auth, реальный HUP, 512 loaded shutdown
receipts без forced close, verified cleanup; event latency p95 316 ms,
loop max 31.048 ms. Reference 512 MiB сохранён, transport distribution примерно
равное. Full V26 завершился FAIL через 76.161 s / 7617 ACK: pressure-close
counter 30 против preflight 1. SCHED_NONE не устранил отказ; production adoption
не разрешена. Следующий observer-only контроль уточняет возраст transport waits
и стадии callback/drain/ACK, сохраняя параметры и существующий 1Hz sampler.
V27 тоже завершился FAIL: 76.512 s / 7652 ACK, pressure counter 81 против 1.
Записи ждут slot до deadline 5 s; global queue budget не достигнут,
reservation-to-ACK max перед fatal около 217 ms. Actual-source reproducer
отдельно подтвердил FIFO gap: между wake и отложенным pump слот может занять
новый pump. V28 вызывает выбранный pump синхронно внутри уже ограниченного
SetImmediate wake (максимум 64, FIFO/RR), сохраняя budgets и общий deadline.
Дополнительные grants не вводятся. Это исправление подтверждённого дефекта;
его достаточность для load FAIL требует нового полного прогона. Измерение
`hub_pump_set64_dispatch` теперь исключает pumps из capacity wake.
V28 RED/GREEN regression прошёл, но full — FAIL через 80.930 s / 8094 ACK:
публичный nginx TLS headroom 1689.778 ms при пределе 1000 ms, TCP connect
15.100 ms и secureConnect 1635.138 ms. Pressure-close остался на preflight 1;
это наблюдаемое улучшение очереди, не доказательство capacity. V29 проверяет
public nginx ChaCha preference с AES fallback на текущем baseline; стандартные
client offers, TLS versions, peer checks и все бюджеты/дедлайны сохраняются.
Серверная preference включается и для TLS 1.2: набор suites сохраняется,
прежний порядок negotiation не обещан; AES128 probe проверяет совместимость.
Production policy пока не меняется.
V29 завершился FAIL через 77.967 s / 7797 ACK: event-loop p95 owner
103.875 ms > 100 при workers 85.852 / 73.597 ms в последнем снимке.
Семь cipher probes и 5000 cold TLS 1.3 ChaCha handshakes прошли;
compatibility не доказывает performance gain. Pressure-close остался 1,
queues ниже cap, ACK errors 0, полного re-auth / 30m / loaded shutdown нет.
V30 добавляет штатный Node `--cpu-prof` только owner (2000 мкс sampling),
фильтрует profiler flags у children и сохраняет один nonsecret profile-file
через ограниченный writable bind mount. Config/secrets остаются RO.
После измерения gateway останавливается для записи профиля до cleanup;
это диагностический stop, не loaded-shutdown proof. Overhead profiler
не измерен; время samples не равно CPU core time. Adoption не разрешена.
V30 профиль записан, но run — FAIL через 3.070 s / 308 ACK, loop 115.081 ms.
Measurement slice показывает около 13.070% sampled self time в побайтном
`frameRecords`; clock mapping приблизительна, profiler overhead неизвестен.
V31 убирает profiler и проверяет стандартный `Buffer.indexOf` для того же
подсчёта границ. Overlapping separators и child validation сохраняются,
cache/metadata/dependencies не добавляются; capacity ещё требует full proof.
V31 LF-run scan function оказался быстрее примерно на 37% для 25/64 actual
frames, но full — FAIL через 78.820 s / 7883 ACK: owner loop 117.965 ms.
Workers ниже 49 ms, queue caps/ACK errors не сработали. Последние пять секунд
coalesce/fanout занял 699 ms / 16 calls, один новый call в bucket 100–250 ms;
lifetime max 112.856 ms уже был раньше. Это timing correlation, не sole cause.
Первый V32 разбил fanout на 64 connections за turn с SetImmediate, single
active window и finite snapshot. Независимый review V32-D1 и actual Hub RED
подтвердили объединение pending records через исходную границу 250 ms при
долгом active fanout; remaining delay недостаточен. Исправляемый вариант
закрывает окна независимым timer и на accept после due. Числовой
`windowStartSequence` в retained record ограничивает supersession одним окном;
backlog хранится только в существующем bounded ring. Scalar watermarks и
ленивое чтение закрытых окон сохраняют последовательную доставку с одним
active snapshot. При потере ещё не доставленного selected hint используется
reset; shutdown/destroy отменяют timer/immediate. Queue/ring budgets и
deadlines прежние; profiler не вводится, stage timings описывают chunks.
Следующий source review исправил V32-F2: переход между окнами тоже выполняется
через отменяемый immediate, иначе один callback мог обработать более 64
connections или рекурсивно исчерпать backlog. Final source review — PASS на
patch `309984a8…e8d09`; final regression tests у tester/root — PASS на selfcheck
`1755c8f1…6bb788`: exact live/replay IDs, 8/70/130 connections, yield,
eviction/reset и lifecycle cleanup. Diagnostic full V32 завершился FAIL через
79.324 s /7932 ACK: direct gateway ready mTLS probe1152.782 ms >1000.
Connect→secureConnect занял около1038 ms; event-loop p9575.891 ms, OOM0.
До первого превышения записаны16 завершённых re-auth receipts и49 retry504;
ещё один ready пришёл раньше, но его receipt позже. Cleanup3638.766 ms verified.
30 минут, полный re-auth, HUP900 и loaded shutdown не достигнуты.
V33 проверит ограниченный owner-only sampler accept queue порта4401 и
cgroup CPU counters из существующего1Hz logging cycle. Async bounded reads
не блокируют callback, работа не более одной in-flight; ошибки дают null,
raw sockets/addresses/secrets не логируются. Linux6.8 source определяет
LISTEN `rx_queue` как `sk_ack_backlog` в
[IPv4](https://raw.githubusercontent.com/torvalds/linux/v6.8/net/ipv4/tcp_ipv4.c)
и [IPv6](https://raw.githubusercontent.com/torvalds/linux/v6.8/net/ipv6/tcp_ipv6.c);
`tx_queue` не является backlog limit. ListenOverflows/ListenDrops относятся
ко всей network namespace, `cpu.stat` throttling — к собственному cgroup
bandwidth limit ([Linux cgroup v2](https://docs.kernel.org/admin-guide/cgroup-v2.html)).
Эти observations не доказывают единственную причину; overhead sampler ещё
не измерен, full criteria и budgets сохраняются. V33 source/tests прошли:
71 прежний check,3V32/7V33. Real IPv6 header и truncated prefix проверены
actual-source regression. Full V33 — FAIL через76.572 s /7658 ACK:
owner loop110.035 ms, workers44.499/67.699. Перед fatal записаны8 completed
re-auth receipts; cleanup3671.772 ms verified. Gateway counters подтвердили
quota200000/100000, при steady load около2CPU usage и throttling; accept queue0–1,
namespace drops/overflows0. Последний prefatal interval имеет throttling delta0;
наблюдения не устанавливают единственную причину.
V34 проверяет только меньший CPU bandwidth period gateway:10000 us с quota20000,
то есть прежние2CPU. [Docker CPU period](https://docs.docker.com/engine/containers/run/#cpu-period-constraint)
определяет ratio quota/period; runtime inspect и cgroup cpu.max обязаны подтвердить
его. `--cpus` и CFS flags одновременно не применяются. Все другие роли, memory/FD,
TLS, queues и обязательные thresholds прежние. Изменение ограничено scratch
coordinator; production config не меняется. Actual V34 inspect и cpu.max
подтвердили20000/10000. Full — FAIL через81.841 s /8185 ACK: direct gateway
headroom1005.630 ms >1000, prefatal driver all-process loop maximum62.128 ms;
postfatal gateway logs достигают504.889 ms. До threshold217
complete re-auth receipts resumed, gaps3.742–11.183 s;116retryHTTP504.
Prefatal accept queue max217, namespace drops/overflows0, own cgroup throttling;
samples не доказывают единственную причину. Cleanup3.563 s verified.
V35 проверяет только чтение wall clock в scratch periodic actor time check:
`Math.floor(Date.now()/1000)` вместо Temporal polyfill, который получает время
из того же Date.now и преобразует его через JSBI. В microbenchmark5000calls
original42.119–59.484 ms /native0.419–0.503 ms; full gain не доказан.
Fresh time на каждом вызове, floor, конечный rollback и exp/iat skew boundaries
проверены actual-source tests. Full signature verifier, TTL/skew и auth timers
прежние; дополнительные гарантии для заменённого NaN clock не заявляются.
All budgets/thresholds и V34CFS20k/10k сохраняются. Full V35 — FAIL через83.285s
/8316ACK: REAUTH_RECOVERY_TIMEOUT, prefatal all-process loop92.799ms. До marker126
complete re-auth resumed/gaps3.483–12.782s; prefatal retry receipts0. Позднейшие
headroom failures не являются trigger. Acceptqueue max65/drops/overflows0;
stage задержавшейся re-auth не наблюдается. Cleanup3.516s verified.
V36 проверит только ready.connectedAt и heartbeat formatting через
`new Date().toISOString()`. Millisecond RFC3339 соответствует существующему
Timestamp contract и heartbeat spec; fields/бизнес-время/timers/auth/replay
не меняются. Function-only5000calls: Temporal174.525–215.548ms/native5.909–6.319ms;
Full V36 — FAIL через80.062s/8007ACK: directGWheadroom1141.923ms>1000,
secureoffset1099.295ms. Prefatalall-processloop65.667ms;59complete reauth
resumed/gaps4.952–9.017s,68retryHTTP504. Acceptqueuemax221/drops/overflows0;
samples не устанавливают sole cause. Cleanup3.795sverified. Native timestamps
не доказали достаточность схемы. V37 проверяет только доверенную передачу
batch.length от Hub pump к ParentSink.writeBatch; eachHubFrame — одна SSE record.
Genericwrite сохраняет пересчёт mutableBuffer, ordinarysinks прежнийfallback;
counts не принимаются из HTTP/IPC. Integer1..64/Buffervalidation, общийreserve/
pending/ACK path и old budgets/deadlines сохраняются. Identitycache отвергнут
из-за mutableBufferregression; regexp count измерен и отвергнут как более медленный.
ActualParentSink microbenchmark25records/5000calls: generic20.278–24.542ms/
trusted1.730–4.682ms, fake noopreserve/release/syncACK; IPC/TLS/fullgain не проверены.
Final source/tests/root min-fixture PASS, actualHub controls/live/replay exactcounts,
doubleIPCbudget/malformedcount/release/genericmutableBuffer проверены. Oldcapacity/
abort/shutdown spies адаптированы к обоим entrypoint, assertions/deadlines прежние.
Full V37 — FAIL через76.346s/7635ACK: directGWheadroom1224.339ms>1000,
secureoffset1176.367ms от начала request; prefatalall-processloop54.067ms.
Однаcompleteprefatalreauth resumed/gap4.849s и8retryHTTP504; totals после fatal
не засчитываются. Acceptqueuemax128/drops/overflows0; timing начинается после
accept и не сопоставлен с failingrequest, причина не установлена. Последние
strictTLS snapshots errors/missingStart6/10, безmapoverflow. Cleanup3.333sverified.
Trusted count ускоряет локальную операцию, но достаточность схемы не доказана.
Adoption всё ещё не разрешена.
Следующий V38 снимает CPU profiles только двух TLS workers через существующий
CLI/capture путь V30, два nonsecret writable file mounts и2000µs sampling.
Owner/app/config/scopedsecret grants и все нагрузочные gates прежние; profiler
overhead не измерен. CLI собирает до выхода без строгого write-size/window cap;
pre-read guard32MiB не является лимитом записи. Capture после driver result и
bounded graceful stop до cleanup не заменяет loaded shutdown/recovery acceptance.
Full V38 — FAIL: driver directGWheadroom1131.843ms>1000 через78.339s/7835ACK,
all-processloop55.575ms; отдельно parent observer отклонил summedRSS1084747776B
при1GiB gate. RSS crossing timestamp отсутствует, порядок отказов неизвестен.
Два profiles captured после gateway cleanexit0/OOMfalse; worker1/2 размеры
1405978/1427371B, samples63641/63299. Owner без profiler. ActualUID1000/
ROscopes/two writable files и2CPU1GiB подтверждены. Capture427ms и cleanup3.820s
verified не являются loaded shutdown proof; capturedAfterDriverResult=false
из-за observer exception в parent result. В baseline main+10..40s nativewritev
self47.49% sampled wall time, connectionCorkNT inclusive56.47%; это не CPUtime
и не раздельное измерение encryption/copy/syscalls. Профили содержат POSTfailure
samples, analysis windows ограничены известным headroom threshold; RSS timing
неизвестен. Profiler overhead не измерен, adoption не разрешена.
В обычном cluster listen Node автоматически разделяет ticket keys
([Node 26.8.1](https://nodejs.org/download/release/v26.8.1/docs/api/tls.html#new-tlsserveroptions-secureconnectionlistener));
собственное управление или передача ключей не вводятся. Client→nginx resumption
сам по себе не подтверждает resumption отдельного nginx→gateway соединения.

Private close-delimited framing V39 сохранило совместимость bounded nginx/mTLS
proof, но full завершился FAIL через78.490s: publichealth headroom1294.378ms.
V40 с тем же runtime завершился FAIL через80.522s: sessionheadroom1307.735ms.
Owned host observer подтвердил publiclistener8443 и scoped CPU/schedstat;
последний prefatal snapshot завершён за5.794s до first threshold, queue405
зафиксирована после threshold. Это не доказательство причины. Следующее
V41 measurement использовал nominal1Hz на существующем observer tick, bounded
singleflight и текущие owned identities; runtime/budgets/security/gates прежние.
Full FAIL80.452s/8046ACK: publichealth1669.376ms, connect→secure1488.481ms.
Publicacceptqueue48→134→170→139→367 теперь наблюдалась строго до threshold;
последний snapshot завершён за237ms, CFS throttle delta0. Aggregate worker
run-delay и очередь не доказывают причину отдельного запроса. Следующий V42
scratch treatment добавляет только `multi_accept on;` в nginx events при прежних
двух workers, listener/TLS/лимитах и observer. V42 full FAIL73.342s/7335ACK:
API1214.746ms. Observed prefatalqueue≤15, connect→secure145.231ms,
secure→headers898.452ms; один run с другим failing kind не доказывает gain.
V43 сохраняет эту настройку только как scratch candidate и добавляет correlated
nginx upstream/auth timings с существующим responsecorrelationID для разделения
задержки после TLS. Новые publicheaders, ресурсные или security-послабления
не вводятся; exact-stage byte/hashes и mountedconfigproof остаются обязательными.
V43 full FAIL73.314s/7332ACK: API timeout до ответа, publicqueue≤7 и process
event-loop≤51.970ms до первого известного failure marker. ExactID связывает
один nginx request1.140s с Edgeauth53.971ms и API10.006ms, но failed probe
не получила responseID; это не доказательство причины её timeout. Cleanup
3441.491ms verified, OOM0. V44 задаёт probe UUID до отправки через existing
optional X-Correlation-ID и сохраняет partial timings при ошибке; nginx
логирует validated UUID, сохраняя existing correlation/actor policy. Protected
API может сохранить валидный caller UUID в подписанной correlation metadata;
session/actor/operation/permissions проверяются отдельно. Direct session
proxy создаёт свой correlationID. UUID не является авторизацией.
Первый V44 остановился до нагрузки: scratch replacement удалил TLS verifier
из driver. Actual nginx config proof прошёл; capacity этим запуском не измерена.
Исправление сохраняет verifier и весь preflight suffix побайтово; повторный
запуск требует fresh manifest и проверки final transformed driver. V44v2
прошёл preflight, затем FAIL76.518s/7652ACK: session1195.301ms. Exact probeID
связывает clientconnect→secure485.627ms и secure→headers632.085ms с nginx
request0.272s; разные временные границы не объясняют остаток. Cleanup3445.754ms
verified; 30min/fullre-auth/HUP/loadedshutdown остаются открытыми.
Ни framing, ни observer результаты не разрешают production adoption или merge.

Readiness зависит от Kafka assignment/watermarks и обоих TLS-процессов.
Измерения event-loop охватывают все три процесса, RSS/CPU/OOM — общий cgroup,
FD — все процессы. Graceful shutdown отправляет reset всем живым клиентам,
подтверждает transport close и завершение процессов в общем пределе 20 секунд.
Cleanup сохраняет предел 10 секунд; forced kill не считается PASS.

Counters Hub читаются по запросу метрик у единственного владельца; периодический
кэш не подтверждает текущую population. Histogram каждого процесса имеет одного
владельца sampling. Высокий p95 непустого окна сохраняется в bounded peak до
следующего чтения измерением, даже если перед ним пришло нормальное окно.
Readiness и diagnostic logging не сбрасывают этот peak; свежесть исходных
samples проверяется отдельно для всех трёх процессов.

## Граница действующей authority и проверка

Для изолированного эксперимента разрешено отступление от одного процесса на
контейнер в ADR-0018/runtime architecture и запрета child processes. Обычные
schema/config/permission manifests и production startup пока сохраняют прежние
значения. Immutable revision roots не изменяются. Экспериментальные сборки и
координаторы получают отдельные hashes и classification `diagnostic-only`,
`launchProof=false`; они не подменяют frozen acceptance profile.

Проверка начинается с существующих helpers и узких сценариев IPC/admission,
replay/live, backpressure, потери процесса, readiness и shutdown. Затем на том же
сервере измеряются **5000 одновременно / отклонение 5001 / 100 ACK/s / 30 минут**,
полная re-auth всех клиентов, обычный HUP, latency и headroom. Все пороги #12
сохраняются. Предварительный короткий контроль проверяет реализуемость и может
раньше остановиться при FAIL; он не закрывает acceptance criteria.

V45 продолжает только временную диагностику: два строковых поля времени в
существующем nginx log и событие ClientRequest finish. Возраст TCP-соединения
до записи лога и передача запроса локальной ОС не измеряют длительность TLS.
Runtime, заголовки, авторизация, бюджеты и критерии прежние. Действующие
архитектурные ограничения сохраняются. Full V45 FAIL74.281s/7429ACK:
APIheadroom1071.797ms, clientfinish222.178/headers1071.503ms, nginxrequest379ms,
Edgehandler2.108/APIhandler6.603ms. Cached nginx timestamps дают лишь
приблизительные интервалы; конкретная причина вне handlers ещё не доказана.
OOM0, cleanup3686.414ms verified; обязательные30min/re-auth/HUP/loadedshutdown
открыты. Бounded parsecache драйвера уже существует и сохраняет validation
каждого кадра; дополнительная оптимизация требует профиля фактического CPU.

V46 добавляет стандартный Node CPU profiler только к полному driver во временном
координаторе. Smoke, gateway и production-код сохраняют прежнее поведение.
Профили main и worker_threads собираются из существующего results bind после
проверки остановленного owned driver; ошибки и пределы чтения отражаются только
в диагностике. Критерии и исходный результат сохраняются. Node не ограничивает
размер записи профиля; sampled time включает startup и не равен CPU-секундам.
Обычный prepare, root-проверка frozen hashes, fixture112 и независимое ревью
пройдены. Full V46 — FAIL74320.260ms/7433ACK: session1104.669ms,
nginxrequest260ms/Edgehandler7.063ms, loop50.364ms; все критерии прежние.
Получены 11 профилей main/workers, включая startup и завершение; это ещё не
доказательство причины задержки. Driver exit1 без OOM, cleanup3650.629ms
verified, 8 roles/network/private удалены. Capacity и merge остаются открытыми.

V47 сохраняет V46 coordinator/profiler и меняет только helper нагрузочного
валидатора: сообщение ошибки формируется при отказе, schema проверяется для
каждого кадра. Harness29/29, tester/reviewer прошли. Full FAIL74470.353ms /
7448ACK: API request deadline без headers; exact probe nginx910ms,
auth upstream688ms, Edgehandler2.272/APIhandler5.784ms. Cleanup3575.158ms
verified без OOM. Direct gateway cgroup использовал91.25%2CPU в обычном окне
и92.37% при re-auth, с throttling в обеих фазах; это не причинная атрибуция
конкретной API-пробы. Полная приёмка остаётся открытой.

Следующий ограниченный V48 проверяет один TLS worker и того же sole Kafka/
replay owner при прежних2CPU/1GiB. Это уменьшение числа процессов в текущем
эксперименте; новый service, secret scope или wire format не вводятся.
64active targets на worker сохраняются, поэтому aggregate окно сокращается
128→64. Generation/PID/readiness/loop checks проверяют ровно1TLS+1owner;
nginx full сохраняет2workers; reference smoke использует1worker/512MiB.
Риск меньшей пропускной способности требует512/120s smoke и затем full5000/100/30min.
V48 smoke DIAGNOSTIC_PASS120000.295ms/12001ACK: re-auth512/512,
eventp95309ms/maxprocessloop26.722ms, loadedshutdown613.978ms,
cleanup3142.438ms verified. Profiler отключён; session refresh не достигнут.
Root сверил normal full manifest209sources/38compiled/14support/native/images,
SHA18b77c3040ebd2d168f29be7f88548ab665837a95de3278b370ed3107db5358b.
Full5000/100/30min при прежних2CPU/1GiB FAIL77119.515ms/7713ACK:
re-auth pre-header500,487retry504 без завершённого recovery receipt.
Поздние headroom1325ms/deadline не являются первичной причиной.
Reportedprocessloop64.651ms, cleanup3560.123ms verified;11driverprofiles
получены. OneTLS не устранил отказ и не принимается в production.
Эксперимент остаётся diagnostic-only/launchProof=false.
V46 source receipts
сохраняются неизменными, кандидат создаётся только в новых scratch-файлах.

V48-AUTH1 восстанавливает error contract/events: отказauthorizer даётtyped
503AUTHORIZER_UNAVAILABLE вместоraw500, capacity сохраняетотдельный503code.
Existingnginx-cutover/nginx:check инезависимоеreview PASS; TLSlatency этимне
устраняется. V49 возвращает2TLS+soleowner черезнеизменныйfrozenV45coordinator
безCPUprofiler, сохраняянынешнийvalidatorhelper иAUTH1. Rootnormalprepare/hash
checks209/38/14/native/images PASS, manifest
5bd668755baee395c2b549c1f0b0466b01c321dc5084cbfd17918d39b595d4b4.
Full5000/100/30min FAIL74509.347ms/7452ACK: sessiondeadline1308.352ms,
secure304.015/finish304.142ms безheaders; лишь4re-auth recovery receipts.
Reportedprocessloop45.449ms, cleanup3531.945ms verified; всеgates/2CPU1GiB
прежние. Этоdiagnostic-only unprofiledконтроль, неproductionadoption.

Отдельный EOF proof в существующем owner-browser fixture прошёл на одном
native Chromium EventSource: owner Outbox создал A и B, compiled disposable
composition усёк B перед blank delimiter и завершил private TLS response.
Тот же экземпляр переподключился с Last-Event-ID A, получил полный retained
replay B до ready и выполнил owner GET: projectionVersion 4 → 5 → 6,
OutOfSync → InSync, business version 2 неизменна. Обе публичные responses
сохранили exact SSE headers. Actual write вернул true; callback→end проверен,
false-write/drain ветка этой пробой не упражнялась. Тест 1/1, skipped 0,
cleanup verified; source/manifest/proof hashes сохранены в
[приёмке #12](../../evidence/issue-12-analysis.md). Это bounded recovery и
public compatibility proof при 512 MiB, не capacity или production adoption.

V50 добавляет только raw CPU ticks отдельных PID в существующий sampler,
без изменения runtime, 2 CPU / 1 GiB, gates или cadence. Source/self-check и
независимое review прошли; exact inverse восстанавливает frozen V45 source.
Первый подготовленный snapshot отвергнут provenance guard после изменения
EOF test: контейнеры не запускались. Новый snapshot подготовлен после
завершения test diff. V50 full завершился FAIL через75.372s/7538ACK:
TLS worker1 p95102.105ms, worker2 64.717ms, owner39.617ms; quota2CPU регулярно
насыщалась и cgroup throttled. Очереди/IPC/FD/RSS оставались в пределах,
OOM0; 30min/re-authcohort не достигнуты, cleanup verified. Raw ticks и
строгий pre-threshold срез сохранены в evidence.

Предложен один counterfactual контроль общей gateway quota3CPU при прежнем
period10000us и1GiB. nginx2CPU/1GiB, два TLS workers/один owner, остальные
ресурсы, TLS/auth и все acceptance gates сохраняются. Дополнительный CPU
может усилить конкуренцию на единственном сервере; выигрыш не доказан.
Такой результат не подменяет2CPU capacity admission. 13.10.2026 пользователь
явно разрешил один диагностический3CPU контроль V51. FULL gateway использует
quota30000/period10000; reference512 сохраняет2CPU. Источники/test diff и
override receipts проверяются до запуска. Production policy не изменена;
разрешение не означает автоматическую adoption или повторные3CPU варианты.

Единственный разрешённый V51 контроль выполнен: actual gateway3CPU,
nginx2CPU/1GiB и остальные ресурсы прежние. Full FAIL75.277s/7528ACK:
API headroom request deadline1200.243ms приgatewaymaxloop55.575ms.
Точный probe связан с Edge handler1.882ms/API4.945ms; nginx auth/main
header time306/871ms, eventual404 записан послеclientdeadline. Причинность
конкретной scheduling/TLS/network стадии не установлена.75re-auth завершены
доmarker, полных30min/cohort/HUP/loadedshutdown нет; cleanup verified.
3CPU не принимаются в production; повторных3CPU вариантов нет.

По явному запросу пользователя изучены первичные практики разработчиков.
[Авторы nginx](https://blog.nginx.org/blog/performance-tuning-tips-tricks)
рекомендуют default `multi_accept off`, пока пользаon не доказана. V52
возвращает только этот scratch V42 параметр кoff при прежних2CPU/1GiB
gateway/nginx. Runtime helpers, TLS/auth/SSE/gates и source provenance
сохраняются; дополнительные libraries/frameworks пока не вводятся. Этот
контроль не продолжает3CPUoverride. V52 full такжеFAIL79.737s/7973ACK:
session1390.076ms, connect→secure1270.309ms приmaxloop61.276ms.
Admission5000/5001 и cleanup3491.426ms verified; полного30min/re-auth нет.
Defaultoff не устранил отказ; runtime и production policy не принимаются
по этому диагностическому результату.

V53 проверяет штатную рекомендациюOpenSSL: общийclientSecureContext наworker
генератора прираздельныхper-clientAgents/sessioncaches. Nativeharness29/29,
review и exactcoordinatorinverse→V52 прошли; 5000initial handshakes остались
cold/authorized/TLS1.3. FullFAIL81.965s/8197ACK: session1159.170ms при1000ms
gate, maxprocessloop65.765ms; cleanup3803.338ms verified. Экономия создания
контекста вboundedmicrobenchmark не доказала capacity; runtime unchanged,
полные30min/re-auth/sessionrefresh/HUP/loadedshutdown не получены.

После V53 отдельный matched pre-HTTP TLS1.3 KeyUpdate контроль исключил KTLS
на текущем kernel6.8/OpenSSL3.5.7: обычный TLS прошёл client KU → server KU →
HTTP200/SSE, KTLS вернул server `internal_error` до первого GET. Software
KTLS activation подтверждена historical namespace TX/RX counters; полный
TLS session trace не сохранялся. Source/proof hashes и cleanup находятся в
[приёмке #12](../../evidence/issue-12-analysis.md). Этот вариант не получает
нагрузочный запуск и не принимается в runtime.

Гипотеза V54 с публичным nginx `ssl_buffer_size`4→8KiB отклонена до правок
и нагрузочного запуска: pinned non-buffered upstream filter помечает каждый
recv-produced буфер `flush=1`, поэтому больший send buffer не объединяет
соседние reads. Влияние на отдельную крупную цепочку не измерено; source
анализ и ссылки сохранены в evidence. Runtime/config не менялись.

V55 использовал только встроенные Node CPU-профили owner и двух TLS workers
в disposable full coordinator, без изменения runtime/crypto/бюджетов/gates.
Запись в tmpfs отклонена из-за отсутствия post-exit экспорта; использован один
пустой scoped0700/UID1000 profile bind. Все три PID-allowlisted профиля
сохранены; общий cleanup5250.737ms/10s verified. Driver FAIL8.083s/809ACK:
API1005.370ms при1000ms. Поздняя monitor ошибка driver exit заменила ошибку
в coordinator result; historical artifacts сохранены, normal fixture получил
узкий exit guard с harness29/29, targeted1/1, lint и независимым reviewPASS.
Profiler overhead и startup/teardown в профилях являются диагностическим
ограничением; этот запуск не является production capacity proof. Nativewrite
sample label не разделяет crypto/copy/syscall CPU. Наблюдение native Node
TLS1.3 `X25519MLKEM768`, включая resumed connection, отдельно записано в
evidence; вклад группы в отказ ещё не измерен, policy не менялась.

Если выигрыш подтверждён, требуется одна итоговая реализация, согласованные
runtime/spec/config/permission изменения, обязательные проверки и обычный
frozen full profile. Если выигрыш не подтверждён, эксперимент не принимается
в production и не даёт основания для merge или закрытия #12. Цена кандидата —
IPC, дополнительная память и новая граница отказа — также подлежит измерению.


Следующая ограниченная гипотеза V56 меняет только порцию TLS-worker target
queue:16 вместо64 за `setImmediate`-ход. IPC window/batch64, FIFO, actual
callback+drain ACK, queue budgets, fanout250ms, auth/TLS и2CPU/1GiB сохранены.
Кандидат unprofiledV53 включает исправленный terminal-driver observer;
профилирование V55 не переносится. Уменьшение порции даёт более частые точки
передачи управления по [Node26.8.1 timers](https://github.com/nodejs/node/blob/v26.8.1/lib/internal/timers.js#L491-L508),
но может увеличить число IPC/ACK вызовов. Syntax/minfixture/selfcheck71+3,
no-undef/inverse/independentreview PASS. Full V56 FAIL80.298s/8028ACK:
direct private mTLS gateway health1618.282ms при1000ms. Cleanup3705.298ms
verified; observer сохранил первичную ошибку. Порция16 не устранила re-auth
headroom и не принимается. Production process model и wire-format authority
сохраняют статус непринятого эксперимента.


V57 добавил только bounded private TLS/health timing и observer порта4401;
после исправления ordered source stages full снова FAIL80.491s/8050ACK:
public health1028.667ms при1000ms. Все154private probes сопоставились поUUID;
на медленном успешном запросе основное ожидание было до connectioncallback,
а accept→secure занял56.874ms. Общая CPU scheduler pressure наблюдается у
nginx и gateway; данные не разделяют очередьaccept/синхроннуюsetup/планирование.
Cleanup3695.121msverified, production adoption не подтверждена.
Следующий локальный V58control повышает только fixedsoftCPUshares двух
fixture roles до4096, сохраняяhard2CPU/1GiB/двухTLSworkers и всеgates.
[CPU weight](https://docs.kernel.org/admin-guide/cgroup-v2.html#weights)
задаёт относительный приоритет при конкуренции, а не резерв процессоров.
Actualweight/quota/period/cpuset проверяются доdriver. Такой контроль
подтвердит только отдельныйweightedprofile; нормативный deployment/schema
и production CPU priorities требуют принятогоauthority решения.


V58 source/selfcheck/independent review прошли; actual weights303/100 и
неизменныеhardресурсы8ролей подтверждены. FullFAIL81.271s/8127ACK:
direct gateway mTLShealth1218.060ms при1000ms. Admission5000/5001 прошёл,
полные30min/re-auth/SLO не приняты. Cleanup3911.204msverified,8ролей/network/
private material удалены. Повышенныеshares не принимаются вproduction.
По просьбе пользователя после проверки V58 работа приостановлена;
productionarchitecture/spec/permissions иmerge #12 остаютсянепринятыми.
