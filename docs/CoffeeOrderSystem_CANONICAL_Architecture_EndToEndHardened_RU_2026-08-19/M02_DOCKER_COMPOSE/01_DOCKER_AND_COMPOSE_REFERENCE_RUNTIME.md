# M02. Docker и Docker Compose как reference runtime

## 1. Docker вводится с Phase P0

Каждый deployable workload обязан иметь production-grade image до production integration.

## 2. Process rule

```text
one application role = one Node process = one container
```

Не использовать PM2/node cluster внутри target container для горизонтального scale.

## 3. Compose layout

```text
infra/compose/
├── compose.base.yml
├── compose.legacy.yml
├── compose.platform.yml
├── compose.kafka.yml
├── compose.hermes.yml
├── compose.observability.yml
├── compose.dev.yml
├── compose.test.yml
└── compose.production-single-host.yml
```

## 4. Platform profile

```text
coffee-edge
platform-web
api-public
api-agent
api-internal
channel-ingress
channel-egress
realtime-gateway
hermes-dispatcher
postgres
```

API roles не объединяются только ради более короткого Compose файла.

## 5. Event profile

Добавляет Kafka, Kafka Connect/Debezium, consumer roles и provider/model stubs.

## 6. Node base images

Workloads с native Kafka/OTel dependencies используют проверенный glibc baseline, предпочтительно `node:24-bookworm-slim` с exact patch+digest. Alpine допускается после compatibility smoke.

`platform-web` остаётся Node build-stage → Nginx runtime.

## 7. Multi-stage / non-root

Build toolchain не попадает в runtime image. Application workloads запускаются non-root.

## 8. Node memory contract

Каждый Node service имеет:

```text
memory request/limit
V8 heap policy
native/Buffer headroom
termination grace period
```

Нельзя задавать V8 heap почти равным container memory limit.

## 9. Health

Readiness отражает способность принять новую работу. Liveness не падает только потому, что внешний provider временно недоступен.

## 10. Graceful stop

Compose/Kubernetes stop grace должен позволять workload-specific drain: HTTP, Kafka, SSE, Hermes Dispatcher.

## 11. Reference topology

Compose используется как executable architecture specification для dev/CI/single-host stage и должен сохранять те же process/trust boundaries, которые затем будут в Kubernetes.

## 12. Image identity

Фиксируются source commit, exact runtime version, image digest, lockfile hash, SBOM/provenance where available. `latest` не является release identity.


## Kafka production topology boundary

Compose Kafka profile предназначен для local/reference/integration tests. Он **не является production cluster contract**. Production Kafka следует M06 `05_KAFKA_PRODUCTION_CLUSTER_CONTRACT.md`: KRaft, separate controller/broker roles или managed equivalent, critical RF/minISR, ACL/quotas и DR reasoning. Не копировать single-node/combined Compose Kafka topology в production manifests.

## Business/runtime process roles

`compose-target-skeleton.yml` is generated/validated against M20 runtime registry. The critical reference topology includes at least:

```text
Channel:   channel-ingress, channel-identity-broker, channel-intake,
           channel-response-mapper, channel-egress
Agent:     hermes-dispatcher, hermes-runtime
Catalog:   catalog-supplier-sync, catalog-mapping-resolver
Orders:    orders-aroma-preparation, orders-catalog-projection,
           orders-aroma-event-projector, aroma-observer, aroma-convergence,
           aroma-checkout-poller, orders-invoice-consumer, orders-payment-consumer
Invoices:  invoices-worker, invoice-intake, invoice-document-worker
Payments:  payments-order-consumer, payments-command-handler,
           payments-webhook, payments-reconciliation
Edge/API:  api-public, api-agent, api-internal, realtime-gateway, aroma-gateway
Artifacts: artifact-storage (reference) + artifact-scan-worker
```

`catalog-supplier-sync` is Catalog-owned and uses Catalog DB + only the `aroma.catalog.read` Gateway audience. It has neither Orders DB credentials nor cart-mutation permission.

`aroma-observer`, `aroma-convergence`, `aroma-checkout-poller` are Orders-owned runtime roles; `aroma-gateway` is provider boundary and owns no Orders state.

`payments-webhook` is an inbound provider-only HTTP workload, not a browser/API alias. Its presence is mandatory whenever Nginx exposes `/webhooks/payments/{provider}`.

The complete inventory and consumer-group binding is `M20_SERVICE_ORCHESTRATION/runtime-workload-registry.yml`.
