# Единая линия реализации

## Правило

Каждое issue обязано назвать predecessor, входные и выходные артефакты и
downstream consumers. Следующая ветка создаётся от `develop`, содержащей
accepted prerequisite; stacked/unmerged predecessor не принимается.

## Foundation и Effect-native authority

```text
#14 → #19 → #2 → #3 / PR #22
                         ↓
#48 → #49 → #50 → #51 → #52 → #53 → #54 → #55
                                         ↓
                                        #4
```

Единственная техническая последовательность — `#3 → #48 → #49 → #50 → #51 →
#52 → #53 → #54 → #55 → #4`. #49 получает `status:ready` только после merge
#48; #50–#55 остаются `status:blocked` до принятия непосредственного
predecessor. Business-граф #4–#13 и #16–#18 сохраняет владельцев и результаты.

## Business-линия после #4

```text
#4
 ├─> #5 Customer ───────────────────────────────────────┐
 ├─> #10 Gateway → #6 staging → #16 activation → #17 API → #18 verification → #7 Pricing
 └─> #8 Orders → #9 React
#10 + #16 + #18 + #8 → #11 AROMA convergence
#8 + #9 + #11 → #12 Realtime
#5..#12 + #16..#18 → #13 Launch gates
```

## Контрольные точки

| Issue | Принимает | Публикует | Разблокирует |
|---|---|---|---|
| #3 / PR #22 | #2 | 15-runtime foundation, config/secrets, DB roles, toolchain registry | #48 |
| #48 | accepted #3 | ADR-0024, v2 machine authority, Effect policies, delivery graph, handoff | #49 |
| #49 | #48 | exact Effect BOM materialization and diagnostics | #50 |
| #50 | #49 | Effect Schema/HttpApi contracts and generated artifacts | #51 |
| #51 | #50 | Effect runtime/HTTP/config/security/observability cutover | #52 |
| #52 | #51 | Effect SQL, transactions, migrations and COPY adapter | #53 |
| #53 | #52 | Effect Kafka adapter and durable Inbox/Outbox | #54 |
| #54 | #53 | browser Effect/Atom runtime and SSE adapter | #55 |
| #55 | #54 | admission, no-legacy proof and final handoff | #4 |
| #4 | #55 | launch contracts, typed clients, fixtures and artifacts | #5–#13, #16–#18 |
| #5 | Customer contracts | Customer API + migrations | #8, #9, #13 |
| #10 | private AROMA contracts | NDJSON export + typed cart primitives | #6, #11 |
| #6 | Gateway stream | Received Catalog staging generation | #16 |
| #16 | Received generation | active revision + owner Outbox events | #17, #18, #8, #11 |
| #17 | active projection | Catalog search + Pricing input | #18, #7, #8, #9 |
| #18 | Catalog pipeline | recovery/capacity evidence | #7, #8, #9, #11, #13 |
| #7 | Catalog API/evidence | immutable quote/verify | #8, #9 |
| #8 | Customer/Catalog/Pricing | Draft/Confirm/contribution/Order Card | #9, #11, #12 |
| #9 | public API providers | React operator flow | #12, #13 |
| #11 | Gateway/Catalog/Orders | observer/convergence/UnknownOutcome | #12, #13 |
| #12 | Orders/React/convergence | SSE invalidation/refetch | #13 |
| #13 | all outputs | verified release evidence | завершает #1 |

## Handoff protocol

Каждый handoff хранится в `evidence/handoffs/issue-<N>.yaml` и содержит:

```yaml
issue: 48
baseCommit: <commit-of-develop-before-work>
inputs:
  - issue: 3
    acceptedMergeCommit: <merge-sha>
    artifact: docs/launch/README.md
    sha256: <digest>
outputs:
  - artifact: docs/adr/ADR-0024-effect-native-platform.md
    sha256: <digest>
    consumers: [49, 4]
verification:
  - command: pnpm authority:check
    result: passed
limitations: []
```

Self commit SHA не является обязательным полем: его нельзя заполнить до merge.
Successor обязан проверить accepted merge SHA predecessor через Git/GitHub и
записать его в `inputs`; sibling/unmerged PR не считается входом.
