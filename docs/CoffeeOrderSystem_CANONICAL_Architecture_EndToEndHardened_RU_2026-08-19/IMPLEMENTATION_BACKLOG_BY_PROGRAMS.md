# Реализационный backlog по программам

Это канонический backlog верхнего уровня. Детали и Definition of Done находятся в `README.md` соответствующей программы.

## M00 — Architecture Foundation

- M000 принять/зафиксировать canonical ADR set;
- M001 создать `platform/` workspace;
- M002 создать `platform/AGENTS.md` и boundary tests;
- M003 создать language-neutral contract registry;
- M004 зафиксировать runtime ownership и supersession map;
- M005 создать canonical architecture CI check.

## M01 — Frontend Handover

- M100 snapshot current React source/contract/image;
- M101 copy `src/CoffeeOrderSystem.Web` → `platform/apps/web`;
- M102 сохранить build/CSP/bundle/Vitest/Playwright parity;
- M103 адаптировать root pnpm workspace;
- M104 отвязать OpenAPI generation от ASP.NET `obj`;
- M105 build `platform-web` image: Node build-stage + Nginx runtime;
- M106 side-by-side old/new web containers;
- M107 Nginx `/app/*` canary/cutover;
- M108 freeze old React tree;
- M109 delete old React tree after soak.

## M02 — Docker / Compose

- M200 разделить `infra/compose` profiles;
- M201 common networks/health/secret injection;
- M202 platform profile;
- M203 Kafka/Debezium profile;
- M204 Hermes/model-stub profile;
- M205 observability profile;
- M206 full integration reference environment;
- M207 Toxiproxy/fault profile.

## M03 — Nginx Strangler

- M300 backend route-family maps;
- M301 route-specific body limits;
- M302 API canary/rollback controls;
- M303 SSE/WebSocket routes;
- M304 trusted forwarded-header policy;
- M305 target metrics/evidence headers;
- M306 schema-compatibility rollback gate.

## M04 — TypeScript Platform

- M400 framework/runtime ADR;
- M401 strict tsconfig/ESLint/no unsafe `any`;
- M402 runtime schema validation;
- M403 Money/date/time primitives;
- M404 PostgreSQL transaction layer;
- M405 Problem/error model;
- M406 service auth/security context;
- M407 реализовать TypeScript HTTP adapters/runtime validation по M19 `client-v1`/`agent-v1`/`internal-v1` contracts;
- M408 OpenTelemetry/request context package;
- M409 n8n control-plane boundary tests;
- M410 зафиксировать Fastify-first ADR и запретить NestJS без отдельного ADR;
- M411 создать отдельные `api-public` / `api-agent` / `api-internal` composition roots;
- M412 создать `packages/http-runtime` и typed provider HTTP clients с bounded pools;
- M413 внедрить `ExecutionContext` + AbortSignal/deadline propagation;
- M414 создать fleet-wide PostgreSQL connection-budget model + shared transaction primitive;
- M415 выбрать один SQL toolkit через POC/ADR;
- M416 внедрить event-loop/memory metrics и blocking-sync static guard;
- M417 вынести PDF/Excel heavy processing из API event loop;
- M418 внедрить Node graceful shutdown/fail-fast runtime contract.

## M05 — Database Ladder

- M500 DB1 real DDL/schema export;
- M501 sanitized DB2 clone process;
- M502 DB3 writable shadow clone;
- M503 DB4 production read role;
- M504 schema ownership registry;
- M505 expand/contract migration policy;
- M506 DB5 cutover/rollback evidence template.

## M06 — Kafka / Event Platform

- M600 local/test Kafka cluster;
- M601 canonical event envelope/schema;
- M602 topic/key/group conventions;
- M603 Debezium/Kafka Connect outbox routing;
- M604 Inbox/idempotency library;
- M605 replay/duplicate/rebalance tests;
- M606 lag + oldest-event-age dashboards;
- M607 DLQ/recovery runbook;
- M608 schema compatibility CI;
- M609 выполнить Node24+pnpm+Docker compatibility spike `@confluentinc/kafka-javascript`;
- M610 создать shared `platform/packages/kafka-runtime`;
- M611 реализовать bounded in-flight + contiguous safe offset/rebalance drain primitives;
- M612 зафиксировать idempotent channel-ingress producer profile;
- M613 реализовать realtime per-replica ephemeral consumer-group broadcast baseline;
- M614 добавить native Kafka/RSS/client statistics observability;
- M615 принять production Kafka cluster contract: KRaft separate controllers/brokers, RF3/minISR2 critical profiles, auto-create off, ACL/quota baseline;
- M616 сделать `kafka-topic-registry.yml` единственным source of truth и убрать дублирующие topic catalogs;
- M617 удалить отдельные Catalog indexing command/event topics из baseline; `catalog-search-indexer` читает `coffee.catalog.products.v1`; AROMA cart остаётся separate commands/events;
- M618 внедрить separate integration event/command envelopes и message-specific payload schemas;
- M619 добавить `aggregateVersion` для lifecycle events и stable idempotency/deadline semantics для commands;
- M620 зафиксировать production partition counts capacity test и запретить automatic partition expansion active keyed topics;
- M621 ввести retention classes, payload-size/reference policy и workload quotas;
- M622 усилить durable consumer fail-closed profile: no auto commit/topic/reset + bounded completed-ahead gap;
- M623 внедрить ReplayJob/DLQ operator workflow и per-consumer replay policies;
- M624 принять Debezium production contract: include-list, unique slot/publication, snapshot policy, heartbeat, WAL/queue alarms;
- M625 провести KIP-848 `group.protocol=consumer` compatibility/load spike с Node/librdkafka client;
- M626 добавить Kafka/Connect/partition-level SLO dashboard и hot-key detection;
- M627 определить Kafka RPO/RTO и ACKed-ingress RPO; принять MirrorMaker2/managed DR only if required;
- M628 добавить Kafka chaos/recovery drills: broker/controller/minISR/offset loss/connector restart;
- M629 внедрить runtime Schema Registry только после P1 ADR; Git schemas + CI остаются source of truth.

## M07 — Customer / Catalog

- M700 Customer reads/parity;
- M701 Catalog reads/parity;
- M702 HTTP parity harness;
- M703 production read-shadow;
- M704 Nginx read canary;
- M705 Catalog writable clone parity;
- M706 DB5 Catalog ownership;
- M707 Customer write cutover when ready.
- M708 characterize Product/Variant/Alias/version/availability behavior;
- M709 implement complete supplier snapshot worker with lease/fence/quality/hash;
- M710 implement deterministic materialization + ProductPriceHistory;
- M711 implement availability transitions + product/variant tombstone Outbox;
- M712 implement deterministic/manual mapping lifecycle + immediate mapping Outbox;
- M713 implement Catalog Product/Availability/Mapping Kafka schemas + Orders Inbox parity;
- M714 implement Draft explicit procurement pricing read/refresh parity;
- M715 implement Catalog pre-cart freshness proof for positive convergence;
- M716 property/failure tests for stop/restore/remap/delete/price/no-op;

## M08 — Payments

- M800 PaymentIntent/Attempt domain;
- M801 provider adapter contract;
- M802 YooKassa/Robokassa adapters as selected;
- M803 webhook inbox/authenticity verification;
- M804 reconciliation/UnknownOutcome;
- M805 refunds;
- M806 Kafka lifecycle events;
- M807 provider failure/idempotency suite;
- M808 production canary.

## M09 — Hermes / VK

- M900 Channel Identity Broker;
- M901 VK ingress TypeScript;
- M902 `coffee.channels.inbound.v1`;
- M903 Hermes Dispatcher TypeScript;
- M904 AgentTurn journal / one-active-turn gate;
- M905 Hermes shard/session binding + OwnerEpoch;
- M906 CoffeeOrder plugin + `agent-v1`;
- M907 VK outbound TypeScript;
- M908 10k→100k+ conversation/load/failure ladder;
- M909 provider route/fallback certification.

### EDA-8 compatibility numbering

- EDA-080 `coffee.agent.turn.requested.v1`;
- EDA-081 Coffee Hermes Dispatcher;
- EDA-082 Hermes Runtime Pool/session binding;
- EDA-083 `AgentTurnCompleted/Failed`;
- EDA-084 Hermes/model-stub load test.

## M10 — Invoices

- M1000 reads/parity;
- M1001 materialization;
- M1002 PDF worker boundary;
- M1003 reconciliation;
- M1004 Kafka event/command migration;
- M1005 DB5 ownership;
- M1006 remove legacy Invoice transport worker.

## M11 — AROMA Gateway

- M1100 auth/session transport;
- M1101 safe GET/read model;
- M1102 provider rate/circuit/bulkhead;
- M1103 one explicit mutation primitive;
- M1104 fault/UnknownOutcome tests;
- M1105 legacy Orders → TS Gateway bridge;
- M1106 Desired/Observed parity harness;
- M1107 lease/fencing migration evidence.
- M1108 Catalog-driven positive preflight and target-zero stop/remap/tombstone convergence parity;

## M12 — Orders

- M1200 characterization corpus/property generators;
- M1201 read parity;
- M1202 Draft decision shadow;
- M1203 Draft write canary;
- M1204 confirmation proof parity;
- M1205 checkout;
- M1206 AROMA Desired/Observed parity;
- M1207 lease/fencing/UnknownOutcome;
- M1208 DB5 Orders ownership;
- M1209 legacy Orders disable.

## M13 — Kubernetes / Selective Microservices

- M1300 image/probe/resource readiness;
- M1301 namespaces/RBAC/NetworkPolicy;
- M1302 stateless Deployments;
- M1303 Kafka consumer autoscaling where useful;
- M1304 Hermes StatefulSet/state-aware drain;
- M1305 topology spread/PDB;
- M1306 GPU/inference placement;
- M1307 multi-node production rollout;
- M1308 service extraction gates/DB ownership enforcement.

## M14 — Decommission

- M1400 zero legacy route evidence;
- M1401 zero legacy writer evidence;
- M1402 remove C# HostedService/consumers;
- M1403 archive migration evidence;
- M1404 remove old Compose services;
- M1405 remove old React tree;
- M1406 remove C# production runtime;
- M1407 remove obsolete flags/config/docs after retention window.

## M15 — Reliability / Operations

- M1500 workload/capacity model;
- M1501 backpressure/bulkheads/retry budgets;
- M1502 SLO/alerts/dashboards;
- M1503 security/trust boundary tests;
- M1504 deterministic/replay/property tests;
- M1505 Toxiproxy fault suite;
- M1506 PostgreSQL restore drill;
- M1507 Kafka/Debezium recovery drill;
- M1508 Hermes shard/PVC recovery drill;
- M1509 AROMA/payment UnknownOutcome exercises;
- M1510 добавить Node ELU/event-loop-delay/RSS/native-memory SLO profile;
- M1511 сформировать DB/provider connection-budget sheets по runtime roles;
- M1512 добавить SSE slow-client/backpressure/reconnect load suite;
- M1513 добавить Node memory-leak/soak и OOM headroom acceptance;
- M1514 проверить graceful drain/restart recovery каждого Node role;
- M1515 добавить Kafka broker/controller/minISR/partition-skew/consumer-age SLI;
- M1516 добавить Debezium heartbeat/WAL/queue/outbox-age SLI;
- M1517 определить Kafka cluster и ACKed-ingress RPO/RTO;
- M1518 выполнить Kafka/Connect/consumer crash/replay/DR recovery drills;
- M1519 добавить quota-throttling и replay-background isolation dashboards.

## M16 — CI/CD / Supply Chain

- M1600 pnpm/dependency pinning;
- M1601 TypeScript quality gates;
- M1602 contract/schema compatibility gates;
- M1603 Docker multi-stage/non-root/digest builds;
- M1604 SBOM/vulnerability scanning;
- M1605 immutable artifact provenance;
- M1606 environment manifests/canary evidence;
- M1607 secret scanning and no-secret-in-Git policy;
- M1608 pin Node 24 LTS exact patch + digest policy;
- M1609 добавить Node native dependency/Kafka client image smoke;
- M1610 добавить blocking sync-API static guard для runtime paths;
- M1611 добавить SIGTERM/memory-limit container acceptance;
- M1612 добавить Node Permission Model audit-mode experiment;
- M1613 добавить Kafka topic-registry/IaC lint и production-completeness gate;
- M1614 добавить partition-count change guard для active keyed topics;
- M1615 добавить event/command JSON Schema compatibility + fixture validation;
- M1616 добавить deployed Kafka topic/config/ACL/quota drift check;
- M1617 добавить Debezium connector/slot/publication/snapshot/heartbeat config validation.

## M17 — AReaL Training-only

- M1700 trajectory exporter/privacy sanitizer;
- M1701 evaluator/reward contract;
- M1702 dataset registry/versioning;
- M1703 SFT/QLoRA baseline;
- M1704 AReaL training environment on separate GPU host/cluster;
- M1705 model registry/evaluation;
- M1706 Hermes shadow route;
- M1707 local-model canary/promotion.

## M18 — System Design Selections

- M1800 architecture review checklist: capacity/ownership/backpressure/idempotency/recovery;
- M1801 maintain accepted/deferred technology table;
- M1802 review bottlenecks before introducing Redis/service mesh/sharding;
- M1803 keep Nginx/Kafka/PostgreSQL/Hermes responsibilities non-overlapping.


## M19 — API Architecture

- M1900 зафиксировать API surface inventory и public/private route matrix;
- M1901 создать language-neutral `client-v1`, `agent-v1`, `internal-v1` OpenAPI registry;
- M1902 отвязать React generated client от ASP.NET build output;
- M1903 создать approved Hermes capability→operationId manifest;
- M1904 формализовать VK callback schema/auth/dedupe/ACK contract;
- M1905 формализовать payment webhook/provider verification contract;
- M1906 формализовать outbound AROMA/VK/PSP normalized adapter contracts;
- M1907 классифицировать Kafka topics/events как versioned asynchronous APIs;
- M1908 зафиксировать SSE realtime invalidation contract и auth;
- M1909 внедрить ProblemDetails/errorCode/409/UnknownOutcome semantics;
- M1910 внедрить API idempotency/retry ownership matrix;
- M1911 добавить OpenAPI/JSON Schema/event compatibility CI;
- M1912 добавить public-edge negative exposure tests для `agent-v1`/`internal-v1`;
- M1913 создать C#↔TS API parity harness и route-family contract tests;
- M1914 добавить webhook replay/duplicate/out-of-order tests;
- M1915 добавить API load profiles по surface, а не общий `max users`;
- M1916 ввести contract deprecation/zero-use retirement registry;
- M1917 физически разделить `api-public` / `api-agent` / `api-internal`;
- M1918 внедрить shared Fastify factory + explicit trustProxy/body/timeout/schema policy;
- M1919 добавить AbortSignal propagation и disconnect/deadline tests;
- M1920 добавить response-schema minimization/PII negative tests.


## M20 — Service Orchestration

- M2000 canonical runtime-workload registry;
- M2001 generate/validate service graph from YAML;
- M2002 close CheckoutAllocationManifest and InvoicePriceProof contracts;
- M2003 add ChannelIdentityBroker/intake/response-mapper/Hermes runtime topology;
- M2004 add Payments webhook/reconciliation/refund topology;
- M2005 enforce consumerGroup→runtime role mapping;
- M2006 enforce Order-atomic procurement end-to-end;
- M2007 semantic architecture validation gate.


## Audit closure — EndToEndHardened

- E2E001 trusted AI/VK confirmation proof;
- E2E002 AddConfirmedOrderItem;
- E2E003 allocation/price-proof artifact manifests;
- E2E004 refund/invoice compensation contracts;
- E2E005 artifact storage boundary;
- E2E006 Catalog source separation + override epoch;
- E2E007 production purge safety;
- E2E008 100% Kafka schema/runtime binding;
- E2E009 numeric SLO/RPO/RTO evidence;
- E2E010 privacy/retention/training export.

- E2E011 Hermes crash-after-accept certification for `turnRef` reconciliation;
- E2E012 Kafka partition/capacity benchmark against explicit baseline;
- E2E013 PostgreSQL/Kafka/Artifact/Hermes restore drills against M15 RPO/RTO;
- E2E014 AROMA mutation lease-expiry/UnknownOutcome chaos suite;
- E2E015 PSP webhook/refund/cancel sandbox certification;
- E2E016 end-to-end Order→Checkout→Invoice→Payment characterization/canary evidence.
