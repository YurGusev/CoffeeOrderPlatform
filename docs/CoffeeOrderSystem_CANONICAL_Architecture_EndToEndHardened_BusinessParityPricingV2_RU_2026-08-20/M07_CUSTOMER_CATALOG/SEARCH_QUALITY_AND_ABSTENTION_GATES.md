# Search quality and abstention gates

Auto-selection допускается только если пройдены hard gates и confidence threshold. В остальных случаях результат `NeedsChoice/Unresolved`.

Обязательные сегменты characterization:

- exact article;
- exact/normalized name;
- alias;
- typo/fuzzy;
- conflicting initials/tokens;
- deleted/unavailable product;
- multiple near-equal candidates;
- variant mismatch;
- ML unavailable;
- vector index stale.

Метрики: top-1 correctness, candidate recall, false auto-select rate, abstention rate, manual-review resolution time. Safety gate: false auto-select важнее снижения abstention.
