# 02. Структура репозитория и clean-room граница

## 1. Рекомендуемый layout

```text
CoffeeOrderSystem/
├── src/                                  # legacy/reference .NET до decommission
│
├── platform/                             # новая online platform
│   ├── apps/
│   │   ├── web/                          # перенесённый React source + Dockerfile
│   │   ├── api-public/                   # /api/client-v1 only
│   │   ├── api-agent/                    # /api/agent-v1 only
│   │   ├── api-internal/                 # /api/internal-v1 only
│   │   │
│   │   ├── channel-ingress/
│   │   ├── channel-identity-broker/
│   │   ├── channel-intake/
│   │   ├── channel-response-mapper/
│   │   ├── channel-egress/
│   │   ├── realtime-gateway/
│   │   ├── hermes-dispatcher/
│   │   │
│   │   ├── catalog-supplier-sync/
│   │   ├── catalog-mapping-resolver/
│   │   ├── catalog-search-indexer/       # projection from coffee.catalog.products.v1
│   │   │
│   │   ├── orders-aroma-preparation/
│   │   ├── orders-catalog-projection/
│   │   ├── orders-aroma-event-projector/
│   │   ├── aroma-observer/
│   │   ├── aroma-convergence/
│   │   ├── aroma-checkout-poller/
│   │   ├── orders-invoice-consumer/
│   │   ├── orders-payment-consumer/
│   │   │
│   │   ├── invoices-worker/              # invoices-command-handler executable
│   │   ├── invoice-intake/
│   │   ├── invoice-document-worker/
│   │   │
│   │   ├── payments-order-consumer/
│   │   ├── payments-command-handler/
│   │   ├── payments-webhook/
│   │   ├── payments-reconciliation/
│   │   │
│   │   ├── aroma-gateway/                # provider transport boundary only
│   │   ├── artifact-scan-worker/
│   │   └── operations-projections/       # optional telemetry/audit projections
│   │
│   ├── modules/
│   │   ├── customer/
│   │   ├── catalog/
│   │   ├── orders/
│   │   ├── invoices/
│   │   └── payments/
│   │
│   ├── integrations/
│   │   └── aroma-provider/               # provider DTO/auth/session/HTTP adapters
│   │
│   ├── packages/
│   │   ├── contracts/
│   │   ├── http-runtime/
│   │   ├── http-client/
│   │   ├── kafka-runtime/
│   │   ├── database/
│   │   ├── observability/
│   │   ├── security/
│   │   ├── idempotency/
│   │   ├── artifact-client/
│   │   ├── config/
│   │   └── testkit/
│   │
│   ├── tests/
│   ├── pnpm-workspace.yaml
│   └── tsconfig.base.json
│
├── edge/
│   ├── nginx.conf
│   ├── route-maps/
│   └── Dockerfile
│
├── infra/
│   ├── compose/
│   ├── kafka/
│   │   ├── cluster/
│   │   ├── topics/
│   │   ├── principals/
│   │   ├── acls/
│   │   ├── quotas/
│   │   ├── connect/
│   │   ├── schema-registry/
│   │   ├── dr/
│   │   └── policies/
│   ├── debezium/
│   ├── postgres/
│   ├── artifact-storage/                 # dev reference only; managed in prod allowed
│   ├── observability/
│   └── kubernetes/
│
├── hermes/
│   ├── runtime/
│   ├── profile/
│   └── coffeeorder-plugin/
│
└── training/
    ├── datasets/
    ├── evaluation/
    └── areal/
```

**Executable inventory source of truth:** `M20_SERVICE_ORCHESTRATION/runtime-workload-registry.yml`. Layout examples do not authorize omission/merging of a `productionCritical: true` runtime role.

## 2. Важное различие: bounded context != runtime role

`Orders`, `Catalog`, `Invoices`, `Payments`, `Customer` — владельцы бизнес-данных и инвариантов.

`aroma-observer`, `aroma-convergence`, `orders-aroma-preparation`, `aroma-checkout-poller` — **не новые bounded contexts**. Это отдельные process roles внутри ownership Orders. Они могут масштабироваться и деплоиться отдельно, но не получают отдельную бизнес-истину и не становятся владельцами `orders.*`.

`aroma-gateway` — также не bounded context. Это provider boundary: протокол, auth/session, provider DTO и HTTP. Он не хранит `Desired`, `Observed`, Order lifecycle, checkout или payment truth.

## 3. Почему `platform/`, а не `src/typescript`

`src/` исторически отражает текущую .NET solution и несёт legacy context. Новая root-level `platform/` подчёркивает независимость implementation, toolchain, build graph и ownership.

## 4. Clean-room compile boundary

CI запрещает:

- импорт implementation-файлов из `src/` в `platform/`;
- использование .NET DLL как runtime dependency новой платформы;
- генерацию TS types из внутренних C# domain classes;
- прямой shared source между legacy и target.

Разрешён shared **contract/evidence**, если он опубликован в language-neutral form:

```text
OpenAPI
JSON Schema
Kafka schema
SQL schema snapshot
HTTP behavior fixture
characterization corpus
state-transition fixture
```

## 5. Platform-specific AGENTS.md

Создать `platform/AGENTS.md` с требованиями:

- TypeScript strict;
- runtime validation внешних данных;
- no `any` without documented exception;
- no direct cross-module DB access;
- one schema write owner;
- no Kafka dual-write after DB commit;
- idempotency for mutation boundary;
- tests/invariants are behavioral source of truth;
- no imports from `/src`;
- no `sendToAromaCart`/legacy cart-fill implementation in target code;
- Orders lifecycle, supplier fulfillment, AROMA convergence, checkout and payment remain separate state machines.

## 6. Shared package policy

Shared packages разрешены только для cross-cutting infrastructure/contracts.

Хорошо:

```text
@coffee/contracts
@coffee/kafka
@coffee/observability
@coffee/testkit
```

Плохо:

```text
@coffee/shared-domain-everything
@coffee/orders-internals imported by catalog/payments
```

## 7. Node process boundary

Новая платформа не создаёт один универсальный `platform-api` process. HTTP trust surfaces и long-lived external/async roles физически разделены. Горизонтальный scale выполняется container/pod replicas, не PM2/node cluster внутри контейнера.

## 8. Kafka IaC boundary

`infra/kafka/**` хранит desired state cluster/topics/principals/ACL/quotas/Connect/schema-registry/DR policies. Applications не создают production topics и не меняют partition topology во время startup/runtime. Canonical logical topic registry находится в M06.

## 9. Нормативная карта связей сервисов

Все разрешённые sync/async связи, anti-cycle rules и runtime owners определены программой `M20_SERVICE_ORCHESTRATION`. Если repository layout допускает связь, но M20 её запрещает, **побеждает M20**.

`catalog-supplier-sync` — Catalog-owned process role: complete supplier snapshot + Catalog transaction. Он не является отдельным bounded context и не имеет Orders/cart-mutation access.
