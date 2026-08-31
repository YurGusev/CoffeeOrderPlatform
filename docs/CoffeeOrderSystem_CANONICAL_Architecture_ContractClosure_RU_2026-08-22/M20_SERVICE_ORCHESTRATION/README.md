# M20 — Contract-closure service orchestration

Этот раздел содержит additive authority для runtime workload и service graph
релиза ContractClosure от 2026-08-22. Он не выполняет cutover, cleanup или
RETIRE: baseline остаётся источником уже принятых ролей и edges.

## Нормативные источники

- runtime-workload-registry.delta.yml — новые workload descriptors и
  materialization rules;
- service-interaction-policy.closure.json — materialized allow/deny authority,
  проверяемый semantic validator;
- service-interaction-policy.delta.yml — исходный additive allow/deny delta;
- ../M06_KAFKA_EVENT_PLATFORM/contract-closure-registry.yml — exact
  producer/consumer bindings.

Markdown/CSV — views. Их нельзя использовать для добавления edge или
consumer group, отсутствующих в YAML authority.

## Materialization rules

1. Merge key для workload — name; для edge — (from, to, mode,
   purposeOrReason).
2. consumesTopics baseline role не выводится из пустого/отсутствующего
   поля. Оно materializes только из exact binding с тем же roleRef и
   consumerGroup.
3. producesTopics materializes только из exact producer binding. Имя
   bounded context само по себе не доказывает executable workload.
4. Durable consumer group имеет ровно одного executable roleRef; единственное
   исключение — ephemeral-per-replica для realtime.
5. Retry/DLQ и activation/rollback evidence являются отдельными полями
   workload contract. Их specification-only статус не следует трактовать как
   production proof.

## Media boundary

channel-media-worker и channel-transcription-worker работают через
artifact-storage. Kafka не переносит media/transcription bytes; в
асинхронном handoff разрешены только ArtifactRef и проверяемые metadata.

## Приёмка

Положительный и отрицательный self-test fixtures находятся в M06:

- ../M06_KAFKA_EVENT_PLATFORM/fixtures/media-transcription-artifact-ref.positive.json;
- ../M06_KAFKA_EVENT_PLATFORM/fixtures/media-transcription-artifact-ref.invalid.json.

Invalid fixture обязан быть отклонён schema validator из-за поля bytes.
