# M20. Service Interaction Matrix

Generated from `service-interaction-policy.yml`. YAML is source of truth.

## Allowed edges

| From | To | Mode | Purpose |
|---|---|---|---|
| `react` | `api-public` | `http` | client-v1 |
| `hermes-runtime` | `api-agent` | `http` | agent-v1 |
| `n8n` | `api-internal` | `http` | bounded-control-plane |
| `channel-ingress` | `channel-identity-broker` | `http-internal` | trusted-identity-attestation |
| `channel-ingress` | `kafka` | `kafka` | channel-message-received |
| `channel-intake` | `kafka` | `kafka` | agent-turn-requested |
| `hermes-dispatcher` | `hermes-runtime` | `http-idempotent-adapter` | submit-reconcile-runs |
| `channel-response-mapper` | `kafka` | `kafka` | channel-outbound-command |
| `channel-egress` | `vk-provider` | `provider-http` | send-message |
| `catalog-supplier-sync` | `aroma-gateway` | `http-safe-read` | complete-wholesale-catalog-snapshot |
| `catalog-mapping-resolver` | `catalog-db` | `db-owning-context` | persisted-complete-snapshot-resolution |
| `catalog` | `kafka` | `outbox-cdc` | product-mapping-availability-facts |
| `orders-draft` | `catalog` | `http-safe-read` | product-snapshot-and-explicit-pricing |
| `orders-confirm-transaction` | `orders-db` | `local-transaction` | status-desired-outbox |
| `orders-convergence` | `catalog` | `http-safe-read` | complete-snapshot-preflight |
| `aroma-observer` | `aroma-gateway` | `http-safe-read` | physical-cart-observation |
| `aroma-convergence` | `aroma-gateway` | `http-get-mutate-get` | physical-convergence |
| `aroma-checkout-poller` | `aroma-gateway` | `http-safe-read` | checkout-wholesale-proof |
| `orders` | `invoices` | `kafka-command` | allocation-manifest-materialization |
| `invoices` | `orders` | `kafka-event` | invoice-price-proof |
| `orders` | `payments` | `kafka-command-or-event` | payment-requirement-refund-cancel |
| `payments` | `orders` | `kafka-event` | verified-payment-refund-facts |
| `payments-order-consumer` | `payment-provider` | `provider-http` | create-payment |
| `payments-command-handler` | `payment-provider` | `provider-http` | cancel-refund |
| `payments-reconciliation` | `payment-provider` | `provider-http-safe-read` | payment-lookup |
| `payment-provider` | `payments-webhook` | `provider-webhook` | signed-payment-events |
| `invoices` | `artifact-storage` | `object-read-write` | invoice-documents-and-proof-manifests |
| `orders` | `artifact-storage` | `object-write` | checkout-allocation-manifest |
| `artifact-scan-worker` | `artifact-storage` | `object-read-write` | quarantine-scan |
| `bounded-contexts` | `kafka` | `outbox-cdc` | direct-realtime-invalidation |

## Denied edges

| From | To | Reason |
|---|---|---|
| `react` | `aroma-gateway` | provider-boundary-not-browser-api |
| `hermes-runtime` | `aroma-gateway` | agent-cannot-own-provider-side-effects |
| `n8n` | `aroma-gateway` | control-plane-cannot-bypass-domain-owner |
| `aroma-gateway` | `orders-db` | gateway-has-no-business-data-ownership |
| `catalog` | `orders-db` | cross-owner-database-write |
| `invoices` | `orders-db` | cross-owner-database-write |
| `payments` | `orders-db` | cross-owner-database-write |
| `orders-confirm-transaction` | `catalog-http` | confirm-must-be-local-atomic |
| `orders-confirm-transaction` | `aroma-gateway` | confirm-must-not-have-external-side-effect |
| `orders-confirm-transaction` | `invoices-http` | no-sync-business-cycle |
| `orders-confirm-transaction` | `payments-http` | no-sync-business-cycle |
| `invoices` | `aroma-gateway` | invoices-consumes-saved-wholesale-proof |
| `aroma-gateway` | `orders-http-callback` | orders-proves-result-via-fresh-read |
| `catalog-mapping-resolver` | `aroma-gateway` | normal-mapping-resolution-uses-persisted-complete-snapshot |
| `catalog-supplier-sync` | `aroma-cart-mutation` | read-only-audience-cannot-mutate-cart |
| `react` | `payments-webhook` | provider-only-route |
| `domain-topics` | `realtime-projector` | canonical-realtime-is-direct-bc-outbox |
