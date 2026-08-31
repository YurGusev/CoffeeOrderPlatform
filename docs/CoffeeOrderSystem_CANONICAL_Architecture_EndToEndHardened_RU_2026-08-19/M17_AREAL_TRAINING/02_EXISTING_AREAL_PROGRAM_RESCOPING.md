# M17. Re-scope прежней AReaL production программы

## 1. Что сохраняется

Старые safety requirements не выбрасываются:

- Coffee domain = business truth;
- agent no direct DB/AROMA;
- service auth;
- session isolation;
- explicit confirmation;
- idempotency;
- staged rollout;
- rollback evidence.

## 2. `agent-v1`

Сохраняется как строгий Coffee Agent API для Hermes plugin. Не требуется автоматически превращать весь OpenAPI в tools.

## 3. Runtime target

```text
старый: Coffee -> AReaL Agent Service -> Agent -> tools
новый: Coffee/Kafka -> Hermes Dispatcher -> Hermes -> CoffeeOrder Plugin -> agent-v1
```

## 4. W2–W8

Незавершённые runtime waves переопределяются на Hermes:

```text
W2 Channel Identity / service auth / customer capability
W3 Hermes profile/plugin/runtime
W4 Shadow/ReadOnly
W5 DraftWrite
W6 Confirmation
W7 test-primary/canary
W8 Hermes fleet + Kafka + Kubernetes scaling
W9 legacy cleanup
```

## 5. AReaL становится отдельной future initiative

```text
T0 trajectory/privacy export
T1 evaluator/reward
T2 dataset registry
T3 SFT baseline
T4 AReaL RL
T5 offline eval
T6 Hermes shadow
T7 local-model canary
```

Она не блокирует production migration на Hermes.
