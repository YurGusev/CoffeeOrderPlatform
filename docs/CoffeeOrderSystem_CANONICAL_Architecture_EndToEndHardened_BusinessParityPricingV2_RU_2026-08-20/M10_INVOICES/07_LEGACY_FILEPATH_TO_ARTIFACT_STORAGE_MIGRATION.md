# Legacy PDF filepath → Artifact Storage migration

Local filesystem path не является target contract.

Target fields:

```text
artifactRef
sha256
contentType
sizeBytes
createdAt
retentionClass
scanStatus
sourceProviderRef
```

Migration копирует legacy PDF в Artifact Storage, проверяет hash/readback, записывает ref и только после evidence retire local path dependency.
