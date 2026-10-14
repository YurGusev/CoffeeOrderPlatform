# Приёмка разработки issue #12

> Срез 14 октября 2026: owner peak 100 × 10 прошёл без повторов клиента после
> bounded Orders admission; см. раздел «Orders admission — 14 октября 2026» в
> конце файла. Ниже сохранена история прежнего 5000-SSE профиля. Её FAIL не
> переаттестованы; operator-1 и итоговый handoff #12 ещё не приняты.

Все 64 пункта issue сопоставлены с кодом и фактическими проверками в таблице ниже.
Remote read13.10.2026 12:06UTC подтвердил OPEN/64checkboxes/48checked;
GitHub authority/origin совпадают, bodySHA90d63ce2ac7b3af4364bcda88f44cebcb1a83c155936c1e3468753a147976716.
Мерж пока не готов: обычный полный профиль 5000 клиентов не прошёл re-auth и
headroom. Диагностические варианты не засчитываются как приёмка. Все проверенные
комбинации initial ramp, TLS preference и CPU affinity также завершились FAIL.
Последний V58 с фиксированными CPU shares завершился FAIL через81.271s /
8127ACK: direct gateway mTLS health1218.060ms при1000ms gate во время re-auth.
Admission5000/5001 прошёл, но повышение мягкихweights не устранило отказ.
V57/V56 такжеFAIL; исправленный observer сохраняет первичную ошибку.
V55 CPU-профили остаются отдельной диагностикой. 30минут и full acceptance
не подтверждены. По просьбе пользователя после проверки V58 работа приостановлена.
Uncommitted work и все receipts сохранены.
Пользователь разрешил ограниченный процессный эксперимент; его границы закреплены
в [ADR-0033](../docs/adr/ADR-0033-realtime-tls-process-experiment.md).
Два TLS-процесса с рабочим окном 64 IPC targets на worker прошли V22 и V26 smoke
512 клиентов / 120 s. Полный V39 вернул прежний V37 без profiler
и изменил только private successful SSE framing на close-delimited.
Bounded actual nginx/mTLS/bytes/callback+drain/EOF проверки прошли. Позднейший
owner-browser v2 доказал linked mid-frame EOF→automatic reconnect→replay
на одном native Chromium EventSource; это не полный capacity proof.
Full завершился FAIL через78.490s/7850ACK: public nginx health headroom1294.378ms
>1000ms. TCP connect42.542ms, secureConnect1276.095ms, headers1294.049ms —
избыточная задержка до secureConnect. Источник внутри public TLS setup не разделён.
Direct gateway headroom до threshold≤201.137ms, all-process loop≤45.777ms.
Все5000 initial cold handshakes и5001preheader503 прошли; до threshold только
7complete resumed re-auth/gaps3.215–6.912s, retry504нет. Full recovery не принят.
Private gateway accept queue≤45/drops0, public nginx accept queue не измерена.
RSS/cgroup/FD бюджеты не нарушены, OOM нет; cleanup3427.934ms verified.
V40 сохранил runtime V39 и добавил host observer публичного nginx.
FAIL через80.522s/8053ACK: session headroom1307.735ms, secureConnect1281.287ms,
loop53.936ms. В25снимках строго до first threshold publicqueue≤44; последний
queue0 завершён за5.794s до threshold. Снимок queue405 выполнен уже ПОСЛЕ
threshold и не доказывает причину. Host snapshots идут с gap около6s;
короткие queue peaks могут быть пропущены. Последний полный prefatal Nginx
CPU interval не имел прироста CFS throttling; schedstat sum run-delay1.939s
заоколо6.2s относится к двум workers, без привязки к failing request.
Cleanup3563.136ms verified; 30min/fullre-auth/HUP/loadedshutdown не достигнуты.
Последний V41 изменил только частоту observer. FAIL80.452s/8046ACK:
publichealth1669.376ms>1000ms, connect→secure1488.481ms, loop51.511ms.
Теперь publicqueue48→134→170→139→367 измерена ДО threshold; последний снимок
завершён за237ms. Drops/overflows и CFS throttle delta0; worker aggregate
run-delay1.258s за1.536s не привязан к конкретному запросу. Причина не доказана.
Все138observer rows доступны, наблюдение занимает median108.6/max256.7ms
включая Docker identity discovery; отдельная стоимость observer не измерена.
Cleanup3519.379ms verified. V42 добавил только scratch `multi_accept on` и
проверку nginxconfig. FAIL73.342s/7335ACK: API1214.746ms>1000ms, при этом
connect→secure145.231ms и secure→headers898.452ms. Prefatalqueue≤15 против
367 в V41 согласуется с меньшим backlog; разные виды failing probes и единичные
runs не доказывают причинный выигрыш. V43 завершился FAIL через73.314s/7332ACK:
API timeout до ответа. До первого известного failure marker publicqueue≤7,
IPC rejection/error0, processloop≤51.970ms, OOM0. Один exactID связывает nginx
request1.140s с Edgeauth53.971ms и API10.006ms; у упавшей пробы responseID нет,
поэтому это ещё не доказательство причины её timeout. V44v2 связал первый
failed session probe с nginx/Edge: full FAIL76.518s/7652ACK, client1195.301ms,
nginxrequest272ms, Edgehandler1.294ms. До первого threshold acceptqueue≤24,
IPC errors0, OOM0; max reported processloop98.370ms. Разность таймеров пока не
локализует задержку. V45 full FAIL74.281s/7429ACK: APIheadroom1071.797ms,
clientfinish222.178/headers1071.503ms, nginxrequest379ms, Edge2.108/API6.603ms.
Raw nginx timestamps имеют cachedclock/разные origins; причину вне handlers
они пока не доказывают. Исследуется CPU локального генератора; production
runtime/config прежние. V46 full FAIL74.320s/7433ACK: session1104.669ms,
nginx260ms/Edge7.063ms, loop50.364ms; 11 driver CPU profiles получены,
cleanup3650.629ms verified без OOM. 30min/fullre-auth/HUP/loadedshutdown открыты.
V47 с тем же V46-координатором и profiler меняет только helper нагрузочного
валидатора. Harness29/29 и ревью PASS; full FAIL74.470s/7448ACK:
API request deadline, secure176.515/finish184.635ms, без headers.
Тот же probe: nginx910/auth688/API222ms, Edge2.272/APIhandler5.784ms.
Cleanup3575.158ms verified; все30strict completed re-auth resumed,
gaps4.343–6.618s. Улучшение live p95 не доказывает capacity или причинность.
V48 уменьшает scratch TLS workers2→1 при том же sole Kafka/replay owner.
Smoke512/120s DIAGNOSTIC_PASS:512/512re-auth, p95event309ms,
maxprocessloop26.722ms, shutdown613.978ms, cleanup3142.438ms verified.
Reference smoke использует1nginxworker/512MiB; full сохраняет2workers/1GiB.
Root сверил full manifest209sources/38compiled/14support/native/images;
full5000/100/30min FAIL77.120s/7713ACK: re-auth pre-header500,
последующие headroom probes1325ms/deadline. Cleanup3560.123ms verified;
30min/full re-auth/HUP/loadedshutdown не достигнуты. launchProof=false.
V49 unprofiled2TLS+owner контроль такжеFAIL74.509s/7452ACK: sessionrequest
deadline, secure304ms/finish304ms безheaders. Profiler отсутствовал; улучшение
capacity не доказано. Cleanup3531.945ms verified, fullgates остаются открытыми.
V50 с отдельными CPU-счётчиками PID завершился FAIL75.372s/7538ACK:
TLS worker1 loop p95102.105ms при100ms gate; worker2 64.717ms, owner39.617ms.
Gateway cgroup регулярно достигал2CPU и throttled; очереди/FD/RSS/OOM в норме,
cleanup3883.329ms verified. Единственный разрешённый контроль3CPU V51
завершился FAIL75.277s/7528ACK: API deadline1200.243ms приmaxloop55.575ms.
Production budget не принят. Возврат scratch nginx кdefault multi_acceptoff
V52 такжеFAIL79.737s/7973ACK: session1390.076ms, преимущественно доsecureConnect,
maxloop61.276ms. V53 переиспользовал clientSecureContext при прежних
per-clientAgent/coldhandshake/gates: nativeharness29/29 и reviewPASS,
ноfullтакжеFAIL81.965s/8197ACK/session1159.170ms. CleanupV51/V52/V53 verified;
полного recovery/30min нет.
Bounded EOF owner-browser v2 PASS1/1/skipped0: тот же native EventSource,
Last-Event-ID A, полный replay B доready, ownerGET и publicSSEheaders доказаны.
Это1-client recoveryproof, неcapacity илиproductionadoption.
Предыдущий V38 дал отдельные FAIL headroom и RSS; снятые worker profiles
показывали47.49% nativewritev sampled wall time, без разделения overhead/CPU costs.
Риски границ окон V32-D1 и yield V32-F2 воспроизведены и исправлены в scratch.
Устранение повторного frameRecords count в диагностическом V37 не доказало
достаточность схемы; aggregate2CPU/1GiB и все нагрузочные gates сохранены.
Обязательные 30 минут, полный re-auth, HUP в 900 s и loaded shutdown не достигнуты.
Достаточность схемы не доказана. Коммит, push, PR и merge не выполнены.

Свежий `PATH=/tmp/coffee-12-proof-bin-jBGChb:$PATH pnpm check` после AUTH1,
EOF owner-browser v2 и lazy validator helper — PASS: 817 тестов, 746 успешных,
0 отказов, 71 explicit live-тест пропущен. Длительность test suite —
96127.322202 мс, код выхода всей команды — 0. Лог
`/tmp/coffee-12-current-check-20261013.log`. Authority/toolchain/config/contracts,
typecheck/architecture/rule parity/lint/UI/build/browser gates прошли.
Общий check не заменяет полный capacity-прогон или отдельно запущенный
owner → Kafka → SSE → браузер proof. Следующий fixture SecureContext diff
будет проверен существующим targeted harness и новым full отдельно.

Предыдущий общий check после V11/V12 также прошёл: 816 tests, 745 passed,
0 failed, 71 explicit-only skips, 100239.794ms. V13 добавил regression настоящего
mTLS expiry/transport-close и forged reconnect; все остальные проверки сохранены.

Отдельные финальные команды: `pnpm contracts:check-generated` — byte-identical;
`pnpm contracts:test` — 49/49; `pnpm architecture:check` — PASS;
`pnpm test:realtime-contract` — 5/5, `pnpm test:realtime-auth` — 9/9 после V13,
`pnpm test:realtime-replay` — 8/8, `pnpm test:realtime-backpressure` — 14/14,
`pnpm test:web-realtime` — Vitest/browser PASS (10 browser scenarios).
Все эти тестовые команды завершились с кодом 0 без пропусков. `pnpm test:realtime-soak`
без аргументов ожидаемо отвергнут CLI guard (exit2), профиль по умолчанию
reference-512 не может запустить full; явный `--prepare --profile isolated-5000`
прошёл. Freeze/prepare не является capacity PASS.

Свежий owner-browser после V14 — PASS: `PATH="$(cat /tmp/coffee-12-v10-proof-bin-path):$PATH" TMPDIR=/home/yurgusev/.hermes/cache/scratch/issue12-owner-browser-final-v14-20261012 COFFEE_DB_LIVE_PROOF=1 COFFEE_REALTIME_OWNER_LIVE_PROOF=1 node --test --test-concurrency=1 --test-name-pattern='preparation owner realtime vertical' tests/orders/aroma-preparation-live.test.mjs`, exit0,1/1 безskips,151344.955ms. Артефакт `issue12-owner-browser-final-v14-20261012/issue12-owner-browser-1ZKBPi/transport/owner-browser-proof.json`: настоящий isolated owner PostgreSQL/Outbox/native Kafka/receiver/served production SPA; projectionVersion4→5, businessVersion2→2, AROMA OutOfSync→InSync, ownerReads4; duplicate/stale broker ACK+commit без лишних изменений, restart/reset/refetch356.500ms, exit0. Cleanupverified3712.694ms,7transport containers+owner/network/private material удалены. Это ограниченный vertical proof с production nginx build, не полный Orders composition/Draft emission/failure matrix/capacity/production admission.

Предыдущий `pnpm check` после V10 — FAIL: 817 tests, 745 passed, 1 failed,
71 explicit-only live tests skipped. До общего test suite contracts/typecheck,
architecture, lint, web build и browser-проверки прошли. Отказ —
`queued live hints share one bounded write; all in-flight frames remain immutable
until its callback`: фиксированный `sleep(10)` завершился до scheduled write,
поэтому assertion увидела ещё `stream-ready`, 0 вместо 3 invalidations. В этом
regression заменены обе произвольные паузы ожиданием существующих наблюдаемых
условий через `until`; assertions и production deadline сохранены.
Повтор `pnpm test:realtime-backpressure` — 14/14 PASS, skipped 0,
8077.989ms. После этой test-only правки свежий общий check выше прошёл.

Контроль стадий hub (stock nginx, 4 KiB, 64 pumps): manifest
`abdb7b59b76e5acbc8f246817fadfa76d1d8fe76c303a5ff7e11f0614f237994`.
После проверки неизменённого snapshot только его compiled hub получил
диагностические агрегаты без IDs/business data и новых timers; pump/write
sampled 1/64. Helper прошёл syntax/import, backpressure 14/14 и независимое
ревью. Диагностическая длительность — 120s, gates сохранены. На одном
непустом окне в main phase source-age max составил 126ms, coalesce/fanout
callback max — 12.925ms, ожидание schedule→pump max — 904.149ms,
write→callback max — 22.535ms. Это разделяет наблюдаемый scheduler wait и
callback wait; sampled histogram buckets дают верхние границы, не точные
percentiles. Контроль завершился FAIL через 75780.753ms / 7579 ACK:
`HEADROOM_LATENCY_EXCEEDED`, readiness kind 3 — 1509.384ms. Последняя live
p95 по shards — 1058–1061ms (последний stats snapshot до ошибки), event-loop
p95 — 88.015ms. Admission и HUP прошли. Полный expiry/re-auth и capacity
остаются непринятыми; fixture cleanup verified. Измерительный код в продукт
не добавлен.

Независимый анализ main-only стадий вычел preflight baseline: 7289 accepts против 7295 ACKed публикаций. Среднее source-age — 55.2ms; coalesce timer lateness — 6.4ms; fanout — 14.5ms; schedule→pump — 805.0ms (max 1630.8ms); write→callback — 11.7ms (max 147.9ms), наблюдений drain — 0. Это локализует измеренный хвост в scheduler wait. Сумма средних не является точным разложением p95. Отказ health совпал с expiry: TLS secure занял 1480.5ms; зарегистрированы 168 re-auth retry HTTP504 до fatal. Последнего stage scrape нет за 1.5s до fatal, поэтому причинность TLS wave и полного recovery ещё не доказана.

V11: независимое ревью обнаружило unscoped mounts синтетического стенда для Edge/API/Realtime: whole privateDir в `/fixture` и whole resultDir в `/results` позволяли читать чужие fixture keys. Production Compose/bootstrap уже выдают scoped tmpfs, утечка production material не установлена. Исправление стенда ограничивает mounts собственными config/role secrets и public CA, исключает `/results`, сверяет actual inspect Mounts и проверяет доступ UID1000 с записью только проверенных путей. Source-review PASS; targeted regression после исправления vacuous argv assertions — 1/1 PASS, skipped 0 (217.955ms). Actual UID1000 negative-read receipts в контролях128/8KiB/public-ChaCha подтвердили все три роли; свежий полный transport остаётся ожидающим. File bind стенда не подменяет production tmpfs proof.

Контроль official nginx с обычным 4 KiB upstream buffer и 64 pumps:
manifest `02673deaa66564a55f174a46369fc92e462744e0501c131bdc7617cffe042248`,
официальный image ID
`sha256:e9567a94eddcc1f293d083044d4c988b853fe17c2a462f343704bcb1ea01c9a6`.
После проверки исходного snapshot изменены только диагностическая длительность
120s и runtime image nginx; overrides сохранены отдельно. Контроль завершился
FAIL через 78913.511ms / 7889 ACK: `request deadline realtime-gateway/health/ready`
во время expiry/re-auth. Admission 5000/5001 и настоящий HUP прошли. На последнем
measurement snapshot при 73.15s hub принял 7302 новых записи против 7300 новых
ACKed публикаций; приём держался около 100/s. Последняя live p95 по shards —
1061–1063ms, replay histogram ещё пустая; gateway event-loop p95 — 78.381ms.
Наблюдаемый cgroup peak nginx достиг 735121408B (около 701MiB), gateway —
630312960B (около 601MiB), OOM/oom_kill=0. Полный re-auth, loaded shutdown и
30-minute capacity не приняты. Fixture cleanup verified, 3529.566ms; восемь
контейнеров, сеть и synthetic private material удалены. Этот контроль не доказывает
достаточность stock image на 30 минут и не заменяет полную приёмку.

Дополнительный контроль scheduler: замороженный manifest
`6d312122bc99c4434810c22ae39dbd5e6e9b89d5292f512ca8dd9b28cab648ad`
проверен до диагностических overrides. Только в копии compiled hub число
соединений за проход увеличено с 64 до 256; длительность контроля — 120s,
остальные бюджеты, TLS, очереди и пороги сохранены. Контроль завершился FAIL
через 17000.725ms / 1701 ACK с `COVERAGE_UNAVAILABLE`; последняя live p95 по
shards — 4291–4298ms, replay ещё не было. Это изменение в продукт не включено.
От первой measurement строки до 16.23s hub принял 1050 новых записей против
1610 новых ACKed публикаций. При 64 pumps в предыдущем 4 KiB контроле
hub принимал около 100/s. Это измеренный lag до `hub.accept`, но отдельные
времена native poll, worker и commit callback не измерены; точная причина
ещё не доказана. Gateway event-loop p95 достигла 96.928ms. Все восемь
контейнеров, сеть и synthetic private material удалены; cleanup verified,
3128.963ms. Короткий диагностический FAIL не является capacity evidence.

Контроль 128 pumps, manifest `cacf4a897b148ef40624d5c99c23344d43ff36c61a6f192c4c2cc2009a349428`: исходный frozen snapshot и official nginx ID проверены до scratch overrides. FAIL через 80233.760ms / 8024 ACK, `REAUTH_ESTABLISHMENT_FAILED`, SSE preheader HTTP500. nginx log зарегистрировал auth subrequest TLS handshake timeout504, преобразованный auth_request в500. Последний client snapshot до fatal: live p95 1957–1960ms, replay histogram ещё пустая; gateway event-loop p9578.905ms. Размер партии в продукте остаётся64. Admission/HUP прошли; loaded shutdown и30-minute capacity не приняты. Runtime negative-read receipts для Edge/API/Realtime подтвердили V11: разрешены только собственные config/role files, запрещены общий fixture, чужой role secret, CA private key и `/results/private/fixture.json`. Cleanup verified.

Контроль upstream buffer 8KiB при stock nginx/64 pumps, manifest `d7df9e91b53b299a86e319e4d5a4a723ba894936be3ffe04ee80a5e28d086be1`: изменены только scratch nginx SSE `proxy_buffer_size8192` и120s diagnostic duration после frozen verification. FAIL через79070.704ms /7908ACK, `request deadline realtime-gateway/health/ready` во время expiry/re-auth. При74.14s accepted7401 против7399ACK, все5000 были admitted, HUP прошёл. Последний client snapshot до fatal: livep951099–1102ms; eventloopp9583.296ms. Изменение в продукт не включено. Cleanupverified3498.870ms, ownedcontainers/network/private удалены. В `result.json` сохранилась скопированная метка128; `classification-correction.json` фиксирует исходный resultSHA и правильную8KiB классификацию, измеренные данные не переписаны.

Контроль только public client ChaCha20 на8KiB upstream baseline, manifest `1f74b8a197e3d9e10dc5aa855a16b108e8278a001f87dd622302d0fa4d3523c2`: все5000 фактически negotiated TLS1.3/CHACHA20_POLY1305_SHA256, upstreammTLS/policy неизменны. FAIL через78393.461ms /7840ACK: readiness deadline во время expiry/re-auth. Последний snapshot livep951067–1069ms, gatewayeventloopp9577.726ms. Cipher policy продукта не менялась; эксперимент не принят какcapacityproof. Cleanupverified.

V12: гипотеза потерянного Edge upstream keep-alive опровергнута real cutover на неизменённом generator. Авторизатор фактически получает два запроса без `Connection` header на одном TLS socket; оба возвращают свежие проверенные подписью actor/correlation assertions. Избыточная директива `Connection` удалена. После независимого P2 review тест требует точный `503 AUTHORIZER_UNAVAILABLE`; финальные `pnpm nginx:check`, `pnpm test:nginx-cutover` и diff check прошли на baseline. Продуктовая причина performance FAIL этим тестом не найдена.

Контроль 4KiB/stock/64 pumps с public и gateway Node TLS ChaCha20, manifest `fc8a50dc9137b6c377239bd54f3696032c319019615f436c20a5b86d49e6cb02`: verified frozen snapshot, 5000 public и 5068 admitted gateway streams фактически negotiated TLS1.3/ChaCha20. Только scratch clients/driver, logging compiled gateway и Node CLI cipher flag; последний затрагивает все Node TLS contexts gateway, не только входящий upstream. Диагностическая длительность120s. Live p95 последнего snapshot904–907ms против1061–1063ms у обычного4KiB контроля, но FAIL через77581.068ms /7755ACK: readiness request deadline при expiry. Eventloopp9557.868ms, admission/HUP пройдены; полный re-auth, loaded shutdown и30-minute capacity неприняты. Cleanupverified3402.379ms. Это локализует частичный выигрыш, но не доказывает достаточность cipher policy; в продукт изменение не включено.

Диагностический контроль TCP/TLS стадий, manifest `0013fa3104556692d8c16cc1239e108ce3710dee79f8957563a80ee1b0b4234b`: тот же4KiB/stock/64/both-ChaCha scratch baseline; дополнительные bounded error timings и cumulative TCP/TLS counters без новых timers. FAIL80144.061ms /8015ACK, `REAUTH_ESTABLISHMENT_FAILED` SSE preheader500. До expiry5129accepted=secure,5004resumed, errors0, listen queue0 и ListenDrops0. Во время re-auth в11:37:15–18 actual gateway TCP listen queue достигла512–513, ListenOverflows/ListenDrops выросли до1270. Последние counters: accepted5417/secure5308/resumed5046/errors107; counters включают cold direct-health probes, поэтому разность resumed сама по себе не определяет процент re-auth resumption. Совпадение заполнения TCP queue и отказов измерено, достаточность изменения backlog ещё не доказана. Full capacity непринят; cleanupverified3473.342ms.

Контроль backlog5000 (kernel somaxconn4096), manifest `1de5e39956202092effebb76c711338a8457813ca2912d14f5327ef976486c88`: только scratch gateway listen, прежний4KiB/stock/64/both-ChaCha baseline. FAIL77499.308ms /7750ACK, readiness deadline в re-auth wave. TCP connect16.856ms завершён, secureConnect/HTTP не получены за2024.230ms. ListenDrops/Overflows0, но actual LISTEN Recv-Q вырос до921: очередь необслуженных соединений сохранилась. Это не доказывает тяжёлую TLS crypto operation; failing socket мог ждать accept(). Последняя livep95 shards953–959ms, replay ещё пустая; eventloopp9581.330ms. Auth closes0 до11:48:16, затем1185 к11:48:21.423; live5000→3863. Accepted5348/secure5323/errors23 не включают kernel LISTEN queue. Backlog в продукт не включён; недостаточность изменения измерена. Cleanupverified3342.350ms, все8ownedcontainers/network/private удалены. Полная приёмка непринята.

Первые два диагностических сбора re-auth CPU не дают профиля Gateway: в первом файл в container tmpfs не удалось забрать до cleanup; во втором включение inspector в re-auth wave сопровождалось event-loop threshold FAIL до завершения3s capture. Manifest первого `85978d3fa6b33ca81eaefc2abf6fd0dfe083a9cad125907bd7d173db5e197924`, FAIL76711.594ms /7672ACK; второго `00d2f3b3499ba9cedfd902629f906480f6ab8e62ae5947e24bc23ae20037a6ac`, FAIL71070.174ms /7108ACK. Оба cleanupverified. Второй профиль Edge сохранён за12:06:12.797–15.889 до основной expiry wave: sampled idle96.26%, inspector post2.64%; это не атрибуция fatal Gateway и не capacity evidence. Включение sampler перенесено в pre-measurement admission; никаких production profiler hooks не добавлено.

CPU-профиль re-auth wave сохранён до cleanup, manifest `5afc8a65a6615dce2d4d4c3a3d6ef79d28b029c812bf35957ce818e5257798e6`. Inspector включён до measurement на5000-м request; public sampling5000µs, max180s/100000samples, scoped SIGUSR2 stop/flush. Контроль остался FAIL: SSE preheader500; thresholds не менялись. Approximate end-wall/V8 mapping отличается от wrapper start на26ms Gateway/13ms Edge; для pre-fatal оценки исключены последние300ms до failure12:13:11.656. В3s pre-fatal weighted2998ms interval Gateway callback `validateActor` inclusive25.49%/764ms, `verifyOneShot` inclusive19.42%/582ms. Это измеренная стоимость повторной crypto/claims проверки неизменного assertion по30s interval; admission получает отдельную полную проверку. Native `writev` self22.64%; затраты TLS encoding/encryption/syscalls этим profile не разделены. Edge в том же3s window sampled idle38.96%. Процент samples не является гарантией ускорения wall clock; capture не заменяет capacity PASS. Cleanupverified.

V13: существующее сравнение `iat/exp/5s skew` вынесено в общий boolean helper; новая admission по-прежнему проверяет подпись, форму, issuer/audience, permissions/operation/correlation/trace и integer clock guard. Для retained route-local claims периодический callback проверяет только время, без cache/TTL extension/keyset reload. Норматив20:97–110 требует именно expiry30s и не обещает мгновенную серверную ревокацию; static keyset и local claims ownership проверены независимым reviewer. Regression проверяет границы skew/clock rollback, настоящий mTLS expiry → response+TLS socket close и forged reconnect403 до SSE. `pnpm test:realtime-auth`9/9 PASS; security actor-context1/1 PASS. Независимый P2 gap закрыт добавлением actual transport-close receipt. Дополнительно `pnpm test:realtime-replay`8/8 и `pnpm test:realtime-backpressure`14/14 PASS безskips. Full capacity после V13 ожидается; измеренные percentages не принимаются как готовый выигрыш.

V13-only контроль с обычными TLS policy/TCP backlog, manifest `19ae76b95111d30d344e4d52b852976ecb203f184e4700fb62ebc46b4a4d461a`, native Node image `sha256:acb60867d943affd2d4cea74ccba1eb9ca56e5c60f0964be1c15986572cf4356`: FAIL82008.880ms /8200ACK, `REAUTH_ESTABLISHMENT_FAILED` SSE preheader504. Admission5000/5001/HUP прошли; всеSLO/CPU/1GiB ceilings сохранены. До53.13s clientsp95 shards1039–1042ms, live5000/headroom≤175.748ms. Послеexpiry получены только2successful end-to-end re-auth receipts из5000, одинgap11577ms/resumedTLStrue; это не полное recovery. Loopmaxreported75.301ms; fullcapacity/loadedshutdownнеприняты. Cleanupverified3764.155ms. V13убрал подтверждённую лишнюю crypto работу, но достаточность изменения длясервера этим прогоном опровергнута.

V13 preferred-cipher контроль: manifest `e21a94e776118f899e8929520558f994113bfe7be3b7e75a91e8015b4e15e43e`, run `i12-4ca6b445d9ae429f`. После V8 verification только scratch snapshot получил приоритет ChaCha20 на realtime TLS server и public nginx; обычные SSE clients сохранили Node TLS defaults. Сохранены CA, hostname/SPIFFE, client-cert verification, TTL, CPU/1GiB и SLO. Семь реальных probes подтвердили default ChaCha20, AES128-only и AES256-only на обоих серверах, а также public TLS1.2/AES128; все вернули 200 и authorized TLS. Все 5000 первоначальных SSE handshakes — TLS1.3/ChaCha20, cold/authorized. Разрешённые TLS1.2 suites сохранены, но `ssl_prefer_server_ciphers on` меняет порядок их выбора. Individual initial receipts не содержат shard из-за отсутствующего поля в ready message; count/cipher assertions проверили все 5000 sockets.

Этот scratch контроль завершился FAIL через 82185.722ms /8218ACK: `REAUTH_ESTABLISHMENT_FAILED`, SSE preheader500. На последнем stats snapshot live p95 shards874–879ms, replay samples ещё отсутствовали; это не полный combined percentile. Admission5000/5001/HUP прошли. Получены 25 actual re-auth receipts из5000, все с resumed TLS, gap максимум10740ms, и1450 retry receipts. Loopmaxreported57.672ms. Nginx зарегистрировал786 TCP-connect и793 TLS-handshake timeouts к realtime upstream,46 TLS-handshake timeouts к Edge auth; Edge обработал дошедшие requests без5xx, max completed response112.400ms. Это не доказывает отсутствие handshake/accept starvation. Cleanupverified3764.350ms, owned8containers/network/private material удалены. Classification `diagnostic-only-v13-preferred-ciphers`, `launchProof=false`; product cipher policy не принята, full re-auth/capacity/loadedshutdown ожидаются.

V13 preferred-32/stages: manifest `4297cc390917f8cb88f15f1ef11a550aabfb9e4031e8e66e1549d36348621208`, run `i12-bb5ffc50a087492c`. После проверки snapshot global dispatcher уменьшен с64 до32; per-write frame batch64, все thresholds/TTL/budgets сохранены. Добавлены scratch-only public TCP/TLS counts и accept→secure fixed histograms с Map≤12288, sampled hub stages и безопасные nginx upstream timings. Temp backpressure/replay22/22 и independent review прошли; root обнаружил и до run исправлен tuple/values дефект diagnostics receipts, теперь shard берётся из Map.entries.

Контроль FAIL73641.363ms /7365ACK: cold readiness TCP connect48.132ms, TLS secure отсутствует до deadline2049.800ms. Последняя live p95 shards947–950ms; re-auth successes0, retries625. Последний отдельный gateway-metrics snapshot12:56:49.034UTC: rawaccepted5482/secure5424/resumed5153/TLSerrors55; accept→securemax128.809ms, Mapoverflow0/missingstarts55. Missing starts относятся к TLS errors, поэтому histogram не описывает время всех оборванных handshakes. На listener4401 RecvQ достиг512; namespace-wide ListenOverflows/ListenDrops вырослидо125. Эти counters не уникальны для listener, заполненная очередь относится к нему непосредственно. В том же последнем metrics window sampled schedule→pumpmax1612.980ms, coalesce fanoutmax34.150ms, write→callbackmax43.847ms. Ни один отдельный замер не доказывает единственную причину starvation. Loopmaxreported56.721ms; loadedshutdown/fullcapacity не приняты. Cleanupverified3575.456ms. Dispatcher32 отклонён как исправление; product остаётся64. Classification `diagnostic-only-v13-preferred-32-stages`, launchProof=false.

V13 preferred-64 без раннего HUP: manifest `c8796792418edfed58719173fff1529af31d7fe442ff216c9e4064080282071e`, run `i12-1b68b3a5b7564b27`. Scratch сохраняет штатную отметку HUP900s, поэтому в120s контроле reload не выполнялся. FAIL79871.748ms /7987ACK: readiness TCP connect22.119ms, secureConnect не наступил до2032.478ms. Сбой до HUP опровергает его необходимость для воспроизведения этого отказа. Последняя live p95 shards947–949ms, replay histogram пустая; loopmaxreported64.291ms. Все642 re-auth receipts — retries504, successful recovery0. В свежем gateway-metrics snapshot13:14:56.448UTC accepted5398/secure5328/resumed5089/TLSerrors68; accept→securemax135.934ms, Mapoverflow0/missingstarts68. Nginx зарегистрировал647 upstream timeouts во время TLS handshake. За последние2.77s auth_close вырос730→1562, scheduled2305→2877, queuedRecords18840→42360; это корреляция, а не доказательство стоимости отдельного close callback. Gateway потреблял около0.9–1.05 CPU-seconds/s, nginx1–1.56, driver2.47–3.86; новое cgroup throttling в последних интервалах отсутствовало, конкуренция за физические ядра отдельно не измерена. Cleanupverified3520.544ms, owned8containers/network/private material удалены. Classification `diagnostic-only-v13-preferred-original-hup-timing`, launchProof=false. Полный reload, re-auth, loadedshutdown и30-minute capacity этим контролем не приняты.

Текущий V13 CPU diagnostic: manifest `1e3693cc8a2bf15860d5f036da2b267f9778ce48b40c8e41c31158d938c921de`, run `i12-46783cfff4cf43a1`. Preferred-TLS scratch, dispatcher64,120s/HUP900s; bounded public inspector Gateway/Edge и Worker.startCpuProfile для10 shards. Сохранены12 профилей до cleanup; profiler overhead явно исключает capacity acceptance. FAIL80417.066ms /8039ACK: realtime readiness headroom1624.566ms>1000. Успешные re-auth receipts61/5000, maxgap8793ms, retries942; последние shard combinedp95896–901ms, но только часть replay доставлена до отказа. Loopmaxreported56.001ms. Cleanup verified10541.862ms, все8 containers/network/private удалены; это время включает diagnostic profiler flush и превышает10s, поэтому оно не засчитывается как loaded cleanup PASS.

В baseline10–40s Gateway native `writev` self61.36%, inclusive `writevGeneric`65.80%; stack `connectionCorkNT → uncork → clearBuffer → Socket._writev → writevGeneric`. Pump inclusive3.51%, coalesce enqueue2.51%. Retained `validateActor` inclusive0.37%, pre-fatal3s около1.06%; повторный signature verifier в expiry callback устранён. Эти проценты профиля не разделяют TLS encryption, buffer copy и syscall wall time. Перед fatal все8logicalCPU заняты96–98%, CPU PSI some≈59%; счётчики host-wide включают стороннюю работу. Accept queue listener4401 достиг512. Это свидетельствует об общей CPU pressure, а не доказывает единственную причину отказа.

V14 меняет только fixture `nowMs()` на `Date.now()`: сохраняются UTC epoch milliseconds, отдельное время каждого decoded frame, ISO conversions, UTF-8/schema/callback isolation, coverage/replay, сроки и SLO. Production Temporal authority не меняется. До изменения в10 worker profiles `nowMs` self занял3.75% всей выборки/16.18% non-idle baseline и4.17%/12.31% wave. Это измерение предыдущего Temporal-варианта, а не before/after V14. Локальный microbenchmark300000 calls: Temporal402.110ms, Date34.862ms; проверен общий system-wall epoch bracket. Выигрыш capacity этим benchmark не доказан. `node --test tests/realtime/fixtures/harness.test.mjs`27/27 безskips, `pnpm architecture:check` и diff-check — PASS.

Обычный полный V14: `issue12-v14-clock-full-final-20261012`, manifest `849044783e642586477bfcf7b49d93b63d40daa32146b4ada19d3a1967277387`, run `i12-c9a72440d9f84ce4`, native image `sha256:389f3b1a68c24a91a8d7e17b1c50424e504edb83f1cf7ea33ac3571f044c4e6d`. Без profiler/cipher/backlog/HUP/TTL/SLO изменений: target5000/100ACK/s/1800000ms, measurement13:55:18.508UTC → failure13:56:36.191UTC. FAIL77682.198ms /7769ACK: `TRANSPORT_PROOF_FAILED`, readiness request deadline gateway. Admission5000/5001 прошла; successful re-auth0,333retry504. Retry times4147–4819ms не являются successful recovery gaps. Последние10shard live/combinedp951015–1018ms, replay0; полный aggregate percentile отсутствует. Loopmaxreported72.548ms. Свежий gateway snapshot13:56:34.157UTC: live4011/scheduled3371/writing64/q58541records/auth_close1031. Loaded shutdown, HUP900s и30min не достигнуты.

Read-only unprofiled V14 host observer: baseline+10–40s logicalbusy77.9%, CPU PSI some23.3%; cgroup GW/nginx/driver1.085/1.426/2.140CPU-seconds/s. Последние3s logicalbusy93.6%, PSI some51.3%, роли1.109/1.580/2.856. Host-wide counters включают постороннюю работу; SMT-pair activity не является прямым измерением physical-core utilization. Снятый LISTEN4401 сохранял queue0, namespace ListenDrops/Overflows0; CPU starvation/TLS точная причина этим не доказана. MaxRSS nginx667267072/GW677105664/driver1272975360B и FD5042/5034/5081 ниже ceilings; sampled OOM0. Cleanupverified3440.869ms, все8containers/network/private material удалены. Это failed-run fixture cleanup, не loaded cleanup acceptance. Сравнение с preferred/profiled V13 не является matched before/after доказательством V14 gain.

V14 affinity setup control: manifest `0481795f1c936b05b709cb5fa8a0f976d46b60e65a4f094ba4c8a22f59863c19`, run `i12-0583d6642a6748f8`, classification diagnostic-only/launchProof=false. До нагрузки FAIL на ошибочной диагностической assertion `idp availableParallelism2 !== mask cardinality6`; созданные2containers/network/private material удалены, cleanupverified1503.133ms. Node учитывает cgroup quota вместе с affinity, что подтверждено [исходником libuv в Node26.8.1](https://raw.githubusercontent.com/nodejs/node/v26.8.1/deps/uv/src/unix/core.c); лимиты не менялись. Следующий scratch coordinator проверяет observed estimate против min(mask cardinality, existing CPU quota) и отдельно точные configured/effective/process masks. Gate String.raw и atomic ready/release markers прошли actual child sanity и независимое ревью; в продукт они не добавлены. Исторический setup FAIL не является transport/capacity измерением.

V14 affinity2: manifest `fa8dac9f2e398ccefe47216ea7dbc65fcc51900c953c76e1ec9bbd72777592b7`, run `i12-2b5af552187d4a68`. Все8 actual configured/effective/process masks и прежние CPU/memory/nofile проверены; driver Node estimate6 при quota8/mask6, остальные Node roles2. До measurement FAIL: worker exited1. Root минимальным local reproduction подтвердил `ERR_INPUT_TYPE_NOT_ALLOWED`: scratch `node --input-type=module -e` передал этот flag файловым Workers. Значения duration/published0, поэтому аппаратный результат отсутствует. Cleanupverified3374.172ms, все8containers/network/private удалены. Исправленный scratch gate — обычный `.mjs` файл; actual child sanity проверил gate до/после release и успешный file-URL Worker, затем independent review PASS. Product driver не менялся.

V14 affinity3 — аппаратный diagnostic FAIL: manifest `faae12ed4231910c022c83b5d424626786f86092f9c9f1801e487ab8119f9f10`, run `i12-9c2c48d9aafe43cf`, coordinator SHA `ff2014d10889d8ec50a67eaf9b31e13854ddd9782fa592bab68a1dbb3b89348d`, обычный gate-file SHA `7e758e09b31f2988dece144280f9ed5b1564f9724dd9644b067993c06e9ff9d4`. Все8 resource/cpuset receipts проверены до release driver. Gateway CPU0,4 — SMT-пара одного физического ядра; остальные7roles делят CPU1-3,5-7, прежние quotas/memory/FD сохранены. Это распределение не исключает посторонние host processes и не принимается как product configuration.

Measurement14:24:10.281UTC → failure14:25:31.822UTC, FAIL81540.674ms/8154ACK: auth/session request deadline. Admission5000/5001 прошла, minLive2302. Успешный re-auth109unique clients, max successful gap9207ms;722unique retries504, не successful recovery. Последние shard live/combinedp95930–935ms; replay352frames, shardp954474–4559ms/max4583ms; aggregate final p95 отсутствует. Loopmaxreported66.126ms. Последний свежий gateway snapshot: live2926/scheduled2798/writing64/q33675records/8809619B/auth_close2187. Host logical busy baseline75.7%, последние3s92.1%; PSI some21.7%→50.4%, full0. Cgroup nginx/GW/driver baseline1.54/1.13/2.27CPU-seconds/s, последние3s1.61/1.09/2.92. Host counters включают чужую нагрузку; причинность timeout ими не доказана. LISTEN4401 queue22→0, снятые namespace overflow/drop counters без роста. MaxRSS nginx667611136/GW682229760/driver1319968768B, FD5050/5034/5081 ниже ceilings; sampled OOM0. Cleanupverified3510.235ms, все8containers/network/private material удалены. HUP900s, loaded shutdown и30min не достигнуты; launchProof=false.

V14 affinity+preferred TLS — diagnostic FAIL: manifest `c26979a6d3cb11816dee5af12dc32156dd224eedcfb89aa4970be3a06ebbf928`, run `i12-ea63c2bedc324af1`, coordinator SHA `433c475df39cfa1c9d59c53b8a7cfe59d18274f6444e60c09e1f601a5ea1680c`. V8 проверка precedes scratch patch/launch, before/after hashes сохранены, all8 affinity/resource receipts и gate проверены. Actual7 compatibility probes подтвердили default/AES128/AES256 на обоих TLS servers и publicTLS1.2 AES128;5000unique(shard,client) ordinary initial connections использовали authorized cold TLS1.3/ChaCha20, receipt shard0–9. Product cipher policy/cpusets не изменены.

Actual measurement14:40:05.700UTC, FAIL76966.240ms/7697ACK: direct gateway headroom1340.305ms>1000ms. Admission5000/5001 прошла, minLive3573, successful re-auth0/152retry; последние shardcombinedp95757–764ms не заменяют final aggregate percentile. Loopmaxreported56.099ms. HUP900s, loaded shutdown и30min не достигнуты. Cleanupverified3632.531ms, все8containers/network/private material удалены, classification diagnostic-only-v14-affinity-preferred-tls/launchProof=false. Улучшение начальной доставки не устранило re-auth headroom failure; product tuning этим результатом не обосновано.

Read-only проверка initial ramp: issue #12 и spec §8/обязательный re-auth требуют фактические5000 одновременно live, reject5001, затем30min/100ACK/s на том же cohort и fresh admission каждого client. Синхронная initial/expiry burst не задана. Текущий readiness barrier45s — fixture watchdog,20s относится к graceful shutdown. Допустима диагностическая калибровка только initial admission; reconnect retry3000/ready10000/TTL60/authCheck30000, latency/coverage/headroom/budgets и полный измеряемый интервал сохраняются. Само заключение не является capacity PASS.

V15 initial ramp со штатными TLS/CPU — diagnostic FAIL: manifest `ae84d4292ea81785da2b442ded11c741ac2dc28e6d15141257aa3b4e01fb83bb`, run `i12-a988a39e566441c7`, coordinator SHA `f94de181aec0c0d98ad18142853418aef996ce42fea59b194002984687d3bb5c`. После verifyPrepared изменены только frozen driver/clients, hashes сохранены. Nominal initial slots39992ms; фактические request starts14:50:03.491–14:50:43.482UTC (39991ms), ready14:50:03.545–14:50:43.496UTC (39951ms), request/ready counts5000. Перед main authCloseDelta0/live5000/fatalfalse; admission5000/5001 прошла. Расписание не касается recovery и не трактуется как claim iat.

Main начался14:50:43.761UTC; FAIL59319.709ms/5933ACK, direct gateway readiness deadline. Последняя measurement samplelive4465, failurelive3807; successful re-auth0,645retry. Последние combined shardp951030–1031ms, final aggregate отсутствует; loopmaxreported65.307ms. Nginx сохранил651upstream TLS-handshake timeout. Это фактическая стадия сбоя, не доказательство единственной CPU-причины. Cleanupverified3737.015ms, все8containers/network/private material удалены. Штатный TLS/CPU с40s ramp не устранил отказ;30min/HUP/loaded shutdown не достигнуты, classification diagnostic-only-initial-ramp/launchProof=false. Изменения остались в scratch.

V15 initial ramp+preferred TLS, обычный CPU — diagnostic FAIL: manifest `d663363ac218e273880feaa6d151fffc833e71ef7a884cc2dbd3c53c2151e449`, run `i12-0aea86614183491c`, coordinator SHA `34f4d1aa1cd6d799de5e68da92d5022c4129b2542b4a56150ff140832863b03c`. Original manifest проверен до cipher/ramp patches, hash chain сохранена. Фактические request starts39991ms/ready39938ms, counts5000; admission5000/5001 и preMeasureauthDelta0/live5000/fatalfalse прошли. Все7actual compatibility probes и5000ordinary cold authorized CH TLS1.3 receipts сохранены. Ни affinity, ни product cipher policy не изменены.

Main14:58:00.179UTC → FAIL57449.123ms/5746ACK: gateway readiness deadline. Последняя measurementlive4475/failurelive4039, successful re-auth0/360retry. Последние shardcombinedp95842–843ms не заменяют final aggregate; loopmaxreported72.483ms. HUP900s/loaded shutdown/30min не достигнуты. Cleanupverified3718.606ms, все8containers/network/private material удалены; classification diagnostic-only-initial-ramp-preferred-tls/launchProof=false. Initial ramp+TLS preference не устранили re-auth failure.

Дополнительное read-only исследование TLS resumption: сохранённый V14 affinity+preferred gateway log содержит5160принятых SSE TLS1.3 соединений,1cold/5159resumed; V13preferred CPU —5099,1cold/5098resumed. Это входящие nginx→realtime соединения, не Edge authorize и не timed-out handshakes; phase/client correlation отсутствует. Принятый sample подтверждает resumption, но не позволяет вычислить reuse среди неудачных попыток или initial/reauth. [NGINX exact upstream source](https://github.com/nginx/nginx/blob/release-1.31.6/src/http/ngx_http_upstream.c#L1682-L1703) использует peer set/save session, [proxy_ssl_session_reuse](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_ssl_session_reuse) по умолчанию on. Event route явноHTTP1.1; [стандартный default с1.29.7 тоже1.1](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_http_version). Отсутствие HTTP socket pool не доказывает cold TLS; Node mTLS CA/client-cert/SAN проверки сохранены.

V15 affinity+initial ramp+preferred TLS — diagnostic FAIL: manifest `e9aa87371328319c9b499dd213184966869ee52aa147f825f8bb656dcd8ea8a1`, run `i12-3c6a25b4451f4273`, coordinator SHA `b84b5ec404c4fe0d6e135e8390db725537770902bc05cd9f46f9f2ac1e906bfd`. All8 exact resource/cpuset receipts и ordinary driver gate прошли; verifyPrepared→cipher→ramp hash chain сохранена. Actual request starts39991ms/ready39951ms, counts5000, admission5000/5001, preMeasureauthDelta0/live5000/fatalfalse; compatibility/TLS receipts сохранены. Product настройки не менялись.

Main15:06:52.767UTC → FAIL59220.639ms/5923ACK: gateway headroom1873.405ms>1000ms. Последняя samplelive4282/failurelive3939; successful re-auth121unique/maxgap8773ms,425retry. Последние shardcombinedp95740ms, final aggregate отсутствует; loopmaxreported47.743ms. Разложение actual failed readiness request: created5.982/socket22.906/lookup35.326/connect51.296/secure1847.815/headers1873.136/end1873.317ms; driver loop p9512.575/max79.888ms. Это задержка до завершения TLS-handshake, не доказательство единственной native-CPU причины. Первый retry15:07:48.786UTC, первые successful re-auth15:07:49.950UTC; readiness failure15:07:51.984UTC. HUP900s/loaded shutdown/30min не достигнуты. Cleanupverified3481.218ms, все8containers/network/private material удалены; classification diagnostic-only-affinity-initial-ramp-preferred-tls/launchProof=false. Все проверенные комбинации калибровки оставили full profile непринятым; разрешение1GiB не ослабляет latency/headroom/reauth или30min.

### Разрешённый архитектурный эксперимент

Проверенные настройки не обеспечили полный профиль на единственном доступном
сервере. Следующий кандидат — эксперимент с двумя процессами HTTPS/TLS и одним
владельцем Kafka consumer, replay ring и sequence. Его производительность и
соответствие общим 2 CPU / 1 GiB не доказаны; это гипотеза для измерения, а не
обещание результата. Новые серверы, dependencies и отдельные бизнес-сервисы не
предлагаются. Пользователь 2026-10-12 разрешил новый ADR и ограниченный эксперимент
с этими границами. [ADR-0033](../docs/adr/ADR-0033-realtime-tls-process-experiment.md)
фиксирует экспериментальный статус. Прототип и координатор разрабатываются
отдельно в scratch; положительный нагрузочный результат ещё не получен.

Перед первым контейнерным прогоном независимое ревью нашло CL1–CL5:
неинициализированный PID registry, недоступный shutdown flag, незавершённый IPC
при штатной остановке, устаревшие метрики и обход общего бюджета через новые
Hub enqueue. Исправления проверены отдельным tester и повторным reviewer.
Узкий scratch selfcheck прошёл: actual `WorkerManager`/`workerComposition`,
PID/sequence/возраст исходного sample, stale/missing snapshots и expiry при
выдаче, callback/drain/error cleanup, потеря worker, общий Hub+две IPC-копии
при удержанных ACK и продолжающемся fanout, shutdown reset. Native cluster
завершил IPC/disconnect с exit0 без kill. Полный configured runtime/TLS startup
и его runtimeController shutdown этим selfcheck не доказаны; первый реальный
512/120s smoke запущен отдельно. Повторное ревью разрешило именно этот прогон,
а не production adoption или merge.

Frozen scratch hashes: gateway `ecd94a43ffaf9180dc5bd905e1e5b245e9cf9a56ab91769dd97932ad9fe63031`,
patch helper `382e9b171808eb72e3d31c44d6efc741974406ff88095da00a45ec62994e8e42`,
selfcheck `102720462a015b180b8a8d42bd95d0445d3afa71744ef279c6424a0ea004da21`,
coordinator `bdda1fbedb71fe49feb5bb92d2887b3b81e771299fc431cdbdd8bd27749a721a`.
Helper проверяет оригинальные compiled hashes после обычного freeze и меняет
ровно runtime/main/hub/sidecar; before/after receipts и diagnostic-only
classification сохраняются. Подготовленный обычным coordinator полный профиль
имеет manifest `fb29dc76b6ce7b1ebaedea6d0c99cc0a914b44295f66091a915cf534d6edebdc`:
5000/100ACK/s/1800000ms, прежние latency/loop/headroom/cleanup/shutdown пороги,
общие gateway 2CPU/1GiB и nginx 2CPU/1GiB. Подготовка не является capacity PASS.

V16 первый two-TLS smoke — **FAIL до main**. Каталог
`issue12-v16-two-tls-smoke-20261012`, manifest
`0f3f70df88750e829111619d3eca076e7c94024ad81ef34298a0236aeab76eb6`,
run `i12-dad9b84d67f54244`. Actual process receipt связал два TLS namespace PID
46/45 с host PID3389017/3389016 и Kafka owner PID7 с host PID3388747;
bootstrap действительно завершился, а не был выведен из наличия init process.
Prephase replay/reset/slow/evicted прошёл; slow burst дал20000 ACK за49963ms.
Все512 clients сообщили ready/live512, но следующий `/metrics` вернул478
connections из сохранённого IPC snapshot. Assertion на actual Hub population
остался прежним; main duration0/published0 не является performance result.
Это CL6: метрики состояния должны читаться у владельца Hub по запросу,
а не выдаваться из периодического кэша, даже если его loop samples ещё свежи.
Исправляется только scratch IPC/compiled metrics await; fixture thresholds
не ослабляются. Cleanup3488.568ms verified: все8containers, network и synthetic
private material удалены. Loaded shutdown/re-auth/120s/5000/30min не приняты.
Сохранены hashes/patch/process receipts и исходники selfcheck/coordinator;
старые байты gateway/patch до CL6 отдельно не были архивированы.

CL6 request/reply regression прошёл в native connected cluster: два concurrent
reads используют один запрос и получают одинаковые arrays; следующий запрос
после изменения Hub возвращает512 вместо478. Stale/missing sources, timeout,
STOP/disconnect cleanup и exit0 проверены. Команда:
`node /tmp/coffee-12-cluster-min-fixture.mjs` (использует тот же selfcheck и
patch helper). Frozen CL6 source receipt сохранён в подготовленном full
каталоге `experiment-source/cl6-v1`: gateway `8fc4a58e6f2b2636a7d071e0016b8c7908a22846ecd98ab2b2329e1105c0ead2`,
patch `f71673d68cace8f5992b5c3fffd52140904ca880749f8aa62f2f13393771a169`,
selfcheck `20e43db315ba8145eaa50bb7f91ddfbe544e0dcd3175412108bc3d55f0902902`,
runner `be0b59f7e9d119f3028aa76699eb50f1c10b4f9f95c1a27481890cc90db13a46`;
coordinator остался `bdda1fbedb71fe49feb5bb92d2887b3b81e771299fc431cdbdd8bd27749a721a`.

Повторное ревью закрыло CL6, но вновь открыло CL4: health/logging reset owner
histogram и последующее непустое низкое окно могут скрыть высокий p95 до driver
GET; worker LOOP тоже перезаписывал предыдущее окно. Проверка одного лишь возраста
последнего sample не защищает от этого ложного PASS. До повторного smoke
исправляются единственный sampling owner и bounded peak для каждого процесса
до потребления измерением. Требование all-three-process loop gate сохраняется;
прежний selfcheck freshness не выдаётся за проверку сохранности высоких окон.

CL4 v2 regression прошёл: owner oldMetrics sampling выполняется только существующим
1Hz timer; readiness и log/GET rendering не сбрасывают histogram. Actual
`updateLoopWindow`, `WorkerManager.message(LOOP)` и `replyMetrics` сохраняют peak
150 после непустого20 до GET — отдельно для owner и обоих TLS workers. Stale,
missing и malformed reply не consume; valid GET150 и следующий GET без нового
seq150; следующий настоящий low20 sample позволяет20. Команды
`node --check /tmp/coffee-12-cluster-selfcheck.mjs` и
`node /tmp/coffee-12-cluster-min-fixture.mjs` — PASS, включая прежние CL6 native
IPC, backpressure и четырёхфайловый hash receipt. В full scratch сохранён
`experiment-source/cl4-v2`: gateway `17a04a48a3230be41475f125b3e2dcc47e18fd3f2a56e83bb1052b5b8016818b`,
selfcheck `1a95cdac8f9a88b9c3a5d45684a831bc87ac37d4efba243b75d305c74cfa2fc1`;
patch/coordinator/runner прежние CL6. Реальная TLS/нагрузочная проверка этого
кандидата ещё не выполнена.

Последующее ревью обнаружило оставшуюся CL4 ошибку sender: при занятой IPC
отправке worker сбрасывал histogram, но не передавал высокий sample. Исправлен
фактический `sendLoopWindow`: low20 in-flight → high150 → low20 сохраняет peak150;
success callback сразу отправляет latest20/peak150, error возвращает peak для
следующего настоящего sample. Следующее новое low20 окно позволяет восстановление;
пожизненный maximum не используется. Parent строго отклоняет LOOP без finite
`peakP95Ms >= p95Ms`. Actual sender → `WorkerManager` → metrics GET regression,
прежние CL4/CL6 native случаи и syntax checks прошли. Независимое ревью разрешило
повторный smoke, новых блокеров в проверенном участке нет. Frozen исходники
сохранены до запуска в `experiment-source/cl4-v3`: gateway
`dad2c80a6cd0ef4b2a754538463c1702097f6827e16420adaa34b9ddf6941ccf`, selfcheck
`6c67313553be49fe89dd53ceda47b78f948537e73e0b4bdc6259686618e951d7`;
patch/coordinator/runner прежние. Это локальная проверка прототипа, не capacity PASS.

V16 повторный two-TLS smoke — **DIAGNOSTIC_PASS**, missing=[]/launchProof=false.
Каталог `issue12-v16-two-tls-smoke-retry-20261012`, original manifest
`4ea1a7714275da446df43e8922d81cc2515607965790f143f02a73f0888b5793`, run
`i12-d2cc911a600a4e88`; использованы frozen CL4-v3 bytes. Команда:
`PATH="$(cat /tmp/coffee-12-v10-proof-bin-path):$PATH" node /tmp/coffee-12-cluster-diagnostic.mjs --smoke --profile reference-512 --smoke-clients 512 --smoke-duration-ms 120000 --result-dir /home/yurgusev/.hermes/cache/scratch/issue12-v16-two-tls-smoke-retry-20261012`.
Actual process receipt подтвердил owner PID7→host3439241 и TLS PID46/45→host3439509/3439508.
Main120008.957ms/12002ACK, eventp95335ms/loop48.038ms/headroom128.756ms;
все512 clients прошли re-auth, maxgap3327ms, finalLive512. Replay/reset/slow/
evicted/admission/HUP/headroom/budgets/shutdown/cleanup checks прошли.
Loaded shutdown638.087ms, все512 закрылись, workererrors0, timedOut=false,
forcedClientClose=false. Fixture removal2988.573ms verified: все8containers,
network и synthetic private material удалены. CLI exit0. Это предварительный
контроль512/120s, не5000/30min и не production permissions proof.

V16 полный two-TLS эксперимент — **FAIL**, launchProof=false. Каталог
`issue12-v16-two-tls-full-20261012`, frozen manifest
`fb29dc76b6ce7b1ebaedea6d0c99cc0a914b44295f66091a915cf534d6edebdc`, run
`i12-de4d2bdc6b1b4309`; команда использовала `--prepared` этого каталога и
`--approve-manifest` точного hash. Actual5000 unique clients/admission5001→503
до SSE headers прошли; establishment21748ms. Main16:52:30.133UTC завершился
через2690.906ms/270ACK с `POPULATION_INTERRUPTED`: unexpected TLS SSE close
after21853ms. Event latency отсутствует, loop61.637ms. Prephase replay/reset/
slow/evicted прошёл; re-auth, HUP900s, loaded shutdown и30min не достигнуты.
Причина раннего закрытия расследуется; достаточность процессной схемы не доказана.
Cleanup3462.480ms verified: все8containers, network и synthetic private material
удалены, CLIexit1. Пороговые условия не изменены, процессная схема не принята
в production.

Read-only трассировка первого V16 full отказа: first close записан в
`samples.jsonl`16:52:32.824UTC/live4996. `fatal()` драйвера после этого закрывает
все streams, поэтому последующее population0 не доказывает5000 самостоятельных
отказов. Последний pre-failure metrics16:52:32.343UTC: live5000, writing1866,
queue121575records/31804461B, transport80922records/21196768B,
total202497records/53001229B при cap262144/67108864B; при main start все очереди0.
AuthClose0, фактический возраст21853ms ниже actor TTL, worker-loss signature
отсутствует; OOM counters0 во всех14 samples. Max sampled aggregate RSS:
gateway999505920B/nginx667303936B/driver995770368B; cgroup gatewaypeak823132160B.
Рост очередей поддерживает гипотезу недостаточного throughput, но точная первая
denial branch не установлена. `WorkerManager.reserve` может вернуть false;
`ParentSink.write` передаёт callback error, после которого Hub закрывает stream
без `slowClose` counter. Изолированный счётчик этого отказа нужен для причинного
контроля; повышение cap или ослабление population gate не предлагается.

Для причинного контроля заморожена scratch instrumentation: первый IPC reserve
reject пишет exact projected Hub+transport totals; bounded counters различают
capacity, worker-unavailable, busy write и oversized frame. Правила callback,
admission, queue maxima и исходное fail-closed `<=` сохранены. Existing selfcheck
проверил actual Hub NaN rejection, success/counter0, exact fields, один warn после
двух rejects, ненулевые fallback stats и отдельные error counters; прежние CL4/CL6
native проверки также PASS. Команды `node --check /tmp/coffee-12-cluster-selfcheck.mjs`
и `node /tmp/coffee-12-cluster-min-fixture.mjs` — exit0. Frozen archive
`issue12-v16-ipc-reservation-diagnostic-20261012/experiment-source/reservation-v1`:
gateway `705f9db08d7cc5eaeb56e578d7a6f28af239bebbf27b5dd0a8dc34737d329393`, patch
`91e02c626ce679ba5ed2e20bb49b2afbabc6025b09a18afe9d508407d67d9827`, selfcheck
`3a404c21cdfc580d0457613e8b2eccb03b1a96b57a1caa445a369c5793bd413f`;
coordinator/runner прежние. Следующий full frozen manifest
`7b96c8fe99eed74e212952fe64d7350c6cb8146109520459888297127be1a5e2`
сохраняет5000/100/1800000ms и все пороги; подготовка не является PASS.

V16 IPC reservation control — **FAIL**, launchProof=false. Main17:06:20.677UTC,
2604.176ms/261ACK, `POPULATION_INTERRUPTED`; admission5000 unique/5001→typed503
прошла. Первый warn17:06:22.669UTC доказал отказ byte budget до первого close:
Hub149878records/39190144B, transport106818records/27917800B,
requested50records/13100B → projected256746records/67121044B;
max262144records/67108864B. `recordsRejected=false`, `bytesRejected=true`.
IPC pending53409records/13958900B. Итоговые capacity/reservation rejects863,
worker-unavailable/busy/oversized0. Наблюдение подтверждает фактическое ограничение
скорости drain и IPC budget, но само по себе не разделяет стоимость serialization
и TLS writes. Cleanup3404.038ms verified: все8containers/network/private material
удалены, CLIexit1. 30min/re-auth/HUP/loadedshutdown не достигнуты.
Следующий узкий кандидат в одобренном эксперименте объединяет текущие≤64 targets
одинакового immutable Buffer и уже завершившиеся write ACK; постоянный cache,
изменение cap и ожидание медленного target перед ACK остальных не применяются.
Производительность этого кандидата пока не измерена.

V17 bounded batch IPC: existing selfcheck прошёл на фактических ParentSink/Manager:
64+1 targets, strict Buffer identity, общий budget65 accepted/66 rejected,
ACTIVATE/order/immutable payload, fast ACK до stalled drain, отмена до flush и
во время write, late ACK, send error и worker loss release-once, flush перед STOP,
parent malformed ACK_BATCH fail-closed. Native connected child передал настоящие
FRAME_BATCH64+1/FRAME_ACK_BATCH64+1 через advanced IPC на missing-stream path;
callback/drain проверен фактическим `writeChildFrame`. Открытый child SSE stream
этим native selfcheck и incoming malformed child batch отдельно не проверены;
сквозной transport proof остаётся ожидающим. Команды syntax/selfcheck runner
прошли, все прежние CL4/CL6 assertions сохранены. Archive `issue12-v17-batched-two-tls-full-20261012/experiment-source/batch-v1`:
gateway `aa7d3944cb59dc85c50a760aa70e99e544559384d58e4a751468a59afa90377c`,
selfcheck `0747b230421140d6c431615734f06b4be6d3c81e12191e97bc9b1712846e4f60`;
patch/coordinator/runner прежние reservation-v1. Original full manifest
`9c3e33a8ca7298cabd13883f0e9ac984c9f85884cc65cd3e9c7ed750b12533a6`
сохраняет5000/100/1800000ms и прежние пороги. Подготовка и selfcheck не являются
capacity PASS.

Независимое V17 batch review — PASS для следующего512/120s smoke: ownership/
sequence, cancellation/release-once, individual callback/drain, flush перед
END/STOP и сохранение CL4/CL6 подтверждены. Review не принимает capacity или
production adoption. Real smoke запущен отдельно; результаты пока ожидаются.

Дополнительный native negative V17 прошёл без изменения gateway/patch:
FRAME_BATCH65 targets → child `exitCode=1`, `runtimeClosed=true`, ACK_BATCH не
выдан; disconnect cleanup проверен. Syntax и min-fixture exit0, прежний positive
64+1 и callback/drain сохранены. Final selfcheck
`5d17cd9fcc858996d4a2f3fb0149ae01bcafcc4f4e9cedb54c76b5ae5ce01ae9`
архивирован отдельно как `batch-v1/coffee-12-cluster-selfcheck-negative.mjs`.
Открытый SSE через batch остаётся предметом текущего real smoke.

V17 real batch smoke — **DIAGNOSTIC_PASS**, missing=[]/launchProof=false,
CLIexit0. Каталог `issue12-v17-batched-two-tls-smoke-20261012`, original manifest
`ddbb371f71d75869ee5f92b5ca111a44ce22097d30ea92f653a9701cc01ebf12`;
gateway/patch frozen batch-v1. Main120000.006ms/12001ACK,
eventp95319ms/loop49.185ms. Все512 clients восстановились после auth expiry,
maxgap3166ms/finalLive512/no unexpected closes. Actual HUP117.834ms,
512→512 live; loadedshutdown438.004ms, all512 reset/closed, gatewayexit0,
workerErrors0/timedOut=false/forcedClientClose=false. Fixture removal2975.913ms
verified: все8containers/network/private material удалены. Replay/reset/slow/
evicted/admission/headroom/budgets/cleanup и остальные checks прошли.
Это подтверждает сквозной открытый SSE batch в коротком reference512 profile;
5000/30min и production permissions остаются ожидающими.

V17 full batch — **FAIL**, launchProof=false. Manifest
`9c3e33a8ca7298cabd13883f0e9ac984c9f85884cc65cd3e9c7ed750b12533a6`, run
`i12-d9da57147f364879`, прежние5000/100/1800000ms. Main17:26:02.733UTC,
1789.481ms/180ACK: `gateway event-loop p95 >100ms`. Admission5000/5001 прошла.
Последний pre-failure metrics17:26:04.333UTC: live5000, owner80.806ms,
TLS workers511.967/798.491ms; total248777records/65149236B, capacityRejects0.
Result field `eventLoopP95Ms=40.108031` содержит предыдущий успешный sample;
actual failing798.491ms сохранён в raw gateway metrics. Порядок фиксации max/assert
в harness исправлен: максимум сохраняется перед тем же assert100ms. Сам FAIL
корректен; новая regression исполняет фактическое тело `sample()`.
Поздние245capacity rejects следуют после первого loop failure и не подменяют
его причину. IPC batching не обеспечил throughput/loop критерий.
Cleanup3594.693ms verified: все8containers/network/private material удалены,
CLIexit1. Re-auth/HUP900s/loadedshutdown/30min не достигнуты; final eventp95 отсутствует.

Read-only аудит V17 подтвердил синхронный child dispatch всех targets внутри
IPC callbacks. Это согласуется с высокой задержкой TLS workers при owner80.806ms,
но отдельно не измеряет native TLS и стоимость `ServerResponse.write()`. Следующий
scratch-контроль ограничивает child dispatch64writes за `setImmediate`-ход;
parent reservation сохраняется до actual callback/drain ACK, прежний aggregate
queue budget и все acceptance thresholds неизменны. Увеличение пропускной
способности этим предположением ещё не доказано.

Regression отчёта: `node --test --test-name-pattern='event-loop sample records'
tests/realtime/fixtures/harness.test.mjs` —1/1PASS; весь existing harness —28/28PASS.
Исполняется настоящее тело `sample()` с798.49ms и прежним40.108ms: failing max
сохранён, original assert100ms/error/finally выполнены; успешный20ms sample не
снижает прежний max. Syntax driver и `git diff --check` —PASS. Новый SHA driver
`315e6bce961d7d2f4e1139bc39a855d0fe5fe2c8c186d8c429f5ded956135ebc`;
следующий профиль готовится заново, прежние FAIL manifests не переписываются.

R-receipt независимое ревью —PASS: failing sample сохраняется до прежнего
assert100ms; fatal и классификация не ослаблены. Новый original full manifest
`7f2360cd06751e81f8bc364ac5cb34fc5d867fce33e925cc300c216ec2c3f4de`, run
`i12-06b1eeb3554e42b7`: root проверил209sources/14supporting/compiled/native/images
до experiment patch;5000/100/1800000ms и2CPU/1GiB каждой transport роли сохранены.

V18 child queue использует FIFO `Map` с максимумом64targets за `setImmediate`
и не более одного queued/inflight frame на stream. Parent сохраняет весь
aggregate records/bytes reservation до actual ACK; child повторно не сканирует
payload и не вводит второй budget. Shape/count/uniqueIDs/Bufferbound batch
проверяются полностью до enqueue. Отмена по stream —O(1); END/STOP ждут write
и close. Source gateway
`310f98da3b71278be9963b7b0eac2dc484e957776bd361943a0001c1e63b034e`, patch прежний
`91e02c626ce679ba5ed2e20bb49b2afbabc6025b09a18afe9d508407d67d9827`.
Syntax/manual parent grouping64+1 —PASS.

V18 actual child-source VM tests —PASS:64+1 за разные setImmediate turns,
shared Buffer identity, fastACK независимо от stalled peer, false-write callback
и drain, bounded ACK batches, maxConnections cap, whole-message duplicate/oversize
fail-closed, queuedCLOSEcancel, END/STOP с ожиданием actualACKsend/close и forcedCLOSE
cleanup. `node --check /tmp/coffee-12-cluster-selfcheck.mjs` и
`node /tmp/coffee-12-cluster-min-fixture.mjs` —PASS, exit0; прежние native/CL4/CL6
и four-file receipt/hash checks сохранены. Selfcheck SHA
`d485dcd2cabf7b11cc030921671ebe47e372ffb6fd48938e937b63070886b7a0`;
все5originalfiles архивированы до load в
`issue12-v18-yielded-two-tls-full-20261012/experiment-source/yield-map-v1`.
Независимое V18 review —PASS для512/120s diagnostic smoke; реальная TLS
доставка/fairness/shutdown и capacity этим source review ещё не подтверждены.

V18 real smoke —**DIAGNOSTIC_PASS**, missing=[]/launchProof=false, manifest
`497639889e2df7c19db35af9cbc4e7da1c921d3302d3cb531fa5f4f4489d400e`.
512/120000.198ms/12001ACK, eventp95328ms, all-process loopmax31.752191ms;
все11checks=true. Re-auth512unique/samples512/authCloseDelta512, finalLive512,
unexpected0/pending0, gap p95/max3295/3422ms. HUP89.368ms сменил реальное
поколение nginx worker при live512→512. Loaded shutdown654.726ms,
512armed/live/closed/reset→close receipts, gateway exited0, workererrors0,
timedOut=false/forcedClientClose=false. Cleanup2987.718ms verified:
все8roles/network/private material удалены. Command:
`PATH="$(cat /tmp/coffee-12-v10-proof-bin-path):$PATH" node /tmp/coffee-12-cluster-diagnostic.mjs --smoke --profile reference-512 --smoke-clients 512 --smoke-duration-ms 120000 --result-dir /home/yurgusev/.hermes/cache/scratch/issue12-v18-yielded-two-tls-smoke-20261012`.
Это actual opened-SSE/reauth/HUP/shutdown proof на512/512MiB, неcapacity5000
и неproduction permission proof. Полный кандидат запускается с original
manifest7f2360... и прежними5000/100/1800000ms; результат ниже.

V18 full —**FAIL**, launchProof=false:1599.837ms/161ACK,
`POPULATION_INTERRUPTED`, первое наблюдение driver17:53:49.497UTC/live4999,
возраст stream3808ms. Admission5000/5001 —PASS. Последний successful metric GET
17:53:49.085UTC: live5000, total120674records/31527639B, IPCcapacityRejects0,
slowClose1(preflight), authClose0; owner27.836ms, TLS workers69.665/71.500ms.
Result сохраняет measured loopmax71.499775ms; final eventp95 отсутствует.
Отдельный owner log перед driver failure показывает live4898, queued136199/
35630716B и p95 owner111.738879ms; worker windows69.665/71.500ms. Эти snapshots
не синхронны и не доказывают устойчивый SLO или performance gain.

Первый parent IPC reserve warning17:53:50.096UTC, после driver FAIL на599ms:
hub126704/33128857B + transport130104/33969074B + request50/13100B =
projected256858records/67111031B, records below262144, bytes over67108864 на2167.
Он не объясняет первое закрытие; последующие55capacity rejects —не первый trigger.
Nginx:94upstream-premature-close в секунду17:53:49, timeout не указан. Перед FAIL
последний host sample17:53:47.546: aggregate gatewayRSS865546240B/cgrouppeak695656448B,
лимит1GiB, OOM0; точного resource sample в момент close нет. Все13 gateway cgroup
samples показывают OOM/oomKill0. Cleanup3516.776ms verified, all8roles/network/
private material removed, CLIexit1. Re-auth/HUP900s/shutdown/30min не достигнуты.

Исходные receipts не различают первый Hub enqueue/replay capacity close и child
write/drain/ACK error. Следующий scratch контроль добавляет bounded first receipt
для каждого из этих путей, без client IDs/payload/secrets, новых timers или
изменения gates. Source audit также обнаружил ошибку `ParentSink.acknowledge`:
error ACK освобождал pending до вызова `fail`, поэтому терял write callback.
Исправление должно передать error в `fail` до очистки, освободить reservation и
вызвать callback ровно один раз; successful/late ACK поведение сохраняется.

V19 реализует это исправление только в scratch experiment. Actual ParentSink/
manager и patched Hub self-check — PASS: error callback/release/destroy ровно
один раз, late/unknown ACK без повторного эффекта, observer throw не препятствует
cleanup. Admission/replay/enqueue/ipc-reserve сохраняют первый timestamp/source;
accepted limits и NaN fail-closed прежние, неизвестные diagnostic числа — null.
Причины child ACK ограничены allowlist, IDs/payload/secrets не логируются.
Прежние native/CL4/CL6/Map64 и four-file hash receipts также PASS.
Команды: `node --check /tmp/coffee-12-cluster-selfcheck.mjs` и
`node /tmp/coffee-12-cluster-min-fixture.mjs`, exit0. Независимое V19 review — PASS
для следующего full diagnostic; happy-path scheduling и gates не менялись,
поэтому повторный512 smoke по этому delta не требовался.

Original V19 manifest
`142c30a2ce6362aa8953e39b101af915e1f61516272915231de116901d175d01`, run
`i12-a284fe84a6964adf`:209sources/14supporting/compiled/native/images проверены
до experiment patch. Все5скриптов архивированы до load в
`issue12-v19-first-close-two-tls-full-20261012/experiment-source/first-close-v1`.
Gateway SHA `527769bef26e893fd99dcab13ceb68d4890b31fe5e7aa050976dbda467ae7019`,
patch SHA `30e1118f980cd3384bedcaea9bc1c9cf99bd7ec072c14833585e7b89193c55e2`,
selfcheck SHA `b9b458c93322a3d7d4d21a304334d32bf7fe18cbf872e39c224a73451a1c2cf6`.
Полный diagnostic запущен с5000/100/1800000ms и прежними2CPU/1GiB transport
лимитами. Итог — **FAIL**, launchProof=false, CLIexit1:1900.066ms/191ACK,
`POPULATION_INTERRUPTED`. Admission5000unique/5001typed503beforeheaders — PASS.
First capacity receipt18:13:25.279UTC, source=ipc-reserve, reason=bytes:
Hub123440records/32280224B + transport132896records/34818752B + next48records/
12576B = projected256384records/67111552B. Records below262144; bytes exceed
67108864 на2688. ParentSink reserve=false передаёт callback error
`REALTIME_IPC_CAPACITY_EXCEEDED`, Hub закрывает stream. Driver сохранил failure
18:13:25.405UTC/live4999, через126ms. Per-stream correlation не записывалась;
причинный путь и временной порядок подтверждены, child ACK error отсутствует.

Последний успешный GET18:13:24.748UTC: live5000, total176988records/46277540B,
4040writing/960scheduled, ownerloop41.189ms, workers71.369/67.764ms, reject0.
Result loopmax71.368703ms; final eventp95 отсутствует. Поздний owner log содержит
805capacity rejects и live3199, loopmax124.912ms; это не pre-failure SLO proof.
Последний host sample18:13:22.494UTC: gateway aggregateRSS865398784B,
cgrouppeak692604928B/1GiB, totalFD5096; nginx peak656687104B, FD9952.
Sampled OOM0; точного resource receipt в момент отказа нет. Cleanup3499.820ms
verified, все8roles/network/private material удалены. Re-auth/HUP900s/
loadedshutdown/30min не достигнуты. Failed-run teardown не заменяет loaded cleanup.
Command: `PATH="$(cat /tmp/coffee-12-v10-proof-bin-path):$PATH" node /tmp/coffee-12-cluster-diagnostic.mjs --prepared /home/yurgusev/.hermes/cache/scratch/issue12-v19-first-close-two-tls-full-20261012 --approve-manifest 142c30a2ce6362aa8953e39b101af915e1f61516272915231de116901d175d01`.

Следующее решение исследуется до правок: backpressure перед запуском transport
write, с сохранением frames в уже учтённой connection.queue до освобождения
IPC reserve actual ACK. Лимит не увеличивается, очередь вне бюджета не вводится.
Set64 ограничивает pumps, но не синхронный coalescer fanout; изменение fanout
пока не выбрано, достаточность обоих предположений не доказана.

V20 исходный full snapshot подготовлен отдельно: manifest
`72d1da79db8d05ca9901299a61dc999c0efdabe5fb759f76c6bb3409678d0127`, run
`i12-3919f5765b8f4361`. `verifyPrepared` — PASS,209source/14supporting hashes,
compiled/native/images и5000/100/1800000ms сверены; nginx и gateway aggregate
лимиты2CPU/1073741824B прежние. Read-only verify завершился exit0.
До load нужны tests/review нового scratch backpressure и512 smoke; full PASS
ещё отсутствует. Ожидание хранит только bounded callback на active connection,
frames остаются в Hub queue, writeTimeoutMs охватывает wait+actual write.

V20 scratch implementation готова: gateway SHA
`f73f001fa3ccb55b637e31654effed91d3d97dde9b641e75aab53b93d4e9a1c0`, patch SHA
`32e40249c473d647ae0349d6689ac00d593e46f56c7896045715a1099bdc36ac`.
Предварительная проверка выполняется до writing/encodeBatch, не меняет hard
rejection receipts и не резервирует capacity вместо окончательного reserve.
Один callback на connection хранится в bounded Map; release планирует один
setImmediate wake до64callbacks. Cleanup отменяет waiter и будит peers после
освобождения Hub queue без ACK; drain повторно планирует terminal reset без
продления deadline. Syntax обоих scripts и преобразованного compiled Hub,
unique patch anchors и manual65waiters/cancel — PASS. Actual self-check/review
и реальные512/full gates ещё ожидают.

V20 actual self-check — PASS: preflight оставляет ready frame в accounted Hub
queue/writing0, не вызывает encode/write, не создаёт pending и не меняет hard
rejection state. Настоящий ACK освобождает reserve; callback/drain учтены до
следующей записи.65FIFO waiters проходят порциями64, duplicate заменяет callback
в том же slot, timer polling отсутствует. Abort без ACK освобождает очередь и
будит peer; wait+stalled write закрываются по одному300ms test deadline, без
второго timeout window. Shutdown доставляет terminal reset и завершает cleanup;
disconnected worker закрывается без capacity wait. Прежние CL4/CL6/native/Map64/
V19/errorACK и four-file frozen before/after hashes — PASS. Commands:
`node --check /tmp/coffee-12-cluster-selfcheck.mjs` и
`node /tmp/coffee-12-cluster-min-fixture.mjs`, exit0. Selfcheck SHA
`fe775fba39704382d291cf2ac007f270faba286511a5c1136c24585e98c94dcc`.
Независимое V20 review — PASS для512/120s smoke; perf5000 ещё не доказана.
Все5scripts архивированы до load в
`issue12-v20-capacity-backpressure-full-20261012/experiment-source/capacity-wait-v1`.
Real512 smoke запущен, reference512MiB и все gates неизменны.

V20 real smoke — **DIAGNOSTIC_PASS**, CLIexit0, missing=[]/all11checks=true,
launchProof=false; manifest
`cf6dad2d8d4b798a730fb81f3e7be962885c10ea660f9701478513c8d7dbfc47`.
512/120010.403ms/12002ACK, eventp95321ms, all-process loopmax32.882687ms.
Re-auth512unique/samples512/authCloseDelta512, finalLive512, unexpected0/pending0,
gap p95/max3147/3207ms. HUP134.384ms сменил настоящее поколение nginx worker
при live512→512. Loaded shutdown492.283ms:512armed/live/closed, workererrors0,
timedOut=false/forcedClientClose=false, gateway exit0. Cleanup2875.422ms verified:
all8roles/network/private material удалены. Command:
`PATH="$(cat /tmp/coffee-12-v10-proof-bin-path):$PATH" node /tmp/coffee-12-cluster-diagnostic.mjs --smoke --profile reference-512 --smoke-clients 512 --smoke-duration-ms 120000 --result-dir /home/yurgusev/.hermes/cache/scratch/issue12-v20-capacity-backpressure-smoke-20261012`.
Это real512 transport proof, не5000/30min capacity и неproduction permission proof.

Независимый аудит V20 smoke подтвердил512уникальных shard/client и old→new
connection IDs, каждый old отличается от new;512unique reset→close shutdown
receipts, no force/errors и реальные HUP generations. Gateway2CPU/512MiB:
sampled cgrouppeak263798784B, aggregateRSSmax444289024B, aggregateFDmax609;
nginx peak96505856B/FD1066.30gateway samples содержат все3actual Node roles/PIDs.
CL4 owner raw source-age/GET peak-consumption этим повтором не реконструировались.
`driver-result.json` — pre-wrapper snapshot: в нём ещё missing budgets/fixture
cleanup, error=null; final `result.json` добавляет оба по host/cleanup receipts и
переклассифицирует результат. Только final result используется как итоговый verdict.

V20 full diagnostic запущен после smoke/audit с original manifest72d1da79...,
прежними5000/100/1800000ms,2CPU/1GiB и неизменными SLO. Command:
`PATH="$(cat /tmp/coffee-12-v10-proof-bin-path):$PATH" node /tmp/coffee-12-cluster-diagnostic.mjs --prepared /home/yurgusev/.hermes/cache/scratch/issue12-v20-capacity-backpressure-full-20261012 --approve-manifest 72d1da79db8d05ca9901299a61dc999c0efdabe5fb759f76c6bb3409678d0127`.
Full result ещё ожидается; launchProof=false сохраняется.

V20 full — **FAIL**, CLIexit1, launchProof=false:2195.441ms/220ACK,
`ERR_ASSERTION: gateway event-loop p95 >100ms`, driver observation
18:44:53.801UTC. Latest GET18:44:53.779UTC: live5000, queued+transport208596records/
54471492B, owner103.809023ms, TLS workers61.800447/48.693247ms. All IPC reservation/
capacity/childACK/unavailable/write-state rejection counters0, slowClose1preflight,
authClose0. Admission5000unique/5001typed503beforeheaders — PASS. Предыдущий
GET18:44:52.778UTC: total99421/25901071B, owner21.299ms, workers59.769/47.940ms.
Backpressure gain этими разными snapshots не доказан; soft waiter peak не снимался.
Result сохраняет failing loopmax103.809023ms; final eventp95 отсутствует.
Поздняя live latency diagnostic по shards: p951094–1150ms/max1282–1311ms,
replay samples0; это не completed SLO percentile.

13host samples: gateway cgrouppeak700723200B/1GiB, aggregateRSS872353792B,
FD5095; nginx peak676511744B/FD10053. Sampled high/max/OOM0. Cleanup3648.474ms
verified, все8roles/network/private material удалены; failure cleanup не
засчитывается как loaded shutdown. Re-auth/HUP900s/shutdown/30min не достигнуты.
Следующий scratch-контроль V21 сохраняет все gates и поведение, добавляя bounded
stage timings coalescer/Set64 dispatch/encodeBatch/ParentSink conversion/reserve/
IPC grouping+send. Это выбор измерения до scheduling fix; конкретная причина
owner delay ещё не установлена. Observer использует monotonic clock/фиксированные
агрегаты и существующую cadence, без IDs/payload/new timers.

V21 original full manifest
`1df139843e84c13cf6c07db796ee8c47d159e3c2c69805447e0b3f0c66f8ef31`, run
`i12-45f99aa76b074f34`: root `verifyPrepared` — PASS, exit0,209sources/
14supporting/compiled/native/images и5000/100/1800000ms сверены до patch.
V21 source: gateway SHA-256
`edc80110ef152df599ea1c856590f12f3578f9f058ce85c7d1eb0566922ce176`, patch
`508db65ab405cc045d802566a23cb7852b3f91303210d939cf04abd7c71a945e`, selfcheck
`f58df9e6594de7dfde96b469116438c94965b873467438533c6e14c3071ac8f1`.
`node --check` для трёх файлов и
`node /tmp/coffee-12-cluster-min-fixture.mjs` — PASS. Actual-source проверки
подтвердили allowlist восьми стадий, 15 фиксированных buckets, насыщение
count/sum, null при отсутствии валидных samples, выборку каждого 64-го вызова
и сохранение доставки, порядка callbacks и исходной ошибки при исключении
observer. Прежние V20/CL4/CL6/native сценарии сохранены. Root просмотрел delta;
Независимое review — PASS для diagnostic full, source blockers не найдены.
Все пять scratch scripts заморожены с отдельным source receipt в
`issue12-v21-owner-stages-full-20261012/experiment-source/owner-stages-v1`.
Coalescer и Set64 dispatch измеряются inclusive; encode/conversion/reserve и
IPC grouping вложены в dispatch и не складываются с ним как отдельные затраты.
`worker.send` измеряется только синхронно, без ожидания callback/child ACK.
Накладные расходы timing учитываются: этот контроль не доказывает улучшение
производительности, lifetime max не выдается за main-only без отдельной границы.

V21 full — **FAIL**, CLI exit 1, launchProof=false, 1940.315 ms / 195 ACK.
Admission 5000 уникальных streams и 5001-й typed 503 до SSE headers прошли.
Измерение началось 18:58:47.324 UTC. Первый hard rejection в 18:58:49.230 UTC:
source=`enqueue`, Hub 117099 records / 30622584 B, дополнительные IPC-копии
139600 records / 36486254 B, добавление 1 record / 43 B. Projected 256700 records
и 67108881 B: records ниже 262144, bytes выше 67108864 на 17 B.
Driver сохранил POPULATION_INTERRUPTED / live 4999 в 18:58:49.264 UTC, через
34 ms после rejection. Сообщение «close after 15297ms» описывает возраст stream,
а не длительность main. Child ACK errors и IPC reservation rejection отсутствуют.
Последний успешный GET 18:58:48.438 UTC: live 5000, total queue 142278 records /
37158181 B, owner loop 31.932 ms, workers 25.854 / 33.391 ms. Итоговый сохранённый
loop максимум 59.965 ms; event latency percentile не завершён.

77 owner log snapshots содержат stage aggregates, но console.log строка не
содержит собственного timestamp. Worker `capturedAt` не равен времени owner
snapshot. Попытка получить timestamped Docker log после окончания не удалась:
контейнер уже удалён; этот файл не является timing receipt. Максимум coalescer
274.388 ms впервые виден в строке после первого rejection с live 4079 и потому
сам по себе не доказывает причину первого close. Независимый causal audit
подтвердил границы: snapshots в строках 5106 и 5109 заключены соответственно
между Pino timestamps 18:58:47.380–48.374 и 18:58:48.439–48.577 UTC. Оба
лежат внутри main до первого отказа, но интервал между ними известен только
в пределах 65–1197 ms. Deltas: coalescer 4 callbacks / 75.975 ms, Set64 dispatch
134 / 349.991 ms inclusive, IPC flush grouping 250 / 4.178 ms, синхронный
worker.send 250 / 24.078 ms. Sampled Buffer/frameRecords: 123 samples / 1.988 ms,
reserve / 0.073 ms, queue grouping / 0.065 ms. Это часть main; делить её на
предполагаемую секунду или складывать inclusive с вложенными нельзя.
Отказанные 43 B практически идентифицируют heartbeat: invalidation имеет
обязательные id/event/retry/data и длиннее, heartbeat interval равен 15000 ms,
а первый close имеет возраст 15297 ms. Тип producer непосредственно в receipt
не записан; backlog остаётся условием отказа, heartbeat — вероятным триггером.

13 host samples: gateway cgroup peak 689078272 B, aggregate RSS 858849280 B,
FD total 5096; nginx peak 666062848 B, RSS 664416256 B, FD total 10053.
Sampled max/OOM events — 0 при прежних 1 GiB / 2 CPU. Cleanup 3587.144 ms,
verified=true: все 8 containers, сеть и synthetic private material удалены.
Re-auth, HUP в 900 s, loaded shutdown и полный 30-минутный профиль не достигнуты.

Следующий V22 ограничивает рабочее окно IPC до 64 pending targets на каждого
TLS worker, переиспользуя существующие canWrite/wait/release. Это контролируемый
кандидат против накопления тысяч защищённых от coalescing in-flight writes,
а не вывод о причине coalescer 274 ms. Hard serialized records/bytes и две
дополнительные IPC-копии считаются как прежде. Ожидание имеет FIFO каждого worker,
общий cap 5000, O(1) cancellation и не более 64 пробуждений за один ход.
Новый timer, config option или dependency не добавляются. Улучшение не доказано.

V22 original snapshot `issue12-v22-bounded-write-window-full-20261013`, manifest
`39b4da877294804b3620caa7ab4c1bd8bba73c39de86565d645bcf7d7422357e`, run
`i12-23919e8a0bbd43d1`: root `verifyPrepared` — PASS, 209 source / 14 supporting
hashes, compiled/native/images, 5000 / 100 ACK/s / 1800000 ms и обе роли
2 CPU / 1 GiB сверены до экспериментального patch.
V22 gateway SHA-256
`263be3050be9bb22463b53d04f82f3f21941adf67a4a2b5ecfa149e132cd25fd`.
Изменены только target window в canReserve/reserve/release, per-worker FIFO wake
и два scalar поля существующего owner log: capturedAtMs и active targets.
Patch V21 сохранён byte-identical. Worker syntax/manual smoke — PASS; root
просмотрел delta. Actual-source regressions, независимое review и реальный
smoke выполнены последовательно; результат полного прогона приведён ниже.
V22 actual-source selfcheck SHA-256
`e30439f3ade90f20cfd8116326299635e95c1db3f871bd9f18199de36b79d0d8`.
Syntax трёх scripts и `node /tmp/coffee-12-cluster-min-fixture.mjs` — PASS.
Actual patched Hub подтвердил окно 64/65, soft wait без encode/writing,
coalescing до последней версии subject и resume после реального ACK_BATCH.
При worker A с 64 активными targets и 100 FIFO waiters свободный slot B
продвинул B первым; A завершил FIFO за два bounded release окна, все target/
byte/record counts вернулись к нулю. Прежние deadline/shutdown/CL4/CL6/native
и V21 observer проверки сохранены. Root просмотрел тестовый delta.
Независимое V22 review — PASS для 512/120 s smoke, source blockers не найдены.
Пять scratch scripts заморожены отдельно в `experiment-source/bounded-window-v1`;
реальный full завершился FAIL по headroom во время re-auth.

V22 real smoke `issue12-v22-bounded-write-window-smoke-20261013` —
**DIAGNOSTIC_PASS**, CLI exit 0, launchProof=false, missing=[] / all 11 checks=true.
Original manifest SHA-256
`a5160e6a5357534b8363d41bfabd9835738649b482b38d02b1329e93b25d97a9`.
512 клиентов / 120010.199 ms / 12002 ACK; event p95 327 ms, loop максимум
29.884415 ms. Re-auth: 512 recovered / samples / auth-close delta, final live 512,
unexpected=0 / pending=0, gap p95 3154 ms / max 3166 ms. Raw min live 131
отражает допустимые expiry disconnects, а не пропажу здорового клиента.
Actual HUP: 97.765 ms, new worker 3772710 после 3762388, live 512→512.
Loaded shutdown: 650.819 ms, все 512 armed/live/gateway/closed с уникальными
reset→server-close receipts, максимум reset→close 68 ms, errors=0,
timedOut=false / forced=false, gateway exit 0 / OOM=false.

Root проверил 181 owner snapshots: capturedAtMs валиден, active targets
обоих workers не превышают 64; фактический максимум 64/64. Gateway: 30 host
samples, aggregate RSS 442937344 B / cgroup peak 261677056 B / FD total 607,
reference memory.max 536870912 B. Nginx: peak 96075776 B / RSS 99131392 B /
FD 1066. Driver: RSS 343691264 B / FD 548, отдельный budget 2 GiB. Sampled
OOM kills — 0. Cleanup 3071.062 ms, verified=true, все 8 roles, сеть и private
material удалены. Driver control cleanup 2533.113 ms — отдельное измерение.
Промежуточный driver-result имеет прежний pre-wrapper FAIL/missing budgets+
fixture cleanup при error=null; финальный coordinator после добавления обоих
proofs дал PASS. Независимый receipt audit — PASS для следующего full:
512 уникальных old/new IDs и shard/client, каждый ID сменился; 121 measurement
GET содержал метрики всех трёх actual process roles с монотонными counters.
Три отдельных host PID совпали с ready logs. Owner snapshots имеют монотонные
capturedAtMs; worker sample age в них максимум 679 ms. Независимый owner raw-age
непосредственно на каждом GET не реконструирован; это ограничение указано прямо.
Full V22 с тем же original manifest, всеми TTL/security/SLO и budgets —
**FAIL**, CLI exit 1, launchProof=false. Measurement начат 19:30:19.892 UTC:
79699.692 ms / 7971 ACK, raw min live 3047 / max 5000. Admission подтвердил
5000 уникальных соединений и typed pre-header 503 для 5001-го. Непрерывные
1800000 ms, полная coverage/latency classification, весь re-auth, HUP и loaded
shutdown не достигнуты. Итоговый сохранённый event-loop p95 максимум 67.239935 ms.

Первый headroom failure записан 19:31:39.584 UTC, kind=2 (`/health/live` через
nginx): 1475.567 ms, TCP connect 52.066 ms, secureConnect 1456.901 ms, headers
1475.326 ms, HTTP 200. Ещё пять public health/auth/API probes в том же окне
заняли 1481–1658 ms с корректными 200/404; secureConnect 1439–1459 ms.
Это непосредственно локализует задержку до завершения TLS, но не разделяет
ожидание accept, scheduler и native crypto. Driver loop p95 15.098 ms / max
71.959 ms не объясняет всю задержку. Последний успешный headroom sample
19:31:36.511 UTC уже содержал direct-gateway probes 983–996 ms.

Сохранены 257 re-auth receipts с новым connection ID и TLS resumption=true,
gap 3158–8246 ms, а также 310 retry receipts со статусом 504. Первый успешный
re-auth — 19:31:34.343 UTC; полный цикл 5000 клиентов не подтверждён.
Последний gateway GET 19:31:38.081 UTC: live 3558, auth-close 1801,
total queue 71718 records / 18768211 B; все IPC rejection/ACK-error counters 0.
155 owner snapshots имеют собственный capturedAtMs; оба active-target maxima
равны 64. Независимый final receipt audit подтвердил сохранение первой ошибки,
четыре exact hook preimages и три разных actual process PID. В 76 measurement
GET были метрики всех трёх ролей с монотонными sample counters; worker age в
owner logs максимум 747 ms. Максимальная scraped total queue — 100905 records /
26422060 B; IPC pending — 6498 / 1677176 B. Все sampled значения ниже лимитов;
частоту sampling не следует трактовать как непрерывный upper-bound proof.

26 host samples gateway/nginx и 25 driver: gateway aggregate RSS 1022038016 B,
cgroup peak 854605824 B / FD total 5096; nginx RSS 667811840 B / peak
691830784 B / FD 10061. Driver RSS 1283391488 B / peak 1257312256 B / FD 5086,
отдельный budget 2 GiB. Sampled OOM kills 0; gateway/nginx memory.max 1 GiB.
Docker CPU percentages — разреженные наблюдения, не точная атрибуция
pre-fatal CPU: максимумы gateway 202.83%, nginx 190.46%, driver 277.95%.
snapshot.at ставится перед последовательным чтением трёх ролей; последнее
наблюдение 19:31:39.359 UTC пересекает fatal/teardown и не является целиком
pre-fatal. В частности, gateway FD=95/CPU=4.05% нельзя приписать моменту до
отказа при тысячах живых stream. В следующем scratch coordinator добавлены
отдельные measurementStartedAt/measurementFinishedAt каждой роли без изменения
ресурсных проверок. Manifest перечисляет бюджеты шести ролей; дополнительные
fixtures idp/orders имеют actual inspect limits 2 CPU / 512 MiB / 4096 FD,
но не перечислены в manifest budget map — ограничение coverage receipt.
Cleanup 3376.462 ms, verified=true: все восемь containers, сеть и synthetic
private material удалены. Обычный production startup не изменён.

V23 `issue12-v23-worker-tls-observer-full-20261013`, original manifest
`82ee544bcbcdff93a48129f094301660dc8027cedad0e88155e32a7b74e02089`, run
`i12-ae746fa1e3024a54`: verifyPrepared — PASS, 209 source / 14 supporting hashes,
compiled/native/images и прежние 5000 / 100 ACK/s / 1800000 ms, обе роли
2 CPU / 1 GiB. Добавлены лишь bounded TLS counters/histograms двух workers и
per-role resource read timestamps. Три состояния resumption учитываются
раздельно; ошибка измерения не выдаётся за cold handshake. Pending correlation
map ограничен 12288, коды/ciphers/protocols и 15 histogram buckets фиксированы,
log использует существующий секундный sampler без нового timer/IPC/metrics API.
Адреса/порты/токены/сертификаты/keys в diagnostic output не входят.

V23 gateway SHA-256
`fc833d585f3bbc562e1bb06cad0bc695bdec9f1b40aea165c8cf2b4e18bfa85e`, selfcheck
`8508a1f8eb4c325e91ddc3c17dc458d7ab79c11414a827c5986c297c81258723`, coordinator
`da3ba0ff07d53fb2597e7128e1bf260daf7048f1f409ebf8aef6cebd0200cb36`.
Patch прежний `508db65ab405cc045d802566a23cb7852b3f91303210d939cf04abd7c71a945e`.
Syntax 3/3 и `node /tmp/coffee-12-cluster-min-fixture.mjs` — PASS, включая
four-file receipt, actual-source VM, frozen pre/post hashes и сохранённые
CL4/CL6/V18–V22 regressions. Root просмотрел source/test delta; независимое
review — PASS для прямого diagnostic full без повторного observer-only smoke.
Пять scripts архивированы и сверены в `experiment-source/tls-observer-v1`.
Запуск начат 19:48:29 UTC и завершился FAIL, launchProof=false, exit=1.
Основная нагрузка началась 19:50:06.564 UTC: 7631 ACK за 76308.047 ms,
минимальная raw population 3587, event-loop max 67.699 ms. Establishment занял
21801 ms; 5000 unique clients и typed 503 для 5001 до SSE headers подтверждены.
Первый отказ: `healthy cohort had a queue/write-pressure close: 4 !== 1`.
Baseline slow-close=1 относится к preflight. Три новых закрытия локализованы
между GET 19:51:20.000 (slow=1) и 19:51:22.844 (slow=4); текущий Hub объединяет
per-client/global overflow, replay capacity и write deadline одним счётчиком.
Hard queue warning и IPC/child-ACK errors отсутствуют; максимум общей очереди
109822 records / 28658224 bytes при лимитах 262144 / 67108864. Эти значения
не исключают превышения per-client лимита или deadline.

177 успешных re-auth использовали client→nginx resumption; 255 retries получили
504. Полный re-auth, 30 минут, HUP в 900 s, итоговая event latency и loaded
shutdown не достигнуты. Cleanup 3589.258 ms, verified=true: восемь containers,
сеть и synthetic private material удалены. Sampled OOM=0; gateway peak cgroup
847581184 bytes, nginx 691535872, driver 1261477888. Последний полностью
pre-fatal gateway resource interval 19:51:19.799–21.799 показывает CPU 200.14%
в общем бюджете 2 CPU. Это подтверждает насыщение, но не причину трёх закрытий.

TLS timing начинается с Node connection event и не включает ожидание до
accept. Counters охватывают также health probes; без phase/client correlation
они не дают точную долю resumption каждой re-auth попытки. До fatal все successful
backend handshakes использовали TLS 1.3 / AES_256_GCM_SHA384. На последних
prefatal samples двух workers secure=5682, resumed=5453, cold=229; максимумы
successful resumed handshake 122.038 / 142.905 ms, cold 89.983 / 82.192 ms.
Reuse unknown и map overflow равны нулю. Все 46 TLS errors имеют missing start
и не входят в error latency histogram: отсутствие duration не означает быстрый
или беззадержочный отказ. Ошибки не сопоставлены с конкретными slow-close.
Missing start или коллизия tuple ограничивают корреляцию; lifetime max не является
новым interval maximum, для интервала вычитаются cumulative counts/sums/buckets.
Независимая финальная сверка V23 подтверждает manifest/frozen scripts/четыре
compiled hooks, runtime receipt двух workers и одного owner, admission и cleanup.
Hash непосредственного `docker logs --since` в process receipt не совпадает с
hash отдельного сохранённого `realtime-gateway.log`; после cleanup тот исходный
поток недоступен. Эта часть hash-связи не воспроизводится по итоговому log.
Inspect limits подтверждают выставленные бюджеты, sampled resources — только
измеренные интервалы; они не доказывают предел фактического потребления между
наблюдениями или бюджет всего host.

Следующий V24 сохраняет прежнюю AES/default TLS policy и добавляет только
первые восемь slow-close receipts, включая preflight: explicit reason,
capturedAt, per-client/global/transport queue usage и limits. Возраст измеряется
только для существующего write deadline; новый timer и новый ресурсный бюджет
не вводятся. Cipher preference пока не применяется: сначала требуется отличить
local/replay capacity от deadline. Original prepared snapshot с названием
`issue12-v24-two-tls-preferred-cipher-full-20261013` остаётся неизменённым;
название было выбрано до уточнения эксперимента и не описывает TLS policy.

V24 original manifest
`90bcb7d83ac182706a507647958f489ad7a26ed6a2cb1ed4efa72cb82300b323`, run
`i12-28d5e3cd997747c7`: verifyPrepared — PASS, 209 sources / 14 supporting /
38 compiled hashes, 5000 / 100 ACK/s / 1800000 ms и прежние бюджеты.
Gateway SHA-256 `2e7d2f9c77373a6241dcc1ee0778431c21fb8dfc489b36b70153cd189c3a7f9c`,
patch `8f91836e3ec30430797c5953a8ec02841c0a6d678f67615a187df14ebe3dd484`,
coordinator `e7aecea3a4ae592305244776947b01c181e64ae627e6143ad52fa31ee9d1d224`,
selfcheck `265ef4f760d5780df7db3737df0230398c86ec09a818cde30648958c669b82ca`.
Syntax четырёх scripts и существующий min-fixture — PASS, exit 0. Actual
transformed Hub проверяет deadline/enqueue/replay snapshots до cleanup,
throwing observers и освобождение очередей; actual owner сохраняет первые
восемь receipts с preflight. CL4/CL6/V18–V23 regressions сохранены. Root просмотрел
source/test delta; независимое review — PASS для direct diagnostic full.
Пять scripts и receipt архивированы в `experiment-source/pressure-reasons-v1`.
Запуск начат 20:08:22 UTC, завершён FAIL, launchProof=false, exit 1.
Measurement началась 20:09:57.601 UTC: 7717 ACK за 77168.920 ms; raw min live
3271 / max 5000, gateway loop max 80.740 ms, establishment 21478 ms.
Fatal — `HEADROOM_LATENCY_EXCEEDED`, kind 3 (direct gateway), 1080.038 ms.
Observer сохранил preflight enqueue-capacity (64 records) и семь runtime
deadline receipts: age 5000–5006 ms, capacityWaiting=true, writingRecords=0,
per-client 25–26 records / 6550–6594 bytes; Hub 61060–70052 records /
15957669–18325387 bytes, transport 5454–6112 records / 1428714–1601344 bytes.
Во всех этих snapshots per-client и общие очереди ниже лимитов. Это устанавливает
истечение общего wait/write deadline при ожидании IPC slot, но не объясняет,
какая операция задержала освобождение slot.
Два совпадения capturedAt были ошибочно объединены первоначальным подсчётом;
восемь элементов сохранённого массива — preflight плюс семь runtime receipts.
Deadline receipts относятся к 20:11:13.910–14.485 UTC, за 263–838 ms до
неуспешного headroom ответа 20:11:14.748; fatal записан в 14.770. Совпадение
по времени не доказывает причинной связи между readiness latency и deadlines.
До fatal — 123 unique re-auth, все с client→nginx TLS session reuse, gaps
4258–6874 ms; 296 retries с 504. Итоговый файл содержит 144 / 311, включая
события после fatal; эти totals не являются pre-failure recovery.
Последние pre-fatal TLS samples 20:11:14.392 / 14.411 показывают только
TLS 1.3 / AES-256-GCM; cold max 92.2 / 89.1 ms, resumed 107.3 / 87.0 ms.
136 / 143 TLS errors относятся к other + missingStart, latency не измерена.
Последний целиком pre-fatal gateway resource interval 20:11:10.971–12.974:
RSS sum 999.7 MB, cgroup current 829.8 MB / peak 830.6 MB, FD 4456,
CPU 186.32%, OOM/high/max/kill counters 0. Driver interval пересекает fatal.
Выборка не доказывает абсолютные максимумы между измерениями.
Независимая сверка manifest, пяти frozen scripts, четырёх compiled hooks,
трёх distinct runtime PID, admission и cleanup — PASS для receipt этого FAIL.
30 минут, итоговая event latency, HUP в 900 s и loaded shutdown не достигнуты.
Cleanup 3582.750 ms, verified=true, восемь containers/сеть/private material удалены.
После восьми событий новые причины не сохраняются; receipt может не попасть
в следующий 1Hz log до остановки. Deadline age использует wall clock.
Отсутствие diagnostic receipt не доказывает отсутствие pressure-close.

Следующий V25 проверяет только внутреннюю server cipher preference gateway:
ChaCha20-first с AES256/AES128 fallback и прежними Node default suites.
Public nginx TLS policy, протоколы, trust checks, IPC window, deadline, ресурсы
и все acceptance gates сохраняются. Замена production startup пока не принята.

V25 original snapshot `issue12-v25-internal-cipher-full-20261013`, manifest
`0022fa06274604cc0a29f40b87097a5cbc7e046d975af277cb836a074797e7ac`, run
`i12-728e896d795c43c9`: verifyPrepared — PASS, 209 / 14 / 38 hashes,
5000 / 100 ACK/s / 1800000 ms, gateway и nginx 2 CPU / 1 GiB.
Существующий cipher transform выделен в одну pure function и применяется к
runtimeAfter до финальной записи/hash; legacy caller использует ту же функцию.
Точные четыре compiled hooks сохраняют original-before и final-after chain.
Gateway не менялся; helper SHA-256
`60ce712aba37d7b0347ced9a0d0e2c0be15d55e9dbbe55a17109e7084cd95dd9`, patch
`64003bb6a596480de2cab10824fb92a9b88464fc06980549cca97c339175f9a5`, coordinator
`73f214b0d882b711ec7e53d16eafd397304ed5ec460b312015b0f61b790dbd12`, selfcheck
`8f3626c6faf399c13be8fb38a457f5b0b3a2ff1d88eac1edee2cc2cf06c4f2b9`.
Syntax 5/5 и существующий min-fixture — PASS, exit 0, включая four-file receipt,
frozen hashes и прежний suite. Actual HTTPS source slice в VM проверяет guard,
порядок suites, honorCipherOrder, сохранение minVersion/key/cert/CA/requestCert/
rejectUnauthorized/signal и отсутствие мутации. Non-realtime HTTPS и отсутствие
HTTPS options сохраняются. Root прочитал source/test delta; шесть scripts с
helper provenance архивированы в `experiment-source/internal-cipher-v1`.
VM не подтверждает фактический AES-only handshake; реальное cipher negotiation
остаётся под worker TLS observer в полном diagnostic control, launchProof=false.
Независимое review — PASS для direct full; manifest и все шесть source hashes
повторно сверены reviewer. Запуск начат 20:16:15 UTC, итог FAIL, exit 1.
Measurement 20:17:48.379 UTC: 7963 ACK / 79630.283 ms, raw min 2943 / max 5000,
loop max 89.784 ms, establishment 19380 ms. Первые неуспешные direct GW ready
probes 20:19:07.976 / 07.990: kind 3, HTTP 200, 1311.648 / 1303.525 ms.
Первый TCP connect=87.727, secureConnect=1282.128, headers=1311.315 ms;
второй connect=67.220, secure=1252.129, headers=1303.298 ms. Следовательно,
connect→secure занимает 1194 / 1185 ms, secure→headers лишь 29 / 51 ms.
Задержка до TLS completion подтверждена; client scheduling, kernel accept queue
и cluster descriptor dispatch без per-probe correlation ещё не разделены.

До fatal 20:19:08.009 — 110 unique re-auth, все client→nginx resumed, gaps
4438–7969 ms, и 460 unique retries с 504. Итоговый файл 128 / 534 включает
postfatal события. Внутренняя preference действительно применена: последние
prefatal worker samples secure 2705 / 2747, resumed 2593 / 2623, все successful
TLS 1.3 используют ChaCha20. Cold max 77.9 / 101.5 ms, resumed 247.8 / 246.2 ms;
эти aggregate maxima не сопоставлены с двумя headroom probes. Error durations
с missingStart неизвестны. Runtime deadline receipts 20:19:06.710–07.330:
age 5004–5005 ms, capacityWaiting=true, writing=0, local 25 records / 6550 bytes,
общие queues около 57231–68094 records / 14.98–17.82 MB, ниже лимитов.
IPC rejects/child ACK errors 0; окна достигают 64 targets на worker.
Совпадение по времени с headroom не доказывает причинность.

Последние полностью prefatal resource intervals: nginx 20:19:02.221–04.093,
CPU 76%, RSS sum около 665 MB, FD max 8529; gateway 04.093–06.089, CPU 158.1%,
RSS sum около 991 MB, cgroup current 821.1 MB / peak 822.9 MB, FD 4110,
OOM counters 0. Driver interval пересекает fatal; его CPU нельзя выдавать за
полностью prefatal sample. Независимая сверка manifest, шести source hashes,
четырёх compiled hooks, трёх distinct live PID и cleanup — PASS для receipt FAIL.
Cleanup 3677.398 ms, verified=true, все восемь containers/сеть/private удалены.
Полные 30 минут, вся re-auth cohort, итоговая latency, HUP и loaded shutdown
не достигнуты; production adoption и merge остаются недоказанными.

Read-only разбор release/wake/child ACK не нашёл доказанного lost wake или
двойного освобождения, объясняющего V25. FIFO относится к извлечению waiter,
а не атомарному резервированию: resumed pump конкурирует с другими pumps.
Starvation текущего run этим разбором не доказана.

Exact installed Node `v26.8.1` совпадает с manifest. Root и native audit проверили
встроенные `internal/cluster/round_robin_handle`, `primary`, `child_process`.
В RR primary принимает socket и передаёт descriptor worker через тот же
ChildProcess IPC, которым идут FRAME_BATCH. Пока descriptor ждёт NODE_HANDLE_ACK,
последующие сообщения без handle помещаются в очередь ради порядка. Источники:
[RR handoff](https://github.com/nodejs/node/blob/v26.8.1/lib/internal/cluster/round_robin_handle.js#L99-L138),
[IPC handle queue](https://github.com/nodejs/node/blob/v26.8.1/lib/internal/child_process.js#L812-L870).
Это подтверждает механизм конкуренции, но не длительность его участия в V25.
Public API не раскрывает RR queue depth/primary accept time; private monkeypatch
не вводится. Следующий V26 меняет только public schedulingPolicy на SCHED_NONE
до setupPrimary/fork: два workers принимают с общего listen handle. Все прочие
параметры V25 сохраняются. Сначала 512 / 120 s smoke, затем тот же full профиль.
Распределение accept между workers требуется проверить: ОС может дать перекос.

V26 original snapshot `issue12-v26-direct-accept-full-20261013`, manifest
`401994fc9a807b0b2c93b096b8290e7bff47041e9fd49af92152208f847e3934`, run
`i12-923e37cb5f02403c`: verifyPrepared — PASS, 209 / 14 / 38 hashes,
5000 / 100 ACK/s / 1800000 ms и прежние 2 CPU / 1 GiB budgets обеих ролей.
Gateway SHA-256 `eb768803d59ca128aacbb5e5addcdc0d1b6641bba74d7293b16f3bd00b34e643`,
coordinator `884721ecd97eb60bba92504c525c1dc25ecd8908b807612bfc4235e7d1f24d7e`.
Gateway delta — одна строка policy; owner/два TLS workers/readiness/PID/stop
сохраняются, listen использует общий host/port без exclusive. Независимое source
review — PASS для smoke после tester; фактический SCHED_NONE lifecycle ещё
не подтверждён. Full ожидает успешного 512 / 120 s smoke и verified cleanup.
Tester: syntax 4/4 и min-fixture — PASS, exit 0; actual start/message/fail VM
подтверждает policy→setup→fork→fork, два LISTENING PID и fail-closed при mismatch.
Прежние regressions сохранены. Root прочитал source/test delta. Selfcheck SHA-256
`5b4b85ff397373251c1bdbc4e0e39441f8ab1ce3272664f484d3cd3c71db7c58`; шесть scripts
с helper provenance архивированы в `experiment-source/direct-accept-v1`.
Smoke `issue12-v26-direct-accept-smoke-20261013` начат 20:29:23 UTC:
512 clients / 100 ACK/s / 120000 ms, reference memory 512 MiB, launchProof=false.
Итог DIAGNOSTIC_PASS, launchProof=false, driver/coordinator exit 0: 120000.398 ms /
12001 ACK, все 11 checks true, error=null, missing=[]. Event latency p95 316 ms,
loop max 31.048 ms. Все 512 unique clients восстановились с новым connection ID
и TLS resumption: authCloseDelta=512, unexpected=0, pending=0, final live=512,
gap p95 3151 / max 3289 ms. Реальный HUP создал новый nginx worker за 81.324 ms,
live 512→512. Loaded shutdown 646.963 ms, 512 unique reset→server-close receipts,
exit 0, workerErrors=0, timedOut=false, forcedClientClose=false, OOM=false.
Cleanup 2939.716 ms verified; все восемь containers/сеть/private material удалены.
Worker transport accepted−closed около 255/257 на 30-й секунде и 257/255 после
recovery; TLS errors 0, все negotiations CH. Probes смешаны с SSE, поэтому
transport counters не являются точным cohort distribution. Независимая сверка
manifest `5def879a534a1e92ea7db53a197f72ef15561a06d968ce45bcd47c47ec14faf4`,
шести sources, четырёх compiled hooks, трёх PID и runtime receipts — PASS для full.
Root подтвердил внешнее завершение coordinator exit 0 и повторно сверил все
шесть source hashes и original full manifest. Full V26 начат 20:34:39 UTC;
итог FAIL, launchProof=false, coordinator exit 1. Measurement 20:36:17.560 UTC:
7617 ACK / 76161.302 ms, raw min live 3495 / max 5000, loop max 74.908 ms,
establishment 21434 ms. Fatal — `healthy cohort had a queue/write-pressure
close: 30 !== 1`. Полный re-auth, 30 минут, итоговая latency, HUP и loaded
shutdown не достигнуты. Cleanup 3409.985 ms verified: восемь containers,
сеть и synthetic private material удалены. SCHED_NONE не устранил отказ;
выигрыш или причинность RR этим результатом не доказаны.
Независимая final сверка manifest, шести source hashes, четырёх compiled hooks,
трёх distinct runtime PID, admission и cleanup — PASS для receipt этого FAIL.
До fatal 20:37:33.721 — 91 unique re-auth, gaps 3271–6209 ms; итоговый файл 96
включает пять postfatal событий. Retry receipts отсутствуют; это не доказывает
отсутствие попыток. TLS counts около establishment дают secure 2472 / 2543
в 20:36:18 (включены control/health). Последние prefatal samples 20:37:33.326 /
33.406: accepted 2916 / 2945, secure 2913 / 2942, closed 827 / 880, resumed
2801 / 2818, cold 112 / 124, errors/mapOverflow 0; все successful TLS 1.3 — CH.
Точного SSE cohort split эти mixed counters не дают.

Slow counter 1→30 между GET 20:37:32.682 и 33.711. First-eight observer хранит
preflight плюс семь отдельных runtime deadlines: пять с capturedAt 33.633,
два с 33.634, age 5027–5028 ms, capacityWaiting=true, writing=0, local
25 records / 6550 bytes. Hub+transport около 102065–102215 records /
26.63–26.67 MB, ниже limits. Остальные 22 новых close не типизированы из-за cap.
IPC rejection/child ACK errors 0, оба окна 64 targets; owner loop 44.04 ms,
workers 37.75 / 57.67 ms. Все 152 direct mTLS kind-3 headroom probes до fatal
ниже 1000 ms: p95 около 166.9 / max 335.2 ms, secure p95 97.5 / max 183.9 ms.
Этот run завершился раньше другого gate, поэтому отсутствие headroom failure
не доказывает достаточность SCHED_NONE или причину задержки V25.
Последние целиком prefatal resource reads: nginx 20:37:29.531–31.374, CPU
140.35%, RSS sum 664.8 MB, FD total 8840; gateway 31.374–33.378, CPU 198.61%,
RSS sum 995.9 MB, cgroup current 826.1 / peak 828.4 MB, FD 4404. OOM/high/max/
kill counters 0; driver read пересекает fatal. Причина занятого slot не измерена.
Следующий V27 добавляет лишь bounded transport-age/stage diagnostics на
существующих owner/worker 1Hz logs. Политики V26 и все gates сохраняются.

V27 перед запуском: root повторно проверил original manifest
`99a599f10536619828e096379858335f5448ec367bb9f295052f5e83bef9abfb`,
run `i12-34989c8ccb8d4c44`, 209 source / 14 supporting / 38 compiled hashes.
Профиль — 5000 / 100 ACK/s / 1800000 ms; gateway и nginx — по 2 CPU / 1 GiB.
Диагностика использует существующие stream/waiter/target collections и 1Hz
sampler: возраст reservation и capacity waiter по каждому worker, возраст
child queue, ожидание callback/drain и фиксированные ACK counters. Возраст
считается только по локальным `performance.now()` одного процесса; между
процессами отметки не вычитаются. Target ACK и batch send имеют разные явно
названные счётчики. Invalid/throwing clock даёт неизвестный возраст (`null`),
а сбой observer не должен прервать write, release или cleanup. Это observer
эксперимента; production architecture и acceptance пока не изменены.
`awaiting*` показывает возраст всей write с её начала, а не время конкретной
фазы. Reservation-to-ACK histogram включает success/error ACK и исключает
cancellation; `ackBatchesCompleted` включает ошибочные send callbacks,
отдельно учтённые в `ackBatchSendErrors`. Scan existing streams выполняется
раз в секунду и имеет ненулевую стоимость; нагрузочный результат обязан её
учитывать.

V27 actual-source selfcheck/min-fixture — PASS, 66 checks; tester и root
отдельно повторили `node /tmp/coffee-12-cluster-min-fixture.mjs` на финальных
байтах. Четыре compiled hooks, before/after hashes и nonRealtimeUnchanged
подтверждены. Независимое source/test review — PASS для direct diagnostic
full. Frozen шесть scripts находятся в
`issue12-v27-transport-ages-full-20261013/experiment-source/slot-stage-observation-v1`:
gateway `fffb5b16df15fe9b34bda99840236b8c5185800edde976d678199e051924c90c`,
coordinator `55f81c22e6d7372f18eb733731c909d284ad7368ce7938716eee1fd2d8b3f7e6`,
selfcheck `4d5b7176d62d90732b210e5dc9fda02ffdcdf57691bbf07c63561f09ad443898`.
Patch, min-fixture и cipher helper сохранили V26 hashes; source-receipt
фиксирует все шесть. Full V27 начат 20:53:43 UTC, measurement —
20:55:24.143 UTC. Итог FAIL, launchProof=false, coordinator exit 1:
7652 ACK / 76512.435 ms, raw min live 3669 / max 5000, fatal sample live 3668,
loop max 70.124 ms, establishment 20228 ms. Fatal 20:56:40.655 — pressure
close `81 !== 1`; 30 минут, full re-auth, HUP, latency и loaded shutdown
не достигнуты. Cleanup 3393.311 ms verified: восемь containers, сеть и
synthetic private material удалены. Независимый provenance/admission/
four-hooks/three-PIDs/budgets/cleanup audit — PASS для receipt этого FAIL.

Первые семь runtime deadline receipts 20:56:40.395–.396 имеют возраст
5002–5003 ms, capacityWaiting=true, writing=0, local 25 records / 6550 bytes.
С preflight они заполняют cap восемь; причины остальных 73 новых closes
индивидуально не сохранены. Hub+IPC около 106125 records / 27.69 MB при
лимитах 262144 / 67108864 bytes, IPC rejection/ACK errors 0. Owner snapshot
20:56:39.519: окна 64/64, waiters 1992/1889, oldest wait 4123/4125 ms,
oldest active reservation 94 ms; cumulative ACK histogram max 203.689 ms,
p95 upper bound 50 ms. В 20:56:40.550 (после первых deadlines, до fatal)
oldest wait 4575/4601 ms, oldest reservation 118/4 ms, ACK max 216.923 ms.
На sampled child snapshots не накопились target queue/drain/ACK-send;
последние snapshots до первого deadline: worker2 20:56:39.802 — 37 waiting
callbacks, oldest 5 ms; worker1 .976 — 0. Это slot-wait backlog; конкретная
причина недостаточного обслуживания всей очереди ещё не установлена.
ACK target throughput по разнице owner snapshots снизился примерно с
10 тысяч/s до 1.8 тысячи/s во время re-auth. До fatal сохранены лишь восемь
успешных resumed re-auth, gaps 3284–5724 ms; full cohort не подтверждён.
Последний полностью prefatal gateway resource interval закончился
20:56:34.776 (5.9 s до fatal), cgroup peak 822.0 MB, OOM/kill 0; это не
непрерывное измерение ресурсов в момент timeout.

Независимый actual-source VM reproducer подтвердил V27-F1: wake удаляет
старого waiter и только планирует pump; новый pump получает освобождённый
slot, старый снова блокируется и попадает после следующего waiter. Это
реальный дефект FIFO, но причинность именно этого load FAIL пока не доказана.
V28 устраняет async gap: capacity resume вызывает `connection.pump()`
синхронно внутри существующего SetImmediate wake с FIFO/RR и максимум 64
resumes. Budget checks, окна 64, callbacks, cleanup и общий deadline 5 s
сохраняются. Дополнительные grant collections не нужны. Stage
`hub_pump_set64_dispatch` после этой правки не включает pumps из capacity
wake и не означает суммарную стоимость всех pumps. Новый full проверит
гипотезу после RED/GREEN regression и independent review.

V28 actual patched-Hub RED/GREEN — подтверждён: с archived V27 helper
старый waiter не пишет, новый конкурент занимает единственный свободный
slot; с V28 slot получает старый waiter. Existing min-fixture/selfcheck —
66 checks PASS у tester и root, включая accounting, cleanup, bounded wake,
общий wait/write deadline и previous CL4/CL6/native suite. Final независимое
source/test review — PASS для direct full. Original manifest
`81f25db7440ef4872f6e516a8cf88f582b842ef70692beb22da7da4137542b27`,
run `i12-e08eedab61c440e9`, verified 209 source / 14 supporting / 38 compiled.
Frozen шесть scripts — `issue12-v28-fifo-inline-full-20261013/experiment-source/fifo-inline-resume-v1`;
patch `77be167a12bd8e09aced16499faccbbaa6947667bb34d4c3899fa01edd669cdd`,
coordinator `eaa371a4a81c7654b8f011f91daa8abb4550d53dae2afd19bb23f807e7bf0764`,
selfcheck `aa91d5a5b973befd3107a055fc68ff8b80cf77c85a07734fde65bf68ad447506`.
Gateway, min-fixture и cipher helper сохраняют V27 hashes. Full V28 начат
21:04:11 UTC, measurement 21:05:50.040. Все 5000/100 ACK/s/30m и 2CPU/1GiB
gates сохранены. Итог FAIL, launchProof=false, coordinator exit 1:
8094 ACK / 80930.469 ms, min live 2587 / max 5000, loop max 73.204 ms,
establishment 20219 ms. Fatal 21:07:10.971 — nginx `/health/live` kind2
1689.778 ms > 1000. У probe TCP connect 15.100 ms, secureConnect 1635.138 ms,
headers 1667.467 ms, end 1689.694 ms; driver loop p95 16.613 ms. Несколько
одновременных public probes тоже имеют secure phase около 1.62–1.66 s.
Это публичный nginx TLS путь; причину внутри accept/handshake/CPU trace
пока не разделяет. Postfatal probe rows до 21:07:11.146 не меняют первый fatal.

В последнем owner snapshot 21:07:10.820 окна 64/64, waiters 3387, oldest wait
991/1532 ms, oldest reservations 25/9 ms, ACK max 192.2 ms, ACK errors и
IPC rejections 0. Последние child snapshots 21:07:09.973/10.004 имеют
пустые target queue, callback/drain и ACK-send gauges. Slow-close остался
1 (preflight), global queue около 88204 records / 22.98 MB. Это положительный
наблюдаемый сигнал FIFO, но один run не доказывает причинное улучшение.
До fatal — 75 успешных resumed re-auth (всего 84 с postfatal tail), gaps
6288–9531 ms; полный cohort не восстановлен. Последние полностью prefatal
resource intervals закончились: gateway 21:07:07.408, nginx .05.402,
driver .09.423; cgroup peaks 828.2 MB / 687.9 MB / 1.253 GB, OOM 0. Это
не непрерывная телеметрия самой failing handshake.
Cleanup 3318.702 ms verified: восемь containers, сеть и private material
удалены. Независимая сверка шести frozen sources, four hooks/receipt digest,
трёх Node PID, budgets и cleanup — PASS для receipt FAIL.
Следующий V29 меняет только публичную nginx cipher preference на ChaCha
с сохранением AES fallback, TLS versions, сертификатов и всех gates.
`ssl_prefer_server_ciphers on` также меняет порядок выбора TLS 1.2;
сохранены версии и существующий набор suites, но не прежний negotiation
order. AES128 TLS 1.2 probe подтверждает совместимость этого suite.
Клиентские offers остаются стандартными; отдельные fallback probes и
negotiation receipts обязаны подтвердить эффективную policy. Эта политика
не принята в production. Ранее похожие controls на других baseline тоже
падали; они не являются доказательством для текущей двухпроцессной схемы.

V29 root/tester final existing selfcheck/min-fixture — PASS, 70 named checks,
четыре compiled cluster hooks и nonRealtimeUnchanged подтверждены. Actual
public helper проверяет ровно nginx/transport/clients/driver; actual coordinator
VM с реальным FS проверяет отказ на неверном before hash без изменения файла,
atomic rewrite с mode 0400, точные after bytes/hashes и неизменный manifest.
Обычные client offers/CA/minVersion/peer identity сохранены; seven negotiation
probes и all-client cold assertions встроены в live preflight. Их фактический
успех unit tests не доказывают. Final independent source/test review — PASS
для direct diagnostic full. Frozen шесть scripts находятся в
`issue12-v29-public-cipher-full-20261013/experiment-source/public-nginx-cipher-v1`:
helper `8c82148f15a04ae6ca36887523ce4d254e3db4b59ca11d0394b0dfe4c45119f2`,
coordinator `de53a486b36d464bdeca18ce7118b7a0d1ef7e73048aca084cf4e81983215037`,
selfcheck `e68e3930b5b81078dde33ac3c0c7a473094c8bf0a989e2d6184761ab30e172dd`.
Gateway/cluster patch/min-fixture сохраняют V28 hashes. Original preparation
создана repository `tests/realtime/soak.test.mjs` и root verified: manifest
`e74d03f61a5ec7a0dca2b36b6a8552655a8c84abb604e7c58e8735f98365aeb0`,
run `i12-0b25fc1987a84bba`, 209 source / 14 supporting / 38 compiled.
Public override получает отдельный four-file before/after receipt; original
manifest остаётся прежним. Full V29 начат 21:16:55 UTC с прежними
5000/100 ACK/s/30m, 2CPU/1GiB gates. Measurement начат 21:18:32.550 UTC;
итог FAIL через 77966.848 ms / 7797 ACK, coordinator exit 1, launchProof=false.
Fatal 21:19:50.517 UTC: owner event-loop p95 103.874559 ms > 100; последний
gateway GET 21:19:50.500 показывает workers 85.852159 и 73.596927 ms.
Предыдущий snapshot 21:19:48.112 уже сохраняет owner peak 103.874559 ms
при worker p95 45.121535 / 41.517055 ms. Driver сохраняет run peak;
более низкий предыдущий samples.jsonl не заменяет фактический отказ.

Семь реальных negotiation probes прошли: TLS 1.3 ChaCha/AES128/AES256
на nginx и gateway и публичный TLS 1.2 AES128. Все 5000 unique initial
receipts — authorized cold TLS 1.3 ChaCha. Это compatibility proof,
не причинное доказательство выигрыша. Prefatal owner 21:19:50.146:
окна 64/64, waiters 1790/1740, oldest waits 3143/3137 ms, ACK max 275.6 ms,
ACK errors / hard IPC rejections 0. Hub 87411 records / 22821516 bytes,
transport 2400 / 628800 bytes, ниже cap. Slow-close остался на preflight 1.
31 prefatal retry с gap 4190–4470 ms не является successful re-auth;
auth-close вырос до 1829. Captured headroom: 608 samples, max 866.576 ms;
полный headroom gate не завершён. Min live 3245 / max 5000. Последние
staggered resource samples: cgroup peaks gateway около 828 MB, nginx
688 MB, driver 1.253 GB, OOM 0; они не описывают точный момент fatal.
Cleanup 3607.630 ms verified: восемь roles, сеть и synthetic private material
удалены. Независимая сверка manifest/result, шести source hashes, cluster/public
receipts, трёх Node PID, budgets и cleanup согласована с FAIL.

V30 сохраняет V29 и все gates и добавляет только штатный Node 26.8.1
`--cpu-prof` с интервалом 2000 мкс у primary owner. TLS workers фильтруют
`--cpu-prof*` из inherited execArgv. Ровно один nonsecret файл mode 0640,
UID 1000 монтируется writable в `/tmp/owner.cpuprofile`; config/role secret
mounts остаются read-only, foreign-secret negatives сохранены. После driver
и observers gateway останавливается для записи профиля до cleanup. Этот
diagnostic stop не считается loaded-shutdown acceptance; ошибка capture не
заменяет исходный driver FAIL. Profile sampling time не означает CPU core
time, а profiler overhead отдельно не измерен. Product runtime не меняется.
V30 existing selfcheck/min-fixture — 75 named checks PASS у tester и root;
four-file receipts/hashes и nonRealtimeUnchanged подтверждены. Final independent
source/test review — PASS для direct diagnostic full. Original prepare и
verifyPrepared — PASS: manifest
`c772ad50b2cd5c0c5fa099370f54974b71217a5588770250080081c4a363b2ba`,
run `i12-6cc3efcf27c4400d`, 209 source / 14 supporting / 38 compiled.
Frozen шесть scripts:
`issue12-v30-owner-cpu-profile-full-20261013/experiment-source/owner-cpu-profile-v1`;
gateway `2d1b6a536307f99b23af92f0a8220280c0f259c2b2a54f00560e489438bef4ca`,
coordinator `4b0bb9d32704a128b42942540e05802ead695e821ca608663439cee8de33d570`,
selfcheck `02e81891168f56f659fb31dc03ee3e8e5d6815eb80f0052c78fa5fe5bae3d02e`.
Остальные hashes совпадают с V29. Full начат 21:32:02 UTC, measurement
21:33:39.094 UTC. Итог FAIL через 3069.871 ms / 308 ACK: event-loop p95
115.081215 ms > 100, fatal 21:33:42.164, live 5000. Семь cipher probes и
initial cold cohort прошли. Actual process commands подтверждают profiler
только у owner и source maps у обоих workers. Actual scope probe подтвердил
единственный writable profile-file, UID 1000 / mode 0640, RO config и четыре
foreign denials. Profile captured: 37543 samples, 1105749 bytes, SHA-256
`a5f788c6ce2b3feb48393812e653bb49935e5175aed714d07377cce6397fba67`.
Diagnostic stop 310.988 ms, gateway exit 0; loaded shutdown не достигнут.
Cleanup 3381.952 ms verified, восемь roles/сеть/private material удалены.

Root profile analysis (`owner-cpu-profile-analysis.json`) сопоставляет monotonic
microseconds V8 с wall time через same-host `process.hrtime`/`Date.now`,
измеренный после run. Это приближённая clock mapping; clock adjustment или
suspend может влиять на attribution. Профиль охватывает startup/preflight/
measurement/stop, примерно 21:32:19.925–21:33:44.332 UTC. Только measurement
slice 21:33:39.094–42.164: 3069522 sampled microseconds, включая idle 19.322%.
`frameRecords` self time 401197 us / 13.070%; GC 7.177%, native commitCb
5.415%. Sampling time не равно CPU core time; overhead отдельно не измерен,
причинность раннего event-loop FAIL этим профилем не доказана.
`frameRecords` сканирует bytes каждого общего Buffer повторно для каждого
получателя. V31 проверит минимальную замену поиска разделителя штатным
`Buffer.indexOf` с сохранением overlapping `\n\n`, fallback 1 и повторной
проверки child input. Cache и новые wire fields не вводятся. Profiler/mount/
diagnostic stop V30 удаляются возвратом coordinator к frozen V29; обычные
gates и остальные experiment параметры сохраняются. Это гипотеза оптимизации,
не capacity PASS и не production adoption.
Независимый V30 runtime audit согласован с FAIL и profile receipt; его
приближённый alignment через container start даёт `frameRecords` около 0.407 s
self samples, близко к root 0.401 s. Самый длинный sampled timeDelta около
42.7 ms не устанавливает единичный 115 ms blocker. Actual `/proc/cmdline`
не сохранён в coordinator PID receipt; root проверил команды непосредственно
через `docker top` во время run. Worker p95 последнего scrape — 39.98 / 39.03 ms.
Полный headroom/coverage/re-auth/latency/HUP/shutdown остаётся непроверенным.

Первый V31 pair-needle `indexOf` в bounded microbenchmark оказался медленнее
и не применён. Числовой `Buffer.indexOf(10,start)` плюс проверка соседнего LF
на representative 262-byte frames быстрее: warmed alternating 10000 loops,
1 frame old 4.7–5.9 / new 3.2–3.6 ms; 25 old 117–122 / new около 72 ms;
64 old 309–340 / new 179–188 ms. Checksums, overlap, zero fallback и binary/text
cases совпали. Это измерение функции, не целого приложения; full ещё нужен.
Root уточнил actual layout через существующий `invalidationFrame` и positive
fixture: 259 bytes / пять LF (`id/event/retry/data/empty`). На нём одиночный
LF indexOf имеет лишь около 6% выигрыша для 25 frames и нестабильный результат
для 64; исходный four-LF benchmark не принят как достаточное основание.
Cached-length loop и `Uint8Array.prototype.indexOf` тоже не дали выигрыша.
Финальный V31 использует native LF search и локальный while для LF-run,
который считает все N−1 overlapping pairs. Actual layout, 6000 calls,
warmup 1000, четыре alternating rounds: mean old/new 1 frame 3.023/2.980 ms
(почти одинаково), 25 frames 70.457/44.146 ms, 64 — 177.313/111.211 ms.
Benchmark receipt включает exact old/new function source и hashes,
frame layout, timings и checksums; SHA-256
`a0c35c0c94d544fbf8163d1613ce929fdf257352bdde766d48f058633d40d604`.

V31 final existing selfcheck/min-fixture — 71 named checks PASS у tester и
root на exact финальных bytes. Проверены overlap/binary/fallback/mutation,
ParentSink record reservation/cleanup и over-budget отказ; прежний child
validation unchanged. Final independent review — PASS, actual old/new
эквивалентны на 29524 short byte combinations. Это не whole-run proof.
Original verifyPrepared: manifest
`581e55404b5434c8606206bbc4801080b448a53d21397d0d1ea136027600f30e`,
run `i12-389aacb2a3ef499f`, 209 source / 14 supporting / 38 compiled,
5000/100/1800000, nginx и gateway 2CPU/1GiB. Frozen шесть scripts:
`issue12-v31-native-frame-boundaries-full-20261013/experiment-source/native-frame-boundaries-v1`;
gateway `97990ec6e372845069466e7b9d1666a889c3edd0edee1171fd0c228acd0a4d1e`,
coordinator `2de447e4ad9309205c049f17d298f2bcf237966699cdadd99009aaf96df4d5b8`,
selfcheck `a652b6e4b9fff1342262b27c5ef21e1e34bc03b23149136c206355c2b1b09ae0`.
Full начат около 21:44 UTC, measurement 21:46:29.028 UTC. Итог FAIL через
78819.982 ms / 7883 ACK, event-loop p95 owner 117.964799 ms > 100.
Fatal 21:47:47.864, minLive result 2646 / raw fatal 2640, maxLive 5000.
Последний gateway GET 21:47:47.808: owner 117.964799, workers 43.876351 /
48.300031 ms; server connections 4053, auth-close 2393, slow-close 1 preflight.
Owner log 21:47:47.227: queues 112754 / 29381689 bytes + IPC 2486 / 651332
bytes, ниже 64 MiB cap; все reject counters и ACK errors 0. Slots 64/64,
waiters 1759/1858, oldest waits 2428/2545 ms, reservation ACK max 245.3 ms.
До fatal восстановился один client, resumed TLS, gap 8185 ms. Все 96 retry
HTTP504 rows после fatal и не используются как его причина. Last prefatal
latency diagnostic: live p95 893 ms, replay p95 6979, combined 901;
итоговый event-latency/headroom/coverage/полный re-auth не принят.
Staggered prefatal resource intervals закончились: nginx 21:47:42.051,
gateway .44.059, driver .46.070, cgroup peaks около 683/822/1256 MB,
OOM 0; это не точная непрерывная state в fatal. Cleanup 6625.226 ms verified,
восемь roles/logs, сеть и synthetic private material удалены. Независимый
provenance audit manifest/шесть scripts/four hooks/семь probes/5000 cold/три
PID/budgets/cleanup согласован с FAIL. Whole-run gain микробенчмарком не доказан.

Root проверил stage counters 21:47:42.199–47.227: coalesce/fanout 16 calls /
699.351 ms (mean 43.7); bucket delta содержит один call 100–250 ms. Lifetime
max 112.856 ms уже существовал до интервала и не является временем именно
этого нового call. Set64 pump 289 calls / 240.56 ms; sampled frame scans
157 / 2.721 ms, IPC send 334 / 81.57 ms. Это локализует длинную синхронную
операцию, но не доказывает её единственную причинность для p95 FAIL.

Первый V32 разбил fanout на максимум 64 connections за turn с SetImmediate,
одним active window и finite snapshot до 5000 refs (около 40 KiB). Он сохранял
due следующего pending window, но selection откладывал до completion.
Независимое design review выявило V32-D1: если active fanout длится дольше
следующего due, selection только после completion может объединить версии
subject до и после исходной границы. Сохранение remaining delay этого не
исправляет. Actual patched Hub regression воспроизвела RED: 70 connections,
fanout удержан 300 ms, версия одного subject принята по обе стороны due;
вместо трёх окон / шести chunks выполнены два / четыре. Command:
`node /tmp/coffee-12-cluster-min-fixture.mjs`; assertion `4 !== 6` на
замороженном patch SHA-256 `ca33b99d932fec291998830d2e216b5a1b0bd52c60cf816681ad305455fa33ca`.

Исправленный V32 закрывает 250-ms окно независимо от fanout и при accept после
due. Retained record получает числовой `windowStartSequence`, supersession
разрешён только внутри того же окна. Backlog остаётся в существующем bounded
ring; scalar watermarks и ленивое чтение закрытых окон заменяют новую очередь
payloads/descriptors. Единственный active window имеет finite connections
snapshot и fanout по 64 за turn. Eviction действительно недоставленного
selected hint использует существующий reset; уже удерживаемый active frame
не считается потерянным. Shutdown/destroy отменяют timer/immediate и очищают
состояние. Stage timing описывает chunks, не весь fanout. Design review — PASS;
окончательные source/tests и load приведены ниже. Gateway V31, TLS/FIFO, budgets/deadlines
и all gates прежние; profiler не включается. Это scratch hypothesis,
не production adoption.

Source review также выявил V32-F2: конец одного окна синхронно начинал первые
64 connections следующего; последний chunk из шести и следующий из 64
попадали в один callback. При малом числе connections backlog обрабатывался
рекурсивно без yield. Переход между окнами теперь использует общий отменяемый
`setImmediate` с pending-transition guard. Independent final source review
— PASS на patch SHA-256
`309984a87d30873ad9a6b69d02a1b6070fb25e9415af59d5dbec0bb6a82e8d09`,
coordinator `48fb13c96b8a170453e56ee0541fb3f470f91e386bb5e6f87bc72c8fb0992697`.
Generated Hub SHA-256
`17a84565cc3c8cdbb635d3e1ca5d2b1a642efd533617882cb89a3cf602addafd`.
Root подтвердил source hashes и syntax. Ранее объявленный worker hash `a0ba…`
оказался преждевременным: после сообщения продолжились правки ring scan/stage
timing, фактический hash был `a90e…`. Tester и reviewer обнаружили расхождение;
эти bytes к load не допущены. Source PASS не доказывает performance или capacity.
Final tester и root `node /tmp/coffee-12-cluster-min-fixture.mjs` — PASS:
71 прежний named check и три V32 checks. Actual Hub cases проверили exact IDs,
replay → ready → live, 8/70 connections с накопленными sealed windows и одним
chunk на callback, 130 connections (64/64/2), closed/new connection boundary,
ring eviction/reset с сохранением active selection, shutdown/destroy и нулевые
queue gauges. Selfcheck SHA-256
`1755c8f1b7008c1a900f485074184bd8b803e778fd35d8d87ec90c5e486bb788`.
Independent final source/test review — PASS. Все шесть scratch sources
зафиксированы mode0444 в `experiment-source/bounded-coalesce-fanout-v1`;
source receipt SHA-256
`7d078877a799e80d1f53680f266cbcab807e2455e5ba246fb2d379a6e55ff0b3`.
Root повторно проверил original manifest, source/native/image hashes и бюджеты.
Diagnostic full стартовал 22:17:58 UTC командой
`PATH="$(cat /tmp/coffee-12-v10-proof-bin-path):$PATH" node /tmp/coffee-12-cluster-diagnostic.mjs --prepared /home/yurgusev/.hermes/cache/scratch/issue12-v32-bounded-fanout-full-20261013 --approve-manifest dff10b88fbb32c7a265e6a63cf5b643fed158c84ad2850cd1a7288262320a250`.
Measurement начат 22:19:35.386 UTC. Итог FAIL через 79323.600 ms / 7932 ACK:
`HEADROOM_LATENCY_EXCEEDED`, kind3 — прямой gateway `/health/ready` mTLS GET,
HTTP200 за 1152.782 ms > 1000. Первое превышение записано 22:20:54.667 UTC,
fatal marker — .710; второе превышение .733 уже после marker. Result minLive
2849 / maxLive 5000, raw fatal live2848; loop max p95 75.890687 ms.

Transport helper использует `https.request(..., agent:false)`, то есть новый
TLS transport для каждого probe. Offsets первого запроса от начала: socket
13.103 ms, TCP connect 18.658, secureConnect 1056.867, headers 1152.228,
end 1152.689. Между connect и secureConnect прошло около 1038.209 ms;
после secureConnect до headers — 95.361 ms. Это локализует задержку до
завершения TLS, но не разделяет accept wait, native crypto и CPU scheduling.
Driver loop p95 16.261 / cumulative max146.014 ms не является точным stall
именно этого probe.

Последний строго prefatal owner log 22:20:54.248: connections3978,
Hub88348 records / 23021623 bytes + IPC2765 / 724313 bytes, ниже cap.
Slots64/64, waiters1683/1684, oldest wait2153/1911 ms; ACK errors0,
cancel74, lifetime max254.7 ms. Owner loop63.34, workers44.76/50.43 ms.
За 53.247–54.248 coalesce chunks177 /79.2 ms, bucket p95 upper2 ms;
Set64 pump94 /75.2 ms, p95 upper5 ms. Это времена chunks, не whole fanout
и не распределение CPU time между процессами.

До первого превышения .667 завершены 16 re-auth receipts (gap5787–7657 ms),
все `tlsSessionReused=true`. Дополнительный ready .632 / gap8977 ms получен
до превышения, receipt .673 — после него, но до fatal marker .710. Эти
разные cutoffs не объединяются. До превышения записаны 49 retry HTTP504;
143 retries и 32 success всего включают последующий finally и не являются
prefatal результатом. Последние десять shard latency rows 22:20:51.493–51.556:
live p95 962–972 ms, live max1838–1925; replay p95 около5148–5626 ms.
Итоговый latency percentile/полный re-auth/30 минут/HUP900/shutdown не приняты.

Последние завершённые до .667 ресурсные интервалы последовательны:
nginx 48.168–50.153, gateway50.153–52.163, driver52.163–54.177.
Cgroup peaks685178880/835739648/1259896832 bytes, OOM0; gateway CPU по
docker stats203.52%. Это staggered observations, не непрерывное состояние
при fatal и не прямое доказательство throttling. Gateway sumRSS1005961216
bytes может повторно учитывать общую память; cgroup peak остаётся ниже1GiB.
Independent live audit подтвердил exact manifest/шесть scripts/four hooks,
5000 уникальных cold TLS13 ChaCha клиентов, семь probes, три Node PID,
лимиты и scoped read-only mounts. Cleanup3638.766 ms verified: восемь roles,
сеть и synthetic private material удалены. `launchProof=false` сохраняется.

Original V32 prepare `issue12-v32-bounded-fanout-full-20261013` завершён без
launch. Manifest SHA-256
`dff10b88fbb32c7a265e6a63cf5b643fed158c84ad2850cd1a7288262320a250`.
Root `verifyPrepared` проверил 209 source / 14 supporting / 38 compiled hashes,
native adapter и image IDs; independent prepare audit подтвердил исходные
5000 / 100 ACK/s / 1800000 ms, 2 CPU / 1 GiB обеих целевых ролей и все limits.
Synthetic private материал предназначался только для этого согласованного run;
после FAIL удалён с verified cleanup.
Metadata audit: private root 0700, role/fixture/Kafka files 0400, private keys
0600. Nginx bundle files 0644 внутри 0755 subtree под private root 0700;
Actual launch audit подтвердил точный scoped mount; parent mode сам по себе
не является доказательством доступа внутри контейнера. Prepare не доказывает runtime
permissions или capacity; окончательные scratch source/test hashes закреплены
в указанном выше отдельном receipt, original manifest не меняется.

V33 добавляет только scratch owner sampler: existing1Hz callback запускает
не более одного async чтения, а log получает последний завершённый snapshot
с start/end/age. TCP4/TCP6 читаются до8KiB каждый, netstat до16KiB, cpu.stat/max
до4KiB (+один байт для определения truncation). FD закрываются в finally;
shutdown прекращает новые выборки и дожидается текущей. Вывод содержит только
сумму LISTEN rx_queue порта4401, namespace-wide ListenOverflows/ListenDrops и
выбранные cgroup counters/quota. Raw rows, addresses, inode и errors не выходят.
Ошибки/неподтверждённые prefix дают null, не нулевое доказательство отсутствия
очереди. `tx_queue` не называется backlog limit.

Independent review V33-F1 исправил принятие malformed/partial counters;
F2/F3 — реальный IPv6 header `remote_address` и потерю полного LISTEN-prefix
из-за обрезанного позднего established tail. Existing min-fixture воспроизвёл
RED на actual gateway `2d9f54…1f3dc`: IPv6 parser вернул `ok:false` вместо
ожидаемых count1/current4. Final source review — PASS на gateway SHA-256
`4918cb70fddcc485e45050ee5a2518f6167161403ca9982730d7ddb06d997948`;
patch V32 `309984…e8d09` неизменён. Coordinator SHA-256
`937543df5732a94ae3c9bc52f41c9c5f8696a0925596fbdaa629ceb540102390`:
изменены только две diagnostic classification labels. Root actual host parser
check подтвердил tcp4/tcp6 и TcpExt; host root-cgroup counters недоступны,
что не подменяет проверку container cgroup при запуске. Final tester/root
`node /tmp/coffee-12-cluster-min-fixture.mjs` — PASS:71 прежний named check,
3 V32 и7 V33 checks; four hooks/before-after/nonRealtimeUnchanged подтверждены.
Selfcheck SHA-256
`186bb074a25f7f7f4701882965144ed00663318fc8ede40193c752beda6dd293`.
Independent final source/test review — PASS. Six mode0444 scripts и actual
selfcheck output сохранены в `experiment-source/bounded-kernel-cpu-v1`,
source receipt SHA-256
`c2c0f2e9670b9cdaa486faab57c54215b081750af50d83c5f3016f971c7db125`.

Original V33 prepare `issue12-v33-kernel-cpu-full-20261013`, run
`i12-0a7997440ce34b1d`, manifest SHA-256
`fede2b2e59ef5fe3901ec4c8bbffe3356a9d5b9cb0c08185870b45cf5b747520`.
Root verifyPrepared и independent audit: 209 source /14 supporting /38 compiled,
native binary/images совпадают; measurement/SLO/budgets/limits/authExpiry равны
V32. Metadata private root0700, scoped role/fixture/Kafka0400, cert keys0600;
common non-secret platform.yaml0664 и nginx key copies0644 под private0700
не являются production least-privilege proof. После freeze diagnostic full
начат22:39:45 UTC:
`PATH="$(cat /tmp/coffee-12-v10-proof-bin-path):$PATH" node /tmp/coffee-12-cluster-diagnostic.mjs --prepared /home/yurgusev/.hermes/cache/scratch/issue12-v33-kernel-cpu-full-20261013 --approve-manifest fede2b2e59ef5fe3901ec4c8bbffe3356a9d5b9cb0c08185870b45cf5b747520`.
Measurement22:41:23.273 UTC, FAIL через76572.421 ms /7658 ACK,
fatal marker22:42:39.897 UTC, raw live3599 /result min3603, max5000.
Actual metrics GET39.887 UTC: owner110.034943 ms, workers44.498943/67.698687.
8 prefatal re-auth receipts, все TLS resumed, gaps4004–5133 ms; всего11 receipts
включают finally и не равны prefatal count. Полный re-auth/30min/HUP900/shutdown
не достигнут. Cleanup3671.772 ms verified, private material удалён.

Последний prefatal owner log39.225 UTC: connections4020, Hub35403 records /
9220496 bytes; kernel sample38.207–38.675 UTC занял467.734 ms, accept queue1,
drops/overflows0. Cpu usage delta1549479 us и throttling delta0 относятся к
интервалу между последовательными чтениями cpu.stat, а не точно к fatal.
Предыдущие snapshots показывают usage1899923/1813799 us и nrThrottled delta8/4,
throttled delta335392/148710 us; это не проценты wall time и не sole cause.
Steady 22:42:11–13 snapshots: usage2013254/1955845/1859246 us, nrThrottled9/10/3,
accept queue0. Примерно1Hz sampling может пропустить короткую очередь, а большая
длительность async sampler не является временем синхронного block.
Initial live audit подтвердил8 roles, exact limits/mounts/четыре compiled hooks,
one owner/two TLS PID и действительные собственные cgroup counters. Итоговый
outer `result.classification` сохранил устаревшую V31 метку: worker заменил две
из трёх labels. `clusterDiagnostic`/source receipt содержат V33; archived bytes,
manifest и measurements однозначно связывают этот run. FAIL не переписывается.
Sampler observations могут разделить гипотезы, но не доказывают sole cause;
его overhead пока не измерен. All full gates сохраняются.

V34 меняет только scratch coordinator launch gateway: вместо `--cpus2`
используются `--cpu-period10000 --cpu-quota20000`, отношение остаётся2CPU.
У других roles прежний NanoCpus path; memory, FD, TLS, window64 и all gates
сохраняются. Inspect требует NanoCpus0 /CpuPeriod10000 /CpuQuota20000 и ratio2,
receipt хранит actual period/quota. Все три result labels исправлены на V34.
Gateway/patch V33 не меняются. Это гипотеза о гранулярности quota, не доказанный
выигрыш и не production adoption. Final tester/root min-fixture — PASS:
71 прежний check /3V32 /7V33 /4V34. Проверены actual launch flags/inspect,
scoped mount построение, non-gateway path, отказ повышенной quota/cpus и
FAIL classification. Fake exec не доказывает недоступность чужих файлов;
existing real UID negative checks сохраняются. Independent final review — PASS.
Coordinator SHA-256
`9b42e8f85900e02a25ad41d1a4598df73a41eb63dc95aed94aae6b49f3979767`,
selfcheck `6f22d2fda8c2b53c7332d430b950fe8ff100937daf0baa77c0f118de5e34afad`.
Six frozen scripts/selfcheck output: `experiment-source/cfs-period-10ms-v1`,
source receipt SHA-256
`827009a6b3a5c36d8a9b10e845e2924d913e22ad3bf8c209f42d46334e03ec7c`.
Original prepare `issue12-v34-cfs-period-10ms-full-20261013`, run
`i12-5cd8a1b4d4d54c3a`, manifest
`79beaf82c94d24b3fadfa49d4f7beac089a8b7f0c9d5019f3e4171666cc4afd0`;
root verifyPrepared209/14/38/native/images — PASS,5000/100/1800000 неизменны.
Diagnostic full начат22:49:05 UTC:
`PATH="$(cat /tmp/coffee-12-v10-proof-bin-path):$PATH" node /tmp/coffee-12-cluster-diagnostic.mjs --prepared /home/yurgusev/.hermes/cache/scratch/issue12-v34-cfs-period-10ms-full-20261013 --approve-manifest 79beaf82c94d24b3fadfa49d4f7beac089a8b7f0c9d5019f3e4171666cc4afd0`.
Итог V34 — FAIL, coordinator exit1, launchProof=false:81840.970 ms /8185 ACK,
prefatal driver event-loop maximum62.128 ms, result minLive2304/max5000.
Postfatal gateway logs достигают504.889 ms и не входят в этот максимум.
Первое превышение
22:52:05.498 UTC, failure marker05.510: direct mTLS gateway ready, HTTP200,
1005.630 ms >1000. Transport offsets TCP10.587 /secure944.548 /headers1005.393 ms
от request start; это не независимые stage durations. До threshold записаны
217 complete re-auth receipts, все resumed, gap3742–11183 ms;116 retryHTTP504.
Totals221success/166retry включают события после отказа и не являются prefatal.
Последний prefatal kernel sample завершён22:52:04.247 UTC: acceptQueue142,
namespace drops/overflows0, cpuUsage delta2126000 us за~1058 ms,
nrThrottled delta91 /throttledUsec786785. Max queue217 в154 complete prefatal
samples. Throttled time агрегируется и не является процентом wall time;
примерно1Hz sampling не устанавливает sole cause или точный peak между samples.
Actual inspect: NanoCpus0/CpuQuota20000/CpuPeriod10000; own cgroup cpu.max
`20000 10000`. Все8 roles, memory/FD/scoped mounts,3Node PID/2nginx workers,
четыре compiled hooks и7authorized/5000unique cold TLS1.3ChaCha receipts
подтверждены audit. OOM0. Cleanup3563.069 ms verified: все8ownedcontainers,
network и synthetic private material удалены. 30min/HUP/fullrecovery/loaded
shutdown не достигнуты; более короткий period не принят в production.

V35 меняет только scratch gateway `nowSeconds`: Temporal polyfill заменён
на `Math.floor(Date.now()/1000)` с чтением при каждом вызове, unused import
удалён. Caller — actual Hub validateActor; full signed actor verification,
TTL/skew, отдельный auth timer каждого connection, queue64 и CFS20k/10k прежние.
Установленный polyfill сам получает wall clock через Date.now и выполняет JSBI
преобразование nanoseconds. Function-only microbenchmark после cleanup V34:
4alternating rounds по5000 calls после1000warmup, original42.119–59.484 ms,
candidate0.419–0.503 ms; observed seconds совпали. Артефакт
`issue12-v34-cfs-period-10ms-full-20261013/actor-clock-microbenchmark.json`.
Это не выигрыш full run. Actual-source tests проверили fresh clock/floor,
конечный rollback, exp/iat skew boundaries; native clock предполагается конечным.
Дополнительная NaN-защита не заявляется. Tester/root/independent review — PASS:
71 прежний check /3V32 /7V33 /4V34 /3V35.
Gateway SHA `37d01d5aa01c21e44fe480050661aef5ee8ed56822c00904e117d833385cdd2a`,
coordinator `5752adaf148fee0978d5e60f9601141e6377a1ba76e2f0ad9813014ceb7e3c3c`,
selfcheck `b4d293c85cf1aeabfad3d6ab8e3cdef7b34ddb787bf430e269e4249dd9886ada`;
patch309984 unchanged. Все три labels V35. Six-source archive
`experiment-source/native-actor-clock-v1`, receipt
`b489a2f9524eb22a157f9d7c42937265b88185e14445c13e8073e48d7a4e43e6`.
Original prepare `issue12-v35-native-actor-clock-full-20261013`, manifest run
`i12-3e5c9c94720f43a8`, SHA
`a2f186d605c1be463238910ef8fd8edfaeb071a16095b96db001f870659102f9`;
root verifyPrepared209/14/38/native/images — PASS. Diagnostic full начат
23:02:03 UTC,5000clients/100ACKs/1800000ms неизменны:
`PATH="$(cat /tmp/coffee-12-v10-proof-bin-path):$PATH" node /tmp/coffee-12-cluster-diagnostic.mjs --prepared /home/yurgusev/.hermes/cache/scratch/issue12-v35-native-actor-clock-full-20261013 --approve-manifest a2f186d605c1be463238910ef8fd8edfaeb071a16095b96db001f870659102f9`.
Итог V35 — FAIL, coordinator exit1, launchProof=false:83284.975 ms /8316 ACK,
REAUTH_RECOVERY_TIMEOUT. First marker23:05:01.755 UTC; rawlive2047,
resultmin2116/max5000 — result summary пропускает более низкий failure sample,
исходный FAIL не переписывается. Prefatal driver loopmaximum92.799 ms; последний
metrics01.609: owner77.726/workers83.296/92.799 ms. До marker126 completed
re-auth receipts, все resumed, gapsmin/median/p95/max3483/7518/11541/12782 ms,
prefatal retries0. One success после marker (total127). Kind1HTTP404/1383.805 ms
и kind3directGWHTTP200/2189.786,2127.083 ms в03.069/03.828 — postfatal,
не trigger. Последний completed kernel snapshot ended01.087: queue63,
quota20k/period10k, drops/overflows0, usage1.480CPU-s за1.337s между completed
reads, nrThrottleddelta11/throttled34112us. Maxqueue65 по155prefatal snapshots;
эти counters не устанавливают stage незавершившегося re-auth. Latest owner
queue~100203records/26.06MB, IPC2167/567KB, ниже configured caps; ACKerrors0.
Real8roles/scopedROmounts/exactlimits,3NodePID/4compiledhooks/6sourcehashes,
7authorizedprobes/5000unique coldTLS1.3ChaCha и5000/5001admission подтверждены.
Отдельного live UID-negative receipt в этом full нет; ранее выполненные
security tests не подменяются проверкой mount topology. OOM0; prefatal host
GW RSS1036181504bytes/cgroup866037760,FDmax2541/sum5098. Async intervals
не синхронны, sumRSS включает shared memory. Cleanup3515.515 ms verified,
all8ownedcontainers/network/private material removed. Production clock прежний.

V36 candidate ограничен two technical Hub timestamps: stream-ready.connectedAt
и heartbeat, `Temporal.Now.instant().toString()` → `new Date().toISOString()`.
Timestamp schema допускает миллисекунды, heartbeat spec требует RFC3339;
frontend приводит дату к epoch milliseconds. Business timestamps, fields,
timer cadence, auth, replay и budgets не меняются. Function-only5000calls,
4alternating rounds после1000warmup: original174.525–215.548ms,
native5.909–6.319ms, артефакт `issue12-v35-native-actor-clock-full-20261013/sse-clock-microbenchmark.json`.
Это только стоимость formatting; load gain не доказан. Scope/contract review
подтвердил допустимость представления. Final tester/root min-fixture и
independent review — PASS:71 прежний check /3V32 /7V33 /4V34 /3V35 /3V36.
Actual patch-produced Hub ready/heartbeat прошли существующий generated-schema
wireValidator/Ajv/SseDecoder; finite parse и timer configuration сохранены.
Этот тест не подтверждает cadence под нагрузкой. Gateway37d0 unchanged;
patch `472a9740c3cee8b5b454559436948b1422bdcb90a83b11500a09ecbde6b62a5a`,
coordinator `233767d3e754f5821ac8e1c752072ae634c2bccd4326b04080dc258f5b690da5`,
selfcheck `2379d34f6495c2e6e1b2dfc1a98f331929346d3139154ae345d2a94c57708985`.
Six-source archive `experiment-source/native-sse-clock-v1`, receipt
`1546862ab06efe53403bb61377604b151070670ee3e92778dc1b68e0743cf316`.
Original prepare `issue12-v36-native-sse-clock-full-20261013`, manifest run
`i12-de78c0eebd254d5b`, SHA
`1e4ac4b21fce883ddd5850479a8389fc36f4fef59780a28eef3bb16f2564a3b2`;
root verifyPrepared209/14/38/native/images — PASS. Diagnostic full начат
23:11:46 UTC,5000/100/1800000 unchanged:
`PATH="$(cat /tmp/coffee-12-v10-proof-bin-path):$PATH" node /tmp/coffee-12-cluster-diagnostic.mjs --prepared /home/yurgusev/.hermes/cache/scratch/issue12-v36-native-sse-clock-full-20261013 --approve-manifest 1e4ac4b21fce883ddd5850479a8389fc36f4fef59780a28eef3bb16f2564a3b2`.
Итог V36 — FAIL, exit1, launchProof=false:80061.948ms/8007ACK, firstthreshold
23:14:42.600UTC directGWkind3HTTP200/1141.923ms>1000. Transport offsets
connect42.638/secure1099.295/headers1141.627ms от requeststart, не отдельные
stage durations. Marker42.628rawlive2647; resultmin2644/max5000. Следующий
slowprobe42.634 postmarker. Prefatal driver loopmaximum65.667ms; последний
GET41.430 owner65.667/workers50.790/63.963ms. До threshold59complete reauth,
allresumed/gapsminmedianp95max4952/7690/7946/9017ms;68retryHTTP504.
Totals73success/113retry включаютpostcutoff14/45 и не являются prefatal.
151strictcompletekernelrows allstatusok, maxqueue221/drops/overflows0.
Последний snapshot captured42.187/sampleended42.464: CPUdelta2.294CPU-s
за~1.182s между completedreads, nrThrottleddelta100/throttled679016us,
quota20k/period10k. Это агрегированные примерно1Hz observations, не доказательство
единственной причины. Ownerqueue91681records/23.89MB+IPC2705/708710bytes,
belowcaps; callbacks40/64 waiting5.25/13.38ms, drainwait0 в этом snapshot.
PrefatalGWmaxRSS1001127936/cgroup829804544, FDmax2555/sum5098, OOM0;
последний resource interval ended39.114,~3.5s до threshold, это не peak finalseconds.
All6frozenhashes/4actualcompiledhooks (Hub56c97a…0b0eb1)/3PID/8roles/exactcaps/
scopedROmounts,7authorizedprobes/5000uniquecoldTLS1.3ChaCha/admission5000/5001
подтверждены audit. Full UID-negative receipt отсутствует, existing auth/unit
negative tests остаются отдельным evidence. Cleanup3794.539msverified:
all8ownedcontainers/network/syntheticprivate removed. 30min/HUP/fullrecovery/
loadedshutdown не достигнуты. Product source не изменяется.

Read-only V35 pipeline map: recovery deadline13s включает reconnect3s,
accept/TLS/auth/OPEN, replay перед ready, decodedstream-ready; OPEN_ACK ещё не
подтверждает ready. BothTLSlegs resumed:126publicclientreceipts; upstreamworker
counters3329/3463 и3378/3495 resumed, unknown0. Upstream TLS histogram p95≤100ms,
max688ms; эти successful intervals не показывают задержанную попытку.
Perrequest actor/OPEN/replay/readyphase timestamps не записаны. ParentSink
заново считает разделители каждого Buffer, хотя Hub reuse-ит live Buffer и
IPC группирует его по identity. V35 stage sampled1/64:9641framecountcalls/
sum131.3ms/max8.05ms при~616476writeStarts; ×64≈8.4s является оценкой work,
не доказанным CPU attribution или причиной13s timeout.
Generic identity cache отвергнут: existing regression требует пересчёта mutable
Buffer. Native regexp черезlatin1/overlappinglookahead тоже отвергнут: actual
6000calls25/64records в4alternatingrounds медленнее текущего nativeLFscan
примерно2–4x, при1023LF/binarycombinationequal. Артефакт
`issue12-v36-native-sse-clock-full-20261013/frame-regexp-microbenchmark.json`.
V37 передаёт известный batch.length исключительно от actualHub через optional
ParentSink.writeBatch(Buffer, integer1..64, callback), сохраняя обычный sink.write
fallback. Every actualHub Frame содержит одну SSE record: templates либо JSON,
internal JSON newlines escaped. Count не приходит из HTTP/IPC. Genericwrite
сохраняет свежий frameRecords scan, включая mutableBuffer; cache не добавлен.
Оба entrypoint используют прежний state guard и один private reserve/pending
path; actualbytes, doubleIPC accounting, shareddeadline/ACK/drain/release прежние.
Validation диапазона count не доказывает соответствие Buffer: безопасность
основана на закрытом trustedHub caller, её нельзя переносить на network inputs.
Final source/test review, tester/root min-fixture — PASS. Actualcontrol/live/replay
counts/doubleIPC budget, malformedtype/count безreserve, exactACKrelease/lateACK
и genericmutableBuffer проверены. First selfcheck остановился на oldspy769:
он слушал толькоwrite, Hub выбираетwriteBatch. Пять instrumentation spies
(capacitywait/window/competitor/abort/terminal) теперь слушаютобаentrypoint;
все прежние assertions/deadlines сохранены. Это test instrumentation mismatch,
не flaky runtime. Все71старыхименованныхchecks сохранены, плюс3V32/7V33/4V34/
3V35/3V36/3V37. Gateway
`a4d3123093d065cf4b55760b6f09218ca7c35d45aee309f0e3cc49315744dd67`, patch
`26bfbc5f001e81becb01a421ca814bb35e929aa85c0ee19451da718a3e565dc6`, coordinator
`25e1248a3b22f195c3fe0bb5fbe1e811aa2e55b56d746348cedb54bb58607e06`,0444/syntaxPASS.
Microbenchmark actualParentSink methods with fake noopreserve/release/syncACK,
4alternating rounds по5000calls после1000warmup:25records generic20.278–24.542ms,
trusted1.730–4.682ms;64records generic32.570–47.434ms/trusted0.901–1.103ms.
Это не IPC/TLS/Hub/fullrun gain; артефакт
`issue12-v37-trusted-batch-records-full-20261013/parent-batch-count-microbenchmark.json`.
OriginalprepareV37manifest
`5ada6559ca66fae428f85e35711faad155c15adf14d9fb41c3e3328a75b60d69`, run
`i12-cea9cd8ae2e64735`; root verifyPrepared209/14/38/native/images — PASS.
Selfcheck SHA `9a31a8b221b6dc458c47fb98490b52795e1117c354bc5034cbb69e9b1a1706da`.
Six-source archive `experiment-source/trusted-batch-records-v1`, receipt
`4d81cf08381f535df2bdbf5d53cc34b7c4fa7dffa867ac6dc652a083144bcf1c`.
Diagnostic full начат23:26:40UTC,5000/100/1800000 unchanged:
`PATH="$(cat /tmp/coffee-12-v10-proof-bin-path):$PATH" node /tmp/coffee-12-cluster-diagnostic.mjs --prepared /home/yurgusev/.hermes/cache/scratch/issue12-v37-trusted-batch-records-full-20261013 --approve-manifest 5ada6559ca66fae428f85e35711faad155c15adf14d9fb41c3e3328a75b60d69`.
Итог V37 — FAIL, exit1, launchProof=false:76345.542ms/7635ACK. Первый порог
23:29:35.136UTC: kind3 directgateway HTTP200 за1224.339488ms при1000ms gate.
Secureoffset1176.367ms и headersoffset1224.051ms измеряются от начала request,
не являются самостоятельными длительностями TLS/HTTP. Marker35.436UTC,
rawlive3408; resultmin3409/max5000. Prefatal driver all-processloop max54.067199ms;
последний strictGET33.899UTC: owner54.067/workers51.249/48.431ms.
Последний complete prefatal kernel row34.356UTC содержит snapshot33.333–33.565:
acceptqueue128, drops/overflows0, статусыok, quota20000/period10000,
CPUusage delta1.854s, nrThrottle28/throttled114565us. Все148 strictrows имеют
complete statuses; maxqueue128. Счётчики с редким sampling не доказывают причину
задержки конкретного запроса. Последние strictTLS rows35.003/35.060UTC:
errors/missingStart6/10, mapOverflow0, acceptToError.count0, pending2/2;
sampledsecure maxima≤167.216ms. Они начинаются после accept и не сопоставлены
с failing cold headroom request, поэтому не исключают его TLS/queue задержку.
На34.001/34.060UTC почти все secure используют ChaCha, AES только два fallback
probes; missingStart/errors ещё0. LIFETIME stageMetrics не являются fatalwindow:
coalesce22397/max39.31ms, pump19424/max26.19ms, encode1/64max2.98ms,
sink_buffer_frame_recordsmax4.02ms, syncworkersendmax18.71ms.
Последняя очередь85661records/22352112B+IPC2745/719190B, active64+64,
rejects0 и prefatalchildACKerrors0. Один complete prefatalreauth, resumed,
gap4849ms; восемь prefatalretry504. Totals7success/261retry включают POSTfatal
шестьsuccess/253retry, не доказательство полного recovery. ProtocolFrames0,
coverage0/eventLatencynull; 30min/HUP900/loadedshutdown не достигнуты.
Strict host samples: GWmaxRSS999243776/cgroup828051456, FDmax2554/sum5098,
OOM0; последний GWinterval заканчивается34.110UTC. Samples разных roles
staggered и не охватывают весь интервал запроса. Все6frozenhash/manifest/receipt,
четыре ACTUAL compiledhooks,3PID/8roles/aggregate2CPU1GiB/scopedROmounts,
7TLSprobes и5000uniqueauthorizedcoldTLS13ChaCha PASS;5000/5001 admission PASS.
Отдельного actualUID-negative receipt в этом full нет; прежние отрицательные
проверки учитываются независимо. Cleanup3333.202msVERIFIED:8roles/network/private
удалены, actualownednetwork `i12-a8743aa7cf534771-net`; manifestrunId выше иной,
поскольку имя network создаётся до присваивания preparedrunId. Product source
прежний; уменьшение внутреннего scan не обеспечило acceptance.

Следующий диагностический шаг V38 — CPU profiles только двух TLS workers,
без profiler у Kafka owner. Переиспользуется CLI/capture из V30, два точных
writable nonsecret file binds, все app/config/scopedsecret mounts RO. В scratch
меняются gateway/patch/coordinator и существующий selfcheck; budgets/gates,
SSE/HTTP/IPC wire, actor signature validation и production source прежние.
Sampling2000µs работает до выхода; короткое окно и строгий лимит размера записи
CLI не обеспечивает. Guard32MiB перед чтением защищает parser, не запись.
Профили забираются после driver result/stopObservers и bounded graceful stop,
до cleanup; их отсутствие/forced exit не заменяют исходный результат.
Файлы связываются с actual workerPID и whitelist profiler flags, остальные
execArgv не публикуются. Overhead не измерен; это не capacity/performance proof.
Согласно [pinned Node CLI](https://nodejs.org/download/release/v26.8.1/docs/api/cli.html#--cpu-prof),
профиль записывается перед выходом; [cluster execArgv](https://nodejs.org/download/release/v26.8.1/docs/api/cluster.html#clustersettings)
позволяет задать эти flags только workers. Source/tests/review до full обязательны.
Дополнительный read-only разбор10driver profiles V13: ulidTime inclusive sampled
time2.812s/300.005s aggregatebaseline10–40s (0.94%all/4.05%non-idle) и
0.973s/99.988s в последних10s до первогоheadroomthreshold (0.97%all/2.59%non-idle).
Это сумма profiler timeDeltas, не измеренные CPU-seconds; alignment по activeWallMs
markers имеет погрешность sampling5ms и control offsets. Timestamp cache не
добавляется: его вклад мал, hitrate не измерен, existingrawcache64 уже убрал
повторный JSONparse при сохранении eachframevalidation. Диагностика gateway
не подменяется профилями клиента.

V38 source review root-F1: при mismatch process receipt ранее assigned workerProof
сохранялся после catch и мог обозначить старыйPID как captured. Catch теперь
очищает объект; tester добавляет wronggeneration/container/manifest/malformedroles
negative cases. Source intermediate coordinator `a8172fb6…143d2530` не запускался.
Текущий coordinator `a3270c4c6a32442f0a31969b69c404437aeffe34f8cb1ad3f5289e1d7af2a088`,
gateway `0b4b459dd02dc37e072991925ca81e54d46002dd5288f55f1c83197521c20f8f`,
patch `21a448a778d6e9af33d4969a2195c398ba6e6dfde2b1484babdc8431a8306d17`.
Normal full prepare23:42UTC/verifyPrepared23:43UTC — PASS:209sources/14supporting/
38compiled/native/images. Manifest
`c69937d301ad239127b154425147f3ad2e3b62f54d062e1db1b9f9f14e6e2964`, run
`i12-c5cb1ccad3bb4584`, budgets2CPU1GiB/5000/100/1800000 прежние.
Independent source/finaltest review и tester/root min-fixture — PASS: все94старых
checks сохранены и3V38добавлены. Selfcheck
`30d23b42f727cc12e81b6fd80b9341dc33ea9929f5104fb4bd5747ce4601a652`.
Actual-function VM покрывает workerargv/ownerflags, mounts/UID/write/deniedread
probes, capture success/wronggeneration/container/manifest/malformedroles/137/OOM/
empty/oversize/invalidJSON/stopfailure; originalFAIL сохраняется. Это mockreceipts,
не actualDocker/profilefiles. Observer→capture→cleanup order проверен статически.
Six-source archive `experiment-source/tls-worker-cpu-profile-v1`, receipt
`4c7ff736afcbb8e42f0abdd624cefd5c3f928f1b3cc4dd788e8e812fc18172f2`.
Diagnostic full начат23:49:18UTC:
`PATH="$(cat /tmp/coffee-12-v10-proof-bin-path):$PATH" node /tmp/coffee-12-cluster-diagnostic.mjs --prepared /home/yurgusev/.hermes/cache/scratch/issue12-v38-tls-worker-cpu-profile-full-20261013 --approve-manifest c69937d301ad239127b154425147f3ad2e3b62f54d062e1db1b9f9f14e6e2964`.
Итог V38 — FAIL, exit1, launchProof=false. `driver-result.json`:78339.028ms/
7835ACK, minLive3022/max5000, all-processloop max55.574527ms. Первый известный
headroom threshold23:52:14.204UTC: kind3 directgateway HTTP200 за1131.843396ms;
secureoffset1044.591ms/headers1131.588ms от начала request, не самостоятельные
TLS/HTTP duration. Marker14.226UTC. Отдельный `result.json` содержит
ERR_ASSERTION: summed gateway process RSS1084747776B >1073741824B;
durationMs0/ACK0/driverExitnull, поскольку observer exception прервал присваивание
driver result. Эти две ветки результата не объединяются. Observer receipt не
содержит timestamp, mtime23:52:16.066UTC — только bound записи артефакта;
порядок RSS crossing и headroom threshold не установлен. Последний host sample
23:52:07.962UTC: GWcgroup current877785088/peak878534656B; OOM counters0.
Summed RSS включает shared pages; обязательный RSS gate всё равно не пройден.
Strict cutoff по23:52:14.204UTC:13complete reauth, все resumed, gapmax7713ms/
p957615ms;303retryHTTP504. Wholefile16success/407retry включает POSTcutoff3/104.
Последний strict gatewaymetrics23:52:13.058UTC: queue70846records/18500275B,
IPCpending3182/833684B; prefatal maxqueue84693/22167166B, IPC3210/838780B.
Admission/reservation/capacity/ACK/worker/write-state/frame-size reject counters0.
Driver cohort уже уменьшился: live5000 до23:52:06.001UTC, live4820 на07.103 и
3901 на10.888; rawlive3022 на14.226 уже POSTmarker. Причина shrink и порядок
относительно RSS crossing не установлены. Lastcompletehost GWmeasurement
23:52:09.942–11.950UTC (rowat07.962): summedRSS1050103808B, cgroup выше.

Kernel diagnostics находятся во вложенном поле153ownerlog rows. Предыдущий
audit вывод «counters отсутствуют» неверен и исправлен. Strict event+sample
cutoff даёт150complete rows, statusesok/maxqueue229/dropsoverflows0. Latest
event23:52:13.517UTC, snapshot12.517–12.617UTC: queue229, quota20k/10k,
CPUusage delta1914606µs, nrThrottle63/throttled301505µs, cumulative5810/
60811128µs. Row logged14.520UTC уже POSTthreshold, хотя его sample13.517–
13.594UTC завершился раньше: queue227/delta1584976µs/29/102085µs. Эти строки
не объединяются. Cgroup throttling counts/deltas не измеряют единственную
причину headroom задержки и не являются wall-time процентом.

Actual process/mount/profile receipts независимо проверены: owner nsPID7 и
workers45/46 связаны с frozen manifest/gateway; owner без profiler flags/file.
Gateway имеет quota20000/period10000=2CPU, memory.max1GiB/nofile12288,
UID1000, ROconfig/root/scoped mounts и ровно два writable diagnostic file binds.
ActualUID probes подтвердили допустимые чтения/записи и отрицательные reads.
Все5000 initial authorized cold TLS13ChaCha receipts и7cipherprobes HTTP200,
5000/5001pre-header typed503 admission — PASS. Обе worker profiles записались
после gateway cleanexit0/OOMfalse: worker1 1405978B/63641samples, SHA
`779e6ad854c074f4484f2405c01dc3ef2871ec1b6f4bb1137bf2720b201ab013`;
worker2 1427371B/63299samples, SHA
`8b7d8fcf40cfa61a844094188c3e31ab54f5d3c96a502c909370ca17c8bd1791`.
UID1000/mode0640. Stop23:52:16.126UTC/427.245ms, captures16.602/.626UTC.
Receipt `capturedAfterDriverResult=false` из-за отсутствующего driverExit в parent
result; capture после stopObservers не доказывает loaded shutdown acceptance.
Cleanup3819.950ms VERIFIED, all8roles/network/private material удалены.
30min/fullrecovery/HUP900/loadedshutdown не достигнуты; production source прежний.

Read-only profile analysis: `cpu-profile-analysis.json` и два clock-alignment
receipts в V38 directory. Pinned Node CLI использует local inspector Profiler.stop
([Node source](https://raw.githubusercontent.com/nodejs/node/v26.8.1/src/inspector_profiler.cc));
его JSON содержит double start/endTime и successive sample timestamp deltas
([V8 inspector](https://raw.githubusercontent.com/nodejs/node/v26.8.1/deps/v8/src/inspector/v8-profiler-agent-impl.cc)),
Linux TimeTicks использует CLOCK_MONOTONIC+1µs
([V8 time](https://raw.githubusercontent.com/nodejs/node/v26.8.1/deps/v8/src/base/platform/time.cc)).
Same-host hrtime/Date.now brackets4.239/3.548µs, offset change0.915ms;
wall precision и sampling2000µs остаются. Profile UTC ranges23:49:35.974–
23:52:16.197 и23:49:35.976–23:52:16.202; они включают POSTheadroom samples.
Baseline23:51:05.886–35.886: aggregate60000sampled-ms, idle16.11%;
native writev self28491.141ms=47.49%all/56.61%non-idle, connectionCorkNT
inclusive56.47%, GC2.68%all. Последние10s до известного headroom threshold:
writev self32.67%all/39.24%non-idle, idle16.74%, GC2.67%all,
TLSSocket.getPeerCertificate self2.11%all. Это sampled wall time, не CPU-seconds;
descheduling/profiler cost и encryption/copy/syscalls отдельно не измерены.
Последнее окно нельзя назвать prefatal относительно untimestamped RSS crossing.
Следующий шаг — read-only проверка actual HTTP/SSE write path и стандартного
способа сократить overhead без изменения wire/backpressure/security.

### Следующее направление после V38: private HTTP framing (разрешённый эксперимент)

Read-only map pinned Node26.8.1: actual `writeChildFrame` уже делает один
ServerResponse.write(Buffer,callback). Chunked path создаёт length/CRLF/payload/
CRLF, socket cork/uncork приводит к nativewritev; TLSWrap при нескольких
nonempty buffers выделяет backingstore и копирует segments перед SSL_write.
Источники: [HTTP outgoing](https://github.com/nodejs/node/blob/v26.8.1/lib/_http_outgoing.js#L937-L953),
[TLSWrap](https://github.com/nodejs/node/blob/v26.8.1/src/crypto/crypto_tls.cc#L1054-L1080).
Explicit ServerResponse.cork сохраняет framing; короткая проверка этого пути
может опровергнуть пользу без изменения wire. Сам профиль не разделяет стоимость
copy/encryption/syscalls, выигрыш не измерен.
Bounded actualmTLS probe на Node26.8.1, existing realtimeFixture/Hub: два SSE
соединения, ready+одна invalidation, elapsed342ms; `node --check
/tmp/coffee-12-cork-tls-probe.mjs` и `node --test
/tmp/coffee-12-cork-tls-probe.mjs` —1/1 PASS,0fail/skip. Для каждой группы
полученное клиентом body побайтно равно captured ServerResponse.write buffers;
invalidation frame одинаков, ready timestamps/length406/407B различаются ожидаемо.
Callback2/2/errors0; falsewrite0/drain0, blockeddrain не проверен. Plain TLS
input _write0/_writev2/8vectors/693B; explicitcork _write1/_writev2/7vectors/694B.
Это plaintext HTTP input перед TLSWrap, включая headers/chunkframing, НЕciphertext
и НЕCPU/throughput measurement. Initial ошибочная подпись ciphertext исправлена
по root/reviewer V38-DOC-2; сырые buffers в receipt отсутствуют. Данный маленький
сценарий не показывает сокращения числаwritev и не исключает иных нагрузочных
эффектов. Архив `experiment-source/http-cork-probe-v1`, scriptSHA
`3c164457baf09e6e14e15d7d49aa499ac2e620ab993c137ab8b8b02e4d282cfb`, receiptSHA
`818fe9bbd457c2b6e93dcb51cd4951de398810b72cfceb6f699dca482bc4de15`.
Hostnativeperf probe `perf stat -e task-clock -- true` отвергнут kernel policy
perf_event_paranoid4/exit255; nativecost не разделён. Host policy не менялась.

13.10.2026 пользователь явно разрешил следующий ограниченный эксперимент.
Реализуется только диагностический вариант private GET/events ответа gateway→
nginx: до writeHead вызвать стандартный removeHeader('Transfer-Encoding'),
поставить Connection:close; тело ограничивается закрытием TLS connection вместо
chunked terminal. SSE bytes/IDs/ready/reset/retry и public nginx response должны
остаться прежними и будут проверены, а не приняты на веру. PublicServerResponse
write/callback/drain сохраняются; directsocketwrite/manualHTTPserialization нет.
Это отдельно разрешённое изменение внутреннего HTTP wire format в scratch.
Production spec§4 всё ещё требует keep-alive, §7 описывает chunked; adoption
не разрешена. Одного разрешения двух TLS workers было недостаточно для этого шага.

Риск конкретный: [RFC9112§6.3](https://www.rfc-editor.org/rfc/rfc9112.html#section-6.3)
разрешает close-delimited response, но EOF не отличает полное тело от обрыва;
стандарт предпочитает length/encoding delimiter. Pinned nginx nonbuffered loop
при EOF/length=-1 завершает response успешно
([upstream source](https://github.com/nginx/nginx/blob/0a5db852e18d1c22c62a5ede1412ac3f416111a0/src/http/ngx_http_upstream.c#L3722-L3738)).
Поэтому obligatory проверяются EOF внутри UTF-8/JSON/SSE frame без продвижения
cursor, recovery последнего подтверждённого hint, partial-frame rejection,
last valid cursor,
replay/reset после abrupt close, causal auth expiry/re-auth, graceful reset→EOF,
отсутствие лишних disconnects и сохранение публичных HTTP headers/body framing.
Нельзя засчитать отсутствие HTTP truncation error как успешный recovery.
Actualnginx public response обязан сохранить исходные headers/framing без
Content-Length и без утечки upstream Connection:close. Нужны actualmTLS/nginx
callback+drain/slow-reader-timeout/reset→server-close checks; два коротких writes
не заменяют эти проверки. Auth/admission/readiness error responses прежние,
framing change относится исключительно к successfulprivateSSEresponse.

Границы: restore V37 scratch без worker profiler/file mounts, заменить только
successfulprivateSSEheaders; сохраняются exactly2TLS+1Kafkaowner,2CPU1GiB,
5000/5001/100ACK/s/30min, TTL/skew/mTLS/signatures, queues/ACK/deadlines/security.
Код продукта/schema/config/pins/immutable roots прежние. До full выполняются
существующие selfchecks и bounded actualmTLS/nginx proof, independent review;
при реальном сокращении vectors без protocol regression — frozen full run.
При FAIL вариант не принимается в production. Перед production adoption всё
равно требуется отдельное проверяемое решение и normal acceptance PASS.
Source/test writers разделены: gateway/patch/coordinator и существующий selfcheck;
root проверяет public/private nginx proof и обновляет документы. Все94V37checks
сохраняются; только удалённые V38 profiler-specific paths/tests остаются в архиве.

V39 source review подтвердил, что единственная новая поведенческая правка
находится после validation/auth и accepted OPEN_ACK. Успешный private `/events`
вызывает `removeHeader('Transfer-Encoding')` и `writeHead` с `Connection: close`.
Error/readiness ветки, ACTIVATE, write callbacks/drain и lifecycle прежние.
Gateway template побайтово совпадает с V37; V38 profiler и writable mounts удалены.
Это source proof, а публичный nginx response и EOF recovery проверяются отдельно.
Frozen source SHA-256: gateway
`a4d3123093d065cf4b55760b6f09218ca7c35d45aee309f0e3cc49315744dd67`, patch
`7b4f64fcb6a053e483d75fd30c1a4e5e9203d570b227df67b35c5bcd03ea9bd1`, coordinator
`f8e563ab5a72c31fbbde2666892f5e8cf21043313075ddaaa43da5de58a85d52`.

Prepare V39 завершился exit0; отдельный `verifyPrepared` подтвердил 209 sources,
38 compiled JS, 14 supporting sources, native adapter и image IDs. Каталог:
`issue12-v39-private-http-framing-full-20261013`; manifest SHA-256
`74c1b852b5f0bae4b09f1ed9d99a4dcb64cb9b5123b39925ad0732f3185e9682`.
Измерение остаётся 5000/100 ACK/s/1800000ms; nginx и gateway по2CPU/1GiB.
Подготовка не запускает capacity proof; full ждёт bounded runtime checks.

Встроенные `_http_outgoing` и `_http_server` фактического Node26.8.1 проверены
через `process.binding('natives')`: SHA-256 соответственно
`bd4c2a684f16af6c50e663406d0be5f8120b05a34727af58e86ed9e4e78ff816` и
`5804af976bfd58b6ac3c0676afaefe29e1230dd77966053ec84a3b451bdd1f9d`.
`removeHeader` до `writeHead` помечает TE удалённым; текущий маршрут не задаёт
CL и начинает body через `write(Buffer)`, поэтому автоматические TE/CL не
добавляются. `Connection: close` устанавливает штатный EOF-delimited конец.
Chunked write отдавал length/CRLF/body/CRLF; новый путь отдаёт body без этих
framing частей. Это logical outgoing writes, не число syscalls/TLS records.
Boolean backpressure, callback, drain и finish проходят stock Node путь;
callback теперь привязан к body вместо завершающего CRLF. Временные эффекты
и фактическое public framing требуют отдельных runtime receipts.

V39 min-fixture прошёл отдельно у tester и root: four-file receipt, hashes,
nonRealtimeUnchanged и selfcheck PASS/exit0. Сохранены все94V37namedchecks,
добавлены2V39checks: фактический transformed worker route в VM проверяет
401/503 до hijack без изменения headers и успешный removeTE перед writeHead;
actual Hub+decoder проверяет partial JSON/UTF-8 без emission/продвижения cursor,
replay следующего complete hint до ready и stale reset до ready.
Selfcheck SHA-256 `2218ef7369577a3dbbc008e830341d51825e9e93b8b478ef17947d6c79485e8d`.
Архив6readonlyscripts `experiment-source/private-http-framing-v1`; receipt SHA-256
`9471bb5a16d37d490eafe88be764405fb7947950ab12b58e5ce2d418f133c5bb`.
Actual emitted gateway SHA-256
`48904aaa8e325b74d05b016c07d239e4f5cff6a6b2bb49c578d053f6b3cd2aff`.
VM/unit проверки не доказывают фактический abrupt upstream EOF через nginx.

Первый V39 mTLS probe — 1/1 PASS,0skip: существующий single-process fixture
получает exact success-header statement из actual compiled worker; cluster
composition не исполняется. Три actual Hub writes на каждом из двух initial
streams дошли побайтово до клиента, callbacks3/3 без ошибок; общий invalidation
frame совпадает. Ready bodies660/661B отличаются своими connection/clock values.
Baseline: TLS `_write`0/`_writev`3/12vectors/954plaintextB; V39: `_write`2/
`_writev`1/2vectors/902plaintextB. Эти байты включают HTTP headers/framing до
TLSWrap, не ciphertext или measured CPU. Error auth403 и admission503 прежние,
реальный replay/reset до ready и graceful finish→socketclose проверены.
False writes0/drain0: blocked drain не проверен этим первым сценарием.
Архив `experiment-source/http-framing-probe-v1`: script SHA-256
`e32133fc8a41f71bc3b3b7b262edca30ef438b8a225beefc625cf6d81482219b`, receipt SHA-256
`8fe5806bf2601e14bce3e0e4fc88fc9625f83d8ddbe1e5c31e028bc0672ff682`.
Отдельно продолжаются real writable backpressure и actual network EOF checks.

Actual V39 cluster→nginx bounded proof завершился `owner-browser-proof-only`:
`v39-proof-92d3fe71e0274a90/v39-framing-proof.json`, SHA-256
`a7e765d9572827a49431f346b7668b3140f47c660ac707db3291a09d38814282`.
Клиент явно запрашивал keep-alive: public200/Connectionkeep-alive/TEchunked/noCL;
direct private mTLS с тем же запросом получил200/Connectionclose/noTE/noCL.
Fresh actor context получен от настоящего Edge204; значения token/cookie не
записаны. Два native SASL_SSL Kafka ACK дошли до обоих потоков, generated
validators проверили public4/private4/total12frames. Actual assertion сравнивает
индексы replay hint и ready: hint после last complete cursor идёт до ready,
unknown cursor reset также до ready. В end callbacks обоих потоков зафиксирован
предшествующий reset; response.complete=true, SIGTERM/rootexit0/OOMfalse,
forcedClientClose=false. Cleanupverified: все8roles/network/private удалены.
Scope остаётся bounded framing/replay/graceful EOF; mid-frame upstream truncation
не инъецировалась. Raw coordinator `result.json` оставлен FAIL/errornull из-за
отсутствующих full-driver критериев; scoped summary не подменяет его и содержит
launchProof=false/fullAcceptance=false. First attempts readiness/client-connection
и test assertion ошибки не являются protocol/capacity результатом.
Независимое ревью обнаружило V39-NGX-1 (непроверенный replay ordering boolean)
и V39-NGX-2 (aggregate validator count приписан каждому потоку). Actual assert
и отдельные counts добавлены, повторный run/review закрыли оба замечания.
Архив `experiment-source/nginx-framing-probe-v2`, script SHA-256
`082684d077dabeb54363fb01c93982678952c7efeee83198b6883c1f5a9b8d85`.
Предыдущий v1 архив сохранён для provenance, не используется для этих assertions.

Расширенный TLS probe прошёл у tester и root:2/2,0fail/skip. Стандартный public
`stream.setDefaultHighWaterMark(false,256)` временно применяется только в test
process до TLS accept, затем восстанавливается в handler/finalizer. Фактические
socket/response HWM256; exact compiled `writeChildFrame` записал64encodedframes/
16567B, writefalse1/callback1/drain1/ACK1 после обоих, pending очищен; client body
совпадает побайтово, finish→TLSsocketclose. Production HWM/config прежние.
Тот же synthetic HTTPS server отправил полный actual hint + усечённый следующий
JSON + incomplete UTF-8 и закончил close-delimited TLS response:368clientbytes,
decoder выдаёт1completeframe, cursor прежний. Decoder получает собранное тело
после EOF; tail buffered/unemitted, явного discard/EOF method нет. Связанный
EOF→reconnect→replay цикл и actual cluster/nginx в этом probe не исполняются;
replay/reset проверены отдельным существующим real mTLS fixture сценарием.
V39-TLS-1 исправил завышенный `partialJsonAndUtf8TailDiscarded` claim на `partialTailNotEmitted`
и эти ограничения, test logic не менялась; повторный2/2PASS.
Архив `experiment-source/http-framing-probe-v2`: script SHA-256
`bc902b2120cb8e02cbe624a8a7c93a2bd332c477debceabf0a164e333d0058ed`, receipt SHA-256
`02894a440287bb68ae80b69ebdb492f9125b507b60efb3eab35d533f4cfa7ecb`.

Full V39 стартовал13.10.2026 01:51:20UTC по исходному frozen manifest
`74c1b852b5f0bae4b09f1ed9d99a4dcb64cb9b5123b39925ad0732f3185e9682`.
Full завершился FAIL/driverExit1:78490.467ms,7850validACK,minLive3171/max5000,
all-process event-loop maximum45.776895ms. Первый threshold sample:
01:54:14.888UTC, public nginx `/health/live` kind2/status200/1294.378449ms.
Это nginx return200 без gateway upstream: TCP connect42.542409ms,
secureConnect1276.094600ms, headers1294.048792ms от старта; разности
connect→secure1233.552191ms, secure→headers17.954192ms. Они локализуют задержку
до public TLS setup, но не разделяют Nginx CPU, accept/TLS queue, client или
host scheduling. Driver loop p95/max того receipt15.065/119.865ms.
Failure marker01:54:14.900UTC/live3171; последующие5threshold records POST.
До cutoff77measurement samples; последний01:54:13.362UTC/elapsed76953ms/
live3566/7675ACK. Предыдущие616headroom probes (154наkind): max session825.976ms,
API837.601ms, public health809.018ms, directgateway201.137ms.

Preflight replay/reset/slow/eviction/admission выполнены. 5000 initial streams
уникальны,5001preheader503typed; всеcoldTLS/cipherfallback probes прежние.
До cutoff7complete re-auth/allresumed/gap3215..6912ms, retryrows0. Последний
ready01:54:14.801UTC; количество и stage ещё ожидающих reconnects не измерены.
Последние metrics01:54:13.581UTC: live3908/authclose1504/pressureclose1
(pressureclose включает preflightslow); queuepeak78247records/20472178B,
IPCpendingpeak3191records/836042B. ACKerrors/reservation/capacity rejects0.
Оба worker target windows64; waiters1281/1202, oldestwait762/1045ms,
reservation→ACK lifetime max140.7ms. Это не TLS handshake measurement и не
доказательство причинной связи с public TLS delay.

149kernel events с полными snapshot intervals строго до cutoff: listener/cgroup
statusok, privateport4401, acceptqueuemax45, ListenDrops/Overflows0. Public nginx
listener8443 здесь не измеряется. Последний snapshot13.608..13.779UTC;
cpu.max20000/10000, максимум usage2110082us/nrthrottled98/throttled2388618us
за sampleinterval; cgroup counters агрегированы, это не wall-time проценты.
Последние полностью завершённые hostrole intervals до cutoff: nginx10.071..
11.864UTC RSS663719936B/cgroup673767424B/peak689610752B/FDmax4350,total8696,
DockerCPU138.55%; gateway11.864..13.868UTC RSS986058752B/cgroup815128576B/
peak816205824B/FDmax2110,total4203,CPU193.80%; driver07.859..09.848UTC
RSS1261236224B/FDmax5052,total5055,CPU322.58%. OOMkill0; интервалы различаются,
CPUstats не устанавливают точную причинную разбивку.
Coordinator и driver совпали по FAIL; observerexception нет. Все8ownedroles,
network и synthetic private material удалены,3427.933845ms/verifiedtrue.
30min/fullre-auth/HUP900s/loadedshutdown не достигнуты; capacity/production
adoption не приняты. Frozen runtime/код продукта не изменены по результату FAIL.

Дополнительное чтение strict-prefatal TLS snapshots V39 (worker1/2 в
01:54:13.958/13.998UTC) подтверждает private resumption: secure2814/2927,
resumed2698/2799, cold116/128, pending5/4, errors/missingStart0/0. Совокупные
accept→secure maxima для cold106.686/167.564ms и resumed198.619/199.613ms.
Между последними snapshots до01:54:07UTC и этими snapshots появились523accept,
514secure,493resumed/21cold. Это счётчики private TLS после accept, без привязки
к failing public request; ожидание до accept они не измеряют. Полный re-auth
этим наблюдением не принимается, гипотеза массовых cold private handshakes
в данном наблюдавшемся окне не подтверждается.

### Следующее измерение после V39: публичный listener nginx

Гипотеза общего auth sweep не подтвердилась: `hub.ts` создаёт отдельный
`setInterval` при открытии каждого stream и удаляет его при close/drain.
Расположение проверок относительно открытия уже различается; изменение
расписания авторизации не обосновано и не выполняется.

V40 сохраняет runtime V39 побайтово и расширяет только существующий host
observer coordinator для owned `edge-nginx`. Bounded reads должны измерить
LISTEN `rx_queue` порта8443 через `/proc/<owned-host-pid>/net/{tcp,tcp6}`,
ListenDrops/Overflows той же network namespace, `cpu.max/cpu.stat` собственного
cgroup и `schedstat` текущих nginx workers. Это счётчики и interval deltas,
не раздельная стоимость TLS instructions. Baselines разделяются по container
StartedAt и worker PID; reload не смешивает поколения. Raw sockets/addresses
не записываются. На EACCES, truncated/invalid input значение недоступно/null,
а не0; permissions/host policy и acceptance gates не меняются. Чтения остаются
в существующем observer без новой cadence или параллельного load. Доступность
host procfs ещё не подтверждена. До нового frozen full — actual-source checks
и independent review; overhead наблюдения отдельно не измерен.

Фактическое ядро6.8.0-146-generic имеет CONFIG_SCHED_INFO=y; оба sysctl
sched_schedstats/task_delayacct равны0, но `/proc/self/schedstat` содержит
ненулевые runtime/run-delay/timeslice counters. Поэтому предварительная гипотеза
«sysctl0 делает эти counters недоступными» отвергнута до реализации. В
[Linux6.8 proc_pid_schedstat](https://raw.githubusercontent.com/torvalds/linux/v6.8/fs/proc/base.c)
источник — `task->sched_info`; [sched_info_on](https://raw.githubusercontent.com/torvalds/linux/v6.8/include/linux/sched/stat.h)
определяется CONFIG_SCHED_INFO. [sched_info_arrive/dequeue](https://raw.githubusercontent.com/torvalds/linux/v6.8/kernel/sched/stats.h)
накапливают run_delay отдельно от static-key SCHEDSTATS. Эти counters считаются
только после строгого разбора и сопоставления одного worker generation.

V40 source review и actual-source regression checks прошли. Сохранены96checks
V39, добавлены4сгруппированных checks: IPv4/IPv6/8443 RX, cap+1/read/close,
EACCES/truncated/malformed input, scoped cgroup path/traversal, strict schedstat,
generation/PID replacement/removal/rollback/null semantics. Root отдельно
повторил `node /tmp/coffee-12-cluster-min-fixture.mjs`: exit0, minFixture/
fourFileReceipt/frozen hashes PASS, nonRealtimeUnchanged=true. Independent
review final hashes — PASS. Снимки не атомарны; partial_new_workers учитывает
только surviving PID и не является полным interval всех workers.

Prepare exit0; `verifyPrepared` подтвердил209sources/38compiled/14supporting,
native adapter/images. Manifest
`c4390e63eb15c18b304a14f051decba5e0b3a5cc843bdbe914908a07bf22cf38`, каталог
`issue12-v40-public-nginx-observer-full-20261013`; workload5000/100/1800000ms,
nginx/gateway2CPU/1GiB. Frozen coordinator SHA-256
`c29a346acb9b8343721b9d48cee672d6bef6401c7b319a57ab449d895a0dec3b`, parser
`4126fc6548333ce56dc357dc26ae839a4bba0b7d06c512f11cb090324718f7a6`, selfcheck
`0a364949247c94912b9a4c80f75c4cdb4924d941cbfbbb679d14e19a6ba978a0`.
Gateway/patch/min-fixture/cipher helper прежние. Архив6readonlysources
`experiment-source/public-nginx-observer-v1`, receipt SHA-256
`409e32d9732fe46c6ddb86eb5a264b83d12510db9755593104588705d3dcb20a`.
Full стартовал13.10.2026 02:20:27UTC и завершился FAIL/driverExit1:
80522.253777ms/8053validACK/minLive2706/max5000, loop53.936127ms. Parent/driver
совпали; HEADROOM_LATENCY_EXCEEDED kind0 session1307.735102ms/status200.
Первый known threshold02:23:20.297UTC: TCPconnect46.735216ms,
secureConnect1281.287227ms, headers1307.463499ms от начала запроса;
connect→secure1234.552011ms. Driver loop того receipt p9515.262/max97.583ms.
Последующие health/API threshold records — POST.

Host procfs/cgroup доступны без обхода permissions.25public snapshots с
measurementFinishedAt строго до cutoff: listenerCount1/port8443/statusok,
public accept queue max44, namespace ListenDrops/Overflows0. Последний
snapshot02:23:14.490..14.503UTC: queue0, cpu.max200000/100000, usage delta
7668997us, nrThrottled/throttledUsec delta0, дваmatchingworkers schedstat
runtime7451487197ns/runqueuewait1939199642ns/timeslices9043. Эти delta относятся
к interval от предыдущего snapshot02:23:08.294..08.305UTC, не только к12.656ms
чтения. Sumrun-delay двух workers не является latency одного запроса или
доказательством sole cause. Снимки не атомарны, gap около6.2s может пропустить
краткий transient. Первые нулевые schedstat deltas возникли до нагрузки;
прямое чтение обоих owned worker PID позже подтвердило ненулевые cumulative
counters и соответствующие runtime ticks, без изменения sysctl.

Snapshot02:23:20.547..20.560UTC показывает publicqueue405, CPU delta8576906us,
throttling delta0, worker sumrunqueuewait3744792257ns. Он строго ПОСЛЕ threshold,
поэтому не используется как доказательство предшествующего queue delay.
Обычное удаление всех8ownedroles/network/private verified,3563.135512ms.
Непройденные30min/fullre-auth/HUP900s/loadedshutdown остаются открыты.
Diagnostic-only/launchProof=false не меняют ordinary acceptance и не разрешают
production adoption/merge.

До first threshold сохранены78полных measurement rows /624headroom probes
(156наkind); последний02:23:18.299UTC/live3124/7829ACK. Max session959.667ms,
API990.764ms, publichealth951.782ms, directgateway525.679ms. Failure marker
02:23:20.397UTC/live2697 идёт после первого threshold; final minLive2706 —
поле driver result, отдельный marker не подменяет его.75complete re-auth
строго до cutoff/allpublicTLSresumed/maxgap8297ms; последние2complete rows
и7retry504 идут ПОСЛЕ cutoff (первыйretry02:23:20.952UTC) и не засчитываются.
Full recovery не принят.

Последняя owner metrics row02:23:19.841UTC/live3773: Hubqueue93351records/
24340251B (prefatalpeak), IPCpending2409/630789B; IPCprefatalpeak3200/838400B.
Все5IPC rejection counters иACKerror0, success832391; maxreservation→ACK285.592ms.
Prefatalrawowner/worker loopmax56.918ms — отдельное observation, driver result
сохранил53.936127ms по своим metric reads. Waiters max2140/2251, oldestage
1608/1744ms. Latest fullyfinished private kernel snapshot02:23:19.004UTC:
acceptqueue1/drops0/overflows0, ownCPU usage delta1986506us, nrthrottled50/
throttled_usec234634; это counters, не attribution failing public request.
Во всех fullyfinished prefatal hostrole intervals: aggregateRSSmax
nginx662769664B/gateway980127744B/driver1304141824B; individualFDmax
5065/2568/5073, gatewayaggregateFDmax5097, OOMkill0. Обязательные resource gates
не пересекались; различающиеся интервалы не являются synchronized CPU proof.

### Следующее измерение после V40: частота public observer

V41 оставляет конфигурацию nginx и runtime V39 прежними. Тот же bounded
collector запускается nominal1Hz через существующий500ms observer tick,
независимо от долгого serial Dockerstats monitor. Отдельный singleflight
запрещает overlap; latestrow — единственное состояние результата вRAM, append
идёт в отдельный jsonl. Owned label/PID/containergeneration и текущие workers
сверяются при каждом sample; ошибки CLI/proc дают unavailable/null и сбрасывают
baseline, не создавая acceptance gate. После stop sampler завершается до cleanup.
Дополнительные inspect/top calls и overhead ещё не измерены; новыйtimer,
Dockerexec, hostpolicy, publicwire, load/budget/threshold changes не вводятся.
Current data не обосновывают multi_accept/reuseport treatment; сначала требуется
плотнее измерить listener рядом с задержавшимся public TLS запросом.

Source review выявило V41-F1: fast inspectRole наследовал default CLI timeout
120s/8MiB и мог удерживать stop. Исправление использует существующий
inspectRole(role,runOptions): только fast caller передаёт5s/64KiB; остальные
callers сохраняют defaults. Top ограничен5s/16KiB, ownership/label проверки
прежние. Повторное source review закрыло F1. Два последовательных CLI могут
занять около10s; nominal1Hz не является гарантией sample каждую секунду.
Final regression checks — PASS у tester и root:104named checks, сохранены100V40
и4V41. Root rerun сначала выявил flaky V40 assertion: поиск цифр PID во всём
JSON совпал с `elapsedMs=0.4888210000001436`. Только assertion заменён recursive
проверкой запрещённых PID/address/inode/path fields; observer source прежний.
Повторный exact-byte min-fixture exit0 подтвердил selfcheck/fourFileReceipt/
frozen hashes/nonRealtimeUnchanged, launchProof=false. Final independent review
замечаний не оставило. Live overhead и полные acceptance пока не доказаны.
Normal prepare exit0 и verifyPrepared
подтвердили209sources/38compiled/14supporting/native/images, measurement
5000/100/1800000ms и2CPU/1GiB. Manifest SHA-256
`e981503e7d2f84321919937d54ac6f0044cffd8fab92bbd968c6eeb63ad6302b`, каталог
`issue12-v41-dense-public-nginx-observer-full-20261013`.

Frozen coordinator `2d410c6c5b607f332bebda924c553390b7e65785753a1d616ba4067009360dd2`,
selfcheck `880a30bf4cde48e69035434035a2e3403e66bab6c4d7a09a607a5d48e7a5829a`,
sampler anchor SHA-256
`560702a4e831d9355eff4b6101b7a0631ec8052dc19ebf15d613afdecbad4979`.
Parser SHA прежний `4126fc6548333ce56dc357dc26ae839a4bba0b7d06c512f11cb090324718f7a6`.
Six sources mode0444/root output сохранены в
`experiment-source/dense-public-nginx-observer-v1`; receipt SHA-256
`0980adf8d67be94e0eb8706e2cbdd9018c6c0ca3d7a0f2f05bd5c3a4e69f8077`,
root selfcheck log `3208d9318ddf03bc75fb4b8d42b670254384ab16e605c0c500c518d8c3af0ace`.
Full5000/100/1800000ms стартовал13.10.2026 02:49:15UTC; parent/driver завершились
FAIL/driverExit1:80452.487917ms/8046validACK/minLive2559/max5000,
loop51.511295ms. Measurement start02:50:50.915UTC. First known threshold
02:52:11.330UTC — publickind2health1669.376274ms/status200; transport cumulative
offsets connect162.540073/secure1651.020585/headers1669.105341ms. Разности
connect→secure1488.480512ms, secure→headers18.084756ms. Driver loop того receipt
p9515.065087/max155.189247ms. Failure marker02:52:11.368/live2557 отдельно от
final minLive2559. Последующие failure records — POST.

Строгая фильтрация по обоим observationFinishedAt и measurementFinishedAt
оставляет137из138dense rows до threshold, всеstatusok. Publiclistener8443/count1,
ListenDrops/Overflows0. В окне reconnect queue48@02:52:06.522 →134@07.550 →
170@08.527 →139@09.557 →367@11.093UTC. Последний snapshot завершён за237ms
до threshold, во время приблизительно восстановленного TLS ожидания failing
request: UTCstart около02:52:09.661, вычитанием monotonic duration из record `at`.
Это приблизительное совмещение, не per-connection nginx proof. Последний CPU
interval от предыдущего measurement end занимает1.536s: usage2026893us,
cpu.max200000/100000, nrThrottled/throttledUsec delta0; schedstat двухmatching
workers runtime1811900628ns/runqueuewait1258083216ns/timeslices2128.
Суммарное ожидание двух workers не является latency одного запроса.
Все138rows statusok; fullobserver median108.555/max256.699ms,
identity discovery max233.773ms. Дополнительная стоимость observer не отделена;
V42 сохраняет его прежним для контролируемого сравнения.

До cutoff78complete measurement rows/624headroom probes (156/kind), последние
02:52:08.865UTC/live3194/7778ACK. Максимумы session653.451/API703.611/
publichealth639.658/directgateway353.549ms.13complete reauth строго до cutoff,
allTLSresumed/maxgap8302ms; всего18complete, остальные POST, retry records нет.
Replay/reset/slow/evicted/admission5000/5001 и realTLS/SASL/composition прошли
preflight; full recovery/30min/HUP900s/loadedshutdown не приняты.
Fullyfinished prefatal roleintervals RSSmax nginx662695936/GW992944128/
driver1289412608B, individualFDmax5030/2541/5075, gatewayaggregateFDmax5099,
OOMkill0. Cleanup3519.379047ms verified: все8ownedroles/network/private удалены.

### Следующее измерение после V41: multi_accept

Prefatal publicacceptqueue рост обосновывает один controlled scratch treatment,
но не устанавливает причину задержки. Согласно
[nginx multi_accept](https://nginx.org/en/docs/ngx_core_module.html#multi_accept),
default off принимает одно соединение за проход; on принимает доступные
соединения за проход. На текущем Linuxepoll sharedlistener дваworkers используют
EPOLLEXCLUSIVE, accept_mutex остаётсяoff. Никакие listen/backlog/reuseport,
TLS/ciphers/worker count/CPU/RSS/TTL/очереди/gates не меняются. V42 добавляет только
`multi_accept on;` в generatedscratch eventsblock после verifyPrepared и прежнего
ciphertransform. Uniqueanchor/absence/обратное восстановление байт и stagehashes
проверяются; actualowned nginx -t/-T должен подтвердить загруженный конфиг.
Production adoption не выполняется. Пользовательские критерии остаются прежними.
Normal prepare V42 exit0; manifest
`cb14a404c6237bb65f3229be56392ac03572b2148916bbf9249cd3ddc6324b00`, каталог
`issue12-v42-nginx-multi-accept-full-20261013`. Root verifyPrepared подтвердил
209sources/38compiled/14supporting/native/images, прежние5000/100/1800000ms и
nginx/gateway2CPU/1GiB. Source SHA-256
`992a29df978f079dae5a8717550aa82d6a8c7668d71ad04b86a67e5c518feb59`, mode0444,
node--check PASS и independent source review без замечаний. Изменены только
TMPcoordinator transform/receipts/preflight и classification; gateway/patch/
minfixture/cipherhelper прежние. `nginx -T` читает mounted конфиг заново,
не introspection памяти master; ROmount до запуска и последующие actualworkers/
readiness дают проверяемую связь. Final regressions — PASS у tester и root:
106named=104предыдущих+2V42. Actual-source assertions покрывают unique/missing/
duplicate/already-multiaccept anchors, точную обратную трансформацию, stagehashes,
ownedinspect и5s/64KiB limits для трёх CLI. Docker responses в этой проверке
подставные; это не live proof. Independent final source/tests review — PASS.
Selfcheck `16320352b5b3acd53fe6b782c32b3b514b7c9296753b047090d5fa866b1c55fd`;
root log `269ce802272a5f69a1397f2d8fee00fed41dceb3d42ebc801ebb93fe3e8f4cb9`.
Six mode0444sources иroot output в `experiment-source/nginx-multi-accept-v1`,
receipt `1ab7c0aedc68607f7b9e99c0dd7f893a6d600ac520bb77359727ccc16209db23`.
Transform anchor hash
`62d05dd7ffec08c6eadde626dfcd23550271c9eb40c4fbbf78dd96da0b0b82d1`, runtimeproof
`822f345bde32b0cd5fe63cc27abd07c46c1f199342dcf0272e0781c3ce1d47d8`.
Full5000/100/1800000ms стартовал13.10.2026 03:05:52UTC; parent/driver завершились
FAIL/driverExit1:73341.774003ms/7335validACK/minLive3880/max5000,
driver-reportedloop43.941887ms. First threshold03:08:43.092UTC:
APIkind1typed4041214.745724ms>1000; cumulative connect170.511234/
secure315.741880/headers1214.193528ms. Connect→secure145.230646ms,
secure→headers898.451648ms; driverloopтогоreceipt p9515.450111/max160.432127ms.
Этот failing request отличается от V41 publichealth и ожидает после TLS;
auth/mainupstream/response scheduling пока не разделены. Последующий failure
marker03:08:43.105/live3880 не является началом запроса.
Actual owned nginx -t/-T preflight прошёл до нагрузки:2workers/
worker_connections16384/однаmulti_accepton, sourceSHA
`5b484c637c1dd282ecd68b7e430da0f9841d8637bad815ea6d95084b47f3ce21`, proofSHA
`c2f197444535ea9db0f1c0c2e4ecabcf45cb6cdea7d7d92820c7aa675a350ea2`.
Stages: frozennginx `df4a92de715a09681b211e9fb986cc5e076dcff7621298b07d925d905b99ee3e`
→cipher `41d2333396db5cc5610c6d5c6053b22c93e3807527f4d88a41c821d165e5df18`
→multi_acceptsource выше; inverseVerified=true. Actual5000coldTLS и5001typed503
прошли, семьcipherfallbackprobes прошли. Это preflight, неfull acceptance.

138из139dense rows полностью завершились по обоим finishfields до cutoff,
statusok/listener8443/count1; acceptqueue max/latest15, drops/overflows0.
Последний measurement03:08:42.695..42.705UTC завершён за387ms до threshold:
CPU delta1395635us, nrThrottled/throttledUsec delta0, дваworkers runtime
1395691753ns/runqueuewait586749884ns/987timeslices заоколо1s. В V41 max367
измерен позже в reconnect относительно mainstart; один контроль не доказывает
causal gain или пригодность настройки. V43 сохраняет её только как bounded
candidate, без production adoption; reuseport/backlog не меняются.

До cutoff72complete measurement rows/576headroom probes (144/kind), последний
03:08:41.105UTC/live4335/7126ACK. Максимумы session345.998/API402.609/
publichealth246.151/directgateway224.968ms. Двеcomplete resumed reauth доcutoff,
gaps4609/4631ms, retry recordsнет; fullcohort не принят.78strictprefatalmetrics:
IPC rejection/error counters0, pendingpeak3179records/832002B; latest2556/669672.
Последняя metrics03:08:41.854UTC: totalqueue53342records/13945082B,
owner/worker p95loop32.145/31.687/34.406ms. Maxrawloopowner45.252607ms,
workers43.941887/39.682047 — отдельное observation от driverreported43.941887.
Fullyfinishedroleintervals25nginx/24gateway/24driver: RSSmax663527424/
982040576/1277014016B, individualFDmax5042/2561/5081, gatewayaggregateFDmax5099.
OOM/oom_kill/oom_group_kill0. Cleanup3687.381232ms verified:8roles/network/private
удалены. 30min/fullre-auth/HUP900s/loadedshutdown снова не достигнуты.

### Следующее измерение после V42: correlated upstream timings

V43 не добавляет настройки приёма или wireheaders. TMPdriver будет сохранять
строго UUID-shaped существующий response `X-Correlation-ID` либоnull вheadroom
receipt; это не новый acceptance gate. Existing stdout `edge_safe` logformat nginx
дополнится response/auth correlation IDs и rawstring request/mainupstream/auth
connect/header/response seconds; cookies/URI/actor context/адреса не
добавляются. [auth_request_set](https://nginx.org/en/docs/http/ngx_http_auth_request_module.html#auth_request_set)
может сохранить variables завершённого authsubrequest. Секунды
[upstream timings](https://nginx.org/en/docs/http/ngx_http_upstream_module.html#var_upstream_connect_time)
остаются строками: отсутствующее `-` не превращается в0. Requesttime nginx
не является полной clientTLSlatency. Причинность будет оцениваться после
совпадения exactresponseCorrelationId с nginx и application request logs;
быстрые соседниеAPI404 изV42 не приписываются failing request.

Source writer меняет только existingTMPcoordinator/change callback после
frozenverification. Newphasebefore/after/inverse отделяется отV42multiaccept
stage; mountedconfigproof проверяет finalphasehash. Обычный prepare exit0;
root verifyPrepared подтверждает209/38/14sources/native/images и прежние
5000/100/1800000ms/2CPU/1GiB. Manifest
`92e2a30b685d2ffc938341a080baaa9c028f34b5d510bfdda99df7c81b9d3d4a`, каталог
`issue12-v43-correlated-upstream-timing-full-20261013`. Source writer заморозил
толькоTMPcoordinator. Source review не обнаружило blockers; parent удалил
единственное prematureundefinedmetadatafield до получения runtimeproof,
authoritativeproofreceipt позже остаётся в result.publicNginxMultiAcceptProof.
Finalsource `10ea3a21c3a1208419a6b78751ba9b63b83fb3eccef46f9980c7be7670591854`,
mode0444/node--check PASS. Девять logfields/9authlocations/27captures,
driver `correlationId` принимает только RFC4122-shaped v1–5 UUID илиnull.
Format escape=json сохранён; `msec` не добавлялся, корреляция идёт по exactID.
Synthetic writer sanity прошёл безDocker; existingregressions прошли уtester
иroot:107named=106предыдущих+1V43group. Actualtransform/inverse/stagehashes,
9fields/27captures/safeformat и actualdriverUUID/null проверены; runtimeproof
вselfcheck использует подставные Docker responses. Final independent review
замечаний не оставило. Selfcheck SHA
`683e9c94d734a0b2168608e0c6f5b618507bbb99b2c552d3d4baf6b353aa95ff`,
rootlog `2ae66712f8a839e211fe664f6b6b5e2db5001adb6a5a7343b45beeea1e189a32`.
Sixsources mode0444 иrootoutput в`experiment-source/correlated-upstream-timing-v1`,
receipt `101549ef37bfe7befd642ac809013caf2a4fd9f05ce9641d6f8385f0087f095d`.
Timingtransform anchor SHA
`b10b65d68b52bbb61c4ae6e9945c9a8c1c49418d95a085c88aab4d2a6d05187d`,
runtimeproof `bdb911b32bef653ad7e3a7034a150ced6491cbf9a1afa1822a66e63c7859b084`.
Full5000/100/1800000ms стартовал13.10.2026 03:23:14UTC; main measurement —
03:24:53.411UTC. Actual owned nginx `-t -q` и `-T` прошли: mounted mainconfig
совпадает с finalstage SHA
`6f0f247ff0a1ce40eb27d0a4b4115f60611f6fe45ab3769f38cae47f20c50c7e`,
две workers/16384connections/одинmultiaccept/одинlogformat/9timingfields и27
authcaptures подтверждены. SHA файла runtimeproof
`ea829591397bdef7ed062f8db7a876398b17eaed0bdaabd228ea135d56d6d34d`;
hash JSON объекта в result отличается от hash форматированного файла.
Во время нагрузки bounded read-only inspect/logs подтвердил20exactUUID pairs
из последних10 обычных samples: каждая API-проба имела ровно одну nginx запись.
Это проверка рабочего сопоставления ответивших запросов, а не полного soak.

Итог full — FAIL, driver exit1, 73313.550925ms/7332validACK,
minLive3824/maxLive5000, reported event-loop51.970047ms. Все5000 initial
connections и typed preheader503 для5001 подтверждены; preflight replay/reset/
slow/eviction прошёл. Ошибка — `TRANSPORT_PROOF_FAILED`, API request deadline
до получения ответа. Первый известный failure marker `samples.jsonl` —
03:26:06.725UTC; это граница классификации evidence, а не точное время начала
timeout. `headroom-failure` с завершённым ответом отсутствует. Драйвер сохранил
576 завершённых headroom probes; полного re-auth receipt нет.

ExactID `e7a21230-f0c0-44b8-a5cd-7ab18fbfdfc6` связывает один nginx→Edgeauth→API
запрос: nginxrequest1.140s, authconnect0.368/header0.700s, mainconnect0.000/
header0.440/response0.440s. Edge получил authorize в03:26:06.423UTC и завершил
его в06.477 за53.971ms; API получил запрос в06.706 и завершил typed404 в06.716
за10.006394ms. Значительная задержка этого запроса накопилась вне времени
обработки API после его получения. У failed driver probe нет response UUID;
нельзя назвать этот запрос именно упавшей пробой или приписать всё время
TLS, одному процессу либо CPU. Суммарные nginx timings не заменяют trace
конкретной попытки клиента.

Гипотеза «auth upstream keepalive не работает из-за HTTP/1.0/Connection close»
не подтверждена. Pinned nginx1.31.6 использует default HTTP/1.1 с1.29.7
([proxy_http_version](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_http_version));
existing `tests/nginx/cutover.test.mjs:167–172` проверяет два независимых auth
запроса без Connection header на одном upstream TLS socket с новой подписью
для каждого actor. `edge_gateway keepalive8` — idle sockets на worker, не
ограничение5000активных запросов. Runtime создаёт Fastify без override;
installed pinned Fastify5.12.1 устанавливает server.keepAliveTimeout72000ms
(`lib/config-validator.js`, `lib/server.js`), что также проверено instance без
listen. Raw Node default5000ms здесь неприменим. V43authconnect0.368s одного
запроса совместим с новым соединением, но не доказывает неработающий пул.
Оснований менять конфигурацию ради «включения keepalive» нет.

Дополнительное exactID-сопоставление охватило все144завершённые kind1 probes
из72strict measurement rows/576total probes (144каждогоkind). Каждая имеет
ровно одну nginx запись и связанные Edge/API logs. Первые10s содержат22API
пробы, последние10s до marker —16; nearest-rank p50/p95/max вмс:
authconnect0/0/0→0/0/59, authheader3/59/59→15/33/106,
mainconnect0/34/41→0/0/0, mainheader27/100/105→15/33/44.
Edgeauthorize responseTime1.79/4.78/5.69→3.07/5.64/5.66ms,
API13.59/65.29/91.57→7.88/12.05/13.00ms. Рост времени upstream/handler в
этих completed samples не наблюдается. Clientfull p95≈220→371ms/max248→459ms,
connect→secure p95≈79→138ms; это не локализация причины timeout. Zero connect
не считается отдельным доказательством reuse. Медленный e7a21230… отсутствует
среди IDs этих проб и исключён из распределений. Небольшие22/16cohorts и
selection только завершённых ответов не характеризуют timed-out попытку.

Строго до marker: последняя обычная sample03:26:04.959/live4205, последняя
gatewaymetric05.515/live4147/authclose950. В78metric rows все шесть IPC
rejection/error counters0; totalqueue peak/latest96940records/25312429B,
latesttransportqueue6044/1559336B, IPCpendingpeak3200/838400B,
latest3022/779668B. Processloop maxima: owner51.970ms, worker1 49.414ms,
worker2 47.350ms. В136dense NGX rows обе части measurement закончились до
marker: queue≤7, latestqueue6 в05.927, drops/overflows0. Latest aggregate
двухworkers runtime1.274s/wait0.623s/1465slices заоколо1s; strictmax CPUdelta
2.592s, throttlecount3/usec79633, schedwait0.879s. Эти интервальные суммы не
привязаны к отдельному запросу; моментные снимки могут пропустить короткий пик.

По собственному `measurementFinishedAt` каждого role строго до marker:
25NGX/24gateway/24driver intervals. MaxRSS664326144/977317888/1274097664B,
individualFD5054/2532/5081, aggregateFD10058/5099/5084. OOM/oom_kill/
oom_group_kill0. Cleanup3441.490893ms verified: все8ownedroles/network/private
material удалены; после запуска owned Docker containers отсутствуют. 30min,
полный re-auth, HUP900s и loadedshutdown не достигнуты; launchProof=false.

### Следующее измерение после V43: идентификатор до отправки пробы

V44 сохраняет runtime V43 и меняет только scratch diagnostics. Driver создаёт
probeUUID до запроса, передаёт existing optional `X-Correlation-ID`
([client-v1](../contracts/openapi/client-v1.yaml)) и сохраняет probe start,
ошибку и частичные transport timings при timeout. Nginx добавляет только
строго UUID-validated incoming probeID в existing escape=json stdout log;
невалидное/отсутствующее значение пустое. Существующая политика correlation и
actor context сохраняется; UUID является metadata, actor/permissions проверяются
отдельно. Existing health location включает тот же безопасный access log
для сопоставления kind2. Нового business header, schema, deadline, retry,
ресурсного бюджета или ослабления acceptance gates нет. Отдельный byte-inverse
и hash receipt отделяет V44 от V43; actual nginxproof должен проверить final
stage. До точной корреляции ошибка V43 не считается объяснённой.

Обычный prepare V44 exit0; root `verifyPrepared` проверил209sources/38compiled/
14supporting/native/images и точные5000/100/1800000ms, NGX/GW2CPU/1GiB.
Каталог `issue12-v44-preassigned-probe-timing-full-20261013`, manifest
`973882992904ab45aea2943459062a093c9730462b3cd43ea641b3432c287e63`.
Writer менял только TMPcoordinator; gateway/clusterpatch сохранили hashes V39.
Root до load обнаружил unquoted `{N}` в nginx map regex; writer заключил весь
regex token в кавычки в transform и runtimeproof. После этого tester выявил
реальный transform bug: String.replace интерпретировал `$'` в replacement
как остаток исходной строки и дублировал health location. Source guard отклонил
изменение до записи/нагрузки. Writer заменил replacement string на callback;
map вставляется буквально. Final coordinator
`961451b64e70d631d30b4d64df36e564671a65aadee700ecf702ad627447a6f6`, mode0444,
node--check PASS. Синтетическая проверка worker не подтверждает реальный nginx
parser; actual `-t/-T` и полный профиль ещё не выполнены. Tester проверяет
исправленный frozen source; launchProof=false.

Tester иroot после M2 прошли node--check/source selfcheck/minfixture:108named
=107предыдущих+1V44group. Actualtransform/inverse/count проверяют literalmap
и сохраняют guard; UUID/tag/start, unchanged deadlines/statuses, partial
timings на том же Error и originalthrow даже при recordfailure подтверждены.
Selfcheck `6c6cbbba183e246ba553309891190c3bbe16328f84f80c8a119771aa780d96e0`,
rootlog `7aacfcf787c8564a11e748fd722c2784054afe2583da4b7de671f7facd7d9781`.
Независимое source/tests review PASS, M1/M2 закрыты. Sixsources+rootoutput
заморожены mode0444 в`experiment-source/preassigned-probe-timing-v1`, receipt
`1e6404759596e85b6380dd8d84877a144593d596046cf4004cdc8f5f7cb9c289`.
V44transform anchor
`0d5236c71fa947264203d4f8c660452a4e7101066466d18cb54d9772fb96a707`,
runtimeproof `0a19e63f2a31fc7664ac2a4280b0c3d7dc5ae8f6e263b219530720756879033f`;
V40parser/V42multi/V43timing hashes прежние, V41sampler изменил только
classification reference. Full5000/100/1800000ms стартовал13.10.2026
03:53:27UTC. Реальный nginx `-t/-T` прошёл, source hash
`6c23a334948b956474db53ea002d135e3c238beb3297ff14a3f89cc8a386cedc`,
runtimeproof fileSHA
`a732d1e3c88dd4d2fb19da3fe75df393b7851d3a3eba0258d002ae57938d2766`:
strict probe map/health logging/auth forwarding подтверждены. Но driver
остановился в preflight: `verifyCipherNegotiation is not defined`, exit1/
duration0. V44 заменял диапазон headroom→preflight, который после V29 cipher
transform содержал ещё TLS verifier; он ошибочно удалился. Это defect harness,
а не повторный capacity failure. Selfcheck проверял cipher helper до конечной
V44 замены и не обнаружил удаление функции из finaldriver; прежний PASS не
доказывал полноту preflight. Cleanup2972.980452ms verified8roles/network/private,
owned containers отсутствуют. Полный main/correlation/reauth не измерены.

M3 исправляет только scratch range end: перед existing
`verifyCipherNegotiation`. Sourceguard сохраняет весь verifier/preflight suffix
byte-identical; тест проверит именно final transformed driver. Новый source
`08a5ea1ac493d1eec185d38d29340cdc7073e77e5e297fc553bea98659084b39`, mode0444,
node--check PASS. Старый archive v1 сохраняет фактически запущенный failed
source. Для повторного запуска выполняется fresh normal prepare в
`issue12-v44-preassigned-probe-timing-full-v2-20261013`; итоговый FAIL описан ниже.
Первый M3 guard ошибочно искал preflight call внутри диапазона до preflight;
tester отклонил его без нагрузки. Итоговый guard сравнивает полный suffix до
EOF, отдельно проверяет уникальность verifier/call/preflight. V2 prepare exit0,
manifest `70882fe6fd4f5111db265f3d484e1b4e82a5832ab88b65a2e0abecd005f0d45d`;
rootverify209/38/14/native/images и все full thresholds/budgets прошёл.
После окончательного M3 tester/root syntax+selfcheck/minfixture PASS108named,
включая byte-exact comparison finaldriver suffix с исходным V29 cipher-stage
driver. Finalselfcheck
`7669b88c3c181bf719ef292dcb56fc9156dfb91cf25cf42887fb97ec2bcf370e`, rootoutput
`7aacfcf787c8564a11e748fd722c2784054afe2583da4b7de671f7facd7d9781`:
набор namedlabels прежний, sourcehash проверки изменился. Independent review
M3 закрыто; прошлое review проверяло isolatedheadroom, а не соседний helper в
finaldriver. Whole-suffix regression теперь проверяет эту конкретную границу.
Sixsources+rootoutput mode0444 в`experiment-source/preassigned-probe-timing-v2`,
receipt `f6269a52e3f67d720f6f6aae8039811124077b72993b33e99f73e1bbb670e173`.
Finaltransformanchor
`b2432e9198f0f4d3073a9153e9e257ac8d7fa951f63e280f7497c103d947c103`.
Повтор full стартовал13.10.2026 03:59:18UTC, main04:00:54.921UTC. Actual
nginx-t/-T снова PASS, тот же configsourceSHA6c23a334…386cedc; runtimeprooffile
`716e8aff97c6c9122502a205602bba3c3c5e7ee38fea12420b43c8fb34c91d9d`.
Full FAIL76517.805904ms/7652ACK, minLive3260/max5000, reportedloop98.369535ms,
driverexit1; cleanup3445.754172ms verified. Первый threshold04:02:11.418UTC:
kind0 session1195.301221ms/status200, probeUUIDb157157b-c394-4a69-a9f1-ccb0690ce1c7,
response UUID3958c991-19db-457e-bcce-ba40b925ac5a. Cumulative connect77.277391/
secure562.904472/headers1194.989297ms: connect→secure485.627081ms,
secure→headers632.084825ms; driverloop16.179199/max164.757503ms. ExactprobeID
имеет ровно одну nginx запись: request/upstreamheader/response0.272s,
upstreamconnect0.000, authsubrequest fields отсутствуют. Это direct session
proxy, не protected API auth_request. Edge по responseUUID принял запрос
04:02:11.068UTC и завершил11.069UTC за1.293815ms. Clientelapsed и nginxrequesttime
имеют разные начала/концы; нельзя приписать оставшееся время одному участку.

Второй session threshold11.433UTC — уже после первого. Оба API timeout
11.793/11.796UTC также после первого threshold; теперь оба точно связаны с
nginx по заранее заданным probeUUID5547f45a…/60e72a87…. Nginx завершил typed404:
request0.909s, authconnect0.000/header0.272s, mainconnect0.000/header0.637s.
Драйвер timeout сохранил partialtimings до secureConnect, без headers. Эти
post-first observations не используются как причина первого failure. Edgeauth
завершился204 за6.593/10.908ms; API завершился404 за26.251/39.052ms в11.457/11.480UTC,
за336/316ms до соответствующего timeout клиента без headers.
30min/fullre-auth/HUP900s/loadedshutdown не достигнуты; launchProof=false.

Strict prefix V44v2 заканчивается перед ПЕРВЫМ threshold11.418UTC, а не более
поздним mainfailure marker11.439. В75measurement rows600probes,150каждогоkind;
последняя row09.826UTC/74.905s/live3631/7478ACK. Только16completedre-auth
строго до threshold, всеTLSresumed/gaps3401–7279ms;17-я ready11.965 уже после.
Live впервые снизился04:02:04.046UTC/4881; full re-auth не доказан.
Последний gatewaymetric10.193UTC:4008connections/7scheduled/128writing,
77132queued+6296transport=83428records/21741290B. Strictpeak96108records/
25093717B @08.215UTC; IPCpendingpeak3200/838400B. Все шесть IPC rejection/
capacity/childACK/workerunavailable/write_state/frame error counters0.
Processloop maxima:worker1 55.771ms/worker2 98.370ms/owner48.234ms;
reported98.370 относится к worker2, а не owner.

Public nginx135strict completed observer rows заканчиваются11.008UTC,
за410ms до threshold: acceptqueue≤24/latest2, drops/overflows0. Последний
интервал~1.008s:CPU1.014s/throttle0, aggregate2worker runwait551ms.
Strict CPUdelta max2.640s/throttle53660us/3periods за~1.515s; aggregate
runwait max1.107s за~1.436s. Эти интервалы не являются per-request timing
и не устанавливают причину. Role-specific measurementFinishedAt даёт25NGX/
25gateway/25driver снимков:RSSmax664473600/990425088/1295884288B, individual
FDmax5040/2534/5073. Cgroupmemory max691355648/820719616/1270861824B;
суммаRSS и cgroupmemory различаются из-за sharedpages. OOM/oomkill0;
aggregateFD этими individualmax не доказывается. Root подтвердил cleanup
8roles/network/private material и отсутствие контейнеров с owned runlabel.

Live matching выявил неверное предположение root о независимости UUID:
для protected API caller X-Correlation-ID проходит существующий authsubrequest
и становится проверенной correlation metadata в подписанном actor context.
В150/150completed kind1 probes probe=response=auth UUID; в150/150kind0 session
response совпал с nginx responseID и отличался от probeID. `/_edge/authorize`
не отключает request header forwarding; runtime `createCorrelationContext`
принимает только валидный UUID, Edge отдельно проверяет session/operation/
permission и подписывает claims. API проверяет подпись, permissions и равенство
correlation. Direct `/auth/session` отключает caller headers и создаёт свой ID.
Caller UUID не задаёт actor или права. `proxyCorrelationTrustPreserved` в
scratch receipt доказывает только existing business forwarding через
`$edge_auth_correlation`, а не отсутствие caller influence в authsubrequest.
Ранее root утверждал более сильную гарантию; это утверждение неверно и
исправлено. Поведение контрактов/forwarding в V44 не менялось.

### Следующее измерение после V44v2: отправка HTTP и время соединения nginx

V45 сохраняет gateway V39, настройку multi_accept V42, наблюдатель V41 и
идентификаторы проб V44. Только во временном координаторе существующий
edge_safe log получает два строковых поля: `$msec` и `$connection_time`;
transport фиксирует `ClientRequest.once('finish')` существующим монотонным
таймером до `req.end()`. Проверяются отдельные границы преобразования, его
обратимость, хеши, настоящий nginx-t/-T и сохранность хвоста итогового драйвера.
Заголовки, TLS/auth, бюджеты, сроки и критерии приёмки прежние. Новые метки
времени не означают успешную приёмку или внедрение cluster в production.

[`$msec` и `$request_time`](https://nginx.org/en/docs/http/ngx_http_log_module.html#log_format)
относятся к записи лога; request_time начинается с чтения первых HTTP bytes
и заканчивается после отправки ответа.
[`$connection_time`](https://nginx.org/en/docs/http/ngx_http_core_module.html#var_connection_time)
считает возраст TCP connection до logwrite. Разность connection_time−request_time
лишь грубо ограничивает preHTTP интервал, не измеряет отдельно TLS handshake;
nginx timestamp использует cached clock.
[`finish` в Node26.8.1](https://nodejs.org/download/release/v26.8.1/docs/api/http.html#event-finish)
означает передачу последних headers/body локальной ОС, а не получение сервером.
Сопоставляются одинаковые probeID, walltimestamps и cumulative clienttimings;
точность wall/monotonic/cache clocks и single-run causality остаются ограничениями.
`probeStartedAt` записан до подготовки UUID/headers, а transport offsets — от
более позднего начала `request()`: их wall-clock сложение лишь приближённое.
`req.setTimeout(1000)` является socket inactivity timeout, а общий headroom gate
отдельно проверяет elapsed≤1000ms; семантика обоих сохранена. Agentfalse
создаёт отдельный HTTPS Agent для каждой пробы, общего пула между ними нет.

V44 driver до первого threshold:25завершённых role snapshots, DockerCPUpercent
p50 215.35/p95 271.69/max315.95/last267.98 при лимите8CPU. Сырых drivercgroup
CPUusage counters нет, интегральный CPU за интервал ими не вычисляется.
В600completed probes driverloop p95 max15.942ms, loopmax164.758ms; firstfailure
сам записалp9516.179/max164.758. Эти данные не доказывают и не исключают
участие драйвера в задержке; его CPU/RSS лимиты не были нарушены.

Обычный prepare V45 exit0; rootverify209sources/38compiled/14support/native/images
PASS. Manifest `f37f334fdabc98e96f51dd6b44f818771ba55ce55b3afdd682166acb4660714d`,
5000/100/1800000ms, aggregate2CPU/1GiB для nginx/gateway. Root нашёл M4 до
нагрузки: V44END был заменён V45END, отдельного V45START не было. Worker
восстановил обе уникальные пары и перенёс два V45 blocks после V44END.
Syntax/markerorder PASS, итоговый coordinator mode0444/SHA
`46aab62905193d718b2be2f14e68896e34aa25cc5ba69fcec0a67c4cd8bc4af8`.
Tester/root syntax и existing min-fixture PASS109named=108прежних+1V45group.
Успешный ответ, однократный finish до end и ошибки до/после него проверяются
на actual transformed request function; исходный Error сохраняется. Неполные
test doubles и cross-realm comparison исправлены только в selfcheck до нагрузки.
Selfcheck mode0444/SHA
`96a03f93bc71e45884495a9484ebd0c46c17deed7c785d6b356d787aeeca47e6`, rootoutput
`c61928cea3f13eb2001b1d7fd301af65d54ad6c8e2e995d3b3650e796a79a086`.
Independent review PASS, M3/M4 закрыты. Sixsources+rootoutput сохранены0444
в`experiment-source/request-finish-connection-timing-v1`, receipt
`2b3bafeafb7d64abf675efd0e68fd512e8ea3c7d732f82d08fb9abbf2036f5ba`;
V45transform anchor `4ffb1682d4eeea09dd526f9c96352719b9ac6eac885f09cdead3655ba2adb8b5`,
runtimeproof anchor `7af4b7e3b197b464d4b4eb716c79449c2b6773385979950849ee3a66160cac7b`.
V40parser/V42multi/V43timing anchors прежние; V41 изменил только classification,
V44 — пояснение correlation metadata. Full запущен с тем же frozen manifest;
итоговый FAIL описан далее. Actual nginx-t/-T PASS:configSHA
`d2b559d713de1d14d60b004070ce3bf310cc238aa181639ee95cd526730b24ab`,
12raw timing/correlation fields,27authcaptures,2workers/16384connections,
strictUUIDmap и exact healthlog. Runtimeprooffile SHA
`ca142f81795d72e2bd743886ec1c4d29d41171e93c22bbe12acc37605dd7680e`.

Full V45 FINAL: FAIL74280.548630ms/7429ACK, minLive3633/max5000,
reportedloop54.165503ms, driverexit1. Checks replay/reset/slow/evicted/admission/
budgets=true; cleanup3686.414104ms verified,8roles/network/private удалены,
rootownedlabel inventory пуст. Первый threshold04:35:13.220UTC: APIkind1
status404/1071.797060ms, probeUUIDd8d86a7a-2d28-4c5c-b7c6-4d8a6bbb586a,
probeStartedAt12.148UTC. Transportoffsets:connect15.768842/secure220.964518/
finish222.178013/headers1071.502715/end1071.668420ms. Secure→finish1.213495ms,
finish→headers849.324702ms; driverloop p9516.433151/max116.719615ms.
Единственная nginxrow по probeUUID: request379ms, authconnect0/header202ms,
mainconnect0/header177ms; response/auth/probe UUID одинаковые. Edgeauth
принял12.668UTC→12.671UTC/status204/2.107568ms; API принял12.939UTC→
12.946UTC/status404/6.602918ms. Эти handler durations не объясняют clientelapsed.

nginx rawmsec1791866112.980 — cachedlogtime12.980UTC, connection_time765ms.
Из их разностей получаются приблизительные firstHTTP12.601UTC/accept12.215UTC
и preHTTP386ms; это не отдельная TLS duration. От probeStartedAt клиентские
finish/headers приблизительно12.370/13.220UTC, но transportorigin позже
probeorigin. Интервалы до firstHTTP и после cachedlogtime не являются точными
сетевыми границами из-за cachedclock, разных origins и callback scheduling.
Значительная часть ожидания лежит вне measured Edge/API handlers; конкретная
очередь/CPU/сеть этими метками ещё не доказана.

Второй APItimeout13.381UTC — уже после firstthreshold13.220/mainfailure13.232:
probe403a0517-1356-4f3c-9319-be77ced92d88, elapsed1225.849158ms,
secure223.724411/finish223.830672ms, headers нет. Nginxrow status499,
request1164/authconnect379/header942/mainresponse222ms; cachedmsec13.765UTC.
Edgeauth16.798515ms/status204 и API6.228675ms/status404 завершились уже после
firstfailure; они не используются для объяснения первого отказа.

Strict prefix V45 до13.220UTC:73measurement rows/584successful probes,146/kind;
последняя11.772UTC/72.821s/live3890/7271ACK/aggregate loop38.896ms.
25completedre-auth до cutoff, всеTLSresumed, gaps4515–6050ms/p95 6037ms;
38re-authrows total включают postfirst. Отдельного retry counter в reauthfile
нет. Gateway79prefirstmetrics, latest12.134UTC/4123connections/11scheduled/
64writing:84190queuedrecords/21980427B, IPC1511/395882B. Strictqueuepeak
93988/24547918B @11.267UTC; IPCpeak3208/838704B; все шесть IPC rejection/error
counters0. Processloopmax/latest:TLSworker1 43.352/40.174ms, TLSworker2
42.336/41.845ms, owner54.166/36.831ms. Reported54.166 теперь ownerpeak.

136publicNGXobserver rows завершили inner и outer measurements до cutoff,
все statusok. Latest13.131UTC, за89ms до threshold:acceptqueue14/drops0/
overflows0, CPUdelta1.383090s/throttle0, aggregate2worker runwait726.418ms.
Strictqueuepeak20; CPUdelta max2.641254s за1.489s, throttle16892us/3periods
за1.037s, worker runtime max2.638456s за1.489s, wait809.232ms за1.447s.
Это interval counters, не perrequest durations. Role-specific prefirst snapshots:
25NGX/25gateway/24driver. RSSmax663113728/988561408/1284526080B; cgrouppeaks
692854784/819122176/1262649344B; individualFDmax5082/2584/5074, OOMkill0.
DriverDockerCPU p50199.71/p95279.94/max312.97/last281.22%, лимит8CPU; сырых
driverCPUusage counters нет. AggregateFD этими individualmax не доказывается.
30min/fullre-auth/HUP900s/loadedshutdown не достигнуты; launchProof=false.

Следующая диагностика рассматривает CPU генератора на этом сервере;
сначала нужны профили фактических worker threads. Существующий SSE decoder
уже имеет bounded64 exactraw parsecache на объект validate, сохраняет вызов
generated validator и clientcallback для каждого кадра. Его повторное
создание или пропуск wire validation не обоснованы.

### Следующее измерение после V45: CPU генератора нагрузки

V46 меняет только временный диагностический координатор. Только полный driver получает
стандартные Node-флаги `--cpu-prof --cpu-prof-interval=10000` и собственный
каталог `driver-cpu` в существующем trusted `/results` bind. Каждый worker
наследует аргументы; имя профиля включает PID/thread ID. Флаги gateway и
production-код прежние. Условия5000/100/30min, TLS/auth, resource budgets и
все gates сохраняются; `diagnosticOnly=true/launchProof=false`.

После завершения driver profiles проверяются до удаления owned container.
Collector проверяет ownership/state, regular files без symlinks, ограничивает
чтение32files/32MiBperfile/256MiBtotal. Эти лимиты относятся к collection,
Node CLI не ограничивает размер записи. Missing/oversize/partial profiles
попадают только в diagnostic receipt и не заменяют исходный FAIL/Error,
не ослабляют проверки и не мешают cleanup. Forced exit/OOM могут не оставить
полный профиль. Sampling добавляет overhead; V8 sampled time не тождественно
CPU time и должен рассматриваться вместе с фактическими CPU counters.
[Node26.8.1 CPU profiler](https://nodejs.org/download/release/v26.8.1/docs/api/cli.html#--cpu-prof)
и [worker inheritance](https://nodejs.org/download/release/v26.8.1/docs/api/worker_threads.html#new-workerfilename-options)
подтверждают поддерживаемый путь. Независимый короткий локальный probe
исполнителя подтвердил main+worker profile и штатный exit1; это не load proof.

Обычная подготовка V46 завершилась с exit0. Frozen manifest:
`49cc15000f200094457637d8cd80817f56b4e6d649a71d14c1cf55acb36a46c6`, каталог
`/home/yurgusev/.hermes/cache/scratch/issue12-v46-driver-cpu-profile-full-20261013`.
Root `verifyPrepared` подтвердил 209 исходников, 38 compiled files,
14 supporting sources, native adapter и resolved image IDs. Измерение остаётся
5000 клиентов / 100 ACK/s / 1800000 мс; nginx и gateway — по 2 CPU / 1073741824 B.
В проверке до нагрузки исправлено условие профилирования: smoke, fixture-check
и owner-browser не получают CLI-флаги. Координатор заморожен с правами 0444,
SHA-256 `018f523c72a30e79454943e06a41ca83923df92d53f3af7f5d6cfbf1bac477b7`.
Подготовка и контроль hashes не подтверждают нагрузочные критерии.

Исполнитель и root: syntax checks и существующий min-fixture — PASS,
112 уникальных named groups (109 прежних и 3 V46). Проверяются actual-source
launch/collector/finalizer, прежние mounts/budgets, exit0/1, owned label,
OOM/running/abnormal exit, symlink/malformed/oversize/count/total limits,
исходный Error и продолжение cleanup при ошибке диагностического отчёта.
Root inverse восстановил V45 побайтно; независимое ограниченное ревью — PASS.
Selfcheck SHA `ff3508fbb78dc57d49abc4b2a8979b0139237c93e399816904c8b4c715ec1c59`,
root output SHA `915d7c5c310cc9e745733311a18d8177a9e37ed64b0d8e8fdc2c6da563d60d45`.
Шесть исходников и root output сохранены с правами 0444 в
`experiment-source/driver-cpu-profile-v1` внутри V46-каталога; receipt SHA
`e76ac186c62c0eafb4cf31bec736e396e842ddaeeafe79a331cb7472bd5af8a4`.
Статус `captured` означает сбор найденных валидных файлов, а не подтверждение
профилей всех threads. Эти проверки используют fixture и подставные Docker
receipts; фактический сбор под нагрузкой пока не подтверждён.

Full V46 завершился FAIL через 74320.260250 мс / 7433 ACK:
`HEADROOM_LATENCY_EXCEEDED`, session probe 1104.669382 мс при пределе 1000.
Измерение началось 05:05:26.382 UTC; minLive3632/max5000,
gateway event-loop maximum p95 — 50.364415 мс. Replay/reset/slow/evicted/admission
и budgets прошли наблюдавшиеся проверки; 30 минут, полная re-auth,
HUP и loaded shutdown этим результатом не подтверждены.
Cleanup3650.629206 мс verified: 8 roles, network, synthetic private material;
root подтвердил отсутствие owned containers.

Collector получил 11 валидных файлов: main thread0 и workers1–10,
3363543 B; driver остановлен с exit1, OOMKilled=false. Profiles main охватывают
150.846047 с, worker profiles — примерно 97–98 с: в них включены preflight,
initial admission и завершение после первого нарушения, а не только main.
Все файлы прошли ownership/name/size/JSON/hash checks. Sampling overhead и
sampled wall-time сохраняют ограничения интерпретации; анализ hotspots ещё
не завершён и не разрешает менять проверки wire/schema.

Первая threshold row — 05:06:40.693 UTC, kind0,
probe `ed2a1cd5-54f0-4aeb-b99c-2530886aeed7`, start05:06:39.588,
status200, correlation `0cca3ab0-0d8f-4385-a3a1-9b741878c9dc`.
Transport offsets: connect22.743/secure424.792/finish454.444/headers1104.318 мс;
driver loop p95 16.253/max155.714 мс. Единственная nginx row того же probe
даёт request260ms/upstream260ms, msec1791868000.528/connection_time738ms;
Edge `/auth/session` 05:06:40.316→40.323, responseTime7.063235ms.
Возраст TCP, cached nginx clock и локальное событие finish не дают точной
разбивки остальной задержки. Конкретный session handler не объясняет все1105ms.

Независимый анализ и отдельная проверка подтвердили hashes/размеры/samples
всех 11 profiles. Workers: 88279 samples / сумма timeDeltas978.968s,
idle702.312s (71.74% sampled time), GC8.906s (0.91%). Self:
frame28.973s/2.96%, push18.479s/1.89%, onFrame14.012s/1.43%,
validate20=9.736s/1.00%, ulidTime9.617s/0.98%, nowMs8.534s/0.87%.
Main отдельно:14205samples/150.841s, idle133.061s/88.21%.
Inclusive с устранением повторов одной function identity внутри sample:
Readable.push188.917s/19.28%, protocol.push135.993s/13.89%,
frame104.460s/10.67%, onFrame45.915s/4.69%, validate20=21.109s/2.16%.
Первое Readable.push35.02% считало повторные вложенные frames; исправлено
до интерпретации. Inclusive stacks перекрываются; эти величины не CPU-секунды.
Whole profiles не выделяют acceptance interval и не доказывают полезность
нового кеша или пропуска generated validation. Replay уже coalesces только
внутри существующих live windows; raw IDs и порядок выбранных hints сохранены.

Post-run clock probe Node26.8.1:10samples в именованной100msфункции совпали
с process.hrtime в пределах1ms, receipt `profile-clock-calibration.json`.
[V8 POSIX TimeTicks](https://github.com/nodejs/node/blob/v26.8.1/deps/v8/src/base/platform/time.cc)
использует CLOCK_MONOTONIC;
[profiler](https://github.com/nodejs/node/blob/v26.8.1/deps/v8/src/profiler/cpu-profiler.cc)
берёт timestamps из этих часов. Post-run UTC offset1791551646860549us
отображает startTime всех11profiles в ту же UTC-секунду, что и их filenames.
Это позволяет приблизительное сравнение участков при допущении отсутствия
wall-clock steps и container time-namespace offset. Отдельного доказательства
этих допущений за всё окно нет; строгую UTC-атрибуцию или причинность таким
сопоставлением не заявляем.

Приблизительные окна с этим post-run offset: обычная нагрузка
05:05:40–05:06:10 и re-auth05:06:30–05:06:39 (последнее оканчивается
за1.693s до первого threshold). Workers:299.994s/27195samples и
89.957s/8288samples, idle73.78%→68.24%; self frame3.42%→3.19%,
push2.29%→2.11%, onFrame1.57%→1.68%, validate20=1.14%→1.19%.
Относительного всплеска этих JS paths не видно. Сдвиг часов и sampled-time
ограничения не позволяют объявить это строгим причинным доказательством.
Последние полностью pre-cut snapshots десяти shards05:06:39.297–39.425:
live p95 938–974ms, replay p95 3801–4849ms; replay80–401frames/shard.
Это cumulative counts, не число уникальных raw-кадров или cache misses.

В whole-profile `frame` positionTicks:21nodes/2575ticks,
Map.get(raw) line102=1794, cache-hit branch line103=442, JSON.parse line113=35.
PositionTicks не разделены по фазам; увеличение cache64 ими не обосновано.
Следующий ограниченный benchmark проверяет другой индекс существующего cache:
prefix64 только для поиска, полный cached.raw===raw для подтверждения hit.
Лимит64, generated validator каждого кадра, callbacks, UTF8/byte/field/order
checks и отдельные копии сохраняются. Это только временный кандидат; пользу
и корректность ещё надо измерить до изменения исполнимой фикстуры.

Prefix-index benchmark отверг кандидат: actual invalidationFrame258B/5LF,
generated AJV validator и callbacks каждого кадра сохранены; обе реализации
прошли same-prefix payload collision, mutation, validator identity, order,
unknown-field и 65th-entry eviction. Шесть измерений каждого варианта
на ширинах1/25/64 по6000push дали медианы baseline→candidate:
20.406→22.312ms,20.375→22.067ms,21.308→20.985ms. Устойчивого выигрыша нет,
вариация сопоставима; код не применён. Скрипт, прототип и исходный output
с hash verification сохранены в `follow-up-benchmarks/raw-prefix-v1`
V46-каталога, receipt SHA
`f2fb6fc6e18cbc601ae4250ad7d9bdfcd70891f7b79c55083a3e9f6b9605b586`.
Эта короткая проба включает JIT/warmup ограничения и не является load proof.

Следующий кандидат убирает только подготовку текста AssertionError для валидного
кадра в `transport.wireValidator`: `check(data)` по-прежнему вызывается перед
проверкой результата, `ajv.errorsText` — только при отказе. Первый benchmark
содержал formatter wrapper в timed path; его цифры не используются как оценка
выигрыша. Отдельный чистый замер извлекает фактическую функцию, компилирует
generated schemas один раз на вариант и использует обычный Ajv без wrappers
в timed path. Actual invalidationFrame258B/5LF, fresh Buffer каждого push,
20K warmup и20Kpush/run, ABBA3повтора: width25 baseline69.49ms
(68.59–72.31)→candidate51.53ms (49.64–52.79); width64 69.96ms
(68.27–71.54)→52.52ms (51.39–54.27). Callbacks/checksums совпали.
В отдельной correctness stage совпали AssertionError name/message/actual,
включая undefined для неизвестного event, expected/operator/code.
Её счётчик оборачивает returned validator: direct unknown event даёт одну
попытку вызова и ноль compiled schema checks. Число schema checks в чистом
timed path следует из сохранённого кода, не измеряется счётчиком.
Четыре исходных scratch-артефакта сохранены0444 в V46-каталоге
`follow-up-benchmarks/lazy-validator-message-v1`, archive receipt SHA
`ee77cf3fb91e414e4a8681fce8a439220ff40b6f1bdf1b81eedaef11bfe4df37`.
Это microbenchmark текущего сервера; 5000/100/30min им не подтверждены.
Минимальная правка helper и один тест существующего harness проверены:
worker syntax/targeted1/1/harness29/29 PASS; независимый tester также29/29
без пропусков, reviewer bounded PASS. Actual Ajv.compile checks: ready/reset/
invalidation/cache-hit=4, invalid additional field ещё1; direct unknown=0.
Valid formatter=0, failures=1каждый. Root inverse вернул два файла в точные
SHA исходников V46 после удаления только этих изменений; чужие пути не менялись.

### V47: полный повтор с отложенным сообщением валидатора

Обычная prepare завершилась exit0; frozen manifest
`91d17933f4d2e7330a16c402071d915330bd77d25f93a9147e08675117f78823`,
каталог `issue12-v47-lazy-validator-message-full-20261013`.
Root verifyPrepared подтвердил209source/38compiled/14support, native/images,
5000/100/1800000 и прежние2CPU/1073741824B для nginx и gateway.
Все шесть scratch source файлов V46 переиспользованы байт-в-байт,
включая profiler flags и внутреннюю classification
`diagnostic-only-v46-driver-cpu-profile`. Trial называется V47 по новой
фикстуре; переименование classification не выполнялось. Архив0444
`experiment-source/reused-v46-driver-profile`, receipt SHA
`def4c904594d4c544109440dd8c7dfcd71b07c90a1bfcda05468ff06105589c2`.
Прежние112scratch checks не повторялись: координатор и prototype неизменны;
изменённый helper проверен новым actual generated-validator regression.
Команда: `PATH=/tmp/coffee-12-proof-bin-jBGChb:$PATH node /tmp/coffee-12-cluster-diagnostic.mjs --prepared /home/yurgusev/.hermes/cache/scratch/issue12-v47-lazy-validator-message-full-20261013 --approve-manifest 91d17933f4d2e7330a16c402071d915330bd77d25f93a9147e08675117f78823`.
Full завершился exit1/FAIL через74470.353487ms/7448ACK, minLive3625/max5000,
max reported loop45.711359ms. Replay/reset/slow/evicted/admission/budgets прошли;
30min/fullre-auth/HUP/loadedshutdown не достигнуты. Первый known failure:
`headroom-request-error`05:42:19.076UTC, kind1/API,
probe `b7af17dd-ae82-4663-8dee-cf63907d12c7`, start05:42:17.881,
1194.140271ms, secure176.514564/finish184.635019ms, response headers отсутствуют.
Общий failure marker19.127 идёт позже; second API error19.078 тоже не причина
первого. Единственная nginx row того же probe: status404/request910ms,
auth connect261/header688/response688ms, API upstream222ms,
msec1791870139.034/connection_time1.115s. Edge authorizer18.568→18.570,
response2.271682ms; API18.844→18.850, response5.784448ms.
Cached nginx clock и разные timer origins не дают точной разбивки задержки.

Последние10shard snapshots05:42:17.180–17.373 строго до отказа:
live p95861–878ms, replay3700–4546ms; replay80–789frames/shard.
В V46 live p95938–974ms; один run/разные виды первого отказа не доказывают
причинный эффект helper. 30completed re-auth до19.076, все resumed,
gap4343–6618ms; всего37rows включают post-cut. Retry rows0.
Cleanup3575.158090ms: verified8/8roles/network/private; owned Docker inventory0.

Независимая сверка подтвердила SHA/size/node/sample counts всех11CPUprofiles,
3291886B, driver exit1/OOMfalse. Workers V46→V47:978.968→984.264s
sampled time, idle71.740→74.032%; frame self2.960→2.641%,
inclusive10.670→9.486% с дедупом function identity внутри stack.
ErrorsText V46:8sample slots/0.1154s; V47:none sampled. Whole profiles включают
admission/preflight/post-cut и inlining; отсутствие named sample не измеряет
полную стоимость callsite и не доказывает capacity gain.

Direct cgroup comparison: V46 номинальное05:05:40–06:10 и re-auth06:30–39;
V47 номинальное05:41:20–50 и re-auth05:42:08–17. Интервалы целиком внутри окон,
kernel timestamps unique; V47 фильтр outer capturedAt И kernel endedAt<19.076
даёт149unique reads. Cached inner read19.045 с outer19.997 исключён.
V46 gateway:29intervals/29.074s, CPU52.233s/89.83%2CPU,
throttle1513periods/13.097299s; re-auth8/8.046s,CPU14.886s/92.51%,
throttle455/3.363410s. V47:29/29.040s,CPU52.998s/91.25%,
throttle1618/14.286162s; re-auth8/8.308s,CPU15.348s/92.37%,
throttle539/4.712596s. Throttled time — cgroup counter, не задержка запроса.
Nginx quota use V46:64.2→67.1%; V47:66.22→64.53%, re-auth throttle0,
acceptqueue0 в выбранных V47окнах. Суммарный schedstat runqueue wait двух
nginxworkers V47:9.846s/29.013s и2.792s/7.990s; это не request attribution.
Driver Docker sparse samples примерно239–272% при cap8CPU; raw driver CFS нет.
Высокая загрузка gateway наблюдается в обеих фазах; причина API deadline
и выигрыш иной process configuration этими цифрами не установлены.

Следующий ограниченный scratch-кандидат V48 уменьшает число TLS workers до
одного в пределах разрешённого процессного эксперимента. Sole Kafka/replay
owner сохраняется. Runtime-код зависит от одного `WORKERS`; process/generation/
PID/loop проверки координатора ожидают ровно1TLS+1owner. В full nginx сохраняет
2workers; reference smoke использует1worker. Общие full2CPU/1GiB, queues/bytes/5swrite deadline,64active targets/worker,
TLS/auth/framing и все acceptance gates сохраняются. Поэтому суммарное окно
активных IPC targets станет64 вместо128; риск роста очереди и latency
проверяется smoke и full. Это первый one-TLS вариант.
Только новые `/tmp/coffee-12-v48-*` файлы; V46 frozen sources неизменны.
Порядок: actual-source guards/tests → tester/reviewer → freeze →512/120s
smoke →full5000/100/30min при успешном smoke. Throughput пока не доказан,
production runtime и канонические документы этот кандидат не принимают.

V48 source/tester/reviewer/root проверки прошли: gateway отличается от V46
только `WORKERS=2→1`; coordinator — expected process counts, source paths,
hash/classification и соответствующие receipts. Configured start ждёт один
fork/LISTENING PID; mismatch PID и stale LOOP остаются fail-closed.
Все6syntax checks и existing min-fixture PASS. Root повторил после исправления
устаревшего имени readiness group:112unique checks PASS, root output SHA
`ac9bf7ba8a3ca17c9a0b48242c579a9ec64324b761329363213aa9a83f5c96dd`.
Отдельные fake-log cases с двумя TLS ready records/отсутствующим PID не
добавлялись; actual coordinator сохраняет strict count/PID/generation guards.
Generic two-worker fairness/queue units сохранены для неизменённых методов.
Шесть новых scratch sources0444 и root output архивированы в
`issue12-v48-single-tls-source-20261013`, source receipt SHA
`a3ddca9e5539d6a86ef592733411bde9c2c6f4151d7303f39cb669fe07cc48b7`.
Команда smoke: `PATH=/tmp/coffee-12-proof-bin-jBGChb:$PATH node /tmp/coffee-12-v48-diagnostic.mjs --smoke --profile reference-512 --smoke-duration-ms 120000 --result-dir /home/yurgusev/.hermes/cache/scratch/issue12-v48-single-tls-smoke-20261013`.
Smoke завершён exit0 /DIAGNOSTIC_PASS, manifest SHA
`34a59d65d482d221aae362869bf710c82c6e187d06a3a07f02d1efadb0c67ac5`.
120000.295ms/12001ACK, p95event309ms/maxprocessloop26.722303ms;
все11checks true. Admission513 pre-header typed503; re-auth512/512,
unexpected0/pending0, gaps max3241/p953182ms, finalLive512.
Минимум live172 относится к ожидаемому TTL cohort; retry3000/ready10000ms
сохранены. Session refresh не достигнут при duration120s.
Actual HUP дал1new nginxworker за77.450ms; liveBefore/After512.
Loaded shutdown:512armed/live/closed/unique receipts, workerErrors0,
forcedfalse/timedOutfalse, elapsed613.977850ms.
Cleanup3142.4375ms verified:8roles/network/private удалены, owned label
inventory пуст. Process receipt:soleowner host866161/namespace7 и одинTLS
host866475/namespace45. Reference nginx1worker, gateway/nginx2CPU/512MiB;
source receipt nginx2workers/1GiB описывает full кандидат, не этот smoke.
Profiler disabled по прежней full-only policy. Это ограниченный live proof,
30минут/5000/full re-auth/session refresh им не подтверждены.

Обычный full prepare завершён; root `verifyPrepared` сверил209sources,
38compiled/14support, native adapter,3image IDs и точные5000/100/1800000.
Gateway/nginx каждый2CPU/1GiB, nginx2workers; текущие helper/test hashes
совпали с frozen inputs. Full manifest SHA
`18b77c3040ebd2d168f29be7f88548ab665837a95de3278b370ed3107db5358b`.
Шесть source files, immutable source receipt и root112selfcheck скопированы в
`issue12-v48-single-tls-full-20261013/experiment-source/single-tls-v48`.
Команда full: `PATH=/tmp/coffee-12-proof-bin-jBGChb:$PATH node /tmp/coffee-12-v48-diagnostic.mjs --prepared /home/yurgusev/.hermes/cache/scratch/issue12-v48-single-tls-full-20261013 --approve-manifest 18b77c3040ebd2d168f29be7f88548ab665837a95de3278b370ed3107db5358b`.
Full завершён exit1/FAIL77119.514989ms/7713ACK, main06:13:56.736UTC.
Admission5000 unique/5001 pre-header503 подтверждён. minLive3076/max5000,
maxreportedprocessloop64.651263ms. Первичный result error —
`REAUTH_ESTABLISHMENT_FAILED: SSE preheader rejection: 500`; первый известный
failure marker06:15:13.857UTC/live3074. В raw reauth487retry504 и нет
завершённых recovery receipts. Первый наблюдавшийся nginx500 имеет
requestId`cfa0d325e4f0dd3069259e6e0627d6fb`, msec1791872113.620,
request/auth response1.048s, authconnect/header`-`, mainupstream пуст.
Связь с конкретным failed client request по ID пока не установлена.
Далее health kind2 завершился1325.184ms, secure689.475ms/headers1323.796ms;
session/API request deadlines появились06:15:14.241–14.254 после primarymarker.
Эти поздние пробы не подменяют первичную причину отказа.
Replay/reset/slow/eviction/admission/budgets checks true; финальныеeventp95,
30min/full re-auth/session refresh/HUP/loadedshutdown не получены.
Profiler включался только в full:11files3495068B, driverexit1/OOMfalse.
Cleanup3560.122528ms verified,8roles/network/private удалены; rootowned
inventory пуст. OneTLS не устранил full failure и не принимается в production.
Classification diagnostic-only/launchProof=false сохраняется.

Независимая strict-cut сверка V48: cutoff06:15:13.857UTC. До него584
завершённых headroom probes/146каждогоkind с ожидаемыми статусами. API p95
130.2/max169.3ms, sessionp9591.7/max133.9ms, publichealthp9580.2/max108.5ms,
directgatewayp95125.8/max815.6ms. Reauth453retry504 до cutoff из487total.
Gateway kernel:151unique actual reads с обоими outercapturedAt и innerendedAt
до cutoff; quota20000/10000us, acceptqueue max212/latest209 при13.123.
Drops/overflows0; sampled CFS throttle существует, но не является причинной
атрибуцией конкретного ответа500. TLS snapshot13.349:accepted5986/secure5566,
resumed5335/cold231, errors=missingStart342/pending78. Такие ошибки не имеют
accept-start timing и не классифицируются как crypto failure.
Последний metrics12.544:live3629/totalqueue70428records18.41MB; максимум
89727records23.44MB, queue-cap/IPC rejection/ACK errors0. Процессныеloopp95
TLS64.65/owner35.26ms. Nginx public138unique completedreads до cutoff,
latest13.548/queue5, max18/drops0/overflows0. Суммарный schedstatwait обоих
workers не является per-request delay. Cgroup memory peaksNGX684433408B/
GW723554304B, OOM0; sparse host samples заканчиваются раньшеfailure.
Nginx за06:15:13 записал144TLShandshake timeout кrealtime,1кauth и1unexpected
auth504. V47 twoTLS acceptqueue max19 противV48max212 согласуется с меньшей
приёмной ёмкостью oneTLS, но оба runs FAIL и причинный выигрыш не доказан.
Root сверил все11profile hashes/bytes/nodecounts/samplecounts:3495068B PASS.

### V48-AUTH1: ошибка наследования nginx error pages

Доказан отдельный P2 в `tools/nginx/generate.mjs`: локальный `/events`
`error_page503=@realtime_capacity` отменяет наследование всехserver errorpages,
включая500→@auth_503 и401/403/502/504. Это соответствует
[официальному правилу nginx](https://nginx.org/en/docs/http/ngx_http_core_module.html#error_page).
Actual V48 errorlog connection`*13563` последовательно содержит TLS handshake
timeout кEdge`/_edge/authorize` иunexpected authstatus504; access записывает
raw500 вместоtyped503`AUTHORIZER_UNAVAILABLE`. Exact failed client ID не
сопоставлен, но ошибочная классификация этой nginx connection доказана.
Исправление ограничено existing generator/error mappings и existing cutover
test: недоступный authorizer для/events обязан вернутьtyped503, не открытьSSE
и не дойти доrealtime upstream; отдельный capacity503 сохраняется.
Правка завершена в двух owning files: только/events задаёт внутреннийlimit_conn
status429, server mapping429→@realtime_capacity сохраняет наследование всего
typedнабора. Другогоgenerated429 нет; business upstream errors не
перехватываются, поэтому их429 не преобразуется вcapacity. Public SSE
admission сохраняет503/code, authfailure503 получаетAUTHORIZER_UNAVAILABLE.
Existing cutover test расширен typed401/403, authorizer-down/events503 без
realtime upstreamcall и admission-boundary503capacity. Последняя проверка
использует exact test-only512→1override с одним уже обслуживаемым stream;
полный профиль5000 не сокращается. Worker `pnpm test:nginx-cutover`,
`pnpm nginx:check`, syntax2/diffcheck PASS. Root exact inverse двухgenerator
anchors восстановил прежнийSHA4305a99bbdf2ef8d75e544b8eba00e9cbf0e7041ed0ce22b79cf05b98bc38337.
Final generatorSHA`ba20518daa18bcad9ccadc56b8f07d57665951183b206f7c5d7be6ea9b1cfc96`,
cutoverSHA`233c8ed3268b1a01a1b1f54c8246f069d7c26069acd242646ef8518f1928bf07`.
Независимое finalreview PASS, обаfinalSHA подтверждены. Это contract correctness fix;
происхождение handshake latency и full capacity им не решены.

### V49: чистый контроль после validator helper и AUTH1

OneTLS V48 отвергнут. Существующий frozen V45 coordinator возвращает2TLS+sole
Kafka/replayowner безCPUprofiler. Новый script/тюнинг не добавляется: текущая
lazy-validator-message правка ранее проходила full только сV46profiler, аV48
одновременно уменьшилTLSworker count. Один unprofiled контроль устраняет
этот дополнительный фактор без обещания performancegain.
Пользовательские5000/100/30min, TLS/auth/TTL/retry/re-auth/replay/latency,
2CPU/1GiB каждогоgateway/nginx,64slots/worker и2nginxworkers прежние.
Reviewer/root сверили archive coordinatorSHA
`46aab62905193d718b2be2f14e68896e34aa25cc5ba69fcec0a67c4cd8bc4af8`;
gateway/patch/cipher нынешних/tmp побайтно совпадают сV45 source receipt.
Исполняется архивныйфайл; import.meta.filename привязывает receipts к нему.
TrialV49 сохраняет прежнююclassification
`diagnostic-only-v45-request-finish-nginx-connection-timing`, launchProof=false.
Normal prepare новогоsnapshot завершён послеAUTH1 workerchecks; root
`verifyPrepared` PASS209sources/38compiled/14support/native/images/exactgates.
ManifestSHA`5bd668755baee395c2b549c1f0b0466b01c321dc5084cbfd17918d39b595d4b4`.
Sixsources/priorroot109selfcheck сохранены0444 в
`issue12-v49-unprofiled-auth-mapping-full-20261013/experiment-source/reused-v45-unprofiled`;
reuse receiptSHA`2c17a4cfd9efbab82a73547fc253e8bf22a7ff883f028011344a1072f373239b`.
При неизменных source прежний109selfcheck не повторялся; новыеvalidator29/29
иAUTH1 nginxruntimechecks/review прошли отдельно. FinalreviewAUTH1 PASS.
Full завершён exit1/FAIL74509.346904ms/7452ACK. Main06:34:16.295UTC;
maxLive5000/min3683, reportedprocessloop45.449215ms. Initial5000unique и
5001pre-header503 подтверждены; preflightreplay/reset/slow/eviction/budgets true.
Первый marker06:35:30.790UTC: sessionprobe
`55878802-d5ee-402e-8c1e-e0400c4e63c7`, start06:35:29.478,
deadline1308.351630ms; created5.208/socket110.827/lookup136.708/
connect151.222/secure304.015/finish304.142ms, безheaders. Драйверloop
p9516.015/max135.791ms; offsets не являются длительностями отдельных фаз.
APIdeadline06:35:30.793 позжепервогоmarker. Только4re-auth receipts,
всеTLSresumed, полногоrecovery нет. НикакогоCPUprofiler/profilefiles здесьнет.
Полныеeventp95/30min/re-auth/session refresh/HUP/loadedshutdown не достигнуты.
Cleanup3531.944954ms verified:8roles/network/private удалены, rootowned
inventory пуст. Unprofiledконтроль также не прошёл; отсутствиеprofiler
не обеспечиваетcapacity. АрхивыV45/V46/V48 не меняются.

Точный session probe сопоставлен с nginx request
`68f7617be82cf077332438d331cc0df6` и Edge correlation
`9fdf8e51-4dbe-42a1-9f99-702d9694bf9c`. Edge принял запрос в
06:35:30.396 и завершил его в 30.403: HTTP 200, 5.767186 ms. nginx записал
HTTP 200 в 30.747, request/header/response time 882 ms и upstream connect
288 ms; age TCP connection 1.085 s не является длительностью TLS handshake.
Deadline marker клиента появился в 30.790, без полученных headers.
Завершение серверного запроса по этим часам не доказывает момент отправки
headers в сеть или возможность клиента их прочитать. Номинальный timer
1000 ms также не равен времени исполнения callback. Причина задержки между
серверным ответом и клиентским событием остаётся неустановленной; итог FAIL
сохраняется.

Строгий срез наблюдателей до первого marker включает 139 уникальных nginx
и 148 gateway измерений, у которых завершились и внешний, и внутренний
интервалы чтения. nginx accept queue достигала 21, gateway — 31; drops и
overflows не наблюдались. Gateway имеет CPU quota 2 CPU и за один интервал
накопил до 1.299247 s throttling; nginx workers показывают scheduler wait
до 1.267345 s в сумме. Такие суммы не приписываются конкретному запросу.
Последние полностью завершённые host measurements: gateway 184.08% CPU
в 06:35:22.830–24.840, driver 253.14% в 24.841–26.851, nginx 129.93%
в 26.876–28.896. Измерения последовательны, поэтому их нельзя складывать
как одновременную нагрузку сервера. Последние gateway metrics в 29.456:
4023 live, 78111 records / около 20.37 MB queue, IPC pending 2726;
rejection и ACK errors отсутствуют. CPU отдельных Kafka owner и TLS workers
в этих артефактах не записан. Ни IPC, ни конкретный процесс не объявляются
причиной session deadline.

### V50: ограниченное измерение CPU отдельных процессов

Следующий диагностический fork существующего V45 coordinator добавляет
в уже имеющийся sampler bounded чтение `/proc/PID/stat`: raw CPU ticks,
process starttime, число threads и время чтения. Существующий nginx observer
с `schedstat` остаётся прежним. Ошибка или
исчезновение PID сохраняются как недоступное диагностическое измерение,
не подменяют обязательные RSS/FD/OOM проверки. Cadence, runtime, 2 TLS
workers + sole Kafka/replay owner, gates и бюджеты остаются прежними.
Новый sampler не меняет CPU weights, quota, affinity, TLS или wire format.
Цель — разделить затраты процессов до выбора следующей runtime правки;
выигрыш и capacity PASS ещё не заявлены. Старые frozen источники не меняются.

Source/test review V50 PASS: coordinator SHA
`c17b97340c8bd664eb9a2698fd499925ba5a8ad3d7170d38e47ccadddd6f2ac3`,
self-check SHA `fb16978d8eb4b37f292832e435d85a584cbb43a7608709c7a158b92835a93dd3`.
Независимый self-check проверил 6 новых actual helper групп и 112 legacy групп
через reused V46 min-fixture; legacy набор не объявляется прогоном V50.
Exact inverse V50 восстанавливает frozen V45 coordinator SHA
`46aab62905193d718b2be2f14e68896e34aa25cc5ba69fcec0a67c4cd8bc4af8`.
Final tester log SHA `c409cc40d43016f4e369a300967303baf7b843b2994503d5fa01a4f112e633f7`.
Два bounded stat-read проверяют PID/starttime, счётчики сохраняются decimal
strings; число threads берётся из stat field 20 без дополнительного status-read.
На этом сервере `getconf CLK_TCK` вернул 100, kernel `6.8.0-146-generic`.
Восемь source/dependency файлов, tester log и receipt сохранены 0444 в
`issue12-v50-process-cpu-full-20261013/experiment-source/process-cpu-v50`;
source receipt SHA `ed2aef4b5f0fb329947e1b465384509ebec7b3ebd57beca70596ff9458d44797`.

Первый V50 run не начал нагрузку: ERR_ASSERTION в `verifyPrepared` обнаружил
изменение `tests/realtime/fixtures/owner-browser.mjs` после подготовки manifest
`17dc110039a28e45691d9c927d9a34357bda366886503f4e8c31d4f736e5d277`.
Подготовка была выполнена root до завершения независимой EOF test правки.
Это pre-start provenance failure, не новое наблюдение capacity bottleneck:
duration 0, ACK 0, контейнеры и сеть не создавались; cleanup 799.274659 ms,
private material удалён, verified true. Guard и frozen manifest не менялись.
После завершения test diff нужен свежий обычный prepare, не обход проверки.

Дополнительная сверка scheduling: канонический Hub создаёт отдельный
`setInterval(authCheckMs)` при открытии каждого соединения; scratch patch
сохраняет этот код. V37 меняет ISO timestamp construction для ready/heartbeat,
а не фазу auth sweep. Гипотеза о едином ошибочном global auth timer не
подтверждена; TTL/retry/auth cadence по ней не меняются.

V50 retry после завершения EOF test diff: обычный prepare и `verifyPrepared`
PASS 209 source / 38 compiled / 14 support, native adapter и 3 image IDs.
Manifest SHA `f8dc8d3f264bfdc56c2d79901e324959c85f501021bbc5e00a0abb02794ef850`;
измерение 5000 / 100 ACK/s / 1800000 ms, gateway и nginx по 2 CPU / 1 GiB.
Те же frozen V50 sources/test/dependencies скопированы 0444 в
`issue12-v50-process-cpu-full-retry-20261013/experiment-source/process-cpu-v50`;
новый source receipt SHA
`b5eb4dd10852f2871bc733341c64d3be6046b11024843683dcefdf486d9f45b7`.
Повторный self-check не нужен при byte-identical source reuse; предыдущие
actual helper checks и inverse proof сохранены, current helper hashes сверены.

V50 retry full завершился exit 1 / FAIL через 75371.666003 ms / 7538 ACK:
`gateway event-loop p95 >100ms`, reported 102.105087 ms. Первый failure sample
07:22:37.633UTC; перед ним sample 37.243 имел live3493 / maxprocess p95
44.400639 ms, owner37.453823 / TLS workers40.534015 и44.400639 ms.
MinLive3425/max5000; admission5000/5001 и preflight replay/reset/slow/evicted/
budgets true, re-auth receipts только6. 30 минут, fullcohort recovery, session
refresh, HUP и loaded shutdown не достигнуты. Raw per-PID CPU ticks/starttime/
timestamps записаны; строгая атрибуция до первой ошибки разбирается отдельно.
Проценты или события после marker не используются как причинное evidence.
Cleanup3883.328790ms verified:8roles/network/private удалены. Прогон не даёт
capacity PASS, production adoption или основания для merge.

Независимый строгий разбор V50 использует cutoff самой threshold metric
07:22:37.610UTC, которая предшествует driver marker. TLS worker1/pid45
102.105087 ms, TLS worker2/pid46 64.716799 ms, owner/pid7 39.616511 ms.
Последний полностью завершённый pre-threshold per-PID CPU интервал:
owner66.52%, TLS workers62.58%/61.42% одного ядра; process total около1.90 CPU.
Ticks пересчитаны при CLK_TCK100, только пары одинаковых PID/starttime и
собственные sampleFinishedAt плюс обязательный role measurementFinishedAt
строго до cutoff. Последний owner kernel срез inner end36.213: quota
20000/10000us, delta usage1,612,482us за около0.882s, throttle50periods/
144,338us. В более ранних интервалах cgroup регулярно достигал около2 CPU;
max throttle delta1,432,978us/95periods. Это ресурсное ограничение, но не
доказательство единственной причины TLS-worker всплеска.

До cutoff 149 уникальных gateway nested observations и136 nginx observations
с завершёнными внешними/внутренними интервалами. Последний nginx inner end
37.078: accept queue0, drops/overflows0, quota2CPU, throttle delta0;
aggregate worker scheduler wait549ms не приписывается конкретному запросу.
Latest gateway metrics36.621: live4140, queue95094records, total26,486,939B,
IPC pending3155, rejects/ACK errors0. Только2re-auth закончились доcutoff,
обаTLSresumed, gaps4839/4851ms; четыре остальных завершились послеcutoff.
OOM/OOM-kill0, FD/RSS бюджеты соблюдены. CPU counter sampling сам по себе
не измеряет стоимость конкретных crypto/IPC/fanout функций.

### Следующее направление после V50: отдельный контроль CPU quota

Предложен один ограниченный диагностический контроль на этом же сервере:
изменить только **общую CPU quota realtime-gateway с2до3 CPU** при прежнем
period10000us. Сохранить1GiB gateway, nginx2CPU/1GiB, двух TLS workers и
одного Kafka/replay owner, CPU остальных ролей, TLS/auth, TTL/retry,
5000/5001,100ACK/s,30min, event/loop/headroom thresholds, queues, cleanup и
loaded shutdown. Никакого изменения affinity/weights, wire, public payload,
dependencies, replicas или production config. Этот counterfactual проверит
влияние измеренного cgroup ceiling; выигрыш не доказан, дополнительный CPU
может усилить конкуренцию с nginx/driver на том же i7-930.
Manifest исходного2CPU профиля сохраняется; approved override, реальные
Docker inspect/cpu.max и source hashes должны явно фиксировать3CPU.
Такой результат не засчитывается за согласованный2CPU capacity PASS и не
принимает production resource policy автоматически. Если3CPU помогает,
окончательный бюджет/spec/config/handoff требуют принятого решения до merge.
Если не помогает, больше CPU не объявляется исправлением и критерии не
ослабляются. 13.10.2026 пользователь явно разрешил этот один диагностический
контроль3CPU. Новый V51 fork меняет только FULL gateway quota30000/period10000;
reference512 остаётся2CPU. Production policy не изменена. До запуска root
проверяет source/test diff, замораживает hashes и отдельный override receipt.
Ответ не разрешает повторные3CPU варианты или автоматическую production adoption.

V51 обычный prepare завершён: original manifest SHA
`3767bfef3ef08737500e5f6a94f7366fb6e17ba932f73b8f71ecee68ebcfb0bf`.
Root `verifyPrepared` PASS209source/38compiled/14support/nativeadapter/imageIDs.
Baseline manifest хранит gateway2CPU/1GiB и nginx2CPU/1GiB; измерение
5000/100/1800000ms. Approved FULL-only3CPU override применяется только новым
диагностическим coordinator после проверки baseline, исходный manifest
не переписывается. Runtime/patch/cipher helpers остаются byte-identical V50.
До freeze/live нужны final source/test hashes и независимые tester/reviewer.

V51 final source/test review PASS. Coordinator SHA
`ce9412767e933d7aed7beb2e039c1e8c5aaddde59b683eb72b466c385d4b80c6`,
self-check SHA `98a63cfd2da4d2546acf9d0eed482974195b28fa52fb762e73c204fe5f740cf4`.
Independent tester `node --check` обоих файлов и exact self-check PASS:
112 legacy V46 groups,5 preserved CPU-helper groups через actual V51 exports,
4 V51 source-derived quota/inspect/manifest/receipt/inverse groups.
Прежние неточные self-check labels исправлены до freeze. Tester log SHA
`3edf8050d524ff8b193fa9715cf8174b11ea41030180d010025d99f3a26f68c6`.
Exact inverse восстанавливает V50 SHA
`c17b97340c8bd664eb9a2698fd499925ba5a8ad3d7170d38e47ccadddd6f2ac3`.
Reviewer не нашёл runtime/gate/прочих budget изменений. Восемь source/dependency
файлов, tester log и receipt заморожены0444 в
`issue12-v51-gateway-three-cpu-full-20261013/experiment-source/gateway-three-cpu-v51`;
receipt SHA `3c80a4d64aad63128ac6bb08ad50f68c6c7bafc007fcaa4796ffca37238ae7ef`.
Root сверил unchanged runtime helper hashes и запустил архивный coordinator:
`PATH=/tmp/coffee-12-proof-bin-jBGChb:$PATH node /home/yurgusev/.hermes/cache/scratch/issue12-v51-gateway-three-cpu-full-20261013/experiment-source/gateway-three-cpu-v51/coffee-12-v51-gateway-three-cpu-diagnostic.mjs --prepared /home/yurgusev/.hermes/cache/scratch/issue12-v51-gateway-three-cpu-full-20261013 --approve-manifest 3767bfef3ef08737500e5f6a94f7366fb6e17ba932f73b8f71ecee68ebcfb0bf`.
Итог нагрузки ещё не получен; source review и синтетический inspect self-check
не засчитываются как фактическая quota/capacity admission.

V51 завершён exit1/FAIL75277.219912ms/7528ACK, maxLive5000/min3583,
reported processloop55.574527ms. Actual inspect receipt подтверждает gateway
quota30000/period10000=3CPU, memory1GiB, fd12288; nginx2CPU/1GiB и driver8CPU/
2GiB прежние. Native nested cgroup observations также подтверждают3CPU.
Admission5000/5001 и preflight replay/reset/slow/evicted/budgets true. Первым
отказал API headroom: marker08:05:53.199UTC, probe
`fce0337a-1648-4871-a3bc-08cec8b4a9b9`, start51.999,
deadline1200.243102ms; cumulative secure189.931/finish190.058ms, безheaders.
Driver loop p95/max15.860/88.736ms. Второй UUID/time53.219 относится к другому
запросу, не заменяет первый marker.

Точный probe связан с Edge authorizer204/1.881601ms и API404/4.944756ms.
nginx записал eventual404 в53.518, позже deadline: request1.177s, auth
connect/header/response0.000/0.306/0.306s, main0.000/0.871/0.871s,
connectionage1.463s. Connect0.000 не поддерживает гипотезу дорогого нового
handshake именно этого upstream запроса; отдельные `/events` handshake
timeouts в errorlog безprobeID не приписываются ему. Cached nginx clocks и
агрегатные stages не разделяют scheduling/сеть/чтение ответа. Быстрые app
handlers не устранили задержку proxy/upstream пути.

Строгий срез до53.199: 150 уникальных gateway nested observations,
133nginxobservations с завершёнными outer/inner intervals. За последние9
gateway counterintervals около10s average229.6% одногоядра приquota3CPU,
max289.7%; throttle total82periods/737793us, maxdelta331128us. nginx quota2CPU,
throttle0, acceptqueue4/max18, drops0, aggregateworkerschedulerwait last586ms/
max1.034s — не время конкретного запроса. Gateway loops не превысили100ms:
TLSworker1max41.779ms, worker2max55.575ms, ownermax53.477ms. Queue max89365/
24994976B, IPCpendingmax3182/833684B, rejects/ACKerrors0. Latest pre-cut
per-PID CPU averages: owner74.8%, TLS70.4/66.6%, nginx68.4/68.8%, driver263.1%;
интервалы завершились за1–5sдоcut и не являются function profiler attribution.
OOM0, RSS/FD бюджеты соблюдены. Доcut завершены75re-auth, всеTLSresumed,
median/maxgap5174/7125ms; всего113re-auth+2retryrows, остальные послеcut.
Full30min/sessionrefresh/HUP/loadedshutdown не достигнуты. Cleanup3443.288434ms
verified:8roles/network/private удалены, rootownedinventory пуст. Один разрешённый
3CPU контроль выполнен; повторных3CPU вариантов и production adoption нет.

### Первичные интернет-источники и следующий минимальный контроль

Пользователь попросил изучить практики разработчиков и дополнительные
библиотеки. [Авторы nginx](https://blog.nginx.org/blog/performance-tuning-tips-tricks)
рекомендуют начинать с `multi_accept off`, пока польза `on` не измерена.
[Официальная документация](https://nginx.org/en/docs/ngx_core_module.html#multi_accept)
определяет off как accept одного нового соединения за обработку события,
on — всех готовых. Текущий scratch V42 добавляетon; canonical generator
директиву не задаёт и использует defaultoff. Проверяемая гипотеза: возврат
к default сокращает продолжительный accept callback при reconnect burst.
Срез V51 этого ещё не доказывает. V52 возвращает только этот scratch параметр
кoff при прежних2CPU/1GiB gateway/nginx, без новых libs/API/schema/weights/
affinity и без изменения5000/100/30min/auth/SSE/SLO критериев. Сравнение
опирается на frozenV50, не продолжает3CPU override. Source/inverse/runtime
nginx-T proof фиксируют одну explicitoff директиву. Выигрыш пока не измерен.

[Node](https://nodejs.org/learn/asynchronous-work/dont-block-the-event-loop)
описывает необходимость ограничивать synchronous callback work; наш existing
Hub уже выдаёт не более64targets за setImmediate-проход. Такая рекомендация
не даёт основания добавить ещё один scheduler или framework без измеренного
пробела. SSE library/native transport кандидаты изучаются по первичным
источникам отдельно; зависимости пока не добавлены.

Read-only сравнение libraries по исходникам:

| Кандидат | Что подтверждено первичным источником | Применимость к этому отказу |
|---|---|---|
| [`@fastify/sse`](https://github.com/fastify/sse/blob/main/index.js) | `writeToStream` использует тот же `reply.raw.write`/`drain`; replay передаёт Last-Event-ID application callback, storage/global budgets не реализует. Buffer formatting преобразует Buffer в string. | Не устраняет nginx proxy scheduling или доказанно дорогую стадию. Наши ring/atomic replay/live/actual write ACK/limits всё равно потребуются; новый plugin не добавлен. |
| [`uWebSockets.js`](https://github.com/uNetworking/uWebSockets.js/blob/master/docs/index.d.ts) | Native HTTP API имеет write/onWritable/cork/onAborted; write применяет chunked framing. Public API не предоставляет эквиваленты TLSSocket.authorized/getPeerCertificate для нашей SAN-проверки. | Возможный кандидат для дорогого Node HTTP/TLS write пути, но выигрыш на нашем workload не измерен и nginx не заменяет. mTLS/SAN/lifecycle/EOF/permissions должны быть доказаны до adoption. |

[uSockets TLS setup](https://github.com/uNetworking/uSockets/blob/master/src/crypto/openssl.c)
при `ca_file_name` включает SSL_VERIFY_PEER, но в этом setup отсутствует
SSL_VERIFY_FAIL_IF_NO_PEER_CERT. Поэтому только CA-option не доказывает наш
отказ при отсутствующем client certificate и проверку transport SAN.
Upstream [native addon поддерживаетNode26](https://github.com/uNetworking/uWebSockets.js/releases/tag/v20.67.0), но нуждается в отдельном exact pin/
binary provenance; версия сама по себе не решает trust gap. Исследование не
является benchmark, библиотеки не установлены, Fastify/Node authority сохранена.

V52 prepare/verifyPrepared PASS209source/38compiled/14support/native/images,
manifest `aaf6106e2b1c5c4085bf8a6380db4115410f34ccfbf1e0c7fb59fc7dd55d8e04`.
Final coordinator SHA `b559bf2e29a269536fd79e4d4cc96a2c91b6fad6ff1725a86fb677b6d6e759c5`,
self-check SHA `e773480db5fd977ca6dc6410d2ced6903b1192ce17ec0b74d1e1d0f84d645ff8`.
Independent tester syntax/selfcheck PASS112legacy+5actualCPUgroups+3V52groups:
actual transform uniqueoff/inversebeforeevents, nginx-T guardonreject,
exactinverse→V50c17. Log SHA
`92e8b52782e25c2d6a9f77f3fd9b35e014054294db3ed5fe50aaa4a59ad2d69b`.
Reviewer PASS; runtime/gates/budgets неизменны. Sources8/testerlog/receipt0444
сохранены в `issue12-v52-nginx-default-accept-full-20261013/experiment-source/nginx-default-accept-v52`;
receipt SHA `45ca1444d74be7da3cf7acec704924f924389de25df76e746a8e338d21d3a15c`.
Архивный coordinator выполнен с exactmanifestapproval: exit1/FAIL,
duration79737.035151ms/7973ACK, maxLive5000/minLive2735,
reportedprocessloop61.276159ms. Первое headroom-failure08:24:24.378UTC:
sessionprobe `3e727582-6dcb-4ed4-98b9-c3ed8151157d`, start08:24:22.988UTC,
status200 за1390.076284ms при1000msgate, responsecorrelation
`f3b24325-489d-456e-a3c2-745b8bc1ed16`. Cumulative transport connect55.454784,
secure1325.764101, finish1325.873470, headers1389.792792ms; connect→secure
1270.309317ms не разделяет TLS computation, nginx scheduling и network wait.
Driverloop p9516.203775/max192.806911ms — aggregate interval, не точная
атрибуция failingprobe. Последующие failures до24.573UTC не подменяют первый
cutoff. Admission5000unique/5001preheader503 и616предыдущих headroom probes
подтверждены; finaleventp95/полныйre-auth/30min/sessionrefresh/HUP/loadedshutdown
не получены. Cleanup3491.426154ms verified:8roles/network/private удалены,
rootownedinventory пуст. 3CPU override отсутствует, canonical/defaultoff
возвращён только в scratch. V52 не устранил отказ, production adoption нет.
Исследование developer practices не подменяет load evidence.

Exact nginx row того же probe/correlation: sessionstatus200,
request_time0.015s, upstreamconnect0.000/header0.015/response0.015s,
connection_time0.046s — возрастTCP, неhandshaketime. Edge sessionhandler
08:24:24.331–24.339UTC/7.666ms. Этот kind0 не обращается кAPI-public;
подстановка соседнегоbusinessAPItrace была бы неверной. Strict outer+inner
nginx observer:138complete rows, последнийfinish08:24:24.268UTC,
queuecurrent/max214, drops/overflows0. Adjacent counter CPU max1.803cores,
last1.390; throttlemax1period/9729us, last0. Worker aggregatewaitdelta
max/latest920338486ns — не индивидуальноеожиданиеprobe. Следующегоstrict
sampleдоresponseнет; короткийqueue/schedulingburstнеисключён.
Gatewaystrictmetrics83rows, latest08:24:22.973UTC/live3877;
maxqueue83267records/21715955B, lastIPC1095records/286890B,
reservation/capacityrejects/childACKerrors0. Maxloopowner41.615/
TLSworker1 61.276/worker2 47.776ms. Latestlivep95diagnostic897ms/maxряд900ms
завершён за2.2sдоcut; итоговыйcombinedp95невычислен.
Доcut завершены55rawre-auth, всеTLSresumed, gap p958387/max8448ms.
Нулевыеfinaldisconnects/reconnects вdriver-result означаютневычисленную
агрегацию: она исполняется только после полногоmain/cohort, кудаrunнедошёл.
Они неотменяютrawreceipts и недоказываютуспешные5000reauth.
Root сверил resource fields: aggregateRSSgateway992477184B,
nginx663359488B, driver1288835072B; sampledOOM0. GatewayfdMax2540 — максимум
одногоPID; fdTotal5099 — суммавсехPIDприaggregateceiling12288. NginxfdMax5028/
fdTotal10058 приper-processnofile16384, driver5081/5084 приnofile32768.
SumVmRSSнеравенcgroupmemory.current из-за sharedpages; этоотдельные измерения,
а gatewayRSS сохраняет около77.5MiB до согласованного1GiB aggregateRSSgate.

Дополнительный strict pre-failure анализ existing V47 profiles не обосновал
кэш ULID-времени: десять client workers дали744.210s sampledtime;
ulidTime self9.555s/1.28%, inclusive18.511s/2.49%. В последние10s доляself
снизилась до0.88%, последние5s —0.70%; Histogram.add self0.37%.
SseDecoder.push self2.26%/inclusive16.08%, frame3.40%/12.30%,
clientcallback1.67%/5.56%, generatedAjv1.15%/2.54%, nowMs1.01%.
Inclusive stacks перекрываются; sampledtime не равно точномуCPUвремени,
existing clock calibration кUTC имеет около±1sпогрешности. V8profiles не
атрибутируют OpenSSLnativework. Доляidle около71.9% не доказывает отсутствие
nativeTLSCPU. Module-level validator общий для500clients каждогоиз10shards;
existing bounded64rawframecache действительно разделяется внутриshard.
TextDecoder уже переиспользуется, Date.now уже используется; freshcopies и
schema каждогокадра сохранены. Новый cache, пропусквалидации или library
ради этихмалых JSдолей не добавлены.

### Следующее направление после V52: повторное использование TLS SecureContext генератора

Интернет-исследование [OpenSSL performance tuning, p24](https://archive.openssl-conference.org/2025/presentations/Tomas_Mraz_OpenSSL_Application_Performance_Tuning_v2.pdf)
указывает на повторное использование client SSL_CTX с неизменным CA store.
Это отличается от SSL_SESSION caching. В [pinned Node26.8.1 connect](https://github.com/nodejs/node/blob/v26.8.1/lib/internal/tls/wrap.js)
`options.secureContext || tls.createSecureContext(options)` создаёт новый
контекст при его отсутствии. Existing clients.mjs создаёт500per-clientAgent
накаждомиз10workers; openStream каждыйразпередаёт одинаковыеCA/minTLS1.3.
При reconnect Agent сохраняеттолькоодну собственнуюTLSsession, но новый
SSL_CTX снова создаётся. ЕгоCPUстоимость наэтомсерверепока не измерена.
Один module-level createSecureContext(tlsOptions('edge-nginx')) наworker и
передача его каждому прежнему Agent устраняют повторный CA parse/setup,
сохраняяраздельныеsessioncaches, coldinitialTLSfalse длякаждогоклиента,
SNI/hostname/rejectUnauthorized и новыйHTTPauthrequest/cursor наreconnect.
Это fixture-only nativeAPI, безlibrary/newcachelayer/productioncryptochanges.
Изменение ограничено clients.mjs и существующим nativeTLSreconnecttest
в harness.test.mjs. Перед новымfull нужныactualnativeTLSisolationtest,
boundedCPU/wallmeasurement, независимые проверки, новыйfrozenmanifest.
Если стоимостьмала илиcapacityнепройдена, выигрышнеприписываетсяserverruntime.

V53 fixture diff реализован и проверен: clients SHA
`50bd3593aa24aabb17f62b5c8dcf8bfeb6970d8710a02b34252f7295fadd1e0f`,
harness SHA `48a2a2acf3d2af9a889344c7c7f0ff4a6a8cd189898ca1c86b76c333ccd95c10`.
Root exactinverse вернул прежние363048…/e6f51e… hashes; другие helperfiles
не менялись. Worker и independenttester: nodecheck/29of29harness PASS,
skipped0; reviewerPASS. ActualnativeTLStest далfalse→true→falseдлядвухAgent
соднимcontext, authorizedtrue/TLS1.3, freshcookies иlastEventID сохранены.
Context пережил первыйsocketclose, новыйclientcold; options/ctxне мутируются.

Bounded benchmark3×ABBA/1000CTX+Agentoperations, безnetworkhandshakes:
wallmediancreate420.613201ms/reuse6.7337755ms,
CPU(user+system)median437.535/8.494ms. External accounting не изменилось,
RSSпослеGCоставалсяповышенным; retainednativebytes неатрибутированы.
12rawrowsсохранены; sourceвосстановленизисходнойвыполненнойinlineкоманды,
повторногоbenchmarkнебыло, disposablecert удалён. Source SHA
`67091ff10f403f07c304f98cb29ee30fe194794acdb2ea113131b973ee14d79c`,
JSON SHA `a5da51b5ab26c97a683886de7a4c3e8bbd23757284047a88346010f37c4385b0`.
Микроизмерение не доказывает end-to-end/TLS/capacityвыигрыш.

Normalprepare/rootverify209sources/38compiled/14support/native/images PASS,
manifest `4fc7fcc8be4328a01b037946fbe75a07a3dc1433dd51d528efac9e943d0d269b`.
Gateway/nginx2CPU1GiB, driver8CPU2GiB, остальныеbudgetsпрежние.
V53coordinator меняеттолькоclassificationliteral/symbol, exactinverse→V52b559;
SHA `7fc4afc2283a387df5c0f05b07d5dead66611e7ae0021382a089c7373d4e98f6`,
selfcheck SHA `4c621fcad4d6934864035feef978d6b79ad0b0093f284ae472f35d592ed71fc3`.
Independentcoordinatortester:112legacy+5CPU+3V52+1V53inversegroups PASS;
log SHA `6a8c1a6afacbf3704040b3dca79d6a1f057f295d58faac6066b94758521900df`.
8sources/5evidencefiles/receipt0444 archivedв
`issue12-v53-shared-client-secure-context-full-20261013/experiment-source/shared-client-secure-context-v53`,
receiptSHA `3d75c7d620591c2bba553150c687ce25d550342ac2155df4fa6085b7b19dd22e`.
Actualarchivedcoordinator выполнен сexactmanifestapproval: exit1/FAIL,
81964.543139ms/8197ACK, maxLive5000/min2251, maxreportedprocessloop65.765375ms.
Firstheadroomfailure09:01:27.573UTC: sessionprobe
`d9bfd6ef-3c33-444f-97d8-9b9e302659ca`, start09:01:26.413UTC,
status200/1159.170205ms, correlation`dcd1539b-75ab-4db6-b498-9a7554f9d6e2`.
Cumulativeconnect33.429497/secure1066.238836/finish1066.343865/
headers1158.863828ms; большаязадержкадоsecureConnect неразделена наTLSCPU/
accept/scheduling/network. Actual5000coldTLSreceipts:TLS1.3/ChaCha/authorizedtrue/
resumedfalse, 7fallbackprobes прошли. Full30min/cohortре-auth/finalp95 не
получены. Cleanup3803.338323ms verified:8roles/network/private удалены,
rootownedinventory пуст. FixtureCTXsetupэкономия не устранилаfailure;
разница1159vs1390ms вдвухединичныхruns не доказываетпричинныйcapacityвыигрыш.
Runtime/scheduler/TLSpolicy/framing/gates совпадают сV52;
3CPUконтрольнеповторяется. Sourcefreeze не являетсяcapacityPASS.

V53 strictaudit: exactnginxprobe/correlation row09:01:27.518UTC/status200,
request/upstreamheader/response38ms, connect0.000, connectionage49ms.
ExactEdgesessionhandler09:01:27.500–.502UTC/1.834ms. SharedCTXиспользуется
толькоSSEclients; failingheadroomrequest имеетagentfalse иctxнепередаёт.
Этотtrace проверяетserverheadroomподизменённойcohortload, а не
per-probeCTXсоздание. Strictpublicobserver139rows, latestfinish27.333UTC,
queuecurrent/max274, drops/overflows0, latestCFSthrottle0. Workerlatest
aggregate runtime1.410s/wait0.615s — counterintervalдвухPID, непричинаprobe.
Gateway84strictmetricsrows/latest26.409UTC: aggregatequeue104683records/
27264463B, IPC/admission/ACKerrors0; ownerloopmax47.776/TLS51.675/65.765ms.
Доcut145rawcompletedreauth, всеresumed; gapmedian9240/p9510711/max10980ms.
25из170totalrowsпослеcut неучтены. LatestprivateTLSworkerсрезы26.812/26.785UTC:
secure6789/resumed6543/cold246/TLSerror0; всеTLS1.3, ChaCha6787 и2AESfallback.
Это96.38%resumption, не подтверждаетгипотезуораздельныхticketkeysкакпричине.
StrictaggregateRSSnginx662900736/gateway989143040/driver1178136576B,
OOM0; fdMax5047/2593/5079 иfdTotal10063/5098/5082впределахсвоихgates.
Latest6sPIDwindows: driver240%, owner67.1%, TLS57.5/61.0%, nginx70.1/68.8%.
Окнараздельныипредшествуютprobe; это не одновременныйCPUtrace/causalproof.
Сравнениеsinglefullruns не доказываетserverthroughputвыигрышотclientCTXreuse.

Дополнительная primarysourceпроверка HTTP/2 upstream не даёт путь5000SSE→
несколькоTLSsessions: [proxy-v2source1.31.6](https://github.com/nginx/nginx/blob/release-1.31.6/src/http/modules/ngx_http_proxy_v2_module.c)
использует следующийstreamID черезpc.cached; [keepalivemodule](https://github.com/nginx/nginx/blob/release-1.31.6/src/http/modules/ngx_http_upstream_keepalive_module.c)
кладётpeerвcache толькопослеfree. АктивныеSSErequests неmultiplexed этим
upstreamпутём; HTTP2wireизменение не применялось. KTLS требуетподтверждённого
OpenSSLbuild/runtimefeature; одно native TLS_TX соединение позднее подтверждено
счётчиками namespace, но проверка KeyUpdate ниже исключила этот вариант.
Изменениеcrypto/group/certificatepolicy без измереннойпричины не применялось.

### Следующее исследование после V53: bounded KTLS compatibility

Actualreadonlyimageinspect e9567a94… подтвердил nginx1.31.6,
OpenSSLbuild3.5.6/runtime3.5.7; exactimageCLIимеет `s_client -ktls`.
Kernel6.8.0-146-generic содержитCONFIG_TLS=m иChaCha/Poly1305x86modules,
исходныеnamespaceTLSсчётчики0. [OpenSSL3.5.7KTLSmethod](https://github.com/openssl/openssl/blob/openssl-3.5.7/ssl/record/methods/ktls_meth.c)
поддерживаетTLS1.3/ChaCha иnonfatalfallback приотказеактивации.
[Linux6.8TLSdoc](https://github.com/torvalds/linux/blob/v6.8/Documentation/networking/tls.rst)
описываетобычныйsend, ноавтоматическогообъединениямалыхwritesнеобещает.
Это не hardwareoffload наэтомCPU и не доказательствоlatencyвыигрыша.
[Kernel6.8setup](https://github.com/torvalds/linux/blob/v6.8/net/tls/tls_main.c)
требуетпроверкиповторнойTLS_TXнастройкиприTLS1.3KeyUpdate.

Локальная проверка использует scratch-копию существующей nginx cutover
фикстуры, синтетический CA, отдельную сеть и read-only pinned image.
Generated config получает Options KTLS при прежних TLS versions/ciphers;
production config/source не меняются. Нужны фактический рост namespace TX
счётчика, TLS 1.3/ChaCha, целостность SSE и проверка KeyUpdate на том же
соединении, затем подтверждённая очистка собственных ресурсов. Одной записи
`K` в stdin или CLI flag недостаточно для PASS. Native crypto в ядре передаёт
traffic keys внутри host TCB; mTLS/SAN/actor и protocol checks сохраняются.

Первые setup attempts не дошли до TLS: порядок сети/доступ synthetic files,
затем missing read-only snippets. Они сохранены как FAIL; данные capacity
не собирались. Один последующий userspace-client attempt подтвердил
nginx namespace TlsTxSw 0→1, TlsCurrTxSw=1 и RX=1, TLS1.3/ChaCha/SSE200.
KeyUpdate predicate завершился по timeout, но trace остался только в RAM:
наличие client/server KU и alert не установлено. Поэтому это не доказанный
TLS protocol failure. Source SHA
`016b41aeb3f15ea55c96f98d002cce72797e3fa823a01a0f57676d80dda697a1`,
proof SHA `7e24ad4ecc8de2d60f0345b1911a1263c6e29d46b75496f7c9d05b32c0fc05ab`,
metadata SHA `fdc7b4c24ae351e0bf41abcadaccbfc0533af638f1827d9fcfdb38b0e9a448c0`.
Архив `issue12-ktls-probe-1281156-zvzyAa`, files0444; containers/network/
certdir/eventlog удалены, cleanup true. Предыдущий client-KTLS attempt
смешивал два crypto пути и не принимается как server KeyUpdate proof.

Следующий контроль запускает baseline без server KTLS первым и сохраняет
только bounded безопасные direction/type KU, alert/error enums и SSE counters;
SSL_SESSION/PSK/полный s_client trace не сохраняются. Иначе тот же predicate
может не проходить из-за обычного SSE downstream read handler. Primary source
nginx1.31.6 показывает MSG_PEEK broken-connection path, но это лишь возможный
механизм; baseline trace должен установить фактическое поведение. При
непроверенной совместимости full не запускается. KTLS adoption и выигрыш
пока не заявляются.

Baseline `issue12-ku-pair-1295397-IaTWXm` без server KTLS подтвердил TLS1.3/
ChaCha, connected, client `>>> KeyUpdate`, отсутствие server KU в ограниченном
окне, всего8ticks, exit0/close_notify/no fatal errors. KTLS stage не запускался.
В диагностике snapshot возвращал живые references: before counters изменились
после команды, поэтому `sseTickCountAfterCommand=0` недостоверен, порядок ticks
не доказан. Это дефект test evidence, не установленный TLS bug. Предшествующие
три setup failures (missing import/неверные argv) TLS не упражняли; cleanup
каждого подтверждён. История не переписывается.

Для устранения неоднозначности выбран matched pre-HTTP контроль: userspace
client завершает handshake, действительно отправляет requested KU, затем
первый GET уже после обновления client write key. Требуются server KU и
валидные SSE bytes, идентичные cipher/verification/options, после чего тот
же сценарий с server KTLS. Snapshot получает свежие copies, сохраняется
только bounded безопасная timeline; полные TLS session/PSK не сохраняются.
Нагрузочный профиль не сокращается и до совместимости не повторяется.

Matched pre-HTTP контроль завершён: архив
`issue12-ku-pair-1312587-nJRtyz`, source SHA
`3c63c1222e9e477387924a5047833761613d8df81ad2693c9d9a440ae0a74cff`,
proof SHA `d5f027615cb75142f8da51c380527887c6addd8644e96994445d902743ef4cbb`.
Обычный TLS и KTLS используют одинаковый userspace client, TLS1.3/ChaCha,
CA/hostname verification и generated config; единственная разница server
config — `ssl_conf_command Options KTLS;`. Generated source SHA
`fb84b47bbf106526ef8bcd5d49eae8ec4dd228c5523521f150da7912ac1885ad`;
активные baseline/KTLS SHA соответственно
`6e89664345e0eb824386069dcbb8c68a4bd5d7a3faecfffb342d6757a2736103` /
`88fea938697e86494e894552e79f486309768c53b01c3ed624090e76830a7362`.

Baseline: фактический client KU в epoch ms1791884768427, GET8528,
server KU/connected8572, следующий tick9573; HTTP200 и exact SSE headers,
exit0, ошибок TLS нет. KTLS: client KU1791884771586/chunk16, server
`internal_error` в том же millisecond/chunk17, раньше GET1686. Ответа HTTP,
server KU, connected и tick нет. Namespace historical TlsTxSw/TlsRxSw=1
подтверждают активацию; current counters=0 после закрытия соединения не
означают отсутствия активации. Device counters=0: это software KTLS.
Таким образом, совместимость KTLS на текущем kernel/OpenSSL **FAIL**;
capacity этим контролем не измерялась, full с KTLS не запускается.

Observer сохраняет свежие snapshots и безопасные enum-only события из одного
потока stdout/stderr, с ограничением64KiB/128events. Полный s_client trace,
SSL_SESSION и PSK не записаны. Capture22201/21759bytes, truncationfalse;
фактический client KU отделён от записи `K` в stdin. Node syntax, установленный
Oxlint no-undef, observer assert self-check и независимая проверка tester
прошли. Reviewer подтвердил rejection, но нашёл KU-OBS-1: listener `exit`
зарегистрирован поздно, поэтому сохранённый KTLS client `signal:timeout`
не доказывает зависания. Исторический receipt не переписывается; вывод
опирается на server alert до GET, а не на этот exit field. Перед будущим
переиспользованием probe exit promise требуется регистрировать сразу после
spawn; исключённый KTLS-кандидат повторно не запускается.
Предыдущая попытка с stale connectedTranscript осталась FAIL;
cleanup каждого контроля подтверждён: свои containers/network/certdir/eventlog
удалены. KTLS исключён, production config не менялся.
Архив source/proof/финального KTLS config/observer self-check имеет mode0444;
manifest SHA `a1166d8a23c8eb7874d47d404b486415719f725e437c29aada8abf969efcf298`.
Отдельный baseline config не сохранён: его hash записан в proof, bytes
восстановимы из archived source и соответствующего generated source.

### Проверка гипотезы V54: публичный TLS-буфер nginx 8 KiB

[Документация nginx](https://nginx.org/en/docs/http/ngx_http_ssl_module.html#ssl_buffer_size)
описывает компромисс между размером TLS send buffer, накладными расходами
большого ответа и временем первого байта. В V53 последний строгий срез
показывает3046 records в writing у128connections, но TLS record sizes и
причинность задержки этим не установлены. Контроль меняет только публичный
`ssl_buffer_size`4096→8192 в disposable config, оставляя upstream
`proxy_buffer_size`4096, cipher/CA/TLS/auth/SSE, два TLS workers/одного owner,
2CPU/1GiB и все5000/100ACK/s/30min gates. Ранее8KiB upstream buffer
проверялся на другом single-process baseline и не прошёл; это иной параметр.
Дополнительная ёмкость публичных буферов при5000clients составляет примерно
20MiB; фактические RSS и задержки всё равно проверяются существующими gates.
До реализации researcher и root проверили pinned source1.31.6:
[non-buffered filter](https://github.com/nginx/nginx/blob/release-1.31.6/src/http/ngx_http_upstream.c#L3817-L3855)
помечает каждую recv-produced цепочку `flush=1`, а
[SSL send chain](https://github.com/nginx/nginx/blob/release-1.31.6/src/event/ngx_event_openssl.c#L2874-L2953)
не ждёт следующего чтения при таком флаге. Поэтому увеличенный send buffer
не реализует предложенное объединение соседних SSE reads. Влияние на дробление
одной крупной цепочки или частичные записи возможно, но таких цепочек и
измеренной связи с отказом нет. Root отклонил эту гипотезу до code/prepare/full;
вариант не считается проведённым нагрузочным экспериментом. Production
generator/config не менялись, очередной full без подтверждённого механизма
не запускается.

### Проверка времени первой re-auth волны

Read-only трассировка подтверждает ожидаемый механизм: Edge в каждом
authorize выдаёт `iat=floor(now/1000)` и `exp` не позже60s/session expiry
(`apps/edge-gateway/src/routes.ts:288`), а Hub ставит отдельный30s timer
на каждое соединение (`apps/realtime-gateway/src/hub.ts:267`). Проверка
actor expiry использует5s skew. Поэтому при близком issuance первый
просроченный sweep обычно приходится примерно на90s возраста соединения.
Measurement начинается после готовности всей когорты; при начальных20s
admissions это даёт первую волну примерно через70s измерения. Это согласуется
с V53 raw completed re-auth, но не доказывает точную ширину всей когорты.

Initial opener работает до8concurrent connections на shard без pacing;
global fixed expiry timer отсутствует. После закрытия fixture выдерживает
wire retry3000ms, затем новый GET проходит Edge authorize;13s recovery gate
и retry502/503/504 сохраняются. Обновление OIDC cookie каждые600s не объясняет
первую волну. Незавершённый full содержит только completed re-auth rows:
по ним нельзя восстановить census5000 или синхронность всех actor tokens.
TTL/sweep/retry/admission schedules и критерии не изменены.

### Наблюдение TLS-групп после V53

По [Node26.8.1](https://nodejs.org/download/release/v26.8.1/docs/api/tls.html)
`ecdhCurve=auto` оставляет OpenSSL выбор списка групп; pinned
[OpenSSL3.5.7 source](https://github.com/openssl/openssl/blob/openssl-3.5.7/ssl/t1_lib.c#L191-L194)
начинает default список с гибридной `X25519MLKEM768` и `X25519`.
Default не доказывает фактического выбора. Возобновление сессии также не
доказывает отсутствия key exchange: [RFC8446§4.2.9](https://www.rfc-editor.org/rfc/rfc8446.html#section-4.2.9)
различает PSK-only и PSK-DHE; cipher suite не указывает negotiated group.

Tester извлёк существующий native reconnect test из
`tests/realtime/fixtures/harness.test.mjs:600` без изменения TLS options,
добавив только client `getEphemeralKeyInfo()` и SNI assertion. Команда
`node --test --test-name-pattern='SSE reconnect retains only' /tmp/coffee-12-tls-groups.test.mjs`
прошла1/1 после syntax check. Actual Nodev26.8.1/OpenSSL3.5.7 сообщил
`{type:TLSGroup,name:X25519MLKEM768}` для всех трёх соединений
`[cold,resumed,cold]`. Peer authorized, TLS1.3 и SNIlocalhost проверены;
cookie/cursor/session-isolation assertions сохранены. Это локальный Node
native fixture, а не доказательство группы каждого V53 nginx соединения.
Source SHA `5b3da5b627e7f98b1b4118bb57a84011cba1a5b2c3c95ed53ba33ed807d0b729`,
original extracted block SHA
`b67e772f48441671767b7ccb39b77b7c43a17da51ce6a3c45968a80d4f421a49`,
proof SHA `7536c216a6dc88bf7fa6bd127a9af47f3f674597b9a30a732d6dd85a2f5359f3`.
Артефакты0444, private synthetic certdir удалён, session/PSK/keys не выводились.
CPU-стоимость этой группы и причинность re-auth отказа пока не измерены;
TLS/group policy не менялась.

Один фактический public nginx group baseline также PASS:
`issue12-nginx-group-baseline-WKrNtz`, source SHA
`0a7da9fdee44e049716bef2aa7331e718e14018220a137085a5c55d431ef04f8`,
proof SHA `f232114e380e84c984136cd787a082b09ba149b96eeae2a0ac789c528fabc296`.
Generated configfb84b47b…1885ad и active6e896643…736103 с exact inverse;
group/curve policy не менялась, использована прежняя ChaCha preference.
Backend Running, nginx-t status0/success; userspace client проверяет CA/
hostname и сообщает TLS1.3/ChaCha/`X25519MLKEM768`, затем HTTP200/connected/
tick, exit0, safe errors0, capture544bytes/truncationfalse. Headers этой
синтетической cutover backend не являются product exact SSE-header proof.
Сохраняются только safe enums, source/proof0444, cleanup полностью verified.

Предыдущие group probes сохранены как setup FAIL, не TLS evidence:
`issue12-nginx-group-baseline-8JLCSA` (duplicate anchor/inverse error, source
54084c6c…63d5d) и `issue12-nginx-group-baseline-kqYkYm` (nginx-config phase,
source0d8f3e11…b87b42). Второй receipt не сохранил статус/причину nginx-t;
точная причинность не восстановлена. Перед PASS исправлены порядок owned
network/backend→nginx-t, восстановлен existing synthetic assertion material
и добавлены safe backend state/config reason enums. Не применялись изменения
CA issuers, TLS groups, KTLS или production source. Это одно negotiated
соединение, не census5000 и не performance/adoption proof.

Root отдельно выполнил два коротких standalone crypto замера в cached pinned
nginx image/OpenSSL3.5.7, с networknone/read-only/UID101/1CPU/64MiB/cap-dropALL:
`openssl speed -seconds 2 -kem-algorithms ML-KEM-768` и
`openssl speed -seconds 2 ecdhx25519`. Оба exit0; named `--rm` containers
после команд отсутствуют. По CPU-time output: ML-KEM keygen8153.5ops/s
(0.122647ms), encaps13785.4ops/s(0.072541ms), decaps8911.5ops/s(0.112215ms);
X25519 derive12069.5ops/s(0.082853ms). Safe logs и receipt0444:
`/tmp/coffee-12-openssl-primitive-cost-20261013.json`, SHA
`69713c452b84339945a4f80454cb9b89c689ea40e359f6603cbfd118b8df4b38`.
Это один короткий замер каждой операции, не TLS-handshake, hybrid group total,
нагрузочный CPU trace или причинность SLO. Разные операции неэквивалентны;
измерение не обосновывает исключение гибридной группы. Keys/PSK не выводились,
TLS policy не менялась. Команды и единицы сверены с
[pinned speed source](https://github.com/openssl/openssl/blob/openssl-3.5.7/apps/speed.c).

### Измерение V55: CPU-профили owner и TLS workers

V53 сохраняет raw process ticks, но не показывает горячие стеки gateway.
Следующий disposable coordinator добавляет только full-only Node flags
`--cpu-prof --cpu-prof-interval=10000 --cpu-prof-dir=/gateway-cpu-profiles` к gateway argv.
[Node26.8.1 cluster source](https://github.com/nodejs/node/blob/v26.8.1/lib/internal/cluster/primary.js#L57-L129)
оставляет default execArgv равным process.execArgv и передаёт его двум forks;
shared runtime/helpers/compiled patch не меняются. Нужны три профиля,
сопоставленные с existing namespace/host PID receipt: Kafka owner и два TLS
worker. Crypto, auth, schedules,2CPU/1GiB и все full gates сохраняются.

Первый план записи в `/tmp` отклонён до реализации: по
[Docker docs](https://docs.docker.com/engine/storage/tmpfs/) tmpfs удаляется
при остановке контейнера, надёжного post-exit экспорта этим путём нет.
Root выбрал один scoped RW bind по существующему fixture pattern:
новая пустая scratch-директория0700/UID1000 только для gateway CPU files,
mounted как `/gateway-cpu-profiles` только в full. Production mounts и
config не меняются. После measurement и observers сохраняются только
exact PID-allowlisted regular files. Capture/stop/проверка должны укладываться
в общий cleanup budget; отсутствие профиля, OOM/SIGKILL/timeout означают
unavailable diagnostics, а не PASS. Node не ограничивает write size:
64MiB posthoc validation не является hard write cap. Profiler добавляет
heap memory/CPU и disk I/O,
поэтому такой прогон имеет diagnosticOnly=true/launchProof=false. Он нужен
для выбора минимального исправления, а capacity затем проверяется обычным
unprofiled full. V8 sampled stacks также не являются полным native crypto
профилем или доказательством единственной причины задержки.

V55 source/review/tester прошли до запуска. Coordinator SHA
`777f71c07a84e1485c18052b904540106d04285aee34c9521d2a2ef8414a72a1`,
self-check SHA `34c5bd7fb619655b420d387359d4299a44ffef4f3584a9660edfc1e2c4a0e5b4`,
inverse-patch SHA `9b9b7edea8e9d5d57f32d5207b180210048507a11c55961a62849e3575566436`;
whole inverse восстанавливает frozen V53 SHA7fc4afc2…e98f6.
Independent self-check log SHA
`e91d15dbca63379e2f7e3e1ce6a610341b5889011ae7f56f12f0b9242f8682da`.
Node syntax/Oxlint no-undef PASS;6existing regex warnings. Ранний self-check
FAIL из-за duplicate VM variable и несогласованной передачи байтов сохранён;
до исправления/повторной проверки Docker не запускался.

Обычный prepare и verifyPrepared прошли209source/38compiled/14supporting,
native adapter/images unchanged. Manifest
`0e4c9ed2f888fb65be4a339cecca0cc9a4cf01ca492d3ab9c7a445d72a81b902`,
archive `issue12-v55-gateway-cpu-profile-full-20261013/experiment-source/gateway-cpu-profile-v55`,
12files0444/source receipt SHA
`e91d440e5c1056a63ced252523fe64a6d97b2dbe41d6cec48eba3da27f24b1dd`.
Команда actual archived coordinator с `--prepared` и этим `--approve-manifest`
завершилась exit1; лог `/tmp/coffee-12-v55-full-20261013.log`.
Actual ownerPID7/TLS58/59 получили ровно profiler flags; gateway/nginx
2CPU/1GiB, остальные budgets и gates прежние.

Первичный driver FAIL: в10:48:49.501Z API kind1/status404/latency1005.369990ms,
duration8082.736703ms/809ACK, min/max live5000, process loop49.151999ms.
Driver result SHA `0e447ab32bc188cf531c94a00559b07a129ccf3374a361cfb54c447394b4deae`.
Позднее monitor ролиdriver получил `owned live process measurements cannot
be empty`; observer mtime10:48:50.256Z после driver-result mtime49.966Z.
Точный нулевой subcondition и повторный container state не записаны.
Monitor source byte-identical V53, gateway PID/argv checks прошли:
профилировщик не доказан причиной ошибки сопоставления. Coordinator проверил
hostFatal раньше чтения driver result, поэтому final duration0 и ERR_ASSERTION
не являются заменой raw driver failure. Historical coordinator receipt SHA
`d546efc467b94fea7c778fc8bcdda6ff6cd38b8bbf4f4cd700a5380f73a48cbc` не исправляется;
nested collectionStatus=not-collected также устарел относительно actual captured
верхнего receipt. Это дефект диагностического reporting, а не PASS runtime.

Все три профиля captured, independently hashed/parsed/PID-mapped:

| Роль/PID | Bytes | Samples=timeDeltas | SHA-256 |
|---|---:|---:|---|
| Kafka owner7 | 535421 | 8922 | `66e6e5801fb99409ea5f3f73c895e2ec223c2caaa67312c64e9f5371b929a85a` |
| TLS58 | 489342 | 8807 | `e7dbf75fb0ca2eaafd7cab475fabfb4832f49a9e4f4adc30d5ea797129ccb652` |
| TLS59 | 523120 | 8774 | `488380918e57185880301f70191dca4dae9d4fe702410d1e74f3bdb67a0f54ae` |

Total1547883B, profile receipt SHA
`da1bc0c9b8e9fe4c596779a2147514a68592b4086206eb2627542330bd23e71c`,
process receipt SHA `fd6e5f3360939be43bb046ef1fe6872c217c71c8b4ac193e73765db6e8df4dc2`.
Gatewayexit0/OOMfalse; capture starts50.706Z after driver failure,
elapsed1227.250ms, поэтому профили включают startup/teardown. Source, profiles
и final receipts0444. Cleanup5250.737437ms включает capture/observer stop,
8/8containers/network/private удалены,10s gatePASS/root label survivors0;
cleanup SHA `c30f7e28e97738d301dabf405bccf135d193d02e43cafd40f0e8ead82c10c1f2`.
30min/re-auth/HUP/finalp95 не получены.

V8 spans около90s. Прямой wall↔monotonic calibration отсутствует;
mtime−timeDelta sum согласуется с секундными UTC filenames, но это inference.
Консервативный приблизительный центральный срез около6.09s measurement
с ±1s границей: owner selfidle20.8%/GC8.4%, inclusive processImmediate35.3%,
pump13.1%/processChunk13.6%; TLS workers selfwriteBuffer42.3–45.4%,
idle25.9–28.9%/GC3.0–5.9%, write path около47% inclusive.
writeBuffer без JS URL — sampled-frame label, не измеренная доля TLS crypto.
Startup-contaminated whole-run доли не используются как load/reauth causal proof.
Воспроизводимый analyzer сохранён0444:
`/tmp/coffee-12-v55-profile-analysis.mjs`, SHA
`3fc1f5055c32c6947bf8e32b9c1ca7b5707a4827115ab8a3670270d6b952f4e6`;
numeric result SHA `c511bf7a55ce0cd0eb7eb0a425acedac63cc71e56fb8324ebb8b53569eb2dada`,
run receipt SHA `274776eadb6857969730ceb453fef2d63e55feaf47d7baf7a0dedae55fa7922f`.
В core window97–99% TLS-worker writeBuffer samples идут через
connectionCorkNT→Writable.uncork→Socket._writeGeneric→writeGeneric→writeBuffer;
немногие остальные — IPC serialization. Pinned
[Node stream binding](https://github.com/nodejs/node/blob/v26.8.1/src/stream_base.cc#L276-L304)
передаёт вызов виртуальному DoWrite;
[TLSWrap](https://github.com/nodejs/node/blob/v26.8.1/src/crypto/crypto_tls.cc#L988-L1113)
вызывает SSL_write и EncOut. Это подтверждает socket/TLS write path, но не
разделяет crypto/native copy/syscall CPU. Node уже выполняет HTTP cork/uncork;
добавочная обёртка вокруг одной записи или library migration этим не обоснованы.

Исправление reporting в текущем normal soak: при пустых RSS/FD measurements
только driver повторно inspect-ится; пропуск разрешён лишь после подтверждения
остановки без OOM. Live driver и остальные роли сохраняют fail-closed guards.
Existing observer test исполняет actual monitor VM для четырёх случаев:
stopped driver, live driver, OOM и иной runtime. Harness29/29, Node syntax,
официальный pnpm lint и diff-check PASS; отдельный custom no-undef config
не знал existing setImmediate и не принимается как product lint failure.
Source soak SHA `eca6f7281f007da74d248dd0abe03b9ec4489418be03d66306ba116132cd9714`,
harness SHA `823fca88e2dada5bdf8ba52481972461afe86d71b16121fc223d9530a59ea844`.
Runtime, thresholds, schedules и historical V55 artifacts не изменены;
новый load с исправленным observer ещё не запускался.
Tester подтвердил exact inverse soak→32955f78…c740c и harness→48a2a2ac…95c10,
целевой observer test1/1, Astra source reviewPASS. Дефект изменял reporting
после раннего driver failure, поэтому этот fix сам по себе не даёт capacity PASS.

Отдельная read-only проверка открытого permission-wrapper evidence:
существующий `node tools/compose-smoke.mjs --stub-secrets` использует canonical
Dockerfile entrypoint `scripts/permission-enforce.mjs`, scoped synthetic RO
secret mount UID1000/mode0400/tmpfs. Но обычный stub mode поднимает14 runtimes,
Kafka и ingress, подключает их к общей external `coffee_postgres_data` и
оставляет `aroma-gateway` egress к `aroma.origin.host:443`. Изоляция этой общей
сети от реальных данных или отсутствие provider calls при старте этим режимом
не доказаны. Команда не запускалась в рамках #12. `--provision-empty-postgres-network`
создаёт только сеть без PostgreSQL и не обеспечивает readiness.
Existing узкий transport fixture переопределяет entrypoint на bare Node;
permissions unit tests проверяют flags/deny, но не целый realtime app. Отдельного
existing realtime-only permission-wrapper fixture со synthetic material нет;
stub mode также не доказывает SOPS→config-bootstrap. Новая инфраструктура или
изменение общей Compose-топологии не добавлены. Этот live evidence остаётся
открытым; успешные config/manifest/bundle/redaction проверки сохраняются.

Уточнение formal scope: точный пункт55 #12 требует manifest/config/bundle/
redaction и отсутствие чужих DB/AROMA secrets, PII/business payload. Он не
требует production SOPS MAC или deployment; эти непроверенные операции не
добавляются как отдельные merge gates. Live permission wrapper остаётся
дополнительным свидетельством фактической изоляции, а full capacity —
самостоятельным незавершённым acceptance criterion.

Новая read-only трассировка нашла existing узкий путь без Compose expansion:
`prepare()` уже строит canonical realtime runtime image с entrypoint,
wrapper/manifest/connectivity policy. Текущий fixture переопределяет
entrypoint и монтирует snapshot поверх `/app`, поэтому скрывает image
filesystem и использует locators `/fixture/...` вне allowFsRead. Для
отдельного normal single-process reference-smoke можно сохранить image
filesystem/entrypoint, дать config `/app/config/platform.yaml`, own secret
`/run/secrets/coffee-platform.yaml`0400 и required wrapper PORT4401.
Секрет только synthetic, новый runner/DB/provider/SOPS не нужен. Bind-файл
с ext4 не становится tmpfs из-за container pathname: для materialization
proof источник должен находиться на настоящем owned host tmpfs и иметь
проверенные filesystem/UID/mode, с удалением только собственного каталога.
Узкий scratch wrapper реализован; source/self-check и независимые tester/Astra
проверки пройдены. Первый запуск ошибочно получил EEXIST из-за заранее
созданного result directory; history сохранена. Второй запуск дошёл до
canonical gateway launch и завершился FAIL: Docker этого сервера помещает
`--tmpfs` в `HostConfig.Tmpfs`, тогда как `Mounts` содержит только два file
bind. Фактическая ошибка — форма inspect assertion, не доказанный отказ
runtime isolation. `durationMs=0`, опубликованных ACK нет; cleanup2580.129ms,
6 созданных ролей/network/private/owned host tmpfs удалены и проверены.
Receipt: `issue12-wrapper-runtime-isolation-smoke-retry-20261013`.
Новый frozen v2 проверяет ровно два read-only file binds в Mounts и оба tmpfs
с точными параметрами в HostConfig.Tmpfs; runtime statfs/UID/mode, permission
denial и общий cleanup budget сохранены. Негативные self-check cases
проверяют отсутствующий/ослабленный/лишний tmpfs и RW bind. Source
`117bfc29512408c6633baa712d56f8142dd956a21a5790d47ffa5888a6a6d8a7`, self-check
`a8415f97928bb44b97042154311061c883203ba64ccabc36bc52a1d5b5a61f01`, exact
inverse v1 подтверждён. Source freeze receipt
`722f96862be25ed9937d4c9c24c71d86cfeca0c3293e6b541f48188e6a96d124`.
V2 smoke1client/120s в новом result directory
`issue12-wrapper-runtime-isolation-v2-smoke-20261013` завершился FAIL до driver:
`canonical permission wrapper and runtime child processes: timeout`.
Actual mount/statfs assertion прошли; gateway log подтверждает HTTPS listener
и переход starting→running. Опросы не нашли ровно1wrapper+1runtime, но safe
process witness не сохранялся: конкретный несовпавший argv predicate неизвестен.
`durationMs=0`,published0,cleanup2807.844497msverified; все6созданных
ролей/network/private/ownedtmpfs удалены; runtime permission failure из этого
timeout не выводится. Frozenv3 safe witness раскрыл точную причину: namespace
PID1 docker-init содержал дочерние wrapper args и ошибочно классифицировался
как второй wrapper; actual Node wrapperPID7 и childPID18 были живы. V3 также
FAILдоdriver, cleanup2765.234802msverified. Никакой runtime bug из этого
observer doublecount не следует. V4 требует Node basename первого executable;
трёхпроцессная NUL-argv regression получает [null,wrapper,runtime], extra
realNodewrapper по-прежнему FAIL. Root/worker syntax/selfcheck/no-undef/inverse
и Astra reviewPASS. V4source
`2c14888e0e8a80cc20bb4eca49904a45d467c79ccf15ee17e7851e28913cce61`,
selfcheck `bf4df27dad31c86d21c48c03204efdf006fe64a0c95c0d9666e5593066c8a091`,
freeze receipt `a017e370419379d19b6e290f7a81316d691721ba5462b2521f194e89f8a79b21`.
V4 live `issue12-wrapper-runtime-isolation-v4-smoke-20261013` уже подтвердил
canonical entrypoint/Cmd, readonly rootfs, scopedROmounts,7manifestreadpaths,
реальные wrapper/runtimePID7/18/UID1000, secretstatfsTMPFS/mode0400 и denial
существующего foreign secret sentinel с фактическими flags. All8roles запущены. V4 завершился FAIL после120010.425177ms/12002ACK:
shutdown client receipts timeout. Canonical gateway SIGTERM прошёл:
control339.595886ms/exit0/OOMfalse, runtime23.009719ms/stopped.
Independent diagnosis выявил пустой shard: fixture smoke2shards при1client;
shardбезstreams не может отправить shutdown-closed из streamonClose.
Это ошибка fixture, а не runtime signal-forwarding failure. Другие transport
checks replay/reset/slow/evicted/reload/reauth/headroom/budgets true;
admission намеренно notExercised для1client. Cleanup3966.556326msverified,
8ролей/network/private/scopedtmpfs удалены. ResultSHA
`42c5f18c12ae204921afedc177d82042fc24a4d6ca31f69babde00affba07a74`, cleanup
`08e9d28fe1def77e33b73faa4ff69035e733dbd30607e9b39150543eaa9e1188`.
Минимальный normal fixture fix ограничивает smoke shards `Math.min(2,clients)`;
512→2,5000full→10 сохраняются. Existingprofiletest исполняет actualfixture
literal и actualdriver распределение для1/2/512/5000: RED2!==1 доfix,
GREEN29/29/skips0 послеfix, officiallint/AstrareviewPASS.
SetupSHA `088a0fbff6b7329e83e88712cae122b5b36fd1a0933220fcd9d57d3b2f935a49`,
harness `efd94be053512321fbeb47c272b882ddc6ab1e3114c45a269c96bf71620563a1`.
Повтор V4b `issue12-wrapper-runtime-isolation-v4b-nonempty-shard-smoke-20261013`
с unchangedfrozenwrapper и новой frozenfixture receipt
`846f46d855d6ea37ef5feaa72b030010f5dd2fd88533b221a6c1d99ac9ab03ec`
завершился без executionerror:120000.07982ms/12001ACK,actualshutdown1live/
1armed/1closed,forcedclosefalse/workererrors0,reset→serverclose1ms,
containerexit0/OOMfalse/hostelapsed337.347207ms. Cleanup4002.132401msverified,
8ролей/network/private/scopedtmpfs удалены, root inventory пуст.
Transport result сохраняет FAIL/missingONLYadmission, который специально
не упражнялся1client; его статус не переписан. Отдельная immutable receipt
`runtime-isolation-proof.json` verifiedtrue **только для canonical isolation и
oneclient shutdown**, launchProoffalse/capacityfalse, связывает result/cleanup/
containers/manifest SHA. ReceiptSHA
`7f9e7549d63c0d1688ce00c8f342e5e4e458334372891fcdd6157a8e126953c0`,
result `692e1154158a70d0afdde884672b49df271564e6b9dc94933abcf418e01bbc55`,
cleanup `cff712e2ee6ce883fcac0b8888a99888d80d3714a926cb4b346132672b6b8313`.
Admission/fullcapacity не подменяются oneclientproof; productionSOPS/deploy
этим runtimeisolation evidence не доказываются.

Дополнительная read-only карта private EOF gap: existing harness получает
actual Hub encoded A и prefix B, удерживает последний полный cursor и вручную
проверяет replay B/reset-before-ready. Owner-browser использует настоящий
Chromium EventSource/nginx/Hub, но control restart выполняет graceful reset,
не mid-frame truncation; request Last-Event-ID там не наблюдается.
Минимальный будущий proof — расширить existing owner-browser flow one-shot
truncation только compiled snapshot и наблюдать `/events` request cursor:
complete A, B без blank delimiter, EOF, тот же native EventSource,
Last-Event-ID=A, полный replay B перед ready. Новый runner не требуется.
Fault seam был не реализован на момент этого read-only исследования;
production adoption framing без live proof не заявляется. Это проверка
восстановления, не capacity workaround.

Read-only проверка existing owner helpers уточнила путь для двух настоящих
realtime outbox rows: после ready повторный `f.observe()` создаёт новую
`observed_revision` и material projection A; затем `f.proof(newObservation)`
переводит projection из OutOfSync в InSync и создаёт B. Эти входные producer
envelopes создаются существующей тестовой fixture; реально исполняются owner
Inbox/store/projection/outbox, relay, Kafka, nginx и браузер. Такой proof
не заявляет проверку production observer/convergence producers. Ограниченная
реализация EOF-проверки поручена в существующих owner-browser fixture и caller:
однократный обрыв B только в compiled snapshot, без production fault hook,
нового runner или ручной записи realtime event/projection. Реализация готова:
fixture SHA `609be605276c7c92e5e610cffa87df507b4eeff76f76e6833189c7bb225ab5b8`,
caller SHA `9ad1a312528cdcd7d5ce33e52cd7bde343f70a4c167088c89785e59368782700`.
Syntax и exact compiled transform anchors/syntax прошли. После A тест ждёт
нового owner GET с projectionVersion A до создания B. Live команда начата:
`PATH=/tmp/coffee-12-proof-bin-jBGChb:$PATH TMPDIR=/home/yurgusev/.hermes/cache/scratch COFFEE_DB_LIVE_PROOF=1 COFFEE_REALTIME_OWNER_LIVE_PROOF=1 node --test --test-name-pattern='preparation owner realtime vertical through served browser' tests/orders/aroma-preparation-live.test.mjs`.
Результат ещё не получен; ранее полученный owner-browser PASS и новый запуск
без live flags с expected skip не засчитываются за EOF.

Первый EOF live завершился FAIL: 90941.669831 ms, tests 1 / pass 0 / fail 1 /
skipped 0; лог `/tmp/coffee-12-eof-owner-browser-live.log`, artifacts
`issue12-owner-browser-DqX3ur/transport`. A, второй open/ready, B и InSync owner
GET достигнуты, но recorder `request.headers()` записал null вместо cursor A
`msg_01M4T1H4SPQ4XVH2QSD5KEWBXS`. Этот API возвращает неполный набор headers;
нужен awaited `request.allHeaders()`, но причина null до фактической повторной
проверки не установлена. Assertion не ослабляется. Independent review требует
ещё constructor/identity witness того же native EventSource и реальные
Cache-Control/Connection/X-Accel headers обеих публичных responses.
Callback/drain→end seam source review прошёл: Hub callback планирует следующий
pump асинхронно, а не пишет следующий кадр синхронно после B. Cleanup
3546.901993 ms verified: 7 транспортных ролей, owner resource, сеть и private
material удалены; root inventory owned containers пуст. Новый live PASS
ещё отсутствует, production adoption не принята.

EOF witness исправлен в существующем fixture: awaited `request.allHeaders()`
сохраняет только Last-Event-ID, `response.allHeaders()` — whitelist четырёх
публичных SSE headers. Ошибка получения headers приводит к failed availability
assertion, null cursor не принимается. Native wrapper фиксирует instance ordinal:
один созданный EventSource, A/B и первые два open одного экземпляра до restart.
Обе реальные responses проверяются на status/content-type, `Cache-Control:
no-cache, no-transform`, `Connection: keep-alive`, `X-Accel-Buffering: no`.
Безопасный failure witness не содержит cookies/Authorization или полных headers.
Fixture SHA `af803b960f0bccc5c02839513a033d756cf6788a00726c9d2692a0dce90fc8e4`,
caller SHA прежний. Syntax PASS; повторный live run начат, лог
`/tmp/coffee-12-eof-owner-browser-live-v2.log`. Причина первого cursor null и
итог публичной совместимости до этого результата не считаются доказанными.

EOF live v2 PASS: exit 0, tests 1 / pass 1 / fail 0 / skipped 0,
93309.628980 ms; artifacts `issue12-owner-browser-sL8T9s/transport`.
`owner-browser-proof.json` SHA
`ef17dc2c1e96cffe6d5d22683833ffea947163ceeca501e448bba27665d36291`,
manifest SHA `587248acdaa64acc915aba9c0d9b814e7baff61b58962fd3636028e3c8fa5c15`.
Original compiled composition SHA
`4499918569eb794eac00de3be360368042e875b62d4d55974561a027cee8bb2d`,
transformed SHA `293ec746fd159f207997d7eb6e4279d47da1fe5795726628362b3731a16ded4d`.
Один native EventSource, первые два open и A/B имеют ordinal 1.
Полный header witness теперь подтверждает Last-Event-ID A
`msg_01M4T1WZW4RPZYFBZSZ71G6Z4E`; полный B
`msg_01M4T1X0W18N9YMBQH1E3B6ZQR` доставлен при retained replay до ready,
не вызывает refetch до повторного open. Owner projectionVersion 4 → 5 → 6,
business version 2 неизменна, OutOfSync → OutOfSync → InSync, пять owner GET.
Duplicate/stale/restart/reset не меняют owner Card/Outbox. Обе публичные
responses: HTTP 200, exact content-type, cache-control, connection keep-alive
и X-Accel-Buffering no. При fault callbackDone true, writeReturned true,
drainRequired/observed false, endCalled true; false-write/drain ветка этим
одноклиентским прогоном не упражнялась. One-shot усечение удалило один байт
завершающего blank delimiter B; reset/destroy не использованы. Cleanup
3644.696599 ms verified, 7 ролей + owner/network/private удалены, root owned
inventory пуст. Это bounded EOF/recovery/public-compatibility proof на 1 клиенте
с 512 MiB gateway/nginx, а не 5000-client capacity или production adoption.
Первая запись null была неполным observer witness; первый FAIL сохранён.
Источник production runtime не менялся, новый fault path существует только
в compiled disposable snapshot теста.

Дополнительная проверка private TLS: gateway уже вызывает
`socket.isSessionReused()` и считает resumed/cold/unknown отдельно. Финальные
V44v2 totals worker1 resumed2892/cold113, worker2 resumed2869/cold125 включают
preflight/direct health/cleanup; они не привязаны к конкретным nginx запросам
и не используются как strict pre-threshold evidence. nginx upstream имеет
`zone realtime_tls_state 64k`, proxy_ssl_session_reuse включён по умолчанию.
[Node26.8.1](https://nodejs.org/download/release/v26.8.1/docs/api/tls.html)
разделяет ticket keys через cluster;
[nginx proxy](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_ssl_session_reuse)
сохраняет upstream session. В закреплённом nginx1.31.6 round-robin peer
использует shared zone. Чередование TLS workers само по себе не доказывает
потерю resumption; менять ticket keys/session pool на основании этой гипотезы
не требуется.

Live GitHub read 19:11 UTC: #12 остаётся OPEN, 64 checkboxes / 48 checked,
body SHA-256 `90d63ce2ac7b3af4364bcda88f44cebcb1a83c155936c1e3468753a147976716`.
Origin и `gh repo view` подтверждают только YurGusev/CoffeeOrderPlatform,
remote develop остаётся `91675aaa56900613505bfbd8cd14981b07cec000`.
Remote mutations, коммит, push, PR и merge не выполнены.
Повторный read в 20:25 UTC подтвердил то же issue body/update timestamp/hash
и тот же remote develop; новые требования или изменения checkbox не появились.
Read в23:04UTC подтвердил прежние body SHA/64checkboxes48checked/OPEN/update
timestamp. Последний remote develop read остаётся20:25UTC; remote mutation
обязана повторно проверить origin и gh repo view.
Read23:47UTC подтвердил неизменные body SHA/64checkboxes48checked/OPEN/update
timestamp и remote develop `91675aaa56900613505bfbd8cd14981b07cec000`.
Read13.10.2026 01:22UTC подтвердил прежние issue body SHA/64checkboxes48checked/
OPEN/update timestamp. Origin, `gh repo view` и remote develop подтверждены
в01:22UTC; remote mutations не выполнялись.
Read13.10.2026 02:40UTC подтвердил тот же bodySHA/64checkboxes48checked/OPEN/
updatedAt2026-10-12T03:14:32Z. Origin, ghrepo authority и remote develop вновь
подтверждены; внешних мутаций нет.
Read13.10.2026 03:48UTC подтвердил тот же issue bodySHA/64checkboxes48checked/
OPEN/updatedAt, точный origin/ghrepo authority и прежний remote develop.
Коммит/push/PR/merge/closure по-прежнему не выполнены.

Кандидат прямо конфликтует с текущими решениями: `01_RUNTIME_ARCHITECTURE.md:37`
и ADR-0018:95 требуют один Node process на container и отвергают `node:cluster`.
Запрет второго realtime instance в spec §2 сохраняется: эксперимент использует
один instance и одного владельца Kafka/replay, а не второй независимый Hub.
`config/platform.schema.json:244` и permission manifest фиксируют
`childProcess=false`, `workers=false`. Новый ADR должен явно заменить только
затронутые обычные решения; immutable revision roots сохраняются.

Предварительные границы эксперимента:

- один master остаётся единственным `realtime-gateway-v1` Kafka consumer и
  владельцем sequence/ring; отдельные TLS-процессы не получают своих consumers;
- bounded IPC должен сохранять atomic replay/live boundary и принятие события
  в ring и нужные очереди до commit; общие 5000 connections, queue/ring/RSS/FD
  budgets нельзя умножить числом процессов;
- каждый новый request по-прежнему проверяет mTLS и свежий actor context;
  раздача scoped secrets, разрешение создания процессов и граница bootstrap
  требуют отдельного security-решения, а не выключения permission enforcement;
- readiness зависит от всех partitions и transport processes; graceful shutdown
  закрывает всех клиентов, очереди и процессы в прежнем общем 20s bound;
- 5000/5001, 100 ACK/s, 30min, TTL, retry, gap, latency, headroom, cleanup и
  штатный HUP сохраняются; эксперимент сначала проверяет реализуемость и общие
  ресурсы, затем все обязательные проверки. FAIL не даёт права на merge.

Затрагиваемые места для отдельного решения: ADR/spec/runtime architecture,
realtime composition/hub/main, lifecycle в `platform-runtime`, schema/config и
permissions/bootstrap, Docker/fixture evidence и существующие realtime tests.
Публичный HTTP/SSE payload не меняется. Production implementation diff пока отсутствует:
эксперимент разрешён, выигрыш не измерен. Если эксперимент подтвердит путь,
оставляется одна итоговая реализация и выполняется обычный frozen full profile.

Проверена ветка `feature/12-realtime-order-card`, созданная от `develop@91675aaa56900613505bfbd8cd14981b07cec000`. Порядок строк соответствует всем 64 checkbox live issue. Код, тесты и live-проверки учитываются раздельно; процессные пункты принимаются только после фактического события.

Повторная read-only проверка GitHub12.10.2026 18:27UTC: origin и `gh repo view`
подтвердили `YurGusev/CoffeeOrderPlatform`, default/develop и remote develop SHA
`91675aaa56900613505bfbd8cd14981b07cec000`. Issue12 OPEN,64checkbox/48checked,
updatedAt2026-10-12T03:14:32Z, body SHA
`90d63ce2ac7b3af4364bcda88f44cebcb1a83c155936c1e3468753a147976716`.
Remote mutations не выполнялись; checked в issue не подменяет status в этой таблице.

Подтверждённые исправления:

- R1: ограничение всего DLQ envelope, digest для oversized wire и безопасный key; offset только после broker ACK.
- S1: route-specific `finish` вызывает `end()` у сохранённого TLS socket после flush SSE; контракт keep-alive headers сохранён. Regression с настоящим keep-alive HTTPS agent переведён red→green; `pnpm test:realtime-auth` — 7/7. Native smoke 512 клиентов подтвердил reset→server close для каждого клиента; shutdown занял 612 мс.
- V1: join обеих observer-задач до fixture cleanup, включая error path.
- V2: SIGTERM живой группы, настоящий reset → server close для каждого клиента; старый сценарий остановки пустого runtime отвергается.
- N3: readiness не открывается до assignment и fetched watermarks всех partitions; проверены отрицательные случаи.
- N4 — исторический эксперимент, удалён из текущего решения: custom nginx build и его три source/test/patch файла больше не используются. На 1 GiB выбран provisional stock-кандидат: закреплённый официальный nginx image, resolved image ID проверяется при freeze/run. Короткие stock-контроли не доказали 30-minute capacity; решение принимается только после полного прогона. Исторические ASan/UBSan и build receipts сохранены как история, а не evidence финального image.
- Проверены JSON-redaction и все три состояния UI-индикатора.
- V3: общий write-pump ограничивает 64 соединения за один проход event loop;
  microtask cascade заменён bounded scheduler, selected immutable hint общий
  для fanout. Regression RED подтвердил starvation другой I/O-задачи, GREEN
  проверяет прогресс между партиями. Pending scheduler удерживает loop;
  shutdown regression запрещает ожидание постороннего таймера.
- V4: event-loop p95 относится к непустому окну между metric reads;
  sample count монотонный, пустое окно сохраняет последний actual p95.
  Regression обнаруживает 200-мс блокировку после длинного normal baseline.

После сохранённых ниже отказов на 512 MiB пользователь явно согласовал по
1 GiB nginx и realtime-gateway только для isolated-5000. Authority —
`platform.realtimeFullProfileMemoryBytes=1073741824`; reference Compose, reference-512 smoke
и owner-browser остаются на 512 MiB. Прототипы MFL, request pool 512 и heap 96
в продукт не включены. Функциональные, security, TTL и 30-минутные критерии
сохраняются. Последний обычный полный профиль V14 завершился FAIL через
77682.198 мс на gateway readiness во время re-auth; capacity не доказана. Короткий V10 control
с обычным 4 KiB upstream buffer подтвердил admission, headroom и loaded shutdown,
но завершился FAIL: event p95 составил 1107 мс. Полный 30-минутный прогон и
нагруженная re-auth остаются ожидающими. Исторические FAIL не превращаются в
PASS. Утверждение, что прежний 1 KiB buffer ограничивал только SSE headers,
оказалось неверным и исправлено в V10.

| № | Требование issue | Код и проверки | Доказательство |
|---:|---|---|---|
| 1 | Предшественники: baseline #3; прямые inputs: #8, #9, #11 и #63 merged в `develop`. | Issue inputs; root проверил hashes: #8 (76 выходов), #9 (59), #11 (139), #63 (36), и #119 (18), #160 (10), #162 (19) | код и подтверждение: hashes проверены |
| 2 | Вход: `RealtimeInvalidated.v1`, trusted actor context, Order detail query identity #9 и owner GET #8/#11. | apps/realtime-gateway/src/contract.ts decodeRealtimeEnvelope; apps/web/src/realtime/order-invalidations.ts; contracts/openapi/client-v1.yaml; tests/realtime/contract.test.mjs | код + модульные тесты |
| 3 | Выход: Kafka→bounded SSE→TanStack Query invalidation/refetch, recovery/capacity evidence и `evidence/handoffs/issue-12.yaml`. | apps/realtime-gateway/src/hub.ts; apps/web/src/realtime/order-invalidations.ts; evidence/handoffs/issue-12.yaml не завершён | процессный шаг ожидает |
| 4 | Разблокирует: #13. | Требуются завершённые merge/handoff #12 | процессный шаг ожидает |
| 5 | Принять merged handoff #119 до реализации уточнённого frontend/recovery scope; остальные prerequisites этой задачи сохраняются. | Root подтвердил accepted source/hash (#119, 18 выходов) | код+evidence: hash verified |
| 6 | Realtime не имеет DB/business state; только invalidation/reset/refetch, authorization и bounded buffers по owning specification. | apps/realtime-gateway/src/hub.ts RealtimeHub; scripts/check-architecture.mjs; tests/architecture/checks.test.mjs; успешный `pnpm architecture:check` | код + модульные тесты |
| 7 | Создать `apps/realtime-gateway`; БД, business cache и owner HTTP client отсутствуют. | apps/realtime-gateway/src/runtime-composition.ts; config/permissions/realtime-gateway.json; architecture gate | код + модульные тесты |
| 8 | Первый запуск использует ровно один экземпляр `realtime-gateway` и fixed group `realtime-gateway-v1`; consumer читает только topic `coffee.realtime.invalidate.v1`, key subjectRef, auto topic creation/auto commit запрещены. Multi-replica fanout требует отдельного issue и не входит в launch-v1. | config/platform.yaml realtime-gateway; packages/platform-kafka-runtime; tests/kafka/runtime.test.mjs; tests/realtime/auth.test.mjs readiness | код + native smoke: один instance и fixed group подтверждены |
| 9 | Schema validate до fanout; first launch принимает только `subjectType=order`. | apps/realtime-gateway/src/contract.ts decodeRealtimeEnvelope; tests/realtime/contract.test.mjs | код + модульные тесты |
| 10 | Duplicate messageId — no-op; lower/equal ownerVersion одного subject не fanout; equal version с другим payload — quarantine. | apps/realtime-gateway/src/hub.ts accept/digest; tests/realtime/contract.test.mjs retained IDs/version conflicts | код + модульные тесты |
| 11 | Unknown schema/type и event >2KiB — quarantine/DLQ, без SSE. | apps/realtime-gateway/src/contract.ts schema/size guard; tests/realtime/contract.test.mjs; tests/kafka/runtime.test.mjs near-limit/oversized-key regression (R1 fix) | код + модульные тесты |
| 12 | Offset commit после ring buffer/fanout enqueue. Crash допускает gap, который закрывает reset/refetch, а не realtime DB. | packages/platform-kafka-runtime; tests/kafka/runtime.test.mjs commit order; apps/realtime-gateway/src/hub.ts; tests/realtime/auth.test.mjs | код + модульные тесты |
| 13 | Public route существует только через nginx #162; direct realtime-gateway port private. | compose.yaml; config/service-catalog.json; tools/nginx/generate.mjs; tests/nginx; native nginx smoke | served nginx transport подтверждён native smoke и owner-browser proof |
| 14 | Private Edge-авторизатор #160 проверяет session/JWT и подписывает actor context с `aud=realtime-gateway`; nginx #162 удаляет client actor headers и передаёт только trusted assertion. | apps/edge-gateway; apps/realtime-gateway/src/runtime-composition.ts verifier; tests/realtime/auth.test.mjs | код + native smoke: expiry и повторная Edge-авторизация 512/512 |
| 15 | Gateway требует server permission `orders:read:any`; 401/403 возвращаются RFC 9457 до SSE headers. | apps/realtime-gateway/src/runtime-composition.ts; tests/realtime/auth.test.mjs denial/header assertions | код + модульные тесты |
| 16 | Endpoint не принимает query/body actorRef, permission, subject/order filters. Клиент не выбирает доступные subjects. | contracts/openapi/client-v1.yaml stream operation; runtime route schema; tests/realtime/contract.test.mjs/auth.test.mjs | код + модульные тесты |
| 17 | Каждые 30s проверять expiry actor context; expired stream закрывается, reconnect повторно авторизуется через edge. | apps/realtime-gateway/src/hub.ts auth timer; tests/realtime/auth.test.mjs expiry/renewed token | native smoke: 512/512 disconnect/reconnect; полный capacity cohort ожидает |
| 18 | Response headers строго: `text/event-stream; charset=utf-8`, `no-cache, no-transform`, keep-alive, `X-Accel-Buffering:no`. | apps/realtime-gateway/src/runtime-composition.ts; tests/realtime/auth.test.mjs; contracts/fixtures/positive/sse/order-invalidations.json | контракт и headers подтверждены через native nginx |
| 19 | `resource-invalidated.v1`: id=Kafka messageId; retry=3000; data только `subjectType`, `subjectRef`, decimal `ownerVersion`, `reason`, `correlationId`. | apps/realtime-gateway/src/contract.ts invalidationFrame/eventData; tests/realtime/contract.test.mjs; positive SSE fixture | код + модульные тесты |
| 20 | Customer/items/money/Desired/Observed/blockers/allowedActions/provider data запрещены schema и negative fixtures. | OpenAPI SseResourceInvalidated additionalProperties=false; apps/web/test/realtime.test.ts; browser negative frames in operator-flow.spec.ts | код + модульные тесты |
| 21 | После auth, replay/reset и установки live delivery отправить `stream-ready.v1` без id; heartbeat каждые 15s как SSE comment. | apps/realtime-gateway/src/hub.ts open; tests/realtime/auth.test.mjs/backpressure.test.mjs; positive/negative SSE fixtures | ready, replay/reset и heartbeat подтверждены через native nginx |
| 22 | `stream-reset.v1` без id содержит только `reason=REPLAY_UNAVAILABLE`. | apps/realtime-gateway/src/hub.ts; generated SseStreamReset; tests/realtime/replay.test.mjs; negative SSE fixture | код + модульные тесты |
| 23 | Instance ring buffer: максимум 10 000 invalidations или 5 минут, первый достигнутый лимит; business state отсутствует. | config/platform.yaml realtime limits; apps/realtime-gateway/src/hub.ts prune; tests/realtime/replay.test.mjs eviction | код + модульные тесты |
| 24 | Header отсутствует → установить live delivery → ready; ID найден → replay subsequent/local ordered events → установить live delivery → ready → live frames. | apps/realtime-gateway/src/hub.ts boundary/replay pump; tests/realtime/replay.test.mjs; tests/realtime/auth.test.mjs | код + модульные тесты |
| 25 | Malformed/not found/evicted/restart/другая replica → stream-reset → установить live delivery → ready → live frames. | apps/realtime-gateway/src/hub.ts; tests/realtime/replay.test.mjs; частичный native smoke | reset/replay через nginx и owner restart/refetch подтверждены; полный capacity ожидает |
| 26 | Query `lastEventId` запрещён; persistent replay DB/sticky session не добавлять. | OpenAPI stream params; runtime composition; architecture/config checks; tests/realtime/contract.test.mjs | код + модульные тесты |
| 27 | Replay является оптимизацией; безопасный результат всегда достигается owner refetch. | apps/web/src/realtime/order-invalidations.ts; operator-flow.spec.ts reset/refetch; tests/realtime/replay.test.mjs | код + модульные тесты |
| 28 | Материализовать fixed group `realtime-gateway-v1` в config/platform.yaml/schema вместо scaffold group; process-wide queue/RSS/FD/container budget и admission задать через тот же config и доказать soak test. | config/platform.yaml/platform.schema.json budgets; hub capacity; целевой tests/realtime/soak.test.mjs | требуется live-проверка: полный профиль 5000×100/s×30min ещё не выполнен |
| 29 | Максимум 5 000 connections на instance; 5 001 получает `503 REALTIME_CAPACITY_EXCEEDED` до SSE headers. | apps/realtime-gateway/src/hub.ts capacity; tests/realtime/backpressure.test.mjs local boundary; tests/realtime/auth.test.mjs early 503 | подтверждены реальные 5000 unique и 5001-й pre-header typed503 в чистых V6/V7; полный 30min и нагруженный shutdown ещё не приняты |
| 30 | Queue одного connection: максимум 64 records или 256KiB serialized. | config/platform.yaml; apps/realtime-gateway/src/hub.ts enqueue; tests/realtime/backpressure.test.mjs exact 64/65 and bytes | код + модульные тесты |
| 31 | Socket write deadline 5s; heartbeat 15s; nginx idle timeout минимум 45s. | config/platform.yaml; hub timers; nginx config; tests/realtime/backpressure.test.mjs; nginx config tests | таймеры и idle/heartbeat native smoke подтверждены |
| 32 | Coalesce одного subject в окне 250ms: оставить наибольшую ownerVersion/message id выбранного event. | apps/realtime-gateway/src/hub.ts pending/coalesce; tests/realtime/replay.test.mjs/backpressure.test.mjs | код + модульные тесты |
| 33 | Overflow/write timeout/socket abort немедленно удаляет connection, queue, listeners и timers; медленный client не блокирует consumer/других. | apps/realtime-gateway/src/hub.ts cleanup/pump; tests/realtime/backpressure.test.mjs timeout/abort/peer | код + модульные тесты; проверка transport stress ожидает |
| 34 | Graceful shutdown 20s: stop accept, stream-reset, close sockets, затем consumer. | apps/realtime-gateway/src/hub.ts shutdown/drain; apps/realtime-gateway/src/runtime-composition.ts S1 socket finish; runtime lifecycle; tests/realtime/backpressure.test.mjs; config/platform.yaml shutdownGraceMs=20000 | Короткий native smoke: 512/512 клиентов получили reset → server close за 612 мс без forced close. В V10 control загруженная группа из 5000 клиентов получила 5000/5000 reset → server close за 3581.880 мс; максимум от reset до close — 42 мс, `forcedClientClose=false`, root exit 0. Полный 30-минутный профиль остаётся ожидающим. |
| 35 | Создать `apps/web/src/realtime/order-invalidations.ts`: один same-origin EventSource на tab, session cookie через edge; ручных auth/actor headers нет. | apps/web/src/browser/app/OrderRealtime.tsx; operator-flow.spec.ts native source/cookie/headers | код + модульные тесты |
| 36 | Runtime validate каждый frame; принять только valid order ref/version. | apps/web/src/realtime/order-invalidations.ts; apps/web/test/realtime.test.ts schema drift/invalid frames; operator-flow.spec.ts | код + модульные тесты |
| 37 | `resource-invalidated`: exact invalidation/refetch TanStack Query Order detail по `subjectRef`; SSE data никогда не записывать в TanStack Query cache. | apps/web/src/realtime/order-invalidations.ts; apps/web/test/realtime.test.ts; operator-flow.spec.ts | код + модульные тесты |
| 38 | Cached `OrderCard.projectionVersion >= ownerVersion` допускает duplicate skip; меньшая версия не откатывает UI, equal version с другим payload quarantined, новая/unknown/gap версия запускает owner GET; response принимается через общий monotonic projectionVersion guard #9. | apps/web/src/realtime/order-invalidations.ts; browser/api/order-card.ts; browser/api/remote.ts; order-cache.test.ts/operator-flow.spec.ts | код + модульные тесты. SSE содержит только метаданные, поэтому frontend не сравнивает payload invalidation; gateway отправляет равные версии с конфликтующим Kafka payload в quarantine, а guard #9 проверяет divergent owner GET |
| 39 | `stream-reset`: invalidates все уже materialized Order-detail query keys и refetches только active; Customer/Catalog/Pricing queries не затрагиваются. Используется существующий prefix #9, новый namespace или второй QueryClient не вводится. | apps/web/src/realtime/order-invalidations.ts; query-keys.ts; realtime.test.ts/operator-flow.spec.ts | код + модульные тесты |
| 40 | Использовать native reconnect + server retry=3000; второй retry loop запрещён. | apps/web/src/browser/app/OrderRealtime.tsx native EventSource; apps/web/test/operator-flow.spec.ts проверяет тот же EventSource и Last-Event-ID при reconnect; положительная SSE fixture фиксирует retry=3000 | код + модульные тесты |
| 41 | UI indicator `Подключено\|Переподключение\|Обновление состояния` не меняет Order/AROMA state. После 30s offline — banner и manual owner refetch. | apps/web/src/browser/app/OrderRealtime.tsx:32-55,90-100; apps/web/src/browser/app/AppShell.tsx:46,58; apps/web/test/operator-flow.spec.ts:2262,2442,2493 прямо проверяет все три надписи, а также banner/refetch. | код и browser-тесты подтверждены |
| 42 | На каждом stream-ready, включая первое подключение без Last-Event-ID, инвалидировать существующие Order detail queries и refetch только active; закрыть окно initial GET → subscription. | apps/web/src/realtime/order-invalidations.ts initialRead branch; apps/web/test/realtime.test.ts ready/inflight; operator-flow.spec.ts first-ready races | код + модульные тесты |
| 43 | Gateway готовит boundary/queue без промежутка потери событий и отправляет ready после replay/reset и установки live delivery. Новый reconnect loop не создаётся. | apps/realtime-gateway/src/hub.ts open ordering; tests/realtime/replay.test.mjs; operator-flow.spec.ts same native EventSource | native EventSource и owner-browser vertical подтверждены |
| 44 | Refetch использует monotonic projectionVersion guard #9; late response не откатывает карточку. | browser/api/order-card.ts acceptOrderCard; browser/api/remote.ts queryFn; order-cache.test.ts; operator-flow.spec.ts late GET | код + модульные тесты |
| 45 | Logout/session switch закрывает EventSource/listeners и отбрасывает late handlers; session не разделяет cache с другим пользователем. | browser/app/OrderRealtime.tsx cleanup/isCurrent; session-identity.ts; remote.ts cache clear; operator-flow.spec.ts switch/logout | код + модульные тесты |
| 46 | Kafka schema/key/version/dedup/out-of-order/quarantine. | tests/realtime/contract.test.mjs; tests/kafka/runtime.test.mjs includes bounded DLQ near-max input and oversized transport key regression | код + модульные тесты; R1 kafka_fix включён по сверке root |
| 47 | Auth: no session, wrong permission/audience, forged headers, expiry и reconnect re-auth. | tests/realtime/auth.test.mjs covers no client, claims, forged transport, expiry and fresh signed context | denial unit/runtime и expiry/re-auth native smoke 512/512 подтверждены |
| 48 | Wire headers/frames/UTF-8/heartbeat и negative business-field fixtures. | apps/realtime-gateway/src/contract.ts; tests/realtime/auth.test.mjs/contract.test.mjs; positive/negative SSE fixtures | код + модульные тесты |
| 49 | Last-Event-ID replay found и reset для malformed/missing/evicted/restart. | apps/realtime-gateway/src/hub.ts; tests/realtime/replay.test.mjs; в 512/120s native smoke replay/reset прошли | код + модульные тесты; полный capacity/restart cohort V2 ожидает |
| 50 | Frontend exact invalidation, inactive no eager fetch, reset query keys и refetch через общий monotonic owner-response guard #9, без записи SSE payload. | apps/web/test/realtime.test.ts; order-cache.test.ts; operator-flow.spec.ts | код + модульные тесты |
| 51 | Duplicate/lower invalidations не откатывают UI. | apps/web/src/realtime/order-invalidations.ts BigInt; realtime.test.ts/operator-flow.spec.ts | код + модульные тесты |
| 52 | Capacity: 5 001 connection, 65 records, >256KiB, stalled 5s, abort и graceful shutdown с cleanup. | tests/realtime/backpressure.test.mjs local hub boundaries/cleanup; tests/realtime/auth.test.mjs early 503; native smoke: admission 513 при 512 live отклонён до SSE headers; graceful close 512/512 | Локальные границы очереди, bytes, stall/abort и 512-client shutdown проверены. Реальные 5000/5001 admission прошли; V10 control также подтвердил loaded shutdown всех 5000 клиентов за 3581.880 мс, максимум reset → close — 42 мс. Остальные capacity criteria и полный 30-минутный прогон не приняты. |
| 53 | Soak: 5 000 connections, 100 invalidations/s, 30min; RSS/event-loop/fd/p95 evidence. | целевой tests/realtime/soak.test.mjs; frozen manifests и scratch result/cleanup receipts | Последний обычный full V14 — FAIL через 77682.198 ms / 7769 ACK. Последний контрольV58 — FAIL через81270.834ms/8127ACK: direct privategateway health1218.060ms при1000ms gate; max processloop63.537ms. ActualCPUshares4096/weight303 уGW/NGX; всеhardceilings прежние, приёмкаweightedprofile не прошла. V56 с порцией16 такжеFAIL80298.457ms/8028ACK. V53 также FAIL81964.543ms/8197ACK/session1159.170ms. 5000 actual cold authorized TLS1.3 receipts сохранены. Последний profiled V55 — driver FAIL через 8082.737 ms / 809 ACK: API 1005.370 ms при 1000 ms; поздняя ошибка monitor заменила primary error в coordinator receipt. Три CPU-профиля сохранены, но не подтверждают re-auth/full; исправление reporting отдельно проверено. Единственный разрешённый gateway 3CPU контроль V51 также FAIL; production budget прежний. Диагностические кандидаты не принимаются как production proof. Полный 30-минутный профиль, cohort re-auth и final p95 не приняты. |
| 54 | `pnpm architecture:check`: только event/platform Kafka/SSE packages; owner runtime/domain/repository/DB запрещены. | scripts/check-architecture.mjs; tests/architecture/checks.test.mjs; recorded pnpm architecture:check | код + модульные тесты |
| 55 | Manifest/config/bundle/redaction: нет DATABASE_URL, DB/AROMA secrets, PII/business payload; только `kafka.realtime`, actor verification и telemetry. | config/permissions/realtime-gateway.json; config/platform.yaml/schema; architecture/runtime checks | config/manifest/permissions/schema/bundle/redaction gates пройдены; real fixture проверила собственные RO mounts/UID1000/запрет чужих secret files. Synthetic productArgs основной нагрузки запускает bare Node. Дополнительный V4 подтвердил canonical permission-enforce entrypoint, реальные дваNodePID, scopedROmounts/UID1000/secret0400/tmpfs и actualflags foreign-secret denial; повторV4b подтвердил1clientreset→serverclose/exit0/cleanup, отдельный isolation receipt verifiedtrue. TransportFAIL/missingadmission сохранён. Реальный SOPS MAC/deploy не проверены и не добавляются к формальному пункту55. |
| 56 | Проверить потерю hint между initial GET и первым ready, lower replay/late GET и logout во время refetch; inactive queries не вызывают eager requests. | apps/web/test/realtime.test.ts; operator-flow.spec.ts race/logout/inactive; issue snapshot фиксирует эти проверки | код + модульные тесты |
| 57 | Обновить указанные owning документы по итоговому поведению и создать `evidence/handoffs/issue-12.yaml` по protocol delivery graph: accepted inputs, hashes outputs, consumers, фактические команды и limitations. | docs/launch/20_REALTIME_SSE_IMPLEMENTATION_SPEC.md и 30_FRONTEND_OPERATOR_RUNBOOK.md изменены; handoff YAML не завершён/принят | процессный шаг ожидает |
| 58 | Ветка `feature/12-realtime-order-card` только от `develop`; PR только в `develop`. | Local branch name/base; PR не создан | процессный шаг ожидает |
| 59 | Один issue — одна ветка — один PR; gateway, frontend adapter, contracts, tests, capacity evidence и docs находятся в PR. | Локальная ветка включает scope; PR нет | процессный шаг ожидает |
| 60 | Коммиты, PR и review replies — на русском; PR содержит `Closes #12`. | PR/commit delivery evidence отсутствует | процессный шаг ожидает |
| 61 | Статусы: `Готово к работе → В работе → На проверке → Готово`; после merge публикуется handoff #12. | Remote issue/merge actions не выполнены | процессный шаг ожидает |
| 62 | Принять auth contract [#160](https://github.com/YurGusev/CoffeeOrderPlatform/issues/160) и transport handoff [#162](https://github.com/YurGusev/CoffeeOrderPlatform/issues/162) без снятия прежних inputs #8/#9/#11/#63/#119. | Root проверил hashes: #160 (10 выходов), #162 (19 выходов) | код и подтверждение: hashes проверены |
| 63 | Проверить, что realtime допускает только transport SAN `edge-nginx` + assertion signer `edge-gateway`, `aud=realtime-gateway`; spoofed browser actor, неверные audience/SAN и просроченный контекст отклоняются. | runtime-composition verifier; tests/realtime/auth.test.mjs claim/transport cases; TLS harness regression receipt | transport/claims отрицательные проверки и native re-auth smoke пройдены |
| 64 | Проверить EventSource через nginx: SSE buffering выключен, stream-reset/ready, reconnect после auth expiry, лимит 5 000 соединений, idle/heartbeat budget; nginx не реализует replay/fanout/permissions вместо realtime. | tools/nginx/generate.mjs/config checks; native smoke receipt подтверждает TLS/SASL_SSL, реальный authorizer/composition, replay/reset/reconnect и shutdown 512/512; EOF owner-browser live v2 PASS подтверждает same-instance cursor A, retained replay B перед ready и публичные headers | native smoke512, owner-browser и bounded EOF proof подтверждены; admission5000/5001 прошла, fullcohort re-auth/HUP/30min pending |

## Команды и результаты

Проверка дерева после N4 до согласованного изменения full-profile бюджета и V3/V4:

- `pnpm check` — ПРОЙДЕНО, exit 0: 815 тестов, 744 пройдено, 0 ошибок, 71 пропуск, 0 отменено. Пропуски относятся к условным live proof targets и не засчитываются как приёмка.
- `pnpm contracts:check-generated` — ПРОЙДЕНО, сгенерированные контракты byte-identical; SHA-256 `0ab7518590449080f176df90d1de82984759bfa8abffbc8f5566360aef084e97`.
- `pnpm contracts:test` — 49/49; `pnpm architecture:check` — ПРОЙДЕНО.
- `pnpm test:realtime-contract` — 5/5; `pnpm test:realtime-auth` — 7/7; `pnpm test:realtime-replay` — 8/8; `pnpm test:realtime-backpressure` — 13/13.
- `pnpm test:web-realtime` — Vitest 8/8 и Chromium native EventSource 10/10 сценариев.
- `node --experimental-strip-types --test tests/kafka/runtime.test.mjs` — 5/5; `node --experimental-strip-types --test tests/runtime/lifecycle.test.mjs` — 33/33; `node --experimental-strip-types --test tests/realtime/fixtures/harness.test.mjs` — 23/23.
- `pnpm security:secrets` — ПРОЙДЕНО. Общий `pnpm check` также прошёл config/schema/catalog/runtime checks, contracts lint/generation/breaking, TypeScript, architecture, rule parity, oxlint, web build, browser bundle, UI, web foundation и operator flow. Bundle: один JS, gzip 141404B из 256000B.
- После последнего небольшого исправления regression независимого harness: `node --test --test-name-pattern='observer shutdown|shutdown close receipt|fixture log redaction|full capacity requires|client latency diagnostics' tests/realtime/fixtures/harness.test.mjs` — 6/6; `git diff --check` — ПРОЙДЕНО.

Логи команд сохранены локально. Общий gate выполнен после N4; результаты owner-browser и capacity приведены ниже. Targeted gates имеют ноль пропусков. `pnpm nginx:check`, `pnpm versions:check`, canonical native image build и harness 23/23 после N4 также пройдены.

### V56: ограничение порции TLS-записей

Следующая гипотеза использует существующий scheduler: TLS child обрабатывает
16 targets вместо64 за один `setImmediate`-ход. FIFO, повторная постановка
остатка, IPC window/batch64, callback+drain ACK, общий/per-connection queue
budget и owner fanout250ms сохраняются. Это сокращает синхронную порцию,
но может увеличить число IPC/ACK microtask вызовов; выигрыш не доказан.
[Node event loop](https://nodejs.org/en/learn/asynchronous-work/event-loop-timers-and-nexttick#phases-in-detail)
и [Node26.8.1 timers](https://github.com/nodejs/node/blob/v26.8.1/lib/internal/timers.js#L491-L508)
подтверждают передачу управления между `setImmediate`-ходами. Непрерывный
nextTick/microtask loop не добавляется. Кандидат основан на unprofiledV53,
с reviewed terminal-driver observer guard; profiler/mounts V55 отсутствуют.
Gateway source `0921e40af48a481ac3ec8598164f0f031aa2a3ff716af3bf0e49c0b0a5fc5a61`,
patch helper `793a3f10c591e468cf8636ca65882bb3c0c125beb89662c9b01ba5c8bf0ae9b9`,
coordinator `c026f632e6260abf7072d7db93c70108dfc163434f3f2ee60d697e712061579b`,
self-check `3fefd7c4dcdf096742ac467e77c586d36818692f8ef9a326d5afa50216c54b28`.
Worker и independent tester syntax/self-check/minfixture/inverse PASS:
71common+3V56cases и legacy сохранены. Первому tester minfixture не хватало
existing contract.js; копирование полного dist устранило fixture setup failure,
итог PASS. No-undef exit0 с отдельным config, добавляющим4existingNodeglobals,
originalfrozenconfig не менялся. Config SHA
`d96bf3c6d4115a26d071346a7a97f559acd280b380469638f12d9450d9ea9cc5`, testerlog
`28b643b9b27b100bf82b46ffeb81fa0f0d7a54893a30c77b021cf9990635a0fc`.
Astra source reviewPASS; root manifest209sources/38compiled/14supporting
native/images PASS. Frozen manifest
`f949d5fd156b1c16a242ea5e6c05d48b885f371241ab47046f85c2a6cccd0cf1`,
source receipt `199b5f94c3a3540a64a7a0f4c51dec09839fc653a68080333980d60c87c4bebb`,
checks receipt `c46de35e8b055e90d5cc16bf4b76b2ced7b6720646011745dd43fc11e0b129a4`.
Full V56 `issue12-v56-tls-drain16-full-20261013` завершился FAIL:
80298.456656ms/8028ACK,minLive2511/maxLive5000,maxgatewayloop56.295423ms.
Headroom kind3 — **direct private mTLS gateway `/health/ready`**, а не nginx:
1618.282494ms при1000ms. Terminal-driver observer fix сохранил первичную
ошибку в coordinator result; observer-fatal не заявляется. Result SHA
`4bf417ce262e3cc7dcaf92d5e4b05c0aa7926d9a13d5897d0528d0fc559ac451`,
driver-result `933d8098ff14a7104898cdc2f13706f51a34a278248e2cf19d877655f2f66ab4`.
202reauthrows сохранены, strictprecut анализ выполняется отдельно.
Cleanup3705.297500msverified:8ролей/network/private удалены, root owned
inventory пуст; cleanup SHA
`f96cdcc80abff0eae6fcd0642f805d2a77603f541642e6a2ac716e4849d0cfc7`.
Меньшая порция не устранила re-auth/headroom; V56 в production не принимается.
30min/fullSLO/HUP/loadedshutdown этим запуском не подтверждены.
Профиль5000/5001,100ACK/s,30min,2CPU/1GiB, прежниеTLS/auth/SLO сохранён.

Independent strict V56 audit: first cutoff11:42:38.588Z; parallel kind3
завершился+9ms с1642.465ms и не был первопричиной. Первая probe connect30.417,
secure1537.047,finish1537.175,headers1617.994ms; connect→secure1506.630ms.
Тот же generatedcorrelation UUID вgateway дал HTTP handler35.746ms, вторая
61.768ms. Driverloop p9517.449/max248.513ms наfailedsample. Эти callbacks
не разделяют serveraccept/nativecrypto/clientcallback scheduling.
Доcutoff616successfulheadroom/154perkind; kind3p50 87.9/p95 214.6/max530.5ms.
Strictprecutreauth45successful/allresumed; gaps p50 6.966s/p95 9.806/max9.944s;
85retriesHTTP504, gaps p50 4.608/max4.918s. Полные totals52successful/150retry
включают postcut и не подменяют strictinterval.
Gatewaylatestcomplete11:42:36.946Z:4049streams/25scheduled/116writing,
queue87311records/22.735MB,IPC2126records/557012B; error/reject counters0.
Strictmaxqueue100193records/26.172MB,IPC3200/838400B, loopmax56.295ms.
Publicnginx135strictsamples: acceptqueue197max/latest,drops0/overflows0;
latestcgroup666917µs/~700ms,throttle0,schedstatworkerwait859msaggregate.
Это контекст publicSSEreauth, не listener4401 сбойной privateprobe.
Strict cgrouppeaks gateway830435328B/nginx693661696B/driver1163010048B,
OOM0; budgets соответствующиеразнымролям. Новая V57диагностика планируется
наunprofiledV53: связывает client socketports, serverconnection/secureConnection
и healthcorrelation; повторно использует existing boundedobserver для4401.
Только наблюдение, без изменения холодныхprobe/TLS/TTL/2CPU1GiB/deadlines.
Новые библиотеки, timers, testinfrastructure и productionpaths не добавляются.

V57v1 source/selfcheck/no-undef/legacy PASS, но Astrareview выявил P1V57-F1:
coordinator запускал новую transport stage послеpublicpatch, затем ошибочно
сверял её before сORIGINALmanifestSHA и использовалwriteFile поверх0400.
SourcegateBLOCKED; Docker/load не запускались. Тесты actualhelperVM+старыйV53
minfixture не покрывали нужный orderedpath. Историяv1source сохранена в
`issue12-v57-private-tls-timing-source-review-20261013/v1`, reviewreceiptSHA
`7944a9d6472ffbe76d13a680b677c358041dd77bb3645e8400371e1c4bf6a3e9`.
V2 готовится отдельно: chainedhash предыдущегоreceipt, existing atomicreplace/
modepreservation и actualpublicpatch→V57 regression; actualcompiledV57minfixture
проверяется отдельно отoldV53legacy. Gateway/patchobsbaseline остаютсяfrozen.

V57-F1repair V2 independenttester/AstrareviewPASS: реальные publicpatch→V57
wrongreceiptreject/atomic0400/inverse, V57fourcompiledhashes/syntax иV53legacy.
Gateway `2ee1cbd1dfc59109c76d23461b2e547e7b70bfffb837172c939ae3b3abfc205c`,
patch `66ee87c58fd986381a04d3bf51f421586e7e2ad9190f50ae4212abff9302c6ec`,
coordinatorv2 `fe8059fcecbe8096c1715fdb87e42ca49c4a5466bf8e241accc8c49908ed4890`,
selfcheckv2 `ad30e66a188f78e357c5550364f80a91f0e21c6e2955f38201b653f5b8acb2e9`,
fullcoordinatorinverseV53 `69962b04393a4f28f1a0ff4cca93a07d856320872b9a3a0330e308246d06600c`,
testerlog `b46c05e2432ff5ea20e8a21e499581b9c8562803f2401bc0f7bb54ca335d9a8b`.
Normalmanifest209/38/14/native/images PASS:
`9e93355463b8d1df9f190ca165a9432698c0727ed1f1cf1fe1c6f485f4006a5e`,
sourcefreeze `544c975b3e865242046e78f21110aa4ee292d8c5dbe3788a0c9b45ede65860d9`.
Full `issue12-v57-private-tls-timing-full-20261013` завершился FAIL:
80490.839920ms/8050ACK,minLive2721/maxLive5000,maxloop76.349439ms.
Первый fatal publickind2 `/health/live`1028.666809ms при1000ms,
cutoff12:19:28.092Z. ExactprobeID вNGXlog HTTP200/request_time0.000,
connection_time0.381s/upstreamauthabsent. Clientconnect114.506/secure925.677/
headers1028.068ms; connect→secure811.171ms неpureSSLCPU. Этотpublicroute
не обращался кAPI/authorizer. ResultSHA
`fd057381080b4bcd2417222645077c0a52ac0992cc8457de358a688a1bdcaa2c`,
driver `2a3881182e517b42c82362d35b27a1514ba7e7ee93e89b05f90d6bc082c6926d`,
cleanup `c4201cd6978d7a3138ec9d2bc21541204213bcf67e1f37ecba6a535e26099637`.
Cleanup3695.121139msverified,8ролей/network/private удалены;rootinventoryпуст.
5k/100ACK/30min/2CPU1GiB/probeagentfalse/TTL/deadlines прежние; fullнепринят.
[Node26.8.1 wrap](https://github.com/nodejs/node/blob/v26.8.1/lib/internal/tls/wrap.js#L622-L681)
откладывает initRead, но поздний connectionobserver не включает синхронное
созданиеTLSSocket доегоcallback. Serverraw/TLSsocket используютparenthandle;
[net endpoint getters](https://github.com/nodejs/node/blob/v26.8.1/lib/net.js#L1109-L1143)
дают однуTCPendpointidentity. ЧерезDockerNATclientportнеобязательнопрямосовпадает;
UUIDprimaryjoin иportmismatchunknown обязательны. Последние16healthrowsмогут
вытесняться; pending/missing/invalid/dropcounts не превращаются внулевое время.

IndependentV57strictaudit:616precutprobes/154perkind; все154privatekind3
сопоставились поresponseUUID соstrictTLSrows, всеportpairs совпали.
Approxserveraccept-minus-probe p50/p95/max12/41/623ms; accept→secure36.1/
89.1/141.0ms, secure→request1.7/6.0/19.6ms. Самая медленная успешнаяkind3:
clienttotal770.233ms/connect16.632/secure659.708, serveraccepted24.754Z/
secured24.811Z/request24.812Z; clientlocalPort/serverremote50256 совпали.
~605msдоconnectioncallback не разделяют kernelacceptqueue/runnablewait/
синхроннуюTLSsetup, и не доказывают причину другогоpublicfatal.
137strictobserverrowsperrole. Private4401queue185max/latest47, public8443
78max/latest78,drops0/overflows0. PrivatelatestCPU1.778922s/~1.163s,
12throttledperiods/18.747ms, summed3mainrunqueuewait2.078s; publicCPU1.305547s/
~1.139s/throttle0/summed2workerwait1.105s. РанееGW~1.8CPU/throttle315–568ms;
суммыwait не являются временемодногозапроса. Strictreauth53success/268retry504,
successgap p50/p95/max7.750/8.921/8.974s; totaltails70/279postcut включаютдругие
события. IPCreject/ACKerrors0; queue70936records/18.51MB/IPC2508/656KB.
LatestcompleteGWRSS999231488B/FDmax2168,total4318; cgrouppeak828870656B,
NGXRSS662728704B/FDmax4608,total9163/cgrouppeak688730112B/OOM0.
Astraread-onlyassessment отверг3TLSworkers какобоснованныйfix: RSS≈953MiB
уже близок1GiB, CPUpressure остаётся, worker3 умножилбыIPCwindow128→192.
Вариант с третьим TLS-процессом не применялся.

СледующийV58control проверяетexistingCFSsoftweights: fixedCpuShares4096
толькоOWNfixtureGW+NGX, hard2CPU/1GiB ичислопроцессовпрежние;driver/otherroles
не меняются. [Docker softshares](https://docs.docker.com/engine/containers/resource_constraints)
и [kernel weights](https://docs.kernel.org/admin-guide/cgroup-v2.html#weights)
определяют относительное распределение при конкуренции, а нерезервCPU.
НаDocker29.7.2/cgroupv2/systemd/runc1.4.3 expectedweight303 для4096shares;
фактическийcpu.weight/parent/quota/period/cpuset проверяется доdriver.
Astra/read-onlyprimaryresearch считаютonecontrol проверяемойгипотезой
с сохранёнными5000/100ACK/30min/TLS/auth/SLO; скоростигенератора/coverage
неослабляются. Повышениевесаобеихролей неразделит индивидуальныйэффект.
V58 source и независимые тесты завершены; полный прогон запущен,
результат пока не получен.
ДажеfullPASSподтвердитэтотweightedprofile; productionweight/schema/adoption
потребуютотдельногосогласованногоauthorityрешения. Ниhostsysctl/nice/affinity,
ниthirdTLSprocess/newlibrary/newinfrastructureневводятся.


### V58: фиксированные CPU shares и точка паузы

Пользователь поручил завершить тесты, нагрузку и проверку V58, затем поставить
работу на паузу. После V58 новые эксперименты, production adoption, commit,
push, PR, merge и closure не выполняются до возобновления.

Кандидат меняет только `--cpu-shares=4096` для gateway и nginx в полном
изолированном профиле. Остальные роли и reference-512 сохраняют defaults.
Actual `CpuShares`, `cpu.weight`, parent weight, `cpu.max` и effective cpuset
фиксируются в receipts; семь ролей проверяются до driver, все восемь — после.
Quota, period, RAM, два TLS-worker/один Kafka owner, IPC64, TLS/auth/TTL,
холодные health-пробы и 5000/100 ACK/s/30min gates сохраняются. Weight меняет
конкуренцию за CPU; это отдельный профиль, не резерв процессоров и не готовое
production-решение. Parent/max/cpuset сопоставляются при анализе результата.

Исходник coordinator:
`c510888d06d8df7ee955f25189c64b092f84377a1016a2f7a9523c4197aed8ac`;
self-check `369a4010379c41f7d603c0f1b7abb96ce72a71cc4a0710ed7f72c7546dc2711e`;
inverseV53 `544db29f2ca6fbcdc6c7405195b7d070a5de12460d74f7bbdef4da86c46a52b6`.
Frozen V57 gateway/patch не менялись. Worker и independent tester подтвердили
syntax/no-undef, actual V57 ordered source chain, четыре compiled hashes,
V53 legacy, full-only argv, weights303/100, guards7/8roles и bounded cgroup
reader. Точный reverse-diff также восстановил V57v2 `fe8059fc…4890`.
Astra source review PASS; остаются шесть inherited `no-useless-escape` warnings.
Tester self-check logSHA
`f8ba292a678a5b97b50cc025cf7a66163953e802f8198f41d0963a24f0e6022d`, lint
`4d5f8246f26daed2bbcdf97a4542123a33bb80b6203090ba9aa2c7c18eef47f4`.

Normal manifest209/38/14/native/images PASS:
`8fdafe2a30dbf80f4af483093fdb3ad8f2f2cf7bbf67359e622f81e4558dfe37`.
Source receipt `28ba68287bdbbd10e7f4de5327cdd5c0d44096a7cda2a2923ee7f339d48c305b`,
checks receipt `58fe9472e93d039594a5e9ccfa93b30df25f9351022317a9e4474e8f00aea5be`.
Full artifact directory:
`/home/yurgusev/.hermes/cache/scratch/issue12-v58-fixed-service-cpu-shares-full-20261013`.
Запуск: `PATH=/tmp/coffee-12-proof-bin-jBGChb:$PATH node /tmp/coffee-12-v58-fixed-service-cpu-shares-diagnostic.mjs --prepared /home/yurgusev/.hermes/cache/scratch/issue12-v58-fixed-service-cpu-shares-full-20261013 --approve-manifest 8fdafe2a30dbf80f4af483093fdb3ad8f2f2cf7bbf67359e622f81e4558dfe37`.
Полный V58 завершился FAIL. Нагрузка: 81.270834459s, 8127 Kafka ACK,
maxLive5000/minLive2575. Admission5000/5001 действительно прошёл:
5001-й получил HTTP503 `REALTIME_CAPACITY_EXCEEDED` до SSE headers.
Первый fatal — direct private mTLS `/health/ready`, kind3:
1218.059529ms >1000ms, cutoff12:44:28.297Z. ResponseHTTP200; clientprobe
начат12:44:27.079Z, connect246.455/secure1112.027/finish1184.321/
headers1214.654/end1217.937ms. Другой parallelkind3 завершилсяпозже с1189.087ms.
Driverloop p9517.744/max241.041ms наfailedsample; gatewayprocessloop
maximumreported63.537151ms. Event latency p95/finalcoverage отсутствуют,
30min/fullreauth/HUP/loadedshutdown не достигнуты; rate100 остаётся заданной
скоростью, не доказательством полного sustained-rate критерия.

Actual ресурсные receipts8/8: CpuShares4096/weight303 толькоGW+NGX;
остальныеCpuShares0/weight100. Parentweight100,cpuset0-7 всехролей.
GWcpu.max20000/10000,NGX200000/100000,driver800000/100000.
Root сравнил cpus/memoryBytes/nofile каждойроли сV57: совпадают8/8.
CPU priority меняетусловияконкуренции, поэтому baselineэквивалентнымнеобъявляется.

Final resultSHA
`b9be27cff47543bf0ca5b629fc41f8cd9cdbedbf7311810af63384d1c95fac5d`,
driver `0cedbd71ad9cd8c635ebafca4a0bd037174bfd2dd2b2576b013d245c6ee7adf9`,
containers `85e3de33f38c6b96ffedb9119447cbf09db3f00046f62c4ca537c12203db7270`,
cleanup `76582be2ae58296cf34a2f565a13480939d99fe9274f244963885b5f242e4fd1`.
Cleanup3911.204202msverified:8ролей/network/private material удалены;
root inventory пуст. `cleanupVerified:true` не означает successfulprotocol
shutdown. `checks.budgets:true` относится только к наблюдавшемуся окну.
Astra final result review: ложного PASS нет, V58 не готов к production adoption,
#12 не готов к merge. Independent strict audit завершён. Сбойная проба
сопоставлена по response UUID и reversed ports52282: serveraccepted12:44:28.071Z,
secured28.198Z,request28.199Z; accept→secure127.313ms, secure→request1.252ms.
TLS snapshot captured28.703Z после cutoff; его embedded timestamps до cutoff
используются как позднее наблюдение прошлых событий, не как strict pre-cut sample.
Client connect246.455ms и secure1112.027ms — cumulative offsets. Ожидание
преимущественно до serverconnectioncallback не разделяет acceptqueue/host
scheduling/синхронную TLS setup и не является измерением чистой crypto CPU.

Strict pre-cut reauth:89 completed, все TLS-resumed, gaps3212–9286ms;
всего110successful/76retry в186rows, первые retry504 послеcutoff28.923Z.
Полный re-auth каждого клиента не подтверждён. Latest gateway metrics27.040Z:
3732connections, totalqueue96744records/25239672B, hub90434/transport6310,
IPC3155records/826610B; rejects/ACKerrors0. Sample старшеcutoff≈1.26s.
Private/public observers:142strictrows каждый; privatequeue151max/latest,
public116latest; drops0/overflows0. Private summedmainthreadrunqueuewait
1.883s latest/1.904s max; public644ms max. Throttled_usec deltasprivate1.901smax/
public66msmax — агрегатные интервальные counters, не длительность запроса.
Strict host RSSmax: gateway983367680B, nginx663441408B, driver1203261440B;
FDmax/total соответственно2559/5099,5030/10064,5081/5084. OOM0.
Latest complete host intervals завершились22.243/24.254/26.277Z дляNGX/GW/
driver: последние секунды доcutoff этими snapshots не покрыты.
Все hardresources8ролей совпали сV57. V57 не сохранял actualcpu.weight;
его baselineweight не выдумывается и causalэффектshares не установлен.
Наблюдаемые очереди/CPU pressure остаются, fixedshares не устранили headroom.

Работа приостановлена по просьбе пользователя после проверки V58.
До возобновления новые прогоны,
правкиruntime, CPU priorities, commit/push/PR/merge/closure не выполняются.
Uncommittedwork сохранён, экспериментальные источники и receipts frozen вscratch.
При возобновлении: прочитать этот V58 checkpoint/strict audit, затем устранить
непринятый headroom/re-auth без ослабления согласованных критериев. Исполнимую
production architecture/spec/config/permissions/handoff можно принимать только
после доказаннойcapacity; финальные delivery gates иmerge остаются впереди.

Новые библиотеки и production architecture изменения не добавлены.

## Незакрытые live и процессные доказательства

S1 native smoke на 512 streams / 120s ПРОЙДЕН: `shutdown` receipt сообщает `liveBefore=512`, `armedClients=512`, `closedClients=512`, `elapsedMs=612.254`, `forcedClientClose=false`; все 11 smoke checks прошли, `missing=[]`, cleanup verified. Результат — ограниченный smoke, не launch proof. Ранее обнаруженный отказ из-за server close сохранён в истории ниже. Owner-browser proof ПРОЙДЕН в изолированной среде: настоящий Orders PostgreSQL, native Outbox publisher, Kafka, gateway, nginx и production SPA; projectionVersion 4 → 5 при business version 2, AROMA OutOfSync → InSync, 4 owner GET. Duplicate/stale metadata не изменили owner state; restart/reset/refetch занял 362.005 мс. Это ограниченный вертикальный proof, не capacity. Полный профиль 5000/5001 и 30 минут остаётся непринятым; handoff/PR/merge ожидают.

71 skips общего gate включают условные disposable PostgreSQL proof, отсутствующие `CUSTOMER_DATABASE_URL`, scoped mTLS client fixture, реальный `CUSTOMER_TEST_LOG_FILE`, отдельные provider-journal/PostgreSQL live проверки. Для SOPS ciphertext MAC не проверялся реальным ключом: `SOPS_AGE_KEY_FILE` отсутствовал, `COFFEE_REQUIRE_SOPS_MAC` не задан. Browser bundle gate проверяет browser JS и gzip, но не выполняет общий скан server `dist` на произвольные PII/секреты.

## Ограничения независимого ревью

- N1/V3: первый 1GiB профиль выявил нагрузочную задержку после fanout; bounded global pump и V4 window metric приняты по регрессиям и независимому ревью. Финальная CPU/latency достаточность требует повторного полного soak.
- N2: ограничение provenance/rebuild относилось к удалённому custom nginx/N4 и сохранено только как история. Текущий stock nginx проверяется по pinned digest и resolved image ID; native Node/Kafka adapter — по frozen source/compiled hashes, image ID и binary receipt. Исторический rebuild не доказывает свойства текущего stock image.
- R1, S1, N3, V1, V2, V3/V3a и V4 отмечены в independent review как исправленные и покрытые регрессиями. Неразрешённых изменений product runtime review не потребовал. Проверка проведена независимым reviewer; capacity остаётся отдельным обязательным gate.



### История live smoke

Первый 512-client/120s native smoke завершился отказом: клиентские stream завершились, но server close превысил 20-секундный предел. S1 устранил удержание TLS keep-alive socket после flush SSE. Последующий smoke из указанного ниже receipt завершился успешно для 512 клиентов; это не подтверждает профиль 5000 клиентов.

Текущий receipt: `/home/yurgusev/.hermes/cache/scratch/issue12-s1-smoke-20261012/result.json`. `manifestSha256`: `09dd199a5992fca08e0967f7c44325e6dc55108f3f7d09b05794c419b8396e51`. Source hashes проверены reviewer. Итоговый `pnpm check`: 815 тестов, 744 пройдено, 71 пропуск.

### Отказ полного профиля до N4 при admission

`issue12-full-final-20261012`: frozen manifest SHA-256 `146f486852d46ae392c3d53108347be67ab9f14c7633240db5d9889a51ff2b9c`; полный профиль 5000/100/s/1800000ms запущен с неизменными лимитами. До начала измерения edge-nginx достиг cgroup ceiling 536870912B и получил `oom_kill=1`. Результат FAIL, `durationMs=0`, `published=0`, launchProof=false. Capacity не принята. Все 8 fixture containers, сеть и synthetic private material удалены; cleanup verified, 3553.55 мс. Требуется устранить расход памяти и повторить полный профиль без ослабления бюджета.

### Повтор полного профиля после N4

`issue12-n4-full-final-20261012`: frozen manifest SHA-256 `4b0355ff811f8de3bfd55655588d30695374458613bd33b4cf0bd7aa9f71bc33`. Gateway metrics и единственный measurement sample подтвердили `live=5000`; этот sample снят через 144 мс после начала измерения, `acked=0`. Доставленный post-admission fanout и HTTP receipt для 5001-й попытки не сохранены. Затем native nginx worker получил SIGKILL, cgroup `peakBytes=555425792`, `oom_kill=1` при прежнем ceiling 536870912B. Состав памяти в observer receipt снят уже после kill и не устанавливает первопричину пика. Итог FAIL: `durationMs=0`, `published=0`, launchProof=false. Все 8 containers, сеть и synthetic private material удалены; cleanup verified, 3027 мс. N4 принят по C-регрессиям и независимому ревью, но достаточность его экономии для capacity не подтверждена.

### Диагностика TLS после N4

Изолированный диагностический hook публичного OpenSSL API ограничил только исходящие nginx records до 4 KiB. На настоящем TLS 1.3 размер record payload уменьшился с 16401 до 4113B; SHA-256 ответа 32 KiB совпал, а проверка с медленным reader сохранила содержимое 4 MiB. Продуктовые файлы не менялись. Короткий профиль достиг 5000 уникальных соединений, получил HTTP 503 для 5001-го до SSE headers и 43 broker ACK, но оборвался через 419 мс измерения. Последний nginx cgroup sample: 463609856B (442.13 MiB) при ceiling 512 MiB, `oom_kill=0`; SIGKILL worker без post-failure cgroup receipt не доказывает OOM. Gateway RSS в последнем sample был 534794240B (510.02 MiB). Cleanup verified; это FAIL диагностики, не launch proof.

В точном Linux/Node 26.8.1 исходнике libuv может передавать allocator hint 64 KiB по пути `uv__read` → `TLSWrap::OnStreamAlloc` → `NodeBIO::PeekWritable`. Однако первичная доставка raw socket buffer через `TLSWrap.receive` может создать меньший BIO до этого вызова; уже существующий неполный buffer не увеличивается до hint. Фактические размеры BIO и доля резидентных страниц не измерены, поэтому оценка 64 KiB resident RSS на каждый live socket не доказана. `process.memoryUsage().external` в этом Node берётся из V8 backing-store accounting и не включает `ExternalMemoryAccounter`, которым пользуются TLSWrap/NodeBIO; измеренные 7147336B не подтверждают и не опровергают их расход. Публичные HTTPS `highWaterMark` и `onread` не меняют Linux libuv hint; изменение внутренних полей OpenSSL или fork Node не использовались.

Повтор с тем же downstream-only hook сохранил post-failure состояние до cleanup: nginx `oom_kill=1`, peak 549822464B; gateway `OOMKilled=true`, exit 137. Он первоначально планировался с combined hook, но mount указывал на прежнюю библиотеку; результат явно отнесён к downstream-only, а не к upstream MFL.

Следующий отдельный запуск проверил фактический mount и SHA combined hook. На закреплённых nginx/Node/OpenSSL upstream MFL 4096 подтверждён публичным session getter для fresh и resumed TLS; 32 KiB payload сохранён, а unsupported peer продолжил работу с getter=0. Однако capacity-прогон снова завершился при admission: nginx `oom_kill=1`, peak 536875008B; gateway RSS 544141312B превысил 512 MiB, хотя его cgroup OOM не было. Полные 5000 live и измерительная фаза не подтверждены, `published=0`, cleanup verified. TLS prototype в продукт не включён: достаточная экономия не доказана.

Диагностика аллокаций на 3000 TLS сохранила все 226 N4 source hashes. OpenSSL tracer зарегистрировал максимум 204773872B live allocation, `dropped_count=0`; glibc `uordblks=294455856B`. Во время нагрузки allocator arena почти заполнена, поэтому fragmentation не установлена как основная причина пика. Tracer добавляет 32 MiB таблицы на процесс и не используется как capacity proof. Gateway достиг RSS 550068224B; после GC heap уменьшился, но RSS остался выше 500 MB. Его native resident allocation этим sampler не атрибутирована. Прогон FAIL, cleanup verified.

Отдельный scratch candidate объединил проверенный MFL hook, generated `request_pool_size=512` и публичный Node `--max-old-space-size=96`; budgets, TTL и thresholds не изменены. Фактические mounts/SHA, Node flag и `nginx -t` проверены до driver. Gateway завершился с exit 134 и `JavaScript heap out of memory` ещё при admission; последний sampler: heapUsed 98741464B, heap limit 113246208B, RSS 437170176B. Это heap OOM, не cgroup OOM. 5000 live, измерение и loaded shutdown не подтверждены; manifest SHA-256 `a0a25c378bc9ddc18d726c58e0b8f13b3a5c5ae0d8c9c128439ac637ec9d4875`, cleanup verified. Эти настройки в продукт не приняты.

### Первый полный профиль с согласованным 1 GiB

`issue12-1g-full-final-20261012`, manifest SHA-256 `3e5dd3bf8fa56265a1bf2fd89dbc74c01ee7c42b4310959c48443c766c4efb7e`: установлено 5000 уникальных streams, 5001-я попытка получила 503 `REALTIME_CAPACITY_EXCEEDED` до SSE headers. Обе роли действительно имели cgroup memory.max=1073741824; OOM-событий не было. Профиль завершился FAIL после 2001 мс и 201 ACK из-за `HEALTHY_CLIENT_SILENT_LOSS` (subject6, expected20030). Все shards получили первые шесть hints; diagnostic p95 1330–1352 мс, gateway принял лишь 26 новых записей между metrics при 145 producer ACK. Cumulative event-loop histogram ещё содержал около 4000 prephase samples и маскировал длинную задержку. После FAIL driver finally закрыл streams: последующий gateway live=0 не является причиной отказа. V3/V4 исправляют global pump fairness и нагрузочное окно метрики; достаточность проверяется новым полным прогоном. Cleanup verified, 3347 мс; все 8 containers, сеть и synthetic private material удалены. Старый FAIL не принят как capacity proof.

Последние узкие проверки после V3/V4: `node --test tests/realtime/contract.test.mjs tests/realtime/auth.test.mjs tests/realtime/replay.test.mjs tests/realtime/backpressure.test.mjs` — 35/35, 0 ошибок/пропусков; `pnpm exec node --test tests/config/platform-config.test.mjs tests/realtime/fixtures/harness.test.mjs` — 50/50, 0 ошибок/пропусков; `pnpm config:check` — PASS. Независимое ревью V3/V4 не нашло оставшихся source blockers; full capacity ещё не принята.

### Полный профиль после V3/V4 с одним nginx worker

`issue12-fair-full-final-20261012`, manifest SHA-256 `9aa2bce40a3b40f28d443bcb5514b879ee44ca20460198405efef9c485d6761f`: снова подтверждены 5000 unique streams и 5001-й pre-header 503, OOM нет. FAIL после 2003 мс/201 ACK: subject6 received20027 вместо expected20030. Gateway принял около 100 hints за первую секунду, p95 event-loop окна 54.85 мс; очередь выросла до 79415 records / 20775542 bytes. Это показывает downstream backlog, но не устанавливает его точную причину. Headroom TLS secureConnect 1467 мс и total2309 мс получены после initial fatal; они не являются независимым доказательством pre-failure CPU насыщения. Nginx admission CPU был 98–100%, generator запускал один worker при allocation2CPU. Следующий ограниченный кандидат использует два workers внутри тех же CPU/memory budgets; его достаточность требует полного proof. Cleanup verified, 3255 мс, все 8containers/network/private removed.

### Полный профиль с двумя nginx workers

`issue12-workers-full-final-20261012`, manifest SHA-256 `c05c7f34cd5c29ef19374aa59f56cdda88345382d8b63973b6603233d653eadc`: root проверил все 209 runtime source и 17 supporting hashes, compiled/native receipts, profile/fixture inputs и image IDs. Независимое source review — PASS; harness — 24/24 без skips. Фактически использовались два native worker при лимитах CPU=2 и memory.max=1 GiB для nginx и gateway. Admission для 5000 уникальных streams прошла; попытка 5001-го получила typed 503 до SSE headers. OOM не было.

Main завершился FAIL через 2002.448 мс и 201 ACK: client0 получил 0 событий subject5 вместо expected20026. На elapsed1309.8 мс очередь gateway составляла 77125 records / 20170763B, p95 event loop — 33.88 мс; оба pre-failure headroom samples были ниже 190 мс. Diagnostic live latency во всех 10 shards: p95 1033–1051 мс, максимум 1240–1272 мс. Финальный percentile и coverage не сформированы и не приняты. Два workers улучшили transport headroom, но capacity не доказали. Отдельный CPU sampler стартовал уже после fatal и не устанавливает причину до отказа. Все 8 containers, сеть и private material удалены; fixture cleanup — 12245 мс, verified=true. Этот FAIL не проверял loaded-client graceful shutdown и его 10-секундный cleanup.

### Локализация CPU и очереди (diagnostic-only)

`issue12-cpu-diagnostic-20261012`, manifest `050d5b836b9d702f700d5e1df81516422e156f87e4beb8ae26255471c36b4906`, использовал public Node inspector/Profiler в scoped local gateway. Root сверил 226 hashes; marker явно содержал `diagnosticOnly=true`. Inspector закрыт после сохранения профиля (лог `Debugger ending`); профиль не подтверждает capacity. Main снова завершился FAIL через 2013.549 мс: subject6 получил 20028 вместо expected20030. При elapsed1292.14 мс из 76798 queued records только 1344 находились в 64 started writes, а 4744 connections ещё были scheduled. Это локализует backlog до запуска большинства writes. Три aggregate gauges проверены существующим backpressure test — 14/14.

Для профиля root сопоставил `profile.startTime + sum(timeDeltas)` с `monotonicBeforeUs/wallBefore` public marker и взял только interval 07:53:21.886–07:53:23.900 UTC. В sampled interval длительностью 2013.335 мс: native `writev` self — 37.68%, общий nextTick/`connectionCorkNT` path — 42.48%, coalescer inclusive — 19.68%, enqueue inclusive — 13.49%, GC — 4.42%. Это атрибуция sampled interval, не измерение отдельных инструкций OpenSSL; native encoding, copy, encryption и syscalls отдельно не разделены. Cgroup sample 07:53:22.758–07:53:23.769 UTC, снятый до fatal, показывает gateway 1.622 CPU-sec / 1006 ms и 436092 µs throttling, nginx 1.023 CPU-sec / 1010 ms без throttling, driver 3.675 CPU-sec / 1007 ms без throttling. Потенциальные стоимость фонового GC и конкуренция на старом host не исключены.

Следующий bounded candidate убрал повторное scheduling для каждого кадра и переиспользует один encoded Buffer только при полном совпадении ordered Frame identities. HTTP chunked framing и TLS encryption/copy сохраняются; достаточность оптимизации ещё не доказана. Budget, TTL и thresholds не менялись.

### V6: fanout и повторное кодирование

Coalescer теперь планирует каждый connection один раз за выбранную подборку. Hub использует один bounded encoded Buffer cache размером до 64 кадров, проверяя identities и порядок всех кадров; Buffer не меняется во время write. Кеш очищается при последнем close, shutdown и destroy. Изменение не устраняет native TLS encryption/copy. Existing tests защищают общий Buffer для 128 клиентов, точный порядок всех 6 кадров, неизменность in-flight bytes и различия внутренних кадров при одинаковых крайних кадрах.

Независимое ревью выявило V6-T1: прежний reentrant replay test требовал coalesce событий 4/5 даже если timer успевал разделить их по разным окнам. Теперь оба publish выполняются синхронно внутри replay write; тест ждёт наблюдаемую доставку события 5 и пустую очередь, сохраняя точные IDs [3,5] и порядок replay→ready→live. Standalone test — 1/1, combined — 35/35; независимое source/test review — PASS. Root затем выполнил `pnpm test:realtime-contract` (5/5), `pnpm test:realtime-auth` (8/8), `pnpm test:realtime-replay` (8/8), `pnpm test:realtime-backpressure` (14/14); везде failed/skipped — 0. Полная capacity-приёмка V6 ожидала чистого прогона без inspector.

### Чистый полный профиль V6 и ошибка coverage harness V7

`issue12-buffer-full-final-20261012`, manifest SHA-256 `e1dafc8472d45f41d02f3047336c1ff5866439378458a762ce49ee15c2fb3ee2`: root повторно сверил frozen inputs и выполнил точный full target без inspector. Exit 1, FAIL через 2133.714 мс / 213 ACK. Фактические 5000 unique и 5001-й pre-header typed 503 прошли; обе роли имели 1 GiB / 2 CPU, два native workers, OOM не было. На elapsed1796.3 мс очередь составляла 80565 records / 21065048B, scheduled — 4296, writing — 64 / 1408 records, p95 event loop — 65.60 мс. Raw shard diagnostic p95 составлял 1157–1591 мс, максимум — 1624–2013 мс; это не финальный 30-минутный percentile. Все 8 containers, сеть и private material удалены; cleanup 3608.68 мс, verified=true. Нагруженные re-auth, HUP, shutdown и полный 30-минутный прогон этим коротким FAIL не проверены.

Read-only CPU collector стартовал до main и был привязан к точным owned roles/runId. В interval 08:14:41.625–08:14:42.628 UTC gateway использовал 1.216590 CPU-sec / 1008 мс без дополнительного throttling, nginx — 1.348950 CPU-sec / 1005 мс, driver — 3.210918 CPU-sec / 1012 мс. Предыдущий interval включает admission/main boundary и gateway 443628 µs `throttled_usec`; это агрегированный cgroup counter, не 443 мс wall pause. Причина в CPU/crypto отдельно не доказана.

Независимое ревью выявило V7: clients.mjs объявлял `HEALTHY_CLIENT_SILENT_LOSS` по первому checkpoint snapshot через 1 s. Issue12, HEAD owning docs20 и canonical verification задают p95≤1000 мс и полноту coalescing hints, а не максимум 1000 мс для каждого hint. Snapshot показывает, что максимальная версия ещё не доставлена, но не доказывает потерю. Новая незакоммиченная формулировка owning docs20 о «прежнем coverage deadline» возникла из ошибочного harness и была явно исправлена. Pending coverage теперь использует общий существующий verification bound 14 s от checkpoint; re-auth 13 s и latency histogram / p95≤1000 мс сохраняются. Изменена методика проверки полноты, но не ресурсный или latency budget. Прежний V6 FAIL сохраняется: фактическая shard p95 тоже превышала 1000 мс. V7 не превращает его в PASS.

Generator ULID time извлекал 48 бит через 10 BigInt shift/allocation на каждом полученном frame. Root benchmark для 500000 вызовов: текущая реализация — 498.48 мс, точный Number decode — 182.34 мс. Это локальный microbenchmark, не capacity proof. Numeric decode обязан сохранять полную проверку 26 символов и 48-битного предела. Clock, frame schema validation и измеряемые timestamp не меняются.

### Чистый full после V7 и freeze-проверка V8

`issue12-coverage-full-final2-20261012`, manifest `7ef76d5cf9d252a771ad5a0c286492e60d09753b15329f97c44cd609d3e77200`: root проверил frozen 226 hashes, compiled/native receipts и images. V7 source review — PASS; harness — 25/25 и root focused — 3/3, failed/skipped — 0. Исправлены reviewer V7a (ждать каждый checkpoint, поскольку финальный может завершиться раньше предыдущего) и V7b (сначала проверять deadline, затем засчитывать completion).

Полный target завершился FAIL через 4327.921 мс / 433 ACK: настоящий API headroom kind1 составил 1168.554 мс при пределе 1000 мс. Все 5000 streams одновременно/unique и 5001-й pre-header 503 прошли. Max event loop — 73.007 мс. Diagnostic shard p95 уже превышал 1000 мс; итоговый 30-минутный histogram не сформирован. Nginx raw cgroup peak — 561229824B, gateway — 587100160B, OOM не было; memory.max обеих ролей — 1 GiB. Fixture cleanup — 3489.74 мс, verified=true. Этот FAIL подтверждает реальную нагрузочную проблему, а не прежнюю ошибочную классификацию snapshot как потери.

V8: prepare-manifest verifier сверял source hashes с ROOT и compiled JS со snapshot, но не сверял смонтированные fixture.mjs/contracts/sourceJSON copies. Теперь каждый из 209 source paths отдельно сверяется с private/app до native receipt; supportingSources, как и прежде, проверяются по ROOT. Существующий regression взял ROOT-valid package.json и tampered snapshot: до fix тест был RED (проверка доходила до native), после — GREEN. Harness — 25/25, root prepared-drift — 1/1, skips нет. Hardlinked installed libraries не меняются. Старые прогоны не становятся новыми frozen proof.

Локальный diagnostic-only TLS mirror с client cipher preference: Node 26 выбрал TLS_AES_256_GCM_SHA384, Chromium 151.0.7922.34 — TLS_CHACHA20_POLY1305_SHA256 на этом host без AES-NI. Это не actual nginx receipt и не причина capacity FAIL. Первая загрузка shortened public ChaCha diagnostic остановилась ДО Docker launch с EACCES на synthetic fixture.json mode 0400; private material удалён. Scratch coordinator исправили на atomic JSON rewrite с сохранением mode 0400; повторная проба использовала новый snapshot. Проба меняла только synthetic public client ciphers и duration 20 s, явно записывала before/after hashes и `launchProof=false`; private mTLS, actor TTL, write/coalesce/security/CPU/RSS/FD thresholds не менялись. Capacity по этой пробе не принимается.

### Диагностика TLS, штатного nginx и генератора

Public ChaCha control `issue12-chacha-public-diagnostic2-20261012`, manifest `5fc5c46d3d5b34d2b15bdf2fdfc82828fe078689489a50bfaa18e1b03687aa2c`: все 5000 соединений действительно выбрали `TLS_CHACHA20_POLY1305_SHA256` / TLS 1.3. Private mTLS не менялся. FAIL через 5299.441 мс / 530 ACK: API headroom — 1143.375 мс при пределе 1000 мс. Event-loop p95 максимум — 81.920 мс. Cleanup verified, 3641.52 мс. Эта 20-секундная проба не является capacity proof и не обосновывает изменение product cipher policy.

Stock control `issue12-stock-nginx-diagnostic-20261012`, manifest `7b6e0e075c1b6c0aaae83379f6622b7fd3cbdf2da61e58f8444b4ada1bcdadb7`: использован exact pinned official nginx image; замороженный snapshot проверен до явной diagnostic override. Те же 1 GiB / 2 CPU, два workers и стандартный TLS. Admission 5000 / 5001 подтверждён; FAIL через 4155.133 мс / 416 ACK: session headroom — 1039.842 мс при пределе 1000 мс. Nginx cgroup peak — 669601792 B, sampled RSS — 659456000 B; OOM не было. У custom nginx из V7 peak составлял 561229824 B. Последние полностью pre-failure CPU samples: stock nginx — 1.781 CPU-sec / 1005 мс, custom — 1.850 CPU-sec / 1003 мс. Это ограниченное подтверждение, что stock nginx помещается в 1 GiB в наблюдавшемся окне; 30 минут и влияние N4 на latency не установлены. Оба результата — FAIL, причины headroom различаются. Cleanup verified, 17855.36 мс; это fixture removal, не приёмка loaded-client cleanup.

Worker CPU diagnostic `issue12-worker-cpu-diagnostic-20261012`, manifest `6b2ac22dfd0682a534b9a031c693d46d9248ea5122afb9db90feb7a426c41f77`: использованы public `Worker.startCpuProfile`, 10 started / 10 stopped / 10 profiles; ошибок записи нет. Main 09:05:19.627–09:05:24.171 UTC завершился FAIL на headroom; profiles включают до 255 мс после failure. Во всех десяти shards основной JS sampled stack — `SseDecoder.frame`: self 18.37%, inclusive 37.48%; `push` inclusive 45.53%. Generated validator inclusive 2.41%, `nowMs` self 4.72%, GC 3.92%, idle 29.49%. Знаменатель — сумма timeDeltas 47.215 s по десяти workers, не CPU-секунды; inclusive stacks перекрываются. Отсутствие crypto-named samples не доказывает отсутствия native crypto. Root и tester независимо подтвердили цифры. Прогон помечен `diagnosticOnly=true` / `launchProof=false` и не принимается как нагрузочное доказательство.

Независимое ревью V8 — PASS: mounted snapshot проверяется до Docker launch; прежние проверки исходников, compiled files, native binary и images сохранены. Targeted regression — 1/1 без пропусков.

### V9: стоимость разбора в нагрузочном генераторе

`SseDecoder` переиспользует разобранные invalidation metadata только для полностью одинаковой raw-строки и того же validator. FIFO-кеш ограничен 64 кадрами; service frames и heartbeat не кешируются. Каждый полученный кадр по-прежнему проходит generated validator; UTF-8, frame/pending byte limits, per-client ownerVersion coverage, latency histogram и re-auth deadlines сохранены. Callback получает отдельные копии fields/data. Регрессия защищает повторный кадр между разными декодерами, изменённые ID/order/payload, unknown field, запрещённый business field, другой validator, mutation handler и eviction 65-го кадра. Worker: focused 1/1, harness 26/26, syntax checks — PASS. Root: targeted 1/1, diff check — PASS. Достаточность для capacity проверяется новым полным прогоном; прежние FAIL сохраняются.

Чистый полный V9: `issue12-decoder-full-final-20261012`, manifest `9aeba2c728ba18d8cda81e6d40654c1b8fe9858860551a1867b16b862f354ab5`. Независимое V9 review — PASS, decoder/cache — 2/2. Root проверил 209 source и 17 supporting hashes, mounted snapshot, compiled/native/images; CPU, memory, TTL и все thresholds не менялись. Прогон завершился FAIL через 3421.309 мс / 343 ACK: API headroom — 1305.920 мс при пределе 1000 мс, включая secureConnect 461.959 мс и headers 1305.507 мс. Все 5000 streams были live, 5001-й typed 503 прошёл; event-loop максимум — 73.925 мс, OOM не было. Последний полностью pre-failure interval 09:16:03.120 UTC: nginx 1.687 CPU-sec / 1002 мс, gateway 1.028 CPU-sec / 1004 мс, driver 3.507 CPU-sec / 1004 мс. Снижение driver CPU относительно предыдущих проб не доказывает причинного улучшения capacity; задержка не принята. Полный 30-минутный percentile и loaded re-auth/reload/shutdown этим отказом не проверены. Fixture cleanup verified, 3319.58 мс; все owned containers/network/private material удалены.

### TLS control и V10: ошибочное уменьшение upstream read buffer

`issue12-both-chacha-diagnostic-20261012`, manifest `5d330b8f009cb02f48105045fd4b96696805080a66d9e7e8bead3d4a40b7328e`: public clients и private gateway server действительно согласовали TLS 1.3 ChaCha20. Исходные source/compiled hashes проверены до diagnostic overrides; cipher receipts сохранены через public `getCipher()`. CA, client certificate и SAN verification не менялись. Прогон завершился FAIL через 3512.276 мс / 352 ACK: API request deadline, event-loop максимум — 62.718 мс. Изменение cipher policy в продукт не принято. Both-cipher fixture cleanup verified, 3472.02 мс; owned containers/network/private material удалены.

Native audit выявил отдельную ошибку N4 configuration: при `proxy_buffering off` `proxy_buffer_size` задаёт размер не только первого чтения headers, но и последующих body reads. Точный pinned source `ngx_http_upstream_process_header` выделяет `u->buffer` по `conf->buffer_size`; non-buffered loop читает тело в тот же буфер. Это подтверждают [документация nginx](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_buffering) и [исходник 1.31.6](https://github.com/nginx/nginx/blob/0a5db852e18d1c22c62a5ede1412ac3f416111a0/src/http/ngx_http_upstream.c#L3964-L4035). Прежнее утверждение docs «1 KiB только под headers» было неверным. Короткий 4 KiB control менял только upstream read buffer, сохраняя исходный TLS и все budgets. Разница ёмкости — 15360000B для 5000 streams; влияние на CPU/latency проверялось отдельным прогоном. Исполнимая V10 удаляет override и возвращает прежний default page buffer без нового config слоя.

### V10 control: стандартный upstream read buffer

`issue12-4k-sse-diagnostic-20261012`, manifest `5569cb5db719357f4afd0183e261e75489325472da0a4a9aa353dbe287785ed8`: единственное поведенческое изменение control — стандартный 4 KiB вместо 1 KiB upstream read buffer. Исходные TLS, CPU, memory и actor/session TTL сохранены. Прогон длился 20002.231 мс и дал 2001 ACK. Все 5000 unique streams и 5001-й pre-header 503 подтверждены; actual HUP сохранён в control receipts. Headroom — PASS, максимум 202.875 мс; event-loop p95 максимум — 57.475 мс. Ошибок исполнения и OOM нет, но event p95 составил 1107 мс при пределе 1000 мс, поэтому общий результат — FAIL. Полный 30-минутный прогон и re-auth не выполнялись. Histogram содержит 2310544 кадра, maximum — 1499 мс. По raw CPU к концу main nginx использовал около 1.4 CPU-sec/s, gateway — 1.06, driver — 2.56. Результат согласуется с устранением избыточного дробления body reads, но отдельно не доказывает распределение затрат по каждому syscall.

Loaded shutdown этой группы из 5000 клиентов прошёл: все 5000 были armed/live и получили уникальные reset→serverclose receipts; workererrors — 0, `forcedClientClose=false`, root exit 0, elapsed — 3581.880 мс. Максимум decoded reset→server close — 42 мс. Fixture cleanup — 3116.775 мс, verified=true. Это доказывает конкретный сценарий shutdown, но не 30-минутную capacity и не массовую re-auth. Worker `config:check`, `nginx:check`, syntax и targeted harness — 1/1 PASS; независимое V10 review — 1/1 PASS.

## Orders admission — 14 октября 2026

Пользователь поручил устранить проблему пула, проверить 100 одновременно
начатых заказов по 10 позиций и готовить W1 к main без commit/публикации.
Источник — текущий чат Codex; локальная feature/12-realtime-order-card над
91675aaa56900613505bfbd8cd14981b07cec000. Это не accepted merge/handoff.

Baseline с synthetic caller retry дал 100 заказов, но 1714 ответов 503 и
14.768s: /tmp/coffee-owner-peak.bqxVOk/issue12-owner-peak-2766047.json.
После удаления retry RED воспроизвёл 4 завершённых/96 отказов:
/tmp/coffee-owner-peak-red.fsJq7I/issue12-owner-peak-2777106.json.
Первый bounded queue вариант с общим checkout250ms дал 28/72 и saturation72:
/tmp/coffee-owner-final.W5c9hs/issue12-owner-peak-2784363.json. Все FAIL сохранены.

Итог: только Orders задаёт dbPool.maxWaiting=100. Foundation резервирует слот
FIFO до pg.connect; очередь ограничена общим request5000ms/transaction10000ms
signal, connect после допуска — прежним checkout250ms. Active pool остаётся4,
default maxWaiting0 сохраняет fail-fast остальных services и fleet96.
Abort/overflow/timeout/shutdown очищают очередь; health не обходит ожидателей.
SQL и неизвестный COMMIT не повторяются. Test caller retry и заменённые unit
tests удалены; peak использует 1400 прямых HTTP вызовов при concurrency150.

Два GREEN receipt: /tmp/coffee-owner-phase2.mCKfBm/issue12-owner-peak-2789819.json
(SHA256 6c20100c7b4a4c0ba42d6f7eeed8786e14c939c8f0fa20d9a5fd731b4f799aca)
и issue12-owner-peak-2790864.json
(SHA256 61720119241a8d95ba4da034ba168ef99cef0396fd685a68d181514364263daf).
Оба: started/completed100, failed0, peakConcurrency100, callerRetries0,
1400 successful commands, 0 refusals; независимые DB counts100Orders/1000Items/
1200History/100Contributions/1000ContributionLines/100Outbox/1200Idempotency.
Волны10959.419ms и11059.778ms: 9.125 и9.042orders/s. Первый flow p95=10943.553ms,
p99=10948.973ms; max одного запроса1086.819ms. Это latency всего 14-command
flow, не одногоHTTPзапроса. Sample maxactive4/maxwaiting95/pending7;
финальный pool active0/idle4/waiting0/saturation0/pending0. Disposable containers
удалены; MaxListenersExceeded не найден. Raw /tmp receipts могут исчезнуть.

Проверенные команды:

- pnpm exec tsc -b packages/platform-config packages/platform-database --pretty false — PASS.
- node --test packages/platform-testing/test/platform-packages.test.mjs — 32/32 PASS.
- node --experimental-strip-types --test tests/config/platform-config.test.mjs — 27/27 PASS.
- COFFEE_DB_LIVE_PROOF=1 node --test --test-concurrency=1 --test-name-pattern='owner peak 100' tests/orders/owner-live.test.mjs — 1/1 PASS.
- COFFEE_DB_LIVE_PROOF=1 node --test --test-concurrency=1 tests/database/pool-concurrency-live.test.mjs — 1/1 PASS (default fail-fast).
- COFFEE_DB_LIVE_PROOF=1 node --test --test-concurrency=1 tests/orders/owner-live.test.mjs — 5/5 PASS.
- pnpm exec tsc -b apps/orders-aroma-preparation --pretty false — PASS.
- COFFEE_DB_LIVE_PROOF=1 node --test --test-concurrency=1 --test-name-pattern='capacity: preparation recomputes 100 contributions and (1000|10000) cart lines within two seconds on real owner DB' tests/orders/aroma-preparation-live.test.mjs — 2/2 PASS, 814/1933ms при2s.
- pnpm config:check, pnpm typecheck, pnpm lint, pnpm architecture:check, pnpm authority:check, git diff --check — PASS.
- pnpm check — exit0; заключительный node:test suite823:749PASS/0FAIL/74explicit-only skips. Общий лог /tmp/coffee-pool-check-20261014.log. Live scoped targets выше прошли без skips.

Независимый Astra reviewer: существенных замечаний нет; собственный targeted
foundation run4/4PASS. Root сверил оба raw receipts и scoped source diff.
SHA256 DB source bb2fde7db58c08874fbdacb9ad980bef0117312752670e7db0a6554193f76e6b;
config065acfbb3ff05c43bfbe5a9c5be2619bbec3f6383486878673039c4d1c46ef98;
owner test5854c5165e785ee82e70e5280c2b8d78204c31527b64b1aab92578b800d2ca5d;
compiled DB71d007b8e293b55f8ad6385d70f60829abdecdfd6b319cfc2c6e9645e305f76e.

Ограничения: synthetic Customer/Pricing/auth, Fastify.inject, Outbox Pending;
нет real client ingress/VK/LLM, активного publisher или полного fleet proof.
Preparation100×100 имеет всего около67ms запаса; production budgets ещё требуют
launch acceptance. #12 operator-1, #64 observability и #13 G00–G19/clean accepted
SHA остаются впереди. Доказательство пула не является release/main admission.
Исторические revision roots/hashes не изменены; commit/push/PR/deploy не выполнены.

### Подготовленный operator-1

`node tests/realtime/soak.test.mjs --prepare --profile operator-1 --result-dir /home/yurgusev/.hermes/cache/scratch/issue12-operator1-prepared-20261014` — exit0,
prepared-not-launch-proof. Manifest SHA256:
`a3190a96a45e34258950cebd2901c99dbc74cbf2d78f881ebd9074529d77a037`.
Независимый read-only verifyPrepared сверил 209 source, 38 compiled и14supporting
hashes, profile/fixture/nginx/native hashes и image IDs. Node26.8.1/ABI147,
librdkafka2.15.0. Main cohort1 subscriber/100invalidations/s/1800000ms,
100subjects; отдельная boundary512/513. nginx/realtime по2CPU/512MiB,
пороги p95event1000ms/loop100ms/headroom1000ms/shutdown20s/cleanup10s прежние.
Сохранён только новый synthetic private fixture material для разрешённого
прогона; real secrets/provider/production data не использованы. Full run не
выполнен: пользователю отправлен запрос отдельного разрешения этого manifest
по текущему body #12 и docs/launch/20_REALTIME_SSE_IMPLEMENTATION_SPEC.md.
Подготовка и hash integrity не являются capacity PASS или launchProof.

### Operator-1 — полный разрешённый прогон 14 октября 2026

Пользователь ответил «Разрешить 30-минутный прогон» для подготовленного выше
manifest SHA256 `a3190a96a45e34258950cebd2901c99dbc74cbf2d78f881ebd9074529d77a037`.
Состояние «Full run не выполнен» выше относится к моменту до этого разрешения.
Выполнена команда:

`node tests/realtime/soak.test.mjs --prepared /home/yurgusev/.hermes/cache/scratch/issue12-operator1-prepared-20261014 --approve-manifest a3190a96a45e34258950cebd2901c99dbc74cbf2d78f881ebd9074529d77a037`

Exit0; итоговый `result.json`: PASS/full-profile, launchProof=true,
missing=[], error=null, cleanupVerified=true. Здесь launchProof относится к
этому transport profile, а не к выпуску W1 или всем G00–G19. Папка receipts:
`/home/yurgusev/.hermes/cache/scratch/issue12-operator1-prepared-20261014`.
SHA256 result.json `e6c3de8e32709e0a1268d38fbb791e0345e6f5bdf4604708d4c7b6067731591c`;
driver-result.json `df6edd629fc26f61a2af904a87243e6868e9e9dfe46e252de65fbcdbb9012575`;
cleanup.json `1f5e244f2c2d7a593c1bd23a677aeccd10421a4113e0b011516f3bf56ec0621a`.
Лог команды: `/tmp/coffee-operator1-run-20261014.log`.

Main interval1800000.428ms: 1 subscriber/100 subjects; scheduled=acked=180001,
publisher pending=0, peakPending=28 при max100. Event p95=307ms при1000ms,
event-loop p95=22.151ms при100ms; 50371 protocol frames/180100 coverage checks.
Event maximum3294ms не является p95 gate. ACK-time секундные bins не равны
строгому минимуму100 ACK в каждую wall-clock секунду: 37 bins ниже100,
min25/max115; proof проверяет total и schedule-lag. Heartbeat frames98;
самостоятельного gate максимального heartbeat interval классификатор не имеет.

Все11 checks=true: replay/reset/slow/evicted/admission/reload/reauth/headroom/
cleanup/shutdown/budgets. Отдельная admission фаза: 512 unique live streams,
513-й получает503 REALTIME_CAPACITY_EXCEEDED до SSE headers; её cleanup
подтверждён до основного одноподписочного интервала. Реальный nginx HUP создаёт
новый worker за151.498ms, main live1→1. Re-auth:19 ожидаемых disconnect/reconnect,
unexpected0, recoveredClients1, pending0, finalLive1; max/p95 gap3019ms при
retry3000ms/ready10000ms. Три OIDC refresh при прежних TTL, без их ослабления.

Host:313 snapshots/14408 headroom probes, OOMkills0; max RSS nginx98988032B,
gateway200130560B при каждом512MiB/2CPU; FD611/394 при16384/12288.
Loaded SIGTERM: root exit0/OOMfalse,340.320ms при20s; один armed/live клиент
получил reset→server close за1ms, workerErrors0, forcedClientClose=false.
Fixture teardown3239.700ms при10s:8/8 собственных containers, network и
synthetic private material удалены; cleanup verified=true.

Raw driver-result сохраняет FAIL без error и missing=[budgets,fixture cleanup]:
driver не владеет host budget sampling и teardown. Coordinator после проверки
hostFatal добавляет budget check, затем fixture cleanup и итоговую классификацию.
Это промежуточная граница ответственности; raw receipt не исправлялся на PASS.
Luna независимо сверила receipts и source/compiled manifest hashes.
Независимый Astra reviewer подтвердил технический PASS, существенных замечаний
нет; отдельно проверил сохранение driver/host/cleanup errors и запрет PASS при
error. Root после прогона вновь сверил209 source/38 compiled hashes с рабочим
деревом: расхождений нет; новая правка evidence не меняет frozen runtime.

Этот synthetic event-plane proof не создаёт180001 заказ: owner headroom GET
использует typed404 fixture, проверяя транспорт и trust chain. Реальные Orders
100×10 проверены отдельно выше; VK/LLM/реальный провайдер здесь не участвуют.
Исторические FAIL сохранены. Commit/push/PR/deploy не выполнялись.

### Настоящий Orders → served browser — повторная проверка 14 октября 2026

После полного operator-1 выполнена существующая команда двух функциональных
сценариев:

`TMPDIR=/home/yurgusev/.hermes/cache/scratch COFFEE_DB_LIVE_PROOF=1 COFFEE_REALTIME_OWNER_LIVE_PROOF=1 node --test --test-concurrency=1 --test-name-pattern='preparation owner realtime vertical' tests/orders/aroma-preparation-live.test.mjs`

Exit0;2/2 PASS,0 FAIL/skip,256041ms; positive142243ms/private-eof113541ms.
Лог `/tmp/coffee-owner-browser-20261014.log`. Оба ownerBrowserVerified=true,
error=null, cleanupVerified=true; classification owner-browser-not-capacity-proof,
launchProof=false сохранены намеренно.

Positive receipt:
`/home/yurgusev/.hermes/cache/scratch/issue12-owner-browser-QZNo8K/transport/owner-browser-proof.json`,
SHA256 `72ba9a72a08a6085ada09e934b08b50294ad11daa9b3eec11050d7b7de5f5873`;
manifest `e652beddbc557b10f4f16104a471c6f5235e4e65605e1016c34ad388c6a90bd0`.
Private-eof receipt:
`/home/yurgusev/.hermes/cache/scratch/issue12-owner-browser-Zy4HiI/transport/owner-browser-proof.json`,
SHA256 `f0bb93b0d18cc9de5a30b0485bcda93d96657672d065287ab2abfb0b95d8bf54`;
manifest `5f5d7c87043a7ced7b801b22d981f7d72d0395441c7266e220f3c80932c8e890`.

Оба: настоящий preparation Inbox → atomic persisted Outbox → native relay ACK
и Published → Kafka → nginx/Edge → production SPA/native EventSource → owner
mTLS/HTTP GET/OrderStore. Card projectionVersion4→5→6 при Order.version2,
AROMA OutOfSync→InSync; ownerReads5, noExtraMutation=true. Точные сохранённые
messageId A/B совпадают с полученными frames. Duplicate/current/stale replay
имеют broker ACK и committed offset, не вызывают дополнительных owner effects;
graceful realtime restart/reset вызывает refetch.

Positive compiledIntegrity.unchanged=true. Private-eof меняет только свой
изолированный runtime-composition.js: original4499918569eb794eac00de3be360368042e875b62d4d55974561a027cee8bb2d →
transformed293ec746fd159f207997d7eb6e4279d47da1fe5795726628362b3731a16ded4d.
One-shot fault B удаляет1 delimiter byte; triggered=true, reconnect Last-Event-ID
равен сохранённому A, connections2 при одной native EventSource instance,
B доставлен replay. Product compiled файл не изменён; оба sourceIntegrity=true.
Root сверил current sources: positive без расхождений, private-eof отличается
только указанным isolated compiled transform, совпадающим с receipt policy.
Cleanup3605.942/3514.438ms: собственные transport/owner containers, network,
synthetic private material и auxiliary image удалены; внешний PostgreSQL fixture
также очищен существующим helper. Real provider/VK/LLM не использованы.
Это два single-order material-change proofs, не повтор100×10 или capacity.

### Отдельный обязательный browser target и численные контракты

`pnpm test:web-realtime` — exit0 14 октября2026: Vitest8/8 и Chromium/native
EventSource10/10; лог `/tmp/coffee-web-realtime-20261014.log`. Проверены
first-ready/initial-GET race, metadata-only monotonic owner refetch, reset/exact
invalidation, fatal403/404/protocol/privacy, owner401, session switch/logout и
native reconnect Last-Event-ID. Это отдельный target, его наличие не выводится
из `pnpm check`.

Root сверил численный scope docs/launch/20_REALTIME_SSE_IMPLEMENTATION_SPEC.md
(operator-1/boundary/resource budgets),21_LAUNCH_VERIFICATION_SPEC.md (раздельные
owner functional/peak/soak proofs) и29_NGINX_TRANSPORT_AND_AUTH.md (SSE target):
1 subscriber,100 ACKed metadata invalidations/s,100subjects,30min;512/513 отдельно,
2CPU/512MiB per nginx/realtime, исходные TTL/deadlines/latency/cleanup/shutdown
budgets. Значения operator-1 согласованы; новые measured facts хранятся здесь,
численные targets не переписаны в обещание production admission.

### Локальный handoff #12

Создан `evidence/handoffs/issue-12.yaml` по существующему delivery protocol:
baseCommit91675aaa56900613505bfbd8cd14981b07cec000;7 inputs #8/#9/#11/#63/#119/
#160/#162 с accepted predecessor merge commits и hashes исторических handoff;
53 изменённых downstream outputs для #13/#64,17 реально выполненных commands.
Root проверил YAML существующим js-yaml, все7 исторических input hashes через
git show и ancestry в baseCommit, все53 текущих output hashes: PASS.
`git diff --check` прошёл. Новый verifier/dependency/test infrastructure не добавлен.

Это локальный draft незакоммиченного дерева. Независимое Astra review текущего
хода покрывает pool admission и operator-1 receipts/classifier; финальное review
всего ранее существовавшего diff #12 ещё требуется. Публикация/merge/handoff
acceptance не выполнены. Для первой волны далее нужны accepted #12, собственная
реализация/приёмка observability #64 и G00–G19 #13 на одном clean accepted SHA.
Обходить blocked prerequisites или объявлять main готовым по этим proof нельзя.

## Проверка каждой галочки issue #12 по коду — 14 октября 2026

Источник: live GitHub `YurGusev/CoffeeOrderPlatform/issues/12`, read-only snapshot
`/tmp/coffee-issue12-audit-live.json`;66 checkbox-строк,48 отмечены/18 открыты.
Локальная ветка `feature/12-realtime-order-card`, HEAD и origin/develop
`91675aaa56900613505bfbd8cd14981b07cec000`; feature commits/remote PR отсутствуют.
Номера ниже присвоены checkbox-строкам сверху вниз в этом snapshot; исторические
абзацы8/9октября не являются повторным подтверждением нового operator-1.

Astra-orchestrator: независимые Luna проверили сервер, браузер и delivery;
Astra reviewer просмотрел связанные critical paths всего substantive diff и
выполнил два точечных воспроизведения; root сверил выводы с кодом, owning
contracts и receipts. Это расширяет прежнее pool/receipt review. Функциональный
код в этом ходе не менялся; GitHub галочки/labels/PR не изменены.

Вердикт: к merge пока НЕ ГОТОВО. По строкам матрицы: 54 подтверждены, 6 частично, 1 с дефектом, 5 процессных впереди.
«Подтверждено» означает наличие проверенной реализации/test и подходящего
существующего evidence; это не accepted merge и не запуск каждого теста заново.

### Подтверждённые остатки и минимальная приёмка

1. **A12-R1, P2 — equal-version dedup.** `apps/realtime-gateway/src/hub.ts:129,139`
   сравнивает digest `eventData`, включающий внешний `correlationId`. Одинаковый
   payload с новым messageId/correlationId вызывает ложный quarantine/DLQ.
   Reproduction: payloadEqual=true, эффекты `offset,quarantine,offset`. Owning
   правило docs20:69–70 требует quarantine только при different payload.
   Минимум: для equal-version сравнивать `envelope.payload`, полный envelope
   digest сохранить для конфликта прежнего messageId. Расширить существующий
   contract test тремя случаями: same payload/new IDs→no-op; equal version/new
   reason→quarantine; прежний messageId/изменённый envelope→quarantine.
2. **A12-R2, P2 — config guards профиля.** nginx schema:50 принимает admission
   до5000; AJV/render с513 успешны. Backend сохраняет hard512: это обход раннего
   внешнего admission с лишними auth/TLS расходами, не открытие>512 streams.
   Realtime parser:866/schema:98–99 также принимают RSS1GiB/FD65535 при owning
   ceilings512MiB/12288. Root parse reproduction это подтвердил; физические
   Compose limits512MiB/12288 не обходятся. Ограничить schema/parser нормативными
   maxima; existing config test должен принять baseline и отклонить513/5000,
   RSS536870913 и FD12289. Новые budgets/слои/config sources не нужны.
3. **A12-R3, P2 — missing native browser re-auth proof.** owner-browser helper
   содержит positive/private-eof45s, но не естественное actor expiry60s/check30s
   через nginx/Edge в настоящей вкладке. Raw transport soak и Vite401 scenario
   проверяют другие границы. Расширить существующий owner-browser proof:
   native EventSource, server auth-close, новый авторизованный `/events`,
   stream-ready и owner refetch без ручного reconnect/изменения TTL. Это
   незавершённая приёмка, не доказанная ошибка runtime. Сам по себе этот
   короткий сценарий не требует повторять30min.
4. **Финальная verification и handoff.** После исправлений выполнить релевантные
   обязательные targets на финальном source, записать реальные argv/results и
   skips, проверить downstream outputs/hashes. Не заменять обязательный nested
   harness общим pnpm check. Contract/generated/architecture уже исполнены
   внутри свежего pnpm check; top-level realtime suites тоже исполнены, но
   отдельные script receipts в draft не представлены. `nginx:check` и
   `--fixture-check` нуждаются в финальном подтверждении. Source-изменение
   R1/R2 требует нового frozen manifest и нового full-profile proof; старый
   PASS сохраняет силу для прежнего snapshot. Run нового manifest — по
   существующему prepare→freeze→approval протоколу, без ослабления критериев.
5. **Delivery после разрешения.** Русский commit только issue scope, push этой
   ветки, один PR в develop с `Closes #12`, checks/review, затем merge/closure
   и accepted handoff. Эти действия сейчас не разрешены и не выполнялись.
   #64 и G00–G19 #13 нужны выпуску W1 в main; они не являются условиями
   реализации или merge самого #12.

### Уточнения, не являющиеся самостоятельными дефектами

- Строка52: реальные512/513,slow reader,loaded shutdown/cleanup дополняют
  deterministic unit boundaries64/65,+1UTF-8byte,5s,fast peer. Astra не требует
  одного TLS receipt всех точных queue boundaries при этом контракте.
- Строка55: `security.serviceTransportKeys.realtime-gateway` — собственная
  mTLS identity по принятому transport contract docs11/29/#160/#162, не DB/AROMA
  credential. Literal сокращение issue не отменяет принятый trust contract.
- Handoff должен перечислять changed downstream artifacts, а не механически
  все changed files. Оставшиеся test/harness/runbook/ADR paths сверить по
  downstream usage; одно отсутствие test path в outputs не доказывает дефект.
- `node --test tests/realtime/fixtures/harness.test.mjs` без TMPDIR: exit1,
  35PASS/1FAIL/0skip (`/tmp/coffee-audit12-harness-20261014.log`), CLI parse
  test выбирает/tmp, guard ожидает declared scratch. Корректный explicit
  `TMPDIR=/home/yurgusev/.hermes/cache/scratch node --test tests/realtime/fixtures/harness.test.mjs`:
  exit0,36/36PASS/0skip,9149.502ms; лог
  `/tmp/coffee-audit12-harness-scoped-20261014.log`. FAIL сохранён, guard не
  ослаблен, source не менялся. Prerequisite TMPDIR записать в final command.

### Все 66 checkbox-строк

| № | GitHub | Проверка | Требование live issue | Код и соответствующая проверка | Вывод / остаток |
|---|---|---|---|---|---|
| 01 | [x] | Подтверждено | Предшественники: baseline #3; прямые inputs: #8, #9, #11 и #63 merged в `develop`. | [evidence/handoffs/issue-12.yaml:2](/home/yurgusev/CoffeeOrderPlatform/evidence/handoffs/issue-12.yaml:2) | Код и соответствующий test подтверждены; отдельного незакрытого пункта в этой строке не найдено. |
| 02 | [x] | Подтверждено | Вход: `RealtimeInvalidated.v1`, trusted actor context, Order detail query identity #9 и owner GET #8/#11. | [config/platform.yaml:468](/home/yurgusev/CoffeeOrderPlatform/config/platform.yaml:468)<br>[apps/realtime-gateway/src/runtime-composition.ts:95](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/runtime-composition.ts:95)<br>[apps/web/src/browser/api/order-card.ts:19](/home/yurgusev/CoffeeOrderPlatform/apps/web/src/browser/api/order-card.ts:19) | Код и соответствующий test подтверждены; отдельного незакрытого пункта в этой строке не найдено. |
| 03 | [ ] | Частично | Выход: Kafka→bounded SSE→TanStack Query invalidation/refetch, recovery/capacity evidence и `evidence/handoffs/issue-12.yaml`. | [apps/realtime-gateway/src/hub.ts:41](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/hub.ts:41)<br>[apps/web/src/realtime/order-invalidations.ts:1](/home/yurgusev/CoffeeOrderPlatform/apps/web/src/realtime/order-invalidations.ts:1)<br>[evidence/handoffs/issue-12.yaml:11](/home/yurgusev/CoffeeOrderPlatform/evidence/handoffs/issue-12.yaml:11) | Основной путь есть; итоговая поставка и handoff ещё не приняты. |
| 04 | [ ] | Процесс впереди | Разблокирует: #13. | [Live issue #12](https://github.com/YurGusev/CoffeeOrderPlatform/issues/12) | Разблокирование successor выполняется после accepted merge #12 и проверки его остальных inputs. |
| 05 | [x] | Подтверждено | Принять merged handoff #119 до реализации уточнённого frontend/recovery scope; остальные prerequisites этой задачи сохраняются. | [evidence/handoffs/issue-12.yaml:8](/home/yurgusev/CoffeeOrderPlatform/evidence/handoffs/issue-12.yaml:8) | Код и соответствующий test подтверждены; отдельного незакрытого пункта в этой строке не найдено. |
| 06 | [x] | Подтверждено | Realtime не имеет DB/business state; только invalidation/reset/refetch, authorization и bounded buffers по owning specification. | [apps/realtime-gateway/src/hub.ts:41](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/hub.ts:41)<br>[apps/realtime-gateway/src/runtime-composition.ts:63](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/runtime-composition.ts:63)<br>[apps/realtime-gateway/src/runtime-composition.ts:96](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/runtime-composition.ts:96)<br>[tests/realtime/contract.test.mjs:24](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/contract.test.mjs:24)<br>[tests/realtime/replay.test.mjs:76](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/replay.test.mjs:76) | Код и соответствующий test подтверждены; отдельного незакрытого пункта в этой строке не найдено. |
| 07 | [x] | Подтверждено | Создать `apps/realtime-gateway`; БД, business cache и owner HTTP client отсутствуют. | [apps/realtime-gateway/package.json:1](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/package.json:1)<br>[apps/realtime-gateway/src/runtime-composition.ts:95](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/runtime-composition.ts:95)<br>[config/platform.yaml:476](/home/yurgusev/CoffeeOrderPlatform/config/platform.yaml:476)<br>[tests/realtime/auth.test.mjs:78](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/auth.test.mjs:78) | Код и соответствующий test подтверждены; отдельного незакрытого пункта в этой строке не найдено. |
| 08 | [x] | Подтверждено | Первый запуск использует ровно один экземпляр `realtime-gateway` и fixed group `realtime-gateway-v1`; consumer читает только topic `coffee.realtime.invalidate.v1`, key subjectRef, auto topic creation/auto commit запрещены. Multi-replica fanout требует отдельного issue и не входит в launch-v1. | [config/platform.yaml:475](/home/yurgusev/CoffeeOrderPlatform/config/platform.yaml:475)<br>[apps/realtime-gateway/src/contract.ts:8](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/contract.ts:8)<br>[apps/realtime-gateway/src/runtime-composition.ts:98](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/runtime-composition.ts:98)<br>[tests/realtime/auth.test.mjs:16](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/auth.test.mjs:16)<br>[tests/kafka/runtime.test.mjs:106](/home/yurgusev/CoffeeOrderPlatform/tests/kafka/runtime.test.mjs:106) | Код и соответствующий test подтверждены; отдельного незакрытого пункта в этой строке не найдено. |
| 09 | [x] | Подтверждено | Schema validate до fanout; first launch принимает только `subjectType=order`. | [apps/realtime-gateway/src/contract.ts:12](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/contract.ts:12)<br>[apps/realtime-gateway/src/contract.ts:26](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/contract.ts:26)<br>[tests/realtime/contract.test.mjs:10](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/contract.test.mjs:10)<br>[tests/realtime/contract.test.mjs:16](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/contract.test.mjs:16) | Код и соответствующий test подтверждены; отдельного незакрытого пункта в этой строке не найдено. |
| 10 | [x] | Дефект | Duplicate messageId — no-op; lower/equal ownerVersion одного subject не fanout; equal version с другим payload — quarantine. | [apps/realtime-gateway/src/hub.ts:121](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/hub.ts:121)<br>[tests/realtime/contract.test.mjs:37](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/contract.test.mjs:37) | A12-R1: equal-version сравнивает correlationId вне payload; корректный повтор ошибочно quarantine. |
| 11 | [x] | Подтверждено | Unknown schema/type и event >2KiB — quarantine/DLQ, без SSE. | [apps/realtime-gateway/src/contract.ts:26](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/contract.ts:26)<br>[packages/platform-kafka-runtime/src/index.ts:397](/home/yurgusev/CoffeeOrderPlatform/packages/platform-kafka-runtime/src/index.ts:397)<br>[tests/realtime/contract.test.mjs:24](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/contract.test.mjs:24)<br>[tests/realtime/contract.test.mjs:32](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/contract.test.mjs:32) | Код и соответствующий test подтверждены; отдельного незакрытого пункта в этой строке не найдено. |
| 12 | [x] | Подтверждено | Offset commit после ring buffer/fanout enqueue. Crash допускает gap, который закрывает reset/refetch, а не realtime DB. | [packages/platform-kafka-runtime/src/index.ts:580](/home/yurgusev/CoffeeOrderPlatform/packages/platform-kafka-runtime/src/index.ts:580)<br>[packages/platform-kafka-runtime/src/index.ts:1020](/home/yurgusev/CoffeeOrderPlatform/packages/platform-kafka-runtime/src/index.ts:1020)<br>[apps/realtime-gateway/src/hub.ts:133](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/hub.ts:133)<br>[tests/kafka/runtime.test.mjs:113](/home/yurgusev/CoffeeOrderPlatform/tests/kafka/runtime.test.mjs:113)<br>[tests/realtime/auth.test.mjs:37](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/auth.test.mjs:37) | Код и соответствующий test подтверждены; отдельного незакрытого пункта в этой строке не найдено. |
| 13 | [x] | Подтверждено | Public route существует только через nginx #162; direct realtime-gateway port private. | [config/platform.yaml:180](/home/yurgusev/CoffeeOrderPlatform/config/platform.yaml:180)<br>[tools/nginx/generate.mjs:64](/home/yurgusev/CoffeeOrderPlatform/tools/nginx/generate.mjs:64)<br>[tests/nginx/cutover.test.mjs:222](/home/yurgusev/CoffeeOrderPlatform/tests/nginx/cutover.test.mjs:222) | Код и соответствующий test подтверждены; отдельного незакрытого пункта в этой строке не найдено. |
| 14 | [x] | Подтверждено | Private Edge-авторизатор #160 проверяет session/JWT и подписывает actor context с `aud=realtime-gateway`; nginx #162 удаляет client actor headers и передаёт только trusted assertion. | [packages/platform-runtime/src/index.ts:610](/home/yurgusev/CoffeeOrderPlatform/packages/platform-runtime/src/index.ts:610)<br>[apps/realtime-gateway/src/runtime-composition.ts:51](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/runtime-composition.ts:51)<br>[packages/platform-security/src/index.ts:155](/home/yurgusev/CoffeeOrderPlatform/packages/platform-security/src/index.ts:155)<br>[tests/realtime/auth.test.mjs:16](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/auth.test.mjs:16) | Код и соответствующий test подтверждены; отдельного незакрытого пункта в этой строке не найдено. |
| 15 | [x] | Подтверждено | Gateway требует server permission `orders:read:any`; 401/403 возвращаются RFC 9457 до SSE headers. | [apps/realtime-gateway/src/runtime-composition.ts:40](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/runtime-composition.ts:40)<br>[apps/realtime-gateway/src/runtime-composition.ts:122](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/runtime-composition.ts:122)<br>[tests/realtime/auth.test.mjs:16](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/auth.test.mjs:16) | Код и соответствующий test подтверждены; отдельного незакрытого пункта в этой строке не найдено. |
| 16 | [x] | Подтверждено | Endpoint не принимает query/body actorRef, permission, subject/order filters. Клиент не выбирает доступные subjects. | [apps/realtime-gateway/src/runtime-composition.ts:113](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/runtime-composition.ts:113)<br>[tests/realtime/auth.test.mjs:25](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/auth.test.mjs:25) | Код и соответствующий test подтверждены; отдельного незакрытого пункта в этой строке не найдено. |
| 17 | [ ] | Подтверждено | Каждые 30s проверять expiry actor context; expired stream закрывается, reconnect повторно авторизуется через edge. | [apps/realtime-gateway/src/hub.ts:269](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/hub.ts:269)<br>[config/platform.yaml:491](/home/yurgusev/CoffeeOrderPlatform/config/platform.yaml:491)<br>[apps/realtime-gateway/src/runtime-composition.ts:136](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/runtime-composition.ts:136)<br>[tests/realtime/auth.test.mjs:95](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/auth.test.mjs:95) | Код и соответствующий test подтверждены; отдельного незакрытого пункта в этой строке не найдено. |
| 18 | [x] | Подтверждено | Response headers строго: `text/event-stream; charset=utf-8`, `no-cache, no-transform`, keep-alive, `X-Accel-Buffering:no`. | [apps/realtime-gateway/src/runtime-composition.ts:131](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/runtime-composition.ts:131)<br>[tests/realtime/auth.test.mjs:32](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/auth.test.mjs:32) | Код и соответствующий test подтверждены; отдельного незакрытого пункта в этой строке не найдено. |
| 19 | [x] | Подтверждено | `resource-invalidated.v1`: id=Kafka messageId; retry=3000; data только `subjectType`, `subjectRef`, decimal `ownerVersion`, `reason`, `correlationId`. | [apps/realtime-gateway/src/contract.ts:18](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/contract.ts:18)<br>[tests/realtime/contract.test.mjs:24](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/contract.test.mjs:24)<br>[tests/realtime/auth.test.mjs:37](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/auth.test.mjs:37) | Код и соответствующий test подтверждены; отдельного незакрытого пункта в этой строке не найдено. |
| 20 | [x] | Подтверждено | Customer/items/money/Desired/Observed/blockers/allowedActions/provider data запрещены schema и negative fixtures. | [apps/realtime-gateway/src/contract.ts:14](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/contract.ts:14)<br>[apps/realtime-gateway/src/contract.ts:18](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/contract.ts:18)<br>[tests/realtime/contract.test.mjs:16](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/contract.test.mjs:16)<br>[tests/realtime/contract.test.mjs:24](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/contract.test.mjs:24) | Код и соответствующий test подтверждены; отдельного незакрытого пункта в этой строке не найдено. |
| 21 | [x] | Подтверждено | После auth, replay/reset и установки live delivery отправить `stream-ready.v1` без id; heartbeat каждые 15s как SSE comment. | [apps/realtime-gateway/src/hub.ts:264](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/hub.ts:264)<br>[config/platform.yaml:490](/home/yurgusev/CoffeeOrderPlatform/config/platform.yaml:490)<br>[config/platform.yaml:200](/home/yurgusev/CoffeeOrderPlatform/config/platform.yaml:200)<br>[tests/realtime/replay.test.mjs:42](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/replay.test.mjs:42)<br>[tests/realtime/backpressure.test.mjs:112](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/backpressure.test.mjs:112) | Код и соответствующий test подтверждены; отдельного незакрытого пункта в этой строке не найдено. |
| 22 | [x] | Подтверждено | `stream-reset.v1` без id содержит только `reason=REPLAY_UNAVAILABLE`. | [apps/realtime-gateway/src/hub.ts:117](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/hub.ts:117)<br>[tests/realtime/replay.test.mjs:42](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/replay.test.mjs:42)<br>[tests/realtime/backpressure.test.mjs:122](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/backpressure.test.mjs:122) | Код и соответствующий test подтверждены; отдельного незакрытого пункта в этой строке не найдено. |
| 23 | [x] | Подтверждено | Instance ring buffer: максимум 10 000 invalidations или 5 минут, первый достигнутый лимит; business state отсутствует. | [apps/realtime-gateway/src/hub.ts:46](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/hub.ts:46)<br>[apps/realtime-gateway/src/hub.ts:105](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/hub.ts:105)<br>[config/platform.yaml:485](/home/yurgusev/CoffeeOrderPlatform/config/platform.yaml:485)<br>[tests/realtime/replay.test.mjs:76](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/replay.test.mjs:76) | Код и соответствующий test подтверждены; отдельного незакрытого пункта в этой строке не найдено. |
| 24 | [x] | Подтверждено | Header отсутствует → установить live delivery → ready; ID найден → replay subsequent/local ordered events → установить live delivery → ready → live frames. | [apps/realtime-gateway/src/hub.ts:167](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/hub.ts:167)<br>[apps/realtime-gateway/src/hub.ts:189](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/hub.ts:189)<br>[apps/realtime-gateway/src/hub.ts:261](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/hub.ts:261)<br>[tests/realtime/replay.test.mjs:52](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/replay.test.mjs:52)<br>[tests/realtime/replay.test.mjs:69](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/replay.test.mjs:69) | Код и соответствующий test подтверждены; отдельного незакрытого пункта в этой строке не найдено. |
| 25 | [x] | Подтверждено | Malformed/not found/evicted/restart/другая replica → stream-reset → установить live delivery → ready → live frames. | [apps/realtime-gateway/src/hub.ts:167](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/hub.ts:167)<br>[apps/realtime-gateway/src/hub.ts:263](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/hub.ts:263)<br>[tests/realtime/replay.test.mjs:42](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/replay.test.mjs:42)<br>[tests/realtime/replay.test.mjs:76](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/replay.test.mjs:76) | Код и соответствующий test подтверждены; отдельного незакрытого пункта в этой строке не найдено. |
| 26 | [x] | Подтверждено | Query `lastEventId` запрещён; persistent replay DB/sticky session не добавлять. | [apps/realtime-gateway/src/runtime-composition.ts:113](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/runtime-composition.ts:113)<br>[tests/realtime/auth.test.mjs:25](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/auth.test.mjs:25) | Код и соответствующий test подтверждены; отдельного незакрытого пункта в этой строке не найдено. |
| 27 | [x] | Подтверждено | Replay является оптимизацией; безопасный результат всегда достигается owner refetch. | [apps/realtime-gateway/src/hub.ts:39](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/hub.ts:39)<br>[apps/realtime-gateway/src/contract.ts:18](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/contract.ts:18)<br>[tests/realtime/replay.test.mjs:76](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/replay.test.mjs:76)<br>[tests/realtime/contract.test.mjs:24](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/contract.test.mjs:24) | Код и соответствующий test подтверждены; отдельного незакрытого пункта в этой строке не найдено. |
| 28 | [ ] | Частично | Материализовать fixed group `realtime-gateway-v1` и согласовать config/platform.yaml/schema с профилем `operator-1`: technical admission 512, nginx/realtime по 2 CPU и 512 MiB; существующие queue/ring/FD/TTL/security ограничения не повышать. Удалить неиспользуемый executable isolated-5000/full-memory override без удаления исторических evidence; доказать новый soak. | [config/platform.yaml:193](/home/yurgusev/CoffeeOrderPlatform/config/platform.yaml:193)<br>[config/platform.yaml:479](/home/yurgusev/CoffeeOrderPlatform/config/platform.yaml:479)<br>[packages/platform-config/src/index.ts:858](/home/yurgusev/CoffeeOrderPlatform/packages/platform-config/src/index.ts:858)<br>[tests/realtime/fixtures/harness.test.mjs:35](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/fixtures/harness.test.mjs:35)<br>[tests/realtime/fixtures/harness.test.mjs:13](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/fixtures/harness.test.mjs:13)<br>[config/platform.yaml:468](/home/yurgusev/CoffeeOrderPlatform/config/platform.yaml:468) | A12-R2: fixed group и текущий профиль верны, но parser/schema разрешают повышенные admission/RSS/FD. |
| 29 | [ ] | Частично | Технический максимум 512 connections на instance и публичном nginx; 513-й получает `503 REALTIME_CAPACITY_EXCEEDED` до SSE headers. Это защитный ceiling существующего reference-профиля, не модель покупателей: штатно работает одна вкладка оператора. Согласовать gateway concurrency/maxConnections, nginx admission, schema и owning specification. | [config/platform.yaml:203](/home/yurgusev/CoffeeOrderPlatform/config/platform.yaml:203)<br>[config/platform.yaml:474](/home/yurgusev/CoffeeOrderPlatform/config/platform.yaml:474)<br>[apps/realtime-gateway/src/hub.ts:83](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/hub.ts:83)<br>[tests/realtime/backpressure.test.mjs:175](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/backpressure.test.mjs:175)<br>[tests/nginx/cutover.test.mjs:222](/home/yurgusev/CoffeeOrderPlatform/tests/nginx/cutover.test.mjs:222)<br>[apps/realtime-gateway/src/runtime-composition.ts:80](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/runtime-composition.ts:80) | A12-R2: реальные512/513 прошли; nginx schema всё ещё принимает513..5000. |
| 30 | [x] | Подтверждено | Queue одного connection: максимум 64 records или 256KiB serialized. | [apps/realtime-gateway/src/hub.ts:236](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/hub.ts:236)<br>[config/platform.yaml:481](/home/yurgusev/CoffeeOrderPlatform/config/platform.yaml:481)<br>[tests/realtime/backpressure.test.mjs:129](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/backpressure.test.mjs:129)<br>[tests/realtime/backpressure.test.mjs:139](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/backpressure.test.mjs:139) | Код и соответствующий test подтверждены; отдельного незакрытого пункта в этой строке не найдено. |
| 31 | [x] | Подтверждено | Socket write deadline 5s; heartbeat 15s; nginx idle timeout минимум 45s. | [config/platform.yaml:489](/home/yurgusev/CoffeeOrderPlatform/config/platform.yaml:489)<br>[apps/realtime-gateway/src/hub.ts:228](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/hub.ts:228)<br>[apps/realtime-gateway/src/hub.ts:268](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/hub.ts:268)<br>[tests/realtime/backpressure.test.mjs:163](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/backpressure.test.mjs:163)<br>[tests/realtime/backpressure.test.mjs:112](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/backpressure.test.mjs:112) | Код и соответствующий test подтверждены; отдельного незакрытого пункта в этой строке не найдено. |
| 32 | [x] | Подтверждено | Coalesce одного subject в окне 250ms: оставить наибольшую ownerVersion/message id выбранного event. | [apps/realtime-gateway/src/hub.ts:147](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/hub.ts:147)<br>[config/platform.yaml:488](/home/yurgusev/CoffeeOrderPlatform/config/platform.yaml:488)<br>[tests/realtime/replay.test.mjs:87](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/replay.test.mjs:87) | Код и соответствующий test подтверждены; отдельного незакрытого пункта в этой строке не найдено. |
| 33 | [x] | Подтверждено | Overflow/write timeout/socket abort немедленно удаляет connection, queue, listeners и timers; медленный client не блокирует consumer/других. | [apps/realtime-gateway/src/hub.ts:176](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/hub.ts:176)<br>[apps/realtime-gateway/src/hub.ts:236](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/hub.ts:236)<br>[apps/realtime-gateway/src/hub.ts:228](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/hub.ts:228)<br>[tests/realtime/backpressure.test.mjs:112](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/backpressure.test.mjs:112)<br>[tests/realtime/backpressure.test.mjs:129](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/backpressure.test.mjs:129)<br>[tests/realtime/backpressure.test.mjs:163](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/backpressure.test.mjs:163) | Код и соответствующий test подтверждены; отдельного незакрытого пункта в этой строке не найдено. |
| 34 | [ ] | Подтверждено | Graceful shutdown 20s: stop accept, stream-reset, close sockets, затем consumer. | [apps/realtime-gateway/src/runtime-composition.ts:87](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/runtime-composition.ts:87)<br>[apps/realtime-gateway/src/runtime-composition.ts:107](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/runtime-composition.ts:107)<br>[packages/platform-runtime/src/index.ts:257](/home/yurgusev/CoffeeOrderPlatform/packages/platform-runtime/src/index.ts:257)<br>[tests/realtime/auth.test.mjs:45](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/auth.test.mjs:45)<br>[tests/realtime/backpressure.test.mjs:122](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/backpressure.test.mjs:122)<br>[tests/runtime/lifecycle.test.mjs:1034](/home/yurgusev/CoffeeOrderPlatform/tests/runtime/lifecycle.test.mjs:1034) | Код закрывает realtime до consumer; loaded SIGTERM340.320ms, reset/server-close, exit0 и cleanup подтверждены. |
| 35 | [x] | Подтверждено | Создать `apps/web/src/realtime/order-invalidations.ts`: один same-origin EventSource на tab, session cookie через edge; ручных auth/actor headers нет. | [apps/web/src/browser/app/OrderRealtime.tsx:16](/home/yurgusev/CoffeeOrderPlatform/apps/web/src/browser/app/OrderRealtime.tsx:16)<br>[apps/web/src/browser/app/OrderRealtime.tsx:57](/home/yurgusev/CoffeeOrderPlatform/apps/web/src/browser/app/OrderRealtime.tsx:57)<br>[apps/web/src/browser/app/session.tsx:92](/home/yurgusev/CoffeeOrderPlatform/apps/web/src/browser/app/session.tsx:92)<br>[apps/web/test/operator-flow.spec.ts](/home/yurgusev/CoffeeOrderPlatform/apps/web/test/operator-flow.spec.ts) | Код и соответствующий test подтверждены; отдельного незакрытого пункта в этой строке не найдено. |
| 36 | [x] | Подтверждено | Runtime validate каждый frame; принять только valid order ref/version. | [apps/web/src/realtime/order-invalidations.ts:7](/home/yurgusev/CoffeeOrderPlatform/apps/web/src/realtime/order-invalidations.ts:7)<br>[apps/web/test/realtime.test.ts](/home/yurgusev/CoffeeOrderPlatform/apps/web/test/realtime.test.ts)<br>[apps/web/test/operator-flow.spec.ts](/home/yurgusev/CoffeeOrderPlatform/apps/web/test/operator-flow.spec.ts) | Код и соответствующий test подтверждены; отдельного незакрытого пункта в этой строке не найдено. |
| 37 | [x] | Подтверждено | `resource-invalidated`: exact invalidation/refetch TanStack Query Order detail по `subjectRef`; SSE data никогда не записывать в TanStack Query cache. | [apps/web/src/realtime/order-invalidations.ts:46](/home/yurgusev/CoffeeOrderPlatform/apps/web/src/realtime/order-invalidations.ts:46)<br>[apps/web/src/realtime/order-invalidations.ts:33](/home/yurgusev/CoffeeOrderPlatform/apps/web/src/realtime/order-invalidations.ts:33)<br>[apps/web/test/realtime.test.ts](/home/yurgusev/CoffeeOrderPlatform/apps/web/test/realtime.test.ts)<br>[apps/web/test/operator-flow.spec.ts](/home/yurgusev/CoffeeOrderPlatform/apps/web/test/operator-flow.spec.ts) | Код и соответствующий test подтверждены; отдельного незакрытого пункта в этой строке не найдено. |
| 38 | [x] | Подтверждено | Cached `OrderCard.projectionVersion >= ownerVersion` допускает duplicate skip; меньшая версия не откатывает UI, equal version с другим payload quarantined, новая/unknown/gap версия запускает owner GET; response принимается через общий monotonic projectionVersion guard #9. | [apps/web/src/realtime/order-invalidations.ts:46](/home/yurgusev/CoffeeOrderPlatform/apps/web/src/realtime/order-invalidations.ts:46)<br>[apps/web/src/browser/api/order-card.ts:19](/home/yurgusev/CoffeeOrderPlatform/apps/web/src/browser/api/order-card.ts:19)<br>[apps/web/src/browser/api/remote.ts:109](/home/yurgusev/CoffeeOrderPlatform/apps/web/src/browser/api/remote.ts:109)<br>[apps/web/test/operator-flow.spec.ts](/home/yurgusev/CoffeeOrderPlatform/apps/web/test/operator-flow.spec.ts) | Код и соответствующий test подтверждены; отдельного незакрытого пункта в этой строке не найдено. |
| 39 | [x] | Подтверждено | `stream-reset`: invalidates все уже materialized Order-detail query keys и refetches только active; Customer/Catalog/Pricing queries не затрагиваются. Используется существующий prefix #9, новый namespace или второй QueryClient не вводится. | [apps/web/src/realtime/order-invalidations.ts:29](/home/yurgusev/CoffeeOrderPlatform/apps/web/src/realtime/order-invalidations.ts:29)<br>[apps/web/src/realtime/order-invalidations.ts:55](/home/yurgusev/CoffeeOrderPlatform/apps/web/src/realtime/order-invalidations.ts:55)<br>[apps/web/test/realtime.test.ts](/home/yurgusev/CoffeeOrderPlatform/apps/web/test/realtime.test.ts)<br>[apps/web/test/operator-flow.spec.ts](/home/yurgusev/CoffeeOrderPlatform/apps/web/test/operator-flow.spec.ts) | Код и соответствующий test подтверждены; отдельного незакрытого пункта в этой строке не найдено. |
| 40 | [x] | Подтверждено | Использовать native reconnect + server retry=3000; второй retry loop запрещён. | [apps/web/src/browser/app/OrderRealtime.tsx:18](/home/yurgusev/CoffeeOrderPlatform/apps/web/src/browser/app/OrderRealtime.tsx:18)<br>[apps/realtime-gateway/src/contract.ts:23](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/contract.ts:23)<br>[apps/realtime-gateway/src/hub.ts:259](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/hub.ts:259)<br>[tests/realtime/contract.test.mjs](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/contract.test.mjs)<br>[apps/web/test/operator-flow.spec.ts](/home/yurgusev/CoffeeOrderPlatform/apps/web/test/operator-flow.spec.ts)<br>[tests/orders/aroma-preparation-live.test.mjs](/home/yurgusev/CoffeeOrderPlatform/tests/orders/aroma-preparation-live.test.mjs) | Код и соответствующий test подтверждены; отдельного незакрытого пункта в этой строке не найдено. |
| 41 | [x] | Подтверждено | UI indicator `Подключено\|Переподключение\|Обновление состояния` не меняет Order/AROMA state. После 30s offline — banner и manual owner refetch. | [apps/web/src/browser/app/OrderRealtime.tsx:8](/home/yurgusev/CoffeeOrderPlatform/apps/web/src/browser/app/OrderRealtime.tsx:8)<br>[apps/web/src/browser/app/OrderRealtime.tsx:46](/home/yurgusev/CoffeeOrderPlatform/apps/web/src/browser/app/OrderRealtime.tsx:46)<br>[apps/web/src/browser/app/OrderRealtime.tsx:83](/home/yurgusev/CoffeeOrderPlatform/apps/web/src/browser/app/OrderRealtime.tsx:83)<br>[apps/web/test/operator-flow.spec.ts](/home/yurgusev/CoffeeOrderPlatform/apps/web/test/operator-flow.spec.ts) | Код и соответствующий test подтверждены; отдельного незакрытого пункта в этой строке не найдено. |
| 42 | [x] | Подтверждено | На каждом stream-ready, включая первое подключение без Last-Event-ID, инвалидировать существующие Order detail queries и refetch только active; закрыть окно initial GET → subscription. | [apps/web/src/browser/app/OrderRealtime.tsx:57](/home/yurgusev/CoffeeOrderPlatform/apps/web/src/browser/app/OrderRealtime.tsx:57)<br>[apps/web/src/realtime/order-invalidations.ts:33](/home/yurgusev/CoffeeOrderPlatform/apps/web/src/realtime/order-invalidations.ts:33)<br>[apps/web/src/realtime/order-invalidations.ts:55](/home/yurgusev/CoffeeOrderPlatform/apps/web/src/realtime/order-invalidations.ts:55)<br>[apps/web/test/realtime.test.ts](/home/yurgusev/CoffeeOrderPlatform/apps/web/test/realtime.test.ts)<br>[apps/web/test/operator-flow.spec.ts](/home/yurgusev/CoffeeOrderPlatform/apps/web/test/operator-flow.spec.ts) | Код и соответствующий test подтверждены; отдельного незакрытого пункта в этой строке не найдено. |
| 43 | [x] | Подтверждено | Gateway готовит boundary/queue без промежутка потери событий и отправляет ready после replay/reset и установки live delivery. Новый reconnect loop не создаётся. | [apps/realtime-gateway/src/runtime-composition.ts:87](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/runtime-composition.ts:87)<br>[apps/realtime-gateway/src/runtime-composition.ts:104](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/runtime-composition.ts:104)<br>[apps/realtime-gateway/src/hub.ts:167](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/hub.ts:167)<br>[tests/realtime/auth.test.mjs:78](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/auth.test.mjs:78)<br>[tests/realtime/replay.test.mjs:69](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/replay.test.mjs:69) | Код и соответствующий test подтверждены; отдельного незакрытого пункта в этой строке не найдено. |
| 44 | [x] | Подтверждено | Refetch использует monotonic projectionVersion guard #9; late response не откатывает карточку. | [apps/web/src/browser/api/order-card.ts:19](/home/yurgusev/CoffeeOrderPlatform/apps/web/src/browser/api/order-card.ts:19)<br>[apps/web/src/browser/api/remote.ts:113](/home/yurgusev/CoffeeOrderPlatform/apps/web/src/browser/api/remote.ts:113)<br>[apps/web/test/operator-flow.spec.ts](/home/yurgusev/CoffeeOrderPlatform/apps/web/test/operator-flow.spec.ts) | Код и соответствующий test подтверждены; отдельного незакрытого пункта в этой строке не найдено. |
| 45 | [x] | Подтверждено | Logout/session switch закрывает EventSource/listeners и отбрасывает late handlers; session не разделяет cache с другим пользователем. | [apps/web/src/browser/api/session-identity.ts:13](/home/yurgusev/CoffeeOrderPlatform/apps/web/src/browser/api/session-identity.ts:13)<br>[apps/web/src/browser/app/session.tsx:27](/home/yurgusev/CoffeeOrderPlatform/apps/web/src/browser/app/session.tsx:27)<br>[apps/web/src/browser/app/session.tsx:92](/home/yurgusev/CoffeeOrderPlatform/apps/web/src/browser/app/session.tsx:92)<br>[apps/web/test/operator-flow.spec.ts](/home/yurgusev/CoffeeOrderPlatform/apps/web/test/operator-flow.spec.ts) | Код и соответствующий test подтверждены; отдельного незакрытого пункта в этой строке не найдено. |
| 46 | [x] | Частично | Kafka schema/key/version/dedup/out-of-order/quarantine. | [apps/realtime-gateway/src/contract.ts:26](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/contract.ts:26)<br>[apps/realtime-gateway/src/hub.ts:121](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/hub.ts:121)<br>[packages/platform-kafka-runtime/src/index.ts:429](/home/yurgusev/CoffeeOrderPlatform/packages/platform-kafka-runtime/src/index.ts:429)<br>[tests/realtime/contract.test.mjs:10](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/contract.test.mjs:10)<br>[tests/realtime/contract.test.mjs:16](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/contract.test.mjs:16)<br>[tests/realtime/contract.test.mjs:32](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/contract.test.mjs:32) | Тесты категорий есть; добавить regression A12-R1 для того же payload с новым messageId/correlationId. |
| 47 | [ ] | Подтверждено | Auth: no session, wrong permission/audience, forged headers, expiry и reconnect re-auth. | [apps/realtime-gateway/src/hub.ts:267](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/hub.ts:267)<br>[tests/realtime/auth.test.mjs:112](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/auth.test.mjs:112)<br>[evidence/issue-12-analysis.md:4767](/home/yurgusev/CoffeeOrderPlatform/evidence/issue-12-analysis.md:4767) | Negative auth код/тесты и19 реальных re-auth пройдены; native browser proof отдельно в66. |
| 48 | [x] | Подтверждено | Wire headers/frames/UTF-8/heartbeat и negative business-field fixtures. | [apps/realtime-gateway/src/runtime-composition.ts:131](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/runtime-composition.ts:131)<br>[apps/realtime-gateway/src/contract.ts:18](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/contract.ts:18)<br>[tests/realtime/auth.test.mjs:32](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/auth.test.mjs:32)<br>[tests/realtime/contract.test.mjs:24](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/contract.test.mjs:24)<br>[tests/realtime/contract.test.mjs:16](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/contract.test.mjs:16) | Код и соответствующий test подтверждены; отдельного незакрытого пункта в этой строке не найдено. |
| 49 | [x] | Подтверждено | Last-Event-ID replay found и reset для malformed/missing/evicted/restart. | [apps/realtime-gateway/src/hub.ts:167](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/hub.ts:167)<br>[apps/realtime-gateway/src/hub.ts:263](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/hub.ts:263)<br>[tests/realtime/replay.test.mjs:9](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/replay.test.mjs:9)<br>[tests/realtime/replay.test.mjs:42](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/replay.test.mjs:42)<br>[tests/realtime/replay.test.mjs:76](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/replay.test.mjs:76) | Код и соответствующий test подтверждены; отдельного незакрытого пункта в этой строке не найдено. |
| 50 | [x] | Подтверждено | Frontend exact invalidation, inactive no eager fetch, reset query keys и refetch через общий monotonic owner-response guard #9, без записи SSE payload. | [apps/web/src/realtime/order-invalidations.ts:29](/home/yurgusev/CoffeeOrderPlatform/apps/web/src/realtime/order-invalidations.ts:29)<br>[apps/web/src/browser/api/remote.ts:109](/home/yurgusev/CoffeeOrderPlatform/apps/web/src/browser/api/remote.ts:109)<br>[apps/web/test/realtime.test.ts](/home/yurgusev/CoffeeOrderPlatform/apps/web/test/realtime.test.ts) | Код и соответствующий test подтверждены; отдельного незакрытого пункта в этой строке не найдено. |
| 51 | [x] | Подтверждено | Duplicate/lower invalidations не откатывают UI. | [apps/web/src/realtime/order-invalidations.ts:46](/home/yurgusev/CoffeeOrderPlatform/apps/web/src/realtime/order-invalidations.ts:46)<br>[apps/web/src/browser/api/order-card.ts:19](/home/yurgusev/CoffeeOrderPlatform/apps/web/src/browser/api/order-card.ts:19)<br>[apps/web/test/operator-flow.spec.ts](/home/yurgusev/CoffeeOrderPlatform/apps/web/test/operator-flow.spec.ts)<br>[tests/orders/aroma-preparation-live.test.mjs](/home/yurgusev/CoffeeOrderPlatform/tests/orders/aroma-preparation-live.test.mjs) | Код и соответствующий test подтверждены; отдельного незакрытого пункта в этой строке не найдено. |
| 52 | [ ] | Подтверждено | Capacity boundaries отдельно от штатной нагрузки: реальные 512/513 connections, 64/65 records, 256KiB/+1 UTF-8 byte, stalled 5s, socket abort/fast peer и graceful shutdown живых streams с проверенным cleanup; отказ происходит до SSE headers. | [apps/realtime-gateway/src/hub.ts:83](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/hub.ts:83)<br>[apps/realtime-gateway/src/hub.ts:236](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/hub.ts:236)<br>[apps/realtime-gateway/src/runtime-composition.ts:126](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/runtime-composition.ts:126)<br>[tests/realtime/backpressure.test.mjs:74](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/backpressure.test.mjs:74)<br>[tests/realtime/backpressure.test.mjs:129](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/backpressure.test.mjs:129)<br>[tests/realtime/backpressure.test.mjs:139](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/backpressure.test.mjs:139) | 64/65,+1byte,5s/fast peer — unit;512/513,slow reader,loaded shutdown/cleanup — реальные transport receipts. Единый TLS receipt всех границ не требуется. |
| 53 | [ ] | Подтверждено | Новый полный soak `operator-1`: 1 live SSE subscriber, 100 ACKed metadata invalidations/s для 100 order subjects, 30min; actual expiry/re-auth/replay/reset, session renewal, HUP на 900s, loaded shutdown и cleanup. Aggregate event p95≤1000ms, process event-loop p95≤100ms, headroom≤1000ms, shutdown≤20s, cleanup≤10s; RSS/FD/CPU/OOM evidence в штатных budgets. Prepare→frozen manifest→отдельное разрешение→run; smoke/старый5000FAIL не дают новый PASS. 100 invalidations/s не означает100orders/s. | [evidence/issue-12-analysis.md:4737](/home/yurgusev/CoffeeOrderPlatform/evidence/issue-12-analysis.md:4737)<br>[/tmp/coffee-operator1-run-20261014.log](/tmp/coffee-operator1-run-20261014.log) | Полный замороженный operator-1 PASS:180001ACK,p95307ms,loop22.151ms; ограничения bins/heartbeat/max latency сохраняются. |
| 54 | [x] | Подтверждено | `pnpm architecture:check`: только event/platform Kafka/SSE packages; owner runtime/domain/repository/DB запрещены. | [evidence/handoffs/issue-12.yaml:122](/home/yurgusev/CoffeeOrderPlatform/evidence/handoffs/issue-12.yaml:122)<br>[scripts/check-architecture.mjs](/home/yurgusev/CoffeeOrderPlatform/scripts/check-architecture.mjs) | Код и соответствующий test подтверждены; отдельного незакрытого пункта в этой строке не найдено. |
| 55 | [ ] | Подтверждено | Manifest/config/bundle/redaction: нет DATABASE_URL, DB/AROMA secrets, PII/business payload; только `kafka.realtime`, actor verification и telemetry. | [config/platform.yaml:503](/home/yurgusev/CoffeeOrderPlatform/config/platform.yaml:503)<br>[compose.yaml:536](/home/yurgusev/CoffeeOrderPlatform/compose.yaml:536)<br>[tests/realtime/fixtures/harness.test.mjs:139](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/fixtures/harness.test.mjs:139) | Собственная mTLS identity разрешена docs11/29 и inputs160/162; это не DB/provider secret. Nested redaction/harness36/36 прошёл с указанным TMPDIR. |
| 56 | [x] | Подтверждено | Проверить потерю hint между initial GET и первым ready, lower replay/late GET и logout во время refetch; inactive queries не вызывают eager requests. | [apps/web/src/realtime/order-invalidations.ts:33](/home/yurgusev/CoffeeOrderPlatform/apps/web/src/realtime/order-invalidations.ts:33)<br>[apps/web/src/browser/app/OrderRealtime.tsx:70](/home/yurgusev/CoffeeOrderPlatform/apps/web/src/browser/app/OrderRealtime.tsx:70)<br>[apps/web/src/browser/api/remote.ts:113](/home/yurgusev/CoffeeOrderPlatform/apps/web/src/browser/api/remote.ts:113)<br>[apps/web/test/operator-flow.spec.ts](/home/yurgusev/CoffeeOrderPlatform/apps/web/test/operator-flow.spec.ts) | Код и соответствующий test подтверждены; отдельного незакрытого пункта в этой строке не найдено. |
| 57 | [ ] | Подтверждено | Расширить существующий tests/orders/owner-live.test.mjs ограниченным peak-сценарием:100 одновременно запущенных buyer flows с разными customerRef, один заказ/10 позиций на flow, реальные существующие Orders routes→application→OrderStore→PostgreSQL→Outbox. Проверить100 durable orders/1000positions, сохранённые versions и idempotency/retry без второго заказа/эффекта; прямые INSERT или synthetic Kafka ACK не заменяют команды. Записать actual concurrency, completions/errors, elapsed, throughput, p50/p95/p99 и DB pool/lock failures при действующих deadlines. Existing synthetic Customer/Pricing/auth seams перечислить явно: это owner-boundary proof, не real ingress/VK/Agent/LLM E2E. | [tests/orders/owner-live.test.mjs:217](/home/yurgusev/CoffeeOrderPlatform/tests/orders/owner-live.test.mjs:217)<br>[evidence/issue-12-analysis.md:4659](/home/yurgusev/CoffeeOrderPlatform/evidence/issue-12-analysis.md:4659)<br>[evidence/handoffs/issue-12.yaml:79](/home/yurgusev/CoffeeOrderPlatform/evidence/handoffs/issue-12.yaml:79) | 100/100 flows,1400 успешных команд,0 refusals/retries;100 durable Orders/1000 items. Synthetic upstream/Fastify.inject явно ограничивают scope. |
| 58 | [ ] | Подтверждено | Сохранить material owner→Outbox→Kafka→nginx→served SPA→real owner GET proof одной вкладки и проверить её восстановление/monotonic state во время потока owner material changes. В existing preparation live regression дополнительно проверить100contributions×10lines без удаления прежнего100×100 и без изменения recompute2s; seeded cardinality не выдавать за командный throughput. Draft/item-edit realtime emitters и безопасный provider mutation protocol не менять в этом scope. | [tests/orders/aroma-preparation-live.test.mjs:814](/home/yurgusev/CoffeeOrderPlatform/tests/orders/aroma-preparation-live.test.mjs:814)<br>[tests/orders/aroma-preparation-live.test.mjs:275](/home/yurgusev/CoffeeOrderPlatform/tests/orders/aroma-preparation-live.test.mjs:275)<br>[tests/realtime/fixtures/owner-browser.mjs:197](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/fixtures/owner-browser.mjs:197)<br>[tests/orders/aroma-preparation-live.test.mjs](/home/yurgusev/CoffeeOrderPlatform/tests/orders/aroma-preparation-live.test.mjs)<br>[evidence/issue-12-analysis.md:4702](/home/yurgusev/CoffeeOrderPlatform/evidence/issue-12-analysis.md:4702) | Реальный owner-browser positive/private-eof2/2;100×10 и100×100 preparation2/2 при2s,814/1933ms. |
| 59 | [ ] | Частично | Синхронизировать численный профиль в docs/launch/20_REALTIME_SSE_IMPLEMENTATION_SPEC.md, 21_LAUNCH_VERIFICATION_SPEC.md, 29_NGINX_TRANSPORT_AND_AUTH.md и затронутых runtime/runbook документах; immutable revision roots не менять. Создать `evidence/handoffs/issue-12.yaml`: accepted inputs, hashes outputs, consumers, отдельные transport/owner/browser proofs, реальные команды и limitations. Архивные5000FAIL и experimental ADR не переписывать в PASS. | [docs/launch/20_REALTIME_SSE_IMPLEMENTATION_SPEC.md:189](/home/yurgusev/CoffeeOrderPlatform/docs/launch/20_REALTIME_SSE_IMPLEMENTATION_SPEC.md:189)<br>[evidence/handoffs/issue-12.yaml:1](/home/yurgusev/CoffeeOrderPlatform/evidence/handoffs/issue-12.yaml:1) | Draft существует и hashes верны; дополнить verification обязательных targets/связью с финальным source, проверить downstream outputs, отразить незакрытые A12-R1/R2/R3. |
| 60 | [ ] | Процесс впереди | Ветка `feature/12-realtime-order-card` только от `develop`; PR только в `develop`. | [Live issue #12](https://github.com/YurGusev/CoffeeOrderPlatform/issues/12) | Локальная ветка верна и основана на develop; commit/push/PR ещё не выполнены. |
| 61 | [ ] | Процесс впереди | Один issue — одна ветка — один PR; gateway, frontend adapter, contracts, tests, capacity evidence и docs находятся в PR. | [Live issue #12](https://github.com/YurGusev/CoffeeOrderPlatform/issues/12) | Один PR в develop отсутствует; полный diff должен пройти финальную приёмку. |
| 62 | [ ] | Процесс впереди | Коммиты, PR и review replies — на русском; PR содержит `Closes #12`. | [Live issue #12](https://github.com/YurGusev/CoffeeOrderPlatform/issues/12) | Коммита/PR/review replies пока нет; при разрешённой публикации нужен русский текст и Closes #12. |
| 63 | [ ] | Процесс впереди | Статусы: `Готово к работе → В работе → На проверке → Готово`; после merge публикуется handoff #12. | [Live issue #12](https://github.com/YurGusev/CoffeeOrderPlatform/issues/12) | GitHub OPEN/status:in-progress; review/merge/closure и accepted handoff не произошли. |
| 64 | [x] | Подтверждено | Принять auth contract [#160](https://github.com/YurGusev/CoffeeOrderPlatform/issues/160) и transport handoff [#162](https://github.com/YurGusev/CoffeeOrderPlatform/issues/162) без снятия прежних inputs #8/#9/#11/#63/#119. | [evidence/handoffs/issue-12.yaml:9](/home/yurgusev/CoffeeOrderPlatform/evidence/handoffs/issue-12.yaml:9)<br>[docs/launch/29_NGINX_TRANSPORT_AND_AUTH.md](/home/yurgusev/CoffeeOrderPlatform/docs/launch/29_NGINX_TRANSPORT_AND_AUTH.md) | Код и соответствующий test подтверждены; отдельного незакрытого пункта в этой строке не найдено. |
| 65 | [x] | Подтверждено | Проверить, что realtime допускает только transport SAN `edge-nginx` + assertion signer `edge-gateway`, `aud=realtime-gateway`; spoofed browser actor, неверные audience/SAN и просроченный контекст отклоняются. | [packages/platform-runtime/src/index.ts:610](/home/yurgusev/CoffeeOrderPlatform/packages/platform-runtime/src/index.ts:610)<br>[packages/platform-security/src/index.ts:155](/home/yurgusev/CoffeeOrderPlatform/packages/platform-security/src/index.ts:155)<br>[apps/realtime-gateway/src/runtime-composition.ts:51](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/runtime-composition.ts:51)<br>[tests/realtime/auth.test.mjs:16](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/auth.test.mjs:16)<br>[tests/realtime/auth.test.mjs:115](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/auth.test.mjs:115) | Код и соответствующий test подтверждены; отдельного незакрытого пункта в этой строке не найдено. |
| 66 | [ ] | Частично | Проверить одну native EventSource вкладку через nginx: SSE buffering выключен, stream-reset/ready, reconnect после auth expiry, technical admission512/513 отдельно от рабочей когорты, idle/heartbeat budget; nginx не реализует replay/fanout/permissions вместо realtime. | [tests/realtime/fixtures/owner-browser.mjs:177](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/fixtures/owner-browser.mjs:177)<br>[tests/realtime/fixtures/owner-browser.mjs:217](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/fixtures/owner-browser.mjs:217)<br>[tests/realtime/fixtures/owner-browser.mjs:260](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/fixtures/owner-browser.mjs:260)<br>[tests/orders/aroma-preparation-live.test.mjs](/home/yurgusev/CoffeeOrderPlatform/tests/orders/aroma-preparation-live.test.mjs)<br>[tests/realtime/soak.test.mjs](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/soak.test.mjs)<br>[apps/web/test/operator-flow.spec.ts](/home/yurgusev/CoffeeOrderPlatform/apps/web/test/operator-flow.spec.ts) | A12-R3: нет native EventSource→nginx→Edge expiry→re-auth→ready→owner GET в одном proof. |

Production/VK/Agent/LLM, provider mutation и multi-replica admission не
проверялись. Native C patch рассмотрен только как pinned resume-wakeup
изменение; полный аудит внутренних блокировок librdkafka не выполнялся.
Новых зависимостей/test infrastructure/debug paths нет; функциональный source
и исходные PASS/FAIL receipts не изменены.


## Исправления после аудита всех checkbox-строк — 14 октября 2026

Разрешённый scope: локально устранить A12-R1/R2/R3, добавить joined browser
re-auth proof, проверить итог и подготовить merge readiness. Коммит,
публикация, remote mutation, provider/production mutation не разрешены.
Astra-orchestrator: bounded Luna workers/tester, независимый Astra reviewer,
root отвечает за интеграцию и окончательную классификацию доказательств.
Исторический аудит выше описывает состояние до этих исправлений.

- A12-R1: в [hub.ts](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/hub.ts:129)
  equal-version digest сравнивает payload. Envelope digest для одинакового
  messageId сохранён: изменение correlationId у того же messageId по-прежнему
  quarantine. Существующий contract test защищает все три случая:
  одинаковый payload с новым messageId/correlationId — no-op; иной payload
  при той же версии — quarantine; конфликт envelope того же messageId — quarantine.
  До исправления новый regression case был RED; после исправления suite5/5 PASS.
- A12-R2: nginx JSON Schema и direct renderer ограничивают admission512;
  platform parser/schema ограничивают RSS536870912 и FD12288. Config negative
  tests отвергают513/5000, RSS+1 и FD+1. Runtime hard bounds и budgets не повышены.
- A12-R3: добавлен сценарий `reauth` в существующем owner-browser fixture и
  live test, расширены два existing harness integrity checks. Сценарий ждёт
  естественный actor TTL60s при auth check30s и session900000ms, затем проверяет
  gateway auth-close, тот же native EventSource, fresh nginx/Edge200 admission,
  Last-Event-ID, stream-ready и actual monotonic owner GET. Card/Outbox не
  должны измениться. Source и compiled runtime сохраняются; только существующий
  private-eof сценарий допускает свою явную framing transformation.
  Runtime PASS этого нового сценария фиксируется отдельно после завершения.

### Native build: сохранённый FAIL и исправление первопричины

Первый combined browser run дал positive1PASS, затем private-eof упал до
начала сценария на native Docker build; reauth был отменён при SIGINT. Логи:
`/tmp/coffee-issue12-fix-tests-20261014/08-preparation-owner-realtime-vertical.stdout`
и `/tmp/coffee-issue12-native-header-failure-20261014.log`.
BuildKit первопричина: node-gyp12.4.0 пытался скачать Node26.8.1 headers с
nodejs.org; ConnectTimeoutError спустя10s. pnpm install был успешен;
компиляция addon и ldd ещё не запускались. Доказательств ENOSPC/ABI failure нет.

В exact pinned Node image без сети подтверждены headers26.8.1/ABI147 в
/usr/local/include/node. Node-pre-gyp уже поддерживает nodedir. Единственная
runtime build правка в [Dockerfile](/home/yurgusev/CoffeeOrderPlatform/Dockerfile:88):
`rebuild --nodedir=/usr/local`, без нового downloader, retry или dependency.
Dynamic librdkafka linking и существующий ldd guard сохранены.

`pnpm image:build --target runtime --build-arg RUNTIME=realtime-gateway --tag coffee-issue12-native-headers-20261014 --load .`
дал exit0: actual native compile/SOLINK, gyp success и ldd dynamic library.
Лог `/tmp/coffee-issue12-native-headers-build-20261014.log`.
Изолированный runtime probe: Node26.8.1/ABI147, librdkafka2.15.0, Producer=function;
image sha256:a6a81606a6f767afb453b0e264864d834f178385d721c536172b0b30f3307023.
После установления причины запущены отдельные patterns positive/private-eof/reauth;
старый FAIL сохранён. Cleanup отменённого собственного disposable PG fixture
записан в `/tmp/coffee-issue12-cancelled-fixture-cleanup-20261014.json`.

### Первые проверки исправленного среза

В `/tmp/coffee-issue12-fix-tests-20261014/` сохранены stdout и exit каждого target:
contract5/5, auth9/9, replay8/8, backpressure14/14, platform-config27/27,
nginx:check exit0, scoped harness36/36. Каждый exit0, FAIL0 и skip0.
Harness использует `TMPDIR=/home/yurgusev/.hermes/cache/scratch`;
прежний FAIL без этого prerequisite не удалён.

На текущем Dockerfile независимые browser positive и private-eof дали
1/1 PASS каждый, exit0/skip0, cleanupVerified=true. Соответственно:
- positive: `/home/yurgusev/.hermes/cache/scratch/issue12-owner-browser-oS20Py/transport/owner-browser-proof.json`,
  SHA256 d637f5ec08507e2356140aa94e4d492f6d300ff0e231fb4f6f2ac77c687b086c;
- private-eof: `/home/yurgusev/.hermes/cache/scratch/issue12-owner-browser-jxsIhd/transport/owner-browser-proof.json`.
Оба `launchProof=false`: это functional owner/browser proof, не capacity gate.
Итоговая готовность к merge ещё требует reauth, финальных checks/review и
нового полного operator-1 на замороженном финальном manifest. Предыдущий
operator-1 PASS остаётся историческим доказательством прежнего source snapshot.


### Новый browser re-auth FAIL — 14 октября 2026

Изолированный сценарий `reauth` на исправленном source завершился exit1,
0PASS/1FAIL/0skip. Native build, заголовки Node и ldd прошли; после natural
TTL/reconnect наблюдался actual owner GET200, но Playwright не дождался
видимого текста «Синхронизировано» за10s. Пока причина не установлена, A12-R3
и готовность к merge не подтверждены; deadline/acceptance не ослаблялись.

Сохранены stdout/exit:
`/tmp/coffee-issue12-fix-tests-20261014/11-preparation-owner-realtime-reauth.stdout`.
Receipt:
`/home/yurgusev/.hermes/cache/scratch/issue12-owner-browser-m6Tg5c/transport/result.json`,
statusFAIL, cleanupVerified=true, launchProof=false. Последующие owner/capacity
и итоговые checks ещё не запускались: tester остановлен на первом FAIL.


### Повторный owner peak100×10 FAIL — 14 октября2026

После browser-сценария отдельная DB-проверка (без параллельных тяжёлых builds)
дала97/100 completed и3failed (`response destroyed before completion`,
flows96/98/99). Все100Draft успешны;1373 полученных responses успешны, но это
не полный PASS1400. Отказов БД/lock не зарегистрировано; final pool0active,
4idle,0waiting,0pending; peak4active/95waiting/7pending. Request deadline5000ms,
transaction10000ms и physical max4 не изменялись. Некоторые PUT заняли
около4993ms, elapsed всего19703ms. Причина исследуется; прежние два PASS
не заменяют этот новый FAIL.

Receipt `/home/yurgusev/.hermes/cache/scratch/issue12-owner-peak-3478129.json`,
лог `/tmp/coffee-issue12-fix-tests-20261014/13-owner-live.stdout`.
TypeScript owner/preparation build перед командой прошёл exit0.
Runner был прерван после failing subtest и успел начать next disposable PG;
root проверил отсутствие процесса3478129 и удалил только его fixture
`coffee-catalog-3478129-edc3a244` с anonymous volume. Cleanup receipt:
`/tmp/coffee-issue12-db-cancelled-fixture-cleanup-20261014.json`.
На будущих прогонах stop-on-fail применяется между командами после штатного
finally всей test file, без SIGINT между её subtests. Production/user containers
не затронуты. Pool-concurrency, preparation capacity и финальныеchecks не запущены.


### Причина browser re-auth FAIL и локальное исправление cache

Owner GET после natural reconnect произошёл примерно через91s после B;
OrderStore fixture имеет maxSnapshotAgeMs60000. Принятый SQL0019
`orders.read_card_projection` заново оценивает InSync на DBtime и при stale
Observed возвращает OutOfSync без записи/увеличения projectionVersion.
Frontend acceptOrderCard отвергал изменение aroma.state при равной версии,
поэтому OrderCardPage показывал fatal protocol barrier после успешного GET200.
Полный body исторического FAIL не сохранялся; вывод подтверждён SQL/таймингом
и изменением response bytes1122→1125. Следующий live receipt обязан записать
безопасные semanticBCardBefore/lateCardAfter summaries и exact state.

Исправлен только frontend guard: равная версия принимает InSync→OutOfSync
(freshness expiry) и Converging→OutOfSync (lease expiry), если остальные
Card/AROMA fields совпадают, кроме уже допускаемого allowedActions. Reverse,
прочие state changes, blocker/business differences остаются fatal.
Existing order-cache regression был RED, затем GREEN4/4; fixtures используют
валидные Confirmed Cards и blockerobject. Runtime/SQL/Outbox/wire budgets не менялись.
Owner-browser reauth теперь ожидает ownerOutOfSync/UI«Есть расхождение», тот же
EventSource, causal authclose/freshEdge/ready/ownerGET, те жеbusiness/projection
versions и отсутствиеstoredCard/Outboxeffects. Это локальное исправление;
новый live PASS ещё не получен, прежний FAIL сохранён.

Sources: apps/web/src/browser/api/order-card.ts, apps/web/test/order-cache.test.ts,
tests/realtime/fixtures/owner-browser.mjs, docs/launch/17_ORDERS_IMPLEMENTATION_SPEC.md,
20_REALTIME_SSE_IMPLEMENTATION_SPEC.md и21_LAUNCH_VERIFICATION_SPEC.md.


### Astra: capacity acceptance остаётся заблокирована (A12-CAP-01/02)

Диагностические попытки с новым phase/event-loop receipt дали два PASS без
изменения owner/runtime/config:3493666 —100/100 и1400responses за11738ms,
максимальныйphase690ms;3499387 —100/100 и1400responses за24840ms,
максимальнаякомандаPUT4869.117ms приdeadline5000, phasesprecheck/getCard/put
2522/2768/2805ms, eventloopmax28.656ms. Второй PASS сохраняетdurable100Orders,
1000items,1200history,100contributions/1000lines,100Outbox и1200idempotency.
Ни один не объясняет historicalFAIL97/100. ВнешнийPTY/stream capturebackpressure
опровергнут: всеNodecommands с самогостарта писалиstdout/stderr вобычныйфайл.
Hostsampler второйпопытки не перекрывал workload; I/O причиной не установлен.

Astra review A12-CAP-01(P1): необъяснённый97/100 остаётся нарушением обязательного
capacity criterion. A12-CAP-02(P2): helper записывалcommand только после успешного
inject и терялtiming/ordinal отказавшихcommands; phasesнебылиcorrelated.
Назначена только test-side диагностика: finally outcomes для rejectedinject,
correlation/phase intervals, времядоacquiredlease, physicalcheckout, leaseheld,
boundedSQL/COMMIT timing classes безSQLtext/values/secrets. Runtimeoptimizations,
повышениеdeadlines иSQLretry не выполнялись. Финальнаяreadyклассификацияожидает
объясненияfailure иполнойприёмкипослеобоснованногоисправления.

Artifacts: /home/yurgusev/.hermes/cache/scratch/issue12-owner-peak-3499387.json;
/tmp/coffee-issue12-fix-tests-20261014/15-owner-peak-diagnostic2.stdout;
/tmp/coffee-issue12-fix-tests-20261014/15-host-vmstat.stdout (невалидныйsampler).


### Полный read-time guard owner GET и PostgreSQL proof — 14 октября 2026

Astra A12-CACHE-01 подтвердил, что двух expiry-переходов недостаточно.
Принятый SQL0019 также возвращает `Converging` после нового lease и вычисляет
`UnknownOutcome` по reservation до асинхронной записи публичной проекции.
Recovery может снять это перекрытие при прежней projectionVersion.

Guard теперь различает текущий валидированный `owner-get` и исторический
`command`/replay. Только owner GET для Confirmed Card может принять четыре
lease/freshness перехода и точное перекрытие `UnknownOutcome` с единственным
`AROMA_UNKNOWN_OUTCOME`, включая его снятие в предусмотренные состояния.
Бизнес-поля, AROMA revisions и lastObservedAt обязаны совпадать. Восстановление
InSync при равной версии, произвольная смена blockers и изменения бизнес-фактов
остаются ошибкой. Исторический response не снимает перекрытие.

Изменены order-card.ts и один GET caller remote.ts; существующий cache regression
прошёл4/4 после RED. Настоящие PostgreSQL проверки в существующем preparation
fixture прошли13/13, exit0, без skips: takeover с новым fence, истечение lease,
вход в UnknownOutcome и recovery сохраняют stored Card/projectionVersion/Outbox.
Команда19 и её лог сохранены в /tmp/coffee-issue12-fix-tests-20261014/.
Новый native reauth proof ещё выполняется; unit/SQL PASS его не заменяет.

Диагностика17 также впервые дала полное измерение:100/100 и1400responses за
11819.698ms;3200 correlated Store phases/leases,35200 SQL records/3200 COMMIT.
Ожидание до acquisition max829.173ms (включая owner prelude/FIFO/checkout),
физический Pool.connect max66.614ms, lease-held max127.061ms,
put COMMIT max106.489ms, event-loop max38.011ms. Receipt:
/home/yurgusev/.hermes/cache/scratch/issue12-owner-peak-3535820.json.
Хостовый vmstat sampler охватывает весь прогон; сильного I/O/swap pressure
в этой успешной попытке нет. Исторический97/100 остаётся необъяснённым.
Предыдущая попытка16 завершила100/100, но не дала DB breakdown из-за потери
ALS контекста Fastify; она не классифицируется как диагностический PASS.
Привязка исправлена через реальные correlationId аргументы Store, обязательный
coverage guard запрещает успешную диагностику с нулевыми наблюдениями.


### Native browser re-auth и полный DB прогон — 14 октября 2026

Новый natural re-auth proof прошёл 1/1, exit 0; Astra закрыл A12-R3.
Actor TTL 60000 мс, auth-check 30000 мс, browser session 900000 мс.
Один native EventSource: открытия 1→2, ready 1→2; auth-close 0→1.
В re-auth окне два /events запроса, reconnect 200 с Last-Event-ID события B;
owner GET после второго ready: reads 4→5, business version 2/PV6 сохраняются,
InSync→OutOfSync принят UI. Stored Card и Outbox неизменны.
Recovery 90793.349 мс; 38 compiled/209 source hashes совпадают; cleanup true.
Последующий третий /events 503 относится к отдельному controlled restart.
Это functional proof, launchProof=false; production и throughput он не доказывает.

Proof: /home/yurgusev/.hermes/cache/scratch/issue12-owner-browser-KZEyzH/transport/owner-browser-proof.json
SHA-256: 1bfa94e0bdb2c08176f63c631dcdedcb5aa2b1874cdc0d446e3f45dc004d63a3.
Команда20/лог: /tmp/coffee-issue12-fix-tests-20261014/20-owner-browser-reauth.stdout.

Полный owner-live на том же owner коде прошёл 5/5 без skips (команда23).
100×10: 100/100 потоков, 1400 успешных HTTP commands, 11883 мс,
3200 correlated phases/leases, 35200 SQL observations/3200 COMMIT;
pool max active4/wait95, финальная очередь пуста. Receipt3611721.
Default pool —1/1 PASS: третий checkout отказал без wait queue (команда24).
Preparation capacity —2/2 PASS (команда25): 100 contributions×10 lines
828.107 мс; 100×100 lines 1940.916 мс при лимите2000 (запас59.084 мс).
Исторический FAIL97/100 не стирается этими PASS: причина конкретного
замедления не установлена. Измеренная амплификация очереди (три checkout
на PUT) требует отдельного исправления/приёмки; A12-CAP-01 ещё открыт.
Коммита, публикации и обращений к production/provider не выполнялось.


### PUT preflight и свежая приёмка 100×10 — 14 октября 2026

Уменьшена измеренная амплификация очереди пула: PUT объединяет idempotency
precheck и прежнее полное валидированное чтение Card в `preflightPut`.
Общий private `readPrecheck` не меняет replay/conflict/in-progress; Card reader,
FOR SHARE и validation сохранены. Pricing вызывается после завершения read-only
транзакции/release, а `putItem` сохраняет отдельные idempotency/version checks и
атомарные effects. Pool4/FIFO100, request5000ms/checkout250ms не повышались;
SQL retry и новые dependencies/schema/public API не добавлялись.

Узкие owner-http/public-api unit27/27 и build прошли. Реальный OrderStore/fault
suite26b —5/5 PASS без skips: preflight при stale-version race, same-key PUT,
заранее aborted signal и настоящий blackhole COMMIT сохраняют безопасные
результаты. Unknown preflight COMMIT не маскируется как lookup-unavailable,
Pricing не вызывается; lease освобождён, pending drained после close.
Предыдущий26FAIL сохранён: assertion ошибочно проверял pending до завершения
native promise после destroy; исправлен только момент проверки teardown.

Полный owner-live27b —5/5 PASS, exit0, без skips. Peak receipt:
/home/yurgusev/.hermes/cache/scratch/issue12-owner-peak-3664947.json.
100/100 заказов×10 позиций,1400/1400 ответов,callerRetries0;
10874.132ms,9.196orders/s (это весь сценарий synthetic owner boundary).
2200 correlated phases/leases/COMMIT и30200 SQL observations:
ровно1000 транзакций и5000 SQL statements меньше прежнего профиля.
Durable counts:100Orders/1000items/1200history/100contributions/
1000contributionlines/100Outbox/1200Idempotency.
Pool active max4/wait max95, final active0/idle4/wait0/saturation0/pending0.
Event-loop p95=12.861ms,max32.670ms.

Предыдущий27 дал peak PASS, но полный suite4/5FAIL: current application
обращался к отсутствующему preflightPut у исторического pre-#11 Store.
Исправлен только локальный fixture bridge (старые precheck→getCard), все
historical writers/hashes/snapshot bytes/exact-bodyless replay сохранены;
production fallback не добавлен. 27FAIL не переписан вPASS.
Причина исторического замедления97/100 не установлена; новый bounded change
устраняет измеренные лишние checkout, а не доказывает конкретную I/O причину.
Общие checks, свежие native browser proofs и final operator-1 ещё в работе.
Никаких commit/push/PR/issue mutations/provider/production действий нет.


### Astra: bounded preflight приёмка закрыта — 14 октября 2026

По готовому diff и реальным26b/27b Astra закрыл A12-PREFLIGHT-TEST-01,
A12-CAP-02 и A12-CAP-01 в заявленном synthetic owner scope. Свежий peak
имеет max command1087.11ms при deadline5000ms; data/replay/error/terminal
handling и исторический fixture проверены. Причина historical97/100 не
установлена, evidence сохранён; закрытие основано на уменьшении измеренной
работы и новой приёмке. Общая готовность #12 требует оставшихся checks,
трёх native functional proofs и новой30min operator-1 приёмки.

28pnpmcheck остановился на двух lint warnings (unused eventData import после
R1fix, uselessSetspreaddiagnosticcleanup). Удалены только unused import и
копированиеSet; узкий oxlint прошёл. Прежний28FAIL сохранён,28b повторяется.
Это не новые runtime/бюджет/API изменения и не основание публиковать ветку.


### Итоговый frozen manifest и разрешение — 14 октября 2026

Текущий pnpmcheck28b PASS:828total/752PASS/0FAIL/76explicit-only skips.
Отдельный web-realtime29 PASS:Vitest8/8/Chromium10/10. Fixture-check30 PASS,
cleanupVerifiedtrue/errornull; scope transport fixture, launchProof=false.
GitHubdevelop повторно проверен:91675aaa56900613505bfbd8cd14981b07cec000,
совпадает с baseCommit/HEAD. Acceptedinputs7 hash/ancestry проверены.

Prepare31 завершён, status prepared-not-launch-proof, exit0:
/home/yurgusev/.hermes/cache/scratch/issue12-operator1-final-20261014/profile-manifest.json
SHA256 eee77607ad3ec1140e71ba78ceba3f04e586b580110d1863e57c9a158299d4b2.
Root verifyPrepared подтвердил38compiled/209source/14supporting hashes иimageIDs.
Profilefull/operator-1:1subscriber,100metadata invalidations/s,100subjects,
1800000ms. ActorTTL60s/authSweep30s/session900000ms не повышались;
nginx/realtime2CPU/512MiB, realtimeFD12288,technicalmax512 сохранены.
Node26.8.1/ABI147/nativeProducer/librdkafka2.15.0 из canonical recipe.

Владелец явно разрешил финальный30minrun на этом точном SHA.
Это разрешение на локальный изолированный transport proof; commit/push/PR/
publish/provider/production по-прежнему не разрешены. Перед fullrun должны
завершиться свежие32positive/33private-eof/34reauth без параллельной нагрузки.
Prepare/разрешение не являются runtime PASS; финальные receipts ожидаются.


### Итоговые native browser proofs32–34 — 14 октября 2026

Все три explicit live targets прошли по1/1 без skips, exit0; cleanupVerifiedtrue,
errornull, launchProof=false. Astra перепроверил SHA/joins/fault injection и
подтвердил отсутствие falsePASS; A12-R3 закрыт на итоговом коде.

32positive: /home/yurgusev/.hermes/cache/scratch/issue12-owner-browser-LzL85n/transport/owner-browser-proof.json
SHA2564fc6849222a5d32e840b8e63470cf1ada009fbc7fbc7656d27465a9ce0373ec3.
Real owner Outbox→nativeKafka→SSE A/B→ownerGET; businessversion2,
projection4→5→6,OutOfSync→OutOfSync→InSync. Duplicate/stale ACK/replay,
restart/reset проверены. Один EventSource;38compiled/209source unchanged.

33private-eof: /home/yurgusev/.hermes/cache/scratch/issue12-owner-browser-0bpRMB/transport/owner-browser-proof.json
SHA2560b4465e939f2076bae76d22d704d73bf0d1d235107db882098e2c451fc2a6771.
Negative fixture намеренно удаляет один байт B в private compiled snapshot:
Last-Event-ID остаётсяA, reconnect доставляетB доready, затемownerGET.
Только compiled runtime-composition.js отличается;209source unchanged,
production fallback/source edits не выполнялись. noExtraMutation подтверждён.

34reauth: /home/yurgusev/.hermes/cache/scratch/issue12-owner-browser-xnoEv5/transport/owner-browser-proof.json
SHA256dda52e9f25ce01a62baea744d05aaba9886ae3c0e3db7649856890ad335d0441.
ActorTTL60000/authCheck30000/session900000ms. Authclose0→1; одинnative
EventSource;ready1→2;два/ events requests/responses200 сLast-Event-ID B;
owner reads4→5 послеready; recovery90788.671ms. Текущий GET вернул
InSync→OutOfSync при businessv2/PV6; UI принялread-time state. StoredCard и
Outbox неизменны;38compiled/209source unchanged. Третий503 относится к
последующему controlledrestart, не к успешному re-auth окну.

В каждом proof SSE содержит только пять разрешённых metadata fields;
добавочных бизнес-мутаций нет. Functional scope не подменяет full30mintransport,
owner100×10, VK/LLM/provider/production или launch#13. Разрешённый35operator-1
запущен на frozenSHAeee77607...d4b2; его итог ещё не получен.


## Итог локальной приёмки issue #12 — 14 октября 2026

**Техническая реализация локально готова к PR в develop.** Все найденные
существенные дефекты исправлены; обязательные scoped proofs и общий check
прошли. Astra принял итоговый код и свежие owner/browser/transport receipts.
GitHub commit/push/PR/issue/status mutation/merge/deployment не выполнялись.
Это pre-commit local draft, не accepted merge и не публикация в main.

### Исправления и проверка

- R1: equal-ownerVersion сравнивается по payload, transport correlation не
  создаёт ложный quarantine. Повтор messageId по-прежнему проверяет envelope.
- R2: schema/decoder/direct nginx renderer запрещают admission выше512;
  realtime RSS выше512MiB и FD выше12288 также отвергаются.
- Native build использует headers exact pinned Node image через
  `--nodedir=/usr/local`, без сетевого скачивания headers Node26.8.1.
- Owner GET cache принимает только разрешённые read-time AROMA transitions
  при прежней projectionVersion и неизменных business facts/revisions.
  Исторический command/replay response не снимает UnknownOutcome overlay.
- PUT `preflightPut` сокращает checkout с трёх до двух: idempotency/full Card
  read вместе, Pricing после commit/release, атомарная запись отдельно.
  Дедлайны/лимиты/validation/idempotency/unknown COMMIT сохраняются.

Owner100×10 —100/100 заказов,1000позиций,1400/1400ответов без отказов/retry;
10.874s (~9.196orders/s), maxcommand1087.114ms приdeadline5000ms.
2200leases/30200SQL/2200COMMIT вместо3200/35200/3200; durablecounts exact,
pool active0/idle4/waiting0/saturation0/pending0. Fullowner27b5/5 и
OrderStore/fault26b5/5 без skips. Preparation100×10=828.107ms,
100×100=1940.916ms при лимите2000;defaultpoolfailfast24—1/1.
Nativepositive/private-eof/reauth32–34—по1/1; realtimeweb29—Vitest8/8 и
Chromium10/10. pnpmcheck28b—828total,752PASS,0FAIL,76explicit-only skips.
Skipped tests не считаются live PASS; требуемые scoped targets исполнены отдельно.

### Финальный operator-1

Утверждённый frozen manifest:
`/home/yurgusev/.hermes/cache/scratch/issue12-operator1-final-20261014/profile-manifest.json`
SHA256 `eee77607ad3ec1140e71ba78ceba3f04e586b580110d1863e57c9a158299d4b2`.
Result: `/home/yurgusev/.hermes/cache/scratch/issue12-operator1-final-20261014/result.json`
SHA256 `850456422b158b0560d15114afdfed7240003497cfeb4ed9c0fe567d8e381fe3`.

Full35 PASS/exit0/launchProoftrue/errornull, all11checks true;
measurement1800010.3ms,180002scheduled=ACK,pending0,1subscriber/100subjects.
Eventp95=306ms,max3257ms;eventloopp95=26.755ms;
headroom14408samples,max179.341ms<=1000.
512live connections подтверждены отдельно;513-е503доSSEheaders.
19expectedreauth,0unexpected,maxgap3038ms,3OIDCsessionrefreshes;
rawminLive0/maxLive1 сохраняются (штатный reconnect не скрывается).
HUP124.706ms/live1→1;loadedSIGTERM343.702ms/exit0/noOOM/noforcedclose.
Driverclientcleanup5431.295ms и coordinatorfixturecleanup3278.657ms,
оба в пределах10s;8containers/network/private material удалены.
313hostsamples: nginxRSSmax98930688bytes/FD819;
realtimeRSSmax198619136bytes/FD480;
driverRSSmax264249344bytes/FD327.
Cgroupbudgets сохранены, recordedOOM/oomkill0.

Rawdriver-result имеет FAIL/errornull/missing=[budgets,fixturecleanup]:
эти проверки принадлежат coordinator; итоговый result обоснованноPASS после
host/cleanup checks. Raw receipt не переписан. ACK bins:46из первых1800
ниже100,47с неполным последнимbin; schedule/totalACK PASS не гарантирует
100ACK каждую wall-clock секунду. 97heartbeat frames получены, строгий
верхний bound каждого heartbeat interval отдельно не проверяется.

### Что остаётся до внешнего merge и main

В issue66checkbox-строк:61техническая строка подтверждена локально,
5процессных строк остаются pending. Разрешённый scope завершён без внешних
записей. После отдельного разрешения потребуются русский commit, один PR
с Closes#12 вdevelop, GitHubCI/review/merge и публикация acceptedhandoff/
статуса issue; только acceptedmerge разблокирует successor#13.
Для первой волны вmain отдельно нужны observability#64 и launch/release#13.

VK/Agent/LLM, realprovider, production и whole-fleet/public-ingress capacity
не проверены. 100metadata invalidations/s не100orders/s. Native transport
proof не заменяет owner capacity; browser proof не заменяет30minsoak.
Причина исторического97/100 неизвестна; старые FAIL5000/owner/browser/
fixture/lint/diagnostic остаются в предыдущих разделах. Текущий owner PASS
основан на проверенном уменьшении queue amplification и новой приёмке.
Полный аудит внутренних native librdkafka locks не выполнялся.

### Итог каждой checkbox-строки (remote checklist не изменён)

Нумерация и формулировки соответствуют live issue snapshot; прошлые отметки
[x]/[ ] сохранены. Процессные строки не отмечаются выполненными без PR/merge.
Исторические ссылки на код приведены без номера строки, чтобы не выдавать
старые line offsets за актуальные. Полный первоначальный разбор расположен выше.

| № | Отметка GitHub | Требование | Итог | Код/доказательство |
|---|---|---|---|---|
| 1 | [x] | Предшественники: baseline #3; прямые inputs: #8, #9, #11 и #63 merged в `develop`. | Подтверждено | [evidence/handoffs/issue-12.yaml](/home/yurgusev/CoffeeOrderPlatform/evidence/handoffs/issue-12.yaml) |
| 2 | [x] | Вход: `RealtimeInvalidated.v1`, trusted actor context, Order detail query identity #9 и owner GET #8/#11. | Подтверждено | [config/platform.yaml](/home/yurgusev/CoffeeOrderPlatform/config/platform.yaml); [apps/realtime-gateway/src/runtime-composition.ts](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/runtime-composition.ts); [apps/web/src/browser/api/order-card.ts](/home/yurgusev/CoffeeOrderPlatform/apps/web/src/browser/api/order-card.ts) |
| 3 | [ ] | Выход: Kafka→bounded SSE→TanStack Query invalidation/refetch, recovery/capacity evidence и `evidence/handoffs/issue-12.yaml`. | Подтверждено | [evidence/handoffs/issue-12.yaml](/home/yurgusev/CoffeeOrderPlatform/evidence/handoffs/issue-12.yaml) |
| 4 | [ ] | Разблокирует: #13. | Процесс: pending | [Live issue #12](https://github.com/YurGusev/CoffeeOrderPlatform/issues/12) |
| 5 | [x] | Принять merged handoff #119 до реализации уточнённого frontend/recovery scope; остальные prerequisites этой задачи сохраняются. | Подтверждено | [evidence/handoffs/issue-12.yaml](/home/yurgusev/CoffeeOrderPlatform/evidence/handoffs/issue-12.yaml) |
| 6 | [x] | Realtime не имеет DB/business state; только invalidation/reset/refetch, authorization и bounded buffers по owning specification. | Подтверждено | [apps/realtime-gateway/src/hub.ts](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/hub.ts); [apps/realtime-gateway/src/runtime-composition.ts](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/runtime-composition.ts); [apps/realtime-gateway/src/runtime-composition.ts](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/runtime-composition.ts); [tests/realtime/contract.test.mjs](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/contract.test.mjs); [tests/realtime/replay.test.mjs](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/replay.test.mjs) |
| 7 | [x] | Создать `apps/realtime-gateway`; БД, business cache и owner HTTP client отсутствуют. | Подтверждено | [apps/realtime-gateway/package.json](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/package.json); [apps/realtime-gateway/src/runtime-composition.ts](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/runtime-composition.ts); [config/platform.yaml](/home/yurgusev/CoffeeOrderPlatform/config/platform.yaml); [tests/realtime/auth.test.mjs](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/auth.test.mjs) |
| 8 | [x] | Первый запуск использует ровно один экземпляр `realtime-gateway` и fixed group `realtime-gateway-v1`; consumer читает только topic `coffee.realtime.invalidate.v1`, key subjectRef, auto topic creation/auto commit запрещены. Multi-replica fanout требует отдельного issue и не входит в launch-v1. | Подтверждено | [config/platform.yaml](/home/yurgusev/CoffeeOrderPlatform/config/platform.yaml); [apps/realtime-gateway/src/contract.ts](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/contract.ts); [apps/realtime-gateway/src/runtime-composition.ts](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/runtime-composition.ts); [tests/realtime/auth.test.mjs](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/auth.test.mjs); [tests/kafka/runtime.test.mjs](/home/yurgusev/CoffeeOrderPlatform/tests/kafka/runtime.test.mjs) |
| 9 | [x] | Schema validate до fanout; first launch принимает только `subjectType=order`. | Подтверждено | [apps/realtime-gateway/src/contract.ts](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/contract.ts); [apps/realtime-gateway/src/contract.ts](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/contract.ts); [tests/realtime/contract.test.mjs](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/contract.test.mjs); [tests/realtime/contract.test.mjs](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/contract.test.mjs) |
| 10 | [x] | Duplicate messageId — no-op; lower/equal ownerVersion одного subject не fanout; equal version с другим payload — quarantine. | Подтверждено | [apps/realtime-gateway/src/hub.ts](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/hub.ts); [tests/realtime/contract.test.mjs](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/contract.test.mjs) |
| 11 | [x] | Unknown schema/type и event >2KiB — quarantine/DLQ, без SSE. | Подтверждено | [apps/realtime-gateway/src/contract.ts](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/contract.ts); [packages/platform-kafka-runtime/src/index.ts](/home/yurgusev/CoffeeOrderPlatform/packages/platform-kafka-runtime/src/index.ts); [tests/realtime/contract.test.mjs](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/contract.test.mjs); [tests/realtime/contract.test.mjs](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/contract.test.mjs) |
| 12 | [x] | Offset commit после ring buffer/fanout enqueue. Crash допускает gap, который закрывает reset/refetch, а не realtime DB. | Подтверждено | [packages/platform-kafka-runtime/src/index.ts](/home/yurgusev/CoffeeOrderPlatform/packages/platform-kafka-runtime/src/index.ts); [packages/platform-kafka-runtime/src/index.ts](/home/yurgusev/CoffeeOrderPlatform/packages/platform-kafka-runtime/src/index.ts); [apps/realtime-gateway/src/hub.ts](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/hub.ts); [tests/kafka/runtime.test.mjs](/home/yurgusev/CoffeeOrderPlatform/tests/kafka/runtime.test.mjs); [tests/realtime/auth.test.mjs](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/auth.test.mjs) |
| 13 | [x] | Public route существует только через nginx #162; direct realtime-gateway port private. | Подтверждено | [config/platform.yaml](/home/yurgusev/CoffeeOrderPlatform/config/platform.yaml); [tools/nginx/generate.mjs](/home/yurgusev/CoffeeOrderPlatform/tools/nginx/generate.mjs); [tests/nginx/cutover.test.mjs](/home/yurgusev/CoffeeOrderPlatform/tests/nginx/cutover.test.mjs) |
| 14 | [x] | Private Edge-авторизатор #160 проверяет session/JWT и подписывает actor context с `aud=realtime-gateway`; nginx #162 удаляет client actor headers и передаёт только trusted assertion. | Подтверждено | [packages/platform-runtime/src/index.ts](/home/yurgusev/CoffeeOrderPlatform/packages/platform-runtime/src/index.ts); [apps/realtime-gateway/src/runtime-composition.ts](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/runtime-composition.ts); [packages/platform-security/src/index.ts](/home/yurgusev/CoffeeOrderPlatform/packages/platform-security/src/index.ts); [tests/realtime/auth.test.mjs](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/auth.test.mjs) |
| 15 | [x] | Gateway требует server permission `orders:read:any`; 401/403 возвращаются RFC 9457 до SSE headers. | Подтверждено | [apps/realtime-gateway/src/runtime-composition.ts](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/runtime-composition.ts); [apps/realtime-gateway/src/runtime-composition.ts](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/runtime-composition.ts); [tests/realtime/auth.test.mjs](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/auth.test.mjs) |
| 16 | [x] | Endpoint не принимает query/body actorRef, permission, subject/order filters. Клиент не выбирает доступные subjects. | Подтверждено | [apps/realtime-gateway/src/runtime-composition.ts](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/runtime-composition.ts); [tests/realtime/auth.test.mjs](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/auth.test.mjs) |
| 17 | [ ] | Каждые 30s проверять expiry actor context; expired stream закрывается, reconnect повторно авторизуется через edge. | Подтверждено | [apps/realtime-gateway/src/hub.ts](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/hub.ts); [config/platform.yaml](/home/yurgusev/CoffeeOrderPlatform/config/platform.yaml); [apps/realtime-gateway/src/runtime-composition.ts](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/runtime-composition.ts); [tests/realtime/auth.test.mjs](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/auth.test.mjs) |
| 18 | [x] | Response headers строго: `text/event-stream; charset=utf-8`, `no-cache, no-transform`, keep-alive, `X-Accel-Buffering:no`. | Подтверждено | [apps/realtime-gateway/src/runtime-composition.ts](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/runtime-composition.ts); [tests/realtime/auth.test.mjs](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/auth.test.mjs) |
| 19 | [x] | `resource-invalidated.v1`: id=Kafka messageId; retry=3000; data только `subjectType`, `subjectRef`, decimal `ownerVersion`, `reason`, `correlationId`. | Подтверждено | [apps/realtime-gateway/src/contract.ts](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/contract.ts); [tests/realtime/contract.test.mjs](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/contract.test.mjs); [tests/realtime/auth.test.mjs](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/auth.test.mjs) |
| 20 | [x] | Customer/items/money/Desired/Observed/blockers/allowedActions/provider data запрещены schema и negative fixtures. | Подтверждено | [apps/realtime-gateway/src/contract.ts](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/contract.ts); [apps/realtime-gateway/src/contract.ts](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/contract.ts); [tests/realtime/contract.test.mjs](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/contract.test.mjs); [tests/realtime/contract.test.mjs](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/contract.test.mjs) |
| 21 | [x] | После auth, replay/reset и установки live delivery отправить `stream-ready.v1` без id; heartbeat каждые 15s как SSE comment. | Подтверждено | [apps/realtime-gateway/src/hub.ts](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/hub.ts); [config/platform.yaml](/home/yurgusev/CoffeeOrderPlatform/config/platform.yaml); [config/platform.yaml](/home/yurgusev/CoffeeOrderPlatform/config/platform.yaml); [tests/realtime/replay.test.mjs](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/replay.test.mjs); [tests/realtime/backpressure.test.mjs](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/backpressure.test.mjs) |
| 22 | [x] | `stream-reset.v1` без id содержит только `reason=REPLAY_UNAVAILABLE`. | Подтверждено | [apps/realtime-gateway/src/hub.ts](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/hub.ts); [tests/realtime/replay.test.mjs](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/replay.test.mjs); [tests/realtime/backpressure.test.mjs](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/backpressure.test.mjs) |
| 23 | [x] | Instance ring buffer: максимум 10 000 invalidations или 5 минут, первый достигнутый лимит; business state отсутствует. | Подтверждено | [apps/realtime-gateway/src/hub.ts](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/hub.ts); [apps/realtime-gateway/src/hub.ts](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/hub.ts); [config/platform.yaml](/home/yurgusev/CoffeeOrderPlatform/config/platform.yaml); [tests/realtime/replay.test.mjs](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/replay.test.mjs) |
| 24 | [x] | Header отсутствует → установить live delivery → ready; ID найден → replay subsequent/local ordered events → установить live delivery → ready → live frames. | Подтверждено | [apps/realtime-gateway/src/hub.ts](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/hub.ts); [apps/realtime-gateway/src/hub.ts](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/hub.ts); [apps/realtime-gateway/src/hub.ts](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/hub.ts); [tests/realtime/replay.test.mjs](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/replay.test.mjs); [tests/realtime/replay.test.mjs](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/replay.test.mjs) |
| 25 | [x] | Malformed/not found/evicted/restart/другая replica → stream-reset → установить live delivery → ready → live frames. | Подтверждено | [apps/realtime-gateway/src/hub.ts](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/hub.ts); [apps/realtime-gateway/src/hub.ts](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/hub.ts); [tests/realtime/replay.test.mjs](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/replay.test.mjs); [tests/realtime/replay.test.mjs](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/replay.test.mjs) |
| 26 | [x] | Query `lastEventId` запрещён; persistent replay DB/sticky session не добавлять. | Подтверждено | [apps/realtime-gateway/src/runtime-composition.ts](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/runtime-composition.ts); [tests/realtime/auth.test.mjs](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/auth.test.mjs) |
| 27 | [x] | Replay является оптимизацией; безопасный результат всегда достигается owner refetch. | Подтверждено | [apps/realtime-gateway/src/hub.ts](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/hub.ts); [apps/realtime-gateway/src/contract.ts](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/contract.ts); [tests/realtime/replay.test.mjs](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/replay.test.mjs); [tests/realtime/contract.test.mjs](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/contract.test.mjs) |
| 28 | [ ] | Материализовать fixed group `realtime-gateway-v1` и согласовать config/platform.yaml/schema с профилем `operator-1`: technical admission 512, nginx/realtime по 2 CPU и 512 MiB; существующие queue/ring/FD/TTL/security ограничения не повышать. Удалить неиспользуемый executable isolated-5000/full-memory override без удаления исторических evidence; доказать новый soak. | Подтверждено | [config/platform.yaml](/home/yurgusev/CoffeeOrderPlatform/config/platform.yaml); [config/nginx-profile.schema.json](/home/yurgusev/CoffeeOrderPlatform/config/nginx-profile.schema.json); [config/platform.schema.json](/home/yurgusev/CoffeeOrderPlatform/config/platform.schema.json) |
| 29 | [ ] | Технический максимум 512 connections на instance и публичном nginx; 513-й получает `503 REALTIME_CAPACITY_EXCEEDED` до SSE headers. Это защитный ceiling существующего reference-профиля, не модель покупателей: штатно работает одна вкладка оператора. Согласовать gateway concurrency/maxConnections, nginx admission, schema и owning specification. | Подтверждено | [tools/nginx/generate.mjs](/home/yurgusev/CoffeeOrderPlatform/tools/nginx/generate.mjs); [tests/config/platform-config.test.mjs](/home/yurgusev/CoffeeOrderPlatform/tests/config/platform-config.test.mjs) |
| 30 | [x] | Queue одного connection: максимум 64 records или 256KiB serialized. | Подтверждено | [apps/realtime-gateway/src/hub.ts](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/hub.ts); [config/platform.yaml](/home/yurgusev/CoffeeOrderPlatform/config/platform.yaml); [tests/realtime/backpressure.test.mjs](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/backpressure.test.mjs); [tests/realtime/backpressure.test.mjs](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/backpressure.test.mjs) |
| 31 | [x] | Socket write deadline 5s; heartbeat 15s; nginx idle timeout минимум 45s. | Подтверждено | [config/platform.yaml](/home/yurgusev/CoffeeOrderPlatform/config/platform.yaml); [apps/realtime-gateway/src/hub.ts](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/hub.ts); [apps/realtime-gateway/src/hub.ts](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/hub.ts); [tests/realtime/backpressure.test.mjs](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/backpressure.test.mjs); [tests/realtime/backpressure.test.mjs](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/backpressure.test.mjs) |
| 32 | [x] | Coalesce одного subject в окне 250ms: оставить наибольшую ownerVersion/message id выбранного event. | Подтверждено | [apps/realtime-gateway/src/hub.ts](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/hub.ts); [config/platform.yaml](/home/yurgusev/CoffeeOrderPlatform/config/platform.yaml); [tests/realtime/replay.test.mjs](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/replay.test.mjs) |
| 33 | [x] | Overflow/write timeout/socket abort немедленно удаляет connection, queue, listeners и timers; медленный client не блокирует consumer/других. | Подтверждено | [apps/realtime-gateway/src/hub.ts](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/hub.ts); [apps/realtime-gateway/src/hub.ts](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/hub.ts); [apps/realtime-gateway/src/hub.ts](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/hub.ts); [tests/realtime/backpressure.test.mjs](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/backpressure.test.mjs); [tests/realtime/backpressure.test.mjs](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/backpressure.test.mjs); [tests/realtime/backpressure.test.mjs](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/backpressure.test.mjs) |
| 34 | [ ] | Graceful shutdown 20s: stop accept, stream-reset, close sockets, затем consumer. | Подтверждено | [apps/realtime-gateway/src/runtime-composition.ts](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/runtime-composition.ts); [apps/realtime-gateway/src/runtime-composition.ts](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/runtime-composition.ts); [packages/platform-runtime/src/index.ts](/home/yurgusev/CoffeeOrderPlatform/packages/platform-runtime/src/index.ts); [tests/realtime/auth.test.mjs](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/auth.test.mjs); [tests/realtime/backpressure.test.mjs](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/backpressure.test.mjs); [tests/runtime/lifecycle.test.mjs](/home/yurgusev/CoffeeOrderPlatform/tests/runtime/lifecycle.test.mjs) |
| 35 | [x] | Создать `apps/web/src/realtime/order-invalidations.ts`: один same-origin EventSource на tab, session cookie через edge; ручных auth/actor headers нет. | Подтверждено | [apps/web/src/browser/app/OrderRealtime.tsx](/home/yurgusev/CoffeeOrderPlatform/apps/web/src/browser/app/OrderRealtime.tsx); [apps/web/src/browser/app/OrderRealtime.tsx](/home/yurgusev/CoffeeOrderPlatform/apps/web/src/browser/app/OrderRealtime.tsx); [apps/web/src/browser/app/session.tsx](/home/yurgusev/CoffeeOrderPlatform/apps/web/src/browser/app/session.tsx); [apps/web/test/operator-flow.spec.ts](/home/yurgusev/CoffeeOrderPlatform/apps/web/test/operator-flow.spec.ts) |
| 36 | [x] | Runtime validate каждый frame; принять только valid order ref/version. | Подтверждено | [apps/web/src/realtime/order-invalidations.ts](/home/yurgusev/CoffeeOrderPlatform/apps/web/src/realtime/order-invalidations.ts); [apps/web/test/realtime.test.ts](/home/yurgusev/CoffeeOrderPlatform/apps/web/test/realtime.test.ts); [apps/web/test/operator-flow.spec.ts](/home/yurgusev/CoffeeOrderPlatform/apps/web/test/operator-flow.spec.ts) |
| 37 | [x] | `resource-invalidated`: exact invalidation/refetch TanStack Query Order detail по `subjectRef`; SSE data никогда не записывать в TanStack Query cache. | Подтверждено | [apps/web/src/realtime/order-invalidations.ts](/home/yurgusev/CoffeeOrderPlatform/apps/web/src/realtime/order-invalidations.ts); [apps/web/src/realtime/order-invalidations.ts](/home/yurgusev/CoffeeOrderPlatform/apps/web/src/realtime/order-invalidations.ts); [apps/web/test/realtime.test.ts](/home/yurgusev/CoffeeOrderPlatform/apps/web/test/realtime.test.ts); [apps/web/test/operator-flow.spec.ts](/home/yurgusev/CoffeeOrderPlatform/apps/web/test/operator-flow.spec.ts) |
| 38 | [x] | Cached `OrderCard.projectionVersion >= ownerVersion` допускает duplicate skip; меньшая версия не откатывает UI, equal version с другим payload quarantined, новая/unknown/gap версия запускает owner GET; response принимается через общий monotonic projectionVersion guard #9. | Подтверждено | [apps/web/src/realtime/order-invalidations.ts](/home/yurgusev/CoffeeOrderPlatform/apps/web/src/realtime/order-invalidations.ts); [apps/web/src/browser/api/order-card.ts](/home/yurgusev/CoffeeOrderPlatform/apps/web/src/browser/api/order-card.ts); [apps/web/src/browser/api/remote.ts](/home/yurgusev/CoffeeOrderPlatform/apps/web/src/browser/api/remote.ts); [apps/web/test/operator-flow.spec.ts](/home/yurgusev/CoffeeOrderPlatform/apps/web/test/operator-flow.spec.ts) |
| 39 | [x] | `stream-reset`: invalidates все уже materialized Order-detail query keys и refetches только active; Customer/Catalog/Pricing queries не затрагиваются. Используется существующий prefix #9, новый namespace или второй QueryClient не вводится. | Подтверждено | [apps/web/src/realtime/order-invalidations.ts](/home/yurgusev/CoffeeOrderPlatform/apps/web/src/realtime/order-invalidations.ts); [apps/web/src/realtime/order-invalidations.ts](/home/yurgusev/CoffeeOrderPlatform/apps/web/src/realtime/order-invalidations.ts); [apps/web/test/realtime.test.ts](/home/yurgusev/CoffeeOrderPlatform/apps/web/test/realtime.test.ts); [apps/web/test/operator-flow.spec.ts](/home/yurgusev/CoffeeOrderPlatform/apps/web/test/operator-flow.spec.ts) |
| 40 | [x] | Использовать native reconnect + server retry=3000; второй retry loop запрещён. | Подтверждено | [apps/web/src/browser/app/OrderRealtime.tsx](/home/yurgusev/CoffeeOrderPlatform/apps/web/src/browser/app/OrderRealtime.tsx); [apps/realtime-gateway/src/contract.ts](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/contract.ts); [apps/realtime-gateway/src/hub.ts](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/hub.ts); [tests/realtime/contract.test.mjs](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/contract.test.mjs); [apps/web/test/operator-flow.spec.ts](/home/yurgusev/CoffeeOrderPlatform/apps/web/test/operator-flow.spec.ts); [tests/orders/aroma-preparation-live.test.mjs](/home/yurgusev/CoffeeOrderPlatform/tests/orders/aroma-preparation-live.test.mjs) |
| 41 | [x] | UI indicator `Подключено\|Переподключение\|Обновление состояния` не меняет Order/AROMA state. После 30s offline — banner и manual owner refetch. | Подтверждено | [apps/web/src/browser/app/OrderRealtime.tsx](/home/yurgusev/CoffeeOrderPlatform/apps/web/src/browser/app/OrderRealtime.tsx); [apps/web/src/browser/app/OrderRealtime.tsx](/home/yurgusev/CoffeeOrderPlatform/apps/web/src/browser/app/OrderRealtime.tsx); [apps/web/src/browser/app/OrderRealtime.tsx](/home/yurgusev/CoffeeOrderPlatform/apps/web/src/browser/app/OrderRealtime.tsx); [apps/web/test/operator-flow.spec.ts](/home/yurgusev/CoffeeOrderPlatform/apps/web/test/operator-flow.spec.ts) |
| 42 | [x] | На каждом stream-ready, включая первое подключение без Last-Event-ID, инвалидировать существующие Order detail queries и refetch только active; закрыть окно initial GET → subscription. | Подтверждено | [apps/web/src/browser/app/OrderRealtime.tsx](/home/yurgusev/CoffeeOrderPlatform/apps/web/src/browser/app/OrderRealtime.tsx); [apps/web/src/realtime/order-invalidations.ts](/home/yurgusev/CoffeeOrderPlatform/apps/web/src/realtime/order-invalidations.ts); [apps/web/src/realtime/order-invalidations.ts](/home/yurgusev/CoffeeOrderPlatform/apps/web/src/realtime/order-invalidations.ts); [apps/web/test/realtime.test.ts](/home/yurgusev/CoffeeOrderPlatform/apps/web/test/realtime.test.ts); [apps/web/test/operator-flow.spec.ts](/home/yurgusev/CoffeeOrderPlatform/apps/web/test/operator-flow.spec.ts) |
| 43 | [x] | Gateway готовит boundary/queue без промежутка потери событий и отправляет ready после replay/reset и установки live delivery. Новый reconnect loop не создаётся. | Подтверждено | [apps/realtime-gateway/src/runtime-composition.ts](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/runtime-composition.ts); [apps/realtime-gateway/src/runtime-composition.ts](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/runtime-composition.ts); [apps/realtime-gateway/src/hub.ts](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/hub.ts); [tests/realtime/auth.test.mjs](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/auth.test.mjs); [tests/realtime/replay.test.mjs](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/replay.test.mjs) |
| 44 | [x] | Refetch использует monotonic projectionVersion guard #9; late response не откатывает карточку. | Подтверждено | [apps/web/src/browser/api/order-card.ts](/home/yurgusev/CoffeeOrderPlatform/apps/web/src/browser/api/order-card.ts); [apps/web/src/browser/api/remote.ts](/home/yurgusev/CoffeeOrderPlatform/apps/web/src/browser/api/remote.ts); [apps/web/test/operator-flow.spec.ts](/home/yurgusev/CoffeeOrderPlatform/apps/web/test/operator-flow.spec.ts) |
| 45 | [x] | Logout/session switch закрывает EventSource/listeners и отбрасывает late handlers; session не разделяет cache с другим пользователем. | Подтверждено | [apps/web/src/browser/api/session-identity.ts](/home/yurgusev/CoffeeOrderPlatform/apps/web/src/browser/api/session-identity.ts); [apps/web/src/browser/app/session.tsx](/home/yurgusev/CoffeeOrderPlatform/apps/web/src/browser/app/session.tsx); [apps/web/src/browser/app/session.tsx](/home/yurgusev/CoffeeOrderPlatform/apps/web/src/browser/app/session.tsx); [apps/web/test/operator-flow.spec.ts](/home/yurgusev/CoffeeOrderPlatform/apps/web/test/operator-flow.spec.ts) |
| 46 | [x] | Kafka schema/key/version/dedup/out-of-order/quarantine. | Подтверждено | [tests/realtime/contract.test.mjs](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/contract.test.mjs) |
| 47 | [ ] | Auth: no session, wrong permission/audience, forged headers, expiry и reconnect re-auth. | Подтверждено | [apps/realtime-gateway/src/hub.ts](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/hub.ts); [tests/realtime/auth.test.mjs](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/auth.test.mjs); [evidence/issue-12-analysis.md](/home/yurgusev/CoffeeOrderPlatform/evidence/issue-12-analysis.md) |
| 48 | [x] | Wire headers/frames/UTF-8/heartbeat и negative business-field fixtures. | Подтверждено | [apps/realtime-gateway/src/runtime-composition.ts](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/runtime-composition.ts); [apps/realtime-gateway/src/contract.ts](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/contract.ts); [tests/realtime/auth.test.mjs](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/auth.test.mjs); [tests/realtime/contract.test.mjs](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/contract.test.mjs); [tests/realtime/contract.test.mjs](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/contract.test.mjs) |
| 49 | [x] | Last-Event-ID replay found и reset для malformed/missing/evicted/restart. | Подтверждено | [apps/realtime-gateway/src/hub.ts](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/hub.ts); [apps/realtime-gateway/src/hub.ts](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/hub.ts); [tests/realtime/replay.test.mjs](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/replay.test.mjs); [tests/realtime/replay.test.mjs](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/replay.test.mjs); [tests/realtime/replay.test.mjs](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/replay.test.mjs) |
| 50 | [x] | Frontend exact invalidation, inactive no eager fetch, reset query keys и refetch через общий monotonic owner-response guard #9, без записи SSE payload. | Подтверждено | [apps/web/src/realtime/order-invalidations.ts](/home/yurgusev/CoffeeOrderPlatform/apps/web/src/realtime/order-invalidations.ts); [apps/web/src/browser/api/remote.ts](/home/yurgusev/CoffeeOrderPlatform/apps/web/src/browser/api/remote.ts); [apps/web/test/realtime.test.ts](/home/yurgusev/CoffeeOrderPlatform/apps/web/test/realtime.test.ts) |
| 51 | [x] | Duplicate/lower invalidations не откатывают UI. | Подтверждено | [apps/web/src/realtime/order-invalidations.ts](/home/yurgusev/CoffeeOrderPlatform/apps/web/src/realtime/order-invalidations.ts); [apps/web/src/browser/api/order-card.ts](/home/yurgusev/CoffeeOrderPlatform/apps/web/src/browser/api/order-card.ts); [apps/web/test/operator-flow.spec.ts](/home/yurgusev/CoffeeOrderPlatform/apps/web/test/operator-flow.spec.ts); [tests/orders/aroma-preparation-live.test.mjs](/home/yurgusev/CoffeeOrderPlatform/tests/orders/aroma-preparation-live.test.mjs) |
| 52 | [ ] | Capacity boundaries отдельно от штатной нагрузки: реальные 512/513 connections, 64/65 records, 256KiB/+1 UTF-8 byte, stalled 5s, socket abort/fast peer и graceful shutdown живых streams с проверенным cleanup; отказ происходит до SSE headers. | Подтверждено | [apps/realtime-gateway/src/hub.ts](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/hub.ts); [apps/realtime-gateway/src/hub.ts](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/hub.ts); [apps/realtime-gateway/src/runtime-composition.ts](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/runtime-composition.ts); [tests/realtime/backpressure.test.mjs](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/backpressure.test.mjs); [tests/realtime/backpressure.test.mjs](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/backpressure.test.mjs); [tests/realtime/backpressure.test.mjs](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/backpressure.test.mjs) |
| 53 | [ ] | Новый полный soak `operator-1`: 1 live SSE subscriber, 100 ACKed metadata invalidations/s для 100 order subjects, 30min; actual expiry/re-auth/replay/reset, session renewal, HUP на 900s, loaded shutdown и cleanup. Aggregate event p95≤1000ms, process event-loop p95≤100ms, headroom≤1000ms, shutdown≤20s, cleanup≤10s; RSS/FD/CPU/OOM evidence в штатных budgets. Prepare→frozen manifest→отдельное разрешение→run; smoke/старый5000FAIL не дают новый PASS. 100 invalidations/s не означает100orders/s. | Подтверждено | [evidence/issue-12-analysis.md](/home/yurgusev/CoffeeOrderPlatform/evidence/issue-12-analysis.md); [/tmp/coffee-operator1-run-20261014.log](/tmp/coffee-operator1-run-20261014.log) |
| 54 | [x] | `pnpm architecture:check`: только event/platform Kafka/SSE packages; owner runtime/domain/repository/DB запрещены. | Подтверждено | [evidence/handoffs/issue-12.yaml](/home/yurgusev/CoffeeOrderPlatform/evidence/handoffs/issue-12.yaml); [scripts/check-architecture.mjs](/home/yurgusev/CoffeeOrderPlatform/scripts/check-architecture.mjs) |
| 55 | [ ] | Manifest/config/bundle/redaction: нет DATABASE_URL, DB/AROMA secrets, PII/business payload; только `kafka.realtime`, actor verification и telemetry. | Подтверждено | [config/platform.yaml](/home/yurgusev/CoffeeOrderPlatform/config/platform.yaml); [compose.yaml](/home/yurgusev/CoffeeOrderPlatform/compose.yaml); [tests/realtime/fixtures/harness.test.mjs](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/fixtures/harness.test.mjs) |
| 56 | [x] | Проверить потерю hint между initial GET и первым ready, lower replay/late GET и logout во время refetch; inactive queries не вызывают eager requests. | Подтверждено | [apps/web/src/realtime/order-invalidations.ts](/home/yurgusev/CoffeeOrderPlatform/apps/web/src/realtime/order-invalidations.ts); [apps/web/src/browser/app/OrderRealtime.tsx](/home/yurgusev/CoffeeOrderPlatform/apps/web/src/browser/app/OrderRealtime.tsx); [apps/web/src/browser/api/remote.ts](/home/yurgusev/CoffeeOrderPlatform/apps/web/src/browser/api/remote.ts); [apps/web/test/operator-flow.spec.ts](/home/yurgusev/CoffeeOrderPlatform/apps/web/test/operator-flow.spec.ts) |
| 57 | [ ] | Расширить существующий tests/orders/owner-live.test.mjs ограниченным peak-сценарием:100 одновременно запущенных buyer flows с разными customerRef, один заказ/10 позиций на flow, реальные существующие Orders routes→application→OrderStore→PostgreSQL→Outbox. Проверить100 durable orders/1000positions, сохранённые versions и idempotency/retry без второго заказа/эффекта; прямые INSERT или synthetic Kafka ACK не заменяют команды. Записать actual concurrency, completions/errors, elapsed, throughput, p50/p95/p99 и DB pool/lock failures при действующих deadlines. Existing synthetic Customer/Pricing/auth seams перечислить явно: это owner-boundary proof, не real ingress/VK/Agent/LLM E2E. | Подтверждено | [tests/orders/owner-live.test.mjs](/home/yurgusev/CoffeeOrderPlatform/tests/orders/owner-live.test.mjs); [evidence/issue-12-analysis.md](/home/yurgusev/CoffeeOrderPlatform/evidence/issue-12-analysis.md); [evidence/handoffs/issue-12.yaml](/home/yurgusev/CoffeeOrderPlatform/evidence/handoffs/issue-12.yaml) |
| 58 | [ ] | Сохранить material owner→Outbox→Kafka→nginx→served SPA→real owner GET proof одной вкладки и проверить её восстановление/monotonic state во время потока owner material changes. В existing preparation live regression дополнительно проверить100contributions×10lines без удаления прежнего100×100 и без изменения recompute2s; seeded cardinality не выдавать за командный throughput. Draft/item-edit realtime emitters и безопасный provider mutation protocol не менять в этом scope. | Подтверждено | [tests/orders/aroma-preparation-live.test.mjs](/home/yurgusev/CoffeeOrderPlatform/tests/orders/aroma-preparation-live.test.mjs); [tests/orders/aroma-preparation-live.test.mjs](/home/yurgusev/CoffeeOrderPlatform/tests/orders/aroma-preparation-live.test.mjs); [tests/realtime/fixtures/owner-browser.mjs](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/fixtures/owner-browser.mjs); [tests/orders/aroma-preparation-live.test.mjs](/home/yurgusev/CoffeeOrderPlatform/tests/orders/aroma-preparation-live.test.mjs); [evidence/issue-12-analysis.md](/home/yurgusev/CoffeeOrderPlatform/evidence/issue-12-analysis.md) |
| 59 | [ ] | Синхронизировать численный профиль в docs/launch/20_REALTIME_SSE_IMPLEMENTATION_SPEC.md, 21_LAUNCH_VERIFICATION_SPEC.md, 29_NGINX_TRANSPORT_AND_AUTH.md и затронутых runtime/runbook документах; immutable revision roots не менять. Создать `evidence/handoffs/issue-12.yaml`: accepted inputs, hashes outputs, consumers, отдельные transport/owner/browser proofs, реальные команды и limitations. Архивные5000FAIL и experimental ADR не переписывать в PASS. | Подтверждено | [evidence/handoffs/issue-12.yaml](/home/yurgusev/CoffeeOrderPlatform/evidence/handoffs/issue-12.yaml) |
| 60 | [ ] | Ветка `feature/12-realtime-order-card` только от `develop`; PR только в `develop`. | Процесс: pending | [Live issue #12](https://github.com/YurGusev/CoffeeOrderPlatform/issues/12) |
| 61 | [ ] | Один issue — одна ветка — один PR; gateway, frontend adapter, contracts, tests, capacity evidence и docs находятся в PR. | Процесс: pending | [Live issue #12](https://github.com/YurGusev/CoffeeOrderPlatform/issues/12) |
| 62 | [ ] | Коммиты, PR и review replies — на русском; PR содержит `Closes #12`. | Процесс: pending | [Live issue #12](https://github.com/YurGusev/CoffeeOrderPlatform/issues/12) |
| 63 | [ ] | Статусы: `Готово к работе → В работе → На проверке → Готово`; после merge публикуется handoff #12. | Процесс: pending | [Live issue #12](https://github.com/YurGusev/CoffeeOrderPlatform/issues/12) |
| 64 | [x] | Принять auth contract [#160](https://github.com/YurGusev/CoffeeOrderPlatform/issues/160) и transport handoff [#162](https://github.com/YurGusev/CoffeeOrderPlatform/issues/162) без снятия прежних inputs #8/#9/#11/#63/#119. | Подтверждено | [evidence/handoffs/issue-12.yaml](/home/yurgusev/CoffeeOrderPlatform/evidence/handoffs/issue-12.yaml); [docs/launch/29_NGINX_TRANSPORT_AND_AUTH.md](/home/yurgusev/CoffeeOrderPlatform/docs/launch/29_NGINX_TRANSPORT_AND_AUTH.md) |
| 65 | [x] | Проверить, что realtime допускает только transport SAN `edge-nginx` + assertion signer `edge-gateway`, `aud=realtime-gateway`; spoofed browser actor, неверные audience/SAN и просроченный контекст отклоняются. | Подтверждено | [packages/platform-runtime/src/index.ts](/home/yurgusev/CoffeeOrderPlatform/packages/platform-runtime/src/index.ts); [packages/platform-security/src/index.ts](/home/yurgusev/CoffeeOrderPlatform/packages/platform-security/src/index.ts); [apps/realtime-gateway/src/runtime-composition.ts](/home/yurgusev/CoffeeOrderPlatform/apps/realtime-gateway/src/runtime-composition.ts); [tests/realtime/auth.test.mjs](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/auth.test.mjs); [tests/realtime/auth.test.mjs](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/auth.test.mjs) |
| 66 | [ ] | Проверить одну native EventSource вкладку через nginx: SSE buffering выключен, stream-reset/ready, reconnect после auth expiry, technical admission512/513 отдельно от рабочей когорты, idle/heartbeat budget; nginx не реализует replay/fanout/permissions вместо realtime. | Подтверждено | [tests/realtime/fixtures/owner-browser.mjs](/home/yurgusev/CoffeeOrderPlatform/tests/realtime/fixtures/owner-browser.mjs); [tests/orders/aroma-preparation-live.test.mjs](/home/yurgusev/CoffeeOrderPlatform/tests/orders/aroma-preparation-live.test.mjs) |


## Подготовка публикации issue #12 — 14 октября 2026

После завершения локальной приёмки владелец явно разрешил commit, push и PR.
Проверены origin и gh repo view: YurGusev/CoffeeOrderPlatform. Ветка
feature/12-realtime-order-card, база develop остаётся
91675aaa56900613505bfbd8cd14981b07cec000; существующего PR для ветки нет.
Предыдущая матрица 61/5 описывает срез до публикации. Внешние процессные
пункты выполняются только после фактического commit/push/PR; CI/review/merge
не подменяются локальными PASS. Разрешения на merge, deployment, изменение
labels и production/provider не получено. Published PR/commit будут записаны
в Obsidian после создания; self commit SHA в handoff не добавляется.


Staged diff check охватил также новые файлы и обнаружил единственную лишнюю
пустую строку EOF в tests/realtime/fixtures/harness.test.mjs. Удалён только
пустой EOF: исходные байты без завершающих переводов строк совпадают.
Это test-only форматирование после soak, без изменения runtime/compiled
или исполнимых инструкций fixture. Frozen manifest/result не переписывались;
их source hash этого test file относится к исходному срезу до EOF cleanup.
Output hash handoff пересчитан. Security material check перед публикацией PASS.


## PR #176: синхронизация 400 для /events — 14 октября 2026

Reviewer P2: https://github.com/YurGusev/CoffeeOrderPlatform/pull/176#discussion_r4269990744.
Замечание подтверждено: runtime уже возвращает400VALIDATION_FAILED при query
или объявленном body, а OpenAPI/manifest перечисляли200/401/403/503.
Добавлен400 со ссылкой на существующий ValidationFailed в client-v1 и manifest;
generated StreamOrderInvalidationsErrors включает400:ErrorValidationFailed.
Описание owning spec обновлено. Runtime/дедлайны/budgets/wire поведение не менялись.

Расширен существующий SSE contract regression:400 обязателен в обеих authority.
До исправления RED1/1 (missing response), после исправления полный contracts:test
49/49 PASS без skips. pnpm test:realtime-auth9/9 PASS подтверждает текущие query
rejections и остальные auth paths. contracts:generate, contracts:check-generated
(byte-identical), contracts:lint, contracts:breaking, pnpmtypecheck и целевой
oxlint — exit0. Логи: /tmp/coffee-pr176-400-*.log.

Полный check/30minsoak не повторялись: изменение описывает существующее поведение,
не меняет runtime. Frozen manifest и исторические source hashes/receipts
сохраняют прежний контрактный срез и не переписаны. Новые outputs и hashes
добавлены в handoff; пользователь разрешил новый commit и push в тот жеPR.
Merge и сообщения reviewer не выполняются этим разрешением.


Astra: PR176-P2-400 устранено, новых существенных замечаний нет. Проверены
OpenAPI400→ValidationFailed, manifest, минимальный generated diff (четыре
строки), regression обеих authority и owning doc. Повторный soak не требуется:
это описание существующего ответа без изменения runtime/wire поведения.
Root подтвердил91outputs/7inputs hashes и ancestry; новый commit/push разрешены.
