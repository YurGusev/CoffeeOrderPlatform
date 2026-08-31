# Hermes migration from legacy AI/AiOrdering

Удаление `Modules.AI`/`Modules.AiOrdering` разрешено только после mapping каждого safeguard в target.

Parity checklist:

- staged cart;
- intent extraction;
- clarification/choice;
- inbound dedupe;
- rate/quantity/input limits;
- customer evidence;
- confirmation freshness/proof;
- operator approval task;
- prompt registry;
- secret/PII redaction;
- tool permissions/budgets;
- provider health/circuit;
- feedback/evaluation export;
- continual-learning governance.

Каждый пункт получает characterization test. Zero-use telemetry + rollback window обязательны до deletion.
