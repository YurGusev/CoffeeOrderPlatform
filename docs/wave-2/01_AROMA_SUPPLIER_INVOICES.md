# Счёт поставщика AROMA: реквизиты, связь с Orders и восстановление

Статус документа: целевой логический контракт второй волны. Этот документ
описывает границы владельцев, наблюдаемые состояния, durable handoff и
acceptance-сценарии. Он не утверждает, что provider API, invoice polling,
хранилище артефактов или runtime уже реализованы.

Документ продолжает первый запуск после точной привязки supplier checkout к
неизменяемому `CheckoutSnapshot`. Его задача — не создавать заказ или платёж,
а сохранить проверяемое evidence о счёте поставщика и передать его в Invoices.

## Источники и область действия

- [M11: checkout и wholesale contract](../CoffeeOrderSystem_CANONICAL_Architecture_EndToEndHardened_RU_2026-08-19/M11_AROMA_GATEWAY/04_AROMA_CHECKOUT_WHOLESALE_CONTRACT.md)
- [M11: checkout cancel race и compensation](../CoffeeOrderSystem_CANONICAL_Architecture_EndToEndHardened_RU_2026-08-19/M11_AROMA_GATEWAY/08_CHECKOUT_CANCEL_RACE_AND_COMPENSATION.md)
- [M10: ownership и materialization](../CoffeeOrderSystem_CANONICAL_Architecture_EndToEndHardened_RU_2026-08-19/M10_INVOICES/01_INVOICES_MIGRATION.md)
- [M10: checkout → invoice → price proof](../CoffeeOrderSystem_CANONICAL_Architecture_EndToEndHardened_RU_2026-08-19/M10_INVOICES/02_CHECKOUT_MATERIALIZATION_AND_PRICE_PROOF.md)
- [M10: allocation manifest и price proof](../CoffeeOrderSystem_CANONICAL_Architecture_EndToEndHardened_RU_2026-08-19/M10_INVOICES/03_ALLOCATION_MANIFEST_AND_PRICE_PROOF_CONTRACT.md)
- [M10: invoice compensation](../CoffeeOrderSystem_CANONICAL_Architecture_EndToEndHardened_RU_2026-08-19/M10_INVOICES/04_INVOICE_COMPENSATION_STATE_MACHINE.md)
- [M08: Payments ownership и handoff](../CoffeeOrderSystem_CANONICAL_Architecture_EndToEndHardened_RU_2026-08-19/M08_PAYMENTS/01_PAYMENTS_ARCHITECTURE.md)
- [границы первого запуска](../launch/00_SCOPE_AND_DECISIONS.md)
- [ownership данных](../launch/05_DATA_OWNERSHIP.md)
- [каталог первых контрактов](../launch/12_LAUNCH_CONTRACT_CATALOG.md)
- [граф поставки](../launch/13_DELIVERY_DEPENDENCY_GRAPH.md)
- [ADR-0033: header phases и revenue grants](../adr/ADR-0033-wave2-header-revenue-boundaries.md)

Первый запуск заканчивается без оформления invoice поставщика, PDF
materialization и customer payment. Эти функции являются второй волной. Наличие
этого документа не меняет exact-15 runtime, exact-5 database или launch
contracts.

## Владение и неизменяемые границы

### Orders

Orders владеет:

- Order lifecycle и guarded cancellation;
- profile-level checkout orchestration;
- frozen составом заказа и `Desired` contributions;
- `CheckoutSnapshot`, frozen source allocations, final
  `CheckoutAllocationManifest`, `DesiredRevision` и `WholesaleSnapshot` link;
- durable timer для ожидания wholesale/invoice observation;
- решением о точности link и staging следующего durable handoff.

После exact wholesale link одна Orders transaction исключает frozen/consumed
contributions из active `Desired` и продвигает ревизии. Повторная convergence
не должна заново добавить эти contributions в новую закупку. Новый Order не
включается в уже frozen checkout.

Orders не создаёт `ClientInvoice`, не изменяет invoice header/status и не
вычисляет supplier allocation по сумме счёта.

### Integration/AROMA Gateway

Gateway владеет provider session и транспортом. Только Gateway выполняет
разрешённый provider read и возвращает Orders нормализованное наблюдение. В
этом документе не называются URL, HTTP method, provider status, поля авторизации
или submit endpoint: их нет в принятом контракте.

Нормализованное наблюдение — логическое сообщение, а не опубликованная wire
схема. Оно содержит как минимум:

- `observationRef` и время наблюдения;
- `providerAccountScope`;
- `wholesaleOrderRef` и, если имеется, `wholesaleOrderNumber`;
- результат наблюдения: отсутствие кандидата, один кандидат, неоднозначность,
  partial или ошибка транспорта;
- реквизиты header, если provider их вернул: supplier invoice ref/number,
  amount и currency;
- `sourceProofRef` на сохранённое Orders-owned normalized observation и его
  hash. Для принятого invoice header эта ссылка обязательна; Gateway только
  возвращает normalized response и не создаёт accepted invoice proof.

Gateway не пишет Orders или Invoices database и не решает, к каким Orders
относится счёт.

### Invoices

Invoices — единственный владелец и writer:

- supplier invoice header и его revisions;
- `ClientInvoice`, invoice lines и allocations;
- document/PDF metadata и materialization state;
- price-application proof;
- reconciliation и invoice compensation state.

Invoices принимает только self-contained durable handoff от Orders. Он не читает
Orders DB и не обращается к AROMA. Header/status/history authority не
дублируется в Orders: разрешена только revision-guarded read projection
invoice summary, не второй writer invoice truth.

### Payments, Pricing и UI

Invoices не инициирует payment/refund. После проверенного `InvoicePricesApplied`
Orders формирует server-owned payment requirement, а Payments действует по своим
контрактам. Supplier invoice total не становится payable amount каждого Order.

Pricing получает owner-derived фактическую себестоимость после достаточного
supplier proof. UI читает owner-derived projections и не обращается к AROMA из
браузера.

## Раздельные ссылки и identity

Следующие значения нельзя взаимозаменять:

| Сущность | Смысл |
| --- | --- |
| `wholesaleOrderRef` | стабильная ссылка на supplier wholesale order |
| `wholesaleOrderNumber` | отображаемый номер supplier wholesale order |
| `supplierInvoiceRef` | стабильная provider invoice identity, если provider её даёт |
| `supplierInvoiceNumber` | номер счёта для отображения и поиска в контексте provider account |
| `clientInvoiceRef` | внутренний идентификатор записи Invoices |
| `checkoutSnapshotRef` | immutable snapshot закупочного состава |
| `orderRef` / `orderItemRef` | Orders и его конкретная строка |
| `observationRef` | отдельное наблюдение Gateway, не invoice identity |

Номер заказа и номер счёта поставщика — разные значения. Номер счёта сам по
себе никогда не является глобальным dedupe key.

### Две независимые idempotency identity

1. Пара `(providerAccountScope, supplierInvoiceRef)` является identity счёта
   поставщика, когда стабильный `supplierInvoiceRef` действительно получен и
   доказан provider. Это не idempotency key каждого observation. Повторные
   observations имеют собственные `observationRef` и payload hash; одинаковый
   semantic snapshot не создаёт новую header revision. Одинаковый номер в
   разных account scopes — разные кандидаты. Если стабильная provider identity
   отсутствует или противоречит ранее сохранённой, header можно сохранить как
   immutable observation с source proof, но автоматическая привязка не
   выполняется: создаётся review.
2. Для materialization normal path canonical identity задаётся логически как
   `profile + checkoutSnapshotRef + wholesaleSnapshotRef`. Повтор того же
   payload должен resume/reuse ту же materialization, а изменённый payload с
   той же identity — conflict/review. В canonical prose это поле названо
   `operationRef`, тогда как machine schema использует `invoiceOperationRef`.
   Точное wire-имя является входом отдельного W2 contracts handoff и здесь не
   объявляется решённым; две параллельные identity вводить нельзя.

Все dedupe keys проверяются в локальной транзакции владельца. Retry доставки не
создаёт новую invoice, allocation, header revision или связь с Order.

## Manifest-first flow и поздний header

### 1. Freeze и exact wholesale link

До freeze Orders проверяет профиль, lease/fencing, expected control version,
`Desired == Observed`, свежие cart/wholesale reads и отсутствие in-flight или
`UnknownOutcome` mutation. Freeze создаёт immutable `CheckoutSnapshot`,
`SourceAllocations`, `WholesaleBaseline`, `ConvergenceProofHash`,
`DesiredRevision`, `ObservedSnapshotRef` и `FencingToken`. Финальный
`CheckoutAllocationManifest` ещё не создаётся: на этой стадии exact
`WholesaleSnapshot` отсутствует.

Freeze не посылает provider cart mutation. Provider-side оформление закупки и
его operational runbook остаются отдельным W2 contract. До доказанного submit
primitive допускается только контролируемый внешний/операторский шаг с
последующим безопасным наблюдением и exact matching.

После exact candidate Orders сначала собирает финальный
`CheckoutAllocationManifest` из frozen sources и exact `WholesaleSnapshot` и
сохраняет его immutable bytes в Artifact Storage **вне** DB transaction. После
проверки ArtifactRef/hash Orders выполняет одну local transaction, которая:

1. сохраняет `WholesaleSnapshot`, manifest ArtifactRef и связь с frozen checkout;
2. исключает frozen Desired sources из active cart;
3. продвигает соответствующие revisions и открывает профиль;
4. ставит durable `InvoiceMaterializationRequested` handoff для Invoices.

Artifact bytes не записываются внутри этой Orders transaction. Если transaction
повторяется после успешной записи artifact, используется та же logical
checkout/wholesale identity и тот же manifest, а не новый supplier submit.
Перед commit exact link эта transaction повторно проверяет current
checkout/control version, fencing token и отсутствие изменившегося
`CancelGuard`. Длительная запись artifact не продлевает старое разрешение на
link; при guard или version failure artifact не даёт права открыть профиль или
исключить sources.

Ноль кандидатов оставляет checkout в ожидании, больше одного или mismatch
блокируют автоматический link. Candidate, появившийся во время CancelGuard,
переходит в явный compensation/review путь, а не теряется.

### Locked revenue handoff (#80 → #86)

По ADR-0033 `orders-checkout-worker` отдельно сохраняет write-once target
`order-revenue-proof.v1` вне DB transaction для каждого из N frozen Orders:
N artifacts, каждый содержит свой frozen order/checkout/version,
currency, Locked customer line/order totals, полное coverage/hash и source
snapshot proof identity. Это не существующая schema: её публикует #76.
Wholesale/provider payload, credentials/URL, Customer PII и текущая quote
исключены; сумма не пересчитывается и не берётся из supplier invoice.
Та же guarded exact-link transaction после version/fence/CancelGuard check
проверяет равенство orderRef set всех proof refs frozen CheckoutSnapshot, без
omitted/extra/duplicate refs или partial line coverage. Весь набор revenue refs
и N Orders→Pricing Outbox facts сохраняется атомарно с одним invoice handoff,
link/exclusion/revisions. Rollback/rejected/stale link не публикует ни одного
revenue fact; bytes остаются orphan, не proof commit.

Normal identity элемента — (checkoutSnapshotRef, orderRef, orderVersionAtCheckout)
в Orders, с immutable source snapshot proof identity/hash/ArtifactRef binding.
Same content повторяет сохранённый messageId/ref; иной hash/frozen version —
conflict/correction, не новый normal факт. Correction требует отдельного
принятого versioned contract, не random identity. Собственный stable messageId,
orderRef key/aggregate и owner version каждого элемента сохраняют общую checkout
correlation/исходную causation. #76 задаёт единственные wire names; общий Outbox
#63 aggregate_sequence — непрерывный delivery counter по aggregate, не индекс
Order в checkout/frozen version, без второго счётчика.
Pricing `pricing-cost-worker` имеет только type-scoped ready read revenue и
invoice-price-proof, не полный allocation manifest/PDF/source-proof; checkout
ref/hash — correlation, не read capability. Validation вне DB locks, затем
Inbox/proof/projection атомарны отдельно для каждого Order. Duplicate одного не
подавляет другой; revenue-before-cost/cost-before-revenue поддерживаются, до обоих
proofs соответствующего Order маржа pending/review, не ноль. Producer transaction
гарантирует completeness без cross-owner lookup.
Trusted generated JSON не ждёт scanner. Retention/pending intents защищают
bytes при cleanup. Maximum checkout Orders/items/allocations #76 и bounds #71/#77
до freeze/повторно перед link, каждый proof ≤1 MiB/envelope+payload ≤64 KiB и
owner transaction budgets сохраняются, без truncation/повышения limits или
разбиения в обход общего checkout bound.

### 2. Self-contained allocation manifest

Orders создаёт immutable `CheckoutAllocationManifest` после exact wholesale
match и до staging handoff. Manifest собирается из frozen source allocations и
проверенного wholesale proof; до этого freeze сохраняет только источники и
baseline. Для каждой allocation сохраняются как минимум `orderRef`,
`orderVersionAtCheckout`, `orderItemRef`, quantity, wholesale line reference,
внешние offer references и supplier unit price, если он был доказан.

Manifest содержит `checkoutSnapshotRef`, `wholesaleSnapshotRef`, profile,
checkout version, proof hash, wholesale reference/number, observed timestamp,
currency и immutable ArtifactRef с hash, byte size и schema version. Полный
manifest является источником связей, а не совпадение суммы, даты или текста
номера счёта.

Invoices сначала загружает bytes по ArtifactRef с ограниченным бюджетом вне DB transaction и
проверяет metadata, byte size, hash и `checkout-allocation-manifest.v1` schema.
Только после успешного fetch/validation локальная DB transaction:

1. принимает Inbox identity и verified artifact proof;
2. проверяет отсутствие duplicate allocation и полное покрытие frozen lines;
3. сверяет quantity sums с wholesale snapshot из handoff/proof;
4. создаёт или восстанавливает `ClientInvoice` и exact allocations;
5. сохраняет manifest evidence и записывает `InvoiceMaterialized` в Outbox.

Artifact bytes не читаются через Orders DB и не записываются в эту транзакцию.

Invoices не делает cross-owner lookup, чтобы восполнить недостающие поля.
Недостаточный manifest — contract failure/review, а не повод читать Orders DB.

### 3. Header observation

Header может прийти позже manifest. Invoices создаёт запись с уже известными
links/allocations и сохраняет header state «Ожидаем реквизиты счёта». При
durable получении точной header связки:

- сохраняются `supplierInvoiceNumber`, amount в minor units и currency;
- сохраняются provider account scope, wholesale/checkout refs, observation time,
  обязательный Orders-owned `sourceProofRef` на normalized observation и новая
  header revision;
- создаётся связь header с immutable manifest и его Orders;
- отображается ранний статус **«Счёт в работе»**.

До записи header Invoices с ограниченным бюджетом загружает `sourceProofRef` и проверяет
сохранённый normalized observation/hash вне DB transaction. Local transaction
принимает только проверенный source proof; Gateway response без такого durable
proof не может стать принятым header.

`sourceProofRef` передаётся как immutable ArtifactRef с hash/size/schema metadata
и разрешением чтения из Artifact Storage. Это не ссылка на Orders API или БД;
получение proof не создаёт межвладельческий «добор» бизнес-данных.

Для этого раннего статуса не требуются PDF, завершённый parsing, price proof или
оплата клиента. Условиями являются durable header с номером/суммой/валютой и
точная связь с конкретным wholesale checkout и его Orders. При известном header,
но неизвестной доле конкретного Order, invoice остаётся «Счёт в работе», а
распределение этого Order имеет `null` share и отображается как
**«Распределение ожидается»**.

`«Счёт в работе»` — внутренний owner-derived статус Invoices, а не provider
status. Он не означает `InvoicePricesApplied`, `AwaitingCustomerPayment`,
customer payment или supplier fulfillment. Document/PDF, distribution и price
proof — отдельные orthogonal states.

### 4. Header раньше manifest или out-of-order delivery

Если Gateway observation с header пришёл раньше manifest, Invoices сохраняет
неизменяемое observed header в provider account scope с состоянием
`Ожидаем checkout link`. До получения и проверки manifest он:

- не создаёт автоматические `invoice → order item` allocations;
- не использует сумму/дату/номер для угадывания Orders;
- не выставляет «Счёт в работе» для связанного заказа;
- сохраняет observation и обязательный `sourceProofRef` для последующего exact
  correlation или review.

Когда manifest приходит позднее, Invoices применяет header только если совпадают
provider account scope и доказанные wholesale/checkout references. Иначе создаётся
новая reconciliation revision и review.

Для любого out-of-order или duplicate handoff действуют правила:

- обработка Inbox и materialization identity идемпотентна;
- повтор с тем же `observationRef` и payload hash — no-op;
- новый `observationRef` с тем же normalized payload hash и той же invoice
  identity — только новый delivery audit, без новой header revision;
- старые значения не перезаписывают уже принятые evidence;
- изменение amount, currency, supplier identity или состава получает новую
  append-only revision;
- downstream price/payment proof не заменяется автоматически и не превращает
  неполный header в verified proof.

## Логическая модель header и связей

### SupplierInvoiceHeader

| Поле | Правило |
| --- | --- |
| `providerAccountScope` | обязательный scope provider account; участвует в dedupe и поиске |
| `supplierInvoiceRef` | стабильная provider identity, если доказана; не подменяется номером |
| `supplierInvoiceNumber` | номер для отображения; не глобальный key |
| `amountMinor` | сумма header в целых minor units; источник и currency сохраняются вместе |
| `currency` | обязательна для статуса «Счёт в работе» |
| `wholesaleOrderRef` / `wholesaleOrderNumber` | refs supplier order; не invoice refs |
| `checkoutSnapshotRef` / `manifestRef` | immutable закупочная связь и ArtifactRef |
| `observedAtUtc` | время конкретного наблюдения |
| `invoiceDate` | дата счёта только если provider её дал; отсутствие не выдумывается |
| `sourceProofRef` | обязательная для принятого header ссылка на сохранённое Orders-owned normalized observation и его hash |
| `normalizedPayloadHash` | hash semantic normalized snapshot; новый observation с тем же hash не создаёт новую header revision |
| `headerRevision` | монотонная локальная revision; прежние evidence не удаляются |

Сумма в header не распределяется автоматически по Orders. Клиентские цены не
переписываются. Discounts, delivery, tax, rounding и allocation formula должны
быть материализованы отдельным W2 contract; этот документ сохраняет наблюдение и
обозначает неизвестную долю как `null`.

### InvoiceAllocation

Одна supplier invoice может объединять несколько Orders. Нормальный order-atomic
путь сохраняет не более одного активного normal checkout/invoice на Order, но
один invoice может иметь много `orderRef`.

Каждая связь содержит:

- `orderRef`, `orderVersionAtCheckout`, `orderItemRef`;
- `allocationRef`, `wholesaleLineRef` и quantity;
- доказанную закупочную долю в minor units, если она уже рассчитана;
- `allocationStatus` с отдельным состоянием ожидания, review или applied;
- ссылки на manifest/header/price evidence.

Если header total известен, а доля Order ещё нет, amount доли равен `null` и
`allocationStatus` показывает «Распределение ожидается». Ноль означает доказанную
нулевую долю и не используется как placeholder. Общая сумма supplier invoice
никогда не копируется в payable amount каждого Order.

### Orthogonal proof states

Логические проекции показывают раздельно:

- `header`: ожидается / сохранён / review;
- `distribution`: ожидается / применено / review;
- `document`: не получен / получен / обработан / quarantine или review;
- `priceProof`: не применён / применён / review;
- `compensation`: `None`, `Requested`, `Processing`, `Completed`, `Failed`,
  `ManualReview`.

Точные wire enum names закрепляются W2 contracts. Ранний header не продвигает
`priceProof`, payment или Order lifecycle. После price proof unlink запрещён;
коррекция/credit evidence добавляется поверх immutable allocations.

## Durable polling и recovery

Orders хранит durable ожидание, по меньшей мере с profile/checkout/wholesale
correlation, next-attempt metadata, последним успешным observation или его
proof-ref, текущей revision и причиной review. Значения интервалов, deadline и
lease window не задаются здесь и вносятся только через утверждённый
`config/platform.yaml` в будущем runtime issue.

Алгоритм ожидания:

1. после exact link Orders коммитит link, исключение consumed Desired и
   планирование timer в одной local transaction;
2. scheduler после restart поднимает durable timer и просит Gateway выполнить
   только разрешённый safe GET;
3. Gateway возвращает нормализованное observation, не меняя owner state;
4. Orders сохраняет normalized observation и его payload hash как immutable
   source proof в своей owner boundary, проверяет correlation/fence и передаёт
   self-contained header с обязательным `sourceProofRef` в Invoices через
   durable Outbox;
5. Invoices bounded-fetches и проверяет source/manifest proofs до DB transaction,
   затем применяет Inbox + header/links в своей local transaction;
6. временная ошибка сохраняет last successful observation и следующее durable
   ожидание; partial response не считается полным header;
7. отсутствие кандидата продолжает ожидание, ambiguous/mismatch/provider identity
   conflict переводит в operator-visible review;
8. restart или duplicate delivery не создаёт новый submit, invoice или link.

Провайдерский submit не является частью этого алгоритма. После provider
UnknownOutcome нельзя повторять небезопасную mutation; сначала требуется
provider lookup/reconciliation и явное решение. При наличии только safe GET
неизвестный результат чтения сохраняется как observation/review, а не
интерпретируется как отсутствие счёта.

### Изменение header после раннего статуса

Изменение суммы, валюты, состава, account scope или provider identity:

- сохраняет старый header и его source proof;
- создаёт новую revision и reconciliation/review;
- не перезаписывает accepted price/payment proof;
- не переводит автоматически Order назад и не меняет клиентскую цену;
- требует отдельной compensation/correction policy до любого irreversible
  действия.

После supplier proof обычный generic checkout cancel не используется. При race
или supplier-side irreversibility сохраняется explicit compensation link между
Orders/Invoices/Payments и ручное решение, если provider не даёт cancellation
primitive.

## UI projection contract

Ранний Orders-owned handler #81 — только в существующей target роли
`apps/orders-invoice-consumer/src/main.ts`, principal `coffee_orders_invoice_rw`
(pool 4), materialized #77. Проверив identity/correlation/invoice revision,
он атомарно пишет Orders Inbox + summary + OrderCard.projectionVersion +
Orders Outbox invalidation. Header phase требует DB/Kafka, не PDF store/scan
и не #82/#83/#84; не создаёт payment requirement и не меняет payable amount
или lifecycle. #83 принимает #81 handoff и расширяет ту же роль финансовым
InvoicePricesApplied handler/read invoice-price-proof; header handler и
subscription/group identity не заменяются. #76 публикует один mapping;
второй consumer в orders-service и Invoices writer в Orders DB запрещены.

### Financial activation и durable apply (#82/#83)

По D1a ADR-0033 #82 fixture/merge acceptance не активирует producer в общей
среде. До принятого установленного #83 price application/InvoicePricesApplied
выключены: document input/intents durable в Invoices, applied proof/его Outbox
не коммитятся. Заблокированной financial Outbox row перед header нет. Isolated
accepted fixture receiver #76 позволяет принять #82 до #83 без обратного DAG
ребра. Затем #83 устанавливает dual-capable intake/recovery, явная activation
идёт по versioned contract #76 и #77 config/platform.yaml/schema/runbook с
последующим #90 live gate, не автоматически по HTTP health.
После activation сохранённые intents с теми же identities завершаются одной
Invoices transaction price application/proof ref/Outbox. Restart не раздваивает
факт. Rollback сначала останавливает producer; consumer сохраняется для
опубликованных/in-flight records и pending jobs, header-only downgrade запрещён
до доказанного drain/replay horizon, offsets/Inbox не сбрасываются.

По D1b #83 принимает валидный financial envelope через Inbox в одной Orders
transaction с immutable envelope/ref/hash/correlation и pending financial job;
transport acceptance/offset только после известного commit. Inbox Processed —
durable acceptance, не verified price proof/AwaitingCustomerPayment. Handler
без pending row не может успешно завершиться. Owner-local job, не новая роль/
shared queue, хранит stable message/business identity, refs/hash/version,
next-at/attempts/reason и lease/fence. В том же процессе bounded scheduler/startup
sweep восстанавливает jobs после restart/store recovery, duplicate intake не
создаёт второй job, terminal job не исполняется снова.

Fetch/size/hash/type/schema/Ready validation вне DB locks. Новая короткая Orders
transaction повторно проверяет correlation/current frozen version, coverage,
amount/currency, cancellation и job lease/version; verified consumed proof +
guarded lifecycle/requirement/history/projection/Outbox + terminal outcome
атомарны. Crash после commit до ACK/retry не повторяет requirement. Corrupt/
wrong owner/type/hash/stale proof — review/conflict без payment effect; storage
outage — durable pending/retry по accepted budgets, не retry внутри Kafka handler
и не transport replay уже Processed Inbox для apply.

После #83 общая /health/ready требует Orders DB + Kafka/Inbox + bounded capacity
header/durable financial intake. Только artifact-ready outage делает financial
apply readiness false/degraded с reason/backlog age, не header: financial record
→ header в одной partition продолжает intake после сохранения job в принятом
profile. Financial fetches не исчерпывают header capacity, нет starvation/
неограниченной RAM queue; backlog/count/age/horizon по #71/#77/#121 наблюдаемы.
Исчерпание безопасной durable DB/disk capacity даёт честный backpressure/not-ready
без потери, не обещание бесконечной независимости. /health/live dependency-free;
mandatory storage остальных ролей не отменяется. Header/financial revision guards
ортогональны: поздний header не откатывает financial state. #81 реализует только
ранний header, не будущие pending jobs/storage dependency #83.

UI получает данные из owner-derived Invoices/Orders projection. Браузер не делает
provider запрос и не использует номер счёта как глобальный поиск.

### Order Card

Показывает:

- supplier invoice number и provider/account context;
- внутренний статус «Счёт в работе» или «Ожидаем реквизиты счёта»;
- supplier currency и общую сумму header, если она доказана;
- отдельную долю текущего Order или «Распределение ожидается»;
- document/price-proof/payment состояния раздельно, без вывода о supplier
  fulfillment из customer payment.

### Invoice view и поиск

Invoice view показывает все связанные Orders, строки manifest, allocation status,
header revision и source/proof state. Поиск по номеру всегда ограничивается
`providerAccountScope` и показывает возможные review/conflict markers.

Если связь неоднозначна или provider identity отсутствует, UI показывает
operator-visible review и сохраняет последнее accepted evidence. Он не предлагает
автоматически выбрать Order по одинаковой сумме, дате или тексту номера.

## Acceptance scenarios

| ID | Вход и порядок доставки | Обязательный durable результат | Запрещённый результат / recovery |
| --- | --- | --- | --- |
| A1 | Wholesale появился после exact freeze | Orders вне DB transaction сохраняет final manifest artifact из frozen sources + wholesale proof, затем atomic link/exclusion/timer/Outbox; Invoices создаёт запись «Ожидаем реквизиты счёта» | Не писать artifact bytes в Orders transaction, не отправлять повторный cart submit и не создавать invoice по одному `OrderConfirmed` |
| A2 | Header пришёл только с номером | Observation сохранено append-only; статус остаётся ожиданием полного header | Не считать номер, сумму или payable amount доказанными |
| A3 | Получены валидные номер, amount, currency, exact checkout link и Orders-owned source proof, PDF отсутствует | Invoices durable записывает header и показывает «Счёт в работе»; document/PDF и priceProof остаются pending | Не требовать PDF; не принимать header без source proof и не объявлять price proof, оплату или supplier fulfillment |
| A4 | Один supplier invoice содержит несколько Orders | Одна invoice запись связана с несколькими `orderRef` через manifest allocations | Не создавать отдельный invoice на каждый Order из общей суммы |
| A5 | Header total известен, доля Order неизвестна | Allocation share остаётся `null`, UI показывает «Распределение ожидается» | Не записывать ноль и не копировать общий supplier total в Order |
| A6 | Повторен тот же checkout/wholesale snapshot и payload | Inbox/materialization resume/reuse; нет новой invoice, allocation или header revision | Не дублировать записи на retry |
| A7 | Один номер счёта пришёл из двух provider account scopes | Каждая scope-пара рассматривается отдельно и сохраняет собственное evidence | Не дедуплицировать глобально по номеру |
| A8 | Header с тем же provider identity меняет total или currency | Новая append-only revision и reconciliation/review; старое evidence сохранено | Не перезаписывать accepted proof и не менять клиентскую цену автоматически |
| A9 | Wholesale candidates отсутствуют, неоднозначны или mismatch baseline | Orders сохраняет ожидание/blocked/review и durable timer; Invoices не получает ложную связь | Не выбирать candidate по сумме, дате или номеру |
| A10 | Restart во время ожидания header | После restart поднимается тот же timer, last observation и correlation; следующий safe GET идемпотентен | Не терять запланированную проверку и не создавать новый submit |
| A11 | Header observation доставлен раньше allocation manifest | Invoices сохраняет unlinked observed header в account scope; allocations/status для Orders не создаются | Не угадывать Orders по номеру, сумме или дате |
| A12 | Manifest доставлен раньше позднего header | Invoices создаёт/resumes allocations и ждёт реквизиты; поздний exact header переводит projection в «Счёт в работе» | Не блокировать manifest до PDF и не создавать вторую invoice |
| A13 | Duplicate или out-of-order observations | Тот же `observationRef` + payload hash — Inbox/no-op; новый `observationRef` с тем же normalized payload hash и invoice identity — delivery audit без новой header revision | Не считать account+invoice identity idempotency каждого observation, не менять header задним числом и не продвигать proof из неполного сообщения |
| A14 | Gateway вернул partial/temporary error после успешного observation | Сохраняются last success, причина и следующее durable ожидание; partial не считается header | Не очищать последний валидный header и не трактовать неизвестный read как отсутствие счёта |
| A15 | Exact candidate появился во время CancelGuard | Orders переводит ситуацию в explicit `WholesaleLinked/CompensationRequired` и сохраняет proof | Не игнорировать поздний candidate и не выполнять generic delete |
| A16 | Exact link завершён, затем снова запускается convergence | Consumed frozen contributions исключены из active Desired; новый Order не попадает в старый frozen checkout | Не наполнить cart уже закупленными позициями |
| A17 | Invoices получил handoff без self-contained manifest или с неверным hash | Bounded fetch/metadata/hash/size/schema validation до DB transaction отклоняет/ставит review; cross-owner read запрещён | Не делать SQL/HTTP добор из Orders или AROMA и не записывать непроверенный artifact в DB transaction |
| A18 | Header уже имеет price/payment evidence, затем приходит correction | Исходные allocations/proofs immutable; создаётся correction/compensation review | Не unlink/delete историю и не воскресить Cancelled Order |
| A19 | UI ищет номер, одинаковый в разных scopes | Результаты разделены account context и показывают review markers | Не смешивать supplier invoices разных scopes |
| A20 | #81 header-only и accepted-not-active #82, затем установка #83 | #82 document intents durable, price application/financial Outbox выключены до явной activation после installed accepted #83; isolated fixtures #76 доказаны отдельно (#76/#77/#82/#83/#90) | Не quarantine/skip валидный future record, не бесконечный retry partition и не blocked financial Outbox перед header; #81/#88 не ждут #83, DAG без reverse edge |
| A21 | Activation, restart или rollback с financial records в полёте | Те же Invoices intent identities; application/proof ref/Outbox атомарны. Rollback producer-off первым, dual consumer и pending jobs сохраняются до drain/replay horizon (#77/#82/#83/#90) | Не applied proof без handoff, не header-only downgrade до drain, не сброс offsets/Inbox |
| A22 | Checkout с двумя и более frozen Orders; omitted/extra/duplicate ref или неполное line coverage | N per-order artifacts/facts, точное множество frozen Orders; guarded exact-link refs/N revenue rows/один invoice handoff/link/exclusion/revisions all-or-nothing (#76/#80/#90) | Ошибка coverage/version/fence/CancelGuard или transaction rollback не публикует ни одного revenue fact; orphan bytes не commit |
| A23 | Wrong hash/frozen version, duplicate/crash/redelivery, oversized checkout/proof/envelope | Stable per-element identity/messageId/ref, conflict/correction при другом content; все checkout и byte/tx bounds соблюдены. Pricing duplicate Order не подавляет другой, оба порядка revenue/cost сохраняют per-order pending до обоих proofs (#76/#80/#86/#90) | Не random identity в обход dedupe, не второй sequence/registry, не splitting/truncation/повышение limits; Locked agreement неизменен |
| A24 | Storage outage: financial record, затем header в одной Kafka partition | Inbox+immutable refs+owner pending job commit до offset; header продолжает progress, financial apply degraded, backlog reason/age видны в bounded profile (#77/#83/#90) | Не offset до job, не Processed=financial completion, не storage retry в handler; financial fetch не исчерпывает header capacity; при DB/disk saturation честный backpressure |
| A25 | Restart pending job, восстановление store, corrupt/wrong owner/type/hash/stale proof | Bounded scheduler/startup sweep с identity/lease/fence/version; validation вне locks, corrupt proof в review/conflict без payment, catch-up по accepted #71/#77/#121 budgets (#83/#90) | Не transport replay Processed Inbox вместо job, не второй job на duplicate, не повтор terminal job и не бесконечная RAM queue |
| A26 | Cancellation/frozen-version/job lease race; crash после apply commit до ACK/retry; поздний header | Короткая transaction повторно проверяет guards и атомарно пишет verified proof/requirement/history/projection/Outbox/terminal job; ровно одно requirement. Header guards ортогональны (#83/#90) | Cancelled/stale/conflicting proof не продвигает payment/lifecycle; поздний header не откатывает financial state |

## Проверки будущей реализации

Этот документ не выполняет runnable business tests. Delivery issues владельцев
обязаны отдельно доказать:

- local transaction `exact link + consumed Desired exclusion + durable timer`;
- Gateway-only provider GET и нормализованный observation без прямого доступа
  Invoices к AROMA;
- Inbox/Outbox idempotency и self-contained manifest validation;
- обязательный persisted normalized observation/hash для принятого header и
  bounded source-proof fetch до Invoices DB transaction;
- header-before-manifest и manifest-before-header delivery;
- ранний «Счёт в работе» без PDF/price proof/payment;
- `null` allocation share и отображение «Распределение ожидается»;
- duplicate snapshot, account-scoped provider dedupe, changed total/currency и
  append-only evidence;
- restart, partial response, ambiguous candidate, CancelGuard race и late
  candidate compensation;
- UI projection без прямого provider request и с раздельными lifecycle/proof
  states.

До начала реализации соответствующих runtime должны быть отдельно закреплены:

- точное wire-имя invoice materialization identity (`operationRef` или
  `invoiceOperationRef`), topic, key, envelope и compatibility rule;
- representation quantity и lossless allocation/rounding policy;
- artifact storage/scanner boundary и retention;
- реальный AROMA read contract для automated invoice polling;
- provider-side submit contract только если выбирается автоматическое оформление
  закупки; операторский runbook может заменить submit шаг, но не read contract;
- Payments contract, PSP/provider agreement и rules для tax/fees/partial,
  over/under-payment.

До принятия этих решений нельзя выдумывать provider API, provider status,
intervals, schema aliases или выдавать документацию за реализованный runtime.
