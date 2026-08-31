---
name: next-areal-training
description: "Use only for the separate AReaL training/evaluation lifecycle: sanitized Hermes trajectories, datasets, rewards, SFT/QLoRA, agentic RL, model registry, shadow/canary promotion. Never use it to add AReaL to production serving."
---

# AReaL Training-Only

## Source of truth

Каноническая программа: `M17_AREAL_TRAINING`. Перед существенным изменением прочитать её `README.md` и релевантные нормативные документы. Если этот skill противоречит канонической программе, **побеждает каноническая программа**, а skill должен быть обновлён.

## Область действия

Этот skill относится **только к новой архитектуре CoffeeOrderSystem**. Нормативная зона записи:

```text
platform/**
edge/**          # только target/strangler изменения
infra/**         # новая Docker/Kafka/Debezium/Kubernetes topology
hermes/**
training/**
```

`src/**` является legacy/reference-зоной. Изменять `src/**` разрешено только когда задача явно требует characterization/parity instrumentation, migration adapter, rollback support или удаления legacy после принятого cutover. Нельзя использовать legacy C# архитектуру как шаблон для target-кода.

Новая platform не должна импортировать runtime-код, сборки или внутренние типы из `src/**`. Разрешены только language-neutral contracts, наблюдаемое поведение, database schema evidence и characterization tests.

## Use when

- trajectory export/dataset;
- reward/evaluator;
- SFT/QLoRA/GRPO/GSPO experiment;
- model registry/promotion;
- AReaL infra.

## Hard rules

- AReaL отсутствует в production request path.
- Hermes state.db не является training dataset напрямую.
- Перед dataset: PII stripping/pseudonymization + business outcome verification.
- Training host не имеет production DB/AROMA/payment credentials.
- Не online-learn от live customer traffic прямо в production weights.
- Цикл: collect→sanitize→freeze dataset→train→evaluate→shadow→canary→promote.
- Reward основан на проверяемом business outcome, а не только “красивом ответе”.
- Cross-customer leakage/identity/confirmation violation = hard failure.
- Model artifact имеет base model/dataset/reward/code/config/checkpoint hashes.

## Workflow

1. Определить dataset schema/privacy class.
2. Собрать verified trajectories.
3. Заморозить versioned train/val/holdout/red-team split.
4. Сначала baseline SFT/QLoRA где уместно.
5. AReaL RL только при готовом evaluator/environment/GPU capacity.
6. Offline eval → Hermes shadow → canary → route promotion.

## Минимальная проверка

Перед завершением:

1. проверить соответствие каноническому документу программы;
2. проверить, что не создана новая скрытая cross-boundary зависимость;
3. выполнить targeted unit/integration/contract tests;
4. выполнить architecture/boundary tests для затронутого слоя;
5. проверить Docker build/health, если изменён runtime workload;
6. проверить observability и failure semantics, если изменён I/O/async path;
7. явно записать skipped checks и остаточный риск.
