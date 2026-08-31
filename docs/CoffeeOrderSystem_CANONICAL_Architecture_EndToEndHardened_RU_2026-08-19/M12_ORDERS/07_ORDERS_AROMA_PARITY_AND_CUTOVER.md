# M12. C# behavior extraction, parity и cutover

## 1. Reference source set

C# `/src` используется как evidence для инвариантов. Основные reference areas:

```text
Order / OrderLifecycleStatus
ConfirmOrderUseCase
AromaCartDesiredSource + RevisionService
AromaAuthoritative observer/projection
ProcessAromaCartConvergenceUseCase
AromaCartCheckoutUseCase + CheckoutSnapshot
PrepareOrderForAromaUseCase
Delete/Cancel/confirmed-item commands
Invoice price/payment transition use cases
```

Legacy `AromaCartFillBatch*` используется только для edge-case corpus, а не как target design.

## 2. Characterization dimensions

Генерируются fixtures по осям:

```text
OrderStatus
OrderVersion
item quantity/variant/grind
mapping ready/manual/unavailable
approval state
fulfillment state
Desired contribution
Observed freshness/quantity/item id
DesiredKeyVersion/drift generation
profile activation/phase/health/authority
lease/fencing
provider response class
checkout proof state
invoice/price/payment proof
```

## 3. Parity target

Сравниваются:

- allowed/rejected transition;
- errorCode;
- semantic revisions;
- Desired target;
- selected convergence operation;
- UnknownOutcome classification;
- required fresh reads;
- checkout proof eligibility;
- invoice/payment transition eligibility.

Не требуется совпадение internal class/table names.

## 4. Mutation cutover

```text
shadow decisions
-> read-only provider observation
-> dedicated test profile
-> one mutation canary cohort
-> controlled profile ownership
-> checkout parity
-> DB5 Orders ownership
```

Rollback не включает одновременный C#/TS writer.

## 5. Legacy removal gate

`sendToAromaCart`/batch surface удаляется только когда target Confirm->Desired->Convergence покрывает production behavior и no legacy batch work remains.
