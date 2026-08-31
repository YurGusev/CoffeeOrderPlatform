# Prompt, tool budget and redaction

Prompt registry: version + checksum + release status. Production использует только released version.

Tool registry: owner, schema version, allowed profile, permission scope, timeout, max calls, idempotency policy, requires-user-confirmation, sensitive input/output fields.

Перед логированием/telemetry выполняется PII/secret redaction. Raw provider credentials, cookies, phone/email в operational logs запрещены.

Provider circuit/health не отменяет domain idempotency. Retry LLM/provider после успешно выполненного business tool не повторяет mutation.
