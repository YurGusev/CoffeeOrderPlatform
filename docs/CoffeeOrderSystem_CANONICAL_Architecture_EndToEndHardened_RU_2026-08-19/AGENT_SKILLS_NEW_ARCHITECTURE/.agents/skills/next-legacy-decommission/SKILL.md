---
name: next-legacy-decommission
description: "Use for deleting or disabling legacy C# runtime, HostedServices, old routes, flags, contracts, Blazor leftovers, AI/VK workers, and migration scaffolding after accepted cutovers."
---

# Legacy Decommission

## Source of truth

Каноническая программа: `M14_DECOMMISSION`. Перед существенным изменением прочитать её `README.md` и релевантные нормативные документы. Если этот skill противоречит канонической программе, **побеждает каноническая программа**, а skill должен быть обновлён.

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

- bounded context прошёл DB5/cutover;
- удаляется `src/**` runtime path;
- удаляются HostedServices/flags/old routes;
- нужно доказать zero consumers.

## Hard rules

- Удаление только после accepted cutover + soak + rollback evidence.
- Перед удалением сделать residual searches по code/config/docs/compose/CI.
- Не оставлять zombie writer/worker с выключенным по умолчанию flag как “на всякий случай” бесконечно.
- Legacy route removal и DB writer removal — разные gates.
- Archived docs явно помечать superseded, а не смешивать с каноном.
- Финальная цель: C# production workloads = 0; reference history остаётся Git history, не live runtime.

## Workflow

1. Подтвердить owner = target.
2. Проверить telemetry: legacy traffic/work = 0.
3. Удалить worker/route/config/secret/build artifact волной с rollback commit.
4. Запустить residual grep/static dependency check.
5. Проверить Compose/K8s/CI/docs.
6. Обновить supersession/decommission evidence.

## Минимальная проверка

Перед завершением:

1. проверить соответствие каноническому документу программы;
2. проверить, что не создана новая скрытая cross-boundary зависимость;
3. выполнить targeted unit/integration/contract tests;
4. выполнить architecture/boundary tests для затронутого слоя;
5. проверить Docker build/health, если изменён runtime workload;
6. проверить observability и failure semantics, если изменён I/O/async path;
7. явно записать skipped checks и остаточный риск.

## BusinessLogicHardened Orders/AROMA rule

При Orders/AROMA migration target parity строится против authoritative `Confirm -> Desired -> Observed -> Convergence -> Checkout` semantics. Legacy `sendToAromaCart`/`AromaCartFillBatch` не является обязательным target behavior; из него переносятся только безопасные edge-case invariants. Service links дополнительно проверяются по M20/`next-business-orchestration`.
