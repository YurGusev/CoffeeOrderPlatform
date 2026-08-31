# Alias, feedback, vector and model lifecycle

## Alias

Alias — versioned Catalog fact с source (`Operator`, `ImportAccepted`, `ApprovedSuggestion`). Auto-created alias после пользовательского выбора не становится authoritative без threshold/policy.

## Feedback

Каждое принятое/отклонённое сопоставление пишет `SearchDecisionFeedback` с query hash, chosen candidate, resolver/model version и actor/channel. PII в training export минимизируется.

## Vector index

Vector index — rebuildable projection. Authoritative Product остаётся PostgreSQL Catalog. Index version привязан к catalog snapshot/version и embedding model digest.

## Model rollout

Новая reranker/model version проходит shadow evaluation, holdout gates, segment checks и canary. При недоступности ML resolver должен degrade к deterministic pipeline, а не fabricates match.
