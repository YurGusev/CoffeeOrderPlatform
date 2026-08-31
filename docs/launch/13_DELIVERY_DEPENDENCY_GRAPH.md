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
           ├─> #10 AROMA Gateway ─> #6 Catalog ─> #7 Pricing
           │                                  └───────────┤
           └─────────────────────────────────────> #8 Orders
                                                       ├─> #9 React
                    #6 + #8 + #10 ────────────────> #11 AROMA convergence
                    #8 + #9 + #11 ────────────────> #12 Realtime
                    #5..#12 ──────────────────────> #13 Launch gates
```

## Контрольные точки

| Issue | Принимает | Публикует | Разблокирует |
|---|---|---|---|
| #2 | launch docs | service/DB/interaction/secret ownership manifests + architecture checker | #3, #4 |
| #3 | manifests #2 | workspace, exact versions, config/secrets bootstrap, DB roles, Compose | #4–#12 |
| #4 | #2–#3 | единую OpenAPI/JSON Schema authority, generated client/mocks | #5–#12 |
| #5 | Customer contracts | работающий Customer API + DB migrations | #8, #9, #13 |
| #10 | private AROMA contracts | typed Gateway reads/mutations | #6, #11 |
| #6 | Catalog + AROMA contracts, Gateway | complete Catalog snapshot/search/events | #7, #8, #9, #11 |
| #7 | Pricing + Catalog contracts | immutable quote/verify | #8, #9 |
| #8 | Customer/Catalog/Pricing contracts+providers | Draft/Confirm/Desired/Order Card/events | #9, #11, #12 |
| #9 | generated client + #5–#8 APIs | React operator flow | #12, #13 |
| #11 | #6/#8/#10 | observer/convergence/UnknownOutcome events | #12, #13 |
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
