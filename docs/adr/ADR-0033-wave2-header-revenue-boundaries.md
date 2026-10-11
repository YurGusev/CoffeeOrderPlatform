# ADR-0033: этапы Orders invoice consumer и минимальный revenue proof W2

- Статус: решение cop-architect по делегированному владельцем полномочию от
  2026-10-11; документальная поставка ожидает merge в `develop`. Не runtime admission.
- Дата: 2026-10-11. Владелец: Platform Architecture совместно с Orders,
  Invoices, Pricing и Artifact Operations.
- База сверки: `91675aaa56900613505bfbd8cd14981b07cec000`.
- Authority: [ADR-0030](ADR-0030-wave2-runtime-topology.md),
  [W2 topology](../wave-2/02_RUNTIME_TOPOLOGY.md),
  [invoice flow](../wave-2/01_AROMA_SUPPLIER_INVOICES.md),
  [W2 delivery graph](../wave-2/README.md) и
  [Artifact boundary](../CoffeeOrderSystem_CANONICAL_Architecture_EndToEndHardened_RU_2026-08-19/M04_TYPESCRIPT_PLATFORM/07_ARTIFACT_STORAGE_BOUNDARY.md).

## Контекст и граница

Ранний header должен попасть в Order Card до финансового proof, а Pricing нужен
Locked customer revenue без доступа к wholesale/provider деталям checkout.
Уточняются только этапы уже названной роли и grants существующей Artifact
инфраструктуры. 19 W2 ролей, 9 target БД, principals/pools и fleet budgets не
увеличиваются. #13 остаётся обязательным входом W2; актуальный launch registry
содержит восемь сообщений с OrderReconciliationRequested по
[ADR-0032](ADR-0032-order-reconciliation-intent.md), не исторические exact-seven.
Исторические #71 и launch handoff hashes не переписываются.

## D1: одна роль, два этапа

Единственная роль — `orders-invoice-consumer`, executable
`apps/orders-invoice-consumer/src/main.ts`, Orders principal
`coffee_orders_invoice_rw`, pool 4. Invoices пишет header/proof только в своей
БД; Orders — единственный writer своей projection/lifecycle.

1. #77 материализует выключенный scaffold и DB/network/Kafka bindings по #76.
   Это не реализация handler и не включение будущих capabilities.
2. #81 поставляет Orders-owned header handler и owner-local migrations/tests:
   проверка message identity, checkout/order correlation и invoice revision;
   Inbox + invoice summary + increment OrderCard.projectionVersion + Orders
   Outbox invalidation — одна Orders transaction. Header не создаёт payment
   requirement, не меняет payable amount и не переводит lifecycle в
   AwaitingCustomerPayment. Readiness требует Orders DB/Kafka, не будущие
   PDF store/scanner. #81/#88 не ждут #82/#83/#84.
3. #83 принимает accepted #81 handoff и расширяет тот же runtime финансовым
   InvoicePricesApplied intake и owner-local pending apply. Header handler,
   principal и существующая subscription/group identity сохраняются. Добавляется
   только authorized ready read invoice-price-proof, не grant на supplier PDF.
   Storage readiness нужна для financial apply, не для header/durable intake.

#76 закрепляет единственный topic/key/group/producer/consumer mapping, ordering
scope и monotonic guards. Этот ADR не придумывает wire/topic/group names;
несовместимый payload не публикуется под прежней версией. Прямая дуга #81→#83
выражает reuse уже транзитивного input через #82; обратной дуги нет.

### D1a: implementation acceptance отдельно от producer activation

#82 остаётся implementation predecessor #83. Его merge/fixture acceptance не
включает price application/InvoicePricesApplied в общей среде: до принятого и
установленного #83 dual-capable consumer financial producer выключен. Invoices
сохраняет document input/intents durable, но не коммитит завершение price
application и его Outbox до activation. Заблокированная financial Outbox row
перед header недопустима: она перенесла бы head-of-line blocking в relay.

Порядок rollout: принять #82 на isolated accepted fixture receiver по #76 →
принять/установить #83 с header+financial intake/recovery → явно включить #82
producer по #77 runbook и последующему #90 live gate. HTTP health consumer не
является автоматическим межсервисным разрешением. #76 фиксирует versioned
activation/compatibility contract; #77 материализует его единственную явную
настройку в config/platform.yaml/schema и runbook. Здесь ключ не создаётся.

После activation Invoices завершает сохранённые intents с теми же identities:
price application + immutable proof reference + Outbox — одна Invoices
transaction. Restart/retry не раздваивает факт; proof не объявляется applied
без durable handoff. Rollback сначала останавливает financial producer, но
сохраняет dual-capable consumer для опубликованных/in-flight records и pending
jobs. Header-only downgrade запрещён до доказанного drain/replay horizon;
offsets/Inbox не сбрасываются. #81/#88 остаются независимыми от #83.

### D1b: durable financial pending и degraded readiness

После #83 общая /health/ready означает способность принимать header и надёжно
сохранять financial work: Orders DB + Kafka/Inbox + bounded capacity. Отказ
только artifact-ready делает financial apply readiness false/degraded с
operator-visible reason/backlog age, но не выключает header intake.
/health/live dependency-free. Это исключение dual-capability роли, не отмена
mandatory storage у остальных ролей.

Валидный financial envelope #76 принимается существующим Inbox: одна Orders
transaction сохраняет immutable envelope/ref/hash/correlation и pending job;
transport acceptance/offset подтверждается только после известного commit.
Inbox Processed означает durable acceptance job, не verified price proof и не
AwaitingCustomerPayment. Успешный handler без pending row запрещён. Это state
будущего #83, не уже имеющаяся способность foundation и не новый runtime.

В том же процессе bounded scheduler/startup sweep возобновляет jobs после
restart/store recovery. Job хранит stable message/business identity,
refs/hash/version, next-at/attempts/reason и lease/fence; duplicate intake не
создаёт второй job, terminal job не исполняется снова. Fetch/size/hash/type/
schema/Ready validation выполняются вне DB transaction. Новая короткая Orders
transaction повторно проверяет correlation/current frozen version, coverage,
currency/amount, cancellation и job lease/version для всего bounded набора N
Orders из verified proof. Orders применяет набор all-or-nothing. Успешная
transaction сохраняет consumed proof и terminal job outcome вместе со всеми N
per-order effects: отдельный stable PaymentRequirementRef, lifecycle/history/
projection и один принятый payment Outbox handoff каждого Order. Payable amount
берётся из Locked customer agreement по #75/#76, не из supplier invoice total.

Если хотя бы один Order cancelled/stale/conflicting или набор неполон, Orders
не создаёт новых requirements/lifecycle/Outbox effects ни для одного элемента.
Job сохраняет explicit review/conflict и причину. Прежние корректные
исторические effects не откатываются. Полностью применённый тот же proof —
no-op/reuse всего набора с прежними identities. Чужое или частично несовместимое
прежнее requirement — conflict, не overwrite и не автозавершение остальных.
Конфликт разрешается только существующим принятым recovery/correction путём.
Crash после commit до ACK/retry не повторяет per-order requirements. Checkout,
proof/envelope и transaction limits не повышаются; validation сети/bytes вне locks.

Storage outage оставляет durable pending/retry по accepted budgets. Corrupt,
wrong owner/type/hash или stale proof даёт explicit review/conflict без payment
effect. Header после financial record в той же Kafka partition продолжается
после сохранения job: storage retry не держится в Kafka handler, transport Inbox
replay не исполняет уже принятый job. Financial fetches не исчерпывают header
capacity; starvation/неограниченная RAM queue запрещены. Backlog/count/age и
recovery horizon наблюдаемы по #71/#77/#121. При невозможности безопасно
сохранить работу — backpressure/not-ready без потери, не обещание независимости
при исчерпанной DB/disk. В принятом bounded profile отказ только storage обязан
сохранять header progress. Header/financial revision guards ортогональны:
поздний header не откатывает применённый financial state.

## D2: отдельный минимальный order-revenue-proof

`order-revenue-proof.v1` — новый **target semantic artifact type**, не уже
опубликованная schema. Type/schema/version и bounded envelope материализует
#76 в единственном registry. Writer только Orders `orders-checkout-worker`;
reader только Pricing `pricing-cost-worker` с `ownerContext=Orders`,
`artifactType=order-revenue-proof`, `schemaVersion=1` и exact ready namespace.
Metadata/ACL owner — существующий `artifact-metadata-service`. Нет grants
произвольного prefix/list/download, browser, Payments, Work Center или invoice
readers на revenue bytes. Source checkout ref/hash — correlation, не capability
на чтение checkout-allocation bytes.

Для N различных frozen Orders создаются N write-once per-order artifacts.
Каждый proof содержит orderRef, checkoutSnapshotRef/checkout identity, frozen order
version, currency, immutable Locked customer line totals и order total,
полное line coverage/coverage hash и source snapshot proof identity. Исключены
credentials/URL, Customer PII, wholesale line payload и текущая quote. Значения
копируются из frozen Orders snapshot по принятой #75 quantity/money policy:
без новой формулы, rounding или переоценки. Сохраняются W2 JSON manifest ≤1 MiB
и каждый сериализованный Kafka envelope+payload ≤64 KiB. Maximum Orders/items/
allocations #76 и bounds #71/#77 проверяются до freeze и повторно перед link;
all-or-nothing transaction укладывается в owner budgets. Oversized checkout/link
отвергается до irreversible effect, без разбиения в обход checkout bound,
silent truncation или повышения limits.

#80 создаёт весь набор write-once bytes вне DB transaction. Guarded exact-link
transaction повторно проверяет checkout/control version, fence, CancelGuard и
равенство множества orderRef в proof refs frozen CheckoutSnapshot: без пропусков,
лишних Orders, duplicate refs или partial line coverage. В той же transaction
сохраняются все N revenue proof refs и N durable publication intents в Orders
вместе с одним существующим invoice materialization Outbox handoff и link/
exclusion/revisions — всё или ничего. Каждый intent сохраняет immutable Locked
customer facts/ref/hash и element identity до публикации. Durable intent — не
опубликованный факт и не завершённая Pricing projection.
Rollback/rejected/stale link не создаёт ни одного committed revenue intent/fact;
orphan bytes не business proof, cleanup учитывает retention/holds/pending intents.

Normal element identity в Orders — (checkoutSnapshotRef, orderRef,
orderVersionAtCheckout). Source snapshot proof identity и hash/ArtifactRef binding
immutable: тот же content возвращает сохранённый messageId/ref; иной hash либо
несовместимая frozen version даёт conflict/correction, не новый normal факт и не
overwrite. Correction требует отдельного принятого versioned contract, не random
identity в обход dedupe. Каждый element имеет собственный stable messageId,
orderRef key/aggregate и owner version, общую checkout correlation и исходную
causation. Эти значения фиксируются в intent до публикации. #76 материализует
единственные wire type/topic/schema names.

### D2b: durable publication до установки Pricing consumer

Пока #86 не принят и не установлен, revenue publication выключена. Checkout
link, invoice materialization и ранний header продолжаются без ожидания #86/PDF.
Pending revenue не ставится в общий Outbox и не резервирует aggregate_sequence:
заблокированная revenue row не должна задержать последующие owner rows.
#80 принимается на isolated accepted fixtures #76 до #86. Обратной implementation
дуги #86→#80 нет.

#76 определяет versioned activation/compatibility contract и exact identities.
#77 материализует явную activation в config/platform.yaml/schema/runbook.
Этот ADR не вводит config key или wire type. HTTP health consumer не разрешает
публикацию автоматически. После явной activation bounded scheduler/startup
sweep того же orders-checkout-worker возобновляет intents. Короткая Orders
transaction атомарно переводит intent в staged и enqueue-ит его через существующий
owner Outbox #63. Переход и Outbox row коммитятся вместе. Непрерывный
aggregate_sequence назначается в существующем Outbox пути только при enqueue,
не как индекс Order или frozen version; второго счётчика нет.

Promotion переносит committed immutable historical fact. Она не выполняет
checkout заново и не повторяет exact-link guards по изменившемуся текущему Order.
Повреждённый сохранённый proof требует explicit review, не пересчёта по текущей
quote. Restart/crash до и после enqueue commit не теряет intent и не создаёт
второй normal fact; stable messageId/ref/hash/business identity сохраняются.
Непоставленные intents и proof bytes нельзя удалять по Kafka retention, обычной
очистке опубликованного Outbox или orphan cleanup. Bounded paging/lease/retry и
backlog count/age/reason используют accepted #71/#77/#121 budgets. Исчерпание
durable capacity вызывает backpressure до нового необратимого действия, не
silent drop или повышение limits.

Rollback сначала выключает promotion новых revenue intents. Совместимый consumer
обслуживает уже staged/in-flight rows до доказанного drain/replay horizon.
Consumer нельзя удалить, сбросить offsets/Inbox или объявить rollout завершённым
при непроверенном остатке. Обычная длительная эксплуатационная потеря consumer
остаётся предметом existing retention/recovery policy. #86 проверяет оба порядка
revenue/cost и независимый per-order dedupe; #90 доказывает живой catch-up.

Pricing fetch/size/hash/type/schema validation выполняется вне DB locks; затем
Inbox + consumed proof + projection атомарны для каждого Order независимо.
Duplicate одного Order не подавляет другой. Producer exact-link transaction
гарантирует полноту набора, cross-owner lookup не добавляется. Revenue-before-cost
и cost-before-revenue поддерживаются; до обоих proofs соответствующего Order
маржа pending/review, missing revenue не ноль. Supplier cost/actual delivery не
изменяют Locked customer agreement.

## IO, health и enforcement

Точная matrix типов — [W2 ArtifactRef](../wave-2/02_RUNTIME_TOPOLOGY.md#artifactref-сканирование-и-восстановление).

- orders-checkout-worker: ready write checkout-allocation + revenue proof;
  без quarantine read/provider egress.
- aroma-checkout-poller: ready write только orders-invoice-source-proof;
  Gateway через internal API, без provider direct; ready storage обязателен.
- invoice-intake: ready read checkout-allocation + source-proof, без write;
  ready storage обязателен.
- invoices-command-handler: ready read checkout-allocation; без provider/Pricing grants.
- orders-invoice-consumer: header-only без artifact dependency; financial
  phase ready read только invoice-price-proof для apply, durable intake/header
  продолжаются при storage outage в bounded profile по D1b.
- pricing-cost-worker: ready read только revenue + invoice-price-proof;
  denied checkout-allocation, supplier PDF и source-proof.

#77 материализует connections/permissions и stage-specific health;
#78 — owner/type/version/namespace/hash/schema enforcement. Network membership
не generic storage capability. Trusted owner-generated JSON не ждёт scanner;
внешний uploaded JSON не становится trusted proof переименованием. External
PDF остаётся quarantine до #122, delivery #123 и financial proof #82.

## Отвергнутые варианты и будущие проверки

Отвергнуты второй header consumer в orders-service, ожидание #83 для раннего
header, quarantine-and-skip валидного будущего financial record, бесконечный retry
partition, обратная implementation dependency #82←#83, Invoices writer в Orders
DB, широкий Pricing checkout grant, неполный checkout revenue fact, копия customer
pricing policy, bytes в Kafka и новый service/DB/общая parking queue. Косметический
health flag при синхронном storage fetch в partition handler не решает D1b.

Будущие owner acceptance обязаны доказать header без PDF/payment,
duplicate/stale revision без projection rollback, #83 reuse без потери header,
Pricing denied checkout/PDF, wrong owner/type/hash, duplicate/corrected proof,
no revenue до exact-link commit, оба порядка revenue/cost и immutable Locked
price. Это требования #76/#77/#78/#80/#81/#83/#86 и итогового #90, не выполненные
runtime tests этой документационной поставки. Уточняющие cases
[A20–A26](../wave-2/01_AROMA_SUPPLIER_INVOICES.md#acceptance-scenarios) закрепляют
#76/#77/#80/#82/#83/#86/#90: accepted-not-active/installed-before-activation,
restart/rollback/in-flight, multi-order completeness/idempotency/limits/rollback,
financial→header в одной partition при storage outage, pending catch-up,
corrupt proof и bounded all-or-nothing per-order payment apply. Для двух Orders
нужны два requirements; один invalid Order запрещает новые effects всего набора.
[A27–A28](../wave-2/01_AROMA_SUPPLIER_INVOICES.md#acceptance-scenarios) требуют
link без #86, задержку дольше Kafka retention/Outbox cleanup, сохранность всех N
refs/intents, activation/catch-up, crash по обе стороны enqueue commit, rollback
с in-flight, header progress и bounds. Зелёный documentary lint не исполняет tests.
