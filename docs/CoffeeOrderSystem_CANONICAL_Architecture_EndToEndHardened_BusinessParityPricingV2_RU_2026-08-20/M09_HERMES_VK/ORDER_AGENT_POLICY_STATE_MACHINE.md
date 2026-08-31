# Order Agent Policy State Machine

Hermes заменяет agent loop, но текущие safeguards становятся отдельным `CoffeeOrderAgentPolicy`.

Состояния conversation order workflow:

```text
Idle
→ Collecting
→ NeedsClarification / NeedsChoice
→ DraftReady
→ ConfirmationPresented
→ ConfirmationAccepted
→ OrderCommandSubmitted
→ Completed
```

`conversation staged cart` никогда не равен AROMA physical cart.

Обязательные guards:

- deterministic intents до LLM там, где возможно;
- session ownership;
- summary/catalog/version freshness;
- explicit customer confirmation proof;
- tool idempotency;
- no direct provider/AROMA mutation;
- pending clarification expiry;
- operator task для неоднозначных/опасных действий.
