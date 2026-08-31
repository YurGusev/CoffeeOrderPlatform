# M04. Immutable Artifact / Document Storage boundary

## 1. Purpose

Большие или бинарные объекты не помещаются в Kafka payload и не живут на ephemeral container filesystem.

Используются для:

```text
CheckoutAllocationManifest
InvoicePriceProofManifest
supplier/customer invoice PDF
Excel order import
voice/audio attachment
sanitized training export bundle
```

## 2. Infrastructure

Production: managed/S3-compatible encrypted object storage. Compose: `artifact-storage` (MinIO-compatible dev reference only).

Object storage — shared infrastructure, **не shared business database**. Каждый bounded context имеет namespace/prefix и service credential.

## 3. ArtifactRef

```text
artifactRef         opaque UUID/ref
ownerContext
artifactType
schemaVersion
sha256              lowercase hex-64
byteSize            decimal string UInt64
contentType
createdAtUtc
retentionClass
```

Business DB owner хранит metadata/provenance; Kafka передаёт только bounded metadata/reference.

## 4. Integrity

Consumer перед использованием обязан:

1. проверить owner/type/schemaVersion;
2. загрузить object по service-authorized reference;
3. проверить `byteSize`;
4. проверить SHA-256;
5. schema-validate JSON manifest либо safe-parse document;
6. записать consumed proof/hash в local DB.

## 5. Security

- encryption at rest + TLS;
- bucket/prefix IAM per runtime role;
- signed URL TTL <= 5 min для browser upload/download, если нужен;
- private objects default;
- executable content запрещён;
- user uploads проходят malware scan/quarantine before business processing;
- filenames не используются как identity/path authority;
- logs содержат ArtifactRef, не content/PII.

## 6. Lifecycle

Upload stages:

```text
PendingUpload -> Quarantined -> Scanning -> Ready | Rejected
```

Provider-fetched invoice PDF также hash-validated; malware scan остаётся обязательным до downstream parsing.

## 7. Retention/DR

- financial invoice artifacts: 5 years target baseline or configured legal requirement;
- checkout/proof manifests: not shorter than related financial record;
- temporary Excel/audio: 30 days after successful processing unless audit requires longer;
- backup/versioning/replication according M15 RPO/RTO;
- quarterly restore/read-integrity drill for sample artifacts.

## 8. Prohibition

Kafka message > application limit never solved by raising broker `max.message.bytes` to carry PDF/Excel/audio. Use ArtifactRef.
