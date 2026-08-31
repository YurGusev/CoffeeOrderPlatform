# M12. Source Map: что брать из текущего C# при переносе

Этот документ — навигация по legacy/reference-коду. Он не делает C# runtime dependency новой платформы.

## Каноническое behavioral evidence — переносить семантику

| C# area | Что извлечь |
|---|---|
| `Domain/Order.cs`, `OrderLifecycleStatus.cs` | business lifecycle и разделение payment/fulfillment |
| `ConfirmOrderUseCase.cs` | единственный Draft→Confirmed primitive; row/version gate; atomic status/history/Desired/preparation |
| `AromaCartDesiredSource.cs` + `AromaCartDesiredRevisionService.cs` | contribution/approval/resolution, semantic revisions/cart key |
| `PrepareOrderForAromaUseCase.cs` | mapping preparation и обновление Desired без cart mutation |
| authoritative Observer/projection | только successful fresh GET меняет Observed |
| `ProcessAromaCartConvergenceUseCase.cs` | lease/fence, GET-before, one mutation, GET-after, exact verify, UnknownOutcome |
| `AromaCartCheckoutUseCase.cs`, `AromaCartCheckoutSnapshot.cs` | immutable checkout proof, profile lease/fence, wholesale baseline |
| wholesale polling/link code | exact post-baseline candidate classification |
| invoice materialization/proof handoff | stable checkout+wholesale identity |
| `MarkOrderPaymentCollectedUseCase.cs` / price transition | Completed = customer payment; price proof before AwaitingCustomerPayment |
| Delete/cancel/confirmed-item use cases | Desired removed/changed atomically with local business mutation |

## Legacy evidence — НЕ переносить architecture shape

| C# area | Использование |
|---|---|
| `AromaCartFillBatch.cs` | edge-case tests only |
| `AromaCartFillLine.cs` | baseline/target/provider ambiguity fixtures only |
| `StartAromaCartFillBatchUseCase.cs` | mapping/preflight cases only; не target orchestration |
| `AromaCartFillBatchWorker/Processor` | retry/concurrency evidence only |
| `/send-to-aroma-cart` controller endpoints | compatibility behavior only; target endpoint отсутствует |
| React `orderAromaCart` / `useOrderAromaCartFillWorkflow` | UnknownOutcome UX evidence; target workflow удаляется |

## Tests to port as behavior corpus

Priority groups:

```text
CoffeeOrderClientActionPolicyTests
Confirm endpoint/use-case tests
AromaCartConvergenceUseCaseTests
AromaCartStageARolloutUseCaseTests
AromaExternalStateUseCaseTests
AromaCartCheckoutUseCaseTests
PrepareOrderForAromaUseCaseTests
DeleteCoffeeOrdersUseCaseTests
MarkOrderPaymentCollectedUseCaseTests
React orders.aroma-cart edge-case tests -> only generic unknown/fresh-read scenarios
```

## Rule

Если legacy batch test конфликтует с accepted authoritative-cart invariant, **побеждает authoritative model**, а тест классифицируется как retired compatibility behavior.
