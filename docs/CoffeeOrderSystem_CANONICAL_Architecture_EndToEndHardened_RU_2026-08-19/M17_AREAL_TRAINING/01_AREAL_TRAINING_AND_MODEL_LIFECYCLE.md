# M17. AReaL — training-only контур и жизненный цикл модели

## 1. Решение

AReaL не входит в production serving path. Он используется позже для agentic RL/trajectory-based training, когда production Hermes уже накопил качественные sanitized interactions и проверяемые business outcomes.

## 2. Физическое разделение

```text
PRODUCTION                         TRAINING
----------                         --------
VK/React                           sanitized trajectories
TypeScript Platform                verified outcomes
Kafka/Hermes                              ↓
PostgreSQL                         Dataset Registry
                                         ↓
                                    Evaluator/Rewards
                                      /          \
                              SFT/QLoRA          AReaL RL
                                      \          /
                                      Candidate Model
                                             ↓
                                      Hermes shadow/canary
```

Training host не получает production DB/AROMA/payment credentials.

## 3. Dataset ETL

`Hermes state.db` не является готовым training dataset.

```text
Hermes run/transcript evidence
+ Coffee business outcomes
+ operator corrections
→ sanitizer
→ label/reward builder
→ versioned dataset
```

## 4. Privacy

Удаляются/псевдонимизируются:

- raw VK/peer IDs;
- phone/address/email;
- credentials/tokens;
- payment sensitive data;
- raw internal DB IDs;
- unnecessary customer history.

## 5. Reward components

Проверяемые rewards:

```text
correct product
correct quantity/weight/grind
no extra/missing item
clarification when required
explicit confirmation respected
no identity violation
valid final order state
no forbidden tool
reasonable tool/token cost
```

Hard negative:

```text
wrong customer
unauthorized confirmation
hallucinated product/price
mutation claimed without tool success
cross-session leak
forbidden tool
blind repeat after uncertain side effect
```

## 6. Training stages

### Stage A

SFT/LoRA/QLoRA на подходящей open-weight model и доступном hardware.

### Stage B

AReaL agentic RL на отдельном GPU environment, когда определены tool environment, evaluator, reward и reproducible baseline.

## 7. Promotion

```text
train
→ offline holdout/red-team
→ shadow
→ canary
→ production route alias
```

Production weights не обновляются автоматически из live traffic.

## 8. Model registry

Каждый artifact хранит:

```text
base model
training code commit
DatasetVersion
RewardVersion
config hash
checkpoint/tokenizer hash
eval/safety report
status
```
