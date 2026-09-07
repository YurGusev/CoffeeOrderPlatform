---
name: channel-hermes-platform
description: Менять production VK/Hermes-каналы приложения.
---

# Канальная платформа Hermes

Channel Platform владеет transport identity ledger, inbound/outbound delivery и
проверкой провайдера. Agent Platform владеет turn routing/journal и Hermes
binding. Ни одна из них не владеет истиной Customer, Catalog, Pricing или Orders.

- Verify provider callbacks before durable intake and acknowledge quickly.
- Preserve per-channel/user ordering, dedupe IDs, and bounded backpressure.
- Resolve customer identity through trusted evidence; model text cannot choose IDs.
- Hermes uses a narrow allowlisted `agent-v1`, never browser/internal/provider APIs.
- LLM output cannot self-authorize confirmation, payment, or AROMA mutation.
- Media uses ArtifactRef and bounded scan/transcription workers, not Kafka blobs.
- Egress is idempotent and records unknown provider outcome for reconciliation.

Проверять дубликаты, overlaps, ordering, shard restart, identity conflict,
prompt/tool policy, media limits, provider timeout и redaction.
