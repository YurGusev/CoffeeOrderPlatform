---
name: artifact-processing
description: Менять загрузку, хранение и обработку документов/media.
---

# Обработка артефактов

Большие документы, manifests, audio и exports используют неизменяемый ArtifactRef
с hash, size, media type, owner, classification и retention. Их bytes нельзя
передавать через Kafka или обрабатывать в интерактивных API loops.

- Upload through bounded authenticated flows with size/type limits.
- Quarantine until scan/validation succeeds; never trust filename/content type.
- Workers are idempotent, resumable, resource-bounded, and emit owner facts.
- Business owners store references/proofs, not private artifact internals.
- Use signed short-lived access and audit; redact contents and credentials.
- Define deletion, legal/PII retention, backup, integrity verification, and orphan cleanup.

Проверять hash mismatch, oversized/malformed input, archive bombs, duplicate
jobs, crash/restart, unauthorized access, retention и restore.
