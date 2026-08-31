# M20 — Service Interaction & Business Orchestration

## Назначение

Нормативный source of truth для связей между bounded contexts, runtime roles и внешними providers.

Главная задача — сохранить бизнес-ownership при переходе к Kafka/microservices и не создать distributed monolith/cyclic HTTP graph.

## Документы

1. `01_SERVICE_OWNERSHIP_AND_RUNTIME_ROLES.md`
2. `02_SERVICE_INTERACTION_MATRIX.md`
3. `03_SYNC_ASYNC_CALL_GRAPH_AND_ANTI_CYCLES.md`
4. `04_END_TO_END_ORDER_FULFILLMENT_ORCHESTRATION.md`
5. `05_CROSS_SERVICE_FAILURE_AND_RECOVERY.md`
6. `06_CATALOG_PRODUCT_SERVICE_CONNECTIONS.md`

Если другой program document разрешает связь, но M20 её запрещает, требуется ADR/обновление M20 до реализации.

## Machine-readable policy

`service-interaction-policy.yml` — будущий источник для architecture-test/CI. `SERVICE_GRAPH_ACCEPTANCE_CHECKLIST.md` применяется на review/cutover.

## Machine-readable sources

Source of truth:

1. `service-interaction-policy.yml` — allowed/denied edges;
2. `runtime-workload-registry.yml` — executable roles/consumer groups.

CSV/Mermaid/Markdown tables are generated views and cannot override YAML.

- `07_RUNTIME_WORKLOAD_REGISTRY.md`

- `08_END_TO_END_CONTRACT_CLOSURE.md`

- `09_END_TO_END_TRACEABILITY_MATRIX.md` — сквозная runtime/contract/state/proof трассировка.


## End-to-end closure status

Specification-level happy path and compensation edges are closed by M20 `09_END_TO_END_TRACEABILITY_MATRIX.md`. Production evidence is a separate M15/M16 gate and remains conditional until load, provider, chaos and restore drills pass.
