# Единая линия реализации

## Правило

Каждое issue обязано назвать predecessor, входные артефакты, выходные артефакты и downstream consumers. Задача не считается готовой без принятого handoff. Следующая ветка создаётся от `develop`, содержащей accepted prerequisite; параллельный обход цепочки запрещён.

## Foundation до Effect

```text
#14 Governance/docs
→ #19 topology/trust authority
→ #2 service/DB/interaction boundaries
→ #3 / PR #22 executable Node foundation
```

## Обязательная Effect-native линия

```text
#3 / PR #22
→ #25 [3.1] Effect-native authority
→ #26 [3.2] BOM, Effect diagnostics и architecture guards
→ #27 [3.3] Effect Schema/HttpApi contract platform
→ #28 [3.4] 15-runtime Effect HTTP/runtime/config/security/observability cutover
→ #29 [3.5] Effect SQL/PostgreSQL/migrations/COPY cutover
→ #30 [3.6] Effect Kafka/Idempotency/Inbox/Outbox cutover
→ #31 [3.7] Effect Atom frontend cutover
→ #32 [3.8] E00–E15 admission и окончательное удаление legacy inventory
→ #4 launch contracts
```

#4 получает `status:ready` только после merge #32 и решения `ДОПУСТИТЬ EFFECT FOUNDATION`.

## Business-линия после #4

```text
#4 Effect Schema/HttpApi HTTP/SSE/event contracts
 ├─> #5 Customer ───────────────────────────────────────┐
 ├─> #10 Gateway ─> #6 staging ─> #16 activation ─> #17 API ─> #18 verification ─> #7 Pricing
 │                                              └──────────────────────────────────────────┤
 └───────────────────────────────────────────────────────────────────────────────────────> #8 Orders
                                                                                              ├─> #9 React
#10 + #16 + #18 + #8 ──────────────────────────────────────────────────────────────────────> #11 AROMA convergence
#8 + #9 + #11 ─────────────────────────────────────────────────────────────────────────────> #12 Realtime
#5..#12 + #16..#18 ────────────────────────────────────────────────────────────────────────> #13 Launch gates
```

## Контрольные точки Effect foundation

| Issue | Принимает | Публикует | Разблокирует |
|---|---|---|---|
| #25 / 3.1 | #3/PR #22 | ADR-0023, machine authority, Effect-native docs/issues | #26 |
| #26 / 3.2 | #25 | exact BOM, diagnostics, closed legacy inventory, RED/GREEN guards | #27 |
| #27 / 3.3 | #26 | Schema/HttpApi packages, deterministic OAS/JSON Schema artifacts | #28 |
| #28 / 3.4 | #27 | 15 Effect runtime, HTTP/config/security/time/observability cutover | #29 |
| #29 / 3.5 | #28 | Effect SQL, Coffee transaction policy, migrations, COPY | #30 |
| #30 / 3.6 | #29 | Confluent→Effect adapter, durable Idempotency/Inbox/Outbox | #31 |
| #31 / 3.7 | #30 | browser Effect/Atom runtime, AtomHttpApi, SSE adapter | #32 |
| #32 / 3.8 | #25–#31 | E00–E15 evidence, no-legacy proof, final handoff | #4 |

## Контрольные точки business-линии

| Issue | Принимает | Публикует | Разблокирует |
|---|---|---|---|
| #4 | #32 | Effect launch contracts, typed clients, fixtures/artifacts | #5–#12, #16–#18 |
| #5 | Customer contracts | Customer API + migrations | #8, #9, #13 |
| #10 | private AROMA contracts | NDJSON export + typed cart primitives | #6, #11 |
| #6 | Gateway stream | `Received` Catalog staging generation | #16 |
| #16 | Received generation | atomic active revision + owner Outbox events | #17, #18, #8, #11 |
| #17 | active projection | Catalog search + Pricing input | #18, #7, #8, #9 |
| #18 | Catalog pipeline | recovery/capacity evidence | #7, #8, #9, #11, #13 |
| #7 | Catalog API/evidence | immutable quote/verify | #8, #9 |
| #8 | Customer/Catalog/Pricing | Draft/Confirm/contribution/Order Card | #9, #11, #12 |
| #9 | public API providers | React operator flow | #12, #13 |
| #11 | Gateway/Catalog/Orders | observer/convergence/UnknownOutcome | #12, #13 |
| #12 | Orders/React/convergence | SSE invalidation/refetch | #13 |
| #13 | все outputs | launch evidence и решение | завершает #1 |

## Контракт передачи

Каждый PR обязан приложить `evidence/handoffs/issue-<N>.yaml`:

```yaml
issue: 26
commit: <accepted-sha>
inputs:
  - issue: 25
    artifact: docs/adr/ADR-0023-effect-native-platform.md
outputs:
  - artifact: config/effect-legacy-inventory.json
    consumers: [27, 28, 29, 30, 31, 32]
verification:
  - command: pnpm architecture:check
    result: passed
```

Checker запрещает принятие, если predecessor commit отсутствует в base, output отсутствует, consumer не указан, checklist отмечен без evidence или handoff ссылается на непринятый PR.
