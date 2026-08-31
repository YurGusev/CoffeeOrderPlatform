# Catalog Search & Resolution architecture

## Один owner

В target существует один `CatalogSearchResolver`. Hermes, React, Order Import и другие callers не воспроизводят product matching в prompt/application code.

## Pipeline

```text
query
→ normalization
→ exact article/name/alias hard gates
→ indexed candidate retrieval
→ deterministic features/ranking
→ optional vector candidates
→ optional ML/Python reranker
→ hard business gates
→ confidence/abstention
→ Result | CandidateChoice | Unresolved
```

ML/vector — advisory. Они не могут обойти deleted/unavailable/mapping/variant hard gates.

## Отдельное понятие для Excel

`OrderImportProductMatcher` использует CatalogSearchResolver, но добавляет import-specific rules (column hints, exact supplier article, manual override proof). Имя `ProductResolverService` больше не используется для двух разных semantic roles.

## Determinism

При одинаковых catalog snapshot + resolver version + input query результат deterministic. Tie-breaking задаётся стабильным ключом, а не DB natural order.
