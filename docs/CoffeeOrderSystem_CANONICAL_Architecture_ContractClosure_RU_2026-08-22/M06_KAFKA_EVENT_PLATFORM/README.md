# M06 — Kafka contract closure

Этот раздел добавляет к canonical Kafka registry новые pricing/customer/import
и export contracts, а также связывает topic/group с executable runtime roles.
Базовые 20 topics и 35 message types не удаляются и не переименовываются.

## Нормативные источники

- kafka-topic-registry.closure.json — materialized closure topic result and
  exact topic metadata for the v3 additions;
- kafka-topic-registry.delta.yml — additive topics и exact existing-topic
  consumer-group additions;
- message-schema-registry.delta.yml — additive message types;
- contract-closure-registry.yml — closure authority для producers, consumers и
  role refs;
- contract-closure-registry.schema.json — machine-readable shape;
- payload-schemas/*.schema.json — message and ArtifactRef schemas;
- fixtures/*.positive.json — positive fixtures.

The registry, binding registry and schemas above are the complete M06 closure
authority listed in the v3 `REVISION_MANIFEST.yml`. The parent M06 registry and
unlisted parent hardening rules remain authoritative for topics and messages
outside that exact list; Markdown/CSV views and legacy runtime code are not
authority.

contract-closure-registry.yml materializes baseline plus revision. Поле
consumerGroups в topic registry — только group identity; executable role
появляется лишь из exact binding registry. Нельзя заполнять consumesTopics
догадкой по отсутствующему полю baseline workload.

## Exact binding acceptance

- каждый durable topic/group имеет ровно один roleRef;
- cross-topic groups разрешены только для canonical work-center-projection
  и operations-projections, а realtime использует documented
  ephemeral-per-replica;
- каждый topic имеет producerRef и consumer roleRef;
- producerRef обязан быть executable roleCatalog entry; logical producer
  records помечены authority gap и не выдаются за runtime evidence. The
  unresolved set is explicit in `materialization.logicalProducerScope` and is
  excluded from the M20 runtime-role count until an audited executable role is
  materialized;
- undeclared edge отклоняется M20 policy.

## ArtifactRef boundary

Media и transcription bytes живут в artifact-storage. В Kafka допускаются
только ArtifactRef и bounded metadata. Fixture
media-transcription-artifact-ref.invalid.json содержит bytes и должен быть
отклонён JSON Schema validator.
