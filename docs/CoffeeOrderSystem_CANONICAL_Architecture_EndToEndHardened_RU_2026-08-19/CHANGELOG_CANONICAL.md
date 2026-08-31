# Changelog канонической сборки

## 2026-08-19 — Kafka Platform Hardening revision

### Исправленные слабости

- добавлен normative production Kafka cluster contract: KRaft, separate controller/broker roles, critical RF3/minISR2, `acks=all`, producer idempotence, auto-topic off;
- устранены противоречивые topic catalogs: `kafka-topic-registry.yml` стал единственным source of truth;
- mixed `coffee.catalog.indexing.v1` и `coffee.aroma.cart.v1` superseded отдельными command/event streams;
- единый ambiguous envelope заменён separate event/command envelopes;
- добавлены exact payload JSON Schemas и `aggregateVersion` lifecycle semantics;
- production partition count теперь capacity-selected contract и не изменяется автоматически KEDA/lag reaction;
- добавлены retention classes, application message-size/reference policy и workload quotas;
- durable consumers fail closed: no auto commit/topic/reset; добавлен bounded completed-ahead offset gap;
- добавлены ReplayJob/DLQ operator workflows и per-consumer replay classes;
- усилен Debezium: capture scope, unique slot/publication, explicit snapshot policy, heartbeat/WAL retention, bounded queue, Connect recovery;
- добавлен P1 spike нового Consumer Rebalance Protocol (`group.protocol=consumer`);
- добавлены Kafka/partition/consumer/Debezium SLI и hot-partition visibility;
- добавлен explicit Kafka/ACKed-ingress RPO/RTO и cross-cluster DR reasoning; MirrorMaker2 не трактуется как RPO=0;
- добавлены Kafka topic/schema/IaC/drift CI gates;
- `next-kafka-event-platform` и связанные `next-*` skills синхронизированы.

## 2026-08-19 — Node.js Runtime Hardening revision

- Fastify-first target; NestJS не baseline;
- Node.js 24 LTS exact patch/digest pinning;
- `api-public`, `api-agent`, `api-internal` separate process roles;
- one Node process = one container/pod role;
- `AbortSignal`/deadline propagation;
- typed fixed-origin provider clients + connection budgets;
- PostgreSQL fleet connection budget/shared transaction primitive;
- ELU/event-loop-delay/RSS/native-memory SLO;
- heavy PDF/Excel вне API event loop;
- shared Node Kafka runtime + Confluent JS compatibility spike;
- realtime multi-replica fan-out и SSE slow-client backpressure;
- fail-fast/graceful-shutdown/container gates;
- добавлен `next-nodejs-runtime`.

## 2026-08-19 — API Architecture consolidation

- добавлена программа `M19_API_ARCHITECTURE`;
- разделены `client-v1`, `agent-v1`, `internal-v1`;
- webhooks/provider/event/realtime APIs оформлены как разные trust/transport classes;
- OpenAPI/JSON Schema стали language-neutral contract formats;
- добавлен `next-api-architecture`.

## 2026-08-19 — Program-grouped canonical architecture

- документация сгруппирована M00–M19;
- React copy-first handover;
- TypeScript/Node target online platform, C# legacy/reference;
- Hermes production runtime, AReaL training-only;
- EDA-080…084 восстановлены;
- n8n control-plane boundary;
- system-design selections, DR/runbooks, skills precedence.

## 2026-08-19 — CatalogHardened

- восстановлена фактическая business logic `Products/Catalog` из `develop`;
- M07 расширен с 2 до 8 нормативных документов;
- complete AROMA supplier snapshot объявлен target operational source;
- зафиксированы materialization/positive price history/product_on_stop/bulk mapping/manual mapping rules;
- разделены effects цены и availability/mapping на существующие Orders;
- Product/Variant tombstone связан с target-zero AROMA convergence;
- manual mapping target усилен atomic Outbox propagation;
- positive cart mutation требует свежий Catalog complete-snapshot preflight;
- добавлен `coffee.catalog.products.v1`, усилены availability/mapping schemas;
- M20 разрешает bounded Orders Draft/Catalog reads и Convergence/Catalog preflight, сохраняя Confirm без external dependency;
- добавлен target-only skill `next-catalog-product-lifecycle`.


## 2026-08-19 — EndToEndHardened

Закрыты AUD-001…AUD-028 глубокого аудита CatalogHardened: self-contained invoice manifests, trusted AI confirmation, AddConfirmedItem, Order-atomic procurement, runtime workload registry, Payments webhook/refund, artifact storage, 100% Kafka schemas+explicit partitions, single realtime model, Customer/ChannelIdentity lifecycle, exact OpenAPI routes, Catalog source separation/concurrency, production purge policy, UInt64 decimal-string wire rule, PII retention, checkout cancel race, numeric SLO/RPO/RTO и semantic validator.
