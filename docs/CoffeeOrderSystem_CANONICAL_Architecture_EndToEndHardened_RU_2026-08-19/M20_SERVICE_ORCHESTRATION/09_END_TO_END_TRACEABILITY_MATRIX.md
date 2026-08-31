# M20. Сквозная traceability matrix — runtime → contract → state → proof

Этот документ закрывает вопрос «прослеживается ли вся цепочка» на уровне исполняемых границ. Источник topology — `runtime-workload-registry.yml`; Kafka names — `M06/kafka-topic-registry.yml`.

| Шаг | Producer/caller | Граница | Consumer/callee | Authoritative write/proof | Failure rule |
|---|---|---|---|---|---|
| VK intake | VK → `channel-ingress` | `/channels/vk/callback` | `channel-ingress` | durable Kafka accept before provider ACK | duplicate provider event idempotent |
| Identity | `channel-ingress` | `/api/internal-v1/channel-identities/attest` | `channel-identity-broker` | ChannelIdentityLedger + identityEpoch | raw provider ID не идёт downstream |
| Turn request | `channel-intake` | `coffee.agent.turn.requested.v1` | `hermes-dispatcher` | AgentTurn journal | at-least-once + one active turn/conversation |
| Hermes submit | `hermes-dispatcher` | `HermesRunAdapter.submit(turnRef)` | `hermes-runtime` | TurnSubmission + hermesRunRef/discovery | SubmissionUnknown → reconcile, no blind POST |
| Agent tool | `hermes-runtime` plugin | `/api/agent-v1/**` | `api-agent` | owning BC transaction | identity/current customer injected, not model-selected |
| AI confirmation | structured VK proof/operator | trusted proof | Orders | challenge Consumed + Draft→Confirmed + Desired | free-text/LLM alone cannot authorize |
| Operator confirm | `api-public` | client-v1 command | Orders | Order + History + Desired + Outbox one transaction | no Catalog/AROMA HTTP inside transaction |
| Catalog refresh | scheduler/convergence coalesced command | `coffee.catalog.sync.commands.v1` | `catalog-supplier-sync` | complete validated snapshot | partial/stale provider data never means unavailable |
| Supplier read | `catalog-supplier-sync` | `aroma.catalog.read` | `aroma-gateway` → AROMA | Catalog snapshot/hash/run ledger | safe GET bounded retry only |
| Mapping request | `orders-aroma-preparation` | `coffee.catalog.mapping.commands.v1` | `catalog-mapping-resolver` | Catalog Mapping + Audit + Outbox | resolver reads persisted complete snapshot only |
| Catalog facts | Catalog Outbox/CDC | products/availability/mapping topics | `orders-catalog-projection` | Orders Inbox + projection/Desired revision | duplicate no-op; source sequence/version guards |
| Positive cart preflight | `aroma-convergence` | safe internal Catalog read | Catalog | complete snapshot proof/freshness | stale/unavailable → fail closed before cart HTTP |
| Cart observe | `aroma-observer` | `aroma.cart.observe` | `aroma-gateway` | Orders Observed snapshot | external read failure ≠ business state |
| Cart mutation | `aroma-convergence` | `aroma.cart.mutate` | `aroma-gateway` | MutationReservation + Attempt + fresh GET proof | one unsafe mutation; UnknownOutcome reconciled first |
| Checkout freeze | Orders | local transaction + Artifact write | Orders/Artifact Storage | immutable CheckoutAllocationManifest + hash | v1 Order-atomic; no partial normal procurement |
| Wholesale detection | `aroma-checkout-poller` | `aroma.wholesale.read` | `aroma-gateway` | WholesaleLinked proof | cancel race uses second fresh GET + guard window |
| Invoice request | Orders Outbox | `coffee.invoices.commands.v1` | `invoices-command-handler` | allocation manifest ref/hash + wholesale snapshot | Invoices never reads Orders DB |
| Invoice document | `invoice-intake`/`invoice-document-worker` | Artifact Storage | Invoices | scanned PDF ArtifactRef + document hash | quarantine before business use |
| Price proof | Invoices Outbox | `coffee.invoices.events.v1` | `orders-invoice-consumer` | InvoicePriceProofManifest + per-order summary | Orders verifies coverage/hash before transition |
| Payment requirement | Orders Outbox | `coffee.orders.lifecycle.v1` | `payments-order-consumer` | PaymentIntent | amount is server-authoritative |
| PSP create | `payments-order-consumer` | provider HTTP | PSP | provider ref / UnknownOutcome state | timeout → lookup/reconcile, no second blind create |
| PSP callback | PSP | `/webhooks/payments/{provider}` | `payments-webhook` | WebhookInbox first | signature + duplicate protection; redirect is not proof |
| Payment fact | Payments Outbox | `coffee.payments.lifecycle.v1` | `orders-payment-consumer` | Orders state transition | late/duplicate facts current-state guarded |
| Refund/cancel | Orders/ops | `coffee.payments.commands.v1` | `payments-command-handler` | Refund/Cancel attempt + provider proof | append-only compensation; Completed not erased |
| Realtime | each owning BC Outbox | `coffee.realtime.invalidate.v1` | `realtime-gateway` | none — hint only | browser refetches authoritative client-v1 state |
| VK reply | `channel-response-mapper` | `coffee.channels.outbound.v1` | `channel-egress` | delivery journal/event | AgentTurnFailed also yields sanitized terminal reply |

## Closure invariant

Ни один normal happy-path consumer не требует SQL read из чужого bounded-context DB. Cross-owner handoff либо самодостаточен, либо использует immutable ArtifactRef+hash; synchronous reads разрешены только как явно перечисленные safe-read contracts в M20 policy.
