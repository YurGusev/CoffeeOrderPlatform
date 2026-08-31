# 23. Nginx Route Cutover Runbook

## 1. Цель

Переключать route family между legacy и platform независимо от остальных bounded contexts.

## 2. Route families

Минимум:

```text
web
customers
catalog/products
orders
invoices
payments
agent
channels
realtime
```

## 3. Web cutover

До:

```text
/app/* -> old reactweb
```

После frontend handover:

```text
/app/* -> platform-web
```

API target не меняется.

## 4. Backend cutover

Пример Catalog:

```text
/api/client-v1/products/*
```

states:

```text
legacy
shadow
canary
platform
```

Shadow не должен выполнять duplicate mutations.

## 5. Pre-cutover checklist

- target ready/healthy;
- image digest pinned;
- contract/parity suite green;
- DB ownership compatible;
- migrations applied/verified;
- dashboards split by target;
- rollback target healthy;
- operator explicit go/no-go.

## 6. Canary

Canary selector должен быть server/edge controlled. Не доверять произвольному public header, позволяющему клиенту самостоятельно выбрать internal backend.

## 7. Observe

Сравнить:

```text
p95/p99
5xx/conflicts
DB queries/locks
resource saturation
semantic mismatch
business outcome
```

## 8. Rollback

Route rollback безопасен только если previous runtime всё ещё понимает текущую schema/contract.

Если TS применил backward-incompatible DB migration, простой Nginx switch не является rollback.

Следовательно migrations во время migration window должны быть expand/contract и backward-compatible до закрытия rollback window.

## 9. Expand/contract

```text
EXPAND
add nullable/new compatible structures
both versions can run

CUTOVER
new writer/read path

CONTRACT
remove obsolete columns/contracts only after rollback window closed
```

## 10. Evidence

Каждый cutover сохраняет:

```text
route family
old/new target
commit/image digests
DB migration version
start/end time
canary cohort
SLO snapshot
rollback result
approver/operator
```
