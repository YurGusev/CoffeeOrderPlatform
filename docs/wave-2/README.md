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

Документы второй волны можно готовить сейчас. Эксплуатационный допуск её
бизнес-пути требует принятого #13 с observability #64 и собственных W2 gates.
#66 не добавляет prerequisite к #4 или #61–#64 и не меняет статусы существующих
issues. Реализация доменов принимает только merged handoffs своих зависимостей.

При подготовке пакета #61 выполняется отдельно в задаче «Настрой параметры
GPT-6 Astra» (`01a06fae-bce6-7ac0-9e84-35b1ad1f79b8`), ветка
`feature/61-runtime-recovery`. #66 не изменяет её runtime/tests и launch
документы `01_RUNTIME_ARCHITECTURE.md`, `06_EVENTS_AND_RECOVERY.md`,
`21_LAUNCH_VERIFICATION_SPEC.md`; их последующее принятие проверяется по GitHub.

Состояние ниже относится к входному commit #60, а не к незакоммиченной работе
других задач. Изменение колонки реализации требует ссылки на accepted handoff.

| Возможность | Специфицировано | Реализовано на входном commit | Проверено |
|---|---|---|---|
| Fastify foundation | ADR-0025 | Recovery/scaffold #60 | Foundation evidence #60, не business admission |
| Durable runtime/DB/Kafka | #61–#63 | Полный durable path отсутствует | Приёмка successors не получена |
| Confirm → общая корзина → InSync | Launch #8/#10/#11 | Бизнес-цепочка отсутствует | E2E/provider proof отсутствует |
| Checkout → wholesale link | Канон M11, этап W2-checkout | Нет | Нет |
| Реквизиты счёта и связи с Orders | Логический контракт #66; provider read inputs открыты | Нет | Только документальные примеры, не live AROMA |
| Invoice proof → customer payment | Канон M10/M08; W2 contracts ещё не материализованы | Нет | Нет |
| Actual margin и Work Center | Канон M22/M21, границы ниже | Нет | Нет |

## Результат и граф поставки

Оператор получает прослеживаемый цикл от синхронизированной корзины до счёта
поставщика, проверенного распределения и оплаты клиента. Каждый остановленный
процесс имеет owner, сохранённую причину и допустимую команду восстановления.

```text
W2-contracts (включая отдельное topology/roles решение)
    → W2-artifacts → W2-checkout → W2-invoices
                                      → W2-payment-requirement → W2-payments
                                      → W2-pricing
факты реализованных owners             → W2-work-center
все этапы + принятый launch #13         → W2-acceptance
```

Это коды этапов плана, не номера GitHub issues. В будущей декомпозиции каждый
owner output получает отдельный delivery issue и PR; таблица не разрешает
реализовать все домены одним PR. Payments можно разрабатывать с contract fixtures
после W2-contracts; его сквозная приёмка требует W2-payment-requirement.

| Этап / владелец | Вход → выход | Критерий приёмки и восстановление |
|---|---|---|
| W2-contracts / Platform Architecture с владельцами контрактов | Канон и закрытые provider inputs → один набор target schemas, topics, ownership и topology bindings | Для каждой связи заданы writer, transport, key, consumer, idempotency, revision/replay policy; дублирующих путей нет. Несовместимость блокирует consumer, invalid payload уходит в quarantine |
| W2-artifacts / Platform Operations | Принятые roles и artifact boundary → private object storage, authorized refs, quarantine/scan, retention/restore | Immutable manifest проверяется по hash/size/schema, документы проходят scan до parsing. Повтор upload/job и restart не создают иной proof; restore подтверждён чтением bytes |
| W2-checkout / Orders; Gateway исполняет provider transport | Current InSync proof и все active строки Order → freeze, exact wholesale link, allocation manifest и ожидание реквизитов | Один Order закупается целиком. После exact link купленные contributions исключены атомарно; ambiguity/cancel race сохраняют blocker/compensation, не повторяют submit |
| W2-invoices / Invoices | Immutable allocation handoff и provider observations → header/links, allocations, document reconciliation, invoice/price proof | Раннее состояние счёта по владеющему документу; полный proof требует coverage/hash/quantity/amount checks. Inbox replay идемпотентен; изменения счёта версионируются, расхождения идут в review |
| W2-payment-requirement / Orders | Verified invoice proof → server-owned requirement и AwaitingCustomerPayment | Проверены frozen version, coverage, amount/currency и correlation. Частичный/чужой proof не продвигает lifecycle; duplicate event не создаёт второе requirement |
| W2-payments / Payments; lifecycle writer Orders | Requirement → intent, verified webhook/reconciliation, payment/refund facts | Browser redirect не proof. Unknown create/refund сверяется по stable provider identity; поздняя оплата отменённого заказа создаёт incident, а не resurrect. Cancel/refund/compensation и их recovery приняты до live gate |
| W2-pricing / Pricing | Verified actual supplier cost и введённая фактическая доставка → воспроизводимая маржа и preview следующего коэффициента | Цена Locked Order не меняется. Активация коэффициента — явная versioned команда; неполные costs остаются pending, исправления сохраняют evidence |
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
| W2 topology / Platform Architecture и Operations | Отдельное ADR/issue с exact runtime set, owner DB/roles, ACL/networks, scoped secrets, pools/limits, storage/scan и workload mappings | Развёртывание новых владельцев и workers |

Текущие пять owner DB и 15 runtime не расширяются этим пакетом. Invoices и
Payments требуют изолированных БД/ролей; Work Center — собственной projection
границы. Artifact storage является инфраструктурой, не общей бизнес-БД.
Физическое число новых процессов определяется принятой topology задачей, а не
неявным объединением canonical runtime roles. Несекретные значения остаются
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
