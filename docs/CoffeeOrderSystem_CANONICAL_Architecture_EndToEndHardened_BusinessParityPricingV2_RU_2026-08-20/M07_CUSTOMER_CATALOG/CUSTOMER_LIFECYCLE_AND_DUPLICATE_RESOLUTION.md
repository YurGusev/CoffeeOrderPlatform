# Customer lifecycle and duplicate resolution

## Ownership

Customer — самостоятельный business aggregate внутри Customer capability. Orders хранит immutable customer snapshot (`CustomerRef`, display name, phone/address snapshot as needed), но не является владельцем master Customer record.

## Lifecycle

```text
Active
 ├─→ Deactivated
 ├─→ Merged → RedirectToCustomerRef
 └─→ Anonymized (только при допустимости retention/legal rules)
```

Hard delete business Customer запрещён после появления Orders/Invoices/Payments/Channel evidence.

## Candidate resolution

Resolver выполняется в два этапа:

1. bounded indexed candidate retrieval;
2. deterministic scoring/review decision.

Нельзя загружать всех customers в память.

Сохраняем legacy-семантику:

- Unicode NFKC, trim/lowercase, `ё→е`;
- token normalization;
- exact/equivalent match;
- surname-only expansion при единственном кандидате;
- conflicting explicit initials блокируют fuzzy auto-match;
- Levenshtein + token/Jaccard как advisory score;
- ambiguous/high-score result → durable Review task;
- manual override всегда audit;
- `forceCreateNew` не должен обходить exact/equivalent identity safety.

## Duplicate merge

Merge — отдельная audited command:

```text
SourceCustomer → Merged
TargetCustomer → Active
CustomerMergeProof(source,target,actor,reason,occurredAt,version)
```

Все новые reads sourceRef разрешаются через redirect. Исторические Order snapshots не переписываются.

## Concurrency

Customer использует application-owned `version BIGINT`; merge/deactivate/update принимают `expectedVersion`.
