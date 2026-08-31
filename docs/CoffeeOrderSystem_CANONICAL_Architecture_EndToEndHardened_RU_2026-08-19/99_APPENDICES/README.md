# 99. Приложения — Architecture Decision Records

Здесь находятся только ADR, которые фиксируют наиболее важные irreversible/long-lived решения. Диаграммы, schemas, examples и checklists размещены непосредственно внутри соответствующих программ, чтобы не создавать дублирующиеся источники истины.

## ADR set

- ADR-0001 — clean-room `/platform` рядом с `/src`;
- ADR-0002 — React copy-first и static internal Nginx hosting;
- ADR-0003 — Nginx public Strangler Edge;
- ADR-0004 — TypeScript/Node.js target online platform;
- ADR-0005 — Transactional Outbox + Debezium + Kafka;
- ADR-0006 — Hermes production, AReaL training-only;
- ADR-0007 — one domain schema / one production writer;
- ADR-0008 — Docker-first, Kubernetes later;
- ADR-0009 — domain-oriented selective microservices.

- `adr/ADR-0010-api-architecture-surfaces.md` — канон M19 API surfaces/trust/transports;
- `adr/ADR-0011-kafka-production-platform-contract.md` — production Kafka cluster/topic/schema/replay/DR contract.
