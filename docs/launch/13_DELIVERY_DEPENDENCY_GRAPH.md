# Единая линия реализации

## Правило

Каждое issue обязано назвать predecessor, входные артефакты, выходные артефакты
и downstream consumers. Задача не считается готовой, пока её consumer contract
test не принят следующей задачей. Все outputs объединяются в `develop`; следующая
ветка создаётся от `develop`, содержащей принятые prerequisites.

## Граф

```text
#2 Boundaries
 └─> #3 Foundation/config/secrets/DB/toolchain
      └─> #4 Unified HTTP/event contracts + generated clients/mocks
           ├─> #5 Customer ───────────────────────────────┐
           ├─> #10 Gateway ─> #6 staging ─> #16 activation ─> #17 API ─> #18 verification ─> #7 Pricing
           │                                      └───────────────────────────────┤
           └─────────────────────────────────────> #8 Orders
                                                       ├─> #9 React
                    #10 + #16 + #18 + #8 ─────────> #11 AROMA convergence
                    #8 + #9 + #11 ────────────────> #12 Realtime
                    #5..#12 + #16..#18 ───────────> #13 Launch gates
```

## Контрольные точки

| Issue | Принимает | Публикует | Разблокирует |
|---|---|---|---|
| #2 | launch docs | service/DB/interaction/secret ownership manifests + architecture checker | #3, #4 |
| #3 | manifests #2 | workspace, exact versions, config/secrets bootstrap, DB roles, Compose | #4–#12, #16–#18 |
| #4 | #2–#3 | единую OpenAPI/JSON Schema authority, generated client/mocks | #5–#12, #16–#18 |
| #5 | Customer contracts | работающий Customer API + DB migrations | #8, #9, #13 |
| #10 | private AROMA contracts | NDJSON Catalog export + typed cart primitives | #6, #11 |
| #6 | NDJSON contract/fixtures #10 | batch manifests + `Received` staging generation | #16 |
| #16 | `Received` generation #6 | atomic active revision + owner Outbox events | #17, #18, #8, #11 |
| #17 | active projection #16 | client Catalog search + private Pricing input | #18, #7, #8, #9 |
| #18 | #10/#6/#16/#17 | Catalog failure/recovery/capacity evidence | #7, #8, #9, #11, #13 |
| #7 | Pricing contracts + Catalog API/evidence #17/#18 | immutable quote/verify | #8, #9 |
| #8 | Customer/Catalog/Pricing contracts+providers | Draft/Confirm/Desired/Order Card/events | #9, #11, #12 |
| #9 | generated client + #5–#8 APIs | React operator flow | #12, #13 |
| #11 | #10/#16/#18/#8 | observer/convergence/UnknownOutcome events | #12, #13 |
| #12 | #8/#9/#11 | SSE invalidation/refetch | #13 |
| #13 | все outputs | единый verified release evidence | завершает #1 |

## Контракт передачи

Каждый PR обязан приложить `evidence/handoffs/issue-<N>.yaml`:

```yaml
issue: 4
commit: <sha>
inputs:
  - issue: 3
    artifact: config/toolchain-versions.json
outputs:
  - artifact: contracts/openapi/client-v1.yaml
    consumers: [5, 7, 8, 9]
verification:
  - command: pnpm contracts:check-generated
    result: passed
```

Checker запрещает закрыть issue, если predecessor commit отсутствует в base,
output отсутствует, downstream consumer не указан или evidence ссылается на
непринятый PR.
