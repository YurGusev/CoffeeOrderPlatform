# M06. Canonical topics, keys и runtime groups

**Source of truth:** `kafka-topic-registry.yml`. Таблица ниже генерируется из registry и не редактируется независимо.

| Topic | Kind | Owner | Key | Partitions | Consumer groups | Payload schemas | PII |
|---|---|---|---|---:|---|---|---|
| coffee.channels.inbound.v1 | event | channel-platform | ConversationKeyHash | 24 | channel-intake | channel-message-received.v1.schema.json | user-generated-content-possible-pii |
| coffee.agent.turn.requested.v1 | command | agent-platform | ConversationKeyHash | 24 | hermes-dispatcher | agent-turn-requested.v1.schema.json | user-generated-content-possible-pii |
| coffee.agent.turn.completed.v1 | event | agent-platform | ConversationKeyHash | 24 | channel-response-mapper,agent-telemetry | agent-turn-completed.v1.schema.json | user-generated-content-possible-pii |
| coffee.agent.turn.failed.v1 | event | agent-platform | ConversationKeyHash | 12 | channel-response-mapper,agent-operations | agent-turn-failed.v1.schema.json | user-generated-content-possible-pii |
| coffee.channels.outbound.v1 | command | channel-platform | ConversationKeyHash | 24 | channel-egress | channel-message-send-requested.v1.schema.json | user-generated-content-possible-pii |
| coffee.channels.delivery.v1 | event | channel-platform | DeliveryRef | 12 | channel-operations | channel-delivery-result.v1.schema.json | provider-delivery-metadata |
| coffee.orders.lifecycle.v1 | event | orders | OrderRef | 12 | payments-order-events | order-confirmed.v1.schema.json,order-payment-required.v1.schema.json,order-completed.v1.schema.json,order-cancelled.v1.schema.json | business-minimized |
| coffee.catalog.products.v1 | event | catalog | ProductRef | 6 | catalog-indexing | catalog-product-changed.v1.schema.json | none |
| coffee.catalog.availability.v1 | event | catalog | CatalogAvailabilityStreamRef | 12 | orders-catalog-projection | product-availability-changed.v1.schema.json | none |
| coffee.catalog.mapping.commands.v1 | command | catalog | CoffeeWeightVariantRef | 12 | catalog-mapping-resolver | catalog-mapping-resolution-requested.v1.schema.json | none |
| coffee.catalog.mapping.v1 | event | catalog | CoffeeWeightVariantRef | 12 | orders-catalog-mapping | catalog-mapping-changed.v1.schema.json | none |
| coffee.catalog.sync.commands.v1 | command | catalog | WholesaleCatalog | 3 | catalog-supplier-sync | catalog-refresh-requested.v1.schema.json | none |
| coffee.invoices.commands.v1 | command | invoices | InvoiceOperationRef | 6 | invoices-command-handler | invoice-materialization-requested.v1.schema.json,invoice-compensation-requested.v1.schema.json | business-minimized |
| coffee.invoices.events.v1 | event | invoices | ClientInvoiceRef | 6 | orders-invoice-events | invoice-materialized.v1.schema.json,invoice-pdf-linked.v1.schema.json,invoice-prices-applied.v1.schema.json,invoice-compensated.v1.schema.json,invoice-compensation-failed.v1.schema.json | business-minimized |
| coffee.payments.commands.v1 | command | payments | PaymentOperationRef | 6 | payments-command-handler | payment-refund-requested.v1.schema.json,payment-intent-cancel-requested.v1.schema.json | payment-metadata-no-card-data |
| coffee.payments.lifecycle.v1 | event | payments | PaymentIntentRef | 6 | orders-payment-events,payment-audit | payment-intent-ready.v1.schema.json,payment-succeeded.v1.schema.json,payment-failed.v1.schema.json,payment-refunded.v1.schema.json,payment-refund-failed.v1.schema.json,payment-intent-cancelled.v1.schema.json | payment-metadata-no-card-data |
| coffee.aroma.preparation.commands.v1 | command | orders | OrderRef | 12 | orders-aroma-preparation | aroma-preparation-requested.v1.schema.json | business-refs-only |
| coffee.aroma.cart.commands.v1 | command | orders | ProfileName+CartKeyHash | 24 | aroma-convergence | aroma-converge-requested.v1.schema.json | business-refs-only |
| coffee.aroma.cart.events.v1 | event | orders | ProfileName+CartKeyHash | 24 | orders-aroma-events,aroma-operations | aroma-cart-observed.v1.schema.json,aroma-convergence-result.v1.schema.json | business-minimized |
| coffee.realtime.invalidate.v1 | event | realtime-platform | ScopeEntityKey | 24 | ephemeral-per-replica | realtime-invalidation.v1.schema.json | refs-only |

## Key rule

Key является business ordering contract. Partition count после cutover immutable; изменение ordering topology требует нового topic version/migration.

## Realtime

Domain topics не имеют `realtime-*` groups. BC Outbox напрямую публикует `coffee.realtime.invalidate.v1`.

## Catalog indexing

`catalog-indexing` читает `coffee.catalog.products.v1`; отдельные indexing command/event topics superseded.
