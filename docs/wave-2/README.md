# Вторая волна: закупка, счета и оплата заказов

Статус: документационный план [issue #66](https://github.com/YurGusev/CoffeeOrderPlatform/issues/66),
не runtime admission. Основной владелец пакета — Platform Architecture.
Логический контракт реквизитов счёта и его связей с Orders находится только в
[AROMA Supplier Invoices](01_AROMA_SUPPLIER_INVOICES.md).

## Вход и граница волн

Пакет принимает recovery #60 / [PR #65](https://github.com/YurGusev/CoffeeOrderPlatform/pull/65),
merge `69cc341b6d9507f27c5e115aef519d0b96923bfc`,
[ADR-0025](../adr/ADR-0025-fastify-launch-recovery.md) и
[delivery graph первого запуска](../launch/13_DELIVERY_DEPENDENCY_GRAPH.md).
Техническая линия: Fastify, native async/await и AbortSignal, PostgreSQL/pg,
Kafka, React Router/TanStack Query, Pino/OpenTelemetry. Effect-линия историческая.
План не требует нового общего workflow engine, Redis или Kubernetes.

Первая волна уже включает Customer, Catalog, Pricing, Draft/Confirm Orders,
автоматическую общую корзину AROMA и React/SSE (#5–#12, #16–#18). Checkout,
Invoices и Payments исключены из неё
[явно](../launch/00_SCOPE_AND_DECISIONS.md). Наличие scaffold #3/#60 не означает
готовность этих бизнес-процессов. Их нельзя переносить во вторую волну для
формального завершения первого запуска.

Документы второй волны можно готовить заранее. Этот план описывает ожидаемую
последовательность задач, но не подтверждает, что какая-либо задача уже
реализована или принята. #66 — исходная историческая колонка и контекст
планирования; актуальные статусы #61–#64 и остальных issues проверяются по
GitHub и принятым handoffs, а не фиксируются этим документом.

## Результат и граф поставки

Оператор получает прослеживаемый цикл от синхронизированной корзины до счёта
поставщика, проверенного распределения и оплаты клиента. Каждый остановленный
процесс имеет owner, сохранённую причину и допустимую команду восстановления.

Порядок ниже — последовательность зависимостей из [epic #70](https://github.com/YurGusev/CoffeeOrderPlatform/issues/70),
а не отчёт о выполнении. Решения #71/#72/#75 — обязательные входы #76;
#73 задаёт политику PSP для последующей Payments-поставки, но **не** объявляется
дополнительным prerequisite #76. Topology handoff #71 раскрывается в [документе runtime topology](02_RUNTIME_TOPOLOGY.md)
и [ADR-0030](../adr/ADR-0030-wave2-runtime-topology.md).

[ADR-0033](../adr/ADR-0033-wave2-header-revenue-boundaries.md) — scoped решение
Архитектора D1/D2 (документальная поставка ожидает merge, не runtime): #81
реализует ранний header handler единственной `orders-invoice-consumer` роли;
#83 принимает #81 и расширяет тот же runtime финансовым handler, без обратного
prerequisite раннего header. #80 публикует минимальный Locked revenue proof и
факт для каждого frozen Order полным атомарным набором для #86, не grant Pricing
на полный checkout. #76 сохраняет актуальный
launch registry с восемью сообщениями по [ADR-0032](../adr/ADR-0032-order-reconciliation-intent.md),
не исторический exact-seven; gate #13 не снимается.

Точный порядок и зависимости:

1. Решения #71 (topology/DB/runtime), #72 (AROMA evidence) и #75
   (quantity/money) подготавливают #76; #73 (PSP) требуется платежным owner paths.
2. #76 публикует contracts после принятых #4/#13/#66/#71/#72/#75.
3. #77 материализует core platform после #12/#13/#61–#64 и #71/#76.
   #120 (realtime) и #121 (telemetry) подключаются после #77 и не являются его
   prerequisites.
4. #78 создаёт core Artifact Storage после #76/#77. Ранние #80/#81 требуют
   #78, но не требуют PDF scan/delivery; #88 принимает их результаты и
   realtime #120.
5. #79 реализует safe AROMA read transport после #10/#72/#76/#77. #80 реализует
   checkout после #8/#11/#76–#79.
6. #122 добавляет bounded PDF scan после #71/#76–#78. #123 доставляет supplier
   PDF через Orders в Invoices после #76–#80 и #122; #82 принимает #81,
   #122 и #123 для полного документного/денежного proof.
7. #87 поставляет ранние checkout/header queues; его входы — #11/#76/#77/#80/#81.
   #124 подключает поздние financial sources после #76/#77/#82–#87.
   #84/#85 могут проверять contract fixtures #76 до реализации #83,
   но живой финансовый путь принимается только в #90.
8. #83 принимает #8/#80/#81/#82/#76/#77; прямая #81→#83 — reuse header consumer,
   не второй consumer. #86 принимает #7/#75/#76/#77/#80/#82: отдельные revenue
   и invoice cost proofs; неизвестная выручка pending, Locked цена неизменна.

Это план зависимостей из #70, а не отчёт о выполнении: ни готовность, ни
принятие handoffs здесь не утверждаются. Каждый owner output остаётся отдельной
поставкой; общий PR на все домены не подразумевается.

### Acceptance не активирует financial producer

По D1a ADR-0033 #82 принимается на isolated accepted fixture receiver #76 до
#83, оставаясь его implementation predecessor. В общей среде price application/
InvoicePricesApplied выключены до принятого установленного #83. Invoices
сохраняет document input/intents durable, не коммитит applied proof/financial
Outbox и не ставит заблокированную financial row перед header. Header-only #81
не паркует неизвестный будущий payload и #81/#88 не ждут #83.

Rollout: #82 fixture acceptance → #83 installation с header+financial durable
intake/job recovery → явная activation #82 по versioned contract #76 и #77
config/platform.yaml/schema/runbook, с последующим live gate #90. HTTP health
не автоматическое разрешение. При activation сохранённые intents завершаются с
прежними identities; price application/proof ref/Outbox одной Invoices transaction.
Restart не раздваивает факт. Rollback сначала выключает producer, сохраняет
dual-capable consumer для опубликованных/in-flight records и pending jobs;
header-only downgrade запрещён до доказанного drain/replay horizon, offsets/
Inbox не сбрасываются. Это operational gate, не обратное DAG ребро #83→#82.

После #83 D1b разделяет durable intake/header readiness и financial apply:
storage outage оставляет owner-local financial jobs pending, header из той же
partition продолжается в принятом bounded profile. Это будущая реализация #83
с bindings/runbook #77, не готовая возможность foundation. Полная семантика и
future cases — [invoice flow](01_AROMA_SUPPLIER_INVOICES.md#acceptance-scenarios).

| Этап / владелец | Вход → выход | Критерий приёмки и восстановление |
|---|---|---|
| W2-contracts / Platform Architecture с владельцами контрактов | Канон и закрытые provider inputs → один набор target schemas, topics, ownership и topology bindings | Для каждой связи заданы writer, transport, key, consumer, idempotency, revision/replay policy; дублирующих путей нет. Несовместимость блокирует consumer, invalid payload уходит в quarantine |
| W2-artifacts / Platform Operations | Принятые roles и artifact boundary → private object storage, authorized refs, quarantine/scan, retention/restore | Immutable manifest проверяется по hash/size/schema, документы проходят scan до parsing. Повтор upload/job и restart не создают иной proof; restore подтверждён чтением bytes |
| W2-checkout / Orders; Gateway исполняет provider transport | Current InSync proof и все active строки Order → freeze, exact wholesale link, allocation manifest и ожидание реквизитов | Один Order закупается целиком. После exact link купленные contributions исключены атомарно; ambiguity/cancel race сохраняют blocker/compensation, не повторяют submit |
| W2-invoices / Invoices | Immutable allocation handoff и provider observations → header/links, allocations, document reconciliation, invoice/price proof | Раннее состояние счёта по владеющему документу; полный proof требует coverage/hash/quantity/amount checks. Inbox replay идемпотентен; изменения счёта версионируются, расхождения идут в review |
| W2-payment-requirement / Orders | Verified invoice proof → server-owned requirement и AwaitingCustomerPayment | Проверены frozen version, coverage, amount/currency и correlation. Частичный/чужой proof не продвигает lifecycle; duplicate event не создаёт второе requirement |
| W2-payments / Payments; lifecycle writer Orders | Requirement → intent, verified webhook/reconciliation, payment/refund facts | Browser redirect не proof. Unknown create/refund сверяется по stable provider identity; поздняя оплата отменённого заказа создаёт incident, а не resurrect. Cancel/refund/compensation и их recovery приняты до live gate |
| W2-pricing / Pricing | Locked Orders revenue proof #80, verified actual supplier cost и введённая фактическая доставка → воспроизводимая маржа и preview следующего коэффициента | Только revenue/price proof grants, без checkout/PDF. Цена Locked Order не меняется; до обоих proofs маржа pending. Активация коэффициента — явная versioned команда; исправления сохраняют evidence |
| W2-work-center / Work Center | Факты подключённых owners → очереди исключений и разрешённые owner commands | Acknowledge/snooze не меняют бизнес-истину. Resolution требует completion fact. Replay восстанавливает projection; недоступный/отстающий источник виден, пустая очередь не означает здоровье |
| W2-acceptance / Reliability | Все принятые outputs → release evidence | Пройдены duplicate/reorder/crash/unknown, cancel races, document integrity, capacity/restore и сквозная диагностика; непроверенные live paths не объявлены PASS |

Orders/Invoices/Payments используют собственные локальные транзакции и Outbox;
Kafka доставляет факты/команды at-least-once. Межвладельческий SQL и синхронный
цикл для «добора» данных отсутствуют. Повторный запуск читает durable owner state,
не восстанавливает бизнес-истину из браузера или Kafka offset.

## Автоматизация и операторские действия

Автоматическая корзина первой волны агрегирует несколько подтверждённых заказов
в один physical cart scope. Checkout freeze — локальная фиксация согласованного
состава; он сам не отправляет закупку поставщику. До доказанного provider submit
контракта оформление закупки остаётся контролируемым действием оператора.
Это граница процесса, не готовый runbook работы в интерфейсе AROMA. После freeze
изменение включённого состава запрещено; при неизвестном результате оформления
повторное нажатие/submit не заменяет safe wholesale reconciliation.

Далее автоматически выполняются exact wholesale matching, получение реквизитов,
детерминированное распределение и проверка доказательств, payment reconciliation,
расчёт фактической маржи и постановка исключений в очередь. Неоднозначное
сопоставление, компенсация/возврат и изменение коммерческой политики требуют
явных owner commands с actor, reason, expected version и idempotency.

`OrderLifecycleStatus.Completed`, supplier fulfillment, checkout и invoice
states независимы. Оплата клиента не доказывает поставку. Manual collection —
audited fallback, не замена штатного verified online-payment пути.

Work Center поставляется вместе с подключаемыми доменами. Источники, отсутствующие
в этой поставке, отмечаются Unavailable; частичное покрытие не объявляется полной
приёмкой M21. Excel import/export и Hermes/VK не входят в обязательный цикл W2.

## Незакрытые входы реализации

| Вход / владелец решения | Требуемое evidence | Блокируемый этап |
|---|---|---|
| AROMA invoice read / Integration и Invoices | Обезличенные реальные ответы, связь invoice с wholesale, поведение pending/partial/not-found, provider limits и семантика актуальности; утверждённый normalized observation contract | Live invoice polling W2-checkout/invoices |
| Stable invoice identity / Integration и Invoices | Устойчивый provider ref в account scope и правила переиздания/смены номера; номер сам по себе недостаточен | Автоматическая привязка и дедупликация счёта |
| AROMA submit / Integration и Orders | Документированный primitive, подтверждённые preconditions/result lookup/UnknownOutcome и утверждённая политика запуска | Автоматическое оформление закупки; контролируемый операторский путь не подменяет такое evidence |
| Payment provider / Payments и владелец продукта | Выбранный PSP, методы оплаты, подписанный webhook contract, create/refund idempotency/lookup, условия partial/over/under-payment | Live Payments; fixtures не подтверждают работу PSP |
| Quantity/money/распределение / Invoices, Orders, Pricing | Единицы provider quantity, точный масштаб, minor units, согласованные правила скидок/доставки/округления и примеры с совпадающими суммами | Allocation/proof и payment requirement |
| Invoice document matching / Invoices | Обезличенные документы/ответы, доказанная связь с header/lines, правила проверки, manual-review критерии | Автоматическое применение invoice prices |
| W2 topology / Platform Architecture и Operations | [ADR-0030](../adr/ADR-0030-wave2-runtime-topology.md) и [target matrix](02_RUNTIME_TOPOLOGY.md) задают роли, DB/ACL, бюджеты и future gates #76/#77/#78/#90 | Решение #71 не даёт разрешения на развёртывание: materialization и evidence остаются за successors |

Текущие пять owner DB и 15 runtime не расширяются этим пакетом. Invoices и
Payments требуют изолированных БД/ролей; Work Center — собственной projection
границы. Artifact storage является инфраструктурой, не общей бизнес-БД.
Target #71 — 19 новых ролей после #13 и отдельных implementation handoffs;
canonical роли не превращаются в них неявно. Несекретные значения остаются
в `config/platform.yaml`, exact pins — в toolchain registry, секреты — в SOPS
с существующей scoped materialization. Новые значения здесь не вводятся.

W2-contracts должен материализовать один target wire contract для каждого
handoff. Сейчас выявлены следующие точки согласования, а не готовые API:

- M10 использует описательное `operationRef`, machine schema —
  `invoiceOperationRef`: требуется одна wire identity и стабильная семантика key.
- Launch decimal quantity и canonical integer allocation quantity требуют
  lossless unit/scale contract; cast/округление без проверки запрещены.
- Orders→Payments описывается как event/command: нужны единственные
  topic/kind/key/consumer и владелец retry, без двух параллельных каналов.
- Invoice compensation, payment cancel/refund и supplier compensation получают
  согласованную последовательность owner facts, terminal criteria и ManualReview.

## Совместимость с первой волной и приёмка

| Consumer | Требование, которое он должен сохранить | Где материализуется |
|---|---|---|
| #8 Orders | Confirm атомарно пишет immutable contribution, history и OrderConfirmed Outbox; cart-level Desired строится после commit | [Orders launch spec](../launch/17_ORDERS_IMPLEMENTATION_SPEC.md) |
| #10 Gateway | Единственный provider transport/session owner; journal не делает business retry | [Gateway journal](../launch/22_AROMA_GATEWAY_OPERATION_JOURNAL.md) |
| #11 convergence | Durable next wake-up/startup sweep и периодический observer должны обеспечивать продолжение после сбоя, coalesced wake-up и UnknownOutcome | Отдельное уточнение acceptance #11; этот пакет не редактирует launch spec |
| #11 convergence | Новый fence не разрешает mutation при незавершённой cart-wide reservation; provider deadline, reservation и lease window согласованы | [Canonical reservation/fencing](../CoffeeOrderSystem_CANONICAL_Architecture_EndToEndHardened_RU_2026-08-19/M11_AROMA_GATEWAY/07_MUTATION_RESERVATION_AND_FENCING.md), затем implementation #11 |
| W2-checkout | Exact link атомарно исключает купленные sources из active Desired до возобновления корзины | [Canonical checkout](../CoffeeOrderSystem_CANONICAL_Architecture_EndToEndHardened_RU_2026-08-19/M11_AROMA_GATEWAY/04_AROMA_CHECKOUT_WHOLESALE_CONTRACT.md), затем W2-checkout |

Данная таблица не меняет существующие issue bodies/statuses и их merged-input
правило. Новый пакет не подменяет acceptance #11 дополнительным неисполненным
текстом. Известные gaps должны быть закрыты владельцем до его runtime admission.

Для одной корзины сохраняется одна mutation lane. Дополнительные replicas не
умножают provider concurrency. Capacity gate измеряет Confirm→InSync и backlog
с provider latency/rate limits; скорость локальной функции не доказывает срок
сходимости физической корзины. После restart durable timers восстанавливают
обработку; внешняя неоднозначность имеет bounded review path, не endless retry.

Минимальная сквозная приёмка W2 проверяет: несколько Orders в checkout; точное
и неоднозначное wholesale matching; отсутствие повторного наполнения купленного
состава; поздний header без PDF; повреждённый/неполный proof; duplicate/reordered
invoice/payment facts; неизвестный create/refund; cancel/late-success race;
restore artifacts/owner state и диагностику остановленного процесса.
Подробные invoice-примеры находятся в единственном владеющем документе выше.

## Источники и handoff

- [Canonical Contract Closure и порядок revisions](../CoffeeOrderSystem_CANONICAL_Architecture_ContractClosure_RU_2026-08-22/README.md).
- [M20 сквозной бизнес-процесс](../CoffeeOrderSystem_CANONICAL_Architecture_EndToEndHardened_RU_2026-08-19/M20_SERVICE_ORCHESTRATION/04_END_TO_END_ORDER_FULFILLMENT_ORCHESTRATION.md).
- [M08 Payments](../CoffeeOrderSystem_CANONICAL_Architecture_EndToEndHardened_RU_2026-08-19/M08_PAYMENTS/01_PAYMENTS_ARCHITECTURE.md).
- [M04 Artifact boundary](../CoffeeOrderSystem_CANONICAL_Architecture_EndToEndHardened_RU_2026-08-19/M04_TYPESCRIPT_PLATFORM/07_ARTIFACT_STORAGE_BOUNDARY.md).
- [M22 коэффициент фактической доставки](../CoffeeOrderSystem_CANONICAL_Architecture_EndToEndHardened_BusinessParityPricingV2_RU_2026-08-20/M22_PRICING/05_DELIVERY_COEFFICIENT_LIFECYCLE.md).
- [M21 owner commands](../CoffeeOrderSystem_CANONICAL_Architecture_ContractClosure_RU_2026-08-22/M21_OPERATOR_WORK_CENTER/OWNER_COMMAND_ALLOWLIST_AND_AUDIT.md).

Canonical roots неизменяемы. #66 выпускает документационный handoff
`evidence/handoffs/issue-66.yaml` с accepted inputs, hashes трёх downstream
документов, фактическими проверками и ограничениями. W2-коды в consumers —
этапы этого плана, не вымышленные issue IDs. Future delivery сначала закрепляет
их реальными owner issues, target contracts и platform decisions. Этот handoff
не подтверждает provider API, invoice polling, payment integration или deployment.
