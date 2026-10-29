import type { KafkaConfig, KafkaServiceConfig } from "./index.js";
import {
  validateLaunchDatabaseIdentity,
  type LaunchDatabaseIdentity,
} from "./launch-database-target.js";

export type LaunchKafkaTarget = Readonly<{
  topics: Readonly<Record<string, string>>;
  groups: Readonly<Record<string, string>>;
}>;

export type LaunchKafkaRegistryTarget = Readonly<{
  topics: Readonly<Record<string, string>>;
}>;

export const CANONICAL_KAFKA_TOPIC_NAMES: readonly string[] = Object.freeze([
  "coffee.catalog.snapshot.v1",
  "coffee.catalog.mapping.v2",
  "coffee.orders.lifecycle.v1",
  "coffee.aroma.cart.commands.v1",
  "coffee.aroma.cart.events.v1",
  "coffee.realtime.invalidate.v1",
] as const);

function fail(message: string): never {
  throw new Error(`RUNTIME_KAFKA_TARGET_INVALID: ${message}`);
}

function deriveLaunchKafkaName(
  identity: LaunchDatabaseIdentity,
  canonicalName: string,
): string {
  const run = validateLaunchDatabaseIdentity(identity);
  return `${run.runId}.${canonicalName}`;
}

export function deriveRuntimeKafkaTarget(
  input: Readonly<{
    config: KafkaConfig;
    service: KafkaServiceConfig;
    enabled: boolean;
    environment: string;
    launchIdentity?: LaunchDatabaseIdentity;
  }>,
): LaunchKafkaTarget {
  const { config, service, enabled, environment, launchIdentity } = input;
  if (enabled && (!launchIdentity || environment === "production"))
    fail(
      "namespace isolation требует readonly launch identity и запрещена в production",
    );

  const configuredTopics = new Set(
    Object.values(config.topics).flatMap(({ name, dlq }) => [name, dlq]),
  );
  const logicalTopics = new Set<string>(service.producers);
  for (const consumer of service.consumers) {
    for (const topic of consumer.topics) logicalTopics.add(topic);
    if (consumer.processing === "realtime") {
      for (const topic of consumer.topics) {
        const topicConfig = Object.values(config.topics).find(
          (candidate) => candidate.name === topic,
        );
        if (!topicConfig || topicConfig.dlq !== `${topic}.dlq`)
          fail("realtime DLQ не совпадает с canonical topic");
        logicalTopics.add(topicConfig.dlq);
      }
    }
  }
  const topics = Object.fromEntries(
    [...logicalTopics].map((name) => {
      if (!configuredTopics.has(name))
        fail("runtime claim содержит foreign topic");
      return [
        name,
        enabled ? deriveLaunchKafkaName(launchIdentity!, name) : name,
      ];
    }),
  );
  const groups = Object.fromEntries(
    service.consumers.map(({ groupId }) => {
      if (!/^[a-z][a-z0-9-]+$/u.test(groupId))
        fail("runtime claim содержит invalid group");
      return [
        groupId,
        enabled ? deriveLaunchKafkaName(launchIdentity!, groupId) : groupId,
      ];
    }),
  );
  return Object.freeze({
    topics: Object.freeze(topics),
    groups: Object.freeze(groups),
  });
}

/** Map every configured registry topic and DLQ without changing any runtime's claims. */
export function deriveLaunchKafkaRegistryTarget(
  input: Readonly<{
    config: KafkaConfig;
    enabled: boolean;
    environment: string;
    launchIdentity?: LaunchDatabaseIdentity;
  }>,
): LaunchKafkaRegistryTarget {
  const { config, enabled, environment, launchIdentity } = input;
  const entries = Object.values(config.topics);
  if (
    entries.length !== CANONICAL_KAFKA_TOPIC_NAMES.length ||
    JSON.stringify(entries.map(({ name }) => name).sort()) !==
      JSON.stringify([...CANONICAL_KAFKA_TOPIC_NAMES].sort()) ||
    entries.some(({ name, dlq }) => dlq !== `${name}.dlq`)
  )
    fail("Kafka registry должен содержать 6 canonical topics и их unique DLQ");
  if (enabled && (!launchIdentity || environment === "production"))
    fail(
      "namespace isolation требует readonly launch identity и запрещена в production",
    );
  const names = entries.flatMap(({ name, dlq }) => [name, dlq]);
  if (
    new Set(names).size !== 12 ||
    names.some((name) => !/^[A-Za-z0-9._-]+$/u.test(name))
  )
    fail("Kafka registry содержит duplicate или invalid topic/DLQ name");
  const topics = Object.fromEntries(
    names.map((name) => [
      name,
      enabled ? deriveLaunchKafkaName(launchIdentity!, name) : name,
    ]),
  );
  return Object.freeze({ topics: Object.freeze(topics) });
}

export function launchKafkaPhysicalName(
  target: LaunchKafkaTarget,
  logicalName: string,
): string {
  const physicalName = target.topics[logicalName] ?? target.groups[logicalName];
  if (physicalName === undefined)
    fail("Kafka name отсутствует в runtime claims");
  return physicalName;
}

export function launchKafkaLogicalTopic(
  target: LaunchKafkaTarget,
  physicalName: string,
): string {
  const matches = Object.entries(target.topics).filter(
    ([, candidate]) => candidate === physicalName,
  );
  if (matches.length !== 1)
    fail("physical topic отсутствует или неоднозначен в runtime claims");
  return matches[0]![0];
}
