# M13. Kubernetes Target Runtime

## 1. Kubernetes приходит после Docker/process split

Kubernetes управляет теми же immutable images, которые доказаны в Compose.

## 2. Target workloads

```text
Deployment/coffee-edge or ingress integration
Deployment/platform-web
Deployment/api-public
Deployment/api-agent
Deployment/api-internal
Deployment/channel-ingress
Deployment/channel-egress
Deployment/realtime-gateway
Deployment/hermes-dispatcher
StatefulSet/hermes-runtime
Deployments/domain Kafka consumers
Deployments/document workers
Jobs/CronJobs maintenance
```

## 3. Node process model

Один pod/container application role запускает один Node process. Horizontal scale = replicas.

## 4. API NetworkPolicy

```text
coffee-edge -> api-public only
Hermes/plugin network -> api-agent only
approved internal workloads -> api-internal only
```

`api-agent`/`api-internal` не публикуются обычным public ingress route.

## 5. Kafka/PostgreSQL

На первом production этапе Kafka/PostgreSQL рассматриваются как отдельные stateful platforms/managed/dedicated infrastructure.

## 6. Scaling signals

| Workload | Signals |
|---|---|
| platform-web | HTTP RPS, p95, CPU |
| api-public | RPS, p95/p99, ELU, event-loop delay, DB pool wait |
| api-agent | tool RPS, p99, ELU, DB pool wait |
| api-internal | operation age/p99, DB/provider saturation |
| channel-ingress | callback RPS, ELU, Kafka produce latency |
| channel-egress | oldest outbound age, provider quota/429, ELU |
| realtime | connections, pending bytes, RSS, ELU, reconnect rate |
| Kafka consumers | lag + oldest event age + DB/provider budget |
| Hermes dispatcher | waiting turns + oldest turn age + ELU |
| inference | queue wait + tokens/sec + GPU |

CPU-only HPA для Node workloads недостаточен.

## 7. HPA/KEDA

HPA/custom metrics — HTTP/stateless workloads. KEDA — Kafka consumers, но replicas ограничиваются partitions и downstream budgets.

## 8. Realtime fan-out

Realtime replicas не используют одну shared Kafka group для broadcast локальным SSE clients. Baseline — unique ephemeral group per replica; дальнейший backplane требует отдельного ADR.

## 9. Hermes scale-down

Stateful; blind HPA scale-down запрещён. Использовать drain/no-new-sessions/reassignment.

## 10. Node memory/termination

Resource limits учитывают V8 + native addons/Buffers. `terminationGracePeriodSeconds` согласован с bounded drain contract роли.

## 11. NetworkPolicy / secrets

Default deny и per-workload service identities/secrets. Никакого общего `.env` со всеми credentials.


## Orders/AROMA process roles

Kubernetes workloads могут быть отдельными Deployments:

```text
catalog-supplier-sync
orders-aroma-preparation
aroma-observer
aroma-convergence
aroma-checkout-poller
aroma-gateway
```

Но первые четыре принадлежат Orders bounded context и работают только с Orders-owned state. Их разделение — bulkhead/scaling boundary, **не microservice/data ownership split**.

`aroma-gateway` не получает доступ к Orders DB. NetworkPolicy разрешает нужным Orders roles -> Gateway; обратный business callback запрещён.

`catalog-supplier-sync` имеет Catalog DB + safe-read Gateway access, но не Orders DB и не cart-mutation credentials.

## Canonical workload list

The complete workload inventory is `M20_SERVICE_ORCHESTRATION/runtime-workload-registry.yml`. K8s manifests/Helm must include every `productionCritical: true` role, including `channel-identity-broker`, `channel-intake`, `channel-response-mapper`, `hermes-runtime`, `payments-webhook`, invoice document workers and Orders event consumers. `catalog-supplier-sync` is Catalog-owned, not Orders-owned.


## Artifact Storage

Production prefers managed/S3-compatible object storage outside pod filesystem. `artifact-storage` in Compose is dev/test reference; K8s workloads receive namespace-scoped credentials and `artifact-scan-worker` handles quarantined uploads.
