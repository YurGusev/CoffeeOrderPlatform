# 20. Security и trust boundaries

## 1. Зоны доверия

```text
Internet
 -> coffee-edge
 -> web/channel public workloads
 -> internal platform
 -> data/event layer
 -> external providers
 -> Hermes/model zone
```

Default deny между зонами.

## 2. `coffee-edge`

Единственный public application entrypoint.

Он:

- TLS termination;
- canonical host/paths;
- trusted forwarding headers;
- route-specific body limits;
- coarse rate limits;
- hides internal services;
- blocks `/api/agent-v1/*` и `/api/internal-v1/*` from public access.

## 3. React frontend

Browser — untrusted client.

Никогда не доверять:

- customerId/order owner;
- prices/totals;
- roles из UI state;
- confirmation status;
- hidden fields.

React отображает server-derived capabilities.

## 4. Internal static web server

`platform-web` не получает:

```text
DB credentials
Kafka business credentials
AROMA secrets
payment secrets
Hermes service token
```

Он хранит только public frontend artifact/configuration.

## 5. Platform API surfaces

Разделить не только логически, но и физически:

```text
api-public   -> /api/client-v1/*
api-agent    -> /api/agent-v1/*
api-internal -> /api/internal-v1/*
```

Один actor не должен автоматически иметь доступ к другому surface. Public edge имеет upstream только к `api-public`; private roles доступны только разрешённым service identities/NetworkPolicy.

## 6. VK identity

Node Channel Gateway валидирует provider payload, затем создаётся opaque `channelIdentityRef`.

Hermes tool:

```text
resolve_current_customer()
```

не принимает `vk_user_id` или `customerId` от модели.

## 7. Hermes

Production Coffee Hermes profile получает только CoffeeOrder plugin capabilities.

Запрещены по умолчанию:

```text
terminal/shell
filesystem writes
arbitrary web/browser
code execution
GitHub
sudo
unrestricted MCP
delegation/subagents
```

## 8. Kafka

- private network;
- TLS/auth;
- separate principal per workload;
- topic-scoped ACL;
- no application wildcard admin;
- secrets injected runtime-only.

## 9. PostgreSQL

Отдельный principal на bounded context/runtime role.

Migration ladder:

```text
read-only clone role
shadow writable clone role
production read role
production owner role
```

Никогда не выдавать target platform broad superuser для ускорения миграции.

## 10. Payments

- hosted payment UI/redirect where possible;
- card data не проходит через Coffee platform;
- webhook/provider authenticity проверяется owning service;
- amount/currency/order relation перепроверяются сервером;
- secrets изолированы.

## 11. AROMA

AROMA credentials доступны только gateway/provider workload.

Model/React не получают provider cookies/tokens.

## 12. Secrets

Запрещены tracked `.env` с real credentials.

Target:

```text
.env.example -> names/default-safe placeholders only
runtime secrets -> CI/Kubernetes/secret manager
```

Rotation и revocation — часть runbook.

## 13. Supply chain

Каждый production release фиксирует:

```text
commit SHA
image digest
lockfile
SBOM where available
vulnerability scan
base image digest/version
```

## 14. Log policy

Не логировать:

- tokens/cookies/passwords;
- raw payment data;
- raw VK IDs в generic logs;
- unbounded customer messages/tool results;
- sensitive addresses/phones без explicit audit need.

## 15. NetworkPolicy target

Примеры:

```text
platform-web -> no DB
channel-ingress -> Kafka + identity API
Hermes -> agent-v1 + model
Payments -> own DB + Kafka + PSP
AROMA Gateway -> AROMA + own secret
```
