# Data retention, privacy and erasure extension

Эта ревизия расширяет baseline privacy policy классами фактически существующих subsystem.

| Data class | Примеры | Policy |
|---|---|---|
| Customer PII | имя, phone, email, address | restricted, versioned, merge/anonymize rules |
| Channel identity | VK refs/hashes | restricted, revoke/relink |
| Agent transcript | prompts/replies/tool summaries | bounded retention, access audit, training opt-in/policy |
| Voice/media | audio/artifacts/transcript | quarantine + short operational retention unless business record |
| Invoice artifacts | PDF/proofs | financial retention; no arbitrary erasure |
| Excel import | source XLSX/preview | limited retention after commit unless audit requires |
| Kafka/DLQ | minimized payload | topic-specific retention; PII class required |
| Feedback/training | resolver/agent feedback | de-identify before dataset export |

Erasure workflow fan-outs by durable opaque CustomerRef, not by fragile text search. Audit records retain non-PII proof where required.
