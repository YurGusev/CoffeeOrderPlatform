# M19. Contract Registry и Versioning

## 1. Language-neutral source of truth

Target contracts не зависят от C# или TypeScript build output.

```text
platform/packages/contracts/
  openapi/
  events/
  commands/
  webhooks/
  provider-normalized/
  errors/
```

M06 Kafka schemas и topic registry должны быть скопированы/сгенерированы в этот package без изменения semantic source of truth.

## 2. HTTP contracts

```text
/api/client-v1
/api/agent-v1
/api/internal-v1
```

имеют отдельные OpenAPI specs, ownership/audience/trust metadata.

## 3. Kafka contracts

Kafka contracts включают:

```text
topic registry
integration event envelope
integration command envelope
message-specific payload schema
key/partition policy
compatibility/replay metadata
```

## 4. React generation

React generated client строится из `client-v1` registry artifact, а не из ASP.NET `obj/` path.

## 5. Hermes plugin

OpenAPI используется для types/validation, но tool allowlist остаётся вручную ограниченным. Не генерировать все agent tools автоматически.

## 6. HTTP versioning

Additive compatible change не меняет major surface. Breaking semantic/auth/required-shape change требует explicit migration и при необходимости `v2`.

## 7. Kafka versioning

Используются:

- topic family major (`.v1`, `.v2`);
- message `schemaVersion`;
- immutable/controlled key and partition topology after cutover.

Новый topic не создаётся на каждое optional field addition, но key semantics/event-vs-command/partition strategy change может потребовать новую topic family.

## 8. Compatibility CI

CI проверяет:

- OpenAPI breaking changes;
- event/command JSON Schema compatibility;
- required fields/types;
- key/money/unit/identity semantics review;
- generated client reproducibility;
- runtime Schema Registry compatibility, если он включён.

## 9. Runtime Schema Registry

Начальная система может работать на Git schemas + CI/runtime validators.

При независимых deployment cadence/росте producers-consumers runtime Schema Registry становится P1 platform component.

Reference implementations с JSON Schema support допустимы; vendor не является частью domain contract.

Critical subjects после ADR используют transitive compatibility mode, если требуется независимый upgrade order.

Runtime producer не auto-register'ит новую production schema из request path.

## 10. Contract ownership metadata

Каждый artifact содержит/связывает:

```text
owner
bounded context/program
audience
security/PII class
version
status
replacement/sunset gate
```

## 11. Deprecation

Deprecated contract удаляется только после telemetry-backed zero-use evidence и принятого migration owner/gate.

## BusinessLogicHardened payload contracts

Critical Orders→Catalog→AROMA→Invoices→Payments payload schemas находятся в:

```text
M06_KAFKA_EVENT_PLATFORM/payload-schemas/
```

Service orchestration contract не должен существовать только в prose. M06 Topic Registry перечисляет payload schemas, а M20 определяет owner/producer/consumer edge.

## UInt64/Int64 wire rule

Application-owned versions/revisions/sequences stored as BIGINT/UInt64 are serialized as **decimal strings** at JSON/HTTP/Kafka boundaries. JavaScript `number` is forbidden for these fields.

Examples: `orderVersion`, `aggregateVersion`, `desiredRevision`, `desiredKeyVersion`, `sourceSequence`, `identityEpoch`, `mappingRevision`.
