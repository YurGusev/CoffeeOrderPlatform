# CoffeeOrderSystem — каноническая End-to-End Hardened архитектура

**Дата ревизии:** 2026-08-19  
**Язык:** русский  
**Target:** clean-room TypeScript/Node.js + React + Nginx + PostgreSQL + Kafka/Debezium + Hermes + AROMA Gateway + Artifact Storage + selective microservices/Kubernetes.

## Статус

Эта ревизия supersede-ит `CatalogHardened` и закрывает глубокий аудит сквозной цепочки: AI/VK confirmation, Confirmed additions, Order-atomic procurement, Checkout→Invoices allocation proofs, Payment refund/compensation, runtime topology, 100% Kafka payload-schema coverage, exact OpenAPI routes, Catalog source separation, AROMA mutation reservation и numeric SLO/RPO/RTO.

## Канонические machine-readable источники

```text
M06_KAFKA_EVENT_PLATFORM/kafka-topic-registry.yml
M06_KAFKA_EVENT_PLATFORM/message-schema-registry.yml
M20_SERVICE_ORCHESTRATION/service-interaction-policy.yml
M20_SERVICE_ORCHESTRATION/runtime-workload-registry.yml
M19_API_ARCHITECTURE/openapi/*.yaml
```

## End-to-end normal path

```text
VK/React
 -> trusted identity/auth
 -> Draft
 -> trusted confirmation proof
 -> Confirmed + Desired
 -> Catalog mapping/availability
 -> AROMA Convergence
 -> Order-atomic CheckoutAllocationManifest
 -> Wholesale proof
 -> Invoice + immutable price proof
 -> AwaitingCustomerPayment
 -> PSP webhook/reconciliation
 -> PaymentSucceeded
 -> Completed
```

## Core hard rules

- PostgreSQL = authoritative business/process state; Kafka = at-least-once movement.
- No cross-owner SQL.
- No direct Draft `sendToAromaCart`.
- AI/LLM cannot self-authorize confirmation/customer identity/provider mutation.
- One normal Order is not partially procured across multiple checkouts in v1.
- Large manifests/PDF/Excel/audio use ArtifactRef + hash/size, not Kafka blob.
- Normal Catalog resolver reads persisted complete snapshot; only catalog-supplier-sync calls provider catalog GET.
- Unsafe AROMA mutation uses MutationReservation + lease/fencing + fresh GET before/after.
- Browser redirect is not payment proof.
- UInt64/BIGINT versions/revisions are decimal strings on JSON wire.

## Navigation

- `PROGRAMS_INDEX.md` — M00–M20.
- `IMPLEMENTATION_BACKLOG_BY_PROGRAMS.md` — implementation backlog.
- `MASTER_ARCHITECTURE.md` — assembled read/search view.
- `VALIDATION_REPORT.md` — structural + semantic + E2E closure status.
- `AUDIT_CLOSURE_REPORT.md` — AUD-001…AUD-028 closure/evidence map.
- `AGENT_SKILLS_NEW_ARCHITECTURE/` — target-only skills.
