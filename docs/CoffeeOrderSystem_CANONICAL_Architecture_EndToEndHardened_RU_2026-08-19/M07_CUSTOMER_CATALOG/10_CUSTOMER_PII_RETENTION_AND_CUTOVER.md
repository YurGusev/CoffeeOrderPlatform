# M07. Customer PII, retention и privacy cutover

## Data classes

| Class | Examples | Rule |
|---|---|---|
| Direct PII | name, phone, address | Customer DB only, encrypted storage/backups, least privilege |
| Opaque identity | CustomerRef, ChannelIdentityRef | preferred cross-service references |
| Historical snapshot | name/address on Order | retained under business retention, not live-linked |
| Raw provider identity | VK raw user/peer ids | Channel Platform ledger only; never Kafka business payload |

## Retention

Default target policy (versioned, subject to legal/business approval):

- active customer data: while account/business relationship active;
- deactivated customer direct PII: 3 years unless longer legal requirement is configured;
- merge alias/provenance: retained with business audit, direct duplicate PII minimized after merge;
- access/audit events: 1 year minimum;
- export/training: direct PII removed before dataset admission.

Purge is idempotent and produces a tombstone/audit proof; it never deletes Order/Invoice financial records that have independent retention.

## Access

- `client-v1`: only authorized operator/customer-safe subset;
- `agent-v1`: minimal fields requested by approved tools;
- `internal-v1`: service-audience allowlist;
- no direct SQL from Hermes/n8n/Channel platform.

## Cutover gate

No DB5 Customer cutover until restore, merge, deactivation, relink and PII purge dry-runs succeed on writable clone.
