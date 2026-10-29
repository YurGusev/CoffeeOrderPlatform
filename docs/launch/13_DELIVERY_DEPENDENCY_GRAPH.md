# Единая линия реализации

## Правило

Каждая задача принимает merged prerequisites из `develop` и публикует handoff
для конкретных consumers. Ветка создаётся от accepted `develop`, без stacked
или unmerged predecessor. Выполненный scaffold не считается доказательством
business durability. Техническую authority задаёт
[ADR-0025](../adr/ADR-0025-fastify-launch-recovery.md), а frontend
техническую foundation — [ADR-0027](../adr/ADR-0027-frontend-ui-foundation.md).
Текущий visual source для #137/#9 — [ADR-0029](../adr/ADR-0029-selected-frontend-prototype.md);
закрытый #136 сам по себе не доказал содержательную приёмку прежних SVG.

## Граф после recovery

```text
#14 → #19 → #2 → #3
                  ↓
                 #60 → #119 ────────→ #4 contracts
                  ↓
             #61 runtime
                  ↓
             #62 PostgreSQL/idempotency
                  ↓
             #63 Kafka/Inbox/Outbox

#4 + #62 → #5 Customer
#4 + #62 → #10 Gateway → #6 staging
#6 + #63 → #16 activation + durable AROMA binding ack → #17 Catalog API → #18 capacity → #7 Pricing
#136 UX/ADR → #137 UI foundation ───────────────┐
#5 + #7 + #17 + #18 + #63 → #8 Orders ────────┼→ #9 React
#4 + #5 + #7 + #8 + #17 + #18 + #119 ─────────┘
#10 + #16 + #18 + #8 + #63 → #11 convergence
#8 + #9 + #11 + #63 → #12 Realtime
#12 + #63 → #64 Operations/producer foundation
#64 + #209 → #210 Grafana observability migration → #13
#5..#12 + #16..#18 + #64 + #210 → #13 Launch gates → завершает #1
```

#119 принимает frontend recovery/deep-link уточнение до #4. Оно использует
accepted #60; #62 и #63 уже приняты независимо от этого уточнения.
#4 начинается после #60 и #119 параллельно runtime hardening. Оно не ждёт DB/Kafka
implementation и использует contract fixtures. Ready определяется всеми текущими
inputs, а не только историческим #60;
#4 остаётся blocked до merge/handoff #119. Остальные сохраняют свои prerequisites.
Observability не блокирует business implementation; Operations принимает реальные
instrumentation points после #12. #64 сохраняется как producer foundation; #210
владеет заменой OpenObserve-специфической реализации и пока проверяется.
Исторический `evidence/handoffs/issue-64.yaml` неизменен; после приёмки #210
полный #13 требует также его merged handoff. Component G12/G14 #210 проверяются
до merge без зависимости от собственного будущего handoff; producer/config не
заменяют PASS G14.
[Runbook Operations](../operations/observability.md) описывает границы проверки.

#136 поставляет только ADR, UX-макеты и согласованные нормативные документы.
#137 после принятого #136 materialize-ит `packages/platform-ui` /
`@coffee-platform/ui`, browser shell и разделённые browser/Node build graphs.
#9 не теряет ни одного прямого prerequisite: #4/#5/#7/#8/#17/#18/#119 остаются
обязательными вместе с принятым foundation #137. #136/#137 не означают
реализацию #9, #12 или #13.

## Дополнение #159: public transport без обратной зависимости

`#19/#4/#60/#61/#119/#137 → #159 (ADR-0031, normative contract)`.
От принятого #159 расходятся независимые реализации: `#159 → #160` private
application authorizer и `#159 + #137 → #161` native nginx/static/fixture;
только `#160 + #161 → #162` выполняет единый active cutover. #162 поставляет
transport artifacts в #9 (browser flow), #12 (realtime receiver/soak), #64
(native telemetry) и #13 (release verification). #160 отдельно поставляет
realtime actor receiver contract в #12, #161 — direct static в #9.
Изначальные prerequisites каждого consumer остаются обязательными. Ни #9,
ни #12, ни #64, ни #13 не предшествуют #159/#160/#161/#162; поэтому нет
цикла. #162 проверяет peer fixtures без требования готовых business экранов или
Kafka fanout. #13 проверяет полный production/browser/capacity admission, а
не считает target числа/fixture результатом PASS. Точная матрица transport,
auth, limits и no-provider exposure — [контракт #159](29_NGINX_TRANSPORT_AND_AUTH.md).

## Контракт #63 для downstream

`#63` передаёт consumers четыре связанные границы:

- `createKafkaRuntime({runtime, config, service, credentials})`,
  `bind(groupId, binding)`, `send(topic, key, envelope, signal)` и
  `processKafkaRecord` принимают только directional topic/group allowlists;
  `KafkaSendAck` содержит `kind`, topic, partition и broker offset.
- Один `PartitionWorkers` serial worker обслуживает один assigned
  `topic:partition`; общий `maxInFlight` и `queueCapacity` ограничивают active +
  queued records. Revoke, неизвестный offset commit и shutdown идут через
  bounded stop/drain/close/reopen; произвольный Promise не считается
  принудительно отменяемым.
- Durable consumer выполняет decode/transport validation → owner transaction
  (`Inbox.begin` → owner state/Outbox → `markProcessed`) → известный DB COMMIT →
  Kafka offset commit. DB/offset unknown оставляет redelivery. Realtime mode
  существует только для `realtime-gateway`/`coffee.realtime.invalidate.v1`/
  `realtime-gateway-v1` и подтверждает offset после local enqueue или DLQ ack.
- `SqlInboxStore` и `SqlOutboxStore` работают с owner-local tables через opaque
  `Transaction`; sequence barrier, lease/token fencing, payload hash conflict и
  quarantine являются частью протокола. Business schema, owner migration и
  handler остаются у consumer.

Owner migration locations задаёт `config/database-ownership.json`: Customer —
`apps/customer-service/migrations`, Catalog — `apps/catalog-service/migrations`,
Pricing — `apps/pricing-service/migrations`, Orders —
`apps/orders-service/migrations`, Integration — `apps/aroma-gateway/migrations`.
В текущем delivery map Kafka tables распределены так: Catalog data owner выдаёт
`catalog-activation-worker` grant на `outbox_messages`; Orders владеет
`outbox_messages` у
`orders-service` и `inbox_messages`/`outbox_messages` у
`orders-aroma-preparation`, `aroma-observer`, `aroma-convergence`.
`inbox_quarantine` пока не перечислена в `config/database-role-map.json` и
должна получить owner migration и явный grant до durable malformed-record
admission. Realtime gateway DB tables не получает. Эти каталоги и пути — contract
handoff, а не утверждение, что business migrations уже materialized.

`#64` принимает от #63 следующие bounded instrumentation points: consumer lag
по runtime/group/topic/partition, assigned/active/queued/pending и capacity,
queue saturation, Inbox lease expiry, quarantine, duplicate/conflict,
`OFFSET_COMMIT_OUTCOME_UNKNOWN` и recovery counters. Разрешены только
allowlisted runtime/group/topic/partition и перечисленные machine reasons;
payload, key, envelope, message body, credentials, SQL и secret material не
попадают в metric labels или log fields. `correlationId`, `causationId` и
`traceparent` остаются correlation fields, не labels. Текущий aggregate runtime
snapshot экспортирует `active`, `queued`, `pending`, `assigned`,
`saturationTotal`, `unknownCommitTotal`, `recoveryTotal` и `lastCode`; расширенный
lag/lease/quarantine/duplicate instrumentation поставляет #64 вместе с его
collector.

## Контрольные точки

| Issue | Обязательные inputs | Выход и consumer |
|---|---|---|
| #60 | accepted #49 / PR #59; baseline #3 / PR #22 и #47 | Fastify recovery, ADR-0025, graph → #4, #61 |
| #61 | #60 | deadlines/cancellation/readiness/shutdown → #62, #63, #64 |
| #62 | #60, #61 | transaction outcome, durable idempotency, migrations/pool → #5, #10, #63 и DB owners |
| #63 | #61, #62 | durable Inbox/Outbox, partition drain, broker persistence → #16, #8, #11, #12, #64 |
| #119 | #60 | browser recovery, Draft/cache/SSE policy, SPA route authority → #4/#5/#7/#8/#9/#12/#13 |
| #4 | #2, #3, #60, #119 | OpenAPI/JSON Schema, types-only generation, fixtures → business contract consumers |
| #5 | #4, #62, #119 | Customer API/migrations → #8, #9, #13 |
| #10 | #4, #62 | safe NDJSON/cart transport, durable operation journal → #6, #11 |
| #6 | #10, #62 | Received Catalog staging generation + immutable AROMA binding preparation → #16 |
| #16 | #6, #63 | durable binding acknowledgements, active revision + owner Outbox events → #17, #18, #8, #11 |
| #17 | #4, #16 | Catalog search + Pricing input → #18, #7, #8, #9 |
| #18 | #10, #6, #16, #17 | pipeline recovery/capacity evidence → #7, #8, #9, #11, #13 |
| #7 | #4, #17, #18, #62, #119 | immutable PricingQuote/verify → #8, #9 |
| #8 | #4, #5, #7, #17, #18, #63, #119 | Draft/Confirm/contribution/Order Card → #9, #11, #12 |
| #136 | accepted #4, #119 | historical ADR-0027/SVG handoff merged with `contentAcceptance: NOT_RUN`; владелец подтвердил последующую приёмку SVG 2026-09-23 (дата/источник первоначального решения уточняются); visual заменён ADR-0029 + versioned prototype → #137, #9, #12, #13 |
| #137 | #136 | `@coffee-platform/ui`, React/Vite/Tailwind/React Aria foundation, browser/Node graphs → #9 |
| #159 | #19, #4, #60, #61, #119, #137 | ADR-0031 + normative transport/auth contract → #160, #161, #162, #9, #12, #64, #13 |
| #160 | #159 | private Edge authorizer/session/actor receiver + crypto tests → #162, #12 |
| #161 | #159, #137 | native nginx image/static/transport fixture → #162, #9, #64 |
| #162 | #160, #161 | один active cutover/removal old transport, trust/config/rollback evidence → #9, #12, #64, #13 |
| #9 | #4, #5, #7, #8, #17, #18, #119, #137, #162 | один `QueryClient`, project-owned fetch/client-v1 runtime validation + React operator flow → #12, #13 |
| #11 | #10, #16, #18, #8, #63 | этап A: backend grind contract → integration gate #9; этап B: observer/convergence/UnknownOutcome → #12, #13 |
| #12 | #8, #9, #11, #63, #119, #160, #162 | single-instance SSE invalidation/refetch → #64, #13 |
| #64 | #4, #61, #62, #63, #12, #162 | историческая producer foundation, Pino/OTel, native applicability и redaction → #210, #13 |
| #210 | #64, #209 | миграция observability по ADR-0040; после приёмки handoff → G14 #13 |
| #13 | все outputs выше, #119, #162, принятый handoff #210 | verified release evidence → закрытие #1 |

Для #9/#11 действует [контракт параллельной разработки](30_AROMA_GRIND_CONTRACT_AND_PARALLEL_DELIVERY.md):
полный #11 не блокирует старт #9; этап A #11 поставляет общий контракт помола
для интеграционной приёмки соответствующего browser flow. Это частичный
handoff, не циклическая зависимость между задачами.

При выполнении #18 отдельно приняты owner-исправления #153 (конкурентный
PostgreSQL checkout) и #155 (сборка clean clone до contract tests). Их
`evidence/handoffs/issue-{153,155}.yaml` — дополнительные проверенные inputs
verification-ветки, но не замена прямых бизнес-предшественников #18.

## История Effect

#48 / PR #56 и #49 / PR #59 остаются завершённой историей. Их ADR/handoff
сохраняются без переписывания hashes. #50–#55 superseded решением #60 и закрываются
как not planned только после merge recovery; они не считаются выполненными.
Ни один business issue больше не принимает Effect admission #55.

## Handoff protocol

Каждый handoff хранится в `evidence/handoffs/issue-<N>.yaml`:

```yaml
issue: 4
baseCommit: <accepted-develop-before-work>
inputs:
  - issue: 60
    acceptedMergeCommit: <accepted-predecessor-merge-sha>
    artifact: docs/adr/ADR-0025-fastify-launch-recovery.md
    sha256: <digest-at-that-commit>
outputs:
  - artifact: contracts/openapi/client-v1.yaml
    sha256: <current-artifact-digest>
    consumers: [5, 7, 8, 9]
verification:
  - command: pnpm contracts:check-generated
    result: passed
limitations: []
```

Self commit SHA не записывается. Consumer проверяет accepted predecessor через
Git/GitHub; historical hashes проверяются на соответствующем commit, не текущем
workspace. Outputs содержат только реальные изменённые artifacts. Команды и
ограничения описывают фактически выполненные проверки; live skip не является PASS.
Historical handoffs не переписываются под новый protocol.
