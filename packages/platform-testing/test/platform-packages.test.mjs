import { strict as assert } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load as parseYaml } from "js-yaml";
import { createHash, generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { createServer as createHttpServer } from "node:http";
import { EventEmitter } from "node:events";
import { registerHooks } from "node:module";
import { Readable, Writable } from "node:stream";
import pg from "pg";
import {
  context as otelContext,
  metrics,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import {
  createRuntime,
  readLaunchDatabaseIdentity,
  RuntimeError,
} from "../../platform-runtime/dist/index.js";
import {
  parsePlatformConfig,
  PlatformConfigError,
  deriveLaunchKafkaRegistryTarget,
  deriveRuntimeDatabaseTarget,
  deriveRuntimeKafkaTarget,
  launchKafkaPhysicalName,
  launchKafkaLogicalTopic,
  loadPlatformConfigWithSource,
  verifyLaunchConfigBytes,
} from "../../platform-config/dist/index.js";
import {
  correlationHeaders,
  createCorrelationContext,
  createPinoLogger,
  logRecordsDropped,
  isTraceparent,
  redactLogFields,
  withCorrelationFields,
  createTelemetryResource,
} from "../../platform-observability/src/index.ts";
import {
  signActorContext,
  verifyActorContext,
  signServiceDelegation,
  verifyServiceDelegation,
  createMutualTlsServerOptions,
  createPublicTlsServerOptions,
  parsePublicTlsCaBundle,
  parseServiceTransportMaterial,
} from "../../platform-security/dist/index.js";
import {
  withTransaction,
  createDatabase,
  DatabaseTransactionError,
} from "../../platform-database/dist/index.js";
import { createHttpClient } from "../../platform-http/dist/index.js";
import {
  defineMigration,
  defineStatement,
  defineCopy,
} from "../../platform-database/dist/owner.js";
import {
  createSqlIdempotencyStore,
  canonicalRequestHash,
} from "../../platform-idempotency/dist/index.js";
import {
  consumeOnce,
  createSqlInboxStore,
} from "../../platform-inbox/dist/index.js";
import {
  createSqlOutboxStore,
  relayOutboxBatch,
} from "../../platform-outbox/dist/index.js";
import {
  applyMigrations,
  migrationChecksum,
} from "../../platform-migrations/dist/index.js";
import { CustomerStore } from "../../../apps/customer-service/dist/infrastructure/postgres/customer-store.js";
import { CustomerRepository } from "../../../apps/customer-service/dist/infrastructure/postgres/customer-repository.js";
import { createCustomerAdapters } from "../../../apps/customer-service/dist/http/index.js";
import { PricingStore } from "../../../apps/pricing-service/dist/infrastructure/database/pricing-store.js";
import {
  OrderStore,
  hashOrderDraftRequest,
} from "../../../apps/orders-service/dist/infrastructure/database/order-store.js";
import { createAromaObservationStore } from "../../../apps/aroma-observer/dist/infrastructure/observation-store.js";
import {
  AromaObserverGatewayClient,
  GatewayClientError as ObserverGatewayClientError,
} from "../../../apps/aroma-observer/dist/gateway-client.js";
import { createAromaPreparationStore } from "../../../apps/orders-aroma-preparation/dist/infrastructure/preparation-store.js";
import { buildDesired } from "../../../apps/orders-aroma-preparation/dist/domain/desired.js";
import { createAromaConvergenceStore } from "../../../apps/aroma-convergence/dist/infrastructure/convergence-store.js";
import { normalizeAromaCartSnapshot } from "../../contracts/aroma-v1/dist/index.js";
import {
  GatewayMutationExecutor,
  canonicalMutationRequestHash,
} from "../../../apps/aroma-gateway/dist/domain/mutation-journal.js";
import { ProviderMutationJournalStore } from "../../../apps/aroma-gateway/dist/infrastructure/database/provider-mutation-journal.js";
import {
  createGatewayTelemetry,
  GatewayMetrics,
} from "../../../apps/aroma-gateway/dist/infrastructure/observability.js";
import { OfferBindingStore } from "../../../apps/aroma-gateway/dist/infrastructure/database/offer-binding-store.js";
import {
  encryptCookieMaterial,
  ProviderSessionStoreAdapter,
} from "../../../apps/aroma-gateway/dist/infrastructure/database/provider-session-store.js";
import {
  CATALOG_SOURCE_IDENTITY_SCHEME,
  createCatalogExportStream,
  sha256CatalogHash,
} from "../../../apps/aroma-gateway/dist/application/catalog-export.js";

import {
  createKafkaRuntime,
  parseEnvelope,
  processKafkaRecord,
  validateKafkaRuntimeConfig,
  PartitionWorkers,
} from "../../platform-kafka-runtime/dist/index.js";
import { createTestClock } from "../src/index.ts";

void test("config rejects unknown keys and requires the exact runtime set", () => {
  const source = parseYaml(
    readFileSync(
      new URL("../../../config/platform.yaml", import.meta.url),
      "utf8",
    ),
  );
  source.verification.databaseIsolation.enabled = false;
  source.verification.kafkaNamespaceIsolation = false;
  const parsed = parsePlatformConfig(source);
  assert.equal(Object.keys(parsed.services).length, 14);
  assert.equal(parsed.databaseIsolation.enabled, false);
  assert.equal(parsed.kafkaNamespaceIsolation, false);
  assert.equal(parsed.services.web, undefined);
  assert.equal(parsed.nginxTransport.listen, 8443);
  assert.deepEqual(parsed.services["edge-gateway"].optionalSecretRefs, [
    "edge.tlsCaBundle",
  ]);
  assert.throws(
    () => parsePlatformConfig({ ...parsed, unknown: true }),
    PlatformConfigError,
  );
});

void test("launch isolation policy flags reject non-boolean config values", () => {
  const source = parseYaml(
    readFileSync(
      new URL("../../../config/platform.yaml", import.meta.url),
      "utf8",
    ),
  );
  const invalidDatabasePolicy = structuredClone(source);
  invalidDatabasePolicy.verification.databaseIsolation.enabled = "true";
  assert.throws(
    () => parsePlatformConfig(invalidDatabasePolicy),
    (error) =>
      error instanceof PlatformConfigError &&
      error.path === "config.verification.databaseIsolation.enabled",
  );

  const invalidKafkaPolicy = structuredClone(source);
  invalidKafkaPolicy.verification.kafkaNamespaceIsolation = 1;
  assert.throws(
    () => parsePlatformConfig(invalidKafkaPolicy),
    (error) =>
      error instanceof PlatformConfigError &&
      error.path === "config.verification.kafkaNamespaceIsolation",
  );
});

void test("launch Kafka target derives only exact run-scoped runtime claims", () => {
  const config = parsePlatformConfig(
    parseYaml(
      readFileSync(
        new URL("../../../config/platform.yaml", import.meta.url),
        "utf8",
      ),
    ),
  );
  const service = config.services["realtime-gateway"].kafka;
  const identity = {
    schemaVersion: 1,
    runId: "20261024T123456Z-1234567",
    candidateSha: `1234567${"0".repeat(33)}`,
    baseConfigSha256: "a".repeat(64),
  };
  const target = deriveRuntimeKafkaTarget({
    config: config.kafka,
    service,
    enabled: true,
    environment: config.environment,
    launchIdentity: identity,
  });
  const topic = config.kafka.topics.realtimeInvalidate.name;
  assert.equal(target.topics[topic], `${identity.runId}.${topic}`);
  assert.equal(
    target.groups["realtime-gateway-v1"],
    `${identity.runId}.realtime-gateway-v1`,
  );
  assert.equal(
    launchKafkaPhysicalName(target, config.kafka.topics.realtimeInvalidate.dlq),
    `${identity.runId}.${config.kafka.topics.realtimeInvalidate.dlq}`,
  );
  assert.throws(
    () => launchKafkaPhysicalName(target, "foreign.topic.v1"),
    /runtime claims/u,
  );
  assert.throws(
    () => launchKafkaLogicalTopic(target, `${identity.runId}.foreign.topic.v1`),
    /physical topic/u,
  );
  const normal = deriveRuntimeKafkaTarget({
    config: config.kafka,
    service,
    enabled: false,
    environment: config.environment,
  });
  assert.equal(normal.topics[topic], topic);
  assert.equal(normal.groups["realtime-gateway-v1"], "realtime-gateway-v1");
  assert.throws(
    () =>
      deriveRuntimeKafkaTarget({
        config: config.kafka,
        service,
        enabled: true,
        environment: "production",
        launchIdentity: identity,
      }),
    /production/u,
  );
  assert.throws(
    () =>
      deriveRuntimeKafkaTarget({
        config: config.kafka,
        service,
        enabled: true,
        environment: config.environment,
      }),
    /identity/u,
  );
  assert.throws(
    () =>
      deriveRuntimeKafkaTarget({
        config: config.kafka,
        service,
        enabled: true,
        environment: config.environment,
        launchIdentity: { ...identity, baseConfigSha256: "invalid" },
      }),
    /identity/u,
  );
  const wrongRealtimeDlq = {
    ...config.kafka,
    topics: {
      ...config.kafka.topics,
      realtimeInvalidate: {
        ...config.kafka.topics.realtimeInvalidate,
        dlq: "coffee.realtime.foreign.v1.dlq",
      },
    },
  };
  assert.throws(
    () =>
      deriveRuntimeKafkaTarget({
        config: wrongRealtimeDlq,
        service,
        enabled: false,
        environment: config.environment,
      }),
    /realtime DLQ/u,
  );
  const invalidGroupService = {
    ...service,
    consumers: service.consumers.map((consumer) => ({
      ...consumer,
      groupId: "Realtime Gateway",
    })),
  };
  assert.throws(
    () =>
      deriveRuntimeKafkaTarget({
        config: config.kafka,
        service: invalidGroupService,
        enabled: false,
        environment: config.environment,
      }),
    /invalid group/u,
  );
  const foreignTopicService = {
    ...service,
    producers: [...service.producers, "coffee.foreign.v1"],
  };
  assert.throws(
    () =>
      deriveRuntimeKafkaTarget({
        config: config.kafka,
        service: foreignTopicService,
        enabled: false,
        environment: config.environment,
      }),
    /foreign topic/u,
  );
});

void test("launch Kafka registry isolates all canonical topics and DLQs and rejects incomplete claims", () => {
  const config = parsePlatformConfig(
    parseYaml(
      readFileSync(
        new URL("../../../config/platform.yaml", import.meta.url),
        "utf8",
      ),
    ),
  );
  const identity = {
    schemaVersion: 1,
    runId: "20261024T123456Z-1234567",
    candidateSha: `1234567${"0".repeat(33)}`,
    baseConfigSha256: "a".repeat(64),
  };
  const canonical = [
    "coffee.catalog.snapshot.v1",
    "coffee.catalog.mapping.v2",
    "coffee.orders.lifecycle.v1",
    "coffee.aroma.cart.commands.v1",
    "coffee.aroma.cart.events.v1",
    "coffee.realtime.invalidate.v1",
  ];
  const expectedRegistryNames = canonical
    .flatMap((name) => [name, `${name}.dlq`])
    .sort();
  const normal = deriveLaunchKafkaRegistryTarget({
    config: config.kafka,
    enabled: false,
    environment: config.environment,
  });
  assert.deepEqual(Object.keys(normal.topics).sort(), expectedRegistryNames);
  assert.deepEqual(Object.values(normal.topics).sort(), expectedRegistryNames);

  const isolated = deriveLaunchKafkaRegistryTarget({
    config: config.kafka,
    enabled: true,
    environment: config.environment,
    launchIdentity: identity,
  });
  const expectedPhysicalNames = expectedRegistryNames
    .map((name) => `${identity.runId}.${name}`)
    .sort();
  assert.deepEqual(Object.keys(isolated.topics).sort(), expectedRegistryNames);
  assert.deepEqual(
    Object.values(isolated.topics).sort(),
    expectedPhysicalNames,
  );
  assert.equal(
    Object.values(isolated.topics).some((name) =>
      expectedRegistryNames.includes(name),
    ),
    false,
  );

  for (const enabled of [false, true]) {
    const groupClaims = Object.values(config.services).flatMap(
      ({ kafka: service }) =>
        Object.entries(
          deriveRuntimeKafkaTarget({
            config: config.kafka,
            service,
            enabled,
            environment: config.environment,
            ...(enabled ? { launchIdentity: identity } : {}),
          }).groups,
        ),
    );
    const expectedGroups = [
      "orders-catalog-mapping-v2",
      "orders-aroma-preparation-v1",
      "orders-aroma-projection-v1",
      "aroma-convergence-v1",
      "realtime-gateway-v1",
    ];
    assert.deepEqual(
      groupClaims.map(([group]) => group).sort(),
      expectedGroups.sort(),
    );
    for (const [group, physical] of groupClaims)
      assert.equal(physical, enabled ? `${identity.runId}.${group}` : group);
  }

  assert.throws(
    () =>
      deriveLaunchKafkaRegistryTarget({
        config: config.kafka,
        enabled: true,
        environment: config.environment,
      }),
    /identity/u,
  );
  assert.throws(
    () =>
      deriveLaunchKafkaRegistryTarget({
        config: config.kafka,
        enabled: true,
        environment: "production",
        launchIdentity: identity,
      }),
    /production/u,
  );
  assert.throws(
    () =>
      deriveLaunchKafkaRegistryTarget({
        config: config.kafka,
        enabled: true,
        environment: config.environment,
        launchIdentity: { ...identity, baseConfigSha256: "invalid" },
      }),
    /identity/u,
  );

  const { realtimeInvalidate: _realtimeInvalidate, ...missingTopics } =
    config.kafka.topics;
  assert.throws(
    () =>
      deriveLaunchKafkaRegistryTarget({
        config: { ...config.kafka, topics: missingTopics },
        enabled: false,
        environment: config.environment,
      }),
    /6 canonical topics/u,
  );
  const foreignTopics = {
    ...config.kafka.topics,
    catalogSnapshot: {
      ...config.kafka.topics.catalogSnapshot,
      name: "coffee.catalog.foreign.v1",
      dlq: "coffee.catalog.foreign.v1.dlq",
    },
  };
  assert.throws(
    () =>
      deriveLaunchKafkaRegistryTarget({
        config: { ...config.kafka, topics: foreignTopics },
        enabled: false,
        environment: config.environment,
      }),
    /6 canonical topics/u,
  );
  const wrongDlqTopics = {
    ...config.kafka.topics,
    catalogSnapshot: {
      ...config.kafka.topics.catalogSnapshot,
      dlq: "coffee.catalog.other.v1.dlq",
    },
  };
  assert.throws(
    () =>
      deriveLaunchKafkaRegistryTarget({
        config: { ...config.kafka, topics: wrongDlqTopics },
        enabled: false,
        environment: config.environment,
      }),
    /6 canonical topics/u,
  );
  const unsafeTopics = {
    ...config.kafka.topics,
    catalogSnapshot: {
      ...config.kafka.topics.catalogSnapshot,
      name: "coffee.catalog.snapshot.v1\n",
      dlq: "coffee.catalog.snapshot.v1\n.dlq",
    },
  };
  assert.throws(
    () =>
      deriveLaunchKafkaRegistryTarget({
        config: { ...config.kafka, topics: unsafeTopics },
        enabled: false,
        environment: config.environment,
      }),
    /6 canonical topics/u,
  );
});

void test("launch DB targets derive from owner authority and context projects only trusted identity", async () => {
  const configBytes = readFileSync(
    new URL("../../../config/platform.yaml", import.meta.url),
  );
  const document = parseYaml(configBytes.toString("utf8"));
  const disabledDocument = structuredClone(document);
  disabledDocument.verification.databaseIsolation.enabled = false;
  disabledDocument.verification.kafkaNamespaceIsolation = false;
  const base = parsePlatformConfig(disabledDocument);
  const loaded = await loadPlatformConfigWithSource(
    new URL("../../../config/platform.yaml", import.meta.url).pathname,
    (text) => parseYaml(text),
  );
  assert.equal(
    loaded.sourceSha256,
    createHash("sha256").update(configBytes).digest("hex"),
  );
  const config = parsePlatformConfig({
    ...disabledDocument,
    verification: {
      ...document.verification,
      databaseIsolation: { enabled: true },
    },
  });
  assert.equal(config.databaseIsolation.enabled, true);
  assert.equal(Object.hasOwn(config, "verification"), false);
  const ownership = JSON.parse(
    readFileSync(
      new URL("../../../config/database-ownership.json", import.meta.url),
      "utf8",
    ),
  );
  const launchIdentity = {
    schemaVersion: 1,
    runId: "20261024T123456Z-1234567",
    candidateSha: `1234567${"0".repeat(33)}`,
    baseConfigSha256: createHash("sha256").update(configBytes).digest("hex"),
  };
  const dbClaims = ownership.runtimeClaims.filter(
    (claim) => claim.database !== null,
  );
  const derived = dbClaims.map(({ runtime }) =>
    deriveRuntimeDatabaseTarget({ config, runtime, ownership, launchIdentity }),
  );
  assert.equal(new Set(derived.map(({ owner }) => owner)).size, 5);
  assert.equal(new Set(derived.map(({ database }) => database)).size, 5);
  assert.deepEqual(derived[0], {
    owner: "customer",
    database: "coffee_verify_20261024t123456z_1234567_customer",
    allowedDatabase: "coffee_verify_20261024t123456z_1234567_customer",
  });
  assert.throws(
    () =>
      deriveRuntimeDatabaseTarget({
        config: base,
        runtime: dbClaims[0].runtime,
        ownership,
        launchIdentity,
      }),
    /выключена/,
  );
  assert.throws(
    () =>
      deriveRuntimeDatabaseTarget({
        config,
        runtime: dbClaims[0].runtime,
        ownership,
      }),
    /launch identity/u,
  );
  assert.throws(
    () =>
      deriveRuntimeDatabaseTarget({
        config,
        runtime: "edge-gateway",
        ownership,
      }),
    /не владеет базой данных/u,
  );
  assert.throws(
    () =>
      deriveRuntimeDatabaseTarget({
        config: { ...config, environment: "production" },
        runtime: dbClaims[0].runtime,
        ownership,
        launchIdentity,
      }),
    /production/,
  );
  const mismatchedRunIdentity = {
    ...launchIdentity,
    candidateSha: `abcdef0${"0".repeat(33)}`,
  };
  assert.throws(
    () =>
      deriveRuntimeDatabaseTarget({
        config,
        runtime: dbClaims[0].runtime,
        ownership,
        launchIdentity: mismatchedRunIdentity,
      }),
    /run\/SHA/u,
  );
  assert.throws(
    () =>
      deriveRuntimeDatabaseTarget({
        config,
        runtime: dbClaims[0].runtime,
        ownership: {
          ...ownership,
          databases: ownership.databases.map((db) =>
            db.owner === "customer" ? { ...db, owner: "orders" } : db,
          ),
        },
        launchIdentity,
      }),
    /canonical owner\/database mapping/,
  );
  const mismatchedRuntimeClaims = {
    ...ownership,
    runtimeClaims: ownership.runtimeClaims.map((claim) =>
      claim.runtime === dbClaims[0].runtime
        ? { ...claim, database: "coffee_platform_catalog" }
        : claim,
    ),
  };
  assert.throws(
    () =>
      deriveRuntimeDatabaseTarget({
        config,
        runtime: dbClaims[0].runtime,
        ownership: mismatchedRuntimeClaims,
        launchIdentity,
      }),
    /runtime claim/u,
  );
  const duplicateRuntimeClaims = {
    ...ownership,
    runtimeClaims: [
      ...ownership.runtimeClaims,
      ownership.runtimeClaims.find(
        (claim) => claim.runtime === dbClaims[0].runtime,
      ),
    ],
  };
  assert.throws(
    () =>
      deriveRuntimeDatabaseTarget({
        config,
        runtime: dbClaims[0].runtime,
        ownership: duplicateRuntimeClaims,
        launchIdentity,
      }),
    /runtime claim/u,
  );
  assert.throws(
    () =>
      deriveRuntimeDatabaseTarget({
        config,
        runtime: dbClaims[0].runtime,
        ownership,
        launchIdentity: { ...launchIdentity, baseConfigSha256: "bad" },
      }),
    /identity/,
  );

  const directory = await mkdtemp(join(tmpdir(), "coffee-launch-context-"));
  try {
    const contextPath = join(directory, "context.json");
    await writeFile(
      contextPath,
      JSON.stringify({
        ...launchIdentity,
        resources: { databasePrefix: "untrusted" },
      }),
      { mode: 0o444 },
    );
    await chmod(contextPath, 0o444);
    const projected = await readLaunchDatabaseIdentity(contextPath);
    assert.deepEqual(projected, launchIdentity);
    await chmod(contextPath, 0o644);
    await assert.rejects(
      readLaunchDatabaseIdentity(contextPath),
      (error) =>
        error instanceof RuntimeError &&
        error.code === "RUNTIME_LAUNCH_CONTEXT_FILE_INVALID",
    );
    await symlink(contextPath, join(directory, "context-link.json"));
    await assert.rejects(
      readLaunchDatabaseIdentity(join(directory, "context-link.json")),
      (error) =>
        error instanceof RuntimeError &&
        error.code === "RUNTIME_LAUNCH_CONTEXT_PATH_INVALID",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("launch config attestation accepts exact B/R bytes and only the literal ADR-0035 D mutation delta", () => {
  const baseBytes = Buffer.from(
    "environment: development\nservices:\n  aroma-convergence:\n    mutationsEnabled: true\n    setting: unchanged\n",
    "utf8",
  );
  const disabledBytes = Buffer.from(
    baseBytes
      .toString("utf8")
      .replace("mutationsEnabled: true", "mutationsEnabled: false"),
    "utf8",
  );
  const baseConfigSha256 = createHash("sha256").update(baseBytes).digest("hex");
  const verify = (actualConfigBytes, overrides = {}) =>
    verifyLaunchConfigBytes({
      actualConfigBytes,
      baseConfigSha256,
      runtime: "aroma-convergence",
      environment: "development",
      databaseIsolationEnabled: true,
      mutationsEnabled: actualConfigBytes.equals(disabledBytes) ? false : true,
      ...overrides,
    });
  const base = verify(baseBytes);
  assert.deepEqual(base, {
    baseConfigSha256,
    actualConfigSha256: baseConfigSha256,
    phase: "base",
  });
  const disabled = verify(disabledBytes);
  assert.deepEqual(disabled, {
    baseConfigSha256,
    actualConfigSha256: createHash("sha256")
      .update(disabledBytes)
      .digest("hex"),
    phase: "disabled",
  });
  assert.notEqual(
    disabled.baseConfigSha256,
    disabled.actualConfigSha256,
    "attestation keeps B and D hashes separate",
  );
  assert.deepEqual(
    verify(baseBytes),
    base,
    "R uses the ordinary exact B hash path",
  );

  const otherFieldBytes = Buffer.from(
    disabledBytes
      .toString("utf8")
      .replace("setting: unchanged", "setting: changed"),
    "utf8",
  );
  assert.throws(
    () => verify(otherFieldBytes, { mutationsEnabled: false }),
    /differs from B/,
  );
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  const bomDisabledBytes = Buffer.concat([bom, disabledBytes]);
  assert.throws(
    () => verify(bomDisabledBytes, { mutationsEnabled: false }),
    /differs from B/,
  );
  const bomBaseBytes = Buffer.concat([bom, baseBytes]);
  const bomBaseSha256 = createHash("sha256").update(bomBaseBytes).digest("hex");
  assert.equal(
    verify(bomDisabledBytes, {
      baseConfigSha256: bomBaseSha256,
      mutationsEnabled: false,
    }).phase,
    "disabled",
  );
  assert.throws(
    () => verify(disabledBytes, { baseConfigSha256: bomBaseSha256 }),
    /differs from B/,
  );
  const servicesFirstBase = Buffer.from(
    "\ufeffservices:\n  aroma-convergence:\n    mutationsEnabled: true\n",
  );
  assert.equal(
    verify(Buffer.from(servicesFirstBase.toString().replace("true", "false")), {
      baseConfigSha256: createHash("sha256")
        .update(servicesFirstBase)
        .digest("hex"),
      mutationsEnabled: false,
    }).phase,
    "disabled",
  );
  const whitespaceBytes = Buffer.from(
    disabledBytes
      .toString("utf8")
      .replace("setting: unchanged", "setting:  unchanged"),
    "utf8",
  );
  assert.throws(
    () => verify(whitespaceBytes, { mutationsEnabled: false }),
    /differs from B/,
  );
  const multipleFlagsBytes = Buffer.from(
    `${disabledBytes.toString("utf8")}  other:\n    mutationsEnabled: false\n`,
    "utf8",
  );
  assert.throws(
    () => verify(multipleFlagsBytes, { mutationsEnabled: false }),
    /ambiguous/,
  );
  const aliasBaseBytes = Buffer.from(
    "settings:\n  mutationsEnabled: &enabled true\nservices:\n  aroma-convergence:\n    mutationsEnabled: *enabled\n",
    "utf8",
  );
  const aliasDisabledBytes = Buffer.from(
    aliasBaseBytes
      .toString("utf8")
      .replace(
        "mutationsEnabled: &enabled true",
        "mutationsEnabled: &enabled false",
      ),
    "utf8",
  );
  assert.throws(
    () =>
      verifyLaunchConfigBytes({
        actualConfigBytes: aliasDisabledBytes,
        baseConfigSha256: createHash("sha256")
          .update(aliasBaseBytes)
          .digest("hex"),
        runtime: "aroma-convergence",
        environment: "development",
        databaseIsolationEnabled: true,
        mutationsEnabled: false,
      }),
    /ambiguous/,
  );
  assert.throws(
    () =>
      verify(disabledBytes, {
        runtime: "orders-service",
        mutationsEnabled: false,
      }),
    /only disabled aroma-convergence/,
  );
  assert.throws(
    () =>
      verify(disabledBytes, {
        databaseIsolationEnabled: false,
        mutationsEnabled: false,
      }),
    /policy/,
  );
  assert.throws(
    () =>
      verify(disabledBytes, {
        environment: "production",
        mutationsEnabled: false,
      }),
    /policy/,
  );
  assert.throws(
    () => verify(disabledBytes, { baseConfigSha256: "f".repeat(64) }),
    /differs from B/,
  );

  const misplacedBytes = Buffer.from(
    "services:\n  other-service:\n    mutationsEnabled: false\n  aroma-convergence:\n    endpoint: unchanged\n",
    "utf8",
  );
  const misplacedBaseSha = createHash("sha256")
    .update(
      misplacedBytes
        .toString("utf8")
        .replace("mutationsEnabled: false", "mutationsEnabled: true"),
    )
    .digest("hex");
  assert.throws(() =>
    verifyLaunchConfigBytes({
      actualConfigBytes: Buffer.from(
        misplacedBytes
          .toString("utf8")
          .replace("mutationsEnabled: true", "mutationsEnabled: false"),
      ),
      baseConfigSha256: misplacedBaseSha,
      runtime: "aroma-convergence",
      environment: "development",
      databaseIsolationEnabled: true,
      mutationsEnabled: false,
    }),
  );

  assert.throws(
    () => verify(Buffer.from([0xff]), { mutationsEnabled: false }),
    /valid UTF-8/u,
  );
  const verifyMalformedDisabledSource = (source) => {
    const actualConfigBytes = Buffer.from(source, "utf8");
    const baseBytes = Buffer.from(
      source.replace("mutationsEnabled: false", "mutationsEnabled: true"),
      "utf8",
    );
    return verifyLaunchConfigBytes({
      actualConfigBytes,
      baseConfigSha256: createHash("sha256").update(baseBytes).digest("hex"),
      runtime: "aroma-convergence",
      environment: "development",
      databaseIsolationEnabled: true,
      mutationsEnabled: false,
    });
  };
  assert.throws(
    () => verifyMalformedDisabledSource("mutationsEnabled: false\n"),
    /services section/u,
  );
  assert.throws(
    () =>
      verifyMalformedDisabledSource(
        "services:\n  aroma-convergence:\n    mutationsEnabled: false\nservices:\n  other:\n    setting: unchanged\n",
      ),
    /services section/u,
  );
  assert.throws(
    () =>
      verifyMalformedDisabledSource(
        "services:\n  other:\n    mutationsEnabled: false\n",
      ),
    /aroma-convergence service/u,
  );
  assert.throws(
    () =>
      verifyMalformedDisabledSource(
        "services:\n  aroma-convergence:\n    mutationsEnabled: false\n  aroma-convergence:\n    endpoint: unchanged\n",
      ),
    /aroma-convergence service/u,
  );
});

void test("observability uses Pino and redacts nested request/provider/PII/error canaries", async () => {
  const canary = "must-never-escape";
  const sensitiveKeys = [" A-P_I.Key "];
  const customFields = {
    "X-API_KEY": canary,
    nested: [{ "api.key": canary, safe: "ok" }],
  };
  assert.deepEqual(redactLogFields(customFields, sensitiveKeys), {
    "X-API_KEY": "[REDACTED]",
    nested: [{ "api.key": "[REDACTED]", safe: "ok" }],
  });
  sensitiveKeys[0] = "safe";
  assert.deepEqual(redactLogFields(customFields, sensitiveKeys), {
    "X-API_KEY": canary,
    nested: [{ "api.key": canary, safe: "[REDACTED]" }],
  });
  assert.deepEqual(
    redactLogFields({
      actor: { token: canary, value: "ok" },
      request: { headers: { cookie: canary }, body: { customerName: canary } },
      payload: canary,
      query: canary,
      provider: { message: canary },
      credentials: { username: canary, password: canary },
      "x-api-key": canary,
      private_key: canary,
      passwd: canary,
      err: new Error(canary),
    }),
    {
      actor: { token: "[REDACTED]", value: "ok" },
      request: { headers: "[REDACTED]", body: "[REDACTED]" },
      payload: "[REDACTED]",
      query: "[REDACTED]",
      provider: "[REDACTED]",
      credentials: "[REDACTED]",
      "x-api-key": "[REDACTED]",
      private_key: "[REDACTED]",
      passwd: "[REDACTED]",
      err: "[REDACTED]",
    },
  );
  const records = [];
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      records.push(chunk.toString());
      callback();
    },
  });
  const logger = createPinoLogger(
    { runtime: "test" },
    16_384,
    destination,
    1,
    25,
  );
  logger.info({ password: canary, err: new Error(canary) }, "hello");
  logger.info(
    {
      safe: {
        token: canary,
        toJSON() {
          return { token: canary };
        },
      },
    },
    "custom serialization",
  );
  logger
    .child({ token: canary })
    .child({ actor: { email: canary } })
    .info({ request: { body: { customerName: canary } } }, "nested");
  const safeMarker = "pino-redaction-record-retained";
  const pinoCanaries = [
    "pino-secret-canary",
    "pino-pii-canary",
    "pino-body-canary",
    "pino-header-canary",
    "pino-sql-canary",
    "pino-provider-canary",
  ];
  logger.info(
    {
      marker: safeMarker,
      nested: {
        credentials: { secret: pinoCanaries[0] },
        customer: { email: pinoCanaries[1] },
      },
      request: {
        body: { value: pinoCanaries[2] },
        headers: { authorization: pinoCanaries[3] },
      },
      "db.statement": pinoCanaries[4],
      provider: { response: pinoCanaries[5] },
    },
    "redaction canary record",
  );
  logger.flush();
  assert.equal(JSON.stringify(records).includes(canary), false);
  const redactionRecord = records
    .map((record) => JSON.parse(record))
    .find((record) => record.msg === "redaction canary record");
  assert.ok(redactionRecord, "the redaction test record was serialized");
  assert.equal(
    redactionRecord.marker,
    safeMarker,
    "safe marker remains in the same serialized record",
  );
  const serializedRedactionRecord = JSON.stringify(redactionRecord);
  for (const value of pinoCanaries)
    assert.equal(
      serializedRedactionRecord.includes(value),
      false,
      "sensitive canary is absent from the retained record",
    );
  let responseRawReads = 0;
  let responseHeadersReads = 0;
  const completionMarker = "fastify-completion-record-retained";
  logger.info(
    {
      marker: completionMarker,
      res: {
        statusCode: 303,
        get raw() {
          responseRawReads += 1;
          return { headers: { cookie: "response-raw-cookie-canary" } };
        },
        get headers() {
          responseHeadersReads += 1;
          return { authorization: "response-header-canary" };
        },
      },
    },
    "request completed",
  );
  const invalidStatusCanary = "invalid-response-status-canary";
  logger.info(
    {
      marker: completionMarker,
      res: {
        statusCode: invalidStatusCanary,
        get raw() {
          responseRawReads += 1;
          return invalidStatusCanary;
        },
        get headers() {
          responseHeadersReads += 1;
          return invalidStatusCanary;
        },
      },
    },
    "invalid response status",
  );
  assert.equal(typeof logger.child, "function");
  logger.flush();
  const serializedCompletionRecords = records.map((record) =>
    JSON.parse(record),
  );
  const completionRecord = serializedCompletionRecords.find(
    (record) => record.msg === "request completed",
  );
  const invalidCompletionRecord = serializedCompletionRecords.find(
    (record) => record.msg === "invalid response status",
  );
  assert.ok(completionRecord, "the same Fastify completion record is retained");
  assert.equal(completionRecord.marker, completionMarker);
  assert.deepEqual(completionRecord.res, { statusCode: 303 });
  assert.ok(
    invalidCompletionRecord,
    "an invalid status does not drop the completion record",
  );
  assert.equal(invalidCompletionRecord.marker, completionMarker);
  assert.deepEqual(invalidCompletionRecord.res, {});
  assert.equal(responseRawReads, 0, "the response raw graph is never read");
  assert.equal(responseHeadersReads, 0, "response headers are never read");
  const serializedCompletionData = JSON.stringify([
    completionRecord,
    invalidCompletionRecord,
  ]);
  assert.equal(
    serializedCompletionData.includes("response-raw-cookie-canary"),
    false,
  );
  assert.equal(
    serializedCompletionData.includes("response-header-canary"),
    false,
  );
  assert.equal(serializedCompletionData.includes(invalidStatusCanary), false);
  const droppedBefore = logRecordsDropped();
  const emitWarning = process.emitWarning.bind(process);
  const warnings = [];
  process.emitWarning = (warning, options) => {
    warnings.push({ warning, options });
    return process;
  };
  try {
    logger.info({ largeSafeField: "x".repeat(20_000) }, "oversized");
    logger
      .child({ largeSafeField: "x".repeat(20_000) })
      .info("oversized child binding");
    createPinoLogger(
      { runtime: "test", largeSafeField: "x".repeat(20_000) },
      16_384,
      destination,
    ).info("oversized base binding");
  } finally {
    process.emitWarning = emitWarning;
  }
  await new Promise((resolve) => setTimeout(resolve, 35));
  const emitWarningAgain = process.emitWarning.bind(process);
  process.emitWarning = (warning, options) => {
    warnings.push({ warning, options });
    return process;
  };
  try {
    logger.info(
      { largeSafeField: "x".repeat(20_000) },
      "oversized after configured interval",
    );
  } finally {
    process.emitWarning = emitWarningAgain;
  }
  logger.flush();
  assert.equal(logRecordsDropped(), droppedBefore + 4);
  assert.equal(
    warnings.length,
    2,
    "dropped logs emit diagnostics at the configured interval",
  );
  assert.equal(
    warnings[0].warning,
    "Structured log records dropped by configured telemetry bounds",
  );
  assert.equal(
    records.some((record) => record.includes("oversized")),
    false,
    "oversized arguments and bindings are dropped before Pino serialization",
  );
});

void test("observability preserves valid correlation and W3C trace context only", () => {
  const correlationId = "11111111-1111-4111-8111-111111111111";
  const traceparent = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01";
  const context = createCorrelationContext({
    "x-correlation-id": correlationId,
    traceparent,
    "x-causation-id": "msg_1",
  });
  assert.deepEqual(context, {
    correlationId,
    traceparent,
    causationId: "msg_1",
  });
  assert.deepEqual(correlationHeaders(context), {
    "x-correlation-id": correlationId,
    traceparent,
  });
  assert.deepEqual(withCorrelationFields(context), {
    correlationId,
    traceparent,
    causationId: "msg_1",
  });
  assert.equal(isTraceparent(traceparent), true);
  const futureVersionTraceparent = `01-${"a".repeat(32)}-${"b".repeat(16)}-01`;
  assert.equal(isTraceparent(futureVersionTraceparent), true);
  assert.equal(
    createCorrelationContext({ traceparent: futureVersionTraceparent })
      .traceparent,
    futureVersionTraceparent,
  );
  assert.equal(
    isTraceparent(`ff-${"a".repeat(32)}-${"b".repeat(16)}-01`),
    false,
  );
  assert.equal(
    isTraceparent(`00-${"A".repeat(32)}-${"b".repeat(16)}-01`),
    false,
  );
  assert.equal(
    isTraceparent(`00-${"0".repeat(32)}-bbbbbbbbbbbbbbbb-01`),
    false,
  );
  assert.equal(
    isTraceparent(`00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-${"0".repeat(16)}-01`),
    false,
  );
  const generated = createCorrelationContext({
    "x-correlation-id": "invalid",
    traceparent: "invalid",
  });
  assert.match(generated.correlationId, /^[0-9a-f-]{36}$/);
  assert.equal(generated.traceparent, undefined);
});

void test("security signs and verifies actor context claims", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const claims = {
    iss: "edge-gateway",
    aud: "api-public",
    originalIssuer: "edge-gateway",
    sub: "actor",
    permissions: ["orders:read:any"],
    operationId: "op",
    correlationId: "corr",
    traceparent: "00-abc-def-01",
    iat: 100,
    exp: 160,
    jti: "jti",
    kid: "active",
  };
  const token = signActorContext(claims, privateKey);
  assert.deepEqual(
    verifyActorContext(token, {
      publicKey,
      issuer: "edge-gateway",
      audience: "api-public",
      nowEpochSeconds: 120,
      clockSkewSeconds: 5,
    }),
    claims,
  );
  assert.throws(
    () =>
      verifyActorContext(token, {
        publicKey,
        issuer: "edge-gateway",
        audience: "api-internal",
        nowEpochSeconds: 120,
        clockSkewSeconds: 5,
      }),
    { code: "SERVICE_AUDIENCE_FORBIDDEN" },
  );
});

void test("security transport rejects plaintext and requires mutual TLS", () => {
  assert.throws(
    () =>
      parseServiceTransportMaterial(
        "compose-smoke-placeholder",
        "development",
        "api-public",
      ),
    { code: "TRANSPORT_IDENTITY_INVALID" },
  );
  assert.deepEqual(
    createMutualTlsServerOptions({
      keyPem: "key",
      certPem: "cert",
      caPem: "ca",
      identity: {
        environment: "development",
        runtime: "api-public",
        san: "spiffe://coffee-platform/development/api-public",
      },
    }),
    {
      key: "key",
      cert: "cert",
      ca: "ca",
      requestCert: true,
      rejectUnauthorized: true,
      minVersion: "TLSv1.3",
    },
  );
  assert.deepEqual(
    createPublicTlsServerOptions({
      keyPem: "key",
      certPem: "cert",
      hostname: "edge.example.test",
    }),
    { key: "key", cert: "cert", requestCert: false, minVersion: "TLSv1.3" },
  );
  assert.throws(() => parsePublicTlsCaBundle("not-a-certificate"), {
    code: "TRANSPORT_IDENTITY_INVALID",
  });
});

void test("security signs and verifies service delegation claims", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const claims = {
    iss: "api-internal",
    aud: "customer-service",
    originalCaller: "orders-service",
    operationId: "getCustomerOrderInput",
    correlationId: "corr",
    traceparent: "00-abc-def-01",
    iat: 100,
    exp: 160,
    jti: "jti",
    kid: "active",
  };
  const token = signServiceDelegation(claims, privateKey);
  assert.deepEqual(
    verifyServiceDelegation(token, {
      publicKey,
      issuer: "api-internal",
      audience: "customer-service",
      nowEpochSeconds: 120,
      clockSkewSeconds: 5,
    }),
    claims,
  );
});

const poolConfig = {
  max: 2,
  checkoutTimeoutMs: 50,
  lockTimeoutMs: 40,
  interactiveStatementTimeoutMs: 100,
  backgroundStatementTimeoutMs: 200,
  terminalTimeoutMs: 40,
  transactionTimeoutMs: 300,
  idleTimeoutMs: 1000,
  maxLifetimeMs: 1000,
};
function mockDatabase(
  t,
  hook = () => undefined,
  ssl = false,
  poolOverrides = {},
  connect = async (connection) => connection,
) {
  const statements = [],
    releases = [];
  const connection = new EventEmitter();
  connection.query = async (query) => {
    const sql = typeof query === "string" ? query : query.text;
    statements.push(sql);
    const override = hook(sql, typeof query === "string" ? [] : query.values);
    return override ?? { rows: [], rowCount: 0, command: sql.split(" ")[0] };
  };
  connection.release = (destroy) => {
    releases.push(destroy);
  };
  t.mock.method(pg.Pool.prototype, "connect", () => connect(connection));
  t.mock.method(pg.Pool.prototype, "end", async () => {});
  const options = {
    owner: "test",
    database: "owner",
    allowedDatabase: "owner",
    host: "localhost",
    port: 5432,
    user: "owner",
    password: "test-only",
    ssl,
    pool: { ...poolConfig, ...poolOverrides },
    shutdownGraceMs: 1000,
  };
  const database = createDatabase(options);
  t.after(() => database.resource.destroy());
  return { database, statements, releases, connection, options };
}

void test("Customer adapters default to fail-closed transport security", async (t) => {
  const { database, statements } = mockDatabase(t);
  const adapters = createCustomerAdapters(database);
  const request = { headers: {} };
  const signal = new AbortController().signal;

  assert.equal(adapters.verifyTransport(request, "api-public"), false);
  assert.equal(adapters.verifyTransport(request, "api-internal"), false);
  assert.throws(
    () => adapters.verifyPublicDelegation("token", "createCustomer", signal),
    { message: "CUSTOMER_TRANSPORT_NOT_CONFIGURED" },
  );
  assert.throws(
    () =>
      adapters.verifyInternalDelegation(
        "token",
        "getCustomerOrderInput",
        signal,
      ),
    { message: "CUSTOMER_TRANSPORT_NOT_CONFIGURED" },
  );
  assert.equal(typeof adapters.owner.create, "function");
  assert.deepEqual(
    statements,
    [],
    "adapter construction must not query the database",
  );
});

void test("CustomerStore name search binds escaped prefix and maps owner rows", async (t) => {
  const customerRef = "cus_00000000000000000000000001";
  const row = {
    customer_ref: customerRef,
    version: "2",
    display_name: "A_%\\",
    display_name_search: "a_%\\",
    phone_e164: null,
    email_normalized: null,
  };
  const { database, statements, releases } = mockDatabase(t, (sql, values) => {
    if (
      sql === "BEGIN" ||
      sql === "COMMIT" ||
      sql === "ROLLBACK" ||
      sql.startsWith("SET LOCAL ")
    )
      return undefined;
    if (sql.includes("display_name_search LIKE")) {
      assert.deepEqual(values, ["A\\_\\%\\\\", "a%", customerRef, 7]);
      return { rows: [row], rowCount: 1, command: "SELECT" };
    }
    assert.fail(`unexpected CustomerStore query: ${sql}`);
  });
  const store = new CustomerStore(
    database,
    new CustomerRepository(database),
    createSqlIdempotencyStore(database, {
      schema: "customer",
      table: "idempotency_records",
    }),
  );

  assert.deepEqual(
    await store.search(
      { mode: "name", value: "A_%\\" },
      { name: "a%", customerRef },
      7,
    ),
    [
      {
        customerRef,
        version: "2",
        displayName: "A_%\\",
        name: "a_%\\",
        phoneE164: null,
        emailNormalized: null,
      },
    ],
  );
  assert.equal(
    statements.some((sql) => sql.includes("display_name_search LIKE")),
    true,
  );
  assert.equal(statements.at(-1), "COMMIT");
  assert.deepEqual(releases, [false]);
});

void test("CustomerStore contact searches use exact phone and email predicates", async (t) => {
  const customerRef = "cus_00000000000000000000000004";
  const row = {
    customer_ref: customerRef,
    version: "3",
    display_name: "Alice Example",
    display_name_search: "alice example",
    phone_e164: "+79991234567",
    email_normalized: "alice@example.test",
  };
  const { database, statements } = mockDatabase(t, (sql, values) => {
    if (
      sql === "BEGIN" ||
      sql === "COMMIT" ||
      sql === "ROLLBACK" ||
      sql.startsWith("SET LOCAL ")
    )
      return undefined;
    if (sql.includes("phone_e164 = $1")) {
      assert.deepEqual(values, ["+79991234567", null, null, 5]);
      return { rows: [row], rowCount: 1, command: "SELECT" };
    }
    if (sql.includes("email_normalized = $1")) {
      assert.deepEqual(values, ["alice@example.test", null, null, 5]);
      return { rows: [row], rowCount: 1, command: "SELECT" };
    }
    assert.fail(`unexpected CustomerStore query: ${sql}`);
  });
  const store = new CustomerStore(
    database,
    new CustomerRepository(database),
    createSqlIdempotencyStore(database, {
      schema: "customer",
      table: "idempotency_records",
    }),
  );
  const expected = [
    {
      customerRef,
      version: "3",
      displayName: "Alice Example",
      name: "alice example",
      phoneE164: "+79991234567",
      emailNormalized: "alice@example.test",
    },
  ];

  assert.deepEqual(
    await store.search(
      { mode: "phone", value: "+79991234567", queryHash: "phone-hash" },
      null,
      5,
    ),
    expected,
  );
  assert.deepEqual(
    await store.search(
      {
        mode: "email",
        value: "alice@example.test",
        queryHash: "email-hash",
      },
      null,
      5,
    ),
    expected,
  );
  assert.equal(statements.filter((sql) => sql === "COMMIT").length, 2);
});

void test("CustomerStore order input returns absence and rejects malformed owner rows", async (t) => {
  const customerRef = "cus_00000000000000000000000002";
  const responses = [
    { rows: [], rowCount: 0, command: "SELECT" },
    {
      rows: [
        {
          customer_ref: customerRef,
          version: "1",
          display_name: "Customer fixture",
          status: "Suspended",
        },
      ],
      rowCount: 1,
      command: "SELECT",
    },
  ];
  const { database, statements } = mockDatabase(t, (sql, values) => {
    if (
      sql === "BEGIN" ||
      sql === "COMMIT" ||
      sql === "ROLLBACK" ||
      sql.startsWith("SET LOCAL ")
    )
      return undefined;
    if (sql.includes("WHERE customer_ref = $1")) {
      assert.deepEqual(values, [customerRef]);
      const response = responses.shift();
      assert.ok(response, "only the two expected reads are permitted");
      return response;
    }
    assert.fail(`unexpected CustomerStore query: ${sql}`);
  });
  const store = new CustomerStore(
    database,
    new CustomerRepository(database),
    createSqlIdempotencyStore(database, {
      schema: "customer",
      table: "idempotency_records",
    }),
  );

  assert.equal(await store.getOrderInput(customerRef), null);
  await assert.rejects(store.getOrderInput(customerRef), {
    message: "CUSTOMER_STORAGE_ROW_INVALID",
  });
  assert.equal(responses.length, 0);
  assert.equal(statements.filter((sql) => sql === "COMMIT").length, 1);
  assert.equal(statements.at(-1), "ROLLBACK");
});

void test("CustomerStore commits one aggregate and replays it without duplicate writes", async (t) => {
  const identity = {
    actorRef: "actor:customer-test",
    scope: "a".repeat(64),
    key: "00000000-0000-4000-8000-000000000031",
  };
  const correlationId = "00000000-0000-4000-8000-000000000032";
  let leaseOwner;
  let requestHash;
  let completed;
  let insertAttempts = 0;
  const aggregateWrites = { customer: 0, address: 0, audit: 0 };
  const { database, statements } = mockDatabase(t, (sql, values) => {
    if (
      sql === "BEGIN" ||
      sql === "COMMIT" ||
      sql === "ROLLBACK" ||
      sql.startsWith("SET LOCAL ")
    )
      return undefined;
    if (sql.startsWith('INSERT INTO "customer"."idempotency_records"')) {
      requestHash = values[3];
      leaseOwner = values[4];
      insertAttempts++;
      return {
        rows: insertAttempts === 1 ? [{ idempotency_key: identity.key }] : [],
        rowCount: insertAttempts === 1 ? 1 : 0,
        command: "INSERT",
      };
    }
    if (sql.includes('FROM "customer"."idempotency_records"')) {
      assert.deepEqual(values, [
        identity.actorRef,
        identity.scope,
        identity.key,
      ]);
      return {
        rows: [
          {
            actor_ref: identity.actorRef,
            scope: identity.scope,
            idempotency_key: identity.key,
            request_hash: requestHash,
            state: completed === undefined ? "Acquired" : "Completed",
            lease_owner: leaseOwner,
            lease_until_ms: "4102444800000",
            expires_at_ms: "4102444800000",
            response_status: completed?.status ?? null,
            response_body:
              completed === undefined ? null : JSON.parse(completed.body),
            resource_ref: completed?.resourceRef ?? null,
          },
        ],
        rowCount: 1,
        command: "SELECT",
      };
    }
    if (sql.includes("INSERT INTO customer.customers")) {
      aggregateWrites.customer++;
      assert.equal(values[1], "Test Customer");
      assert.equal(values[2], "test customer");
      return {
        rows: [
          {
            customer_ref: values[0],
            version: "1",
            display_name: values[1],
            phone_e164: values[3],
            email_normalized: values[4],
            created_at: "2026-10-25T08:00:00.000Z",
            updated_at: "2026-10-25T08:00:00.000Z",
          },
        ],
        rowCount: 1,
        command: "INSERT",
      };
    }
    if (sql.includes("INSERT INTO customer.addresses")) {
      aggregateWrites.address++;
      return {
        rows: [{ address_ref: values[0] }],
        rowCount: 1,
        command: "INSERT",
      };
    }
    if (sql.includes("INSERT INTO customer.audit_log")) {
      aggregateWrites.audit++;
      return {
        rows: [{ audit_ref: values[0] }],
        rowCount: 1,
        command: "INSERT",
      };
    }
    if (sql.includes('UPDATE "customer"."idempotency_records"')) {
      completed = {
        status: values[4],
        body: values[5],
        resourceRef: values[6],
      };
      return {
        rows: [{ idempotency_key: identity.key }],
        rowCount: 1,
        command: "UPDATE",
      };
    }
    assert.fail(`unexpected CustomerStore query: ${sql}`);
  });
  const store = new CustomerStore(
    database,
    new CustomerRepository(database),
    createSqlIdempotencyStore(database, {
      schema: "customer",
      table: "idempotency_records",
    }),
  );
  const command = {
    actorRef: identity.actorRef,
    scope: identity.scope,
    idempotencyKey: identity.key,
    correlationId,
    input: {
      displayName: "Test Customer",
      displayNameSearch: "test customer",
      phoneE164: "+79991234567",
      emailNormalized: "alice@example.test",
      address: {
        kind: "Delivery",
        line1: "1 Main Street",
        line2: null,
        city: "Yekaterinburg",
        postalCode: null,
        countryCode: "RU",
      },
    },
  };

  const created = await store.create(command);
  assert.equal(created.status, 201);
  assert.equal(created.replayed, false);
  assert.equal(created.body.address?.line1, "1 Main Street");
  assert.equal(completed?.status, 201);
  assert.deepEqual(JSON.parse(completed?.body), created.body);
  assert.equal(completed?.resourceRef, created.body.customerRef);

  assert.deepEqual(await store.create(command), { ...created, replayed: true });
  assert.equal(insertAttempts, 2);
  assert.deepEqual(aggregateWrites, { customer: 1, address: 1, audit: 1 });
  assert.equal(statements.filter((sql) => sql === "COMMIT").length, 2);
  assert.equal(statements.includes("ROLLBACK"), false);
});

void test("CustomerStore replay distinguishes completed, in-progress, expired and missing records", async (t) => {
  const identity = {
    actorRef: "actor:customer-test",
    scope: "b".repeat(64),
    key: "00000000-0000-4000-8000-000000000033",
  };
  const correlationId = "00000000-0000-4000-8000-000000000034";
  const customerResponse = {
    customerRef: "cus_00000000000000000000000005",
    version: "1",
    displayName: "Customer fixture",
    createdAt: "2026-10-25T08:00:00.000Z",
    updatedAt: "2026-10-25T08:00:00.000Z",
  };
  const records = [
    {
      state: "Completed",
      expiresAtMs: Number.MAX_SAFE_INTEGER,
      response: {
        status: 201,
        body: customerResponse,
        resourceRef: customerResponse.customerRef,
      },
    },
    undefined,
    {
      state: "Acquired",
      expiresAtMs: Number.MAX_SAFE_INTEGER,
    },
    {
      state: "Completed",
      expiresAtMs: 0,
      response: { status: 201, body: customerResponse },
    },
    { state: "Completed", expiresAtMs: Number.MAX_SAFE_INTEGER },
  ];
  const { database, statements } = mockDatabase(t, (sql) => {
    if (
      sql === "BEGIN" ||
      sql === "COMMIT" ||
      sql === "ROLLBACK" ||
      sql.startsWith("SET LOCAL ")
    )
      return undefined;
    assert.fail(`unexpected CustomerStore replay query: ${sql}`);
  });
  const store = new CustomerStore(
    database,
    {},
    {
      get: async (_transaction, requestedIdentity) => {
        assert.deepEqual(requestedIdentity, identity);
        return records.shift();
      },
    },
  );
  const signal = new AbortController().signal;

  assert.deepEqual(await store.replay(identity, signal, correlationId), {
    kind: "completed",
    response: {
      status: 201,
      body: customerResponse,
      resourceRef: customerResponse.customerRef,
    },
  });
  assert.deepEqual(await store.replay(identity, signal, correlationId), {
    kind: "not_retained",
  });
  assert.deepEqual(await store.replay(identity, signal, correlationId), {
    kind: "in_progress",
  });
  assert.deepEqual(await store.replay(identity, signal, correlationId), {
    kind: "not_retained",
  });
  assert.deepEqual(await store.replay(identity, signal, correlationId), {
    kind: "invalid",
  });
  assert.equal(records.length, 0);
  assert.equal(statements.filter((sql) => sql === "COMMIT").length, 5);
});

void test("CustomerStore creates only after acquiring a new idempotency lease", async (t) => {
  const identity = {
    actorRef: "actor:customer-test",
    scope: "c".repeat(64),
    key: "00000000-0000-4000-8000-000000000035",
  };
  const command = {
    actorRef: identity.actorRef,
    scope: identity.scope,
    idempotencyKey: identity.key,
    correlationId: "00000000-0000-4000-8000-000000000036",
    input: {
      displayName: "Customer fixture",
      displayNameSearch: "customer fixture",
      phoneE164: null,
      emailNormalized: null,
      address: null,
    },
  };
  const customerResponse = {
    customerRef: "cus_00000000000000000000000006",
    version: "1",
    displayName: "Customer fixture",
    createdAt: "2026-10-25T08:00:00.000Z",
    updatedAt: "2026-10-25T08:00:00.000Z",
  };
  const acquireResults = [
    { kind: "acquired", record: {} },
    { kind: "conflict", reason: "request_hash_mismatch" },
    { kind: "in_progress", leaseUntilMs: Number.MAX_SAFE_INTEGER },
    {
      kind: "replay",
      response: { status: 201, body: customerResponse },
    },
    { kind: "replay", response: { status: 409, body: {} } },
  ];
  const writes = { aggregate: 0, complete: 0 };
  const { database, statements } = mockDatabase(t, (sql) => {
    if (
      sql === "BEGIN" ||
      sql === "COMMIT" ||
      sql === "ROLLBACK" ||
      sql.startsWith("SET LOCAL ")
    )
      return undefined;
    assert.fail(`unexpected CustomerStore idempotency query: ${sql}`);
  });
  const store = new CustomerStore(
    database,
    {
      createAggregate: async () => {
        writes.aggregate++;
        return customerResponse;
      },
    },
    {
      acquire: async () => acquireResults.shift(),
      complete: async (
        _transaction,
        requestedIdentity,
        _leaseOwner,
        response,
      ) => {
        assert.deepEqual(requestedIdentity, identity);
        assert.equal(response.resourceRef, customerResponse.customerRef);
        writes.complete++;
      },
    },
  );

  assert.deepEqual(await store.create(command), {
    status: 201,
    body: customerResponse,
    replayed: false,
  });
  await assert.rejects(store.create(command), { code: "IDEMPOTENCY_CONFLICT" });
  await assert.rejects(store.create(command), {
    code: "IDEMPOTENCY_REQUEST_IN_PROGRESS",
  });
  assert.deepEqual(await store.create(command), {
    status: 201,
    body: customerResponse,
    replayed: true,
  });
  await assert.rejects(store.create(command), {
    code: "IDEMPOTENCY_RESULT_INVALID",
  });

  assert.equal(acquireResults.length, 0);
  assert.deepEqual(writes, { aggregate: 1, complete: 1 });
  assert.equal(statements.filter((sql) => sql === "COMMIT").length, 2);
  assert.equal(statements.filter((sql) => sql === "ROLLBACK").length, 3);
});

void test("CustomerRepository rejects duplicate active contacts without writing a second aggregate", async (t) => {
  const customerRef = "cus_00000000000000000000000007";
  const phone = "+79991234567";
  const email = "alice@example.test";
  let owner;
  let aggregateWrites = 0;
  let auditWrites = 0;
  const { database, statements } = mockDatabase(t, (sql, values) => {
    if (
      sql === "BEGIN" ||
      sql === "COMMIT" ||
      sql === "ROLLBACK" ||
      sql.startsWith("SET LOCAL ")
    )
      return undefined;
    if (sql.includes("INSERT INTO customer.customers")) {
      aggregateWrites++;
      if (owner !== undefined)
        return { rows: [], rowCount: 0, command: "INSERT" };
      owner = { phone: values[3], email: values[4] };
      return {
        rows: [
          {
            customer_ref: values[0],
            version: "1",
            display_name: values[1],
            phone_e164: values[3],
            email_normalized: values[4],
            created_at: "2026-10-25T08:00:00.000Z",
            updated_at: "2026-10-25T08:00:00.000Z",
          },
        ],
        rowCount: 1,
        command: "INSERT",
      };
    }
    if (sql.includes("phone_e164 = $1")) {
      assert.deepEqual(values, [phone]);
      return {
        rows: [{ phone_e164: owner?.phone ?? null }],
        rowCount: owner?.phone === phone ? 1 : 0,
        command: "SELECT",
      };
    }
    if (sql.includes("email_normalized = $1")) {
      assert.deepEqual(values, [email]);
      return {
        rows: [{ phone_e164: owner?.phone ?? null }],
        rowCount: owner?.email === email ? 1 : 0,
        command: "SELECT",
      };
    }
    if (sql.includes("INSERT INTO customer.audit_log")) {
      auditWrites++;
      return {
        rows: [{ audit_ref: values[0] }],
        rowCount: 1,
        command: "INSERT",
      };
    }
    assert.fail(`unexpected CustomerRepository query: ${sql}`);
  });
  const repository = new CustomerRepository(database);
  const baseWrite = {
    customerRef,
    addressRef: null,
    auditRef: "aud_customer_fixture",
    actorRef: "actor:customer-test",
    correlationId: "00000000-0000-4000-8000-000000000037",
    input: {
      displayName: "Alice Example",
      displayNameSearch: "alice example",
      phoneE164: phone,
      emailNormalized: email,
      address: null,
    },
  };
  const persist = (write) =>
    withTransaction(database, { mode: "interactive" }, (transaction) =>
      repository.createAggregate(transaction, write),
    );

  const created = await persist(baseWrite);
  assert.equal(created.displayName, "Alice Example");
  await assert.rejects(
    persist({
      ...baseWrite,
      customerRef: "cus_00000000000000000000000008",
      auditRef: "aud_customer_duplicate_phone",
      input: { ...baseWrite.input, emailNormalized: null },
    }),
    { code: "CUSTOMER_PHONE_CONFLICT" },
  );
  await assert.rejects(
    persist({
      ...baseWrite,
      customerRef: "cus_00000000000000000000000009",
      auditRef: "aud_customer_duplicate_email",
      input: { ...baseWrite.input, phoneE164: null },
    }),
    { code: "CUSTOMER_EMAIL_CONFLICT" },
  );
  assert.equal(aggregateWrites, 3);
  assert.equal(auditWrites, 1);
  assert.equal(statements.filter((sql) => sql === "COMMIT").length, 1);
  assert.equal(statements.filter((sql) => sql === "ROLLBACK").length, 2);
});

void test("CustomerRepository fails closed when an ignored insert has no active-contact conflict", async (t) => {
  const existing = {
    customer_ref: "cus_00000000000000000000000010",
    version: "1",
    display_name: "Alice Example",
    phone_e164: "+79991234567",
    email_normalized: "alice@example.test",
    created_at: "2026-10-25T08:00:00.000Z",
    updated_at: "2026-10-25T08:00:00.000Z",
  };
  let inserts = 0;
  let audits = 0;
  const { database, statements } = mockDatabase(t, (sql, values) => {
    if (
      sql === "BEGIN" ||
      sql === "COMMIT" ||
      sql === "ROLLBACK" ||
      sql.startsWith("SET LOCAL ")
    )
      return undefined;
    if (sql.includes("INSERT INTO customer.customers")) {
      inserts++;
      return inserts === 1
        ? {
            rows: [existing],
            rowCount: 1,
            command: "INSERT",
          }
        : { rows: [], rowCount: 0, command: "INSERT" };
    }
    if (sql.includes("phone_e164 = $1")) {
      assert.deepEqual(values, ["+79990000000"]);
      return { rows: [], rowCount: 0, command: "SELECT" };
    }
    if (sql.includes("email_normalized = $1")) {
      assert.deepEqual(values, ["bob@example.test"]);
      return { rows: [], rowCount: 0, command: "SELECT" };
    }
    if (sql.includes("INSERT INTO customer.audit_log")) {
      audits++;
      return {
        rows: [{ audit_ref: values[0] }],
        rowCount: 1,
        command: "INSERT",
      };
    }
    assert.fail(`unexpected CustomerRepository query: ${sql}`);
  });
  const repository = new CustomerRepository(database);
  const persist = (write) =>
    withTransaction(database, { mode: "interactive" }, (transaction) =>
      repository.createAggregate(transaction, write),
    );
  const baseline = {
    customerRef: existing.customer_ref,
    addressRef: null,
    auditRef: "aud_customer_insert_baseline",
    actorRef: "actor:customer-test",
    correlationId: "00000000-0000-4000-8000-000000000042",
    input: {
      displayName: "Alice Example",
      displayNameSearch: "alice example",
      phoneE164: existing.phone_e164,
      emailNormalized: existing.email_normalized,
      address: null,
    },
  };
  assert.equal((await persist(baseline)).customerRef, existing.customer_ref);

  await assert.rejects(
    persist({
      ...baseline,
      customerRef: "cus_00000000000000000000000011",
      auditRef: "aud_customer_unknown_conflict",
      input: {
        ...baseline.input,
        phoneE164: "+79990000000",
        emailNormalized: "bob@example.test",
      },
    }),
    { message: "customer insert was ignored without a contact conflict" },
  );
  assert.equal(inserts, 2);
  assert.equal(audits, 1, "the unresolved insert must not write an audit row");
  assert.equal(statements.filter((sql) => sql === "COMMIT").length, 1);
  assert.equal(statements.filter((sql) => sql === "ROLLBACK").length, 1);
});

void test("CustomerRepository audit write failure rolls back the aggregate transaction", async (t) => {
  const customerRef = "cus_00000000000000000000000003";
  const correlationId = "00000000-0000-4000-8000-000000000003";
  const { database, statements, releases } = mockDatabase(t, (sql, values) => {
    if (
      sql === "BEGIN" ||
      sql === "COMMIT" ||
      sql === "ROLLBACK" ||
      sql.startsWith("SET LOCAL ")
    )
      return undefined;
    if (sql.includes("INSERT INTO customer.customers")) {
      assert.equal(values[0], customerRef);
      return {
        rows: [
          {
            customer_ref: customerRef,
            version: "1",
            display_name: "Customer fixture",
            phone_e164: null,
            email_normalized: null,
            created_at: "2026-10-25T08:00:00.000Z",
            updated_at: "2026-10-25T08:00:00.000Z",
          },
        ],
        rowCount: 1,
        command: "INSERT",
      };
    }
    if (sql.includes("INSERT INTO customer.audit_log"))
      return { rows: [], rowCount: 0, command: "INSERT" };
    assert.fail(`unexpected CustomerRepository query: ${sql}`);
  });
  const repository = new CustomerRepository(database);

  await assert.rejects(
    withTransaction(database, { mode: "interactive" }, (transaction) =>
      repository.createAggregate(transaction, {
        customerRef,
        addressRef: null,
        auditRef: "aud_customer_fixture",
        actorRef: "actor:customer-test",
        correlationId,
        input: {
          displayName: "Customer fixture",
          displayNameSearch: "customer fixture",
          phoneE164: null,
          emailNormalized: null,
          address: null,
        },
      }),
    ),
    { name: "CustomerStorageError", message: "audit insert failed" },
  );
  assert.equal(
    statements.some((sql) => sql.includes("INSERT INTO customer.audit_log")),
    true,
  );
  assert.equal(statements.includes("COMMIT"), false);
  assert.equal(statements.at(-1), "ROLLBACK");
  assert.deepEqual(releases, [false]);
});

void test("PricingStore maps the active policy and rejects a malformed persisted policy", async (t) => {
  const validPolicyRow = {
    policy_version_ref: "pvr_00000000000000000000000001",
    version: "2",
    currency: "RUB",
    markup_basis_points: 3000,
    minimum_margin_minor: "0",
    quote_ttl_seconds: 900,
    quantity_scale: 3,
    rounding_mode: "CEILING",
  };
  const rows = [
    validPolicyRow,
    { ...validPolicyRow, markup_basis_points: 100001 },
  ];
  const { database, statements } = mockDatabase(t, (sql, values) => {
    if (
      sql === "BEGIN" ||
      sql === "COMMIT" ||
      sql === "ROLLBACK" ||
      sql.startsWith("SET LOCAL ")
    )
      return undefined;
    if (sql.includes("FROM pricing.pricing_policy_versions")) {
      assert.deepEqual(values, []);
      const row = rows.shift();
      assert.ok(row, "only the two expected policy reads are permitted");
      return { rows: [row], rowCount: 1, command: "SELECT" };
    }
    assert.fail(`unexpected PricingStore query: ${sql}`);
  });
  const store = new PricingStore(database);

  assert.deepEqual(await store.readActivePolicy(), {
    policyVersionRef: validPolicyRow.policy_version_ref,
    version: "2",
    currency: "RUB",
    markupBasisPoints: 3000,
    minimumMarginMinor: "0",
    quoteTtlSeconds: 900,
    quantityScale: 3,
    roundingMode: "CEILING",
  });
  await assert.rejects(store.readActivePolicy(), {
    code: "PRICING_DATABASE_DECODE_ERROR",
  });
  assert.equal(rows.length, 0);
  assert.equal(statements.filter((sql) => sql === "COMMIT").length, 1);
  assert.equal(statements.at(-1), "ROLLBACK");
});

void test("PricingStore persists a validated quote and completes idempotency in one transaction", async (t) => {
  const identity = {
    actorRef: "actor:pricing-test",
    scope: "a".repeat(64),
    key: "00000000-0000-4000-8000-000000000004",
  };
  const requestHash = "b".repeat(64);
  const nowMs = 1_798_000_000_000;
  const policyRow = {
    policy_version_ref: "pvr_00000000000000000000000001",
    version: "2",
    currency: "RUB",
    markup_basis_points: 3000,
    minimum_margin_minor: "0",
    quote_ttl_seconds: 900,
    quantity_scale: 3,
    rounding_mode: "CEILING",
  };
  let leaseOwner;
  let currentNowMs = nowMs;
  let clockReads = 0;
  let idempotencyInsertCalls = 0;
  let insertedQuote;
  let insertedLine;
  let completedResponse;
  const auditEvents = [];
  const { database, statements } = mockDatabase(t, (sql, values) => {
    if (
      sql === "BEGIN" ||
      sql === "COMMIT" ||
      sql === "ROLLBACK" ||
      sql.startsWith("SET LOCAL ")
    )
      return undefined;
    if (sql.includes('INSERT INTO "pricing"."pricing_idempotency_records"')) {
      assert.deepEqual(values.slice(0, 4), [
        identity.actorRef,
        identity.scope,
        identity.key,
        requestHash,
      ]);
      leaseOwner = values[4];
      idempotencyInsertCalls++;
      return {
        rows:
          idempotencyInsertCalls === 1
            ? [{ idempotency_key: identity.key }]
            : [],
        rowCount: idempotencyInsertCalls === 1 ? 1 : 0,
        command: "INSERT",
      };
    }
    if (sql.includes('FROM "pricing"."pricing_idempotency_records"')) {
      assert.deepEqual(values, [
        identity.actorRef,
        identity.scope,
        identity.key,
      ]);
      const completed = completedResponse !== undefined;
      return {
        rows: [
          {
            actor_ref: identity.actorRef,
            scope: identity.scope,
            idempotency_key: identity.key,
            request_hash: requestHash,
            state: completed ? "Completed" : "Acquired",
            lease_owner: completed ? completedResponse[3] : leaseOwner,
            lease_until_ms: String(nowMs + 30_000),
            expires_at_ms: String(nowMs + 86_400_000),
            response_status: completed ? completedResponse[4] : null,
            response_body: completed ? JSON.parse(completedResponse[5]) : null,
            resource_ref: completed ? completedResponse[6] : null,
          },
        ],
        rowCount: 1,
        command: "SELECT",
      };
    }
    if (sql.includes("date_trunc('milliseconds',transaction_timestamp())")) {
      const ttlSeconds = values[0];
      assert.equal([0, 900, 0, 0][clockReads] ?? 0, ttlSeconds);
      clockReads++;
      return {
        rows: [
          {
            created_at: new Date(currentNowMs),
            expires_at: new Date(currentNowMs + ttlSeconds * 1000),
            now_ms: String(currentNowMs),
          },
        ],
        rowCount: 1,
        command: "SELECT",
      };
    }
    if (sql.includes("FROM pricing.pricing_policy_versions"))
      return { rows: [policyRow], rowCount: 1, command: "SELECT" };
    if (sql.startsWith("INSERT INTO pricing.pricing_quotes")) {
      insertedQuote = values;
      return { rows: [], rowCount: 1, command: "INSERT" };
    }
    if (sql.startsWith("INSERT INTO pricing.pricing_quote_lines")) {
      insertedLine = values;
      return { rows: [], rowCount: 1, command: "INSERT" };
    }
    if (sql.includes("FROM pricing.pricing_quotes q")) {
      assert.deepEqual(values, [result.body.quoteRef]);
      return {
        rows: [
          {
            quote_ref: insertedQuote[0],
            customer_ref: insertedQuote[1],
            policy_version_ref: insertedQuote[2],
            catalog_snapshot_revision: insertedQuote[3],
            currency: "RUB",
            total_minor: insertedQuote[4],
            canonical_hash: insertedQuote[5],
            internal_proof_hash: insertedQuote[6],
            created_at: new Date(insertedQuote[7]),
            expires_at: new Date(insertedQuote[8]),
            actor_ref: insertedQuote[9],
            correlation_id: insertedQuote[10],
            request_hash: insertedQuote[11],
            quote_ttl_seconds: policyRow.quote_ttl_seconds,
            quantity_scale: policyRow.quantity_scale,
            rounding_mode: policyRow.rounding_mode,
            unexpired: new Date(insertedQuote[8]).getTime() > currentNowMs,
          },
        ],
        rowCount: 1,
        command: "SELECT",
      };
    }
    if (sql.startsWith("SELECT *, catalog_snapshot_revision::text"))
      return {
        rows: [
          {
            quote_ref: insertedLine[0],
            line_number: insertedLine[1],
            product_ref: insertedLine[2],
            variant_ref: insertedLine[3],
            product_display_name: insertedLine[4],
            offer_ref: insertedLine[5],
            catalog_snapshot_revision: insertedLine[6],
            mapping_revision: insertedLine[7],
            unit: insertedLine[8],
            quantity_milli: String(insertedLine[9]),
            supplier_unit_minor: insertedLine[10],
            markup_basis_points: insertedLine[11],
            minimum_margin_minor: insertedLine[12],
            unit_minor: insertedLine[13],
            line_total_minor: insertedLine[14],
            currency: "RUB",
            source_grind_key_hash: insertedLine[15],
            grind_display_name: insertedLine[16],
          },
        ],
        rowCount: 1,
        command: "SELECT",
      };
    if (sql.startsWith("INSERT INTO pricing.pricing_audit_records")) {
      auditEvents.push(values.slice(1));
      return { rows: [], rowCount: 1, command: "INSERT" };
    }
    if (sql.includes('UPDATE "pricing"."pricing_idempotency_records"')) {
      completedResponse = values;
      return {
        rows: [{ idempotency_key: identity.key }],
        rowCount: 1,
        command: "UPDATE",
      };
    }
    assert.fail(`unexpected PricingStore query: ${sql}`);
  });
  const store = new PricingStore(database);
  const input = {
    identity,
    requestHash,
    correlationId: "00000000-0000-4000-8000-000000000006",
    policy: {
      policyVersionRef: policyRow.policy_version_ref,
      version: policyRow.version,
      currency: "RUB",
      markupBasisPoints: policyRow.markup_basis_points,
      minimumMarginMinor: policyRow.minimum_margin_minor,
      quoteTtlSeconds: policyRow.quote_ttl_seconds,
      quantityScale: 3,
      roundingMode: "CEILING",
    },
    customerRef: "cus_00000000000000000000000001",
    catalogSnapshotRevision: "1",
    lines: [
      {
        productRef: "prd_00000000000000000000000001",
        variantRef: "var_00000000000000000000000001",
        productDisplayName: "Coffee fixture",
        quantity: "2.000",
        unit: "piece",
        offerRef: "off_00000000000000000000000001",
        mappingRevision: "1",
        supplierUnitMinor: "100",
        catalogSnapshotRevision: "1",
      },
    ],
  };
  const result = await store.create(input);

  assert.equal(result.status, 201);
  assert.equal(result.replayed, false);
  assert.equal(result.body.totalMinor, "260");
  assert.equal(result.body.lines[0].unitMinor, "130");
  assert.equal(insertedLine?.[9], 2000n);
  assert.equal(completedResponse?.[3], leaseOwner);
  assert.equal(completedResponse?.[4], 201);
  assert.equal(completedResponse?.[6], result.body.quoteRef);
  assert.deepEqual(JSON.parse(completedResponse?.[5]), result.body);
  const replayed = await store.create(input);
  assert.deepEqual(replayed, { ...result, replayed: true });
  assert.equal(idempotencyInsertCalls, 2);
  assert.equal(
    statements.filter((sql) =>
      sql.startsWith("INSERT INTO pricing.pricing_quotes"),
    ).length,
    1,
  );
  assert.equal(
    statements.filter((sql) =>
      sql.startsWith("INSERT INTO pricing.pricing_quote_lines"),
    ).length,
    1,
  );
  assert.equal(
    statements.filter((sql) =>
      sql.startsWith("INSERT INTO pricing.pricing_audit_records"),
    ).length,
    1,
  );
  assert.equal(clockReads, 4);
  const verificationRequest = {
    quoteRef: result.body.quoteRef,
    hash: result.body.hash,
    customerRef: input.customerRef,
    quoteLineNumber: 1,
    productRef: input.lines[0].productRef,
    variantRef: input.lines[0].variantRef,
    quantity: result.body.lines[0].quantity,
  };
  const verified = await store.verify({
    request: verificationRequest,
    actorRef: "actor:orders-test",
    correlationId: "00000000-0000-4000-8000-000000000007",
  });
  assert.equal(verified.valid, true);
  assert.equal(verified.line.offerRef, input.lines[0].offerRef);
  assert.equal(verified.line.supplierUnitMinor, "100");
  assert.equal(verified.line.internalProofHash, insertedQuote[6]);

  await assert.rejects(
    store.verify({
      request: { ...verificationRequest, hash: "f".repeat(64) },
      actorRef: "actor:orders-test",
      correlationId: "00000000-0000-4000-8000-000000000008",
    }),
    { code: "PRICING_QUOTE_HASH_MISMATCH" },
  );
  await assert.rejects(
    store.verify({
      request: {
        ...verificationRequest,
        customerRef: "cus_00000000000000000000000002",
      },
      actorRef: "actor:orders-test",
      correlationId: "00000000-0000-4000-8000-000000000009",
    }),
    { code: "PRICING_QUOTE_SCOPE_MISMATCH" },
  );
  currentNowMs = new Date(insertedQuote[8]).getTime() + 1;
  await assert.rejects(
    store.verify({
      request: verificationRequest,
      actorRef: "actor:orders-test",
      correlationId: "00000000-0000-4000-8000-000000000010",
    }),
    { code: "PRICING_QUOTE_EXPIRED" },
  );
  assert.deepEqual(
    auditEvents.map(([action, quoteRef, , , reason]) => [
      action,
      quoteRef,
      reason,
    ]),
    [
      ["QuoteCreated", result.body.quoteRef, null],
      ["QuoteVerified", result.body.quoteRef, null],
      ["QuoteRejected", result.body.quoteRef, "PRICING_QUOTE_HASH_MISMATCH"],
      ["QuoteRejected", result.body.quoteRef, "PRICING_QUOTE_SCOPE_MISMATCH"],
      ["QuoteRejected", result.body.quoteRef, "PRICING_QUOTE_EXPIRED"],
    ],
  );
  assert.equal(statements.filter((sql) => sql === "COMMIT").length, 6);
  assert.equal(clockReads, 8);
  assert.equal(statements.includes("ROLLBACK"), false);
  assert.equal(statements.at(-1), "COMMIT");
  assert.equal(statements.includes("ROLLBACK"), false);
});

void test("PricingStore rejects invalid catalog create facts before acquiring a connection", async (t) => {
  let connectCalls = 0;
  const { database, statements } = mockDatabase(
    t,
    (sql) => assert.fail(`unexpected PricingStore query: ${sql}`),
    false,
    {},
    async (connection) => {
      connectCalls++;
      return connection;
    },
  );
  const store = new PricingStore(database);
  const line = {
    productRef: "prd_00000000000000000000000001",
    variantRef: "var_00000000000000000000000001",
    productDisplayName: "Coffee fixture",
    quantity: "2",
    unit: "piece",
    offerRef: "off_00000000000000000000000001",
    mappingRevision: "1",
    supplierUnitMinor: "100",
    catalogSnapshotRevision: "1",
  };
  const baseInput = {
    identity: {
      actorRef: "actor:pricing-test",
      scope: "a".repeat(64),
      key: "00000000-0000-4000-8000-000000000004",
    },
    requestHash: "b".repeat(64),
    correlationId: "00000000-0000-4000-8000-000000000005",
    policy: {
      policyVersionRef: "pvr_00000000000000000000000001",
      version: "1",
      currency: "RUB",
      markupBasisPoints: 3000,
      minimumMarginMinor: "0",
      quoteTtlSeconds: 900,
      quantityScale: 3,
      roundingMode: "CEILING",
    },
    customerRef: "cus_00000000000000000000000001",
    catalogSnapshotRevision: "1",
    lines: [line],
  };

  await assert.rejects(
    store.create({
      ...baseInput,
      catalogSnapshotRevision: "2",
    }),
    { code: "CATALOG_REVISION_CHANGED" },
  );
  await assert.rejects(store.create({ ...baseInput, lines: [line, line] }), {
    code: "PRICING_PERSISTED_FACTS_INVALID",
  });
  assert.equal(connectCalls, 0);
  assert.deepEqual(statements, []);
});

void test("PricingStore rejects a malformed persisted quote and rolls back", async (t) => {
  const { database, statements, releases } = mockDatabase(t, (sql, values) => {
    if (
      sql === "BEGIN" ||
      sql === "COMMIT" ||
      sql === "ROLLBACK" ||
      sql.startsWith("SET LOCAL ")
    )
      return undefined;
    if (sql.includes("FROM pricing.pricing_quotes q")) {
      assert.deepEqual(values, ["prq_00000000000000000000000001"]);
      return {
        rows: [{ quote_ref: "prq_malformed" }],
        rowCount: 1,
        command: "SELECT",
      };
    }
    assert.fail(`unexpected PricingStore query: ${sql}`);
  });

  await assert.rejects(
    new PricingStore(database).verify({
      request: { quoteRef: "prq_00000000000000000000000001" },
      actorRef: "actor:orders-test",
      correlationId: "00000000-0000-4000-8000-000000000006",
    }),
    { code: "PRICING_DATABASE_DECODE_ERROR" },
  );
  assert.equal(
    statements.some((sql) => sql.includes("FROM pricing.pricing_quotes q")),
    true,
  );
  assert.equal(statements.includes("COMMIT"), false);
  assert.equal(statements.at(-1), "ROLLBACK");
  assert.deepEqual(releases, [false]);
});

void test("PricingStore precheck keeps expired, conflicting and acquired records distinct", async (t) => {
  const identity = {
    actorRef: "actor:pricing-test",
    scope: "a".repeat(64),
    key: "00000000-0000-4000-8000-000000000004",
  };
  const requestHash = "b".repeat(64);
  const nowMs = 1_798_000_000_000;
  const baseRecord = {
    actor_ref: identity.actorRef,
    scope: identity.scope,
    idempotency_key: identity.key,
    request_hash: requestHash,
    lease_owner: "00000000-0000-4000-8000-000000000005",
    lease_until_ms: String(nowMs + 30_000),
    expires_at_ms: String(nowMs + 86_400_000),
    response_status: 201,
    response_body: { stored: true },
    resource_ref: "prq_00000000000000000000000001",
  };
  const records = [
    [],
    [
      {
        ...baseRecord,
        state: "Completed",
        lease_until_ms: String(nowMs - 2_000),
        expires_at_ms: String(nowMs - 1_000),
      },
    ],
    [{ ...baseRecord, state: "Completed", request_hash: "c".repeat(64) }],
    [
      {
        ...baseRecord,
        state: "Acquired",
        response_status: null,
        response_body: null,
        resource_ref: null,
      },
    ],
  ];
  let clockReads = 0;
  const { database, statements } = mockDatabase(t, (sql) => {
    if (
      sql === "BEGIN" ||
      sql === "COMMIT" ||
      sql === "ROLLBACK" ||
      sql.startsWith("SET LOCAL ")
    )
      return undefined;
    if (sql.includes('FROM "pricing"."pricing_idempotency_records"')) {
      const rows = records.shift();
      assert.ok(rows, "only the four requested records may be read");
      return { rows, rowCount: rows.length, command: "SELECT" };
    }
    if (sql.includes("date_trunc('milliseconds',transaction_timestamp())")) {
      clockReads++;
      return {
        rows: [
          {
            created_at: new Date(nowMs),
            expires_at: new Date(nowMs),
            now_ms: String(nowMs),
          },
        ],
        rowCount: 1,
        command: "SELECT",
      };
    }
    assert.fail(`unexpected PricingStore query: ${sql}`);
  });
  const store = new PricingStore(database);

  assert.deepEqual(await store.precheck(identity, requestHash), {
    kind: "not_retained",
  });
  assert.deepEqual(await store.precheck(identity, requestHash), {
    kind: "not_retained",
  });
  assert.deepEqual(await store.precheck(identity, requestHash), {
    kind: "conflict",
  });
  assert.deepEqual(await store.precheck(identity, requestHash), {
    kind: "in_progress",
  });
  assert.equal(records.length, 0);
  assert.equal(clockReads, 3, "an absent record needs no clock query");
  assert.equal(statements.filter((sql) => sql === "COMMIT").length, 4);
  assert.equal(statements.includes("ROLLBACK"), false);
});

void test("PricingStore commits not-found verification audit before rejecting", async (t) => {
  const correlationId = "00000000-0000-4000-8000-000000000006";
  const { database, statements, releases } = mockDatabase(t, (sql, values) => {
    if (
      sql === "BEGIN" ||
      sql === "COMMIT" ||
      sql === "ROLLBACK" ||
      sql.startsWith("SET LOCAL ")
    )
      return undefined;
    if (sql.includes("FROM pricing.pricing_quotes q"))
      return { rows: [], rowCount: 0, command: "SELECT" };
    if (sql.includes("date_trunc('milliseconds',transaction_timestamp())"))
      return {
        rows: [
          {
            created_at: new Date("2026-10-25T10:00:00.000Z"),
            expires_at: new Date("2026-10-25T10:00:00.000Z"),
            now_ms: "1792922400000",
          },
        ],
        rowCount: 1,
        command: "SELECT",
      };
    if (sql.includes("INSERT INTO pricing.pricing_audit_records")) {
      assert.deepEqual(values.slice(1), [
        "QuoteRejected",
        null,
        "actor:orders-test",
        correlationId,
        "PRICING_QUOTE_NOT_FOUND",
      ]);
      return { rows: [], rowCount: 1, command: "INSERT" };
    }
    assert.fail(`unexpected PricingStore query: ${sql}`);
  });

  await assert.rejects(
    new PricingStore(database).verify({
      request: {
        quoteRef: "prq_00000000000000000000000001",
        hash: "a".repeat(64),
        customerRef: "cus_00000000000000000000000001",
        quoteLineNumber: 1,
        productRef: "prd_00000000000000000000000001",
        variantRef: "var_00000000000000000000000001",
        quantity: "1.000",
      },
      actorRef: "actor:orders-test",
      correlationId,
    }),
    { code: "PRICING_QUOTE_NOT_FOUND" },
  );
  const quoteRead = statements.findIndex((sql) =>
    sql.includes("FROM pricing.pricing_quotes q"),
  );
  const auditWrite = statements.findIndex((sql) =>
    sql.includes("INSERT INTO pricing.pricing_audit_records"),
  );
  assert.ok(quoteRead >= 0 && auditWrite > quoteRead);
  assert.equal(statements.at(-1), "COMMIT");
  assert.deepEqual(releases, [false]);
});

void test("PricingStore rolls back a rejected verification when its audit cannot persist", async (t) => {
  let auditAttempts = 0;
  const { database, statements, releases } = mockDatabase(t, (sql) => {
    if (
      sql === "BEGIN" ||
      sql === "COMMIT" ||
      sql === "ROLLBACK" ||
      sql.startsWith("SET LOCAL ")
    )
      return undefined;
    if (sql.includes("FROM pricing.pricing_quotes q"))
      return { rows: [], rowCount: 0, command: "SELECT" };
    if (sql.includes("date_trunc('milliseconds',transaction_timestamp())"))
      return {
        rows: [
          {
            created_at: new Date("2026-10-25T10:00:00.000Z"),
            expires_at: new Date("2026-10-25T10:00:00.000Z"),
            now_ms: "1792922400000",
          },
        ],
        rowCount: 1,
        command: "SELECT",
      };
    if (sql.includes("INSERT INTO pricing.pricing_audit_records")) {
      auditAttempts += 1;
      throw new Error("synthetic audit storage failure");
    }
    assert.fail(`unexpected PricingStore query: ${sql}`);
  });

  await assert.rejects(
    new PricingStore(database).verify({
      request: {
        quoteRef: "prq_00000000000000000000000001",
        hash: "a".repeat(64),
        customerRef: "cus_00000000000000000000000001",
        quoteLineNumber: 1,
        productRef: "prd_00000000000000000000000001",
        variantRef: "var_00000000000000000000000001",
        quantity: "1.000",
      },
      actorRef: "actor:orders-test",
      correlationId: "00000000-0000-4000-8000-000000000006",
    }),
    (error) =>
      error instanceof DatabaseTransactionError &&
      error.code === "DB_CONNECTION_LOST",
  );
  assert.equal(auditAttempts, 1);
  assert.equal(statements.includes("COMMIT"), false);
  assert.equal(statements.at(-1), "ROLLBACK");
  assert.deepEqual(releases, [true]);
});

void test("database, HTTP and Outbox telemetry preserves owner parentage, bounded metrics and payload privacy", async (t) => {
  let traces = "";
  let exportedMetrics = "";
  const collector = createHttpServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString();
      if (request.url === "/v1/traces") traces += body;
      if (request.url === "/v1/metrics") exportedMetrics += body;
      response.writeHead(200, { "content-type": "application/x-protobuf" });
      response.end();
    });
  });
  let outgoingTraceparent;
  let forwardedCorrelation;
  let forwardedCausation;
  const service = createHttpServer((request, response) => {
    if (request.url?.startsWith("/failed")) response.writeHead(503);
    else {
      outgoingTraceparent = request.headers.traceparent;
      forwardedCorrelation = request.headers["x-correlation-id"];
      forwardedCausation = request.headers["x-causation-id"];
    }
    response.end("ok");
  });
  await Promise.all([
    new Promise((resolve) => collector.listen(0, "127.0.0.1", resolve)),
    new Promise((resolve) => service.listen(0, "127.0.0.1", resolve)),
  ]);
  const collectorAddress = collector.address();
  const serviceAddress = service.address();
  assert.ok(collectorAddress && typeof collectorAddress === "object");
  assert.ok(serviceAddress && typeof serviceAddress === "object");
  const telemetry = createTelemetryResource(
    {
      environment: "development",
      namespace: "coffee-platform",
      releaseDigest: "test",
      collector: { otlpEndpoint: `http://127.0.0.1:${collectorAddress.port}` },
      producer: {
        queueCapacity: 32,
        maxRecordBytes: 16_384,
        batchSize: 16,
        batchIntervalMs: 60_000,
        exportTimeoutMs: 1_000,
        diagnosticIntervalMs: 60_000,
        flushTimeoutMs: 2_000,
      },
    },
    "database-http-span-test",
    "test-token",
  );
  telemetry.start();
  const { database } = mockDatabase(t);
  await database.resource.start(new AbortController().signal);
  const statement = defineStatement(database, "SELECT 'db-private-canary'");
  const client = createHttpClient({
    origin: `http://127.0.0.1:${serviceAddress.port}`,
  });
  const ownerSpan = trace
    .getTracer("owner-test")
    .startSpan("orders.owner.operation");
  let transactionSpan;
  let failedTransactionSpan;
  let unknownTransactionSpan;
  let ownerSpanEnded = false;
  const endOwnerSpan = () => {
    if (!ownerSpanEnded) {
      ownerSpanEnded = true;
      ownerSpan.end();
    }
  };
  const callerTraceparent = `00-${ownerSpan.spanContext().traceId}-${ownerSpan.spanContext().spanId}-01`;
  let telemetryStopped = false;
  try {
    await otelContext.with(
      trace.setSpan(otelContext.active(), ownerSpan),
      async () => {
        await withTransaction(
          database,
          { mode: "interactive" },
          async (transaction) => {
            transactionSpan = trace.getSpan(otelContext.active());
            assert.ok(transactionSpan);
            assert.equal(
              transactionSpan.spanContext().traceId,
              ownerSpan.spanContext().traceId,
            );
            assert.notEqual(
              transactionSpan.spanContext().spanId,
              ownerSpan.spanContext().spanId,
            );
            await statement(transaction, []);
          },
        );
        assert.equal(transactionSpan.isRecording(), false);
        await assert.rejects(
          withTransaction(database, { mode: "background" }, async () => {
            failedTransactionSpan = trace.getSpan(otelContext.active());
            throw new Error("db-private-canary");
          }),
          /db-private-canary/u,
        );
        assert.equal(failedTransactionSpan.isRecording(), false);
        let rejectRollback;
        const {
          database: rollbackDatabase,
          connection: rollbackConnection,
          statements: rollbackStatements,
          releases: rollbackReleases,
        } = mockDatabase(t, (sql) =>
          sql === "ROLLBACK"
            ? new Promise((_, reject) => {
                rejectRollback = reject;
              })
            : undefined,
        );
        rollbackConnection.release = (destroy) => {
          rollbackReleases.push(destroy);
          assert.equal(destroy, true);
          rejectRollback?.(new Error("socket closed"));
        };
        await assert.rejects(
          otelContext.with(trace.setSpan(otelContext.active(), ownerSpan), () =>
            withTransaction(
              rollbackDatabase,
              { mode: "background" },
              async () => {
                unknownTransactionSpan = trace.getSpan(otelContext.active());
                throw new Error("rollback failed");
              },
            ),
          ),
          (error) =>
            error.code === "DB_ROLLBACK_FAILED" &&
            error.message === "DB_ROLLBACK_FAILED" &&
            error.previousCode === "DB_QUERY_FAILED",
        );
        assert.equal(unknownTransactionSpan.isRecording(), false);
        assert.equal(rollbackStatements.at(-1), "ROLLBACK");
        assert.equal(rollbackStatements.includes("COMMIT"), false);
        assert.deepEqual(rollbackReleases, [true]);
        const inboxProbe = {
          begin: async () => ({ kind: "acquired", record: {} }),
          markProcessed: async () => {},
        };
        const inboxMessage = {
          messageId: "trace-inbox",
          messageType: "TraceProbe",
          receivedAt: "2026-01-01T00:00:00Z",
          payloadHash: "a".repeat(64),
          payload: {},
        };
        let inboxSpan;
        let handlerChildSpan;
        const inboxResult = await consumeOnce(
          inboxProbe,
          {},
          inboxMessage,
          "trace-consumer",
          1_000,
          10_000,
          async () => {
            inboxSpan = trace.getSpan(otelContext.active());
            handlerChildSpan = trace
              .getTracer("inbox-child-probe")
              .startSpan("Inbox.handler.child");
            handlerChildSpan.end();
          },
          "2026-01-01T00:00:00Z",
        );
        assert.equal(inboxResult.kind, "processed");
        assert.equal(inboxSpan.name, "Inbox.consumeOnce");
        assert.equal(
          handlerChildSpan.parentSpanContext.spanId,
          inboxSpan.spanContext().spanId,
        );
        assert.equal(
          handlerChildSpan.spanContext().traceId,
          inboxSpan.spanContext().traceId,
        );
        assert.equal(trace.getSpan(otelContext.active()), ownerSpan);
        let failedInboxSpan;
        await assert.rejects(
          consumeOnce(
            inboxProbe,
            {},
            inboxMessage,
            "trace-consumer",
            1_000,
            10_000,
            async () => {
              failedInboxSpan = trace.getSpan(otelContext.active());
              throw new Error("inbox handler failed");
            },
            "2026-01-01T00:00:00Z",
          ),
          /inbox handler failed/u,
        );
        assert.equal(failedInboxSpan.name, "Inbox.consumeOnce");
        assert.equal(
          failedInboxSpan.parentSpanContext.spanId,
          ownerSpan.spanContext().spanId,
        );
        assert.equal(failedInboxSpan.isRecording(), false);
        assert.equal(trace.getSpan(otelContext.active()), ownerSpan);
        const response = await client.fetch(
          "/private/entity-secret?token=query-secret",
          {
            headers: {
              "x-correlation-id": "corr-safe",
              "x-causation-id": "cause-safe",
              traceparent: callerTraceparent,
            },
          },
        );
        assert.equal(response.status, 200);
        assert.equal(
          (await client.fetch("/failed/entity-secret?token=query-secret"))
            .status,
          503,
        );
      },
    );
    const { database: deliveryDatabase } = deliverySqlDatabase(t);
    const outbox = createSqlOutboxStore(deliveryDatabase);
    const messages = [
      outboxFixture("trace-relay-00", "trace-aggregate-00", 1),
      outboxFixture("trace-relay-01", "trace-aggregate-01", 1),
    ];
    messages[1].traceparent = `01-${"c".repeat(32)}-${"d".repeat(16)}-01`;
    messages[1].envelope.traceparent = messages[1].traceparent;
    for (const message of messages) {
      await withTransaction(
        deliveryDatabase,
        { mode: "background" },
        (transaction) => outbox.enqueue(transaction, message),
      );
      let deliverySpan;
      const delivered = await relayOutboxBatch(
        outbox,
        deliveryDatabase,
        async () => {
          deliverySpan = trace.getSpan(otelContext.active());
          assert.ok(deliverySpan);
          assert.equal(
            deliverySpan.spanContext().traceId,
            message.traceparent.slice(3, 35),
          );
          assert.notEqual(
            deliverySpan.spanContext().spanId,
            message.traceparent.slice(36, 52),
          );
          return { kind: "ack" };
        },
        {
          nowMs: 100,
          leaseOwner: message.messageId,
          policy: {
            leaseMs: 1000,
            sendTimeoutMs: 100,
            maxInFlight: 1,
            retry: { baseMs: 1, maxMs: 10, maxAttempts: 3 },
          },
        },
      );
      assert.equal(delivered.published, 1);
      assert.equal(deliverySpan.isRecording(), false);
    }
    endOwnerSpan();
    await client.close();
    await telemetry.stop(new AbortController().signal);
    telemetryStopped = true;
  } finally {
    endOwnerSpan();
    await client.close();
    await new Promise((resolve) => collector.close(resolve));
    await new Promise((resolve) => service.close(resolve));
    if (!telemetryStopped) await telemetry.stop(new AbortController().signal);
  }
  assert.ok(traces.includes("db.transaction"));
  assert.ok(traces.includes("HTTP GET"));
  assert.ok(traces.includes("Outbox.relay"));
  assert.ok(traces.includes("transaction.outcome"));
  assert.ok(traces.includes("unknown"));
  assert.ok(traces.includes("http_5xx"));
  assert.ok(traces.includes("UNEXPECTED"));
  assert.equal(traces.includes("db-private-canary"), false);
  assert.equal(traces.includes("entity-secret"), false);
  assert.equal(traces.includes("query-secret"), false);
  assert.equal(forwardedCorrelation, "corr-safe");
  assert.equal(forwardedCausation, "cause-safe");
  assert.equal(outgoingTraceparent, callerTraceparent);
  assert.ok(exportedMetrics.includes("db.client.connection.checkout_wait"));
  assert.ok(exportedMetrics.includes("db.client.connection.waiting"));
  assert.ok(exportedMetrics.includes("db.client.transaction.duration"));
  assert.ok(exportedMetrics.includes("db.client.transaction.count"));
  assert.ok(exportedMetrics.includes("transaction.outcome"));
  assert.ok(exportedMetrics.includes("unknown"));
});

void test("database opaque transaction: states, budgets, owner identity and terminal use", async (t) => {
  const { database, statements, releases, options } = mockDatabase(t);
  const query = defineStatement(database, "SELECT $1::integer AS value");
  let saved;
  assert.equal(
    await withTransaction(database, { mode: "interactive" }, async (tx) => {
      saved = tx;
      assert.equal(tx.state(), "Active");
      assert.deepEqual(Object.keys(tx), ["state"]);
      assert.equal(tx.query, undefined);
      await query(tx, [1]);
      return "known";
    }),
    "known",
  );
  assert.equal(saved.state(), "Committed");
  assert.ok(statements.includes("SET LOCAL statement_timeout = '100ms'"));
  assert.deepEqual(releases, [false]);
  await assert.rejects(query(saved, [2]), { code: "DB_INVALID_TRANSITION" });
  await assert.rejects(query({}, [2]), { code: "DB_INVALID_TRANSITION" });
  assert.throws(() => defineStatement(database, "COMMIT"), {
    code: "DB_INVALID_CONFIGURATION",
  });
  assert.throws(
    () =>
      createDatabase({
        owner: "test",
        database: "other",
        allowedDatabase: "owner",
      }),
    { code: "DB_INVALID_CONFIGURATION" },
  );
  for (const invalid of [
    { ...options, shutdownGraceMs: 0 },
    { ...options, ssl: "invalid" },
    { ...options, host: {} },
    { ...options, pool: { ...poolConfig, terminalTimeoutMs: 0 } },
    { ...options, pool: { ...poolConfig, maxWaiting: -1 } },
    { ...options, pool: { ...poolConfig, maxWaiting: 1.5 } },
    { ...options, pool: { ...poolConfig, maxWaiting: 101 } },
  ])
    assert.throws(() => createDatabase(invalid), {
      code: "DB_INVALID_CONFIGURATION",
    });
  const failure = new DatabaseTransactionError("DB_QUERY_FAILED", {
    correlationId: "safe",
  });
  await assert.rejects(
    withTransaction(database, { mode: "background" }, async (tx) => {
      saved = tx;
      throw failure;
    }),
    (error) => error === failure,
  );
  assert.equal(saved.state(), "RolledBack");
  assert.ok(statements.includes("SET LOCAL statement_timeout = '200ms'"));
  assert.deepEqual(releases, [false, false]);
});

void test("database COMMIT blackhole: finite unknown, destroy, no rollback, native promise settled on close", async (t) => {
  let rejectCommit;
  let commitError;
  const canary = "db-commit-private-canary";
  const { database, statements, releases, connection } = mockDatabase(
    t,
    (sql) =>
      sql === "COMMIT"
        ? commitError === undefined
          ? new Promise((_, reject) => {
              rejectCommit = reject;
            })
          : Promise.reject(commitError)
        : undefined,
  );
  connection.release = (destroy) => {
    releases.push(destroy);
    rejectCommit?.(new Error("socket closed"));
  };
  let saved;
  const started = performance.now();
  await assert.rejects(
    withTransaction(
      database,
      { mode: "interactive", correlationId: "corr" },
      async (tx) => {
        saved = tx;
      },
    ),
    (error) => {
      assert.equal(error.code, "TRANSACTION_OUTCOME_UNKNOWN");
      assert.deepEqual(error.metadata, { correlationId: "corr" });
      assert.equal(error.message, "TRANSACTION_OUTCOME_UNKNOWN");
      assert.equal(error.previousCode, "DB_QUERY_TIMEOUT");
      assert.equal(error.sqlState, undefined);
      assert.equal(error.cause, undefined);
      assert.equal(
        JSON.stringify({
          name: error.name,
          message: error.message,
          code: error.code,
          previousCode: error.previousCode,
          sqlState: error.sqlState,
        }).includes(canary),
        false,
      );
      return true;
    },
  );
  assert.ok(performance.now() - started < 500);
  assert.equal(saved.state(), "Unknown");
  assert.equal(statements.includes("ROLLBACK"), false);
  assert.deepEqual(releases, [true]);

  commitError = Object.assign(new Error(canary), { code: "23514" });
  await assert.rejects(
    withTransaction(database, { mode: "interactive" }, async () => {}),
    (error) => {
      assert.equal(error.code, "TRANSACTION_OUTCOME_UNKNOWN");
      assert.equal(error.previousCode, "DB_QUERY_FAILED");
      assert.equal(error.sqlState, "23514");
      assert.equal(error.message, "TRANSACTION_OUTCOME_UNKNOWN");
      assert.equal(error.cause, undefined);
      assert.equal(
        JSON.stringify({
          name: error.name,
          message: error.message,
          code: error.code,
          previousCode: error.previousCode,
          sqlState: error.sqlState,
        }).includes(canary),
        false,
      );
      return true;
    },
  );
  assert.equal(
    statements.filter((statement) => statement === "COMMIT").length,
    2,
  );
  assert.equal(statements.includes("ROLLBACK"), false);
  assert.deepEqual(releases, [true, true]);
  await database.resource.stop(new AbortController().signal);
  assert.equal(database.metrics().active, 0);
  assert.equal(database.metrics().pending, 0);
});

void test("database interruption rollback blackhole destroys in finite time", async (t) => {
  let rejectRollback;
  const { database, statements, releases, connection } = mockDatabase(
    t,
    (sql) =>
      sql === "ROLLBACK"
        ? new Promise((_, reject) => {
            rejectRollback = reject;
          })
        : undefined,
  );
  connection.release = (destroy) => {
    releases.push(destroy);
    rejectRollback?.(new Error("socket closed"));
  };
  const abort = new AbortController();
  const started = performance.now();
  await assert.rejects(
    withTransaction(
      database,
      { mode: "interactive", signal: abort.signal },
      async () => {
        abort.abort();
      },
    ),
    { code: "DB_ROLLBACK_FAILED" },
  );
  assert.ok(performance.now() - started < 500);
  assert.equal(statements.at(-1), "ROLLBACK");
  assert.equal(statements.includes("COMMIT"), false);
  assert.deepEqual(releases, [true]);
  await database.resource.stop(new AbortController().signal);
});

void test("database known COMMIT ignores disconnect after commit starts; pre-commit abort rolls back", async (t) => {
  const abort = new AbortController();
  const { database, statements, releases } = mockDatabase(t, (sql) => {
    if (sql === "COMMIT") {
      abort.abort();
      return { command: "COMMIT", rows: [], rowCount: 0 };
    }
    return undefined;
  });
  assert.equal(
    await withTransaction(
      database,
      { mode: "interactive", signal: abort.signal },
      async () => "accepted",
    ),
    "accepted",
  );
  assert.equal(statements.includes("ROLLBACK"), false);
  assert.deepEqual(releases, [false]);
  const pre = new AbortController();
  await assert.rejects(
    withTransaction(
      database,
      { mode: "interactive", signal: pre.signal },
      async () => {
        pre.abort();
      },
    ),
    { code: "DB_INTERRUPTED" },
  );
  assert.equal(statements.at(-1), "ROLLBACK");
  assert.deepEqual(releases, [false, false]);
});

void test("database caught SQL failure + COMMIT ROLLBACK tag is never a known commit", async (t) => {
  const { database, releases } = mockDatabase(t, (sql) => {
    if (sql === "SELECT 1/0")
      throw Object.assign(new Error("sensitive parameters"), { code: "22012" });
    if (sql === "COMMIT") return { command: "ROLLBACK", rows: [], rowCount: 0 };
    return undefined;
  });
  const query = defineStatement(database, "SELECT 1/0");
  let saved;
  await assert.rejects(
    withTransaction(database, { mode: "interactive" }, async (tx) => {
      saved = tx;
      await assert.rejects(query(tx, []), {
        code: "DB_QUERY_FAILED",
        sqlState: "22012",
        message: "DB_QUERY_FAILED",
      });
      return "must not escape";
    }),
    { code: "DB_TRANSACTION_ROLLED_BACK" },
  );
  assert.equal(saved.state(), "RolledBack");
  assert.deepEqual(releases, [false]);
});

void test("database classifies query timeout and broken connections without leaking SQL", async (t) => {
  let state = "57014";
  const { database, releases } = mockDatabase(t, (sql) => {
    if (sql.startsWith("SELECT $1"))
      throw Object.assign(new Error("password/payload"), { code: state });
    return undefined;
  });
  const query = defineStatement(database, "SELECT $1");
  await assert.rejects(
    withTransaction(database, { mode: "interactive" }, (tx) =>
      query(tx, ["private"]),
    ),
    { code: "DB_QUERY_TIMEOUT", message: "DB_QUERY_TIMEOUT" },
  );
  state = "ECONNRESET";
  await assert.rejects(
    withTransaction(database, { mode: "interactive" }, (tx) =>
      query(tx, ["private"]),
    ),
    { code: "DB_CONNECTION_LOST", message: "DB_CONNECTION_LOST" },
  );
  assert.deepEqual(releases, [false, true]);
});

void test("database pool cap preserves healthy readiness and recovers admission", async (t) => {
  const { database } = mockDatabase(t);
  assert.equal(
    await database.readiness.check(new AbortController().signal),
    true,
  );
  let releaseWork;
  const work = new Promise((resolve) => {
    releaseWork = resolve;
  });
  const first = withTransaction(
    database,
    { mode: "interactive" },
    async () => work,
  );
  const second = withTransaction(
    database,
    { mode: "interactive" },
    async () => work,
  );
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    withTransaction(database, { mode: "interactive" }, async () => {}),
    { code: "DB_POOL_EXHAUSTED" },
  );
  assert.equal(database.metrics().saturationTotal, 1);
  assert.equal(
    await database.readiness.check(new AbortController().signal),
    true,
  );
  releaseWork();
  await Promise.all([first, second]);
  await withTransaction(database, { mode: "interactive" }, async () => {});
  assert.equal(database.metrics().active, 0);
});

void test("database bounded checkout queue reserves slots FIFO, keeps health, and removes canceled or expired waiters", async (t) => {
  const waitingSamples = [];
  t.mock.method(metrics, "getMeter", () => ({
    createGauge: (name) => ({
      record: (value, attributes) =>
        waitingSamples.push({ name, value, attributes }),
    }),
    createHistogram: () => ({ record() {} }),
    createCounter: () => ({ add() {} }),
  }));
  const { database } = mockDatabase(t, () => undefined, false, {
    max: 1,
    maxWaiting: 2,
    checkoutTimeoutMs: 250,
    transactionTimeoutMs: 500,
  });
  assert.equal(
    await database.readiness.check(new AbortController().signal),
    true,
  );
  let finishFirst, finishSecond;
  const firstGate = new Promise((resolve) => {
    finishFirst = resolve;
  });
  const secondGate = new Promise((resolve) => {
    finishSecond = resolve;
  });
  let secondEntered, thirdEntered;
  const secondStarted = new Promise((resolve) => {
    secondEntered = resolve;
  });
  const thirdStarted = new Promise((resolve) => {
    thirdEntered = resolve;
  });
  const entered = [];
  const first = withTransaction(database, { mode: "interactive" }, async () => {
    entered.push("first");
    await firstGate;
  });
  await new Promise((resolve) => setImmediate(resolve));
  const liveCaller = new AbortController();
  const second = withTransaction(
    database,
    { mode: "interactive", signal: liveCaller.signal },
    async () => {
      entered.push("second");
      secondEntered();
      await secondGate;
    },
  );
  const third = withTransaction(database, { mode: "interactive" }, async () => {
    entered.push("third");
    thirdEntered();
  });
  assert.equal(database.metrics().waiting, 2);
  assert.deepEqual(waitingSamples.at(-1), {
    name: "db.client.connection.waiting",
    value: 2,
    attributes: { "db.owner": "other" },
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(liveCaller.signal.aborted, false);
  assert.equal(
    database.metrics().waiting,
    2,
    "a live caller may wait beyond checkoutTimeoutMs for a FIFO slot",
  );
  await assert.rejects(
    withTransaction(database, { mode: "interactive" }, async () => {}),
    { code: "DB_POOL_EXHAUSTED" },
  );
  assert.equal(database.metrics().saturationTotal, 1);
  assert.equal(
    await database.readiness.check(new AbortController().signal),
    true,
  );
  assert.equal(database.metrics().waiting, 2);
  finishFirst();
  await secondStarted;
  assert.deepEqual(entered, ["first", "second"]);
  assert.equal(database.metrics().waiting, 1);
  assert.equal(waitingSamples.at(-1).value, 1);
  finishSecond();
  await thirdStarted;
  await Promise.all([first, second, third]);
  assert.deepEqual(entered, ["first", "second", "third"]);

  const { database: boundedDatabase } = mockDatabase(
    t,
    () => undefined,
    false,
    { max: 1, maxWaiting: 2, checkoutTimeoutMs: 50 },
  );
  let finishBlocker;
  const blockerGate = new Promise((resolve) => {
    finishBlocker = resolve;
  });
  const blocker = withTransaction(
    boundedDatabase,
    { mode: "interactive" },
    async () => blockerGate,
  );
  await new Promise((resolve) => setImmediate(resolve));
  const abort = new AbortController();
  const canceled = withTransaction(
    boundedDatabase,
    { mode: "interactive", signal: abort.signal },
    async () => {},
  );
  abort.abort();
  await assert.rejects(canceled, { code: "DB_INTERRUPTED" });
  assert.equal(boundedDatabase.metrics().waiting, 0);
  assert.equal(boundedDatabase.metrics().saturationTotal, 0);
  const timed = withTransaction(
    boundedDatabase,
    { mode: "interactive", signal: AbortSignal.timeout(75) },
    async () => {},
  );
  await assert.rejects(timed, { code: "DB_INTERRUPTED" });
  assert.equal(boundedDatabase.metrics().waiting, 0);
  assert.equal(boundedDatabase.metrics().saturationTotal, 1);
  finishBlocker();
  await blocker;
  assert.equal(waitingSamples.at(-1).value, 0);
});

void test("database checkout timeout starts after FIFO slot dispatch", async (t) => {
  let connectCalls = 0,
    lateConnect;
  const lateConnection = new Promise((resolve) => {
    lateConnect = resolve;
  });
  const { database, releases, connection } = mockDatabase(
    t,
    () => undefined,
    false,
    {
      max: 1,
      maxWaiting: 1,
      checkoutTimeoutMs: 250,
      transactionTimeoutMs: 500,
    },
    async (client) => {
      if (++connectCalls === 2) {
        await new Promise((resolve) => setTimeout(resolve, 350));
        lateConnect();
      }
      return client;
    },
  );
  let finishFirst;
  const firstGate = new Promise((resolve) => {
    finishFirst = resolve;
  });
  const first = withTransaction(
    database,
    { mode: "interactive" },
    async () => firstGate,
  );
  await new Promise((resolve) => setImmediate(resolve));
  const second = withTransaction(
    database,
    { mode: "interactive", signal: AbortSignal.timeout(5_000) },
    async () => {},
  );
  assert.equal(database.metrics().waiting, 1);
  finishFirst();
  await first;
  await assert.rejects(second, { code: "DB_POOL_EXHAUSTED" });
  await lateConnection;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(connectCalls, 2);
  assert.equal(database.metrics().waiting, 0);
  assert.equal(database.metrics().active, 0);
  assert.deepEqual(releases, [false, true]);
  assert.equal(connection.listenerCount("error"), 0);
});

void test("database shutdown rejects queued checkouts without acquiring a connection", async (t) => {
  const { database } = mockDatabase(t, () => undefined, false, {
    max: 1,
    maxWaiting: 1,
    checkoutTimeoutMs: 100,
  });
  let finishBlocker;
  const blockerGate = new Promise((resolve) => {
    finishBlocker = resolve;
  });
  const blocker = withTransaction(
    database,
    { mode: "interactive" },
    async () => blockerGate,
  );
  await new Promise((resolve) => setImmediate(resolve));
  const waiting = withTransaction(
    database,
    { mode: "interactive" },
    async () => {},
  );
  assert.equal(database.metrics().waiting, 1);
  const stopping = database.resource.stop(AbortSignal.timeout(500));
  await assert.rejects(waiting, { code: "DB_STOPPED" });
  assert.equal(database.metrics().waiting, 0);
  finishBlocker();
  await Promise.allSettled([blocker]);
  await stopping;
});

void test("database non-cooperative callback remains owned for runtime fail-stop", async (t) => {
  const { database } = mockDatabase(t);
  let settle;
  const never = new Promise((resolve) => {
    settle = resolve;
  });
  const abort = new AbortController();
  const work = withTransaction(
    database,
    { mode: "interactive", signal: abort.signal },
    async () => {
      abort.abort();
      return never;
    },
  );
  await assert.rejects(work, { code: "DB_INTERRUPTED" });
  assert.equal(database.metrics().active, 0);
  assert.equal(database.metrics().pending, 1);
  const app = await createRuntime({
    name: "db-proof",
    host: "127.0.0.1",
    port: 0,
    shutdownGraceMs: 40,
    resources: [database.resource],
  });
  await app.runtimeController.start();
  const result = await app.runtimeController.closeRuntime();
  assert.equal(result.status, "fail-stop");
  assert.ok(result.pending.includes("stop:database"));
  settle();
  await database.resource.stop(new AbortController().signal);
  assert.equal(database.metrics().pending, 0);
});

const kafkaEnvelope = (messageId = "m1") => ({
  envelopeVersion: "1",
  messageId,
  messageType: "OrderConfirmed",
  occurredAt: "2026-01-01T00:00:00Z",
  producer: "orders-service",
  correlationId: "c1",
  causationId: null,
  traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
  aggregate: { type: "Order", ref: "ord_1", version: "1" },
  payload: { x: 1 },
});
const kafkaRecord = (partition = 0, offset = "0") => ({
  topic: "coffee.orders.lifecycle.v1",
  partition,
  offset,
  key: "ord_1",
  value: kafkaEnvelope(),
  headers: {},
});
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

void test("Kafka partition workers preserve offset order, one handler per partition and a shared bounded cap", async () => {
  const seen = [],
    gates = [],
    active = new Map();
  let total = 0,
    peak = 0;
  const workers = new PartitionWorkers(
    { maxPartitions: 2, maxInFlight: 2, queueCapacity: 4 },
    async (record) => {
      assert.equal(active.get(record.partition) ?? 0, 0);
      active.set(record.partition, 1);
      peak = Math.max(peak, ++total);
      seen.push([record.partition, record.offset]);
      await new Promise((resolve) => gates.push(resolve));
      total--;
      active.set(record.partition, 0);
    },
    (error) => {
      throw error;
    },
  );
  workers.assign([
    { topic: kafkaRecord().topic, partition: 0 },
    { topic: kafkaRecord().topic, partition: 1 },
  ]);
  workers.enqueue(kafkaRecord(0, "0"));
  workers.enqueue(kafkaRecord(0, "1"));
  workers.enqueue(kafkaRecord(1, "0"));
  workers.enqueue(kafkaRecord(1, "1"));
  assert.throws(() => workers.enqueue(kafkaRecord(1, "2")), {
    code: "KAFKA_QUEUE_FULL",
  });
  await nextTurn();
  assert.deepEqual(seen, [
    [0, "0"],
    [1, "0"],
  ]);
  assert.throws(() => workers.resetAssignment(), { code: "KAFKA_REVOKED" });
  gates[0]();
  await nextTurn();
  assert.deepEqual(seen, [
    [0, "0"],
    [1, "0"],
    [0, "1"],
  ]);
  gates[1]();
  await nextTurn();
  assert.deepEqual(seen.at(-1), [1, "1"]);
  gates[2]();
  gates[3]();
  await nextTurn();
  assert.equal(peak, 2);
  assert.equal(workers.metrics().saturationTotal, 1);
  assert.throws(() => workers.enqueue(kafkaRecord(0, "0")), {
    code: "KAFKA_ENVELOPE_INVALID",
  });
  await workers.drain();
  assert.equal(workers.metrics().pending, 0);
  workers.resetAssignment();
  workers.assign([{ topic: kafkaRecord().topic, partition: 0 }]);
  workers.enqueue(kafkaRecord(0, "0"));
  await nextTurn();
  assert.deepEqual(seen.at(-1), [0, "0"]);
  gates[4]();
  await workers.drain();
});

void test("Kafka partition failure freezes its queue; revoke stops intake and non-cooperative work forces fail-stop", async () => {
  let release;
  const failures = [];
  const workers = new PartitionWorkers(
    { maxPartitions: 1, maxInFlight: 1, queueCapacity: 2 },
    async () =>
      new Promise((resolve) => {
        release = resolve;
      }),
    (error) => failures.push(error),
  );
  workers.assign([{ topic: kafkaRecord().topic, partition: 0 }]);
  workers.enqueue(kafkaRecord());
  workers.enqueue(kafkaRecord(0, "1"));
  await nextTurn();
  const app = await createRuntime({
    name: "kafka-proof",
    host: "127.0.0.1",
    port: 0,
    shutdownGraceMs: 40,
    resources: [
      {
        name: "kafka",
        stop: () => workers.drain(),
        destroy: () => workers.abort(),
      },
    ],
  });
  await app.runtimeController.start();
  const outcome = await app.runtimeController.closeRuntime();
  assert.equal(outcome.status, "fail-stop");
  assert.ok(outcome.pending.includes("stop:kafka"));
  assert.throws(() => workers.enqueue(kafkaRecord(0, "2")), {
    code: "KAFKA_REVOKED",
  });
  release();
  await workers.drain();
  assert.equal(workers.metrics().pending, 0);
  assert.equal(failures.length, 0);
  assert.throws(() => workers.resetAssignment(), { code: "KAFKA_REVOKED" });
  let runs = 0;
  const failed = new PartitionWorkers(
    { maxPartitions: 1, maxInFlight: 1, queueCapacity: 2 },
    async () => {
      runs++;
      throw Error("owner failure");
    },
    (e) => failures.push(e),
  );
  failed.assign([{ topic: kafkaRecord().topic, partition: 0 }]);
  failed.enqueue(kafkaRecord());
  failed.enqueue(kafkaRecord(0, "1"));
  await nextTurn();
  assert.equal(runs, 1);
  assert.equal(failures.length, 1);
  assert.equal(failed.metrics().queued, 0);
  await failed.drain();
});

void test("Kafka partition workers share a bounded maxInFlight budget across groups", async () => {
  const gates = [];
  const seen = [];
  const budget = {
    active: 0,
    owned: 0,
    maxInFlight: 4,
    queueCapacity: 8,
    wake: new Set(),
  };
  const process = async (record) => {
    seen.push(record.partition);
    await new Promise((resolve) => gates.push(resolve));
  };
  const onFailure = (error) => {
    throw error;
  };
  const first = new PartitionWorkers(
    { maxPartitions: 2, maxInFlight: 4, queueCapacity: 8 },
    process,
    onFailure,
    budget,
  );
  const second = new PartitionWorkers(
    { maxPartitions: 2, maxInFlight: 4, queueCapacity: 8 },
    process,
    onFailure,
    budget,
  );
  first.assign([
    { topic: kafkaRecord().topic, partition: 0 },
    { topic: kafkaRecord().topic, partition: 1 },
  ]);
  second.assign([
    { topic: kafkaRecord().topic, partition: 2 },
    { topic: kafkaRecord().topic, partition: 3 },
  ]);
  first.enqueue(kafkaRecord(0));
  first.enqueue(kafkaRecord(1));
  second.enqueue(kafkaRecord(2));
  second.enqueue(kafkaRecord(3));
  // The two workers share four active slots; later records remain queued until a slot is released.
  first.enqueue(kafkaRecord(0, "1"));
  first.enqueue(kafkaRecord(1, "1"));
  second.enqueue(kafkaRecord(2, "1"));
  second.enqueue(kafkaRecord(3, "1"));
  await nextTurn();
  assert.deepEqual(
    seen.sort((left, right) => left - right),
    [0, 1, 2, 3],
  );
  assert.equal(budget.active, 4);
  assert.equal(first.metrics().queued + second.metrics().queued, 4);
  for (const release of gates.splice(0)) release();
  await nextTurn();
  for (const release of gates.splice(0)) release();
  await Promise.all([first.drain(), second.drain()]);
  assert.deepEqual(
    seen.sort((left, right) => left - right),
    [0, 0, 1, 1, 2, 2, 3, 3],
  );
});

void test("Kafka decode precedes Inbox; only known DB commit permits offset, duplicate/conflict skip owner", async (t) => {
  const order = [];
  let decision = "acquired",
    tag = "COMMIT",
    commits = 0;
  const { database } = mockDatabase(t, (sql) => {
    if (sql === "COMMIT") {
      order.push("db-commit");
      return { rows: [], rowCount: 0, command: tag };
    }
  });
  const binding = {
    processing: "durable",
    database,
    inbox: {
      begin: async (_tx, message) => {
        const envelope = {
          ...kafkaEnvelope(),
          traceparent: message.payload.traceparent,
        };
        assert.deepEqual(message.payload, envelope);
        assert.equal(message.payloadHash, canonicalRequestHash(envelope));
        assert.notEqual(
          message.payloadHash,
          canonicalRequestHash(envelope.payload),
        );
        order.push("inbox");
        return { kind: decision };
      },
      markProcessed: async () => {
        order.push("processed");
      },
      quarantineRecord: async () => {
        order.push("quarantine");
        return "created";
      },
    },
    decode: (value) => {
      order.push("decode");
      return parseEnvelope(value, (p) => p);
    },
    handle: async (tx) => {
      assert.equal(tx.state(), "Active");
      order.push("owner+outbox");
    },
  };
  const options = {
    runtime: "orders-aroma-preparation",
    groupId: "orders-aroma-preparation-v1",
    topics: [kafkaRecord().topic],
    binding,
    leaseMs: 30000,
    maxMessageBytes: 1048576,
    signal: new AbortController().signal,
    commit: async () => {
      commits++;
      order.push("offset");
    },
  };
  const futureVersionEnvelope = {
    ...kafkaEnvelope(),
    traceparent: `01-${"a".repeat(32)}-${"b".repeat(16)}-01`,
  };
  await processKafkaRecord(
    { ...kafkaRecord(), value: futureVersionEnvelope },
    options,
  );
  assert.deepEqual(order, [
    "decode",
    "inbox",
    "owner+outbox",
    "processed",
    "db-commit",
    "offset",
  ]);
  assert.equal(order.includes("quarantine"), false);
  order.length = 0;
  await processKafkaRecord(kafkaRecord(), options);
  assert.deepEqual(order, [
    "decode",
    "inbox",
    "owner+outbox",
    "processed",
    "db-commit",
    "offset",
  ]);
  for (const kind of ["duplicate", "conflict"]) {
    decision = kind;
    order.length = 0;
    await processKafkaRecord(kafkaRecord(), options);
    assert.ok(!order.includes("owner+outbox"));
    assert.equal(order.includes("quarantine"), kind === "conflict");
  }
  order.length = 0;
  await processKafkaRecord({ ...kafkaRecord(), value: "broken JSON" }, options);
  assert.ok(!order.includes("inbox"));
  assert.ok(order.includes("quarantine"));
  const malformedUtf8 = Uint8Array.from([
    ...Buffer.from(
      '{"envelopeVersion":"1","messageId":"m1","messageType":"OrderConfirmed","occurredAt":"2026-01-01T00:00:00Z","producer":"orders-service","correlationId":"c1","causationId":null,"traceparent":"00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01","aggregate":{"type":"Order","ref":"ord_1","version":"1"},"payload":"',
    ),
    0xff,
    ...Buffer.from('"}'),
  ]);
  order.length = 0;
  await processKafkaRecord({ ...kafkaRecord(), value: malformedUtf8 }, options);
  assert.ok(!order.includes("inbox"));
  assert.ok(order.includes("quarantine"));
  for (const messageId of [null, "wrong-id"]) {
    order.length = 0;
    await processKafkaRecord(
      { ...kafkaRecord(), headers: { messageId } },
      options,
    );
    assert.deepEqual(order, ["decode", "quarantine", "db-commit", "offset"]);
  }
  const quarantine = t.mock.method(
    binding.inbox,
    "quarantineRecord",
    async () => {
      throw Error("quarantine unavailable");
    },
  );
  const beforeQuarantineFailure = commits;
  await assert.rejects(
    processKafkaRecord({ ...kafkaRecord(), value: "broken JSON" }, options),
  );
  assert.equal(commits, beforeQuarantineFailure);
  quarantine.mock.restore();
  decision = "acquired";
  tag = "ROLLBACK";
  const before = commits;
  await assert.rejects(processKafkaRecord(kafkaRecord(), options), {
    code: "DB_TRANSACTION_ROLLED_BACK",
  });
  assert.equal(commits, before);
  tag = "COMMIT";
  decision = "in_progress";
  await assert.rejects(processKafkaRecord(kafkaRecord(), options), {
    code: "KAFKA_HANDLER_FAILED",
  });
  assert.equal(commits, before);
  decision = "acquired";
  await assert.rejects(
    processKafkaRecord(kafkaRecord(), {
      ...options,
      commit: async () => {
        throw Error("lost ack");
      },
    }),
    { code: "OFFSET_COMMIT_OUTCOME_UNKNOWN" },
  );
  await database.resource.stop(new AbortController().signal);
});

void test("Kafka directional config and realtime bypass fail closed before native connect", async () => {
  const config = parsePlatformConfig(
    parseYaml(
      readFileSync(
        new URL("../../../config/platform.yaml", import.meta.url),
        "utf8",
      ),
    ),
  );
  const options = {
    runtime: "orders-service",
    config: config.kafka,
    service: config.services["orders-service"].kafka,
    credentials: { username: "u", password: "p", caPem: "test-ca" },
  };
  assert.equal(
    validateKafkaRuntimeConfig(options).config.autoTopicCreation,
    false,
  );
  assert.deepEqual(
    validateKafkaRuntimeConfig({
      ...options,
      credentials: { username: "u", password: "p" },
    }).credentials,
    { username: "u", password: "p" },
  );
  assert.throws(
    () =>
      validateKafkaRuntimeConfig({
        ...options,
        credentials: { username: "u", password: "p", caPem: "" },
      }),
    { code: "KAFKA_CONFIG_INVALID" },
  );
  assert.throws(
    () =>
      validateKafkaRuntimeConfig({
        ...options,
        config: { ...config.kafka, autoTopicCreation: true },
      }),
    { code: "KAFKA_CONFIG_INVALID" },
  );
  assert.throws(
    () =>
      validateKafkaRuntimeConfig({
        ...options,
        service: {
          producers: [],
          consumers: [
            {
              groupId: "g",
              topics: [kafkaRecord().topic],
              processing: "realtime",
            },
          ],
        },
      }),
    { code: "KAFKA_CONFIG_INVALID" },
  );
  let runs = 0;
  await assert.rejects(
    processKafkaRecord(kafkaRecord(), {
      runtime: "orders-service",
      groupId: "g",
      topics: [kafkaRecord().topic],
      binding: {
        processing: "realtime",
        decode: (v) => v,
        enqueue: async () => {
          runs++;
        },
      },
      signal: new AbortController().signal,
      leaseMs: 30000,
      maxMessageBytes: 10000,
      commit: async () => {
        runs++;
      },
    }),
    { code: "KAFKA_CONFIG_INVALID" },
  );
  assert.equal(runs, 0);
  const runtime = createKafkaRuntime(options);
  await assert.rejects(runtime.relay({}, {}), { code: "KAFKA_STOPPED" });
  runtime.resource.destroy();
});

void test(
  "native Kafka relay publishes only ACKs and recovers overlap and queue saturation",
  { timeout: 10_000 },
  async (t) => {
    const config = parsePlatformConfig(
      parseYaml(
        readFileSync(
          new URL("../../../config/platform.yaml", import.meta.url),
          "utf8",
        ),
      ),
    );
    const topic = "coffee.orders.lifecycle.v1";
    const outcomes = new Map([
      ["native-ack", "ack"],
      ["native-unknown", "error"],
      ["native-overlap", "hold"],
      ["native-after-overlap", "ack"],
      ["native-queue", "queue-full-once"],
    ]);
    const produced = new Set();
    let releaseHeld = false;
    const overlapProduce = Promise.withResolvers();
    class Producer extends EventEmitter {
      connected = false;
      pending = [];
      connect(_options, callback) {
        this.connected = true;
        callback(null);
      }
      isConnected() {
        return this.connected;
      }
      produce(producedTopic, _partition, bytes, _key, _timestamp, opaque) {
        const envelope = JSON.parse(Buffer.from(bytes).toString("utf8"));
        const id = envelope.messageId;
        const configuredMode = outcomes.get(id) ?? "ack";
        const mode =
          configuredMode === "queue-full-once" && produced.has(id)
            ? "ack"
            : configuredMode;
        if (configuredMode === "queue-full-once" && !produced.has(id)) {
          produced.add(id);
          throw Object.assign(new Error(), { code: -184 });
        }
        produced.add(id);
        if (id === "native-overlap") overlapProduce.resolve();
        this.pending.push({ topic: producedTopic, opaque, id, mode });
      }
      poll() {
        const ready = [];
        this.pending = this.pending.filter((item) => {
          if (item.mode === "hold" && !releaseHeld) return true;
          ready.push(item);
          return false;
        });
        for (const item of ready)
          this.emit(
            "delivery-report",
            item.mode === "error" ? { code: 1234 } : null,
            { topic: item.topic, partition: 0, offset: 1, opaque: item.opaque },
          );
      }
      disconnect(callback) {
        this.connected = false;
        callback(null);
      }
    }
    const nativeKey = Symbol.for("coffee.platform-testing.native-relay");
    globalThis[nativeKey] = { Producer, KafkaConsumer: class {} };
    const url = `data:text/javascript,${encodeURIComponent('export const RdKafka=globalThis[Symbol.for("coffee.platform-testing.native-relay")];export default {RdKafka};')}`;
    const hook = registerHooks({
      resolve(specifier, context, next) {
        return specifier === "@confluentinc/kafka-javascript"
          ? { url, shortCircuit: true }
          : next(specifier, context);
      },
    });

    const { database, snapshot } = deliverySqlDatabase(t);
    const store = createSqlOutboxStore(database);
    const enqueue = async (id) => {
      const message = outboxFixture(id, `aggregate-${id}`, 1);
      message.topic = topic;
      await withTransaction(database, { mode: "background" }, (transaction) =>
        store.enqueue(transaction, message),
      );
    };
    const options = {
      runtime: "orders-service",
      config: config.kafka,
      service: config.services["orders-service"].kafka,
      credentials: { username: "test-user", password: "test-password" },
    };
    const runtime = createKafkaRuntime(options);
    let started = false;
    t.after(async () => {
      try {
        if (started) await runtime.resource.stop(AbortSignal.timeout(5000));
        else runtime.resource.destroy();
      } catch (error) {
        runtime.resource.destroy();
        throw error;
      } finally {
        hook.deregister();
        delete globalThis[nativeKey];
      }
    });
    await runtime.resource.start(AbortSignal.timeout(5000));
    started = true;

    await enqueue("native-ack");
    assert.deepEqual(await runtime.relay(store, database), {
      claimed: 1,
      published: 1,
      failed: 0,
      unknown: 0,
      quarantined: 0,
    });
    assert.equal(snapshot().outbox.get("native-ack").state, "Published");

    await enqueue("native-unknown");
    assert.deepEqual(await runtime.relay(store, database), {
      claimed: 1,
      published: 0,
      failed: 0,
      unknown: 1,
      quarantined: 0,
    });
    assert.equal(
      snapshot().outbox.get("native-unknown").state,
      "Publishing",
      "a delivery error is uncertain and must not be reported Published",
    );
    assert.notEqual(snapshot().outbox.get("native-unknown").state, "Published");

    await enqueue("native-overlap");
    const overlapping = runtime.relay(store, database);
    await overlapProduce.promise;
    await assert.rejects(runtime.relay(store, database), {
      code: "KAFKA_QUEUE_FULL",
    });
    releaseHeld = true;
    assert.deepEqual(await overlapping, {
      claimed: 1,
      published: 1,
      failed: 0,
      unknown: 0,
      quarantined: 0,
    });
    await enqueue("native-after-overlap");
    assert.deepEqual(
      await runtime.relay(store, database),
      { claimed: 1, published: 1, failed: 0, unknown: 0, quarantined: 0 },
      "relay latch clears after the in-flight send settles",
    );
    assert.equal(
      snapshot().outbox.get("native-after-overlap").state,
      "Published",
    );

    await enqueue("native-queue");
    assert.deepEqual(await runtime.relay(store, database), {
      claimed: 1,
      published: 0,
      failed: 1,
      unknown: 0,
      quarantined: 0,
    });
    assert.equal(
      snapshot().outbox.get("native-queue").state,
      "Pending",
      "native queue saturation remains retryable",
    );
    await new Promise((resolve) =>
      setTimeout(resolve, config.kafka.delivery.retry.baseMs + 50),
    );
    assert.deepEqual(await runtime.relay(store, database), {
      claimed: 1,
      published: 1,
      failed: 0,
      unknown: 0,
      quarantined: 0,
    });
    assert.equal(snapshot().outbox.get("native-queue").state, "Published");
  },
);

void test("testing clock is explicit and deterministic", () => {
  const clock = createTestClock(100);
  clock.advanceMs(50);
  assert.equal(clock.nowMs(), 150);
  clock.setMs(0);
  assert.equal(clock.nowMs(), 0);
});

function idempotencyDatabase(t) {
  let durable = new Map(),
    working,
    aborted = false;
  return mockDatabase(t, (sql, values) => {
    if (sql === "BEGIN") {
      working = structuredClone(durable);
      aborted = false;
    }
    if (sql === "COMMIT") {
      if (!aborted) durable = structuredClone(working);
      return {
        command: aborted ? "ROLLBACK" : "COMMIT",
        rows: [],
        rowCount: 0,
      };
    }
    if (sql === "SELECT 1/0") {
      aborted = true;
      throw Object.assign(new Error("division"), { code: "22012" });
    }
    if (!sql.includes("idempotency_records")) return undefined;
    const key = JSON.stringify(values.slice(0, 3));
    const row = working.get(key);
    if (sql.startsWith("INSERT")) {
      if (row) return { rows: [], rowCount: 0 };
      working.set(key, {
        actor_ref: values[0],
        scope: values[1],
        idempotency_key: values[2],
        request_hash: values[3],
        state: "Acquired",
        lease_owner: values[4],
        lease_until_ms: values[5],
        expires_at_ms: values[7],
        response_status: null,
        response_body: null,
        resource_ref: null,
      });
      return { rows: [{ idempotency_key: values[2] }], rowCount: 1 };
    }
    if (sql.startsWith("SELECT"))
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    if (
      sql.startsWith("UPDATE") &&
      row?.lease_owner === values[3] &&
      row.state === "Acquired"
    ) {
      Object.assign(row, {
        state: "Completed",
        response_status: values[4],
        response_body: JSON.parse(values[5]),
        resource_ref: values[6],
      });
      return { rows: [{ idempotency_key: values[2] }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
}

function cloneDeliveryState(state) {
  const cloneRows = (rows) =>
    new Map([...rows].map(([key, row]) => [key, { ...row }]));
  return {
    inbox: cloneRows(state.inbox),
    quarantine: cloneRows(state.quarantine),
    outbox: cloneRows(state.outbox),
  };
}

function deliverySqlDatabase(
  t,
  { ageRows = [], corruptEnvelopeBytes = false } = {},
) {
  let durable = { inbox: new Map(), quarantine: new Map(), outbox: new Map() };
  let working;
  let clockMs = 0;
  let ageParameters;
  const result = (rows = [], rowCount = rows.length, command = null) => ({
    rows,
    rowCount,
    ...(command === null ? {} : { command }),
  });
  const cloneJson = (value) => (value === null ? null : JSON.parse(value));
  const sameSequence = (left, right) => String(left) === String(right);
  const database = mockDatabase(t, (sql, values) => {
    if (sql === "BEGIN") {
      working = cloneDeliveryState(durable);
      return result([], 0, "BEGIN");
    }
    if (sql === "COMMIT") {
      durable = cloneDeliveryState(working);
      working = undefined;
      return result([], 0, "COMMIT");
    }
    if (sql === "ROLLBACK") {
      working = undefined;
      return result([], 0, "ROLLBACK");
    }
    if (working === undefined) return undefined;

    if (sql.includes('"inbox_quarantine"')) {
      const key = `${values[0]}\u0000${values[1]}\u0000${values[2]}`;
      if (sql.startsWith("INSERT")) {
        if (working.quarantine.has(key)) return result();
        working.quarantine.set(key, {
          topic: values[0],
          partition: values[1],
          offset: values[2],
          message_id: values[3],
          message_type: values[4],
          payload_hash: values[5],
          envelope: cloneJson(values[6]),
          reason: values[7],
        });
        return result([{ topic: values[0] }]);
      }
      const row = working.quarantine.get(key);
      return result(row === undefined ? [] : [row]);
    }
    if (sql.includes('"inbox_messages"')) {
      const messageId = String(values[0]);
      if (sql.startsWith("INSERT")) {
        if (working.inbox.has(messageId)) return result();
        clockMs = Number(values[6]) - 1;
        working.inbox.set(messageId, {
          message_id: values[0],
          message_type: values[1],
          received_at: String(values[2]).replace("T", " ").replace(/Z$/, "+00"),
          payload: cloneJson(values[3]),
          payload_hash: values[4],
          state: "Processing",
          lease_owner: values[5],
          lease_until_ms: Number(values[6]),
          attempt: 1,
          processed_at: null,
          quarantine_reason: null,
        });
        return result([{ message_id: values[0] }]);
      }
      if (sql.startsWith("SELECT")) {
        const row = working.inbox.get(messageId);
        return result(row === undefined ? [] : [row]);
      }
      const row = working.inbox.get(messageId);
      if (row === undefined) return result();
      if (sql.includes("SET lease_owner")) {
        if (row.state !== "Processing" || row.lease_until_ms > clockMs)
          return result();
        Object.assign(row, {
          lease_owner: values[1],
          lease_until_ms: Number(values[2]),
          attempt: row.attempt + 1,
        });
        return result([row]);
      }
      if (sql.includes("SET state = 'Processed'")) {
        if (
          row.state !== "Processing" ||
          row.lease_owner !== values[1] ||
          row.lease_until_ms <= clockMs
        )
          return result();
        Object.assign(row, {
          state: "Processed",
          lease_owner: "",
          processed_at: values[2],
        });
        return result([{ message_id: values[0] }]);
      }
      if (sql.includes("SET state = 'Quarantined'")) {
        if (
          row.state !== "Processing" ||
          row.lease_owner !== values[1] ||
          row.lease_until_ms <= clockMs
        )
          return result();
        Object.assign(row, {
          state: "Quarantined",
          lease_owner: "",
          quarantine_reason: values[2],
        });
        return result([{ message_id: values[0] }]);
      }
      if (sql.startsWith("DELETE")) {
        if (
          row.state !== "Processing" ||
          row.lease_owner !== values[1] ||
          row.lease_until_ms <= clockMs
        )
          return result();
        working.inbox.delete(messageId);
        return result([{ message_id: values[0] }]);
      }
      return undefined;
    }
    if (sql.includes('"outbox_messages"')) {
      if (sql.startsWith("SELECT")) {
        if (sql.includes("jsonb_array_elements_text")) {
          ageParameters = [...values];
          return result(ageRows);
        }
        if (sql.includes("WHERE message_id")) {
          const row = working.outbox.get(String(values[0]));
          if (row === undefined) return result();
          const selected = {
            payload_hash: row.payload_hash,
            message_type: row.message_type,
            topic: row.topic,
            aggregate_ref: row.aggregate_ref,
            aggregate_sequence: row.aggregate_sequence,
            owner_version: row.owner_version,
            envelope: row.envelope,
            envelope_bytes: corruptEnvelopeBytes
              ? Buffer.concat([
                  Buffer.from(row.envelope_bytes),
                  Buffer.from([0]),
                ])
              : row.envelope_bytes,
            envelope_hash: row.envelope_hash,
            partition_key: row.partition_key,
            schema_version: row.schema_version,
          };
          return result([selected]);
        }
        const rows = [...working.outbox.values()]
          .filter((row) => row.aggregate_ref === values[0])
          .sort(
            (left, right) =>
              Number(right.aggregate_sequence) -
              Number(left.aggregate_sequence),
          );
        return result(
          rows.length === 0
            ? []
            : [{ aggregate_sequence: rows[0].aggregate_sequence }],
        );
      }
      if (sql.startsWith("INSERT")) {
        const messageId = String(values[0]);
        const conflict =
          working.outbox.has(messageId) ||
          [...working.outbox.values()].some(
            (row) =>
              row.aggregate_ref === values[3] &&
              sameSequence(row.aggregate_sequence, values[4]),
          );
        if (conflict) return result();
        working.outbox.set(messageId, {
          message_id: values[0],
          message_type: values[1],
          topic: values[2],
          aggregate_ref: values[3],
          aggregate_sequence: values[4],
          owner_version: values[5],
          partition_key: values[6],
          schema_version: values[7],
          envelope: cloneJson(values[8]),
          payload: cloneJson(values[9]),
          payload_hash: values[10],
          occurred_at: String(values[11])
            .replace("T", " ")
            .replace(/Z$/, "+00"),
          correlation_id: values[12],
          causation_id: values[13],
          traceparent: values[14],
          envelope_bytes: values[15],
          envelope_hash: values[16],
          state: "Pending",
          lease_owner: "",
          lease_token: 0n,
          lease_until_ms: 0,
          attempt: 0,
          next_attempt_at_ms: 0,
          last_error: null,
        });
        return result([{ message_id: values[0] }]);
      }
      if (sql.startsWith("WITH")) {
        const nowMs = Number(values[0]);
        const leaseUntilMs = Number(values[1]);
        const leaseOwner = values[2];
        const limit = Number(values[3]);
        clockMs = nowMs;
        const candidates = [...working.outbox.values()]
          .filter(
            (row) =>
              (row.state === "Pending" ||
                (row.state === "Publishing" && row.lease_until_ms <= nowMs)) &&
              row.next_attempt_at_ms <= nowMs &&
              ![...working.outbox.values()].some(
                (predecessor) =>
                  predecessor.aggregate_ref === row.aggregate_ref &&
                  Number(predecessor.aggregate_sequence) <
                    Number(row.aggregate_sequence) &&
                  predecessor.state !== "Published",
              ),
          )
          .sort(
            (left, right) =>
              Number(left.next_attempt_at_ms) -
                Number(right.next_attempt_at_ms) ||
              String(left.aggregate_ref).localeCompare(
                String(right.aggregate_ref),
              ) ||
              Number(left.aggregate_sequence) -
                Number(right.aggregate_sequence) ||
              String(left.message_id).localeCompare(String(right.message_id)),
          )
          .slice(0, limit);
        for (const row of candidates)
          Object.assign(row, {
            state: "Publishing",
            lease_owner: leaseOwner,
            lease_token: BigInt(row.attempt + 1),
            lease_until_ms: leaseUntilMs,
            attempt: row.attempt + 1,
          });
        return result(
          corruptEnvelopeBytes
            ? candidates.map((row) => ({
                ...row,
                envelope_bytes: Buffer.concat([
                  Buffer.from(row.envelope_bytes),
                  Buffer.from([0]),
                ]),
              }))
            : candidates,
        );
      }
      const messageId = String(values[0]);
      const row = working.outbox.get(messageId);
      if (row === undefined) return result();
      if (sql.includes("SET state = 'Published'")) {
        if (
          row.state !== "Publishing" ||
          row.lease_owner !== values[1] ||
          String(row.lease_token) !== String(values[2]) ||
          row.lease_until_ms <= clockMs
        )
          return result();
        Object.assign(row, { state: "Published", lease_owner: "" });
        return result([{ message_id: values[0] }]);
      }
      if (sql.includes("SET state = CASE")) {
        if (
          row.state !== "Publishing" ||
          row.lease_owner !== values[1] ||
          String(row.lease_token) !== String(values[2]) ||
          row.lease_until_ms <= clockMs
        )
          return result();
        const permanent = values[5] === true;
        Object.assign(row, {
          state: permanent ? "Quarantined" : "Pending",
          lease_owner: "",
          next_attempt_at_ms: Number(values[4]),
          last_error: values[3],
        });
        return result([{ state: row.state }]);
      }
      return undefined;
    }
    return undefined;
  }).database;
  return {
    database,
    snapshot: () => cloneDeliveryState(durable),
    ageParameters: () => ageParameters,
  };
}

function outboxFixture(
  messageId,
  aggregateRef,
  aggregateSequence,
  payload = { value: messageId },
) {
  const messageType = "DeliveryTest.Event";
  const occurredAt = "2026-01-01T00:00:00.123456789Z";
  const correlationId = `correlation-${messageId}`;
  const traceparent = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01";
  const ownerVersion = "1";
  return {
    messageId,
    messageType,
    topic: "coffee.delivery.test.v1",
    aggregateRef,
    aggregateSequence,
    ownerVersion,
    partitionKey: aggregateRef,
    schemaVersion: "1",
    envelope: {
      envelopeVersion: "1",
      messageId,
      messageType,
      occurredAt,
      producer: "platform-testing",
      correlationId,
      causationId: null,
      traceparent,
      aggregate: {
        type: "DeliveryTestAggregate",
        ref: aggregateRef,
        version: ownerVersion,
      },
      payload,
    },
    payload,
    occurredAt,
    correlationId,
    traceparent,
  };
}

function inboxFixture(message) {
  return {
    messageId: message.messageId,
    messageType: message.messageType,
    receivedAt: message.occurredAt,
    payloadHash: canonicalRequestHash(message.envelope),
    payload: message.envelope,
  };
}

void test("SQL Outbox keeps one aggregate ordered while independent aggregates progress", async (t) => {
  const { database, snapshot } = deliverySqlDatabase(t);
  const store = createSqlOutboxStore(database);
  const messages = [
    outboxFixture("aggregate-a-1", "aggregate-a", 1),
    outboxFixture("aggregate-a-2", "aggregate-a", 2),
    outboxFixture("aggregate-b-1", "aggregate-b", 1),
    outboxFixture("aggregate-b-2", "aggregate-b", 2),
  ];
  await withTransaction(
    database,
    { mode: "interactive" },
    async (transaction) => {
      for (const message of messages)
        assert.equal(await store.enqueue(transaction, message), "created");
    },
  );
  const first = await withTransaction(
    database,
    { mode: "background" },
    (transaction) => store.claim(transaction, 100, "publisher-a", 2, 1_000),
  );
  assert.deepEqual(first.map((claim) => claim.message.messageId).sort(), [
    "aggregate-a-1",
    "aggregate-b-1",
  ]);
  const blocked = await withTransaction(
    database,
    { mode: "background" },
    (transaction) => store.claim(transaction, 100, "publisher-b", 2, 1_000),
  );
  assert.deepEqual(blocked, []);
  const firstById = new Map(
    first.map((claim) => [claim.message.messageId, claim]),
  );
  await withTransaction(database, { mode: "background" }, (transaction) =>
    store.finalize(
      transaction,
      "aggregate-b-1",
      firstById.get("aggregate-b-1").leaseOwner,
      firstById.get("aggregate-b-1").leaseToken,
    ),
  );
  const independent = await withTransaction(
    database,
    { mode: "background" },
    (transaction) => store.claim(transaction, 100, "publisher-b", 2, 1_000),
  );
  assert.deepEqual(
    independent.map((claim) => claim.message.messageId),
    ["aggregate-b-2"],
  );
  await withTransaction(database, { mode: "background" }, (transaction) =>
    store.finalize(
      transaction,
      "aggregate-b-2",
      independent[0].leaseOwner,
      independent[0].leaseToken,
    ),
  );
  await withTransaction(database, { mode: "background" }, (transaction) =>
    store.finalize(
      transaction,
      "aggregate-a-1",
      firstById.get("aggregate-a-1").leaseOwner,
      firstById.get("aggregate-a-1").leaseToken,
    ),
  );
  const ordered = await withTransaction(
    database,
    { mode: "background" },
    (transaction) => store.claim(transaction, 100, "publisher-a", 2, 1_000),
  );
  assert.deepEqual(
    ordered.map((claim) => claim.message.messageId),
    ["aggregate-a-2"],
  );
  await withTransaction(database, { mode: "background" }, (transaction) =>
    store.finalize(
      transaction,
      "aggregate-a-2",
      ordered[0].leaseOwner,
      ordered[0].leaseToken,
    ),
  );
  assert.deepEqual(
    [...snapshot().outbox.values()].map((row) => row.state),
    ["Published", "Published", "Published", "Published"],
  );
});

void test("SQL Outbox rejects aggregate sequence gaps before inserting", async (t) => {
  const { database, snapshot } = deliverySqlDatabase(t);
  const store = createSqlOutboxStore(database);

  await assert.rejects(
    withTransaction(database, { mode: "background" }, (transaction) =>
      store.enqueue(
        transaction,
        outboxFixture("gap-sequence-2", "aggregate-gap", 2),
      ),
    ),
    { code: "OUTBOX_SEQUENCE_INVALID" },
  );
  assert.equal(snapshot().outbox.size, 0);
});

void test("SQL Outbox treats an unresolved insert race as a conflict", async (t) => {
  let messageReads = 0;
  let inserts = 0;
  const { database } = mockDatabase(t, (sql) => {
    if (!sql.includes('"outbox_messages"')) return undefined;
    if (sql.startsWith("SELECT") && sql.includes("WHERE message_id")) {
      messageReads += 1;
      return { rows: [], rowCount: 0 };
    }
    if (sql.startsWith("SELECT")) return { rows: [], rowCount: 0 };
    if (sql.startsWith("INSERT")) {
      inserts += 1;
      return { rows: [], rowCount: 0 };
    }
    return undefined;
  });
  const store = createSqlOutboxStore(database);

  const result = await withTransaction(
    database,
    { mode: "background" },
    (transaction) =>
      store.enqueue(
        transaction,
        outboxFixture("sequence-race", "aggregate-sequence-race", 1),
      ),
  );

  assert.equal(result, "conflict");
  assert.equal(inserts, 1);
  assert.equal(messageReads, 2, "the insert race is checked by message ID");
});

void test("SQL Outbox rejects envelopes that do not preserve event identity", async (t) => {
  const { database, statements } = mockDatabase(t);
  const store = createSqlOutboxStore(database);
  const original = outboxFixture(
    "invalid-envelope-contract",
    "aggregate-invalid-envelope-contract",
    1,
  );
  const cases = [
    ["empty message identifier", (message) => ({ ...message, messageId: "" })],
    [
      "invalid outer event time",
      (message) => ({ ...message, occurredAt: "bad-time" }),
    ],
    [
      "invalid aggregate sequence",
      (message) => ({ ...message, aggregateSequence: 0 }),
    ],
    [
      "empty causation identity",
      (message) => ({ ...message, causationId: "" }),
    ],
    ["empty trace context", (message) => ({ ...message, traceparent: "" })],
    [
      "unsupported envelope version",
      (message) => ({
        ...message,
        envelope: { ...message.envelope, envelopeVersion: "2" },
      }),
    ],
    [
      "unsupported schema version",
      (message) => ({ ...message, schemaVersion: "2" }),
    ],
    [
      "unknown envelope field",
      (message) => ({
        ...message,
        envelope: { ...message.envelope, unexpected: true },
      }),
    ],
    [
      "event ID mismatch",
      (message) => ({
        ...message,
        envelope: { ...message.envelope, messageId: "foreign-id" },
      }),
    ],
    [
      "event type mismatch",
      (message) => ({
        ...message,
        envelope: { ...message.envelope, messageType: "Foreign.Event" },
      }),
    ],
    [
      "event timestamp mismatch",
      (message) => ({
        ...message,
        envelope: { ...message.envelope, occurredAt: "2026-01-02T00:00:00Z" },
      }),
    ],
    [
      "invalid event timestamp",
      (message) => ({
        ...message,
        envelope: { ...message.envelope, occurredAt: "not-a-time" },
      }),
    ],
    [
      "producer missing",
      (message) => ({
        ...message,
        envelope: { ...message.envelope, producer: "" },
      }),
    ],
    [
      "correlation mismatch",
      (message) => ({
        ...message,
        envelope: { ...message.envelope, correlationId: "foreign-correlation" },
      }),
    ],
    [
      "trace mismatch",
      (message) => ({
        ...message,
        envelope: {
          ...message.envelope,
          traceparent:
            "00-cccccccccccccccccccccccccccccccc-dddddddddddddddd-01",
        },
      }),
    ],
    [
      "causation mismatch",
      (message) => ({
        ...message,
        envelope: { ...message.envelope, causationId: "unexpected-causation" },
      }),
    ],
    [
      "aggregate reference mismatch",
      (message) => ({
        ...message,
        envelope: {
          ...message.envelope,
          aggregate: {
            ...message.envelope.aggregate,
            ref: "foreign-aggregate",
          },
        },
      }),
    ],
    [
      "aggregate is not an object",
      (message) => ({
        ...message,
        envelope: { ...message.envelope, aggregate: null },
      }),
    ],
    [
      "aggregate has unknown field",
      (message) => ({
        ...message,
        envelope: {
          ...message.envelope,
          aggregate: { ...message.envelope.aggregate, tenant: "foreign" },
        },
      }),
    ],
    [
      "aggregate type empty",
      (message) => ({
        ...message,
        envelope: {
          ...message.envelope,
          aggregate: { ...message.envelope.aggregate, type: "" },
        },
      }),
    ],
    [
      "aggregate version field absent",
      (message) => ({
        ...message,
        envelope: {
          ...message.envelope,
          aggregate: {
            type: "DeliveryTestAggregate",
            ref: message.aggregateRef,
          },
        },
      }),
    ],
    [
      "aggregate version mismatch",
      (message) => ({
        ...message,
        envelope: {
          ...message.envelope,
          aggregate: { ...message.envelope.aggregate, version: "2" },
        },
      }),
    ],
    [
      "payload mismatch",
      (message) => ({
        ...message,
        envelope: {
          ...message.envelope,
          payload: { value: "foreign-payload" },
        },
      }),
    ],
  ];

  for (const [name, mutate] of cases) {
    await t.test(name, async () => {
      await assert.rejects(
        withTransaction(database, { mode: "background" }, (transaction) =>
          store.enqueue(transaction, mutate(original)),
        ),
        { code: "OUTBOX_INVALID" },
      );
    });
  }
  assert.equal(
    statements.some((sql) => sql.includes('"outbox_messages"')),
    false,
    "invalid event identity must be rejected before SQL persistence",
  );
});

void test("SQL Outbox fails closed on malformed rows returned by claim", async (t) => {
  const message = outboxFixture(
    "malformed-claim-row",
    "aggregate-malformed-claim-row",
    1,
  );
  const validRow = {
    message_id: message.messageId,
    message_type: message.messageType,
    topic: message.topic,
    aggregate_ref: message.aggregateRef,
    aggregate_sequence: "1",
    owner_version: message.ownerVersion,
    partition_key: message.partitionKey,
    schema_version: message.schemaVersion,
    envelope: message.envelope,
    payload: message.payload,
    payload_hash: canonicalRequestHash(message.envelope),
    occurred_at: message.occurredAt,
    correlation_id: message.correlationId,
    causation_id: null,
    traceparent: message.traceparent,
    state: "Publishing",
    lease_owner: "publisher-a",
    lease_token: "1",
    lease_until_ms: "2000",
    attempt: 1,
    next_attempt_at_ms: "0",
    last_error: null,
  };
  const cases = [
    [
      "claim returned a non-leased state",
      { state: "Pending" },
      "OUTBOX_RECORD_INVALID",
    ],
    [
      "persisted payload hash is malformed",
      { payload_hash: "not-a-hash" },
      "OUTBOX_RECORD_INVALID",
    ],
    [
      "persisted envelope hash does not match",
      { payload_hash: "0".repeat(64) },
      "OUTBOX_RECORD_INVALID",
    ],
    ["claim returned a zero attempt", { attempt: 0 }, "OUTBOX_INVALID"],
    [
      "claim returned a negative lease token",
      { lease_token: "-1" },
      "OUTBOX_RECORD_INVALID",
    ],
  ];

  await t.test(
    "a valid claim projection reaches the acquired result",
    async (subtest) => {
      const { database } = mockDatabase(subtest, (sql) =>
        sql.startsWith("WITH") && sql.includes('"outbox_messages"')
          ? { rows: [validRow], rowCount: 1 }
          : undefined,
      );
      const store = createSqlOutboxStore(database);
      const claims = await withTransaction(
        database,
        { mode: "background" },
        (transaction) =>
          store.claim(transaction, 1_000, "publisher-a", 1, 1_000),
      );

      assert.equal(claims.length, 1);
      assert.equal(claims[0].message.messageId, message.messageId);
      assert.equal(claims[0].message.occurredAt, message.occurredAt);
      assert.equal(claims[0].attempt, 1);
      assert.equal(claims[0].leaseOwner, "publisher-a");
      assert.equal(claims[0].leaseToken, 1n);
    },
  );

  for (const [name, override, code] of cases) {
    await t.test(name, async (subtest) => {
      const { database } = mockDatabase(subtest, (sql) =>
        sql.startsWith("WITH") && sql.includes('"outbox_messages"')
          ? { rows: [{ ...validRow, ...override }], rowCount: 1 }
          : undefined,
      );
      const store = createSqlOutboxStore(database);
      await assert.rejects(
        withTransaction(database, { mode: "background" }, (transaction) =>
          store.claim(transaction, 1_000, "publisher-a", 1, 1_000),
        ),
        { code },
      );
    });
  }
});

void test("SQL Outbox rejects unsafe claim and failure commands before SQL", async (t) => {
  const { database, statements } = mockDatabase(t);
  const store = createSqlOutboxStore(database);
  /** @type {Array<[string, [number, string, number, number]]>} */
  const claimCases = [
    ["negative claim time", [-1, "publisher-a", 1, 10]],
    ["empty claim owner", [1, "", 1, 10]],
    ["zero claim limit", [1, "publisher-a", 0, 10]],
    ["lease window overflow", [Number.MAX_SAFE_INTEGER, "publisher-a", 1, 1]],
  ];
  for (const [name, args] of claimCases) {
    await t.test(name, async () => {
      await assert.rejects(
        withTransaction(database, { mode: "background" }, (transaction) =>
          store.claim(transaction, ...args),
        ),
        { code: "OUTBOX_INVALID" },
      );
    });
  }
  const failCases = [
    ["negative retry time", [-1, "send failed", false]],
    ["oversized failure detail", [1, "x".repeat(513), false]],
    ["nonboolean permanence", [1, "send failed", "true"]],
    ["negative lease fence", [1, "send failed", false, -1]],
  ];
  for (const [
    name,
    [nextAttemptAtMs, lastError, permanent, leaseToken],
  ] of failCases) {
    await t.test(name, async () => {
      await assert.rejects(
        withTransaction(database, { mode: "background" }, (transaction) =>
          store.fail(
            transaction,
            "message-id",
            "publisher-a",
            leaseToken ?? 1,
            nextAttemptAtMs,
            lastError,
            permanent,
          ),
        ),
        { code: "OUTBOX_INVALID" },
      );
    });
  }
  assert.equal(
    statements.some((sql) => sql.includes('"outbox_messages"')),
    false,
    "invalid claim and retry facts must not reach PostgreSQL",
  );
});

void test("SQL Outbox immutable envelope bytes fence duplicate and claimed records", async (t) => {
  const message = outboxFixture(
    "immutable-envelope-bytes",
    "aggregate-bytes",
    1,
  );
  const { database } = deliverySqlDatabase(t);
  const store = createSqlOutboxStore(database, { envelopeBytes: true });

  await withTransaction(
    database,
    { mode: "background" },
    async (transaction) => {
      assert.equal(await store.enqueue(transaction, message), "created");
    },
  );
  await withTransaction(
    database,
    { mode: "background" },
    async (transaction) => {
      assert.equal(await store.enqueue(transaction, message), "duplicate");
    },
  );

  const corrupted = deliverySqlDatabase(t, { corruptEnvelopeBytes: true });
  const corruptedStore = createSqlOutboxStore(corrupted.database, {
    envelopeBytes: true,
  });
  await withTransaction(
    corrupted.database,
    { mode: "background" },
    (transaction) => corruptedStore.enqueue(transaction, message),
  );
  await withTransaction(
    corrupted.database,
    { mode: "background" },
    async (transaction) => {
      assert.equal(
        await corruptedStore.enqueue(transaction, message),
        "conflict",
      );
    },
  );
  await assert.rejects(
    withTransaction(corrupted.database, { mode: "background" }, (transaction) =>
      corruptedStore.claim(transaction, 100, "publisher-bytes", 1, 10),
    ),
    { code: "OUTBOX_RECORD_INVALID" },
  );
});

void test("SQL Outbox age diagnostics are scoped and reject invalid persisted ages", async (t) => {
  const topic = "coffee.delivery.test.v1";
  const scoped = deliverySqlDatabase(t, {
    ageRows: [{ topic, age_ms: "1500" }],
  });
  const store = createSqlOutboxStore(scoped.database, { topics: [topic] });
  assert.deepEqual(
    await withTransaction(
      scoped.database,
      { mode: "background" },
      (transaction) => store.oldestUnpublishedAgesMs(transaction, 10_000),
    ),
    [{ topic, ageMs: 1500 }],
  );
  assert.deepEqual(scoped.ageParameters(), [10_000, JSON.stringify([topic])]);

  const unscoped = deliverySqlDatabase(t);
  const unknownStore = createSqlOutboxStore(unscoped.database);
  assert.equal(
    await withTransaction(
      unscoped.database,
      { mode: "background" },
      (transaction) =>
        unknownStore.oldestUnpublishedAgesMs(transaction, 10_000),
    ),
    null,
  );
  assert.equal(unscoped.ageParameters(), undefined);

  const invalid = deliverySqlDatabase(t, {
    ageRows: [{ topic, age_ms: "-1" }],
  });
  const invalidStore = createSqlOutboxStore(invalid.database, {
    topics: [topic],
  });
  await assert.rejects(
    withTransaction(invalid.database, { mode: "background" }, (transaction) =>
      invalidStore.oldestUnpublishedAgesMs(transaction, 10_000),
    ),
    { code: "OUTBOX_RECORD_INVALID" },
  );
});

void test("SQL Outbox scoped age diagnostics remain best-effort across query failure", async (t) => {
  const topic = "coffee.delivery.diagnostics.v1";
  let failAgeQuery = false;
  let ageCalls = 0;
  const { database, statements } = mockDatabase(t, (sql) => {
    if (sql.startsWith("WITH") && sql.includes('"outbox_messages"'))
      return { rows: [], rowCount: 0 };
    if (sql.startsWith("SELECT") && sql.includes("jsonb_array_elements_text")) {
      ageCalls += 1;
      if (failAgeQuery)
        throw Object.assign(new Error("age query failed"), { code: "57014" });
      return { rows: [{ topic, age_ms: "250" }], rowCount: 1 };
    }
    return undefined;
  });
  const store = createSqlOutboxStore(database, {
    schema: "orders",
    topics: [topic],
  });
  const options = {
    nowMs: 1_000,
    leaseOwner: "publisher-a",
    policy: {
      leaseMs: 1_000,
      sendTimeoutMs: 500,
      maxInFlight: 1,
      retry: { baseMs: 10, maxMs: 100, maxAttempts: 3 },
    },
  };
  const idle = {
    claimed: 0,
    published: 0,
    failed: 0,
    unknown: 0,
    quarantined: 0,
  };
  const waitForDiagnostics = async () => {
    for (let tick = 0; tick < 20 && database.metrics().pending > 0; tick++)
      await new Promise((resolve) => setImmediate(resolve));
    assert.equal(database.metrics().pending, 0);
  };

  assert.deepEqual(
    await relayOutboxBatch(
      store,
      database,
      async () => assert.fail("no message should be sent without a claim"),
      options,
    ),
    idle,
  );
  await waitForDiagnostics();
  assert.equal(ageCalls, 1);
  failAgeQuery = true;
  assert.deepEqual(
    await relayOutboxBatch(
      store,
      database,
      async () => assert.fail("diagnostics must not create a delivery"),
      options,
    ),
    idle,
  );
  await waitForDiagnostics();
  assert.equal(
    ageCalls,
    2,
    "a failed diagnostic must release its scoped latch",
  );
  assert.ok(
    statements.some((sql) => sql.includes("jsonb_array_elements_text")),
    "the store must issue its configured-topic age query",
  );
  await database.resource.stop(AbortSignal.timeout(1_000));
});

void test("SQL Outbox preserves stable messageId, recovers expired lease and fences stale finalize", async (t) => {
  const { database, snapshot } = deliverySqlDatabase(t);
  const store = createSqlOutboxStore(database);
  const leaseMessage = outboxFixture("stable-lease-id", "aggregate-lease", 1);
  await withTransaction(database, { mode: "background" }, (transaction) =>
    store.enqueue(transaction, leaseMessage),
  );
  await withTransaction(database, { mode: "background" }, async (transaction) =>
    assert.equal(await store.enqueue(transaction, leaseMessage), "duplicate"),
  );
  const reorderedEnvelope = {
    payload: leaseMessage.payload,
    aggregate: leaseMessage.envelope.aggregate,
    traceparent: leaseMessage.traceparent,
    causationId: null,
    correlationId: leaseMessage.correlationId,
    producer: "platform-testing",
    occurredAt: leaseMessage.occurredAt,
    messageType: leaseMessage.messageType,
    messageId: leaseMessage.messageId,
    envelopeVersion: "1",
  };
  await withTransaction(database, { mode: "background" }, async (transaction) =>
    assert.equal(
      await store.enqueue(transaction, {
        ...leaseMessage,
        envelope: reorderedEnvelope,
      }),
      "duplicate",
    ),
  );
  const changedEnvelope = {
    ...leaseMessage,
    envelope: { ...leaseMessage.envelope, producer: "other-producer" },
  };
  await withTransaction(database, { mode: "background" }, async (transaction) =>
    assert.equal(await store.enqueue(transaction, changedEnvelope), "conflict"),
  );
  const changedPayload = {
    ...leaseMessage,
    envelope: { ...leaseMessage.envelope, payload: { value: "different" } },
  };
  await assert.rejects(
    withTransaction(database, { mode: "background" }, (transaction) =>
      store.enqueue(transaction, changedPayload),
    ),
    { code: "OUTBOX_INVALID" },
  );
  const changedCorrelation = {
    ...leaseMessage,
    envelope: { ...leaseMessage.envelope, correlationId: "other-correlation" },
  };
  await assert.rejects(
    withTransaction(database, { mode: "background" }, (transaction) =>
      store.enqueue(transaction, changedCorrelation),
    ),
    { code: "OUTBOX_INVALID" },
  );
  const beforeIdentityMismatch = snapshot().outbox.size;
  const changedMessageId = {
    ...leaseMessage,
    envelope: { ...leaseMessage.envelope, messageId: "foreign-message-id" },
  };
  await assert.rejects(
    withTransaction(database, { mode: "background" }, (transaction) =>
      store.enqueue(transaction, changedMessageId),
    ),
    { code: "OUTBOX_INVALID" },
  );
  assert.equal(snapshot().outbox.size, beforeIdentityMismatch);
  const oldClaim = (
    await withTransaction(database, { mode: "background" }, (transaction) =>
      store.claim(transaction, 100, "publisher-old", 1, 10),
    )
  )[0];
  assert.equal(oldClaim.message.messageId, leaseMessage.messageId);
  const recovered = (
    await withTransaction(database, { mode: "background" }, (transaction) =>
      store.claim(transaction, 111, "publisher-new", 1, 100),
    )
  )[0];
  assert.equal(recovered.message.messageId, leaseMessage.messageId);
  assert.equal(recovered.attempt, oldClaim.attempt + 1);
  assert.notEqual(recovered.leaseToken, oldClaim.leaseToken);
  await assert.rejects(
    withTransaction(database, { mode: "background" }, (transaction) =>
      store.finalize(
        transaction,
        oldClaim.message.messageId,
        oldClaim.leaseOwner,
        oldClaim.leaseToken,
      ),
    ),
    { code: "OUTBOX_LEASE_INVALID" },
  );
  await withTransaction(database, { mode: "background" }, (transaction) =>
    store.finalize(
      transaction,
      recovered.message.messageId,
      recovered.leaseOwner,
      recovered.leaseToken,
    ),
  );

  const relayMessage = outboxFixture("relay-stable-id", "aggregate-relay", 1);
  await withTransaction(database, { mode: "background" }, (transaction) =>
    store.enqueue(transaction, relayMessage),
  );
  const outboxSpans = [];
  const originalGetTracer = Reflect.get(trace, "getTracer");
  trace.getTracer = function (name, ...args) {
    const tracer = originalGetTracer.call(this, name, ...args);
    if (name !== "coffee-platform.outbox") return tracer;
    return {
      ...tracer,
      startSpan(spanName, ...spanArgs) {
        const span = tracer.startSpan(spanName, ...spanArgs);
        const captured = { name: spanName, statuses: [], ends: 0 };
        const setStatus = span.setStatus.bind(span);
        const end = span.end.bind(span);
        span.setStatus = (status) => {
          captured.statuses.push(status);
          return setStatus(status);
        };
        span.end = (...endArgs) => {
          captured.ends++;
          return end(...endArgs);
        };
        outboxSpans.push(captured);
        return span;
      },
    };
  };
  t.after(() => {
    trace.getTracer = originalGetTracer;
  });
  const sent = [];
  const relayResult = await relayOutboxBatch(
    store,
    database,
    async (claim, signal) => {
      assert.equal(signal.aborted, false);
      sent.push({
        messageId: claim.message.messageId,
        envelopeMessageId: claim.message.envelope.messageId,
        occurredAt: claim.message.envelope.occurredAt,
        causationId: claim.message.envelope.causationId,
      });
      return { kind: "ack" };
    },
    {
      nowMs: 200,
      leaseOwner: "publisher-relay",
      policy: {
        leaseMs: 100,
        sendTimeoutMs: 50,
        maxInFlight: 2,
        retry: { baseMs: 1, maxMs: 10, maxAttempts: 3 },
      },
    },
  );
  assert.deepEqual(sent, [
    {
      messageId: relayMessage.messageId,
      envelopeMessageId: relayMessage.messageId,
      occurredAt: relayMessage.occurredAt,
      causationId: null,
    },
  ]);
  assert.deepEqual(relayResult, {
    claimed: 1,
    published: 1,
    failed: 0,
    unknown: 0,
    quarantined: 0,
  });
  assert.equal(
    snapshot().outbox.get(relayMessage.messageId).state,
    "Published",
  );
  assert.deepEqual(
    outboxSpans.map(({ name, statuses, ends }) => ({ name, statuses, ends })),
    [
      { name: "Outbox.poll", statuses: [], ends: 1 },
      { name: "Outbox.relay", statuses: [], ends: 1 },
    ],
  );
  outboxSpans.length = 0;

  // A batch cannot start more native sends than maxInFlight, even with more ready rows.
  for (const id of ["bounded-a", "bounded-b", "bounded-c"]) {
    await withTransaction(database, { mode: "background" }, (transaction) =>
      store.enqueue(transaction, outboxFixture(id, id, 1)),
    );
  }
  const { promise: sendGate, resolve: releaseSends } = Promise.withResolvers();
  let activeSends = 0;
  const boundedBatch = relayOutboxBatch(
    store,
    database,
    async () => {
      activeSends++;
      await sendGate;
      activeSends--;
      return { kind: "unknown" };
    },
    {
      nowMs: 300,
      leaseOwner: "publisher-bounded",
      policy: {
        leaseMs: 100,
        sendTimeoutMs: 1_000,
        maxInFlight: 2,
        retry: { baseMs: 1, maxMs: 10, maxAttempts: 3 },
      },
    },
  );
  try {
    for (let tick = 0; tick < 20 && activeSends < 2; tick++)
      await new Promise((resolve) => setImmediate(resolve));
    assert.equal(activeSends, 2);
    assert.equal(
      [...snapshot().outbox.values()].filter((row) => row.state === "Pending")
        .length,
      1,
    );
  } finally {
    releaseSends();
  }
  assert.deepEqual(await boundedBatch, {
    claimed: 2,
    published: 0,
    failed: 0,
    unknown: 2,
    quarantined: 0,
  });
  assert.equal(activeSends, 0);
  assert.equal(
    outboxSpans.filter((span) => span.name === "Outbox.poll").length,
    1,
  );
  assert.equal(
    outboxSpans.filter((span) => span.name === "Outbox.relay").length,
    2,
  );
  assert.ok(
    outboxSpans.every(
      (span) =>
        span.statuses.length === 1 &&
        span.statuses[0].code === SpanStatusCode.ERROR &&
        span.ends === 1,
    ),
  );

  outboxSpans.length = 0;
  const drainedResult = await relayOutboxBatch(
    store,
    database,
    async () => ({ kind: "ack" }),
    {
      nowMs: 301,
      leaseOwner: "publisher-drain",
      policy: {
        leaseMs: 100,
        sendTimeoutMs: 50,
        maxInFlight: 1,
        retry: { baseMs: 1, maxMs: 10, maxAttempts: 3 },
      },
    },
  );
  assert.equal(drainedResult.published, 1);
  assert.ok(
    outboxSpans.every((span) => span.statuses.length === 0 && span.ends === 1),
  );

  outboxSpans.length = 0;
  const failedMessage = outboxFixture(
    "relay-failed",
    "aggregate-relay-failed",
    1,
  );
  await withTransaction(database, { mode: "background" }, (transaction) =>
    store.enqueue(transaction, failedMessage),
  );
  const failedResult = await relayOutboxBatch(
    store,
    database,
    async () => ({ kind: "failed", error: "send rejected" }),
    {
      nowMs: 302,
      leaseOwner: "publisher-failed",
      policy: {
        leaseMs: 100,
        sendTimeoutMs: 50,
        maxInFlight: 1,
        retry: { baseMs: 1, maxMs: 10, maxAttempts: 3 },
      },
    },
  );
  assert.deepEqual(failedResult, {
    claimed: 1,
    published: 0,
    failed: 1,
    unknown: 0,
    quarantined: 0,
  });
  assert.equal(outboxSpans.length, 2);
  assert.ok(
    outboxSpans.every(
      (span) =>
        span.statuses.length === 1 &&
        span.statuses[0].code === SpanStatusCode.ERROR &&
        span.ends === 1,
    ),
  );

  outboxSpans.length = 0;
  const thrownMessage = outboxFixture(
    "relay-thrown-finalize",
    "aggregate-relay-thrown-finalize",
    1,
  );
  await withTransaction(database, { mode: "background" }, (transaction) =>
    store.enqueue(transaction, thrownMessage),
  );
  const failingFinalizeStore = Object.create(store);
  failingFinalizeStore.finalize = async () => {
    throw new Error("finalize failed");
  };
  const thrownResult = await relayOutboxBatch(
    failingFinalizeStore,
    database,
    async () => ({ kind: "ack" }),
    {
      nowMs: 302,
      leaseOwner: "publisher-thrown",
      policy: {
        leaseMs: 100,
        sendTimeoutMs: 50,
        maxInFlight: 1,
        retry: { baseMs: 1, maxMs: 10, maxAttempts: 3 },
      },
    },
  );
  assert.deepEqual(thrownResult, {
    claimed: 1,
    published: 0,
    failed: 0,
    unknown: 1,
    quarantined: 0,
  });
  assert.equal(outboxSpans.length, 2);
  assert.ok(
    outboxSpans.every(
      (span) =>
        span.statuses.length === 1 &&
        span.statuses[0].code === SpanStatusCode.ERROR &&
        span.ends === 1,
    ),
  );
});

void test("SQL Outbox quarantines permanent publish failure instead of retrying", async (t) => {
  const { database, snapshot } = deliverySqlDatabase(t);
  const store = createSqlOutboxStore(database);
  const message = outboxFixture(
    "relay-permanent",
    "aggregate-relay-permanent",
    1,
  );
  await withTransaction(database, { mode: "background" }, (transaction) =>
    store.enqueue(transaction, message),
  );

  assert.deepEqual(
    await relayOutboxBatch(
      store,
      database,
      async () => ({
        kind: "failed",
        permanent: true,
        error: "schema rejected",
      }),
      {
        nowMs: 303,
        leaseOwner: "publisher-permanent",
        policy: {
          leaseMs: 100,
          sendTimeoutMs: 50,
          maxInFlight: 1,
          retry: { baseMs: 1, maxMs: 10, maxAttempts: 3 },
        },
      },
    ),
    { claimed: 1, published: 0, failed: 1, unknown: 0, quarantined: 1 },
  );
  assert.equal(snapshot().outbox.get(message.messageId).state, "Quarantined");
  assert.deepEqual(
    await withTransaction(database, { mode: "background" }, (transaction) =>
      store.claim(transaction, 1_000, "publisher-after-quarantine", 1, 100),
    ),
    [],
  );
});

void test("Outbox age diagnostics run single-flight without gating delivery and drain before database shutdown", async (t) => {
  const { database } = mockDatabase(t);
  const message = outboxFixture(
    "age-diagnostic-does-not-gate",
    "aggregate-age-diagnostic",
    1,
  );
  const started = [Promise.withResolvers(), Promise.withResolvers()];
  const gates = [Promise.withResolvers(), Promise.withResolvers()];
  let diagnosticCalls = 0;
  let claimAvailable = true;
  const store = {
    enqueue: async () => "created",
    claim: async () => {
      if (!claimAvailable) return [];
      claimAvailable = false;
      return [
        {
          message,
          payloadHash: canonicalRequestHash(message.envelope),
          state: "Publishing",
          attempt: 1,
          leaseOwner: "age-diagnostic-relay",
          leaseToken: 1n,
          leaseUntilMs: 500,
          nextAttemptAtMs: 400,
        },
      ];
    },
    finalize: async () => {},
    fail: async () => "Pending",
    oldestUnpublishedAgesMs: async () => {
      const call = diagnosticCalls++;
      started[call].resolve();
      await gates[call].promise;
      if (call === 0) throw new Error("diagnostic query failed");
      return null;
    },
  };
  const options = {
    nowMs: 400,
    leaseOwner: "age-diagnostic-relay",
    policy: {
      leaseMs: 100,
      sendTimeoutMs: 50,
      maxInFlight: 1,
      retry: { baseMs: 1, maxMs: 10, maxAttempts: 3 },
    },
  };

  const delivered = await relayOutboxBatch(
    store,
    database,
    async () => ({ kind: "ack" }),
    options,
  );
  assert.equal(
    delivered.published,
    1,
    "a delayed diagnostic must not delay claim or delivery",
  );
  await started[0].promise;
  const overlapping = await relayOutboxBatch(
    store,
    database,
    async () => ({ kind: "ack" }),
    options,
  );
  assert.equal(overlapping.claimed, 0);
  assert.equal(
    diagnosticCalls,
    1,
    "the same store must not start overlapping age queries",
  );

  gates[0].resolve();
  while (database.metrics().pending > 0)
    await new Promise((resolve) => setImmediate(resolve));
  const retried = await relayOutboxBatch(
    store,
    database,
    async () => ({ kind: "ack" }),
    options,
  );
  assert.equal(retried.claimed, 0);
  await started[1].promise;
  assert.equal(
    diagnosticCalls,
    2,
    "a failed diagnostic releases the single-flight guard",
  );
  let stopped = false;
  const shutdown = database.resource
    .stop(AbortSignal.timeout(1_000))
    .then(() => {
      stopped = true;
    });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    stopped,
    false,
    "database shutdown waits for the already-tracked diagnostic transaction",
  );
  gates[1].resolve();
  await shutdown;
  assert.equal(stopped, true);
});

void test("Inbox consumeOnce rollback leaves no partial Inbox/Outbox mark and permits retry", async (t) => {
  const { database, snapshot } = deliverySqlDatabase(t);
  const inbox = createSqlInboxStore(database);
  const outbox = createSqlOutboxStore(database);
  const message = outboxFixture("rollback-handler", "aggregate-rollback", 1);
  const inboxMessage = inboxFixture(message);
  let handlers = 0;
  await assert.rejects(
    withTransaction(database, { mode: "interactive" }, (transaction) =>
      consumeOnce(
        inbox,
        transaction,
        inboxMessage,
        "consumer-a",
        1_000,
        10_000,
        async (tx) => {
          handlers += 1;
          assert.equal(await outbox.enqueue(tx, message), "created");
          throw new Error("handler failed before durable mark");
        },
        "2026-01-01T00:00:00Z",
      ),
    ),
    /handler failed before durable mark/,
  );
  assert.equal(handlers, 1);
  assert.equal(snapshot().inbox.size, 0);
  assert.equal(snapshot().outbox.size, 0);

  const result = await withTransaction(
    database,
    { mode: "interactive" },
    (transaction) =>
      consumeOnce(
        inbox,
        transaction,
        inboxMessage,
        "consumer-retry",
        1_000,
        10_000,
        async (tx) => {
          assert.equal(await outbox.enqueue(tx, message), "created");
        },
        "2026-01-01T00:00:00Z",
      ),
  );
  assert.deepEqual(result, { kind: "processed" });
  assert.equal(snapshot().inbox.get(message.messageId).state, "Processed");
  assert.equal(snapshot().outbox.get(message.messageId).state, "Pending");
});

void test("consumer Inbox rejects envelope identity and trace mismatches before insert", async (t) => {
  const { database, statements } = mockDatabase(t);
  const inbox = createSqlInboxStore(database, {
    consumerName: "orders.lifecycle",
  });
  const message = inboxFixture(
    outboxFixture("inbox-envelope-identity", "aggregate-inbox", 1),
  );
  const foreignIdentity = {
    ...message,
    payload: { ...message.payload, messageId: "foreign-message-id" },
  };
  foreignIdentity.payloadHash = canonicalRequestHash(foreignIdentity.payload);
  const invalidTrace = {
    ...message,
    payload: { ...message.payload, traceparent: "invalid-traceparent" },
  };
  invalidTrace.payloadHash = canonicalRequestHash(invalidTrace.payload);

  await withTransaction(
    database,
    { mode: "background" },
    async (transaction) => {
      for (const invalidMessage of [foreignIdentity, invalidTrace])
        await assert.rejects(
          inbox.begin(transaction, invalidMessage, "consumer-a", 1_000, 10_000),
          { code: "INBOX_INVALID" },
        );
    },
  );
  assert.equal(
    statements.some((sql) =>
      sql.includes('INSERT INTO "public"."inbox_messages"'),
    ),
    false,
  );
});

void test("Inbox fences an expired owner after lease recovery and permits the current owner", async (t) => {
  const { database, snapshot } = deliverySqlDatabase(t);
  const inbox = createSqlInboxStore(database);
  const message = inboxFixture(
    outboxFixture("inbox-recovered-lease", "aggregate-inbox-lease", 1),
  );
  const clockAdvance = inboxFixture(
    outboxFixture("inbox-clock-advance", "aggregate-clock-advance", 1),
  );
  await withTransaction(
    database,
    { mode: "background" },
    async (transaction) => {
      assert.equal(
        (await inbox.begin(transaction, message, "consumer-old", 0, 10)).kind,
        "acquired",
      );
      await inbox.begin(transaction, clockAdvance, "clock-advance", 1_000, 10);
      await assert.rejects(
        inbox.markProcessed(
          transaction,
          message.messageId,
          "consumer-old",
          "2026-01-01T00:00:01Z",
        ),
        { code: "INBOX_LEASE_INVALID" },
      );
      const recovered = await inbox.begin(
        transaction,
        message,
        "consumer-new",
        1_010,
        100,
      );
      assert.equal(recovered.kind, "acquired");
      if (recovered.kind !== "acquired") assert.fail("lease was not reclaimed");
      assert.equal(recovered.record.attempt, 2);
      await assert.rejects(
        inbox.markProcessed(
          transaction,
          message.messageId,
          "consumer-old",
          "2026-01-01T00:00:02Z",
        ),
        { code: "INBOX_LEASE_INVALID" },
      );
      await inbox.markProcessed(
        transaction,
        message.messageId,
        "consumer-new",
        "2026-01-01T00:00:02Z",
      );
    },
  );
  assert.equal(snapshot().inbox.get(message.messageId).state, "Processed");
  assert.equal(snapshot().inbox.get(message.messageId).attempt, 2);
});

void test("Inbox rejects an unknown persisted state instead of acquiring it", async (t) => {
  const { database, statements } = mockDatabase(t, (sql) => {
    if (!sql.includes('"inbox_messages"')) return undefined;
    if (sql.startsWith("INSERT"))
      return { rows: [{ message_id: "persisted-unknown-state" }], rowCount: 1 };
    if (sql.startsWith("SELECT"))
      return {
        rows: [
          {
            message_id: "persisted-unknown-state",
            message_type: "DeliveryTest.Event",
            received_at: "2026-01-01 00:00:00+00",
            payload: { stable: true },
            payload_hash: canonicalRequestHash({ stable: true }),
            state: "Received",
            lease_owner: "old-consumer",
            lease_until_ms: 0,
            attempt: 1,
            processed_at: null,
            quarantine_reason: null,
          },
        ],
        rowCount: 1,
      };
    return undefined;
  });
  const inbox = createSqlInboxStore(database);
  const payload = { stable: true };
  const message = {
    messageId: "persisted-unknown-state",
    messageType: "DeliveryTest.Event",
    receivedAt: "2026-01-01T00:00:00Z",
    payload,
    payloadHash: canonicalRequestHash(payload),
  };

  await assert.rejects(
    withTransaction(database, { mode: "background" }, (transaction) =>
      inbox.begin(transaction, message, "new-consumer", 1_000, 10_000),
    ),
    { code: "INBOX_RECORD_INVALID" },
  );
  assert.equal(
    statements.some((sql) => sql.includes("SET lease_owner")),
    false,
    "an unknown persisted state must not be reclaimed as Processing",
  );
});

void test("Inbox does not grant a permit for malformed persisted Processing rows", async (t) => {
  const payload = { stable: true };
  const message = {
    messageId: "inbox-malformed-row",
    messageType: "DeliveryTest.Event",
    receivedAt: "2026-01-01T00:00:00Z",
    payload,
    payloadHash: canonicalRequestHash(payload),
  };
  const validRow = {
    message_id: message.messageId,
    message_type: message.messageType,
    received_at: "2026-01-01 00:00:00+00",
    payload,
    payload_hash: message.payloadHash,
    state: "Processing",
    lease_owner: "consumer-a",
    lease_until_ms: "2000",
    attempt: 1,
    processed_at: null,
    quarantine_reason: null,
  };
  for (const [name, override, expectedCode] of [
    [
      "empty persisted message type",
      { message_type: "" },
      "INBOX_RECORD_INVALID",
    ],
    [
      "invalid persisted receive time",
      { received_at: "not-a-time" },
      "INBOX_RECORD_INVALID",
    ],
    [
      "negative persisted lease time",
      { lease_until_ms: -1 },
      "INBOX_RECORD_INVALID",
    ],
    ["zero persisted attempt", { attempt: 0 }, "INBOX_INVALID"],
    ["non-string processed time", { processed_at: 1 }, "INBOX_RECORD_INVALID"],
    [
      "non-string quarantine reason",
      { quarantine_reason: 1 },
      "INBOX_RECORD_INVALID",
    ],
  ]) {
    await t.test(name, async (subtest) => {
      const { database } = mockDatabase(subtest, (sql) => {
        if (!sql.includes('"inbox_messages"')) return undefined;
        if (sql.startsWith("INSERT"))
          return { rows: [{ message_id: message.messageId }], rowCount: 1 };
        if (sql.startsWith("SELECT"))
          return { rows: [{ ...validRow, ...override }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      });
      const inbox = createSqlInboxStore(database);

      await assert.rejects(
        withTransaction(database, { mode: "background" }, (transaction) =>
          inbox.begin(transaction, message, "consumer-a", 1_000, 500),
        ),
        { code: expectedCode },
      );
    });
  }
});

void test("Inbox rejects invalid message and lease windows before SQL", async (t) => {
  const valid = inboxFixture(
    outboxFixture("inbox-invalid-input", "aggregate-inbox-invalid-input", 1),
  );
  const cases = [
    [
      "invalid received time",
      { message: { ...valid, receivedAt: "bad-time" } },
    ],
    ["invalid hash syntax", { message: { ...valid, payloadHash: "bad-hash" } }],
    [
      "mismatched payload hash",
      { message: { ...valid, payloadHash: "0".repeat(64) } },
    ],
    [
      "noncanonical payload",
      {
        message: {
          ...valid,
          payload: { bad: undefined },
          payloadHash: "0".repeat(64),
        },
      },
    ],
    ["empty lease owner", { leaseOwner: "" }],
    ["negative acquisition time", { nowMs: -1 }],
    ["zero lease duration", { leaseMs: 0 }],
    [
      "lease exceeds safe integer window",
      { nowMs: Number.MAX_SAFE_INTEGER, leaseMs: 1 },
    ],
  ];
  const { database, statements } = mockDatabase(t);
  const inbox = createSqlInboxStore(database);

  for (const [name, overrides] of cases) {
    await t.test(name, async () => {
      await assert.rejects(
        withTransaction(database, { mode: "background" }, (transaction) =>
          inbox.begin(
            transaction,
            overrides.message ?? valid,
            overrides.leaseOwner ?? "consumer-a",
            overrides.nowMs ?? 1_000,
            overrides.leaseMs ?? 500,
          ),
        ),
        { code: "INBOX_INVALID" },
      );
    });
  }
  assert.equal(
    statements.some((sql) => sql.includes('"inbox_messages"')),
    false,
  );
});

void test("Inbox distinguishes active leases from durable terminal duplicates", async (t) => {
  const payload = { stable: true };
  const message = {
    messageId: "inbox-existing-state",
    messageType: "DeliveryTest.Event",
    receivedAt: "2026-01-01T00:00:00Z",
    payload,
    payloadHash: canonicalRequestHash(payload),
  };
  for (const [state, expected] of [
    ["Processing", { kind: "in_progress", leaseUntilMs: 2_000 }],
    ["Processed", { kind: "duplicate", state: "Processed" }],
    ["Quarantined", { kind: "duplicate", state: "Quarantined" }],
  ]) {
    await t.test(state, async (subtest) => {
      const { database, statements } = mockDatabase(subtest, (sql) => {
        if (!sql.includes('"inbox_messages"')) return undefined;
        if (sql.startsWith("INSERT")) return { rows: [], rowCount: 0 };
        if (sql.startsWith("SELECT"))
          return {
            rows: [
              {
                message_id: message.messageId,
                message_type: message.messageType,
                received_at: "2026-01-01 00:00:00+00",
                payload,
                payload_hash: message.payloadHash,
                state,
                lease_owner: "old-consumer",
                lease_until_ms: "2000",
                attempt: 1,
                processed_at: null,
                quarantine_reason: null,
              },
            ],
            rowCount: 1,
          };
        return { rows: [], rowCount: 0 };
      });
      const inbox = createSqlInboxStore(database);

      assert.deepEqual(
        await withTransaction(database, { mode: "background" }, (transaction) =>
          inbox.begin(transaction, message, "new-consumer", 1_000, 500),
        ),
        expected,
      );
      assert.equal(
        statements.some((sql) => sql.includes("SET lease_owner")),
        state === "Processing",
        "only an active Processing record should attempt lease reclamation",
      );
    });
  }
});

void test("consumer Inbox rejects malformed transport envelopes before insert", async (t) => {
  const original = outboxFixture(
    "consumer-envelope-contract",
    "aggregate-consumer-envelope-contract",
    1,
  ).envelope;
  const cases = [
    [
      "unsupported envelope version",
      (envelope) => ({
        ...envelope,
        envelopeVersion: "2",
      }),
    ],
    [
      "unknown aggregate field",
      (envelope) => ({
        ...envelope,
        aggregate: { ...envelope.aggregate, tenant: "foreign" },
      }),
    ],
    [
      "control character in identifier",
      (envelope) => ({
        ...envelope,
        producer: "orders\nservice",
      }),
    ],
    [
      "zero trace identifier",
      (envelope) => ({
        ...envelope,
        traceparent: "00-00000000000000000000000000000000-bbbbbbbbbbbbbbbb-01",
      }),
    ],
    [
      "owner version zero",
      (envelope) => ({
        ...envelope,
        aggregate: { ...envelope.aggregate, version: "0" },
      }),
    ],
    [
      "owner version exceeds PostgreSQL bigint",
      (envelope) => ({
        ...envelope,
        aggregate: { ...envelope.aggregate, version: "9223372036854775808" },
      }),
    ],
  ];

  for (const [name, mutate] of cases) {
    await t.test(name, async (subtest) => {
      const envelope = mutate(original);
      const message = {
        messageId: envelope.messageId,
        messageType: envelope.messageType,
        receivedAt: envelope.occurredAt,
        payload: envelope,
        payloadHash: canonicalRequestHash(envelope),
      };
      const { database, statements } = mockDatabase(subtest);
      const inbox = createSqlInboxStore(database, {
        consumerName: "orders.lifecycle",
      });

      await assert.rejects(
        withTransaction(database, { mode: "background" }, (transaction) =>
          inbox.begin(transaction, message, "consumer-a", 1_000, 1_000),
        ),
        { code: "INBOX_INVALID" },
      );
      assert.equal(
        statements.some((sql) => sql.includes('"inbox_messages"')),
        false,
      );
    });
  }
});

void test("consumer Inbox maps a valid envelope into one acquired owner record", async (t) => {
  const envelope = {
    ...outboxFixture(
      "consumer-valid-envelope",
      "aggregate-consumer-valid-envelope",
      1,
    ).envelope,
    causationId: "cause-previous-event",
  };
  const message = {
    messageId: envelope.messageId,
    messageType: envelope.messageType,
    receivedAt: envelope.occurredAt,
    payload: envelope,
    payloadHash: canonicalRequestHash(envelope),
  };
  let insertValues;
  let row = {
    message_id: message.messageId,
    message_type: message.messageType,
    received_at: "2026-01-01 00:00:00+00",
    payload: envelope,
    payload_hash: message.payloadHash,
    state: "Processing",
    lease_owner: "consumer-a",
    lease_until_ms: 2_000,
    attempt: 1,
    processed_at: null,
    quarantine_reason: null,
  };
  const { database, statements } = mockDatabase(t, (sql, values) => {
    if (!sql.includes('"inbox_messages"')) return undefined;
    if (sql.startsWith("INSERT")) {
      insertValues = values;
      return { rows: [{ message_id: message.messageId }], rowCount: 1 };
    }
    if (sql.startsWith("SELECT")) return { rows: [row], rowCount: 1 };
    if (sql.startsWith("UPDATE") && sql.includes("state = 'Processed'")) {
      row = { ...row, state: "Processed", lease_owner: "" };
      return { rows: [{ message_id: message.messageId }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  const inbox = createSqlInboxStore(database, {
    consumerName: "orders.lifecycle",
  });

  await withTransaction(
    database,
    { mode: "background" },
    async (transaction) => {
      const acquired = await inbox.begin(
        transaction,
        message,
        "consumer-a",
        1_000,
        1_000,
      );
      assert.equal(acquired.kind, "acquired");
      if (acquired.kind !== "acquired")
        assert.fail("consumer did not acquire row");
      assert.equal(acquired.record.state, "Processing");
      assert.equal(acquired.record.leaseOwner, "consumer-a");
      assert.equal(acquired.record.message.payloadHash, message.payloadHash);
      assert.deepEqual(acquired.record.message.payload, envelope);
      assert.equal(insertValues[6], "orders.lifecycle");
      assert.equal(insertValues[9], envelope.aggregate.ref);
      assert.equal(insertValues[11], envelope.aggregate.version);

      await inbox.markProcessed(
        transaction,
        message.messageId,
        "consumer-a",
        "2026-01-01T00:00:01Z",
      );
      await assert.rejects(
        inbox.markProcessed(
          transaction,
          message.messageId,
          "consumer-a",
          "2026-01-01T00:00:02Z",
        ),
        { code: "INBOX_NOT_ACQUIRED" },
      );
    },
  );
  assert.equal(
    statements.filter((sql) => sql.includes("state = 'Processed'")).length,
    1,
    "the transaction-scoped permit is consumed by the terminal update",
  );
});

void test("Inbox suppresses duplicate and in-progress effects before handler execution", async (t) => {
  const message = inboxFixture(
    outboxFixture("inbox-consume-decision", "aggregate-consume-decision", 1),
  );
  const decisions = [
    [
      "processed duplicate",
      { kind: "duplicate", state: "Processed" },
      { kind: "duplicate" },
    ],
    [
      "quarantined duplicate",
      { kind: "duplicate", state: "Quarantined" },
      { kind: "quarantined" },
    ],
    [
      "payload conflict",
      { kind: "conflict", reason: "payload_hash_mismatch" },
      { kind: "conflict", reason: "payload_hash_mismatch" },
    ],
    [
      "active lease",
      { kind: "in_progress", leaseUntilMs: 2_000 },
      { kind: "in_progress", leaseUntilMs: 2_000 },
    ],
  ];

  for (const [name, begin, expected] of decisions) {
    await t.test(name, async (subtest) => {
      const { database } = mockDatabase(subtest);
      let handlerCalls = 0;
      let markCalls = 0;
      const store = {
        begin: async () => begin,
        markProcessed: async () => {
          markCalls += 1;
        },
      };

      const actual = await withTransaction(
        database,
        { mode: "interactive" },
        (transaction) =>
          consumeOnce(
            store,
            transaction,
            message,
            "consumer-a",
            1_000,
            500,
            async () => {
              handlerCalls += 1;
            },
            "2026-01-01T00:00:01Z",
          ),
      );
      assert.deepEqual(actual, expected);
      assert.equal(handlerCalls, 0);
      assert.equal(markCalls, 0);
    });
  }
});

void test("Inbox quarantine and release require the same live transaction permit", async (t) => {
  const { database, snapshot } = deliverySqlDatabase(t);
  const inbox = createSqlInboxStore(database);
  const quarantined = inboxFixture(
    outboxFixture("inbox-quarantine-permit", "aggregate-inbox-permit-q", 1),
  );
  const released = inboxFixture(
    outboxFixture("inbox-release-permit", "aggregate-inbox-permit-r", 1),
  );
  const expired = inboxFixture(
    outboxFixture("inbox-release-fenced", "aggregate-inbox-fenced", 1),
  );
  const clockAdvance = inboxFixture(
    outboxFixture("inbox-release-clock", "aggregate-inbox-clock", 1),
  );

  await withTransaction(
    database,
    { mode: "background" },
    async (transaction) => {
      assert.equal(
        (await inbox.begin(transaction, quarantined, "consumer-q", 100, 10))
          .kind,
        "acquired",
      );
      await assert.rejects(
        inbox.quarantine(
          {},
          quarantined.messageId,
          "consumer-q",
          "bad payload",
        ),
        { code: "INBOX_NOT_ACQUIRED" },
      );
      await inbox.quarantine(
        transaction,
        quarantined.messageId,
        "consumer-q",
        "invalid payload",
      );
      await assert.rejects(
        inbox.quarantine(
          transaction,
          quarantined.messageId,
          "consumer-q",
          "second attempt",
        ),
        { code: "INBOX_NOT_ACQUIRED" },
      );

      assert.equal(
        (await inbox.begin(transaction, released, "consumer-r", 200, 10)).kind,
        "acquired",
      );
      await inbox.release(transaction, released.messageId, "consumer-r");
      await assert.rejects(
        inbox.release(transaction, released.messageId, "consumer-r"),
        { code: "INBOX_NOT_ACQUIRED" },
      );

      assert.equal(
        (await inbox.begin(transaction, expired, "consumer-expired", 300, 10))
          .kind,
        "acquired",
      );
      await inbox.begin(transaction, clockAdvance, "clock-advance", 1_000, 10);
      await assert.rejects(
        inbox.release(transaction, expired.messageId, "consumer-expired"),
        { code: "INBOX_LEASE_INVALID" },
      );
    },
  );

  assert.equal(
    snapshot().inbox.get(quarantined.messageId).state,
    "Quarantined",
  );
  assert.equal(
    snapshot().inbox.get(quarantined.messageId).quarantine_reason,
    "invalid payload",
  );
  assert.equal(snapshot().inbox.has(released.messageId), false);
  assert.equal(snapshot().inbox.get(expired.messageId).state, "Processing");
});

void test("Inbox quarantine deduplicates an offset and detects changed envelope content", async (t) => {
  const { database, snapshot } = deliverySqlDatabase(t);
  const inbox = createSqlInboxStore(database);
  const record = {
    topic: "coffee.orders.lifecycle.v1",
    partition: 1,
    offset: "42",
    messageId: "quarantined-message",
    messageType: "Orders.LifecycleChanged",
    envelope: { value: "original" },
    reason: "INVALID_ENVELOPE",
  };
  const disposition = (value) =>
    withTransaction(database, { mode: "background" }, (transaction) =>
      inbox.quarantineRecord(transaction, value, 1_000),
    );
  assert.equal(await disposition(record), "created");
  assert.equal(await disposition(record), "duplicate");
  assert.equal(
    await disposition({
      ...record,
      envelope: { value: "changed" },
    }),
    "conflict",
  );
  assert.equal(snapshot().quarantine.size, 1);
});

void test("Inbox rejects invalid quarantine facts before durable evidence writes", async (t) => {
  const { database, statements } = mockDatabase(t);
  const inbox = createSqlInboxStore(database);
  const valid = {
    topic: "coffee.orders.lifecycle.v1",
    partition: 0,
    offset: "42",
    reason: "INVALID_ENVELOPE",
  };
  const invalidRecords = [
    { topic: "", partition: 0, offset: "42", reason: valid.reason },
    { ...valid, partition: -1 },
    { ...valid, offset: "" },
    { ...valid, messageId: "" },
    { ...valid, messageType: "" },
    { ...valid, payloadHash: "not-a-hash" },
    { ...valid, reason: "" },
    { ...valid, reason: "x".repeat(513) },
    { ...valid, envelope: { nonJson: undefined } },
  ];

  for (const record of invalidRecords) {
    await assert.rejects(
      withTransaction(database, { mode: "background" }, (transaction) =>
        inbox.quarantineRecord(transaction, record, 1_000),
      ),
      { code: "INBOX_INVALID" },
    );
  }
  assert.equal(
    statements.some((sql) => sql.includes('"inbox_quarantine"')),
    false,
    "malformed offset evidence must not be persisted",
  );
});

void test("consumer Inbox retains an invalid full envelope as quarantine evidence", async (t) => {
  const record = {
    topic: "coffee.orders.lifecycle.v1",
    partition: 2,
    offset: "91",
    envelope: { envelopeVersion: "unsupported", body: "retain-for-operator" },
    reason: "INVALID_ENVELOPE",
  };
  let insertValues;
  const { database, statements } = mockDatabase(t, (sql, values) => {
    if (!sql.includes('"inbox_quarantine"')) return undefined;
    if (sql.startsWith("INSERT")) {
      insertValues = values;
      return { rows: [{ topic: record.topic }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  const inbox = createSqlInboxStore(database, {
    consumerName: "orders.lifecycle",
  });

  assert.equal(
    await withTransaction(database, { mode: "background" }, (transaction) =>
      inbox.quarantineRecord(transaction, record, 1_000),
    ),
    "created",
  );
  assert.equal(insertValues[0], "orders.lifecycle");
  assert.equal(insertValues[1], record.topic);
  assert.equal(insertValues[2], record.partition);
  assert.equal(insertValues[3], record.offset);
  assert.equal(insertValues[4], null, "unparsed identity is not invented");
  assert.equal(insertValues[5], null);
  assert.equal(insertValues[6], null);
  assert.equal(insertValues[7], null);
  assert.equal(insertValues[8], null);
  assert.equal(insertValues[9], canonicalRequestHash(record.envelope));
  assert.deepEqual(JSON.parse(insertValues[10]), record.envelope);
  assert.equal(
    statements.some((sql) => sql.includes('"inbox_messages"')),
    false,
  );
});

void test("consumer Inbox quarantine scopes an offset and canonical envelope hash", async (t) => {
  const inserted = [];
  let storedEnvelopeHash;
  const { database } = mockDatabase(t, (sql, values) => {
    if (!sql.includes('"inbox_quarantine"')) return undefined;
    if (sql.startsWith("INSERT")) {
      inserted.push(values);
      if (storedEnvelopeHash !== undefined) return { rows: [], rowCount: 0 };
      storedEnvelopeHash = values[9];
      return { rows: [{ topic: values[1] }], rowCount: 1 };
    }
    return {
      rows: [{ payload_hash: storedEnvelopeHash }],
      rowCount: storedEnvelopeHash === undefined ? 0 : 1,
    };
  });
  const inbox = createSqlInboxStore(database, {
    consumerName: "orders.lifecycle",
  });
  const envelope = outboxFixture(
    "consumer-quarantine-message",
    "aggregate-consumer-quarantine",
    1,
  ).envelope;
  const record = {
    topic: "coffee.orders.lifecycle.v1",
    partition: 2,
    offset: "42",
    messageId: envelope.messageId,
    messageType: envelope.messageType,
    envelope,
    reason: "INBOX_HASH_CONFLICT",
  };
  const disposition = (value) =>
    withTransaction(database, { mode: "background" }, (transaction) =>
      inbox.quarantineRecord(transaction, value, 1_000),
    );

  assert.equal(await disposition(record), "created");
  assert.equal(await disposition(record), "duplicate");
  assert.equal(
    await disposition({
      ...record,
      envelope: { ...envelope, payload: { value: "changed" } },
    }),
    "conflict",
  );
  assert.equal(inserted.length, 3);
  assert.equal(inserted[0][0], "orders.lifecycle");
  assert.equal(inserted[0][1], record.topic);
  assert.equal(inserted[0][2], record.partition);
  assert.equal(inserted[0][3], record.offset);
  assert.equal(inserted[0][11], "MESSAGE_ID_PAYLOAD_CONFLICT");
});

void test("consumer Inbox does not treat a persisted quarantine hash mismatch as duplicate", async (t) => {
  const { database } = mockDatabase(t, (sql) => {
    if (!sql.includes('"inbox_quarantine"')) return undefined;
    if (sql.startsWith("INSERT")) return { rows: [], rowCount: 0 };
    return { rows: [{ payload_hash: "corrupt-persisted-hash" }], rowCount: 1 };
  });
  const inbox = createSqlInboxStore(database, {
    consumerName: "orders.lifecycle",
  });
  const envelope = outboxFixture(
    "consumer-quarantine-corrupt-row",
    "aggregate-consumer-quarantine-corrupt",
    1,
  ).envelope;

  await withTransaction(
    database,
    { mode: "background" },
    async (transaction) => {
      assert.equal(
        await inbox.quarantineRecord(
          transaction,
          {
            topic: "coffee.orders.lifecycle.v1",
            partition: 0,
            offset: "91",
            messageId: envelope.messageId,
            messageType: envelope.messageType,
            envelope,
            reason: "INVALID_ENVELOPE",
          },
          1_000,
        ),
        "conflict",
      );
    },
  );
});

void test("idempotency canonical request hash preserves JSON identity without prototype collisions", () => {
  assert.equal(
    canonicalRequestHash({ b: [1, { z: false, a: null }], a: "x" }),
    canonicalRequestHash({ a: "x", b: [1, { a: null, z: false }] }),
  );
  assert.notEqual(
    canonicalRequestHash(JSON.parse('{"__proto__":{"a":1}}')),
    canonicalRequestHash({}),
  );
  const cyclic = {};
  cyclic.self = cyclic;
  const cyclicArray = [];
  cyclicArray.push(cyclicArray);
  const symbolKeyed = { value: 1 };
  symbolKeyed[Symbol("not-json")] = 2;
  for (const invalid of [
    undefined,
    { key: undefined },
    NaN,
    Infinity,
    Symbol("not-json"),
    1n,
    cyclic,
    cyclicArray,
    symbolKeyed,
    new Map(),
    Array(2),
  ]) {
    assert.throws(() => canonicalRequestHash(invalid), TypeError);
  }
});

void test("idempotency SQL decisions, tx-bound complete, expiry never reacquires, JSON null/string replay", async (t) => {
  const { database, statements } = idempotencyDatabase(t);
  const store = createSqlIdempotencyStore(database);
  const identity = { actorRef: "actor", scope: "owner:create", key: "same" };
  const hash = canonicalRequestHash({ name: "coffee" });
  await withTransaction(database, { mode: "interactive" }, async (tx) => {
    for (const [invalidIdentity, invalidHash, nowMs, leaseMs, retentionMs] of [
      [{ ...identity, scope: "" }, hash, 1_000, 30_000, 60_000],
      [identity, "not-a-sha256", 1_000, 30_000, 60_000],
      [identity, hash, 1_000, 60_001, 60_000],
      [identity, hash, Number.MAX_SAFE_INTEGER, 1, 1],
    ]) {
      await assert.rejects(
        store.acquire(
          tx,
          invalidIdentity,
          invalidHash,
          "lease",
          nowMs,
          leaseMs,
          retentionMs,
        ),
        { code: "IDEMPOTENCY_RECORD_INVALID" },
      );
    }
    assert.equal(
      statements.filter((sql) => sql.includes('"idempotency_records"')).length,
      0,
      "invalid claim inputs must be rejected before persistence",
    );
  });
  for (const [index, body] of [null, "plain string"].entries()) {
    const id = { ...identity, key: String(index) };
    await withTransaction(database, { mode: "interactive" }, async (tx) => {
      assert.equal(
        (await store.acquire(tx, id, hash, "lease", 1000, 30000, 60000)).kind,
        "acquired",
      );
      assert.equal(
        (await store.acquire(tx, id, hash, "lease", 1000, 30000, 60000)).kind,
        "in_progress",
      );
      await store.complete(tx, id, "lease", { status: 201, body });
      await assert.rejects(
        store.complete(tx, id, "lease", { status: 201, body }),
        { code: "IDEMPOTENCY_NOT_ACQUIRED" },
      );
    });
    await withTransaction(database, { mode: "interactive" }, async (tx) => {
      assert.deepEqual(
        await store.acquire(tx, id, hash, "other", 1001, 30000, 60000),
        { kind: "replay", response: { status: 201, body } },
      );
      assert.equal(
        (
          await store.acquire(
            tx,
            id,
            canonicalRequestHash({ different: true }),
            "other",
            1001,
            30000,
            60000,
          )
        ).kind,
        "conflict",
      );
    });
  }
  await withTransaction(database, { mode: "interactive" }, async (tx) => {
    assert.equal(
      (await store.acquire(tx, identity, hash, "lease", 1000, 30000, 60000))
        .kind,
      "acquired",
    );
  });
  await withTransaction(database, { mode: "interactive" }, async (tx) => {
    assert.equal(
      (await store.acquire(tx, identity, hash, "lease", 100000, 30000, 60000))
        .kind,
      "in_progress",
    );
    await assert.rejects(
      store.complete(tx, identity, "lease", { status: 200, body: null }),
      { code: "IDEMPOTENCY_NOT_ACQUIRED" },
    );
  });
});

void test("idempotency caught SQL error -> COMMIT ROLLBACK never publishes Completed or false Replay", async (t) => {
  const { database, releases } = idempotencyDatabase(t);
  const store = createSqlIdempotencyStore(database);
  const failSql = defineStatement(database, "SELECT 1/0");
  const identity = {
    actorRef: "actor",
    scope: "owner:create",
    key: "rolled-back",
  };
  const hash = canonicalRequestHash({ request: 1 });
  await assert.rejects(
    withTransaction(database, { mode: "interactive" }, async (tx) => {
      assert.equal(
        (await store.acquire(tx, identity, hash, "lease", 1000, 30000, 60000))
          .kind,
        "acquired",
      );
      await store.complete(tx, identity, "lease", {
        status: 201,
        body: { id: 1 },
      });
      await assert.rejects(failSql(tx, []), { code: "DB_QUERY_FAILED" });
    }),
    { code: "DB_TRANSACTION_ROLLED_BACK" },
  );
  await withTransaction(database, { mode: "interactive" }, async (tx) => {
    assert.equal(await store.get(tx, identity), undefined);
    assert.equal(
      (
        await store.acquire(
          tx,
          identity,
          hash,
          "retry-after-known-rollback",
          1001,
          30000,
          60000,
        )
      ).kind,
      "acquired",
    );
    await store.complete(tx, identity, "retry-after-known-rollback", {
      status: 201,
      body: { id: 2 },
    });
  });
  assert.deepEqual(releases, [false, false]);
});

void test("idempotency DB lease fence rejects completion and leaves request in progress", async (t) => {
  let row;
  const { database } = mockDatabase(t, (sql, values) => {
    if (!sql.includes('"idempotency_records"')) return undefined;
    if (sql.startsWith("INSERT")) {
      if (row !== undefined) return { rows: [], rowCount: 0 };
      row = {
        actor_ref: values[0],
        scope: values[1],
        idempotency_key: values[2],
        request_hash: values[3],
        state: "Acquired",
        lease_owner: values[4],
        lease_until_ms: values[5],
        expires_at_ms: values[7],
        response_status: null,
        response_body: null,
        resource_ref: null,
      };
      return { rows: [{ idempotency_key: values[2] }], rowCount: 1 };
    }
    if (sql.startsWith("SELECT"))
      return { rows: row === undefined ? [] : [row], rowCount: row ? 1 : 0 };
    if (sql.startsWith("UPDATE")) return { rows: [], rowCount: 0 };
    return undefined;
  });
  const store = createSqlIdempotencyStore(database);
  const identity = { actorRef: "actor", scope: "owner:create", key: "fenced" };
  const requestHash = canonicalRequestHash({ name: "coffee" });

  await withTransaction(
    database,
    { mode: "interactive" },
    async (transaction) => {
      assert.equal(
        (
          await store.acquire(
            transaction,
            identity,
            requestHash,
            "lease-owner",
            1_000,
            30_000,
            60_000,
          )
        ).kind,
        "acquired",
      );
      await assert.rejects(
        store.complete(transaction, identity, "lease-owner", {
          status: 201,
          body: { id: "created" },
        }),
        { code: "IDEMPOTENCY_NOT_ACQUIRED" },
      );
    },
  );

  await withTransaction(
    database,
    { mode: "interactive" },
    async (transaction) => {
      assert.equal(
        (
          await store.acquire(
            transaction,
            identity,
            requestHash,
            "retry-owner",
            1_001,
            30_000,
            60_000,
          )
        ).kind,
        "in_progress",
      );
      assert.equal(row.state, "Acquired");
      assert.equal(row.response_status, null);
    },
  );
});

void test("idempotency refuses to replay a Completed row without its response status", async (t) => {
  const identity = {
    actorRef: "actor",
    scope: "owner:create",
    key: "bad-completed",
  };
  const requestHash = canonicalRequestHash({ request: 1 });
  const validRow = {
    actor_ref: identity.actorRef,
    scope: identity.scope,
    idempotency_key: identity.key,
    request_hash: requestHash,
    state: "Completed",
    lease_owner: "original-owner",
    lease_until_ms: "2000",
    expires_at_ms: "60000",
    response_status: 201,
    response_body: { id: "created-resource" },
    resource_ref: "created-resource",
  };
  for (const [name, override] of [
    ["missing response status", { response_status: null }],
    ["invalid response status", { response_status: 99 }],
    ["invalid persisted lease timestamp", { lease_until_ms: "invalid" }],
    ["unknown persisted state", { state: "Finalized" }],
    ["malformed resource reference", { resource_ref: { id: "not-a-string" } }],
  ]) {
    await t.test(name, async (subtest) => {
      const { database } = mockDatabase(subtest, (sql) => {
        if (!sql.includes('"idempotency_records"')) return undefined;
        if (sql.startsWith("INSERT")) return { rows: [], rowCount: 0 };
        if (sql.startsWith("SELECT"))
          return { rows: [{ ...validRow, ...override }], rowCount: 1 };
        return undefined;
      });
      const store = createSqlIdempotencyStore(database);

      await withTransaction(
        database,
        { mode: "interactive" },
        async (transaction) => {
          await assert.rejects(store.get(transaction, identity), {
            code: "IDEMPOTENCY_RECORD_INVALID",
          });
          await assert.rejects(
            store.acquire(
              transaction,
              identity,
              requestHash,
              "retry-owner",
              1_000,
              1_000,
              60_000,
            ),
            { code: "IDEMPOTENCY_RECORD_INVALID" },
          );
        },
      );
    });
  }
});

void test("idempotency cannot complete a durable claim with an invalid response", async (t) => {
  const identity = {
    actorRef: "actor",
    scope: "owner:create",
    key: "invalid-response",
  };
  const requestHash = canonicalRequestHash({ request: 1 });
  for (const [name, response] of [
    ["status outside HTTP range", { status: 99, body: null }],
    ["undefined body", { status: 201, body: undefined }],
    ["non-JSON body", { status: 201, body: 1n }],
  ]) {
    await t.test(name, async (subtest) => {
      const { database, statements } = idempotencyDatabase(subtest);
      const store = createSqlIdempotencyStore(database);

      await withTransaction(
        database,
        { mode: "interactive" },
        async (transaction) => {
          assert.equal(
            (
              await store.acquire(
                transaction,
                identity,
                requestHash,
                "lease-owner",
                1_000,
                30_000,
                60_000,
              )
            ).kind,
            "acquired",
          );
          await assert.rejects(
            store.complete(transaction, identity, "lease-owner", response),
            { code: "IDEMPOTENCY_RECORD_INVALID" },
          );
        },
      );
      assert.equal(
        statements.some((sql) => sql.startsWith("UPDATE")),
        false,
        "invalid response must not transition Acquired to Completed",
      );
    });
  }
});

void test("migrations checksum ledger is an immutable applied prefix in one owner transaction", async (t) => {
  const first = { id: "0001_first", sql: "CREATE TABLE proof (id integer)" };
  first.checksum = migrationChecksum(first.sql);
  const second = {
    id: "0002_second",
    sql: "ALTER TABLE proof ADD COLUMN name text",
  };
  second.checksum = migrationChecksum(second.sql);
  let ledger = [];
  const { database, statements } = mockDatabase(t, (sql) =>
    sql.startsWith("SELECT id, checksum")
      ? { rows: ledger, rowCount: ledger.length }
      : undefined,
  );
  const beforeInvalidMigrations = statements.length;
  for (const [migrations, code] of [
    [[{ ...first, id: "first" }], "MIGRATION_INVALID"],
    [[second, first], "MIGRATION_INVALID"],
    [
      [{ ...first, sql: `${first.sql}; -- changed` }],
      "MIGRATION_CHECKSUM_DRIFT",
    ],
  ]) {
    await assert.rejects(applyMigrations(database, migrations), { code });
    assert.equal(statements.length, beforeInvalidMigrations);
  }
  assert.deepEqual(await applyMigrations(database, [first, second]), [
    first.id,
    second.id,
  ]);
  assert.equal(statements.filter((sql) => sql === "BEGIN").length, 1);
  assert.equal(statements.at(-1), "COMMIT");
  ledger = [first, second];
  assert.deepEqual(await applyMigrations(database, [first, second]), []);
  for (const [rows, code] of [
    [[{ ...first, checksum: "0".repeat(64) }], "MIGRATION_CHECKSUM_DRIFT"],
    [[{ ...first, checksum: "" }], "MIGRATION_MISSING_CHECKSUM"],
    [[{ id: 1, checksum: first.checksum }], "MIGRATION_ORPHAN"],
    [[first, first], "MIGRATION_ORPHAN"],
    [[second], "MIGRATION_NON_PREFIX"],
    [
      [first, second, { id: "0003_unknown", checksum: first.checksum }],
      "MIGRATION_ORPHAN",
    ],
  ]) {
    ledger = rows;
    await assert.rejects(applyMigrations(database, [first, second]), { code });
    assert.equal(statements.at(-1), "ROLLBACK");
  }
  await assert.rejects(
    applyMigrations(database, [{ ...first, checksum: "" }]),
    { code: "MIGRATION_MISSING_CHECKSUM" },
  );
});

void test("OrderStore SQL boundary creates a draft, reads its card, and replays the idempotent result", async (t) => {
  const identity = {
    actorRef: "orders-platform-test",
    scope: "a".repeat(64),
    key: "00000000-0000-4000-8000-000000000041",
  };
  const invalidReplayIdentity = {
    actorRef: identity.actorRef,
    scope: "c".repeat(64),
    key: "00000000-0000-4000-8000-000000000045",
  };
  const customer = {
    customerRef: "cus_00000000000000000000000001",
    customerVersion: "2",
    displayName: "Покупатель",
    state: "Active",
  };
  const correlationId = "00000000-0000-4000-8000-000000000042";
  const command = {
    actorRef: identity.actorRef,
    identity,
    correlationId,
    customer,
    cardPermissions: ["orders:edit:any"],
  };
  let record;
  let order;
  let invalidOrderDate = false;
  const timestamp = new Date("2026-10-25T08:00:00.000Z");
  const { database, statements } = mockDatabase(t, (sql, values) => {
    if (
      sql === "BEGIN" ||
      sql === "COMMIT" ||
      sql === "ROLLBACK" ||
      sql.startsWith("SET LOCAL ")
    )
      return undefined;
    if (sql.startsWith('INSERT INTO "orders"."idempotency_records"')) {
      if (record !== undefined)
        return { rows: [], rowCount: 0, command: "INSERT" };
      record = {
        actor_ref: values[0],
        scope: values[1],
        idempotency_key: values[2],
        request_hash: values[3],
        state: "Acquired",
        lease_owner: values[4],
        lease_until_ms: String(values[5]),
        expires_at_ms: String(values[7]),
        response_status: null,
        response_body: null,
        resource_ref: null,
      };
      return {
        rows: [{ idempotency_key: values[2] }],
        rowCount: 1,
        command: "INSERT",
      };
    }
    if (sql.includes('FROM "orders"."idempotency_records"')) {
      if (values[2] === invalidReplayIdentity.key)
        return {
          rows: [
            {
              actor_ref: invalidReplayIdentity.actorRef,
              scope: invalidReplayIdentity.scope,
              idempotency_key: invalidReplayIdentity.key,
              request_hash: "invalid",
              state: "Completed",
              lease_owner: "orders-test-lease",
              lease_until_ms: "4102444800000",
              expires_at_ms: "4102444800000",
              response_status: 201,
              response_body: {},
              resource_ref: null,
            },
          ],
          rowCount: 1,
          command: "SELECT",
        };
      if (values[2] === identity.key)
        assert.deepEqual(values, [
          identity.actorRef,
          identity.scope,
          identity.key,
        ]);
      return {
        rows:
          record !== undefined && values[2] === identity.key ? [record] : [],
        rowCount: record !== undefined && values[2] === identity.key ? 1 : 0,
        command: "SELECT",
      };
    }
    if (sql.includes('UPDATE "orders"."idempotency_records"')) {
      record = {
        ...record,
        state: "Completed",
        response_status: values[4],
        response_body: JSON.parse(values[5]),
        resource_ref: values[6],
      };
      return {
        rows: [{ idempotency_key: identity.key }],
        rowCount: 1,
        command: "UPDATE",
      };
    }
    if (sql.includes("AS now_ms"))
      return {
        rows: [{ now_ms: String(timestamp.getTime()) }],
        rowCount: 1,
        command: "SELECT",
      };
    if (sql.startsWith("INSERT INTO orders.orders")) {
      order = {
        order_ref: values[0],
        status: "Draft",
        version: "1",
        projection_version: "1",
        customer_ref: values[1],
        customer_version: values[2],
        customer_display_name: values[3],
        customer_state: "Active",
        customer_state_proof_hash: values[4],
        currency: null,
        confirmed_at: null,
        created_at: timestamp,
        updated_at: timestamp,
        created_by_actor_ref: values[5],
        last_modified_by_actor_ref: values[5],
      };
      return { rows: [], rowCount: 1, command: "INSERT" };
    }
    if (sql.startsWith("INSERT INTO orders.order_history"))
      return { rows: [], rowCount: 1, command: "INSERT" };
    if (sql.includes("FROM orders.orders WHERE order_ref=$1 FOR SHARE")) {
      assert.equal(values[0], order?.order_ref);
      return {
        rows:
          order === undefined
            ? []
            : [
                {
                  ...order,
                  created_at: invalidOrderDate ? "invalid" : order.created_at,
                },
              ],
        rowCount: order === undefined ? 0 : 1,
        command: "SELECT",
      };
    }
    if (sql.includes("FROM orders.order_items WHERE order_ref=$1"))
      return { rows: [], rowCount: 0, command: "SELECT" };
    if (sql.includes("orders.read_card_projection"))
      return { rows: [], rowCount: 0, command: "SELECT" };
    assert.fail(`unexpected OrderStore query: ${sql}`);
  });
  const store = new OrderStore(database);

  const created = await store.createDraft(command);
  assert.equal(created.status, 201);
  assert.equal(created.replayed, false);
  assert.equal(created.body.status, "Draft");
  assert.equal(created.body.customer.customerRef, customer.customerRef);
  assert.deepEqual(created.body.allowedActions, ["edit-items"]);
  assert.equal(record.state, "Completed");
  assert.deepEqual(record.response_body, created.body);

  assert.deepEqual(
    await store.getCard(created.body.orderRef, {
      correlationId,
      permissions: command.cardPermissions,
    }),
    created.body,
  );
  assert.deepEqual(
    await store.precheck(
      identity,
      hashOrderDraftRequest(customer.customerRef),
      correlationId,
    ),
    {
      kind: "completed",
      response: {
        status: 201,
        body: created.body,
        resourceRef: created.body.orderRef,
      },
    },
  );
  assert.deepEqual(await store.replay(identity, undefined, correlationId), {
    kind: "completed",
    response: {
      status: 201,
      body: created.body,
      resourceRef: created.body.orderRef,
    },
  });
  const completedRecord = structuredClone(record);
  const writesBeforeLookups = statements.filter((sql) =>
    /^(?:INSERT|UPDATE|DELETE) /u.test(sql),
  ).length;
  const draftHash = hashOrderDraftRequest(customer.customerRef);
  for (const [changes, hash, expected] of [
    [{}, "b".repeat(64), "conflict"],
    [
      {
        state: "Acquired",
        response_status: null,
        response_body: null,
        resource_ref: null,
      },
      draftHash,
      "in_progress",
    ],
    [{ expires_at_ms: "0" }, draftHash, "not_retained"],
    [{ response_body: {} }, draftHash, "invalid"],
    [{ resource_ref: "ord_00000000000000000000000002" }, draftHash, "invalid"],
    [{ response_status: 202 }, draftHash, "invalid"],
  ]) {
    record = { ...completedRecord, ...changes };
    const before = statements.length;
    assert.deepEqual(await store.precheck(identity, hash, correlationId), {
      kind: expected,
    });
    assert.deepEqual(
      await store.preflightPut(
        identity,
        hash,
        created.body.orderRef,
        command.cardPermissions,
        correlationId,
      ),
      { kind: expected },
    );
    if (expected !== "conflict") {
      assert.deepEqual(await store.replay(identity, undefined, correlationId), {
        kind: expected,
      });
    }
    assert.equal(
      statements
        .slice(before)
        .some((sql) => sql.includes("FROM orders.orders")),
      false,
      "retained-result failures must not read the order card",
    );
  }
  record = completedRecord;
  assert.equal(
    statements.filter((sql) => /^(?:INSERT|UPDATE|DELETE) /u.test(sql)).length,
    writesBeforeLookups,
  );
  const absentIdentity = {
    actorRef: identity.actorRef,
    scope: "b".repeat(64),
    key: "00000000-0000-4000-8000-000000000043",
  };
  assert.deepEqual(
    await store.precheck(absentIdentity, "c".repeat(64), correlationId),
    { kind: "proceed" },
  );
  assert.deepEqual(
    await store.replay(absentIdentity, undefined, correlationId),
    { kind: "not_retained" },
  );
  assert.deepEqual(
    await store.replay(invalidReplayIdentity, undefined, correlationId),
    { kind: "invalid" },
  );
  assert.deepEqual(
    await store.preflightPut(
      absentIdentity,
      "c".repeat(64),
      created.body.orderRef,
      command.cardPermissions,
      correlationId,
    ),
    { kind: "proceed", customerRef: customer.customerRef },
  );
  const abortedPreflight = new AbortController();
  abortedPreflight.abort();
  assert.deepEqual(
    await store.preflightPut(
      absentIdentity,
      "c".repeat(64),
      created.body.orderRef,
      command.cardPermissions,
      correlationId,
      abortedPreflight.signal,
    ),
    { kind: "lookup_unavailable" },
  );
  assert.deepEqual(await store.createDraft(command), {
    ...created,
    replayed: true,
  });
  assert.equal(
    statements.filter((sql) => sql.startsWith("INSERT INTO orders.orders"))
      .length,
    1,
  );
  assert.equal(statements.filter((sql) => sql === "ROLLBACK").length, 1);

  await assert.rejects(
    store.createDraft({
      ...command,
      customer: { ...customer, customerRef: "cus_00000000000000000000000002" },
    }),
    { message: "IDEMPOTENCY_CONFLICT" },
  );
  invalidOrderDate = true;
  await assert.rejects(
    store.preflightPut(
      absentIdentity,
      "c".repeat(64),
      created.body.orderRef,
      command.cardPermissions,
      correlationId,
    ),
    { message: "ORDER_DATABASE_DECODE_ERROR" },
  );
  await assert.rejects(
    store.getCard(created.body.orderRef, {
      correlationId,
      permissions: command.cardPermissions,
    }),
    { message: "ORDER_DATABASE_DECODE_ERROR" },
  );
  assert.equal(statements.filter((sql) => sql === "ROLLBACK").length, 4);
});

void test("OrderStore item and confirm commands persist versioned facts once and roll back rejected writes", async (t) => {
  const orderRef = "ord_00000000000000000000000011";
  const customerRef = "cus_00000000000000000000000011";
  const actorRef = "orders-platform-test";
  const scope = "d".repeat(64);
  const correlationId = "00000000-0000-4000-8000-000000000044";
  const now = new Date();
  let keyNumber = 50;
  const meta = () => ({
    actorRef,
    identity: {
      actorRef,
      scope,
      key: `00000000-0000-4000-8000-${String(keyNumber++).padStart(12, "0")}`,
    },
    correlationId,
    cardPermissions: ["orders:edit:any", "orders:confirm:any"],
  });
  const proof = (
    n,
    quoteExpiresAt = Temporal.Now.instant().add({ hours: 1 }).toString(),
  ) => ({
    productRef: "prd_00000000000000000000000011",
    variantRef: "var_00000000000000000000000011",
    productDisplayName: "Кофе",
    unit: "piece",
    quantityMilli: "2500",
    quoteRef: `prq_${String(n).padStart(26, "0")}`,
    quoteLineNumber: 1,
    quoteHash: "e".repeat(64),
    internalProofHash: "f".repeat(64),
    quoteExpiresAt,
    policyVersionRef: "pvr_00000000000000000000000011",
    catalogSnapshotRevision: "1",
    mappingRevision: "2",
    offerRef: `off_${String(n).padStart(26, "0")}`,
    unitMinor: "150",
    lineTotalMinor: "375",
    currency: "RUB",
  });
  const request = (expectedVersion, item) => ({
    expectedVersion,
    productRef: item.productRef,
    variantRef: item.variantRef,
    quantity: "2.5",
    quoteRef: item.quoteRef,
    quoteLineNumber: item.quoteLineNumber,
    quoteHash: item.quoteHash,
    ...(item.sourceGrindKeyHash === undefined
      ? {}
      : { sourceGrindKeyHash: item.sourceGrindKeyHash }),
  });
  let order = {
    order_ref: orderRef,
    status: "Draft",
    version: "1",
    projection_version: "1",
    customer_ref: customerRef,
    customer_version: "2",
    customer_display_name: "Покупатель",
    customer_state: "Active",
    customer_state_proof_hash: "a".repeat(64),
    currency: null,
    confirmed_at: null,
    created_at: now,
    updated_at: now,
    created_by_actor_ref: actorRef,
    last_modified_by_actor_ref: actorRef,
  };
  let items = [];
  let records = new Map();
  let history = [];
  let desired = [];
  let outbox = [];
  let aromaRow;
  let failOutbox = false;
  let transactionSnapshot;
  const recordKey = (actor, identityScope, key) =>
    `${actor}\0${identityScope}\0${key}`;
  const { database, statements } = mockDatabase(t, (sql, values) => {
    if (sql === "BEGIN") {
      transactionSnapshot = structuredClone({
        order,
        items,
        records: [...records],
        history,
        desired,
        outbox,
      });
      return undefined;
    }
    if (sql === "COMMIT") {
      transactionSnapshot = undefined;
      return undefined;
    }
    if (sql === "ROLLBACK") {
      assert.ok(
        transactionSnapshot,
        "rollback must follow a started transaction",
      );
      ({ order, items, history, desired, outbox } = transactionSnapshot);
      records = new Map(transactionSnapshot.records);
      transactionSnapshot = undefined;
      return undefined;
    }
    if (sql.startsWith("SET LOCAL ")) return undefined;
    if (sql.startsWith('INSERT INTO "orders"."idempotency_records"')) {
      const key = recordKey(values[0], values[1], values[2]);
      if (records.has(key)) return { rows: [], rowCount: 0, command: "INSERT" };
      records.set(key, {
        actor_ref: values[0],
        scope: values[1],
        idempotency_key: values[2],
        request_hash: values[3],
        state: "Acquired",
        lease_owner: values[4],
        lease_until_ms: String(values[5]),
        expires_at_ms: String(values[7]),
        response_status: null,
        response_body: null,
        resource_ref: null,
      });
      return {
        rows: [{ idempotency_key: values[2] }],
        rowCount: 1,
        command: "INSERT",
      };
    }
    if (sql.includes('FROM "orders"."idempotency_records"')) {
      const row = records.get(recordKey(values[0], values[1], values[2]));
      return {
        rows: row === undefined ? [] : [row],
        rowCount: row === undefined ? 0 : 1,
        command: "SELECT",
      };
    }
    if (sql.includes('UPDATE "orders"."idempotency_records"')) {
      const key = recordKey(values[0], values[1], values[2]);
      const row = records.get(key);
      assert.ok(row, "only an acquired idempotency row can be completed");
      records.set(key, {
        ...row,
        state: "Completed",
        response_status: values[4],
        response_body: JSON.parse(values[5]),
        resource_ref: values[6],
      });
      return {
        rows: [{ idempotency_key: values[2] }],
        rowCount: 1,
        command: "UPDATE",
      };
    }
    if (sql.includes("AS now_ms"))
      return {
        rows: [{ now_ms: String(Date.now()) }],
        rowCount: 1,
        command: "SELECT",
      };
    if (
      sql.includes("orders.orders WHERE order_ref=$1 FOR UPDATE") ||
      sql.includes("orders.orders WHERE order_ref=$1 FOR SHARE")
    ) {
      assert.equal(values[0], orderRef);
      return { rows: [{ ...order }], rowCount: 1, command: "SELECT" };
    }
    if (
      sql.includes(
        "orders.order_items WHERE order_ref=$1 ORDER BY line_position",
      )
    )
      return {
        rows: items.map((item) => ({ ...item })),
        rowCount: items.length,
        command: "SELECT",
      };
    if (sql.includes("$1::timestamptz > transaction_timestamp() AS valid"))
      return {
        rows: [{ valid: new Date(values[0]).getTime() > Date.now() }],
        rowCount: 1,
        command: "SELECT",
      };
    if (sql.includes("generate_series(1,100)")) {
      const positions = new Set(items.map((item) => item.line_position));
      let position = 1;
      while (positions.has(position)) position++;
      return { rows: [{ count: position }], rowCount: 1, command: "SELECT" };
    }
    if (
      sql.startsWith(
        "UPDATE orders.orders SET version=version+1, currency=COALESCE",
      )
    ) {
      if (order.version !== values[1] || order.status !== "Draft")
        return { rows: [], rowCount: 0, command: "UPDATE" };
      order = {
        ...order,
        version: String(Number(order.version) + 1),
        currency: order.currency ?? values[2],
        updated_at: now,
        last_modified_by_actor_ref: values[3],
      };
      return {
        rows: [{ version: order.version }],
        rowCount: 1,
        command: "UPDATE",
      };
    }
    if (sql.includes("orders.write_card_projection($1)")) {
      order = { ...order, projection_version: order.version };
      return {
        rows: [{ projection_version: order.version }],
        rowCount: 1,
        command: "SELECT",
      };
    }
    if (sql.startsWith("INSERT INTO orders.order_items")) {
      assert.deepEqual(values.slice(3, 12), [
        "prd_00000000000000000000000011",
        "var_00000000000000000000000011",
        "Кофе",
        "piece",
        "2500",
        values[8],
        1,
        "e".repeat(64),
        "f".repeat(64),
      ]);
      items.push({
        order_ref: values[0],
        item_ref: values[1],
        line_position: values[2],
        product_ref: values[3],
        variant_ref: values[4],
        product_display_name: values[5],
        unit: values[6],
        quantity_milli: values[7],
        quote_ref: values[8],
        quote_line_number: values[9],
        quote_hash: values[10],
        internal_proof_hash: values[11],
        quote_expires_at: new Date(values[12]),
        policy_version_ref: values[13],
        catalog_snapshot_revision: values[14],
        mapping_revision: values[15],
        offer_ref: values[16],
        unit_minor: values[17],
        line_total_minor: values[18],
        currency: values[19],
        source_grind_key_hash: values[20],
        grind_display_name: values[21],
        created_at: now,
        updated_at: now,
      });
      return { rows: [], rowCount: 1, command: "INSERT" };
    }
    if (sql.startsWith("UPDATE orders.order_items SET product_ref=$3")) {
      const item = items.find(
        (row) => row.order_ref === values[0] && row.item_ref === values[1],
      );
      assert.ok(item, "the existing item being updated must be persisted");
      Object.assign(item, {
        product_ref: values[2],
        variant_ref: values[3],
        product_display_name: values[4],
        unit: values[5],
        quantity_milli: values[6],
        quote_ref: values[7],
        quote_line_number: values[8],
        quote_hash: values[9],
        internal_proof_hash: values[10],
        quote_expires_at: new Date(values[11]),
        policy_version_ref: values[12],
        catalog_snapshot_revision: values[13],
        mapping_revision: values[14],
        offer_ref: values[15],
        unit_minor: values[16],
        line_total_minor: values[17],
        currency: values[18],
        source_grind_key_hash: values[19],
        grind_display_name: values[20],
        updated_at: now,
      });
      return { rows: [], rowCount: 1, command: "UPDATE" };
    }
    if (
      sql.includes(
        "DELETE FROM orders.order_items WHERE order_ref=$1 AND item_ref=$2 RETURNING item_ref",
      )
    ) {
      const before = items.length;
      items = items.filter(
        (item) => item.order_ref !== values[0] || item.item_ref !== values[1],
      );
      const removed = items.length !== before;
      return {
        rows: removed ? [{ item_ref: values[1] }] : [],
        rowCount: removed ? 1 : 0,
        command: "DELETE",
      };
    }
    if (sql.startsWith("INSERT INTO orders.order_history")) {
      history.push({ event: values[3], facts: JSON.parse(values[7]) });
      return { rows: [], rowCount: 1, command: "INSERT" };
    }
    if (sql.includes("orders.read_card_projection"))
      return {
        rows: aromaRow === undefined ? [] : [aromaRow],
        rowCount: aromaRow === undefined ? 0 : 1,
        command: "SELECT",
      };
    if (
      sql.startsWith("UPDATE orders.orders SET version=version+1,updated_at")
    ) {
      if (order.version !== values[1] || order.status !== "Confirmed")
        return { rows: [], rowCount: 0, command: "UPDATE" };
      order = {
        ...order,
        version: String(Number(order.version) + 1),
        updated_at: now,
        last_modified_by_actor_ref: values[2],
      };
      return {
        rows: [{ version: order.version, requested_at: now.toISOString() }],
        rowCount: 1,
        command: "UPDATE",
      };
    }
    if (sql.startsWith("UPDATE orders.orders SET status=$5")) {
      assert.equal(order.status, "Draft");
      assert.equal(order.version, values[1]);
      order = {
        ...order,
        status: values[4],
        version: values[2],
        confirmed_at: now,
        updated_at: now,
        last_modified_by_actor_ref: values[3],
        currency: "RUB",
      };
      return {
        rows: [{ confirmed_at: now.toISOString() }],
        rowCount: 1,
        command: "UPDATE",
      };
    }
    if (sql.startsWith("INSERT INTO orders.order_desired_contributions(")) {
      desired.push({ orderRef: values[0], orderVersion: values[1] });
      return { rows: [], rowCount: 1, command: "INSERT" };
    }
    if (
      sql.startsWith("INSERT INTO orders.order_desired_contribution_lines(")
    ) {
      desired.push({
        offerRef: values[1],
        quantityMilli: values[2],
        itemRefs: JSON.parse(values[4]),
      });
      return { rows: [], rowCount: 1, command: "INSERT" };
    }
    if (sql.includes("max(aggregate_sequence)"))
      return {
        rows: [{ sequence: String(outbox.length + 1) }],
        rowCount: 1,
        command: "SELECT",
      };
    if (sql.startsWith("INSERT INTO orders.outbox_messages")) {
      if (failOutbox) throw new Error("outbox unavailable");
      const envelope = JSON.parse(values[6]);
      const payload = JSON.parse(values[7]);
      if (sql.includes("OrderReconciliationRequested.v1")) {
        assert.equal(values[3], order.version);
        assert.equal(envelope.aggregate.version, values[3]);
        assert.deepEqual(payload, {
          orderRef,
          orderVersion: values[3],
          requestedAt: now.toISOString(),
        });
        assert.deepEqual(JSON.parse(values[4].toString()), envelope);
        assert.equal(
          values[5],
          createHash("sha256").update(values[4]).digest("hex"),
        );
        assert.equal(payload.reason, undefined);
        outbox.push(envelope);
        return { rows: [], rowCount: 1, command: "INSERT" };
      }
      assert.deepEqual(payload, {
        orderRef,
        orderVersion: "6",
        customerRef,
        confirmedAt: now.toISOString(),
        contributionRevision: "1",
      });
      assert.deepEqual(JSON.parse(values[4].toString()), envelope);
      assert.equal(
        values[5],
        createHash("sha256").update(values[4]).digest("hex"),
      );
      assert.equal(values[8], canonicalRequestHash(envelope));
      outbox.push(envelope);
      return { rows: [], rowCount: 1, command: "INSERT" };
    }
    assert.fail(`unexpected OrderStore query: ${sql}`);
  });
  const store = new OrderStore(database);
  const firstProof = proof(11);
  const firstCommand = {
    ...meta(),
    orderRef,
    itemRef: "itm_00000000000000000000000011",
    expectedVersion: "1",
    request: request("1", firstProof),
    item: firstProof,
  };

  const statementsBeforeInvalidProofs = statements.length;
  for (const invalid of [
    {
      request: { ...firstCommand.request, quantity: "0" },
      item: { ...firstProof, quantityMilli: "0" },
    },
    {
      request: { ...firstCommand.request, quantity: "1000000" },
      item: { ...firstProof, quantityMilli: "1000000000" },
    },
    { item: { ...firstProof, mappingRevision: "-1" } },
    { item: { ...firstProof, internalProofHash: "not-a-hash" } },
    { item: { ...firstProof, grindDisplayName: "Несогласованный помол" } },
    { item: { ...firstProof, unit: "unknown" } },
    { item: { ...firstProof, currency: "USD" } },
    { item: { ...firstProof, quoteExpiresAt: "not-a-timestamp" } },
  ]) {
    await assert.rejects(store.putItem({ ...firstCommand, ...invalid }), {
      code:
        invalid.item.quoteExpiresAt === "not-a-timestamp"
          ? "ORDER_DATABASE_DECODE_ERROR"
          : "ORDER_VALIDATION_FAILED",
    });
    assert.equal(statements.length, statementsBeforeInvalidProofs);
    assert.deepEqual(
      { items, history, desired, outbox, records: [...records] },
      {
        items: [],
        history: [],
        desired: [],
        outbox: [],
        records: [],
      },
    );
  }

  const inserted = await store.putItem(firstCommand);
  assert.equal(inserted.body.version, "2");
  assert.deepEqual(
    inserted.body.items.map(
      ({ quoteRef, quantity, unitMinor, lineTotalMinor }) => ({
        quoteRef,
        quantity,
        unitMinor,
        lineTotalMinor,
      }),
    ),
    [
      {
        quoteRef: firstProof.quoteRef,
        quantity: "2.5",
        unitMinor: "150",
        lineTotalMinor: "375",
      },
    ],
  );
  assert.deepEqual(history[0], {
    event: "ItemUpserted",
    facts: {
      itemRef: firstCommand.itemRef,
      quoteRef: firstProof.quoteRef,
      quoteLineNumber: 1,
    },
  });
  const writesAfterPut = {
    version: order.version,
    items: items.length,
    history: history.length,
  };
  assert.deepEqual(await store.putItem(firstCommand), {
    ...inserted,
    replayed: true,
  });
  assert.deepEqual(
    { version: order.version, items: items.length, history: history.length },
    writesAfterPut,
  );

  const draftReconciliationMeta = meta();
  const draftReconciliationCommand = {
    ...draftReconciliationMeta,
    identity: {
      ...draftReconciliationMeta.identity,
      scope: createHash("sha256")
        .update(
          `POST\n/api/client-v1/orders/${orderRef}/commands/request-aroma-reconciliation`,
          "utf8",
        )
        .digest("hex"),
    },
    orderRef,
    expectedVersion: "2",
    reason: "Нельзя запрашивать сверку до подтверждения заказа",
  };
  const stateBeforeDraftReconciliation = structuredClone({
    order,
    items,
    records: [...records],
    history,
    desired,
    outbox,
  });
  const draftReconciliationCommits = statements.filter(
    (sql) => sql === "COMMIT",
  ).length;
  const draftReconciliationRollbacks = statements.filter(
    (sql) => sql === "ROLLBACK",
  ).length;
  await assert.rejects(
    store.requestReconciliation(draftReconciliationCommand),
    { code: "AROMA_RECONCILIATION_NOT_ALLOWED" },
  );
  assert.deepEqual(
    { order, items, records: [...records], history, desired, outbox },
    stateBeforeDraftReconciliation,
  );
  assert.equal(
    statements.filter((sql) => sql === "COMMIT").length,
    draftReconciliationCommits,
  );
  assert.equal(
    statements.filter((sql) => sql === "ROLLBACK").length,
    draftReconciliationRollbacks + 1,
  );

  const duplicateQuoteCommand = {
    ...meta(),
    orderRef,
    itemRef: "itm_00000000000000000000000012",
    expectedVersion: "2",
    request: request("2", firstProof),
    item: firstProof,
  };
  const duplicateQuoteState = structuredClone({
    order,
    items,
    history,
    desired,
    outbox,
  });
  const duplicateQuoteRollbacks = statements.filter(
    (sql) => sql === "ROLLBACK",
  ).length;
  const duplicateQuoteCommits = statements.filter(
    (sql) => sql === "COMMIT",
  ).length;
  await assert.rejects(store.putItem(duplicateQuoteCommand), {
    code: "ORDER_QUOTE_SCOPE_MISMATCH",
  });
  assert.deepEqual(
    { order, items, history, desired, outbox },
    duplicateQuoteState,
  );
  assert.equal(
    records.has(
      recordKey(
        duplicateQuoteCommand.identity.actorRef,
        duplicateQuoteCommand.identity.scope,
        duplicateQuoteCommand.identity.key,
      ),
    ),
    false,
  );
  assert.equal(
    statements.filter((sql) => sql === "ROLLBACK").length,
    duplicateQuoteRollbacks + 1,
  );
  assert.equal(
    statements.filter((sql) => sql === "COMMIT").length,
    duplicateQuoteCommits,
  );

  const singlePersistedItem = structuredClone(items);
  const persistedItem = items[0];
  items = Array.from({ length: 100 }, (_, index) => ({
    ...persistedItem,
    item_ref:
      index === 0
        ? persistedItem.item_ref
        : `itm_${String(1000 + index).padStart(26, "0")}`,
    line_position: index + 1,
    quote_ref:
      index === 0
        ? persistedItem.quote_ref
        : `prq_${String(1000 + index).padStart(26, "0")}`,
    quote_line_number: 1,
  }));
  assert.equal(
    new Set(items.map(({ line_position }) => line_position)).size,
    100,
  );
  assert.equal(new Set(items.map(({ quote_ref }) => quote_ref)).size, 100);
  const limitProof = proof(999999);
  const limitCommand = {
    ...meta(),
    orderRef,
    itemRef: `itm_${"9".repeat(26)}`,
    expectedVersion: "2",
    request: request("2", limitProof),
    item: limitProof,
  };
  const fullOrderState = structuredClone({
    order,
    items,
    history,
    desired,
    outbox,
  });
  const limitRollbacks = statements.filter((sql) => sql === "ROLLBACK").length;
  const limitCommits = statements.filter((sql) => sql === "COMMIT").length;
  await assert.rejects(store.putItem(limitCommand), {
    code: "ORDER_ITEM_LIMIT_EXCEEDED",
  });
  assert.deepEqual({ order, items, history, desired, outbox }, fullOrderState);
  assert.equal(
    records.has(
      recordKey(
        limitCommand.identity.actorRef,
        limitCommand.identity.scope,
        limitCommand.identity.key,
      ),
    ),
    false,
  );
  assert.equal(
    statements.filter((sql) => sql === "ROLLBACK").length,
    limitRollbacks + 1,
  );
  assert.equal(
    statements.filter((sql) => sql === "COMMIT").length,
    limitCommits,
  );
  items = singlePersistedItem;

  const updatedProof = {
    ...proof(15),
    sourceGrindKeyHash: "b".repeat(64),
    grindDisplayName: "Средний",
    unitMinor: "2000000000000000000",
    lineTotalMinor: "5000000000000000000",
  };
  const updated = await store.putItem({
    ...meta(),
    orderRef,
    itemRef: firstCommand.itemRef,
    expectedVersion: "2",
    request: request("2", updatedProof),
    item: updatedProof,
  });
  assert.equal(updated.body.version, "3");
  assert.deepEqual(updated.body.items[0], {
    itemRef: firstCommand.itemRef,
    linePosition: 1,
    productRef: updatedProof.productRef,
    variantRef: updatedProof.variantRef,
    displayName: updatedProof.productDisplayName,
    quantity: "2.5",
    unit: updatedProof.unit,
    quoteRef: updatedProof.quoteRef,
    quoteLineNumber: updatedProof.quoteLineNumber,
    unitMinor: updatedProof.unitMinor,
    lineTotalMinor: updatedProof.lineTotalMinor,
    sourceGrindKeyHash: updatedProof.sourceGrindKeyHash,
    grindDisplayName: updatedProof.grindDisplayName,
  });
  const writesAfterUpdate = {
    version: order.version,
    items: items.length,
    history: history.length,
  };

  const overflowProof = {
    ...proof(16),
    unitMinor: "2000000000000000000",
    lineTotalMinor: "5000000000000000000",
  };
  const overflowCommand = {
    ...meta(),
    orderRef,
    itemRef: "itm_00000000000000000000000016",
    expectedVersion: "3",
    request: request("3", overflowProof),
    item: overflowProof,
  };
  const completedBeforeOverflow = [...records.values()].filter(
    (row) => row.state === "Completed",
  ).length;
  const rollbacksBeforeOverflow = statements.filter(
    (sql) => sql === "ROLLBACK",
  ).length;
  await assert.rejects(
    store.putItem(overflowCommand),
    { code: "ORDER_STATE_INCONSISTENT" },
    "individually valid line totals must not overflow the projected order total",
  );
  assert.deepEqual(
    {
      version: order.version,
      items: items.length,
      history: history.length,
      completedIdempotency: [...records.values()].filter(
        (row) => row.state === "Completed",
      ).length,
    },
    { ...writesAfterUpdate, completedIdempotency: completedBeforeOverflow },
  );
  assert.equal(
    records.has(
      recordKey(
        overflowCommand.identity.actorRef,
        overflowCommand.identity.scope,
        overflowCommand.identity.key,
      ),
    ),
    false,
    "the rejected transaction must not retain its acquired idempotency row",
  );
  assert.equal(
    statements.filter((sql) => sql === "ROLLBACK").length,
    rollbacksBeforeOverflow + 1,
  );

  const staleProof = proof(12);
  await assert.rejects(
    store.putItem({
      ...meta(),
      orderRef,
      itemRef: "itm_00000000000000000000000012",
      expectedVersion: "1",
      request: request("1", staleProof),
      item: staleProof,
    }),
    { code: "ORDER_VERSION_CONFLICT" },
  );
  const expiredProof = proof(
    13,
    Temporal.Now.instant().subtract({ hours: 1 }).toString(),
  );
  await assert.rejects(
    store.putItem({
      ...meta(),
      orderRef,
      itemRef: "itm_00000000000000000000000013",
      expectedVersion: "3",
      request: request("3", expiredProof),
      item: expiredProof,
    }),
    { code: "PRICING_QUOTE_EXPIRED" },
  );
  assert.deepEqual(
    { version: order.version, items: items.length, history: history.length },
    writesAfterUpdate,
  );

  const removed = await store.deleteItem({
    ...meta(),
    orderRef,
    itemRef: firstCommand.itemRef,
    expectedVersion: "3",
  });
  assert.equal(removed.body.version, "4");
  assert.equal(removed.body.items.length, 0);
  await assert.rejects(
    store.deleteItem({
      ...meta(),
      orderRef,
      itemRef: firstCommand.itemRef,
      expectedVersion: "4",
    }),
    { code: "ORDER_ITEM_NOT_FOUND" },
  );
  assert.equal(order.version, "4");
  assert.equal(items.length, 0);

  const emptyConfirmCommand = {
    ...meta(),
    orderRef,
    expectedVersion: "4",
  };
  const emptyOrderState = structuredClone({
    order,
    items,
    history,
    desired,
    outbox,
  });
  const emptyConfirmRollbacks = statements.filter(
    (sql) => sql === "ROLLBACK",
  ).length;
  const emptyConfirmCommits = statements.filter(
    (sql) => sql === "COMMIT",
  ).length;
  await assert.rejects(store.confirm(emptyConfirmCommand), {
    code: "ORDER_EMPTY",
  });
  assert.deepEqual({ order, items, history, desired, outbox }, emptyOrderState);
  assert.equal(
    records.has(
      recordKey(
        emptyConfirmCommand.identity.actorRef,
        emptyConfirmCommand.identity.scope,
        emptyConfirmCommand.identity.key,
      ),
    ),
    false,
  );
  assert.equal(
    statements.filter((sql) => sql === "ROLLBACK").length,
    emptyConfirmRollbacks + 1,
  );
  assert.equal(
    statements.filter((sql) => sql === "COMMIT").length,
    emptyConfirmCommits,
  );

  const confirmProof = proof(14);
  const confirmPut = await store.putItem({
    ...meta(),
    orderRef,
    itemRef: "itm_00000000000000000000000014",
    expectedVersion: "4",
    request: request("4", confirmProof),
    item: confirmProof,
  });
  assert.equal(confirmPut.body.version, "5");
  const confirmCommand = {
    ...meta(),
    orderRef,
    expectedVersion: "5",
    traceparent: "00-11111111111111111111111111111111-2222222222222222-01",
  };
  const beforeFailedConfirm = structuredClone({
    order,
    items,
    records: [...records],
    history,
    desired,
    outbox,
  });
  const confirmRollbacks = statements.filter(
    (sql) => sql === "ROLLBACK",
  ).length;
  failOutbox = true;
  await assert.rejects(store.confirm(confirmCommand), {
    code: "DB_CONNECTION_LOST",
  });
  failOutbox = false;
  assert.deepEqual(
    { order, items, records: [...records], history, desired, outbox },
    beforeFailedConfirm,
  );
  assert.equal(
    statements.filter((sql) => sql === "ROLLBACK").length,
    confirmRollbacks + 1,
  );
  const confirmed = await store.confirm(confirmCommand);
  assert.equal(confirmed.body.status, "Confirmed");
  assert.equal(confirmed.body.version, "6");
  assert.equal(order.status, "Confirmed");
  assert.equal(order.currency, "RUB");
  assert.equal(history.at(-1).event, "OrderConfirmed");
  assert.equal(desired.length, 2);
  assert.equal(outbox.length, 1);
  const effectsAfterConfirm = {
    version: order.version,
    history: history.length,
    desired: desired.length,
    outbox: outbox.length,
  };
  assert.deepEqual(await store.confirm(confirmCommand), {
    ...confirmed,
    replayed: true,
  });
  assert.deepEqual(
    {
      version: order.version,
      history: history.length,
      desired: desired.length,
      outbox: outbox.length,
    },
    effectsAfterConfirm,
  );
  aromaRow = {
    state: "OutOfSync",
    desired_revision: "2",
    observed_revision: "1",
    blocker_codes: ["CART_OUT_OF_SYNC"],
    last_observed_at: now,
  };
  const reconciliationMeta = meta();
  const reconciliationCommand = {
    ...reconciliationMeta,
    identity: {
      ...reconciliationMeta.identity,
      scope: createHash("sha256")
        .update(
          `POST\n/api/client-v1/orders/${orderRef}/commands/request-aroma-reconciliation`,
          "utf8",
        )
        .digest("hex"),
    },
    orderRef,
    expectedVersion: "6",
    reason: "Проверить расхождение корзины",
  };
  const beforeFailedReconciliation = structuredClone({
    order,
    items,
    records: [...records],
    history,
    desired,
    outbox,
  });
  const reconciliationRollbacks = statements.filter(
    (sql) => sql === "ROLLBACK",
  ).length;
  failOutbox = true;
  await assert.rejects(store.requestReconciliation(reconciliationCommand), {
    code: "DB_CONNECTION_LOST",
  });
  failOutbox = false;
  assert.deepEqual(
    { order, items, records: [...records], history, desired, outbox },
    beforeFailedReconciliation,
  );
  assert.equal(
    statements.filter((sql) => sql === "ROLLBACK").length,
    reconciliationRollbacks + 1,
  );
  const reconciliation = await store.requestReconciliation(
    reconciliationCommand,
  );
  assert.deepEqual(reconciliation.body, {
    orderRef,
    orderVersion: "7",
    requestedAt: now.toISOString(),
    aromaState: "OutOfSync",
  });
  assert.equal(history.at(-1).event, "ReconciliationRequested");
  assert.deepEqual(history.at(-1).facts, { requestKind: "OperatorRequested" });
  const effectsAfterReconciliation = {
    version: order.version,
    history: history.length,
    desired: desired.length,
    outbox: outbox.length,
  };
  assert.deepEqual(await store.requestReconciliation(reconciliationCommand), {
    ...reconciliation,
    replayed: true,
  });
  assert.deepEqual(
    {
      version: order.version,
      history: history.length,
      desired: desired.length,
      outbox: outbox.length,
    },
    effectsAfterReconciliation,
  );
  aromaRow = { ...aromaRow, state: "InSync" };
  const rejectedReconciliationMeta = meta();
  await assert.rejects(
    store.requestReconciliation({
      ...rejectedReconciliationMeta,
      identity: {
        ...rejectedReconciliationMeta.identity,
        scope: reconciliationCommand.identity.scope,
      },
      orderRef,
      expectedVersion: "7",
      reason: "Повторная проверка",
    }),
    { code: "AROMA_RECONCILIATION_NOT_ALLOWED" },
  );
  await assert.rejects(
    store.deleteItem({
      ...meta(),
      orderRef,
      itemRef: "itm_00000000000000000000000014",
      expectedVersion: "7",
    }),
    { code: "ORDER_NOT_EDITABLE" },
  );
  assert.deepEqual(
    {
      version: order.version,
      history: history.length,
      desired: desired.length,
      outbox: outbox.length,
    },
    effectsAfterReconciliation,
  );
  assert.equal(statements.filter((sql) => sql === "ROLLBACK").length, 12);

  for (const state of ["Blocked", "UnknownOutcome"]) {
    aromaRow = {
      ...aromaRow,
      state,
      blocker_codes:
        state === "UnknownOutcome"
          ? ["AROMA_OPERATION_UNKNOWN_OUTCOME"]
          : ["CART_OUT_OF_SYNC"],
    };
    const stateMeta = meta();
    const command = {
      ...stateMeta,
      identity: {
        ...stateMeta.identity,
        scope: reconciliationCommand.identity.scope,
      },
      orderRef,
      expectedVersion: order.version,
      reason: `Повторная сверка после состояния ${state}`,
    };
    const before = {
      version: order.version,
      projectionVersion: order.projection_version,
      history: history.length,
      outbox: outbox.length,
    };
    const result = await store.requestReconciliation(command);
    const expectedVersion = String(Number(before.version) + 1);
    assert.deepEqual(result, {
      status: 202,
      body: {
        orderRef,
        orderVersion: expectedVersion,
        requestedAt: now.toISOString(),
        aromaState: state,
      },
      replayed: false,
    });
    assert.equal(order.version, expectedVersion);
    assert.equal(order.projection_version, expectedVersion);
    assert.equal(history.length, before.history + 1);
    assert.deepEqual(history.at(-1), {
      event: "ReconciliationRequested",
      facts: { requestKind: "OperatorRequested" },
    });
    assert.equal(outbox.length, before.outbox + 1);
    const effectsAfterSuccess = {
      version: order.version,
      projectionVersion: order.projection_version,
      history: history.length,
      outbox: outbox.length,
    };
    assert.deepEqual(await store.requestReconciliation(command), {
      ...result,
      replayed: true,
    });
    assert.deepEqual(
      {
        version: order.version,
        projectionVersion: order.projection_version,
        history: history.length,
        outbox: outbox.length,
      },
      effectsAfterSuccess,
    );
  }

  aromaRow = { ...aromaRow, state: "Blocked" };
  const staleMeta = meta();
  const staleReconciliationCommand = {
    ...staleMeta,
    identity: {
      ...staleMeta.identity,
      scope: reconciliationCommand.identity.scope,
    },
    orderRef,
    expectedVersion: "7",
    reason: "Устаревшая версия не должна ставить повторную сверку",
  };
  const stateBeforeStaleReconciliation = structuredClone({
    order,
    items,
    records: [...records],
    history,
    desired,
    outbox,
  });
  const staleReconciliationCommits = statements.filter(
    (sql) => sql === "COMMIT",
  ).length;
  const staleReconciliationRollbacks = statements.filter(
    (sql) => sql === "ROLLBACK",
  ).length;
  await assert.rejects(
    store.requestReconciliation(staleReconciliationCommand),
    { code: "ORDER_VERSION_CONFLICT" },
  );
  assert.deepEqual(
    { order, items, records: [...records], history, desired, outbox },
    stateBeforeStaleReconciliation,
  );
  assert.equal(
    statements.filter((sql) => sql === "COMMIT").length,
    staleReconciliationCommits,
  );
  assert.equal(
    statements.filter((sql) => sql === "ROLLBACK").length,
    staleReconciliationRollbacks + 1,
  );
});

void test("migration guard accepts PostgreSQL quoted function bodies and every Orders migration", () => {
  const allowed = [
    "CREATE FUNCTION f() RETURNS void AS $$ BEGIN PERFORM 'COMMIT'; END; $$ LANGUAGE plpgsql;",
    "CREATE FUNCTION f() RETURNS void AS $func$ BEGIN PERFORM $inner$START TRANSACTION$inner$; END; $func$ LANGUAGE plpgsql;",
    `CREATE TABLE "COMMIT" (note text DEFAULT E'escaped\\' ABORT;');`,
    `CREATE TABLE t (note text DEFAULT 'doubled '' ROLLBACK;');`,
    `CREATE TABLE U&"b\\0065gin" (note text); /* outer /* BEGIN; */ COMMIT; */`,
    `CREATE TABLE t (n integer CHECK (CASE WHEN n > 0 THEN 1 ELSE 0 END = 1)); -- ROLLBACK`,
  ];
  for (const sql of allowed)
    assert.doesNotThrow(() => defineMigration({}, sql), sql);
  const migrations = new URL(
    "../../../apps/orders-service/migrations/",
    import.meta.url,
  );
  for (const name of readdirSync(migrations).filter((name) =>
    name.endsWith(".sql"),
  )) {
    assert.doesNotThrow(
      () =>
        defineMigration({}, readFileSync(new URL(name, migrations), "utf8")),
      name,
    );
  }
});

void test("migration guard rejects transaction commands at statement boundaries", () => {
  const body =
    "CREATE FUNCTION f() RETURNS void AS $body$ BEGIN NULL; END; $body$ LANGUAGE plpgsql;";
  const forbidden = [
    `BEGIN; ${body}`,
    `${body} COMMIT;`,
    `${body} /* outer /* END */ */ StArT TRANSACTION;`,
    `${body} -- safe text\nAbOrT;`,
    `SELECT 1; ROLLBACK TO SAVEPOINT s;`,
    `SELECT 1; SAVEPOINT s;`,
    `SELECT 1; RELEASE SAVEPOINT s;`,
    `SELECT 1; PREPARE TRANSACTION 'x';`,
    `SELECT 1; END WORK;`,
    `SELECT 1; SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;`,
    `SELECT 1; SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL READ COMMITTED;`,
  ];
  for (const sql of forbidden) {
    assert.throws(
      () => defineMigration({}, sql),
      (error) => error?.code === "DB_INVALID_CONFIGURATION",
      sql,
    );
  }
});

void test("migration guard rejects unterminated SQL lexemes", () => {
  for (const sql of [
    "SELECT 'unterminated",
    `SELECT E'escaped\\'`,
    'SELECT "identifier',
    "SELECT /* outer /* inner */",
    "SELECT $tag$body$$",
    "SELECT $$body$other$",
  ]) {
    assert.throws(
      () => defineMigration({}, sql),
      (error) => error?.code === "DB_INVALID_CONFIGURATION",
      sql,
    );
  }
});

void test("database does not reuse a connection with an unsettled native query after interruption", async (t) => {
  let rejectQuery;
  const abort = new AbortController();
  const { database, releases, connection } = mockDatabase(t, (sql) => {
    if (sql === "SELECT pg_sleep(10)")
      return new Promise((_, reject) => {
        rejectQuery = reject;
        abort.abort();
      });
    return undefined;
  });
  connection.release = (destroy) => {
    releases.push(destroy);
    rejectQuery?.(new Error("socket closed"));
  };
  const query = defineStatement(database, "SELECT pg_sleep(10)");
  await assert.rejects(
    withTransaction(
      database,
      { mode: "interactive", signal: abort.signal },
      (tx) => query(tx, []),
    ),
    { code: "DB_INTERRUPTED" },
  );
  assert.deepEqual(releases, [true]);
  await database.resource.stop(new AbortController().signal);
  assert.equal(database.metrics().pending, 0);
});

void test("database COPY synchronous driver failure is typed and releases a destroyed connection", async (t) => {
  const { database, releases, connection } = mockDatabase(t);
  connection.query = (query) => {
    if (typeof query !== "string")
      throw Object.assign(new Error("private connection info"), {
        code: "ECONNRESET",
      });
    return Promise.resolve({
      rows: [],
      rowCount: 0,
      command: query.split(" ")[0],
    });
  };
  const copy = defineCopy(database, "records", ["id"], "owner");
  const source = Readable.from(["1\n"]);
  await assert.rejects(
    withTransaction(database, { mode: "interactive" }, (tx) =>
      copy(tx, source),
    ),
    { code: "DB_CONNECTION_LOST", message: "DB_CONNECTION_LOST" },
  );
  assert.deepEqual(releases, [true]);
  assert.equal(source.destroyed, true);
  assert.equal(database.metrics().pending, 0);
});

void test("database ssl prefer falls back only before authentication on explicit server refusal", async (t) => {
  const { database, connection } = mockDatabase(t, undefined, "prefer");
  const observed = [];
  t.mock.method(pg.Pool.prototype, "connect", async function () {
    observed.push(this.options.ssl);
    if (this.options.ssl)
      throw new Error("The server does not support SSL connections");
    return connection;
  });
  await withTransaction(database, { mode: "interactive" }, async () => {});
  assert.deepEqual(observed, [true, false]);
  t.mock.method(pg.Pool.prototype, "connect", async () => {
    observed.push("certificate failure");
    throw new Error("certificate verify failed");
  });
  await assert.rejects(
    withTransaction(database, { mode: "interactive" }, async () => {}),
    { code: "DB_CONNECTION_LOST" },
  );
  assert.equal(
    observed.filter((value) => value === "certificate failure").length,
    1,
  );
});

void test("AROMA Observer Gateway read honors caller cancellation while fetch is pending", async () => {
  const controller = new AbortController();
  let resolveFetchStarted;
  const fetchStarted = new Promise((resolve) => {
    resolveFetchStarted = resolve;
  });
  let fetchSignal;
  let fetchCount = 0;
  const client = new AromaObserverGatewayClient(
    {
      fetch: async (_path, options) => {
        fetchCount++;
        fetchSignal = options.signal;
        resolveFetchStarted();
        return new Promise(() => {});
      },
    },
    { deadlineMs: 700, maxResponseBytes: 1024 },
  );
  const pending = client.read({
    correlationId: "observer-cancel",
    signal: controller.signal,
  });
  await fetchStarted;
  controller.abort();
  const fetchAbortedImmediately = fetchSignal.aborted;
  const settled = pending.then(
    (value) => ({ kind: "resolved", value }),
    (error) => ({ kind: "rejected", error }),
  );
  let watchdog;
  try {
    const result = await Promise.race([
      settled,
      new Promise((resolve) => {
        watchdog = setTimeout(() => resolve({ kind: "watchdog" }), 150);
      }),
    ]);
    assert.equal(
      fetchAbortedImmediately,
      true,
      "caller cancellation must propagate to the in-flight fetch signal",
    );
    assert.equal(
      result.kind,
      "rejected",
      "caller cancellation must settle before the internal deadline",
    );
    assert.ok(result.error instanceof ObserverGatewayClientError);
    assert.equal(result.error.kind, "TransportUnavailable");
    assert.equal(result.error.code, "AROMA_GATEWAY_TRANSPORT_UNAVAILABLE");
  } finally {
    clearTimeout(watchdog);
  }
  assert.equal(fetchCount, 1);
  assert.equal(fetchSignal.aborted, true);
});

void test("AROMA observation store schedules, fences, validates, and persists through owner SQL", async (t) => {
  const ownerInstanceId = "11111111-1111-4111-8111-111111111111";
  const leaseUntil = "2026-10-25T12:00:00.000Z";
  const capturedAt = "2026-10-25T11:59:59.000Z";
  const grindHash = "a".repeat(64);
  const snapshotLines = [
    { offerRef: "off_00000000000000000000000001", quantity: "1.25" },
    {
      offerRef: "off_00000000000000000000000002",
      quantity: "2",
      sourceGrindKeyHash: grindHash,
    },
  ];
  const hash = (value) =>
    createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const canonicalLines = snapshotLines
    .map((line) => ({ ...line }))
    .sort((left, right) => left.offerRef.localeCompare(right.offerRef));
  const snapshot = {
    cartScopeRef: "aroma-primary",
    providerSnapshotRef: `aroma-gateway:cart-body-sha256:${"b".repeat(64)}`,
    capturedAt,
    cartFingerprint: hash(canonicalLines),
    lines: snapshotLines,
  };
  const options = {
    ownerInstanceId,
    intervalMs: 30_000,
    leaseMs: 10_000,
    maxSnapshotAgeMs: 60_000,
    maxLines: 10,
  };
  const signal = new AbortController().signal;
  const makeDatabase = (mode = {}) => {
    const queries = [];
    let permitCalls = 0;
    const { database } = mockDatabase(t, (sql, values) => {
      const normalized = sql.replace(/\s+/gu, " ").trim();
      queries.push({ sql: normalized, values });
      if (
        normalized === "BEGIN" ||
        normalized === "COMMIT" ||
        normalized === "ROLLBACK"
      )
        return { rows: [], rowCount: null, command: normalized };
      if (normalized.startsWith("SET LOCAL "))
        return { rows: [], rowCount: null, command: "SET" };
      if (normalized.startsWith("SELECT true AS locked"))
        return { rows: [{ locked: true }], rowCount: 1 };
      if (normalized.startsWith("INSERT INTO orders.observation_schedule")) {
        if (mode.recoverScheduleError) throw mode.recoverScheduleError;
        return { rows: [], rowCount: 1 };
      }
      if (
        normalized.startsWith("UPDATE orders.observation_schedule") &&
        normalized.includes("RETURNING lease_until::text")
      )
        return mode.claim === false
          ? { rows: [], rowCount: 0 }
          : { rows: [{ lease_until: leaseUntil }], rowCount: 1 };
      if (
        normalized.startsWith(
          "SELECT EXISTS(SELECT 1 FROM orders.observation_schedule",
        )
      ) {
        permitCalls++;
        return {
          rows: [
            {
              valid:
                (mode.permitValid === false && permitCalls === 1) ||
                mode.permitInvalidAtCall === permitCalls
                  ? false
                  : true,
            },
          ],
          rowCount: 1,
        };
      }
      if (normalized.startsWith("SELECT ($1::timestamptz<=clock_timestamp()"))
        return {
          rows: [{ valid: mode.fresh === false ? false : true }],
          rowCount: 1,
        };
      if (
        normalized.startsWith("SELECT (COALESCE(max(observed_revision),0)+1)")
      )
        return { rows: [{ revision: "7" }], rowCount: 1 };
      if (
        normalized.startsWith(
          "UPDATE orders.cart_observed_revisions SET state='Superseded'",
        )
      )
        return { rows: [], rowCount: 1 };
      if (normalized.startsWith("INSERT INTO orders.cart_observed_revisions"))
        return { rows: [], rowCount: 1 };
      if (normalized.startsWith("INSERT INTO orders.cart_observed_lines")) {
        if (mode.insertLinesError) throw mode.insertLinesError;
        return { rows: [], rowCount: JSON.parse(values[1]).length };
      }
      if (normalized.startsWith("SELECT to_char(clock_timestamp()"))
        return { rows: [{ now: "2026-10-25T12:00:00.000Z" }], rowCount: 1 };
      if (
        normalized.startsWith("SELECT (COALESCE(max(aggregate_sequence),0)+1)")
      )
        return { rows: [{ sequence: "4" }], rowCount: 1 };
      if (
        normalized.startsWith(
          "SELECT payload_hash, message_type, topic, aggregate_ref",
        )
      )
        return { rows: [], rowCount: 0 };
      if (
        normalized.startsWith(
          'SELECT aggregate_sequence FROM "orders"."outbox_messages"',
        )
      )
        return { rows: [{ aggregate_sequence: "3" }], rowCount: 1 };
      if (normalized.startsWith('INSERT INTO "orders"."outbox_messages"'))
        return { rows: [{ message_id: values[0] }], rowCount: 1 };
      if (
        normalized.startsWith(
          "UPDATE orders.observation_schedule SET next_observation_at=",
        )
      )
        return { rows: [], rowCount: mode.rescheduleRowCount ?? 1 };
      throw new Error(`Unexpected Observer SQL: ${normalized}`);
    });
    return { database, queries };
  };
  const store = (database, overrides = {}, telemetry) =>
    createAromaObservationStore(
      database,
      { ...options, ...overrides },
      telemetry,
    );
  const gatewayFor = (read) => ({ read });

  await t.test(
    "invalid observation bounds fail at construction before owner SQL",
    async () => {
      const { database, queries } = makeDatabase();
      assert.throws(() => store(database, { maxLines: 0 }), {
        message: "AROMA_OBSERVATION_OPTIONS_INVALID",
      });
      assert.deepEqual(queries, []);
    },
  );

  await t.test(
    "a schedule recovery SQL failure rolls back, escapes, and reports only recovery error",
    async () => {
      const { AromaObserverTelemetry } =
        await import("../../../apps/aroma-observer/dist/observability.js");
      const { database, queries } = makeDatabase({
        recoverScheduleError: Object.assign(
          new Error("schedule insert failed"),
          { code: "23514" },
        ),
      });
      const telemetry = new AromaObserverTelemetry();
      const observer = store(database, {}, telemetry);

      await assert.rejects(observer.recover(signal), {
        code: "DB_QUERY_FAILED",
      });

      const sql = queries.map(({ sql }) => sql);
      assert.equal(
        sql.some((entry) =>
          entry.startsWith("INSERT INTO orders.observation_schedule"),
        ),
        true,
      );
      assert.equal(sql.filter((entry) => entry === "ROLLBACK").length, 1);
      assert.equal(
        sql.some((entry) => entry === "COMMIT"),
        false,
      );
      assert.equal(
        sql.some(
          (entry) =>
            entry.startsWith("UPDATE orders.observation_schedule") &&
            entry.includes("RETURNING lease_until::text"),
        ),
        false,
      );
      assert.equal(
        sql.some((entry) =>
          entry.startsWith(
            "SELECT EXISTS(SELECT 1 FROM orders.observation_schedule",
          ),
        ),
        false,
      );
      const recoveryMetrics = telemetry
        .render()
        .filter((entry) =>
          entry.startsWith("coffee_aroma_observation_recovery_results_total"),
        );
      assert.deepEqual(recoveryMetrics, [
        'coffee_aroma_observation_recovery_results_total{result="ready"} 0',
        'coffee_aroma_observation_recovery_results_total{result="error"} 1',
      ]);
    },
  );

  await t.test(
    "recovery schedules once; a missing claim stays idle without a provider read",
    async () => {
      const { database, queries } = makeDatabase({ claim: false });
      const observer = store(database);
      await observer.recover(signal);
      const beforeRun = queries.length;
      assert.equal(
        await observer.runOnce(
          gatewayFor(async () => assert.fail("unexpected read")),
          signal,
        ),
        "idle",
      );
      assert.equal(
        queries
          .slice(0, beforeRun)
          .some(({ sql }) =>
            sql.startsWith("INSERT INTO orders.observation_schedule"),
          ),
        true,
      );
      assert.equal(
        queries
          .slice(beforeRun)
          .some(
            ({ sql }) =>
              sql.startsWith("UPDATE orders.observation_schedule") &&
              sql.includes("RETURNING lease_until::text"),
          ),
        true,
      );
    },
  );

  await t.test(
    "a valid safe read writes normalized lines, revision, owner envelope, outbox, and schedule",
    async () => {
      const { AromaObserverTelemetry } =
        await import("../../../apps/aroma-observer/dist/observability.js");
      const { database, queries } = makeDatabase();
      const telemetry = new AromaObserverTelemetry();
      const observer = store(database, {}, telemetry);
      await observer.recover(signal);
      let reads = 0;
      assert.equal(
        await observer.runOnce(
          gatewayFor(async () => {
            reads++;
            return snapshot;
          }),
          signal,
        ),
        "observed",
      );
      assert.equal(reads, 1);
      const observerMetrics = telemetry.render();
      assert.ok(
        observerMetrics.includes(
          'coffee_aroma_observation_recovery_results_total{result="ready"} 1',
        ),
      );
      assert.ok(
        observerMetrics.includes(
          'coffee_aroma_observation_recovery_results_total{result="error"} 0',
        ),
      );
      assert.ok(
        observerMetrics.includes(
          'coffee_aroma_observation_results_total{result="observed"} 1',
        ),
      );
      assert.ok(
        observerMetrics.includes(
          'coffee_aroma_observation_results_total{result="failed"} 0',
        ),
      );
      assert.ok(
        observerMetrics.includes(
          "coffee_aroma_observation_fence_failures_total 0",
        ),
      );
      assert.match(
        observerMetrics.find((entry) =>
          entry.startsWith("coffee_aroma_observed_age_ms "),
        ),
        /^coffee_aroma_observed_age_ms [0-9]+$/u,
      );
      const lineWrite = queries.find(({ sql }) =>
        sql.startsWith("INSERT INTO orders.cart_observed_lines"),
      );
      assert.ok(lineWrite);
      assert.deepEqual(JSON.parse(lineWrite.values[1]), [
        {
          offerRef: snapshotLines[0].offerRef,
          quantityMilli: "1250",
          sanitizedLineHash: hash({
            offerRef: snapshotLines[0].offerRef,
            quantityMilli: "1250",
          }),
        },
        {
          offerRef: snapshotLines[1].offerRef,
          quantityMilli: "2000",
          sourceGrindKeyHash: grindHash,
          sanitizedLineHash: hash({
            offerRef: snapshotLines[1].offerRef,
            quantityMilli: "2000",
            sourceGrindKeyHash: grindHash,
          }),
        },
      ]);
      const outboxWrite = queries.find(({ sql }) =>
        sql.startsWith('INSERT INTO "orders"."outbox_messages"'),
      );
      assert.ok(outboxWrite);
      const envelope = JSON.parse(outboxWrite.values[8]);
      assert.equal(envelope.messageType, "AromaObservationChanged.v1");
      assert.equal(envelope.aggregate.version, "7");
      assert.deepEqual(envelope.payload, {
        cartScopeRef: "aroma-primary",
        observedRevision: "7",
        observedAt: capturedAt,
        observationState: "Complete",
        cartFingerprint: snapshot.cartFingerprint,
      });
      assert.equal(outboxWrite.values[2], "coffee.aroma.cart.events.v1");
      assert.equal(outboxWrite.values[4], 4n);
      assert.deepEqual(
        outboxWrite.values[15],
        Buffer.from(outboxWrite.values[8]),
      );
      assert.equal(outboxWrite.values[16], hash(envelope));
      const sql = queries.map(({ sql }) => sql);
      const lockIndex = sql.indexOf(
        "SELECT true AS locked FROM (SELECT pg_advisory_xact_lock(hashtext('orders:aroma-primary'))) AS acquired",
      );
      const claimIndex = sql.findIndex((entry) =>
        entry.startsWith("UPDATE orders.observation_schedule"),
      );
      assert.notEqual(lockIndex, -1);
      assert.notEqual(claimIndex, -1);
      assert.ok(lockIndex < claimIndex);
      const supersedeIndex = sql.findIndex((entry) =>
        entry.startsWith(
          "UPDATE orders.cart_observed_revisions SET state='Superseded'",
        ),
      );
      const revisionIndex = sql.findIndex((entry) =>
        entry.startsWith("INSERT INTO orders.cart_observed_revisions"),
      );
      assert.notEqual(supersedeIndex, -1);
      assert.notEqual(revisionIndex, -1);
      assert.ok(supersedeIndex < revisionIndex);
      assert.ok(
        sql.findIndex((entry) =>
          entry.startsWith('INSERT INTO "orders"."outbox_messages"'),
        ) <
          sql.findIndex((entry) =>
            entry.startsWith(
              "UPDATE orders.observation_schedule SET next_observation_at=",
            ),
          ),
      );
    },
  );

  await t.test(
    "a successful Gateway read followed by an owner write error rolls back and escapes without publishing",
    async () => {
      const { AromaObserverTelemetry } =
        await import("../../../apps/aroma-observer/dist/observability.js");
      const { database, queries } = makeDatabase({
        insertLinesError: Object.assign(
          new Error("observer-write-private-canary"),
          { code: "23514" },
        ),
      });
      const telemetry = new AromaObserverTelemetry();
      const observer = store(database, {}, telemetry);
      let reads = 0;

      await assert.rejects(
        observer.runOnce(
          gatewayFor(async () => {
            reads++;
            return snapshot;
          }),
          signal,
        ),
        (error) => {
          assert.equal(error.code, "DB_QUERY_FAILED");
          assert.equal(error.message, "DB_QUERY_FAILED");
          assert.equal(error.sqlState, "23514");
          assert.equal(
            error.message.includes("observer-write-private-canary"),
            false,
          );
          return true;
        },
      );

      assert.equal(reads, 1);
      const sql = queries.map(({ sql }) => sql);
      const linesIndex = sql.findIndex((entry) =>
        entry.startsWith("INSERT INTO orders.cart_observed_lines"),
      );
      assert.notEqual(linesIndex, -1);
      assert.equal(sql.filter((entry) => entry === "COMMIT").length, 2);
      assert.equal(sql.filter((entry) => entry === "ROLLBACK").length, 1);
      assert.equal(
        sql
          .slice(linesIndex + 1)
          .some(
            (entry) =>
              entry.includes('INSERT INTO "orders"."outbox_messages"') ||
              entry.startsWith(
                "UPDATE orders.observation_schedule SET next_observation_at=",
              ),
          ),
        false,
      );
      const observerMetrics = telemetry.render();
      assert.ok(
        observerMetrics.includes(
          'coffee_aroma_observation_results_total{result="observed"} 0',
        ),
      );
      assert.ok(
        observerMetrics.includes(
          "coffee_aroma_observation_fence_failures_total 0",
        ),
      );
      assert.ok(observerMetrics.includes("coffee_aroma_observed_age_ms 0"));
    },
  );

  const oversizedLines = Array.from({ length: 11 }, (_, index) => ({
    offerRef: `off_${String(index).padStart(26, "0")}`,
    quantity: "1",
  }));
  const oversizedSnapshot = {
    ...snapshot,
    lines: oversizedLines,
    cartFingerprint: hash(oversizedLines),
  };
  assert.equal(normalizeAromaCartSnapshot(oversizedSnapshot).lines.length, 11);
  for (const [maxLines, expected] of [
    [10, "failed"],
    [11, "observed"],
  ]) {
    await t.test(
      `valid 11-line snapshot is ${expected} at maxLines=${maxLines}`,
      async () => {
        const { database, queries } = makeDatabase();
        const observer = store(database, { maxLines });
        await observer.recover(signal);
        assert.equal(
          await observer.runOnce(
            gatewayFor(async () => oversizedSnapshot),
            signal,
          ),
          expected,
        );
        const lineWrite = queries.find(({ sql }) =>
          sql.startsWith("INSERT INTO orders.cart_observed_lines"),
        );
        const revisionWrite = queries.some(({ sql }) =>
          sql.startsWith("INSERT INTO orders.cart_observed_revisions"),
        );
        const outboxWrite = queries.some(({ sql }) =>
          sql.includes('INSERT INTO "orders"."outbox_messages"'),
        );
        assert.equal(revisionWrite, expected === "observed");
        assert.equal(outboxWrite, expected === "observed");
        if (expected === "observed") {
          assert.ok(lineWrite);
          assert.equal(JSON.parse(lineWrite.values[1]).length, 11);
        } else {
          assert.equal(lineWrite, undefined);
        }
      },
    );
  }

  const invalidCases = [
    {
      name: "stale snapshot",
      mode: { fresh: false },
      read: async () => snapshot,
    },
    {
      name: "invalid snapshot",
      mode: {},
      read: async () => ({
        ...snapshot,
        providerSnapshotRef: "provider-private-id",
      }),
    },
  ];
  for (const { name, mode, read } of invalidCases) {
    await t.test(
      `${name} fails without allocating a revision or writing an outbox message`,
      async () => {
        const { database, queries } = makeDatabase(mode);
        const observer = store(database);
        await observer.recover(signal);
        assert.equal(
          await observer.runOnce(gatewayFor(read), signal),
          "failed",
        );
        assert.equal(
          queries.some(({ sql }) =>
            sql.startsWith("SELECT (COALESCE(max(observed_revision),0)+1)"),
          ),
          false,
        );
        assert.equal(
          queries.some(({ sql }) =>
            sql.startsWith("INSERT INTO orders.cart_observed_revisions"),
          ),
          false,
        );
        assert.equal(
          queries.some(({ sql }) =>
            sql.includes('INSERT INTO "orders"."outbox_messages"'),
          ),
          false,
        );
        assert.equal(
          queries.some(({ sql }) =>
            sql.startsWith(
              "UPDATE orders.observation_schedule SET next_observation_at=",
            ),
          ),
          true,
        );
      },
    );
  }

  await t.test(
    "a transient Gateway read failure releases the fenced schedule and a later valid read can persist",
    async () => {
      const { AromaObserverTelemetry } =
        await import("../../../apps/aroma-observer/dist/observability.js");
      const { database, queries } = makeDatabase();
      const telemetry = new AromaObserverTelemetry();
      const observer = store(database, {}, telemetry);
      await observer.recover(signal);
      const failureStart = queries.length;
      let reads = 0;
      assert.equal(
        await observer.runOnce(
          gatewayFor(async () => {
            reads++;
            throw new Error("transient transport failure");
          }),
          signal,
        ),
        "failed",
      );
      let observerMetrics = telemetry.render();
      assert.ok(
        observerMetrics.includes(
          'coffee_aroma_observation_recovery_results_total{result="ready"} 1',
        ),
      );
      assert.ok(
        observerMetrics.includes(
          'coffee_aroma_observation_recovery_results_total{result="error"} 0',
        ),
      );
      assert.ok(
        observerMetrics.includes(
          'coffee_aroma_observation_results_total{result="failed"} 1',
        ),
      );
      assert.ok(
        observerMetrics.includes(
          'coffee_aroma_observation_results_total{result="observed"} 0',
        ),
      );

      const failedQueries = queries.slice(failureStart);
      const failedSql = failedQueries.map(({ sql }) => sql);
      const failedReschedule = failedQueries.find(({ sql }) =>
        sql.startsWith(
          "UPDATE orders.observation_schedule SET next_observation_at=",
        ),
      );
      assert.ok(failedReschedule);
      assert.match(failedReschedule.sql, /lease_owner=\$1::uuid/u);
      assert.match(failedReschedule.sql, /lease_until=\$2::timestamptz/u);
      assert.match(failedReschedule.sql, /lease_until>clock_timestamp\(\)/u);
      assert.deepEqual(failedReschedule.values, [
        ownerInstanceId,
        leaseUntil,
        options.intervalMs,
      ]);
      const failedPermits = failedQueries.filter(({ sql }) =>
        sql.startsWith(
          "SELECT EXISTS(SELECT 1 FROM orders.observation_schedule",
        ),
      );
      assert.equal(failedPermits.length, 2);
      assert.deepEqual(
        failedPermits.map(({ values }) => values),
        [
          [ownerInstanceId, leaseUntil],
          [ownerInstanceId, leaseUntil],
        ],
      );
      assert.equal(
        failedSql.some((sql) =>
          sql.startsWith("UPDATE orders.cart_observed_revisions SET state="),
        ),
        false,
      );
      assert.equal(
        failedSql.some((sql) =>
          sql.startsWith("INSERT INTO orders.cart_observed_revisions"),
        ),
        false,
      );
      assert.equal(
        failedSql.some((sql) =>
          sql.startsWith("INSERT INTO orders.cart_observed_lines"),
        ),
        false,
      );
      assert.equal(
        failedSql.some((sql) =>
          sql.includes('INSERT INTO "orders"."outbox_messages"'),
        ),
        false,
      );

      const retryStart = queries.length;
      assert.equal(
        await observer.runOnce(
          gatewayFor(async () => {
            reads++;
            return snapshot;
          }),
          signal,
        ),
        "observed",
      );
      assert.equal(reads, 2);
      observerMetrics = telemetry.render();
      assert.ok(
        observerMetrics.includes(
          'coffee_aroma_observation_results_total{result="failed"} 1',
        ),
      );
      assert.ok(
        observerMetrics.includes(
          'coffee_aroma_observation_results_total{result="observed"} 1',
        ),
      );
      assert.ok(
        observerMetrics.includes(
          "coffee_aroma_observation_fence_failures_total 0",
        ),
      );
      assert.match(
        observerMetrics.find((entry) =>
          entry.startsWith("coffee_aroma_observed_age_ms "),
        ),
        /^coffee_aroma_observed_age_ms [0-9]+$/u,
      );
      const retrySql = queries.slice(retryStart).map(({ sql }) => sql);
      assert.equal(
        retrySql.some((sql) =>
          sql.startsWith("INSERT INTO orders.cart_observed_revisions"),
        ),
        true,
      );
      assert.equal(
        retrySql.some((sql) =>
          sql.includes('INSERT INTO "orders"."outbox_messages"'),
        ),
        true,
      );
    },
  );

  await t.test(
    "stale permit and an overlapping invocation do not issue another read",
    async () => {
      const { AromaObserverTelemetry } =
        await import("../../../apps/aroma-observer/dist/observability.js");
      const stale = makeDatabase({ permitValid: false });
      const telemetry = new AromaObserverTelemetry();
      const staleObserver = store(stale.database, {}, telemetry);
      let staleReads = 0;
      assert.equal(
        await staleObserver.runOnce(
          gatewayFor(async () => {
            staleReads++;
            return snapshot;
          }),
          signal,
        ),
        "idle",
      );
      assert.equal(staleReads, 0);
      const staleMetrics = telemetry.render();
      assert.ok(
        staleMetrics.includes(
          'coffee_aroma_observation_results_total{result="idle"} 1',
        ),
      );
      assert.ok(
        staleMetrics.includes(
          'coffee_aroma_observation_results_total{result="observed"} 0',
        ),
      );
      assert.ok(
        staleMetrics.includes(
          'coffee_aroma_observation_results_total{result="failed"} 0',
        ),
      );
      assert.ok(
        staleMetrics.includes(
          "coffee_aroma_observation_fence_failures_total 1",
        ),
      );
      assert.ok(staleMetrics.includes("coffee_aroma_observed_age_ms 0"));

      const overlapping = makeDatabase();
      const overlapObserver = store(overlapping.database);
      let releaseRead;
      const pendingRead = new Promise((resolve) => {
        releaseRead = resolve;
      });
      let reads = 0;
      const first = overlapObserver.runOnce(
        gatewayFor(async () => {
          reads++;
          return pendingRead;
        }),
        signal,
      );
      while (reads === 0) await new Promise((resolve) => setImmediate(resolve));
      const before = overlapping.queries.length;
      assert.equal(
        await overlapObserver.runOnce(
          gatewayFor(async () => {
            reads++;
            return snapshot;
          }),
          signal,
        ),
        "idle",
      );
      assert.equal(overlapping.queries.length, before);
      releaseRead(snapshot);
      assert.equal(await first, "observed");
      assert.equal(reads, 1);
    },
  );

  await t.test(
    "a lost fence after the safe read returns idle and rolls back the completion transaction",
    async () => {
      const { database, queries } = makeDatabase({ rescheduleRowCount: 0 });
      const observer = store(database);
      let reads = 0;
      assert.equal(
        await observer.runOnce(
          gatewayFor(async () => {
            reads++;
            return snapshot;
          }),
          signal,
        ),
        "idle",
      );
      assert.equal(reads, 1);

      const sql = queries.map(({ sql }) => sql);
      const revisionIndex = sql.findIndex((entry) =>
        entry.startsWith("INSERT INTO orders.cart_observed_revisions"),
      );
      const linesIndex = sql.findIndex((entry) =>
        entry.startsWith("INSERT INTO orders.cart_observed_lines"),
      );
      const outboxIndex = sql.findIndex((entry) =>
        entry.startsWith('INSERT INTO "orders"."outbox_messages"'),
      );
      const rescheduleIndex = sql.findIndex((entry) =>
        entry.startsWith(
          "UPDATE orders.observation_schedule SET next_observation_at=",
        ),
      );
      assert.notEqual(revisionIndex, -1);
      assert.notEqual(linesIndex, -1);
      assert.notEqual(outboxIndex, -1);
      assert.notEqual(rescheduleIndex, -1);
      assert.ok(revisionIndex < linesIndex);
      assert.ok(linesIndex < outboxIndex);
      assert.ok(outboxIndex < rescheduleIndex);

      assert.deepEqual(queries[rescheduleIndex].values, [
        ownerInstanceId,
        leaseUntil,
        options.intervalMs,
      ]);
      assert.equal(sql.filter((entry) => entry === "ROLLBACK").length, 1);
      assert.equal(sql.filter((entry) => entry === "COMMIT").length, 2);
    },
  );

  await t.test(
    "a lost fence before persistence leaves the safe read unobserved",
    async () => {
      const { AromaObserverTelemetry } =
        await import("../../../apps/aroma-observer/dist/observability.js");
      const { database, queries } = makeDatabase({ permitInvalidAtCall: 2 });
      const telemetry = new AromaObserverTelemetry();
      const observer = store(database, {}, telemetry);
      let reads = 0;
      assert.equal(
        await observer.runOnce(
          gatewayFor(async () => {
            reads++;
            return snapshot;
          }),
          signal,
        ),
        "idle",
      );
      assert.equal(reads, 1);
      const observerMetrics = telemetry.render();
      assert.ok(
        observerMetrics.includes(
          'coffee_aroma_observation_results_total{result="idle"} 1',
        ),
      );
      assert.ok(
        observerMetrics.includes(
          'coffee_aroma_observation_results_total{result="observed"} 0',
        ),
      );
      assert.ok(
        observerMetrics.includes(
          'coffee_aroma_observation_results_total{result="failed"} 0',
        ),
      );
      assert.ok(
        observerMetrics.includes(
          "coffee_aroma_observation_fence_failures_total 1",
        ),
      );
      assert.ok(observerMetrics.includes("coffee_aroma_observed_age_ms 0"));

      const sql = queries.map(({ sql }) => sql);
      const permitSql = sql.filter((entry) =>
        entry.startsWith(
          "SELECT EXISTS(SELECT 1 FROM orders.observation_schedule",
        ),
      );
      assert.equal(permitSql.length, 2);
      assert.equal(
        sql.some((entry) =>
          entry.startsWith("SELECT ($1::timestamptz<=clock_timestamp()"),
        ),
        false,
      );
      assert.equal(
        sql.some((entry) =>
          entry.startsWith("SELECT (COALESCE(max(observed_revision),0)+1)"),
        ),
        false,
      );
      assert.equal(
        sql.some((entry) =>
          entry.startsWith("UPDATE orders.cart_observed_revisions SET state="),
        ),
        false,
      );
      assert.equal(
        sql.some((entry) =>
          entry.startsWith("INSERT INTO orders.cart_observed_revisions"),
        ),
        false,
      );
      assert.equal(
        sql.some((entry) =>
          entry.startsWith("INSERT INTO orders.cart_observed_lines"),
        ),
        false,
      );
      assert.equal(
        sql.some((entry) =>
          entry.includes('INSERT INTO "orders"."outbox_messages"'),
        ),
        false,
      );
      assert.equal(
        sql.some((entry) =>
          entry.startsWith(
            "UPDATE orders.observation_schedule SET next_observation_at=",
          ),
        ),
        false,
      );
    },
  );
});

void test("AROMA preparation recovery is idle without work and persists authoritative Desired before waking convergence", async (t) => {
  const orderRef = "ord_01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const itemRef = "itm_01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const productRef = "prd_01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const variantRef = "var_01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const offerRef = "off_01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const contributionLine = {
    order_ref: orderRef,
    contribution_revision: "1",
    offer_ref: offerRef,
    source_grind_key_hash: null,
    quantity_milli: "1000",
    contribution_hash: "a".repeat(64),
    item_refs: [itemRef],
    items: [
      {
        itemRef,
        found: true,
        productRef,
        variantRef,
        offerRef,
        grind: null,
        quantity: "1000",
        mappingOffer: offerRef,
        mappingRevision: "1",
        mappingState: "Active",
        availability: "Available",
      },
    ],
  };
  const contributions = [
    { order_ref: orderRef, contribution_revision: "1", order_version: "2" },
  ];
  const clockRow = {
    now: "2026-10-25 08:00:00.000+00",
    ms: String(Date.parse("2026-10-25T08:00:00.000Z")),
  };
  const options = {
    batchSize: 10,
    maxOrders: 10,
    maxLines: 10,
    maxSnapshotAgeMs: 60_000,
  };
  const sqlResult = (rows, command = "SELECT", rowCount = rows.length) => ({
    rows,
    rowCount,
    command,
  });
  const signal = new AbortController().signal;
  const { AromaPreparationTelemetry } =
    await import("../../../apps/orders-aroma-preparation/dist/observability.js");

  await t.test(
    "consumed mapping replays and invalid source facts never write owner state",
    async (t) => {
      const envelope = JSON.parse(
        readFileSync(
          new URL(
            "../../../contracts/fixtures/positive/events/catalog-mapping-changed.v2.json",
            import.meta.url,
          ),
          "utf8",
        ),
      );
      const payloadHash = canonicalRequestHash(envelope.payload);
      const cases = [
        { key: "wrong-key", reason: "AROMA_PREPARATION_KEY_INVALID" },
        { revision: "3", hash: payloadHash },
        { revision: "2", hash: payloadHash },
        {
          revision: "2",
          hash: "f".repeat(64),
          reason: "AROMA_MAPPING_REVISION_CONFLICT",
        },
        {
          revision: "1",
          snapshot: "2",
          hash: payloadHash,
          reason: "AROMA_MAPPING_SNAPSHOT_REGRESSION",
        },
      ];
      let active;
      const { database, statements } = mockDatabase(t, (sql, values) => {
        if (
          sql === "BEGIN" ||
          sql === "COMMIT" ||
          sql === "ROLLBACK" ||
          sql.startsWith("SET LOCAL ")
        )
          return undefined;
        if (
          sql.includes(
            "pg_advisory_xact_lock(hashtext('orders:aroma-primary'))",
          )
        ) {
          assert.notEqual(active.key, "wrong-key");
          return { rows: [{ locked: true }], rowCount: 1, command: "SELECT" };
        }
        if (
          sql.startsWith(
            "SELECT mapping_revision::text,catalog_snapshot_revision::text,payload_hash",
          )
        ) {
          assert.deepEqual(values, [
            envelope.payload.productRef,
            envelope.payload.variantRef,
          ]);
          return {
            rows: [
              {
                mapping_revision: active.revision,
                catalog_snapshot_revision: active.snapshot ?? "1",
                payload_hash: active.hash,
              },
            ],
            rowCount: 1,
            command: "SELECT",
          };
        }
        assert.fail(`unexpected SQL before mapping source admission: ${sql}`);
      });
      const store = createAromaPreparationStore(database, options);
      for (const item of cases) {
        active = item;
        const start = statements.length;
        const handling = withTransaction(
          database,
          { mode: "background", signal },
          (tx) =>
            store.handle(
              tx,
              envelope,
              { key: item.key ?? envelope.aggregate.ref },
              signal,
            ),
        );
        if (item.reason) {
          await assert.rejects(handling, (error) => {
            assert.equal(error.name, "InboxProcessingError");
            assert.deepEqual(error.failure, {
              kind: "permanent",
              reason: item.reason,
            });
            return true;
          });
        } else await handling;
        const executed = statements.slice(start);
        assert.equal(
          executed.filter((sql) => sql === "COMMIT").length,
          item.reason ? 0 : 1,
        );
        assert.equal(
          executed.filter((sql) => sql === "ROLLBACK").length,
          item.reason ? 1 : 0,
        );
        assert.equal(
          executed.some((sql) => /^(?:INSERT|UPDATE|DELETE)\b/u.test(sql)),
          false,
        );
        assert.equal(
          executed.filter((sql) =>
            sql.startsWith("SELECT mapping_revision::text"),
          ).length,
          item.key ? 0 : 1,
        );
      }
    },
  );

  await t.test(
    "invalid OrderConfirmed source rolls back before durable Inbox quarantine",
    async (t) => {
      const envelope = JSON.parse(
        readFileSync(
          new URL(
            "../../../contracts/fixtures/positive/events/order-confirmed.v1.json",
            import.meta.url,
          ),
          "utf8",
        ),
      );
      const leaseOwner = "orders-aroma-preparation-v1";
      const rejectedSources = [
        {
          name: "foreign customer binding",
          messageId: "msg_01ARZ3NDEKTSV4RRFFQ69G5FAZ",
          payload: { customerRef: "cus_01ARZ3NDEKTSV4RRFFQ69G5FAW" },
        },
        {
          name: "non-current contribution revision",
          messageId: "msg_01ARZ3NDEKTSV4RRFFQ69G5FB0",
          payload: { contributionRevision: "2" },
        },
        {
          name: "stale order version",
          messageId: "msg_01ARZ3NDEKTSV4RRFFQ69G5FB1",
          aggregate: { version: "6" },
          payload: { orderVersion: "6" },
        },
      ];
      const transactions = [];
      let currentTransaction;
      let confirmedSourceReads = 0;
      let activeEnvelope;
      const { database, statements } = mockDatabase(t, (sql, values) => {
        if (sql === "BEGIN") {
          currentTransaction = `tx-${transactions.length + 1}`;
          transactions.push([currentTransaction, "BEGIN"]);
          return undefined;
        }
        if (sql === "COMMIT" || sql === "ROLLBACK") {
          transactions.push([currentTransaction, sql]);
          return undefined;
        }
        if (sql.startsWith("SET LOCAL ")) return undefined;
        if (sql.startsWith('INSERT INTO "public"."inbox_messages"')) {
          assert.equal(values[0], activeEnvelope.messageId);
          assert.equal(values[1], activeEnvelope.messageType);
          assert.equal(values[6], leaseOwner);
          assert.equal(values[3], canonicalRequestHash(activeEnvelope));
          assert.equal(values[8], canonicalRequestHash(activeEnvelope.payload));
          return sqlResult(
            [{ message_id: activeEnvelope.messageId }],
            "INSERT",
            1,
          );
        }
        if (
          sql.startsWith("SELECT ") &&
          sql.includes('FROM "public"."inbox_messages"')
        )
          return sqlResult([
            {
              message_id: activeEnvelope.messageId,
              message_type: activeEnvelope.messageType,
              received_at: activeEnvelope.occurredAt,
              envelope: activeEnvelope,
              payload_hash: canonicalRequestHash(activeEnvelope),
              state: "Processing",
              lease_owner: leaseOwner,
              lease_until_ms: "1790000000000",
              attempt: 1,
              processed_at: null,
              quarantine_reason: null,
            },
          ]);
        if (
          sql.includes(
            "pg_advisory_xact_lock(hashtext('orders:aroma-primary'))",
          )
        )
          return sqlResult([{ locked: true }]);
        if (sql.includes("FROM orders.order_desired_contributions c")) {
          confirmedSourceReads++;
          assert.deepEqual(values, [
            activeEnvelope.payload.orderRef,
            activeEnvelope.payload.contributionRevision,
            activeEnvelope.payload.orderVersion,
            activeEnvelope.payload.customerRef,
            activeEnvelope.payload.confirmedAt,
          ]);
          assert.match(sql, /c\.order_ref=\$1/u);
          assert.match(sql, /c\.contribution_revision=\$2::bigint/u);
          assert.match(sql, /c\.order_version=\$3::bigint/u);
          assert.match(sql, /c\.state='Current'/u);
          assert.match(sql, /o\.status='Confirmed'/u);
          assert.match(sql, /o\.customer_ref=\$4/u);
          assert.match(
            sql,
            /date_trunc\('milliseconds',o\.confirmed_at\)=\$5::timestamptz/u,
          );
          return sqlResult([{ valid: false }]);
        }
        if (sql.startsWith('UPDATE "public"."inbox_messages"')) {
          assert.match(sql, /SET state = 'Quarantined'/u);
          assert.deepEqual(values.slice(0, 3), [
            activeEnvelope.messageId,
            leaseOwner,
            "AROMA_CONFIRMATION_SOURCE_INVALID",
          ]);
          return sqlResult(
            [{ message_id: activeEnvelope.messageId }],
            "UPDATE",
            1,
          );
        }
        if (sql.startsWith('INSERT INTO "public"."inbox_quarantine"')) {
          assert.deepEqual(values.slice(0, 6), [
            leaseOwner,
            "coffee.orders.lifecycle.v1",
            0,
            "42",
            activeEnvelope.messageId,
            activeEnvelope.messageType,
          ]);
          assert.equal(values[11], "AROMA_CONFIRMATION_SOURCE_INVALID");
          return sqlResult(
            [{ topic: "coffee.orders.lifecycle.v1" }],
            "INSERT",
            1,
          );
        }
        assert.fail(
          `unexpected SQL for rejected OrderConfirmed source: ${sql}`,
        );
      });
      const inbox = createSqlInboxStore(database, {
        consumerName: leaseOwner,
      });
      const telemetry = new AromaPreparationTelemetry();
      const store = createAromaPreparationStore(database, options, telemetry);
      let offsetCommits = 0;

      for (const item of rejectedSources) {
        activeEnvelope = {
          ...envelope,
          messageId: item.messageId,
          aggregate: { ...envelope.aggregate, ...item.aggregate },
          payload: { ...envelope.payload, ...item.payload },
        };
        const transactionStart = transactions.length;
        await processKafkaRecord(
          {
            ...kafkaRecord(0, "42"),
            key: activeEnvelope.aggregate.ref,
            value: JSON.stringify(activeEnvelope),
          },
          {
            runtime: "orders-aroma-preparation",
            groupId: leaseOwner,
            topics: ["coffee.orders.lifecycle.v1"],
            binding: {
              processing: "durable",
              database,
              inbox,
              decode: (value) => value,
              handle: (transaction, message, record, handlerSignal) =>
                store.handle(transaction, message, record, handlerSignal),
            },
            leaseMs: 30_000,
            maxMessageBytes: 1_048_576,
            signal,
            commit: async () => {
              offsetCommits++;
            },
          },
        );
        const itemTransactions = transactions
          .slice(transactionStart)
          .map(([, outcome]) => outcome);
        assert.deepEqual(itemTransactions, [
          "BEGIN",
          "ROLLBACK",
          "BEGIN",
          "COMMIT",
        ]);
        assert.equal(offsetCommits, rejectedSources.indexOf(item) + 1);
      }

      assert.equal(confirmedSourceReads, rejectedSources.length);
      assert.equal(offsetCommits, rejectedSources.length);
      assert.equal(
        statements.some(
          (sql) =>
            /^(?:INSERT|UPDATE|DELETE)\b/u.test(sql) &&
            !sql.startsWith('INSERT INTO "public"."inbox_messages"') &&
            !sql.startsWith('UPDATE "public"."inbox_messages"') &&
            !sql.startsWith('INSERT INTO "public"."inbox_quarantine"'),
        ),
        false,
        "invalid confirmation facts cannot reach Desired, wake, projection, or Outbox writes",
      );
      const metrics = telemetry.render();
      assert.ok(
        metrics.includes(
          'coffee_aroma_preparation_inbox_results_total{result="error"} 3',
        ),
      );
      assert.ok(
        metrics.includes(
          'coffee_aroma_preparation_inbox_results_total{result="order_confirmed"} 0',
        ),
      );
      assert.ok(
        metrics.includes(
          'coffee_aroma_preparation_recompute_results_total{result="changed"} 0',
        ),
      );
      assert.ok(
        metrics.includes(
          'coffee_aroma_preparation_projection_results_total{result="changed"} 0',
        ),
      );
    },
  );

  await t.test(
    "missing Desired keeps an accepted reconciliation event retryable before Inbox acknowledgment",
    async (t) => {
      const intent = JSON.parse(
        readFileSync(
          new URL(
            "../../../contracts/fixtures/positive/events/order-reconciliation-requested.v1.json",
            import.meta.url,
          ),
          "utf8",
        ),
      );
      const leaseOwner = "orders-aroma-preparation-v1";
      const signal = new AbortController().signal;
      const { database, statements } = mockDatabase(t, (sql, values) => {
        if (
          sql === "BEGIN" ||
          sql === "COMMIT" ||
          sql === "ROLLBACK" ||
          sql.startsWith("SET LOCAL ")
        )
          return undefined;
        if (sql.startsWith('INSERT INTO "public"."inbox_messages"')) {
          assert.equal(values[0], intent.messageId);
          assert.equal(values[1], intent.messageType);
          assert.equal(values[6], leaseOwner);
          return sqlResult([{ message_id: intent.messageId }], "INSERT", 1);
        }
        if (
          sql.startsWith("SELECT ") &&
          sql.includes('FROM "public"."inbox_messages"')
        )
          return sqlResult([
            {
              message_id: intent.messageId,
              message_type: intent.messageType,
              received_at: intent.occurredAt,
              payload: intent,
              payload_hash: canonicalRequestHash(intent),
              state: "Processing",
              lease_owner: leaseOwner,
              lease_until_ms: 31_000,
              attempt: 1,
              processed_at: null,
              quarantine_reason: null,
            },
          ]);
        if (
          sql.includes(
            "pg_advisory_xact_lock(hashtext('orders:aroma-primary'))",
          )
        )
          return sqlResult([{ locked: true }]);
        if (sql.includes("JOIN orders.order_history h USING(order_ref)")) {
          assert.deepEqual(values.slice(0, 4), [
            intent.payload.orderRef,
            intent.payload.orderVersion,
            intent.payload.requestedAt,
            intent.messageId,
          ]);
          assert.deepEqual(JSON.parse(values[4]), intent);
          return sqlResult([{ valid: true }]);
        }
        if (
          sql ===
          "SELECT desired_revision::text,desired_hash,created_at::text FROM orders.cart_desired_revisions WHERE cart_scope_ref='aroma-primary' AND state='Current'"
        )
          return sqlResult([]);
        assert.fail(`unexpected SQL for pending reconciliation facts: ${sql}`);
      });
      const inbox = createSqlInboxStore(database, {
        consumerName: leaseOwner,
      });
      const store = createAromaPreparationStore(database, options);
      let offsetCommits = 0;

      await assert.rejects(
        processKafkaRecord(
          {
            ...kafkaRecord(0, "1"),
            key: intent.aggregate.ref,
            value: JSON.stringify(intent),
          },
          {
            runtime: "orders-aroma-preparation",
            groupId: leaseOwner,
            topics: ["coffee.orders.lifecycle.v1"],
            binding: {
              processing: "durable",
              database,
              inbox,
              decode: (value) => value,
              handle: (transaction, envelope, record, handlerSignal) =>
                store.handle(transaction, envelope, record, handlerSignal),
            },
            leaseMs: 30_000,
            maxMessageBytes: 1_048_576,
            signal,
            commit: async () => {
              offsetCommits++;
            },
          },
        ),
        (error) => {
          assert.equal(error.name, "InboxProcessingError");
          assert.deepEqual(error.failure, {
            kind: "transient",
            reason: "AROMA_RECONCILIATION_FACTS_PENDING",
          });
          return true;
        },
      );

      assert.equal(
        statements.some((sql) => sql === "COMMIT"),
        false,
        "the Inbox acquire and owner handler share a transaction that must roll back",
      );
      assert.equal(statements.at(-1), "ROLLBACK");
      assert.equal(
        offsetCommits,
        0,
        "failed transient handling cannot commit Kafka offset",
      );
      assert.ok(
        statements.some((sql) =>
          sql.startsWith('INSERT INTO "public"."inbox_messages"'),
        ),
        "the original reconciliation message was presented to Inbox",
      );
      assert.ok(
        statements.some((sql) =>
          sql.includes("JOIN orders.order_history h USING(order_ref)"),
        ),
        "the accepted owner intent was validated before checking current Desired",
      );
      assert.ok(
        statements.some((sql) =>
          sql.includes("FROM orders.cart_desired_revisions"),
        ),
        "current Desired absence is the transient boundary",
      );
      assert.equal(
        statements.some((sql) => sql.includes("SET state = 'Processed'")),
        false,
        "transient Preparation failure must not acknowledge Inbox",
      );
      assert.equal(
        statements.some(
          (sql) =>
            /^(?:INSERT|UPDATE|DELETE)\b/u.test(sql) &&
            !sql.startsWith('INSERT INTO "public"."inbox_messages"'),
        ),
        false,
        "no owner-state write or reconciliation effect precedes the pending-facts retry",
      );
    },
  );

  await t.test(
    "recovery without confirmed facts has no durable effects",
    async (t) => {
      const { database, statements } = mockDatabase(t, (sql) => {
        if (
          sql === "BEGIN" ||
          sql === "COMMIT" ||
          sql === "ROLLBACK" ||
          sql.startsWith("SET LOCAL ")
        )
          return undefined;
        if (
          sql.includes(
            "pg_advisory_xact_lock(hashtext('orders:aroma-primary'))",
          )
        )
          return { rows: [{ locked: true }], rowCount: 1, command: "SELECT" };
        if (
          sql.includes("FROM orders.orders o WHERE o.status='Confirmed' AND (")
        )
          return { rows: [], rowCount: 0, command: "SELECT" };
        if (sql.includes("FROM orders.order_desired_contributions c"))
          return { rows: [], rowCount: 0, command: "SELECT" };
        if (sql.includes("FROM orders.order_desired_contribution_lines l"))
          return { rows: [], rowCount: 0, command: "SELECT" };
        if (
          sql.includes(
            "FROM orders.cart_desired_revisions WHERE cart_scope_ref='aroma-primary' AND state='Current'",
          )
        )
          return { rows: [], rowCount: 0, command: "SELECT" };
        if (sql.includes("FROM orders.outbox_messages b JOIN orders.orders o"))
          return { rows: [], rowCount: 0, command: "SELECT" };
        if (
          sql.includes(
            "FROM orders.cart_observed_revisions WHERE cart_scope_ref='aroma-primary'",
          )
        )
          return { rows: [], rowCount: 0, command: "SELECT" };
        if (
          sql.includes(
            "FROM orders.convergence_leases WHERE cart_scope_ref='aroma-primary'",
          )
        )
          return { rows: [], rowCount: 0, command: "SELECT" };
        if (sql.includes("EXISTS(SELECT 1 FROM orders.mutation_reservations"))
          return {
            rows: [{ unresolved: false, unknown: false }],
            rowCount: 1,
            command: "SELECT",
          };
        assert.fail(`unexpected Aroma Preparation query: ${sql}`);
      });
      const store = createAromaPreparationStore(database, options);
      assert.equal(await store.runOnce(signal), "idle");
      assert.equal(
        statements.some((sql) => /^(?:INSERT|UPDATE|DELETE)\b/u.test(sql)),
        false,
      );
    },
  );

  await t.test(
    "recovery advisory-lock failure rolls back and releases before any owner reads",
    async (t) => {
      const lockError = Object.assign(new Error("serialization lock failed"), {
        code: "40001",
      });
      const { database, statements, releases } = mockDatabase(t, (sql) => {
        if (
          sql === "BEGIN" ||
          sql === "ROLLBACK" ||
          sql.startsWith("SET LOCAL ")
        )
          return undefined;
        if (
          sql.includes(
            "pg_advisory_xact_lock(hashtext('orders:aroma-primary'))",
          )
        )
          throw lockError;
        assert.fail(`unexpected SQL after failed Preparation lock: ${sql}`);
      });
      const store = createAromaPreparationStore(database, options);

      await assert.rejects(store.runOnce(signal), (error) => {
        assert.equal(error.code, "DB_QUERY_FAILED");
        assert.equal(error.sqlState, "40001");
        return true;
      });

      const lockIndex = statements.findIndex((sql) =>
        sql.includes("pg_advisory_xact_lock(hashtext('orders:aroma-primary'))"),
      );
      assert.notEqual(lockIndex, -1);
      assert.deepEqual(statements.slice(lockIndex + 1), ["ROLLBACK"]);
      assert.equal(statements.includes("COMMIT"), false);
      assert.equal(
        statements.some((sql) => /^(?:INSERT|UPDATE|DELETE)\b/u.test(sql)),
        false,
      );
      assert.deepEqual(releases, [false]);
    },
  );

  await t.test(
    "valid authoritative Desired facts persist revision, proofs, wake, and envelope in order",
    async (t) => {
      const telemetry = new AromaPreparationTelemetry();
      const persisted = [];
      let currentDesired;
      let wakePresent = false;
      let outboxSequence = 0;
      let conflictNextOutbox = false;
      let outboxReads = 0;
      let loseNextCommitReply = false;
      const mock = mockDatabase(t, (sql, values) => {
        if (sql === "COMMIT" && loseNextCommitReply) {
          loseNextCommitReply = false;
          throw Object.assign(new Error("simulated lost COMMIT reply"), {
            code: "08006",
          });
        }
        if (
          sql === "BEGIN" ||
          sql === "COMMIT" ||
          sql === "ROLLBACK" ||
          sql.startsWith("SET LOCAL ")
        )
          return undefined;
        if (
          sql.includes(
            "pg_advisory_xact_lock(hashtext('orders:aroma-primary'))",
          )
        )
          return { rows: [{ locked: true }], rowCount: 1, command: "SELECT" };
        if (
          sql.includes("FROM orders.orders o WHERE o.status='Confirmed' AND (")
        )
          return { rows: [], rowCount: 0, command: "SELECT" };
        if (sql.includes("FROM orders.order_desired_contributions c"))
          return {
            rows: contributions,
            rowCount: contributions.length,
            command: "SELECT",
          };
        if (sql.includes("FROM orders.order_desired_contribution_lines l"))
          return { rows: [contributionLine], rowCount: 1, command: "SELECT" };
        if (
          sql.includes(
            "FROM orders.cart_desired_revisions WHERE cart_scope_ref='aroma-primary' AND state='Current'",
          )
        )
          return {
            rows: currentDesired ? [currentDesired] : [],
            rowCount: currentDesired ? 1 : 0,
            command: "SELECT",
          };
        if (sql.startsWith("SELECT (COALESCE(max(desired_revision),0)+1)"))
          return { rows: [{ revision: "1" }], rowCount: 1, command: "SELECT" };
        if (
          sql.startsWith(
            "UPDATE orders.cart_desired_revisions SET state='Superseded'",
          )
        ) {
          persisted.push("supersede");
          return { rows: [], rowCount: 0, command: "UPDATE" };
        }
        if (sql.startsWith("INSERT INTO orders.cart_desired_revisions")) {
          persisted.push("revision");
          assert.deepEqual(values, ["1", values[1], "2"]);
          currentDesired = {
            desired_revision: "1",
            desired_hash: values[1],
            created_at: clockRow.now,
          };
          return {
            rows: [currentDesired],
            rowCount: 1,
            command: "INSERT",
          };
        }
        if (sql.startsWith("INSERT INTO orders.cart_desired_lines")) {
          persisted.push("lines");
          assert.equal(values[0], "1");
          const lines = JSON.parse(values[1]);
          assert.deepEqual(
            lines.map(
              ({
                offerRef,
                sourceGrindKeyHash,
                quantityMilli,
                contributingOrderRefs,
              }) => ({
                offerRef,
                sourceGrindKeyHash,
                quantityMilli,
                contributingOrderRefs,
              }),
            ),
            [
              {
                offerRef,
                sourceGrindKeyHash: null,
                quantityMilli: "1000",
                contributingOrderRefs: [orderRef],
              },
            ],
          );
          assert.match(lines[0].contributionHash, /^[0-9a-f]{64}$/u);
          return { rows: [], rowCount: 1, command: "INSERT" };
        }
        if (sql.startsWith("INSERT INTO orders.cart_desired_blockers")) {
          persisted.push("blockers");
          assert.deepEqual(values, ["1", "[]"]);
          return { rows: [], rowCount: 0, command: "INSERT" };
        }
        if (sql.startsWith("INSERT INTO orders.cart_desired_order_facts")) {
          persisted.push("facts");
          assert.equal(values[0], "1");
          const facts = JSON.parse(values[1]);
          assert.equal(facts.length, 1);
          assert.deepEqual(facts[0], {
            orderRef,
            contributionRevision: "1",
            contributionHash: facts[0].contributionHash,
          });
          assert.match(facts[0].contributionHash, /^[0-9a-f]{64}$/u);
          return { rows: [], rowCount: 1, command: "INSERT" };
        }
        if (sql.startsWith("INSERT INTO orders.convergence_work")) {
          persisted.push("wake");
          assert.deepEqual(values, ["1", "Recovery"]);
          wakePresent = true;
          return { rows: [], rowCount: 1, command: "INSERT" };
        }
        if (
          sql.includes(
            "AS now,(extract(epoch FROM clock_timestamp())*1000)::bigint::text AS ms",
          )
        )
          return { rows: [clockRow], rowCount: 1, command: "SELECT" };
        if (sql.startsWith("SELECT (COALESCE(max(aggregate_sequence),0)+1)"))
          return {
            rows: [{ sequence: String(++outboxSequence) }],
            rowCount: 1,
            command: "SELECT",
          };
        if (
          sql.startsWith(
            'SELECT aggregate_sequence FROM "orders"."outbox_messages"',
          )
        )
          return outboxSequence > 1
            ? {
                rows: [{ aggregate_sequence: String(outboxSequence - 1) }],
                rowCount: 1,
                command: "SELECT",
              }
            : { rows: [], rowCount: 0, command: "SELECT" };
        if (
          sql.startsWith(
            "SELECT payload_hash, message_type, topic, aggregate_ref",
          )
        ) {
          if (conflictNextOutbox && ++outboxReads === 2)
            return {
              rows: [
                { payload_hash: "f".repeat(64), message_type: "Other.v1" },
              ],
              rowCount: 1,
              command: "SELECT",
            };
          return { rows: [], rowCount: 0, command: "SELECT" };
        }
        if (sql.startsWith('INSERT INTO "orders"."outbox_messages"')) {
          if (conflictNextOutbox) {
            persisted.push("outbox-conflict");
            return { rows: [], rowCount: 0, command: "INSERT" };
          }
          persisted.push("outbox");
          assert.equal(values[1], "AromaConvergenceRequested.v1");
          assert.equal(values[2], "coffee.aroma.cart.commands.v1");
          assert.equal(values[3], "aroma-primary");
          assert.equal(values[4], BigInt(outboxSequence));
          assert.equal(values[5], String(outboxSequence));
          const envelope = JSON.parse(values[8]);
          assert.equal(envelope.messageType, "AromaConvergenceRequested.v1");
          assert.equal(envelope.producer, "orders-aroma-preparation");
          assert.equal(envelope.aggregate.ref, "aroma-primary");
          assert.equal(envelope.aggregate.version, String(outboxSequence));
          assert.deepEqual(envelope.payload, {
            cartScopeRef: "aroma-primary",
            desiredRevision: "1",
            reason: "Recovery",
            orderRef: null,
          });
          return {
            rows: [{ message_id: values[0] }],
            rowCount: 1,
            command: "INSERT",
          };
        }
        if (sql.includes("FROM orders.outbox_messages b JOIN orders.orders o"))
          return { rows: [], rowCount: 0, command: "SELECT" };
        if (
          sql.includes(
            "FROM orders.convergence_work WHERE cart_scope_ref='aroma-primary'",
          )
        )
          return {
            rows: wakePresent ? [{ desired_revision: "1", dirty: true }] : [],
            rowCount: wakePresent ? 1 : 0,
            command: "SELECT",
          };
        if (
          sql.includes(
            "FROM orders.cart_observed_revisions WHERE cart_scope_ref='aroma-primary'",
          )
        )
          return { rows: [], rowCount: 0, command: "SELECT" };
        if (
          sql.includes(
            "FROM orders.convergence_leases WHERE cart_scope_ref='aroma-primary'",
          )
        )
          return { rows: [], rowCount: 0, command: "SELECT" };
        if (sql.includes("FROM orders.convergence_attempts"))
          return { rows: [], rowCount: 0, command: "SELECT" };
        if (sql.includes("EXISTS(SELECT 1 FROM orders.mutation_reservations"))
          return {
            rows: [{ unresolved: false, unknown: false }],
            rowCount: 1,
            command: "SELECT",
          };
        assert.fail(`unexpected Aroma Preparation query: ${sql}`);
      });
      const releases = [];
      const release = mock.connection.release;
      mock.connection.release = (destroy) => {
        releases.push(destroy);
        release(destroy);
      };
      const { database, statements } = mock;
      const store = createAromaPreparationStore(database, options, telemetry);
      assert.equal(await store.runOnce(signal), "prepared");
      assert.deepEqual(persisted, [
        "supersede",
        "revision",
        "lines",
        "blockers",
        "facts",
        "wake",
        "outbox",
      ]);
      const revisionIndex = statements.findIndex((sql) =>
        sql.startsWith("INSERT INTO orders.cart_desired_revisions"),
      );
      const wakeIndex = statements.findIndex((sql) =>
        sql.startsWith("INSERT INTO orders.convergence_work"),
      );
      const outboxIndex = statements.findIndex((sql) =>
        sql.startsWith('INSERT INTO "orders"."outbox_messages"'),
      );
      assert.ok(revisionIndex < wakeIndex && wakeIndex < outboxIndex);

      wakePresent = false;
      const repairStart = statements.length;
      const persistedStart = persisted.length;
      assert.equal(await store.runOnce(signal), "prepared");
      assert.deepEqual(persisted.slice(persistedStart), ["wake", "outbox"]);
      const repairedStatements = statements.slice(repairStart);
      assert.equal(
        repairedStatements.some((sql) =>
          /^(?:INSERT INTO orders\.cart_desired_|UPDATE orders\.cart_desired_revisions)/u.test(
            sql,
          ),
        ),
        false,
      );
      assert.equal(outboxSequence, 2);

      const repeatStart = statements.length;
      const repeatPersistedStart = persisted.length;
      assert.equal(await store.runOnce(signal), "idle");
      assert.deepEqual(persisted.slice(repeatPersistedStart), []);
      assert.equal(
        statements
          .slice(repeatStart)
          .some((sql) => /^(?:INSERT|UPDATE|DELETE)\b/u.test(sql)),
        false,
      );
      const stableMetrics = telemetry.render();
      assert.ok(
        stableMetrics.includes(
          'coffee_aroma_preparation_recompute_results_total{result="changed"} 1',
        ),
      );
      assert.ok(
        stableMetrics.includes(
          'coffee_aroma_preparation_recompute_results_total{result="unchanged"} 2',
        ),
      );
      assert.ok(
        stableMetrics.includes(
          'coffee_aroma_preparation_recovery_results_total{result="completed"} 2',
        ),
      );
      assert.ok(
        stableMetrics.includes(
          'coffee_aroma_preparation_recovery_results_total{result="idle"} 1',
        ),
      );
      assert.ok(
        stableMetrics.includes(
          'coffee_aroma_preparation_projection_results_total{result="unchanged"} 3',
        ),
      );
      assert.ok(
        stableMetrics.includes("coffee_aroma_preparation_desired_revision 1"),
      );
      const desiredAge = Number(
        stableMetrics
          .find((metric) =>
            metric.startsWith("coffee_aroma_preparation_desired_age_ms "),
          )
          ?.split(" ")[1],
      );
      const expectedDesiredAge =
        Date.now() - Date.parse("2026-10-25T08:00:00.000Z");
      assert.ok(desiredAge > 60_000);
      assert.ok(desiredAge >= expectedDesiredAge - 5_000);
      assert.ok(desiredAge <= expectedDesiredAge + 5_000);

      // Model rows visible after COMMIT applied but its reply was lost. This
      // verifies retry behavior, not PostgreSQL durability or atomicity.
      currentDesired = undefined;
      wakePresent = false;
      outboxSequence = 0;
      outboxReads = 0;
      conflictNextOutbox = false;
      loseNextCommitReply = true;
      const unknownCommitStart = statements.length;
      const unknownCommitPersistedStart = persisted.length;
      const unknownCommitReleaseStart = releases.length;
      await assert.rejects(store.runOnce(signal), (error) => {
        assert.equal(error.code, "TRANSACTION_OUTCOME_UNKNOWN");
        return true;
      });
      const unknownCommitStatements = statements.slice(unknownCommitStart);
      assert.deepEqual(persisted.slice(unknownCommitPersistedStart), [
        "supersede",
        "revision",
        "lines",
        "blockers",
        "facts",
        "wake",
        "outbox",
      ]);
      assert.equal(
        unknownCommitStatements.filter((sql) => sql === "COMMIT").length,
        1,
      );
      assert.equal(
        unknownCommitStatements.filter((sql) => sql === "ROLLBACK").length,
        0,
      );
      assert.equal(currentDesired?.desired_revision, "1");
      assert.equal(wakePresent, true);
      assert.equal(outboxSequence, 1);
      assert.equal(
        unknownCommitStatements.some((sql) =>
          sql.includes("write_card_projection"),
        ),
        false,
      );
      assert.equal(
        unknownCommitStatements.some((sql) =>
          sql.startsWith("INSERT INTO orders.order_aroma_projection_history"),
        ),
        false,
      );
      assert.deepEqual(releases.slice(unknownCommitReleaseStart), [true]);

      const recoveryStart = statements.length;
      const recoveryPersistedStart = persisted.length;
      const recoveryReleaseStart = releases.length;
      assert.equal(await store.runOnce(signal), "idle");
      assert.deepEqual(persisted.slice(recoveryPersistedStart), []);
      assert.equal(
        statements
          .slice(recoveryStart)
          .some((sql) => /^(?:INSERT|UPDATE|DELETE)\b/u.test(sql)),
        false,
      );
      assert.deepEqual(releases.slice(recoveryReleaseStart), [false]);

      currentDesired = undefined;
      wakePresent = false;
      outboxSequence = 0;
      outboxReads = 0;
      conflictNextOutbox = true;
      const conflictStart = statements.length;
      const conflictPersistedStart = persisted.length;
      await assert.rejects(store.runOnce(signal), (error) => {
        assert.equal(error.code, "AROMA_PREPARATION_OUTBOX_CONFLICT");
        return true;
      });
      const conflictStatements = statements.slice(conflictStart);
      assert.deepEqual(persisted.slice(conflictPersistedStart), [
        "supersede",
        "revision",
        "lines",
        "blockers",
        "facts",
        "wake",
        "outbox-conflict",
      ]);
      assert.equal(
        conflictStatements.filter((sql) => sql === "COMMIT").length,
        0,
      );
      assert.equal(
        conflictStatements.filter((sql) => sql === "ROLLBACK").length,
        1,
      );
      assert.equal(
        conflictStatements.some((sql) => sql.includes("write_card_projection")),
        false,
      );
      assert.equal(
        conflictStatements.some((sql) =>
          sql.startsWith("INSERT INTO orders.order_aroma_projection_history"),
        ),
        false,
      );
    },
  );

  await t.test(
    "recovery replays an accepted reconciliation intent without rewriting an unchanged Desired",
    async (t) => {
      const intent = JSON.parse(
        readFileSync(
          new URL(
            "../../../contracts/fixtures/positive/events/order-reconciliation-requested.v1.json",
            import.meta.url,
          ),
          "utf8",
        ),
      );
      intent.aggregate.version = "2";
      intent.payload.orderVersion = "2";
      intent.payload.requestedAt = intent.occurredAt;
      const desiredHash = buildDesired(
        contributions,
        [contributionLine],
        options.maxOrders,
        options.maxLines,
      ).hash;
      const effects = [];
      let alreadyWoken = false;
      const { database, statements } = mockDatabase(t, (sql, values) => {
        if (
          sql === "BEGIN" ||
          sql === "COMMIT" ||
          sql === "ROLLBACK" ||
          sql.startsWith("SET LOCAL ")
        )
          return undefined;
        if (
          sql.includes(
            "pg_advisory_xact_lock(hashtext('orders:aroma-primary'))",
          )
        )
          return { rows: [{ locked: true }], rowCount: 1, command: "SELECT" };
        if (
          sql.includes("FROM orders.orders o WHERE o.status='Confirmed' AND (")
        )
          return { rows: [], rowCount: 0, command: "SELECT" };
        if (sql.includes("FROM orders.order_desired_contributions c"))
          return {
            rows: contributions,
            rowCount: contributions.length,
            command: "SELECT",
          };
        if (sql.includes("FROM orders.order_desired_contribution_lines l"))
          return {
            rows: [contributionLine],
            rowCount: 1,
            command: "SELECT",
          };
        if (
          sql.includes(
            "FROM orders.cart_desired_revisions WHERE cart_scope_ref='aroma-primary' AND state='Current'",
          )
        )
          return {
            rows: [
              {
                desired_revision: "1",
                desired_hash: desiredHash,
                created_at: clockRow.now,
              },
            ],
            rowCount: 1,
            command: "SELECT",
          };
        if (
          sql.includes("FROM orders.outbox_messages b JOIN orders.orders o")
        ) {
          effects.push("pending-intent");
          assert.deepEqual(values, [options.batchSize]);
          return {
            rows: [{ envelope: intent }],
            rowCount: 1,
            command: "SELECT",
          };
        }
        if (sql.includes("JOIN orders.order_history h USING(order_ref)")) {
          effects.push("validate-history-outbox-proof");
          assert.deepEqual(values.slice(0, 4), [
            orderRef,
            "2",
            intent.payload.requestedAt,
            intent.messageId,
          ]);
          assert.deepEqual(JSON.parse(values[4]), intent);
          return {
            rows: [{ valid: true }],
            rowCount: 1,
            command: "SELECT",
          };
        }
        if (
          sql.startsWith(
            "SELECT EXISTS(SELECT 1 FROM orders.outbox_messages WHERE message_type='AromaConvergenceRequested.v1'",
          )
        ) {
          effects.push("check-causation");
          assert.deepEqual(values, [intent.messageId]);
          return {
            rows: [{ present: alreadyWoken }],
            rowCount: 1,
            command: "SELECT",
          };
        }
        if (sql.startsWith("INSERT INTO orders.convergence_work")) {
          effects.push("wake");
          assert.deepEqual(values, ["1", "OperatorRequested"]);
          return { rows: [], rowCount: 1, command: "INSERT" };
        }
        if (sql.startsWith("SELECT clock_timestamp()::text AS now,"))
          return { rows: [clockRow], rowCount: 1, command: "SELECT" };
        if (
          sql.startsWith(
            "SELECT (COALESCE(max(aggregate_sequence),0)+1)::text AS sequence",
          )
        ) {
          assert.deepEqual(values, ["aroma-primary"]);
          return {
            rows: [{ sequence: "1" }],
            rowCount: 1,
            command: "SELECT",
          };
        }
        if (
          sql.startsWith(
            'SELECT aggregate_sequence FROM "orders"."outbox_messages"',
          )
        )
          return { rows: [], rowCount: 0, command: "SELECT" };
        if (
          sql.startsWith(
            "SELECT payload_hash, message_type, topic, aggregate_ref",
          )
        )
          return { rows: [], rowCount: 0, command: "SELECT" };
        if (sql.startsWith('INSERT INTO "orders"."outbox_messages"')) {
          effects.push("outbox");
          assert.equal(values[1], "AromaConvergenceRequested.v1");
          assert.equal(values[2], "coffee.aroma.cart.commands.v1");
          assert.equal(values[3], "aroma-primary");
          assert.equal(values[4], 1n);
          assert.equal(values[5], "1");
          assert.equal(values[12], intent.correlationId);
          assert.equal(values[13], intent.messageId);
          const envelope = JSON.parse(values[8]);
          assert.equal(envelope.messageType, "AromaConvergenceRequested.v1");
          assert.equal(envelope.producer, "orders-aroma-preparation");
          assert.equal(envelope.correlationId, intent.correlationId);
          assert.equal(envelope.causationId, intent.messageId);
          assert.deepEqual(envelope.aggregate, {
            type: "AromaCart",
            ref: "aroma-primary",
            version: "1",
          });
          assert.deepEqual(envelope.payload, {
            cartScopeRef: "aroma-primary",
            desiredRevision: "1",
            reason: "OperatorRequested",
            orderRef,
          });
          const hash = canonicalRequestHash(envelope);
          assert.equal(values[10], hash);
          assert.equal(values[16], hash);
          assert.equal(Buffer.from(values[15]).toString("utf8"), values[8]);
          return {
            rows: [{ message_id: values[0] }],
            rowCount: 1,
            command: "INSERT",
          };
        }
        if (
          sql.includes(
            "FROM orders.convergence_work WHERE cart_scope_ref='aroma-primary'",
          )
        )
          return {
            rows: [{ desired_revision: "1", dirty: true }],
            rowCount: 1,
            command: "SELECT",
          };
        if (
          sql.includes(
            "FROM orders.cart_observed_revisions WHERE cart_scope_ref='aroma-primary'",
          )
        )
          return { rows: [], rowCount: 0, command: "SELECT" };
        if (
          sql.includes(
            "FROM orders.convergence_leases WHERE cart_scope_ref='aroma-primary'",
          )
        )
          return { rows: [], rowCount: 0, command: "SELECT" };
        if (sql.includes("FROM orders.convergence_attempts"))
          return { rows: [], rowCount: 0, command: "SELECT" };
        if (sql.includes("EXISTS(SELECT 1 FROM orders.mutation_reservations"))
          return {
            rows: [{ unresolved: false, unknown: false }],
            rowCount: 1,
            command: "SELECT",
          };
        assert.fail(`unexpected Aroma Preparation query: ${sql}`);
      });
      const store = createAromaPreparationStore(database, options);
      assert.equal(await store.runOnce(signal), "prepared");
      assert.deepEqual(effects, [
        "pending-intent",
        "validate-history-outbox-proof",
        "check-causation",
        "wake",
        "outbox",
      ]);
      assert.equal(
        statements.some((sql) =>
          sql.startsWith("INSERT INTO orders.cart_desired_revisions"),
        ),
        false,
      );
      assert.equal(
        statements.some((sql) =>
          sql.startsWith("INSERT INTO orders.cart_desired_lines"),
        ),
        false,
      );
      assert.equal(
        statements.some((sql) =>
          sql.startsWith(
            "UPDATE orders.cart_desired_revisions SET state='Superseded'",
          ),
        ),
        false,
      );

      alreadyWoken = true;
      const duplicateStart = statements.length;
      const duplicateEffectsStart = effects.length;
      assert.equal(await store.runOnce(signal), "idle");
      assert.deepEqual(effects.slice(duplicateEffectsStart), [
        "pending-intent",
        "validate-history-outbox-proof",
        "check-causation",
      ]);
      assert.equal(
        statements
          .slice(duplicateStart)
          .some((sql) => /^(?:INSERT|UPDATE|DELETE)\b/u.test(sql)),
        false,
      );
    },
  );

  await t.test(
    "recovery wakes an accepted intent without Desired once and leaves dirty work alone",
    async (t) => {
      const intent = JSON.parse(
        readFileSync(
          new URL(
            "../../../contracts/fixtures/positive/events/order-reconciliation-requested.v1.json",
            import.meta.url,
          ),
          "utf8",
        ),
      );
      intent.aggregate.version = "2";
      intent.payload.orderVersion = "2";
      intent.payload.requestedAt = intent.occurredAt;
      const effects = [];
      let wakePresent = false;
      let wakeWrites = 0;
      const { database, statements } = mockDatabase(t, (sql, values) => {
        if (
          sql === "BEGIN" ||
          sql === "COMMIT" ||
          sql === "ROLLBACK" ||
          sql.startsWith("SET LOCAL ")
        )
          return undefined;
        if (
          sql.includes(
            "pg_advisory_xact_lock(hashtext('orders:aroma-primary'))",
          )
        )
          return sqlResult([{ locked: true }]);
        if (sql.includes("FROM orders.order_desired_contributions c"))
          return sqlResult([]);
        if (sql.includes("FROM orders.order_desired_contribution_lines l"))
          return sqlResult([]);
        if (
          sql.includes(
            "FROM orders.cart_desired_revisions WHERE cart_scope_ref='aroma-primary' AND state='Current'",
          )
        )
          return sqlResult([]);
        if (
          sql.includes("FROM orders.outbox_messages b JOIN orders.orders o")
        ) {
          effects.push("pending-intent");
          assert.deepEqual(values, [options.batchSize]);
          return sqlResult([{ envelope: intent }]);
        }
        if (sql.includes("JOIN orders.order_history h USING(order_ref)")) {
          effects.push("validate-intent");
          assert.deepEqual(values.slice(0, 4), [
            orderRef,
            "2",
            intent.payload.requestedAt,
            intent.messageId,
          ]);
          assert.deepEqual(JSON.parse(values[4]), intent);
          return sqlResult([{ valid: true }]);
        }
        if (
          sql.startsWith(
            "SELECT EXISTS(SELECT 1 FROM orders.outbox_messages WHERE message_type='AromaConvergenceRequested.v1'",
          )
        ) {
          effects.push("check-causation");
          assert.deepEqual(values, [intent.messageId]);
          return sqlResult([{ present: false }]);
        }
        if (
          sql.includes(
            "FROM orders.convergence_work WHERE cart_scope_ref='aroma-primary'",
          )
        ) {
          effects.push("read-work");
          return sqlResult(
            wakePresent ? [{ desired_revision: null, dirty: true }] : [],
          );
        }
        if (sql.startsWith("INSERT INTO orders.convergence_work")) {
          effects.push("wake");
          wakeWrites++;
          assert.deepEqual(values, [null, "OperatorRequested"]);
          wakePresent = true;
          return sqlResult([], "INSERT", 1);
        }
        if (
          sql.includes("FROM orders.orders o WHERE o.status='Confirmed' AND (")
        )
          return sqlResult([]);
        if (
          sql.includes(
            "FROM orders.cart_observed_revisions WHERE cart_scope_ref='aroma-primary'",
          ) ||
          sql.includes(
            "FROM orders.convergence_leases WHERE cart_scope_ref='aroma-primary'",
          )
        )
          return sqlResult([]);
        if (sql.includes("EXISTS(SELECT 1 FROM orders.mutation_reservations"))
          return sqlResult([{ unresolved: false, unknown: false }]);
        assert.fail(`unexpected no-Desired recovery query: ${sql}`);
      });
      const store = createAromaPreparationStore(database, options);

      assert.equal(await store.runOnce(signal), "prepared");
      assert.deepEqual(effects, [
        "pending-intent",
        "validate-intent",
        "check-causation",
        "read-work",
        "wake",
      ]);
      assert.equal(wakeWrites, 1);
      assert.equal(
        statements.some((sql) =>
          sql.startsWith('INSERT INTO "orders"."outbox_messages"'),
        ),
        false,
      );
      assert.equal(
        statements.some((sql) =>
          sql.startsWith("INSERT INTO orders.cart_desired_"),
        ),
        false,
      );

      const repeatStart = statements.length;
      const effectsStart = effects.length;
      assert.equal(await store.runOnce(signal), "idle");
      assert.deepEqual(effects.slice(effectsStart), [
        "pending-intent",
        "validate-intent",
        "check-causation",
        "read-work",
      ]);
      assert.equal(wakeWrites, 1);
      assert.equal(
        statements.some((sql) =>
          sql.startsWith('INSERT INTO "orders"."outbox_messages"'),
        ),
        false,
      );
      assert.equal(
        statements
          .slice(repeatStart)
          .some((sql) => /^(?:INSERT|UPDATE|DELETE)\b/u.test(sql)),
        false,
      );
    },
  );

  await t.test(
    "recovery writes only changed impacted cards and invalidates their exact projection version",
    async (t) => {
      const secondOrderRef = "ord_01ARZ3NDEKTSV4RRFFQ69G5FAW";
      const secondContribution = {
        ...contributions[0],
        order_ref: secondOrderRef,
      };
      const secondContributionLine = {
        ...contributionLine,
        order_ref: secondOrderRef,
      };
      const activeContributions = [...contributions, secondContribution];
      const activeLines = [contributionLine, secondContributionLine];
      const desiredHash = buildDesired(
        activeContributions,
        activeLines,
        options.maxOrders,
        options.maxLines,
      ).hash;
      const effects = [];
      const writes = [];
      const histories = [];
      const realtimeEvents = [];
      const { database, statements } = mockDatabase(t, (sql, values) => {
        if (
          sql === "BEGIN" ||
          sql === "COMMIT" ||
          sql === "ROLLBACK" ||
          sql.startsWith("SET LOCAL ")
        )
          return undefined;
        if (
          sql.includes(
            "pg_advisory_xact_lock(hashtext('orders:aroma-primary'))",
          )
        )
          return sqlResult([{ locked: true }]);
        if (
          sql.includes("FROM orders.orders o WHERE o.status='Confirmed' AND (")
        )
          return sqlResult(
            [orderRef, secondOrderRef].map((ref) => ({
              order_ref: ref,
              version: "2",
              status: "Confirmed",
            })),
          );
        if (sql.includes("FROM orders.order_desired_contributions c"))
          return sqlResult(activeContributions);
        if (sql.includes("FROM orders.order_desired_contribution_lines l"))
          return sqlResult(activeLines);
        if (
          sql.includes(
            "FROM orders.cart_desired_revisions WHERE cart_scope_ref='aroma-primary' AND state='Current'",
          )
        )
          return sqlResult([
            {
              desired_revision: "1",
              desired_hash: desiredHash,
              created_at: clockRow.now,
            },
          ]);
        if (sql.includes("FROM orders.outbox_messages b JOIN orders.orders o"))
          return sqlResult([]);
        if (
          sql.includes(
            "FROM orders.convergence_work WHERE cart_scope_ref='aroma-primary'",
          )
        )
          return sqlResult([{ desired_revision: "1", dirty: true }]);
        if (
          sql.includes(
            "FROM orders.cart_observed_revisions WHERE cart_scope_ref='aroma-primary'",
          ) ||
          sql.includes(
            "FROM orders.convergence_leases WHERE cart_scope_ref='aroma-primary'",
          ) ||
          sql.includes("FROM orders.convergence_attempts")
        )
          return sqlResult([]);
        if (sql.includes("EXISTS(SELECT 1 FROM orders.mutation_reservations"))
          return sqlResult([{ unresolved: false, unknown: false }]);
        if (sql.includes("FROM orders.write_card_projection($1,$2::jsonb)")) {
          const material = JSON.parse(values[1]);
          writes.push(material.order_ref);
          effects.push(`card:${material.order_ref}`);
          assert.equal(material.state, "PendingObservation");
          assert.equal(material.desired_revision, "1");
          assert.equal(material.desired_hash, desiredHash);
          const changed = material.order_ref === orderRef;
          const version = changed ? "7" : "4";
          return sqlResult([
            {
              projection_version: version,
              material_change: changed,
              snapshot: {
                ...material,
                projection_version: version,
                updated_at: clockRow.now,
              },
            },
          ]);
        }
        if (
          sql.startsWith("INSERT INTO orders.order_aroma_projection_history")
        ) {
          effects.push(`history:${values[0]}`);
          histories.push({
            orderRef: values[0],
            version: values[1],
            snapshot: JSON.parse(values[2]),
          });
          return sqlResult([], "INSERT", 1);
        }
        if (sql.startsWith("SELECT clock_timestamp()::text AS now,"))
          return sqlResult([clockRow]);
        if (
          sql.startsWith(
            "SELECT (COALESCE(max(aggregate_sequence),0)+1)::text AS sequence",
          )
        ) {
          assert.deepEqual(values, [orderRef]);
          return sqlResult([{ sequence: "1" }]);
        }
        if (
          sql.startsWith(
            'SELECT aggregate_sequence FROM "orders"."outbox_messages"',
          )
        )
          return sqlResult([]);
        if (
          sql.startsWith(
            "SELECT payload_hash, message_type, topic, aggregate_ref",
          )
        )
          return sqlResult([]);
        if (sql.startsWith('INSERT INTO "orders"."outbox_messages"')) {
          const envelope = JSON.parse(values[8]);
          effects.push(`realtime:${values[5]}`);
          realtimeEvents.push({ values, envelope });
          return sqlResult([{ message_id: values[0] }], "INSERT");
        }
        assert.fail(`unexpected projection recovery query: ${sql}`);
      });
      const store = createAromaPreparationStore(database, options);

      assert.equal(await store.runOnce(signal), "prepared");
      assert.deepEqual(writes, [orderRef, secondOrderRef]);
      assert.equal(histories.length, 1);
      assert.deepEqual(
        { orderRef: histories[0].orderRef, version: histories[0].version },
        { orderRef, version: "7" },
      );
      assert.equal(histories[0].snapshot.projection_version, "7");
      assert.deepEqual(
        realtimeEvents.map(({ envelope }) => envelope.payload),
        [
          {
            subjectType: "order",
            subjectRef: orderRef,
            ownerVersion: "7",
            reason: "AromaStateChanged",
          },
        ],
      );
      assert.equal(realtimeEvents[0].values[1], "RealtimeInvalidated.v1");
      assert.equal(
        realtimeEvents[0].values[2],
        "coffee.realtime.invalidate.v1",
      );
      assert.equal(realtimeEvents[0].values[3], orderRef);
      assert.equal(realtimeEvents[0].values[4], 1n);
      assert.equal(realtimeEvents[0].values[5], "7");
      assert.equal(realtimeEvents[0].envelope.aggregate.ref, orderRef);
      assert.equal(realtimeEvents[0].envelope.aggregate.version, "7");
      assert.deepEqual(effects, [
        `card:${orderRef}`,
        `history:${orderRef}`,
        "realtime:7",
        `card:${secondOrderRef}`,
      ]);
      assert.equal(statements.filter((sql) => sql === "COMMIT").length, 1);
      assert.equal(statements.filter((sql) => sql === "ROLLBACK").length, 0);
    },
  );

  await t.test(
    "malformed or missing persisted contribution proof fails before desired side effects",
    async (t) => {
      const invalidLine = {
        ...contributionLine,
        items: [{ ...contributionLine.items[0], quantity: "999" }],
      };
      for (const { name, lines } of [
        { name: "mismatched persisted line", lines: [invalidLine] },
        { name: "missing persisted line", lines: [] },
      ]) {
        await t.test(name, async (caseContext) => {
          const { database, statements } = mockDatabase(caseContext, (sql) => {
            if (
              sql === "BEGIN" ||
              sql === "COMMIT" ||
              sql === "ROLLBACK" ||
              sql.startsWith("SET LOCAL ")
            )
              return undefined;
            if (
              sql.includes(
                "pg_advisory_xact_lock(hashtext('orders:aroma-primary'))",
              )
            )
              return {
                rows: [{ locked: true }],
                rowCount: 1,
                command: "SELECT",
              };
            if (sql.includes("FROM orders.order_desired_contributions c"))
              return {
                rows: contributions,
                rowCount: contributions.length,
                command: "SELECT",
              };
            if (sql.includes("FROM orders.order_desired_contribution_lines l"))
              return {
                rows: lines,
                rowCount: lines.length,
                command: "SELECT",
              };
            assert.fail(`unexpected Aroma Preparation query: ${sql}`);
          });
          const store = createAromaPreparationStore(database, options);
          await assert.rejects(store.runOnce(signal), {
            message: "AROMA_CONTRIBUTION_INVALID",
          });
          assert.equal(
            statements.some((sql) => /^(?:INSERT|UPDATE|DELETE)\b/u.test(sql)),
            false,
          );
        });
      }
    },
  );

  await t.test(
    "configured persisted-fact cardinality caps roll back before Desired or wake effects",
    async (t) => {
      const secondOrderRef = "ord_01ARZ3NDEKTSV4RRFFQ69G5FAW";
      const secondContributionLine = {
        ...contributionLine,
        offer_ref: "off_01ARZ3NDEKTSV4RRFFQ69G5FAW",
        contribution_hash: "b".repeat(64),
        item_refs: ["itm_01ARZ3NDEKTSV4RRFFQ69G5FAW"],
        items: [
          {
            ...contributionLine.items[0],
            itemRef: "itm_01ARZ3NDEKTSV4RRFFQ69G5FAW",
            productRef: "prd_01ARZ3NDEKTSV4RRFFQ69G5FAW",
            variantRef: "var_01ARZ3NDEKTSV4RRFFQ69G5FAW",
            offerRef: "off_01ARZ3NDEKTSV4RRFFQ69G5FAW",
            mappingOffer: "off_01ARZ3NDEKTSV4RRFFQ69G5FAW",
          },
        ],
      };
      const cases = [
        {
          name: "confirmed orders exceed maxOrders",
          maxLines: 2,
          maxOrders: 1,
          rows: [
            ...contributions,
            { ...contributions[0], order_ref: secondOrderRef },
          ],
          expectedContributions: 2,
          expectedLines: 0,
        },
        {
          name: "otherwise-valid contribution lines exceed maxLines",
          maxLines: 1,
          maxOrders: 1,
          rows: contributions,
          expectedContributions: 1,
          expectedLines: 2,
        },
      ];

      for (const item of cases) {
        await t.test(item.name, async (caseContext) => {
          const boundedOptions = {
            ...options,
            maxOrders: item.maxOrders,
            maxLines: item.maxLines,
          };
          assert.equal(item.rows.length, item.expectedContributions);
          const { database, statements } = mockDatabase(
            caseContext,
            (sql, values) => {
              if (
                sql === "BEGIN" ||
                sql === "COMMIT" ||
                sql === "ROLLBACK" ||
                sql.startsWith("SET LOCAL ")
              )
                return undefined;
              if (
                sql.includes(
                  "pg_advisory_xact_lock(hashtext('orders:aroma-primary'))",
                )
              )
                return sqlResult([{ locked: true }]);
              if (
                sql.startsWith(
                  "SELECT c.order_ref,c.contribution_revision::text,c.order_version::text FROM orders.order_desired_contributions c",
                )
              ) {
                assert.deepEqual(values, [boundedOptions.maxOrders + 1]);
                return sqlResult(item.rows);
              }
              if (sql.startsWith("WITH bounded AS (")) {
                assert.equal(item.expectedLines, 2);
                assert.deepEqual(values, [boundedOptions.maxLines + 1]);
                return sqlResult([contributionLine, secondContributionLine]);
              }
              assert.fail(
                `unexpected SQL after Preparation cardinality limit: ${sql}`,
              );
            },
          );
          const store = createAromaPreparationStore(database, boundedOptions);

          await assert.rejects(store.runOnce(signal), {
            code: "AROMA_PREPARATION_CARDINALITY",
          });
          assert.equal(
            statements.filter((sql) => sql.startsWith("SELECT c.order_ref"))
              .length,
            1,
          );
          assert.equal(
            statements.filter((sql) => sql.startsWith("WITH bounded AS ("))
              .length,
            item.expectedLines === 0 ? 0 : 1,
          );
          assert.equal(statements.filter((sql) => sql === "COMMIT").length, 0);
          assert.equal(
            statements.filter((sql) => sql === "ROLLBACK").length,
            1,
          );
          assert.equal(
            statements.some((sql) => /^(?:INSERT|UPDATE|DELETE)\b/u.test(sql)),
            false,
          );
          assert.equal(
            statements.some((sql) =>
              sql.includes(
                "FROM orders.cart_desired_revisions WHERE cart_scope_ref='aroma-primary' AND state='Current'",
              ),
            ),
            false,
          );
        });
      }
    },
  );
});

void test("AROMA convergence does not read the Gateway without due work and an acquired lease", async (t) => {
  let work = [];
  const calls = { read: 0, setQuantity: 0, remove: 0, catalogInput: 0 };
  const { database, statements } = mockDatabase(t, (sql) => {
    if (
      sql === "BEGIN" ||
      sql === "COMMIT" ||
      sql === "ROLLBACK" ||
      sql.startsWith("SET LOCAL ")
    )
      return undefined;
    if (sql.includes("pg_advisory_xact_lock(hashtext('orders:aroma-primary'))"))
      return { rows: [{ locked: true }], rowCount: 1, command: "SELECT" };
    if (
      sql.includes(
        "FROM orders.convergence_work w JOIN orders.cart_desired_revisions d",
      )
    )
      return { rows: work, rowCount: work.length, command: "SELECT" };
    if (sql.startsWith("SELECT operation_ref,attempt_ref,offer_ref"))
      return { rows: [], rowCount: 0, command: "SELECT" };
    if (
      sql.startsWith(
        "WITH lease_clock AS MATERIALIZED (SELECT clock_timestamp() AS now)\n    INSERT INTO orders.convergence_leases",
      )
    )
      return { rows: [], rowCount: 0, command: "INSERT" };
    assert.fail(`unexpected Aroma Convergence query: ${sql}`);
  });
  const store = createAromaConvergenceStore(database, {
    ownerInstanceId: "00000000-0000-4000-8000-000000000099",
    mutationsEnabled: true,
    leaseMs: 30_000,
    heartbeatIntervalMs: 5_000,
    providerDeadlineMs: 10_000,
    safetyMarginMs: 1_000,
    retryBackoffMs: 1_000,
    maxSnapshotAgeMs: 60_000,
    maxLines: 100,
  });
  const gateway = Object.fromEntries(
    Object.keys(calls).map((name) => [
      name,
      async () => (calls[name]++, undefined),
    ]),
  );
  const signal = new AbortController().signal;

  await t.test(
    "no due work exits before reservation and Gateway calls",
    async () => {
      assert.equal(await store.runOnce(gateway, signal), "idle");
      assert.deepEqual(calls, {
        read: 0,
        setQuantity: 0,
        remove: 0,
        catalogInput: 0,
      });
      assert.equal(
        statements.some((sql) =>
          sql.includes("INSERT INTO orders.convergence_leases"),
        ),
        false,
      );
    },
  );

  await t.test(
    "due work without an acquired lease exits before Attempt or Gateway calls",
    async () => {
      work = [
        {
          desired_revision: "1",
          desired_hash: "a".repeat(64),
          wake_revision: "1",
        },
      ];
      assert.equal(await store.runOnce(gateway, signal), "idle");
      assert.deepEqual(calls, {
        read: 0,
        setQuantity: 0,
        remove: 0,
        catalogInput: 0,
      });
      assert.equal(
        statements.filter((sql) =>
          sql.includes("INSERT INTO orders.convergence_leases"),
        ).length,
        1,
      );
      assert.equal(
        statements.some((sql) =>
          sql.includes("INSERT INTO orders.convergence_attempts"),
        ),
        false,
      );
      assert.equal(
        statements.some((sql) =>
          sql.includes('INSERT INTO "orders"."outbox_messages"'),
        ),
        false,
      );
    },
  );
});

void test("AROMA convergence handleWake only wakes the delivered current revision", async (t) => {
  const envelope = JSON.parse(
    readFileSync(
      new URL(
        "../../../contracts/fixtures/positive/events/aroma-convergence-requested.v1.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const ownerQueries = [];
  const { database } = mockDatabase(t, (sql, values) => {
    if (
      sql === "BEGIN" ||
      sql === "COMMIT" ||
      sql === "ROLLBACK" ||
      sql.startsWith("SET LOCAL ")
    )
      return undefined;
    if (
      sql.includes("pg_advisory_xact_lock(hashtext('orders:aroma-primary'))")
    ) {
      ownerQueries.push("scope-lock");
      return { rows: [{ locked: true }], rowCount: 1, command: "SELECT" };
    }
    if (
      sql.startsWith(
        "UPDATE orders.convergence_work SET next_attempt_at=LEAST(",
      )
    ) {
      ownerQueries.push("wake-current-revision");
      assert.deepEqual(values, [envelope.payload.desiredRevision]);
      assert.match(
        sql,
        /WHERE cart_scope_ref='aroma-primary' AND dirty AND desired_revision=\$1/u,
      );
      return { rows: [], rowCount: 0, command: "UPDATE" };
    }
    assert.fail(`unexpected Aroma Convergence wake query: ${sql}`);
  });
  const store = createAromaConvergenceStore(database, {
    ownerInstanceId: "00000000-0000-4000-8000-000000000099",
    mutationsEnabled: true,
    leaseMs: 30_000,
    heartbeatIntervalMs: 5_000,
    providerDeadlineMs: 10_000,
    safetyMarginMs: 1_000,
    retryBackoffMs: 1_000,
    maxSnapshotAgeMs: 60_000,
    maxLines: 100,
  });

  await withTransaction(database, { mode: "background" }, (tx) =>
    store.handleWake(tx, envelope, new AbortController().signal),
  );

  assert.deepEqual(ownerQueries, ["scope-lock", "wake-current-revision"]);
});

void test("AROMA convergence recovery records an interrupted reservation as UnknownOutcome", async (t) => {
  const provenance = JSON.parse(
    readFileSync(
      new URL(
        "../../../contracts/fixtures/positive/events/aroma-convergence-requested.v1.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const clockRow = {
    now: "2026-10-25T08:00:00.000Z",
    ms: String(Date.parse("2026-10-25T08:00:00.000Z")),
  };
  const steps = [];
  let clockReads = 0;
  const { database } = mockDatabase(t, (sql, values) => {
    if (
      sql === "BEGIN" ||
      sql === "COMMIT" ||
      sql === "ROLLBACK" ||
      sql.startsWith("SET LOCAL ")
    )
      return undefined;
    if (sql.includes("pg_advisory_xact_lock(hashtext('orders:aroma-primary'))"))
      return { rows: [{ locked: true }], rowCount: 1, command: "SELECT" };
    if (sql.startsWith("UPDATE orders.convergence_attempts a")) {
      steps.push("abandon-attempt");
      return {
        rows: [
          {
            attempt_ref: "att_01ARZ3NDEKTSV4RRFFQ69G5FAV",
            desired_revision: "3",
            observed_start_revision: "2",
            state: "UnknownOutcome",
          },
        ],
        rowCount: 1,
        command: "UPDATE",
      };
    }
    if (
      sql.startsWith(
        "UPDATE orders.mutation_reservations r SET state='UnknownOutcome'",
      )
    ) {
      steps.push("abandon-reservation");
      return { rows: [], rowCount: 1, command: "UPDATE" };
    }
    if (sql.startsWith("SELECT to_char(clock_timestamp()")) {
      steps.push(clockReads++ === 0 ? "recovery-clock" : "event-clock");
      return { rows: [clockRow], rowCount: 1, command: "SELECT" };
    }
    if (sql.startsWith("SELECT envelope FROM orders.inbox_messages")) {
      steps.push("provenance");
      assert.deepEqual(values, ["3"]);
      return {
        rows: [{ envelope: provenance }],
        rowCount: 1,
        command: "SELECT",
      };
    }
    if (
      sql.startsWith(
        "SELECT (COALESCE(max(aggregate_sequence),0)+1)::text AS sequence",
      )
    ) {
      steps.push("aggregate-sequence");
      return { rows: [{ sequence: "1" }], rowCount: 1, command: "SELECT" };
    }
    if (
      sql.startsWith("SELECT payload_hash, message_type, topic, aggregate_ref")
    ) {
      steps.push("outbox-id-check");
      return { rows: [], rowCount: 0, command: "SELECT" };
    }
    if (
      sql.startsWith(
        'SELECT aggregate_sequence FROM "orders"."outbox_messages"',
      )
    ) {
      steps.push("outbox-sequence-check");
      return { rows: [], rowCount: 0, command: "SELECT" };
    }
    if (sql.startsWith('INSERT INTO "orders"."outbox_messages"')) {
      steps.push("outbox-event");
      assert.equal(values[1], "AromaConvergenceChanged.v1");
      assert.equal(values[2], "coffee.aroma.cart.events.v1");
      assert.equal(values[3], "aroma-primary");
      assert.equal(values[4], 1n);
      assert.equal(values[5], "1");
      assert.equal(values[12], provenance.correlationId);
      assert.equal(values[13], provenance.messageId);
      const envelope = JSON.parse(values[8]);
      assert.equal(envelope.messageType, "AromaConvergenceChanged.v1");
      assert.equal(envelope.producer, "aroma-convergence");
      assert.equal(envelope.correlationId, provenance.correlationId);
      assert.equal(envelope.causationId, provenance.messageId);
      assert.deepEqual(envelope.aggregate, {
        type: "AromaCart",
        ref: "aroma-primary",
        version: "1",
      });
      assert.deepEqual(envelope.payload, {
        cartScopeRef: "aroma-primary",
        desiredRevision: "3",
        observedRevision: "2",
        attemptRef: "att_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        attemptState: "UnknownOutcome",
        changedAt: clockRow.now,
        blockerCodes: ["AROMA_WORKER_INTERRUPTED"],
      });
      const hash = canonicalRequestHash(envelope);
      assert.equal(values[10], hash);
      assert.equal(values[16], hash);
      assert.equal(Buffer.from(values[15]).toString("utf8"), values[8]);
      return {
        rows: [{ message_id: values[0] }],
        rowCount: 1,
        command: "INSERT",
      };
    }
    assert.fail(`unexpected Aroma Convergence recovery query: ${sql}`);
  });
  const store = createAromaConvergenceStore(database, {
    ownerInstanceId: "00000000-0000-4000-8000-000000000099",
    mutationsEnabled: true,
    leaseMs: 30_000,
    heartbeatIntervalMs: 5_000,
    providerDeadlineMs: 10_000,
    safetyMarginMs: 1_000,
    retryBackoffMs: 1_000,
    maxSnapshotAgeMs: 60_000,
    maxLines: 100,
  });
  await store.recover(new AbortController().signal);
  assert.deepEqual(steps, [
    "abandon-attempt",
    "abandon-reservation",
    "recovery-clock",
    "provenance",
    "event-clock",
    "aggregate-sequence",
    "outbox-id-check",
    "outbox-sequence-check",
    "outbox-event",
  ]);
});

void test("AROMA convergence blocks disabled mutations and verifies one enabled positive SetQuantity", async (t) => {
  const { GatewayClientError } =
    await import("../../../apps/aroma-convergence/dist/infrastructure/gateway-client.js");
  const { AromaConvergenceTelemetry } =
    await import("../../../apps/aroma-convergence/dist/telemetry/index.js");
  const telemetry = new AromaConvergenceTelemetry();
  const unknownCountSql =
    "SELECT count(*)::text AS count FROM orders.mutation_reservations WHERE cart_scope_ref='aroma-primary' AND state='UnknownOutcome' AND resolved_at IS NULL";
  const provenance = JSON.parse(
    readFileSync(
      new URL(
        "../../../contracts/fixtures/positive/events/aroma-convergence-requested.v1.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  provenance.aggregate.version = "1";
  provenance.payload.desiredRevision = "1";
  const ownerInstanceId = "00000000-0000-4000-8000-000000000099";
  const offerRef = "off_00000000000000000000000001";
  const capturedAt = "2026-10-25T08:00:00.000Z";
  const clockRow = {
    now: capturedAt,
    ms: String(Date.parse(capturedAt)),
  };
  const snapshot = {
    cartScopeRef: "aroma-primary",
    providerSnapshotRef: `aroma-gateway:cart-body-sha256:${"b".repeat(64)}`,
    capturedAt,
    cartFingerprint: createHash("sha256").update("[]").digest("hex"),
    lines: [],
  };
  const verificationLines = [{ offerRef, quantity: "1" }];
  const verificationSnapshot = {
    ...snapshot,
    providerSnapshotRef: `aroma-gateway:cart-body-sha256:${"c".repeat(64)}`,
    cartFingerprint: createHash("sha256")
      .update(JSON.stringify(verificationLines))
      .digest("hex"),
    lines: verificationLines,
  };
  const cleanupBaselineLines = [{ offerRef, quantity: "1" }];
  const cleanupBaselineSnapshot = {
    ...snapshot,
    providerSnapshotRef: `aroma-gateway:cart-body-sha256:${"e".repeat(64)}`,
    cartFingerprint: createHash("sha256")
      .update(JSON.stringify(cleanupBaselineLines))
      .digest("hex"),
    lines: cleanupBaselineLines,
  };
  const cleanupVerifiedSnapshot = {
    ...snapshot,
    providerSnapshotRef: `aroma-gateway:cart-body-sha256:${"f".repeat(64)}`,
  };
  const appliedRecoverySnapshot = {
    ...snapshot,
    providerSnapshotRef: `aroma-gateway:cart-body-sha256:${"d".repeat(64)}`,
    cartFingerprint: createHash("sha256")
      .update(JSON.stringify(verificationLines))
      .digest("hex"),
    lines: verificationLines,
  };
  assert.deepEqual(normalizeAromaCartSnapshot(snapshot).lines, []);
  assert.equal(
    normalizeAromaCartSnapshot(verificationSnapshot).lines[0].quantityMilli,
    "1000",
  );
  const gatewayCalls = { read: 0, setQuantity: 0, remove: 0, catalogInput: 0 };
  const steps = [];
  let enabledScenario = false;
  let cleanupScenario = false;
  let cleanupAlreadyClean = false;
  let verificationUnavailable = false;
  let initialReadFailure = false;
  let initialSnapshotInvalid = false;
  let verificationSnapshotInvalid = false;
  let catalogProofMode = "valid";
  let mappingChangesAfterProof = false;
  let catalogSourceReads = 0;
  let mutationOutcome = "success";
  let recoveredAppliedScenario = false;
  let unresolvedReads = 0;
  let recoveredBarrierReads = 0;
  let dispatchCommitted = false;
  let acknowledgementCommitted = false;
  let mutationRequest;
  let operationRef;
  let mutationAck;
  const messages = [];
  const guardParameters = [];
  const reservationOutcomes = [];
  const observedReadRevisions = [];
  const observedWriteRevisions = [];
  let outboxSequence = 0;
  let attemptRef;
  let clockReads = 0;
  let copiedBytes = 0;
  let copyPayloads = [];
  let heartbeatLossArmed = false;
  let heartbeatSqlFailureScenario = false;
  let terminalReleaseMiss = false;
  let heartbeatFenceLost = false;
  let lostFenceChecks = 0;
  let mutationRpcStarted;
  let mutationRpcAborted;
  let pendingMutationRpc;
  let heartbeatObserved;
  let heartbeatSqlFailureArmed = false;
  const heartbeatSqlFailure = new Error("simulated heartbeat renewal failure");
  heartbeatSqlFailure.code = "ECONNRESET";
  const { database, statements, connection } = mockDatabase(
    t,
    (sql, values) => {
      if (
        sql === "BEGIN" ||
        sql === "COMMIT" ||
        sql === "ROLLBACK" ||
        sql.startsWith("SET LOCAL ")
      ) {
        if (
          (enabledScenario || cleanupScenario) &&
          sql === "COMMIT" &&
          !dispatchCommitted &&
          steps.includes("dispatch-reservation") &&
          steps.includes("dispatch-attempt")
        ) {
          steps.push("dispatch-commit");
          dispatchCommitted = true;
        }
        if (
          (enabledScenario || cleanupScenario) &&
          sql === "COMMIT" &&
          steps.includes("acknowledged") &&
          !acknowledgementCommitted
        ) {
          steps.push("ack-commit");
          acknowledgementCommitted = true;
        }
        return undefined;
      }
      if (sql.includes("SET heartbeat_at=lease_clock.now")) {
        if (heartbeatSqlFailureArmed) {
          heartbeatSqlFailureArmed = false;
          heartbeatLossArmed = false;
          steps.push("heartbeat-sql-error");
          heartbeatObserved.resolve();
          throw heartbeatSqlFailure;
        }
        assert.equal(heartbeatLossArmed, true);
        heartbeatLossArmed = false;
        heartbeatFenceLost = true;
        heartbeatObserved.resolve();
        return { rows: [], rowCount: 0, command: "UPDATE" };
      }
      if (sql === unknownCountSql)
        return {
          rows: [
            {
              count:
                reservationOutcomes.at(-1)?.[1] === "UnknownOutcome"
                  ? "1"
                  : "0",
            },
          ],
          rowCount: 1,
          command: "SELECT",
        };
      if (
        sql.includes("pg_advisory_xact_lock(hashtext('orders:aroma-primary'))")
      )
        return { rows: [{ locked: true }], rowCount: 1, command: "SELECT" };
      if (
        sql.includes(
          "FROM orders.convergence_work w JOIN orders.cart_desired_revisions d",
        )
      ) {
        steps.push("work");
        return {
          rows: [
            {
              desired_revision: "1",
              desired_hash: "a".repeat(64),
              wake_revision: "1",
            },
          ],
          rowCount: 1,
          command: "SELECT",
        };
      }
      if (sql.startsWith("SELECT operation_ref,attempt_ref,offer_ref")) {
        steps.push("unresolved-reservations");
        unresolvedReads++;
        if (recoveredAppliedScenario) {
          recoveredBarrierReads++;
          return {
            rows: [
              {
                operation_ref: "op_01ARZ3NDEKTSV4RRFFQ69G5FAV",
                attempt_ref: "att_01ARZ3NDEKTSV4RRFFQ69G5FAV",
                offer_ref: offerRef,
                source_grind_key_hash: null,
                desired_milli: "1000",
                observed_before_milli: "0",
                observed_before_revision: "1",
                action: "SetQuantity",
                state: "Dispatched",
                window_ended: true,
                remaining_ms: "0",
              },
            ],
            rowCount: 1,
            command: "SELECT",
          };
        }
        return { rows: [], rowCount: 0, command: "SELECT" };
      }
      if (
        sql.startsWith(
          "WITH lease_clock AS MATERIALIZED (SELECT clock_timestamp() AS now)\n    INSERT INTO orders.convergence_leases",
        )
      )
        return { rows: [{ fence_epoch: "1" }], rowCount: 1, command: "INSERT" };
      if (sql.startsWith("UPDATE orders.convergence_attempts a"))
        return { rows: [], rowCount: 0, command: "UPDATE" };
      if (
        sql.startsWith(
          "UPDATE orders.mutation_reservations r SET state='UnknownOutcome'",
        )
      ) {
        steps.push("reservation-recovery-sweep");
        return { rows: [], rowCount: 0, command: "UPDATE" };
      }
      if (sql.startsWith("SELECT to_char(clock_timestamp()")) {
        steps.push(
          (cleanupScenario
            ? cleanupAlreadyClean
              ? [
                  "attempt-clock",
                  "baseline-observation-clock",
                  "terminal-clock",
                  "terminal-event-clock",
                ]
              : [
                  "attempt-clock",
                  "baseline-observation-clock",
                  "operation-clock",
                  "verification-observation-clock",
                  "terminal-clock",
                  "terminal-event-clock",
                ]
            : enabledScenario
              ? initialReadFailure || initialSnapshotInvalid
                ? ["attempt-clock", "terminal-clock", "terminal-event-clock"]
                : heartbeatSqlFailureScenario ||
                    verificationUnavailable ||
                    verificationSnapshotInvalid
                  ? [
                      "attempt-clock",
                      "baseline-observation-clock",
                      "operation-clock",
                      "terminal-clock",
                      "terminal-event-clock",
                    ]
                  : catalogProofMode !== "valid"
                    ? [
                        "attempt-clock",
                        "baseline-observation-clock",
                        "terminal-clock",
                        "terminal-event-clock",
                      ]
                    : mappingChangesAfterProof
                      ? ["attempt-clock", "baseline-observation-clock"]
                      : mutationOutcome !== "success"
                        ? [
                            "attempt-clock",
                            "baseline-observation-clock",
                            "operation-clock",
                            "terminal-clock",
                            "terminal-event-clock",
                          ]
                        : [
                            "attempt-clock",
                            "baseline-observation-clock",
                            "operation-clock",
                            "verification-observation-clock",
                            "terminal-clock",
                            "terminal-event-clock",
                          ]
              : [
                  "attempt-clock",
                  "observation-event-clock",
                  "terminal-clock",
                  "terminal-event-clock",
                ])[clockReads++] ?? "unexpected-clock",
        );
        return { rows: [clockRow], rowCount: 1, command: "SELECT" };
      }
      if (sql.startsWith("INSERT INTO orders.convergence_attempts")) {
        steps.push("start-attempt");
        attemptRef = values[0];
        assert.deepEqual(values.slice(1), [
          "1",
          "a".repeat(64),
          ownerInstanceId,
          "1",
        ]);
        return { rows: [], rowCount: 1, command: "INSERT" };
      }
      if (sql.startsWith("SELECT envelope FROM orders.inbox_messages")) {
        assert.deepEqual(values, ["1"]);
        return {
          rows: [{ envelope: provenance }],
          rowCount: 1,
          command: "SELECT",
        };
      }
      if (
        sql.startsWith(
          "SELECT EXISTS(SELECT 1 FROM orders.convergence_leases l",
        )
      ) {
        guardParameters.push(values);
        if (heartbeatFenceLost) lostFenceChecks++;
        return {
          rows: [{ valid: !heartbeatFenceLost }],
          rowCount: 1,
          command: "SELECT",
        };
      }
      if (sql.startsWith("SELECT ($1::timestamptz<=clock_timestamp()")) {
        assert.deepEqual(values, [capturedAt, 60_000]);
        return { rows: [{ valid: true }], rowCount: 1, command: "SELECT" };
      }
      if (sql.startsWith("SELECT (COALESCE(max(observed_revision),0)+1)")) {
        const revision =
          enabledScenario || cleanupScenario
            ? String(
                steps.filter((step) => step === "snapshot-lines").length + 1,
              )
            : recoveredAppliedScenario
              ? "2"
              : "1";
        return { rows: [{ revision }], rowCount: 1, command: "SELECT" };
      }
      if (
        sql.startsWith(
          "UPDATE orders.cart_observed_revisions SET state='Superseded'",
        )
      )
        return { rows: [], rowCount: 0, command: "UPDATE" };
      if (
        sql.startsWith(
          "SELECT observed_revision::text AS revision\n    FROM orders.cart_observed_revisions WHERE cart_scope_ref='aroma-primary' AND state='Current'",
        )
      )
        return { rows: [], rowCount: 0, command: "SELECT" };
      if (sql.startsWith("INSERT INTO orders.cart_observed_revisions")) {
        const revision = recoveredAppliedScenario
          ? "2"
          : enabledScenario || cleanupScenario
            ? String(
                steps.filter((step) => step === "snapshot-lines").length + 1,
              )
            : "1";
        const observedSnapshot = recoveredAppliedScenario
          ? appliedRecoverySnapshot
          : cleanupScenario
            ? revision === "1" && !cleanupAlreadyClean
              ? cleanupBaselineSnapshot
              : cleanupVerifiedSnapshot
            : enabledScenario && revision === "2"
              ? verificationSnapshot
              : snapshot;
        assert.deepEqual(values, [
          revision,
          observedSnapshot.providerSnapshotRef,
          observedSnapshot.cartFingerprint,
          capturedAt,
          attemptRef,
          "1",
        ]);
        if (recoveredAppliedScenario) observedWriteRevisions.push(values[0]);
        return { rows: [], rowCount: 1, command: "INSERT" };
      }
      if (sql.startsWith('COPY "orders"."cart_observed_lines"')) {
        steps.push("snapshot-lines");
        return { rows: [], rowCount: 0, command: "COPY" };
      }
      if (
        sql.startsWith(
          "UPDATE orders.convergence_attempts SET state='Observed'",
        )
      )
        return { rows: [], rowCount: 1, command: "UPDATE" };
      if (
        sql.startsWith(
          "UPDATE orders.convergence_attempts SET state='MutationReserved'",
        )
      ) {
        steps.push("select-action");
        assert.deepEqual(values, [
          attemptRef,
          cleanupScenario ? "Remove" : "SetQuantity",
          offerRef,
          null,
        ]);
        return { rows: [], rowCount: 1, command: "UPDATE" };
      }
      if (
        sql.startsWith("SELECT DISTINCT code FROM orders.cart_desired_blockers")
      )
        return {
          rows: cleanupScenario ? [{ code: "PRODUCT_UNAVAILABLE" }] : [],
          rowCount: cleanupScenario ? 1 : 0,
          command: "SELECT",
        };
      if (sql.startsWith("SELECT NOT EXISTS ("))
        return {
          rows: [{ valid: recoveredAppliedScenario }],
          rowCount: 1,
          command: "SELECT",
        };
      if (
        sql.startsWith("SELECT offer_ref,source_grind_key_hash,quantity_milli")
      ) {
        assert.deepEqual(values, ["1"]);
        if (
          recoveredAppliedScenario &&
          sql.includes("FROM orders.cart_observed_lines")
        ) {
          observedReadRevisions.push(values[0]);
          return { rows: [], rowCount: 0, command: "SELECT" };
        }
        if (cleanupScenario && sql.includes("FROM orders.cart_desired_lines"))
          return { rows: [], rowCount: 0, command: "SELECT" };
        if (cleanupScenario && sql.includes("FROM orders.cart_observed_lines"))
          return {
            rows: cleanupAlreadyClean
              ? []
              : [
                  {
                    offer_ref: offerRef,
                    source_grind_key_hash: null,
                    quantity_milli: "1000",
                  },
                ],
            rowCount: cleanupAlreadyClean ? 0 : 1,
            command: "SELECT",
          };
        return {
          rows: [
            {
              offer_ref: offerRef,
              source_grind_key_hash: null,
              quantity_milli: "1000",
            },
          ],
          rowCount: 1,
          command: "SELECT",
        };
      }
      if (
        sql.startsWith("SELECT count(*)=1 AND bool_and(mapping_state='Active'")
      )
        return { rows: [{ safe: true }], rowCount: 1, command: "SELECT" };
      if (
        sql.startsWith(
          "SELECT product_ref,variant_ref,catalog_snapshot_revision::text,mapping_revision::text",
        )
      ) {
        catalogSourceReads++;
        return {
          rows: [
            {
              product_ref: "prd_01ARZ3NDEKTSV4RRFFQ69G5FAV",
              variant_ref: "var_01ARZ3NDEKTSV4RRFFQ69G5FAV",
              catalog_snapshot_revision: "1",
              mapping_revision:
                mappingChangesAfterProof && catalogSourceReads > 1 ? "2" : "1",
            },
          ],
          rowCount: 1,
          command: "SELECT",
        };
      }
      if (sql.startsWith("INSERT INTO orders.mutation_reservations")) {
        steps.push("reserve");
        operationRef = values[0];
        const reservedRequest = {
          operationRef,
          cartScopeRef: "aroma-primary",
          ...(cleanupScenario ? {} : { quantity: "1" }),
        };
        assert.equal(values[1], attemptRef);
        assert.deepEqual(
          values.slice(2, 11),
          cleanupScenario
            ? ["1", "1", "1", "Remove", offerRef, null, "1000", "0", null]
            : ["1", "1", "1", "SetQuantity", offerRef, null, "0", "1000", "1"],
        );
        assert.equal(
          values[11],
          canonicalRequestHash({
            offerRef,
            action: cleanupScenario ? "Remove" : "SetQuantity",
            request: reservedRequest,
          }),
        );
        assert.deepEqual(values.slice(12), [10_000, 1_000]);
        return { rows: [], rowCount: 1, command: "INSERT" };
      }
      if (
        sql.startsWith(
          "UPDATE orders.convergence_leases SET expires_at=GREATEST",
        )
      ) {
        steps.push("extend-lease");
        assert.deepEqual(values, [ownerInstanceId, "1", operationRef]);
        return { rows: [], rowCount: 1, command: "UPDATE" };
      }
      if (
        sql.startsWith(
          "UPDATE orders.mutation_reservations SET state='Dispatched'",
        )
      ) {
        steps.push("dispatch-reservation");
        assert.deepEqual(values, [operationRef]);
        return {
          rows: [{ remaining_ms: "9000" }],
          rowCount: 1,
          command: "UPDATE",
        };
      }
      if (
        sql.startsWith(
          "UPDATE orders.convergence_attempts SET state='MutationDispatched'",
        )
      ) {
        steps.push("dispatch-attempt");
        assert.deepEqual(values, [attemptRef]);
        return { rows: [], rowCount: 1, command: "UPDATE" };
      }
      if (sql.startsWith("UPDATE orders.mutation_reservations SET state=$2")) {
        assert.equal(
          values[0],
          recoveredAppliedScenario
            ? "op_01ARZ3NDEKTSV4RRFFQ69G5FAV"
            : operationRef,
        );
        reservationOutcomes.push([...values]);
        if (values[1] === "Acknowledged") {
          steps.push("acknowledged");
          assert.equal(values[2], canonicalRequestHash(mutationAck));
        } else if (values[1] === "UnknownOutcome") {
          steps.push("unknown-outcome");
          assert.equal(
            values[2],
            acknowledgementCommitted ? canonicalRequestHash(mutationAck) : null,
          );
        } else if (values[1] === "Rejected") {
          steps.push("rejected-reservation");
          assert.equal(
            values[2],
            canonicalRequestHash({
              status: 404,
              problemCode: "AROMA_CART_ITEM_NOT_FOUND",
            }),
          );
        } else if (values[1] === "RecoveredApplied") {
          steps.push("recovered-applied");
          assert.deepEqual(values, [values[0], "RecoveredApplied", null]);
        } else {
          steps.push("verified-reservation");
          assert.equal(values[1], "Verified");
          assert.equal(values[2], canonicalRequestHash(mutationAck));
        }
        return { rows: [], rowCount: 1, command: "UPDATE" };
      }
      if (sql.startsWith("UPDATE orders.convergence_attempts SET state=$2")) {
        steps.push("terminal-attempt");
        assert.equal(values[0], attemptRef);
        const unknownOutcome =
          heartbeatSqlFailureScenario ||
          verificationUnavailable ||
          verificationSnapshotInvalid ||
          mutationOutcome === "ambiguous" ||
          mutationOutcome === "invalid-ack";
        const observationFailed = initialReadFailure || initialSnapshotInvalid;
        const rejected = mutationOutcome === "not-found";
        const mappingBlocked = catalogProofMode !== "valid";
        const blockers = recoveredAppliedScenario
          ? []
          : cleanupScenario
            ? ["PRODUCT_UNAVAILABLE"]
            : observationFailed
              ? [
                  initialReadFailure
                    ? "AROMA_OBSERVATION_UNAVAILABLE"
                    : "AROMA_OBSERVATION_INVALID",
                ]
              : unknownOutcome
                ? [
                    verificationUnavailable || verificationSnapshotInvalid
                      ? verificationUnavailable
                        ? "AROMA_VERIFICATION_UNAVAILABLE"
                        : "AROMA_VERIFICATION_INVALID"
                      : "AROMA_OPERATION_UNKNOWN_OUTCOME",
                  ]
                : rejected
                  ? ["AROMA_CART_ITEM_NOT_FOUND"]
                  : mappingBlocked
                    ? ["AROMA_MAPPING_NOT_AVAILABLE"]
                    : enabledScenario
                      ? []
                      : ["AROMA_MUTATIONS_DISABLED"];
        assert.equal(
          values[1],
          recoveredAppliedScenario
            ? "NoOpInSync"
            : cleanupScenario
              ? "Blocked"
              : observationFailed
                ? "Failed"
                : unknownOutcome
                  ? "UnknownOutcome"
                  : rejected || mappingBlocked
                    ? "Blocked"
                    : enabledScenario
                      ? "VerifiedInSync"
                      : "Blocked",
        );
        assert.equal(values[3], blockers[0] ?? null);
        assert.deepEqual(JSON.parse(values[4]), blockers);
        return { rows: [], rowCount: 1, command: "UPDATE" };
      }
      if (sql.startsWith("UPDATE orders.convergence_work SET dirty=$3")) {
        steps.push("consume-work");
        assert.deepEqual(values.slice(0, 3), [
          "1",
          "1",
          initialReadFailure ||
            initialSnapshotInvalid ||
            heartbeatSqlFailureScenario ||
            verificationUnavailable ||
            verificationSnapshotInvalid ||
            mutationOutcome === "ambiguous" ||
            mutationOutcome === "invalid-ack",
        ]);
        assert.equal(values[3], 1_000);
        return { rows: [], rowCount: 1, command: "UPDATE" };
      }
      if (
        sql.startsWith(
          "UPDATE orders.convergence_leases SET expires_at=clock_timestamp()",
        )
      ) {
        steps.push("release-lease");
        assert.deepEqual(values, [ownerInstanceId, "1"]);
        if (terminalReleaseMiss) {
          terminalReleaseMiss = false;
          steps.push("release-lease-miss");
          return { rows: [], rowCount: 0, command: "UPDATE" };
        }
        return { rows: [], rowCount: 1, command: "UPDATE" };
      }
      if (
        sql.startsWith(
          "SELECT (COALESCE(max(aggregate_sequence),0)+1)::text AS sequence",
        )
      )
        return {
          rows: [{ sequence: String(outboxSequence + 1) }],
          rowCount: 1,
          command: "SELECT",
        };
      if (
        sql.startsWith(
          "SELECT payload_hash, message_type, topic, aggregate_ref",
        )
      )
        return { rows: [], rowCount: 0, command: "SELECT" };
      if (
        sql.startsWith(
          'SELECT aggregate_sequence FROM "orders"."outbox_messages"',
        )
      )
        return outboxSequence === 0
          ? { rows: [], rowCount: 0, command: "SELECT" }
          : {
              rows: [{ aggregate_sequence: String(outboxSequence) }],
              rowCount: 1,
              command: "SELECT",
            };
      if (sql.startsWith('INSERT INTO "orders"."outbox_messages"')) {
        const envelope = JSON.parse(values[8]);
        steps.push(
          envelope.messageType === "AromaObservationChanged.v1"
            ? "observation-outbox"
            : "terminal-outbox",
        );
        const hash = canonicalRequestHash(envelope);
        assert.equal(values[4], BigInt(outboxSequence + 1));
        assert.equal(values[10], hash);
        assert.equal(values[16], hash);
        assert.equal(Buffer.from(values[15]).toString("utf8"), values[8]);
        assert.equal(values[12], provenance.correlationId);
        assert.equal(values[13], provenance.messageId);
        messages.push(envelope);
        outboxSequence++;
        return {
          rows: [{ message_id: values[0] }],
          rowCount: 1,
          command: "INSERT",
        };
      }
      assert.fail(`unexpected Aroma Convergence runOnce query: ${sql}`);
    },
  );
  const query = connection.query;
  connection.query = (request) => {
    const result = query(request);
    if (
      typeof request !== "string" &&
      request.text?.startsWith('COPY "orders"."cart_observed_lines"')
    ) {
      const chunks = [];
      return new Writable({
        write(chunk, _encoding, callback) {
          copiedBytes += chunk.length;
          chunks.push(Buffer.from(chunk));
          callback();
        },
        final(callback) {
          copyPayloads.push(Buffer.concat(chunks));
          callback();
        },
      });
    }
    return result;
  };
  const store = createAromaConvergenceStore(
    database,
    {
      ownerInstanceId,
      mutationsEnabled: false,
      leaseMs: 30_000,
      heartbeatIntervalMs: 5_000,
      providerDeadlineMs: 10_000,
      safetyMarginMs: 1_000,
      retryBackoffMs: 1_000,
      maxSnapshotAgeMs: 60_000,
      maxLines: 100,
    },
    telemetry,
  );
  const gateway = {
    read: async () => {
      gatewayCalls.read++;
      if (recoveredAppliedScenario) return appliedRecoverySnapshot;
      if (cleanupScenario) {
        if (gatewayCalls.read === 1 && !cleanupAlreadyClean)
          return cleanupBaselineSnapshot;
        if (gatewayCalls.read === 2) {
          assert.equal(acknowledgementCommitted, true);
          steps.push("verification-read");
        }
        return cleanupVerifiedSnapshot;
      }
      if (enabledScenario && gatewayCalls.read === 2) {
        assert.equal(acknowledgementCommitted, true);
        steps.push(
          verificationUnavailable
            ? "verification-read-failed"
            : verificationSnapshotInvalid
              ? "verification-read-invalid"
              : "verification-read",
        );
        if (verificationUnavailable)
          throw new Error("simulated verification GET failure");
        if (verificationSnapshotInvalid)
          return {
            ...verificationSnapshot,
            cartFingerprint: "0".repeat(64),
          };
        return verificationSnapshot;
      }
      if (enabledScenario) {
        steps.push("initial-read");
        if (initialReadFailure)
          throw new Error("simulated initial observation GET failure");
        if (initialSnapshotInvalid)
          return { ...snapshot, cartFingerprint: "0".repeat(64) };
      }
      return snapshot;
    },
    setQuantity: async (actualOfferRef, request, context) => {
      gatewayCalls.setQuantity++;
      assert.equal(dispatchCommitted, true);
      mutationRequest = request;
      steps.push("set-quantity");
      assert.equal(actualOfferRef, offerRef);
      if (mutationOutcome === "not-found")
        throw new GatewayClientError(
          "Rejected",
          404,
          "AROMA_CART_ITEM_NOT_FOUND",
        );
      if (mutationOutcome === "ambiguous")
        throw new GatewayClientError("TransportUnavailable");
      assert.deepEqual(request, {
        operationRef: request.operationRef,
        cartScopeRef: "aroma-primary",
        quantity: "1",
      });
      if (heartbeatLossArmed) {
        context.signal.addEventListener(
          "abort",
          () => mutationRpcAborted.resolve(),
          { once: true },
        );
        pendingMutationRpc = Promise.withResolvers();
        mutationRpcStarted.resolve();
        return pendingMutationRpc.promise;
      }
      mutationAck = {
        operationRef: request.operationRef,
        cartScopeRef: "aroma-primary",
        offerRef,
        state: "Acknowledged",
      };
      return mutationOutcome === "invalid-ack"
        ? { ...mutationAck, operationRef: "op_00000000000000000000000099" }
        : mutationAck;
    },
    remove: async (actualOfferRef, request) => {
      gatewayCalls.remove++;
      assert.equal(dispatchCommitted, true);
      assert.equal(actualOfferRef, offerRef);
      assert.deepEqual(request, {
        operationRef: request.operationRef,
        cartScopeRef: "aroma-primary",
      });
      mutationRequest = request;
      steps.push("remove");
      mutationAck = {
        operationRef: request.operationRef,
        cartScopeRef: "aroma-primary",
        offerRef,
        state: "Acknowledged",
      };
      return mutationAck;
    },
    catalogInput: async (productRef, variantRef) => {
      gatewayCalls.catalogInput++;
      steps.push("catalog-proof");
      assert.equal(productRef, "prd_01ARZ3NDEKTSV4RRFFQ69G5FAV");
      assert.equal(variantRef, "var_01ARZ3NDEKTSV4RRFFQ69G5FAV");
      if (catalogProofMode === "mismatched-offer")
        return {
          productRef,
          variantRef,
          offerRef: "off_00000000000000000000000002",
          snapshotRevision: "1",
          supplierUnitMinor: "1",
          currency: "RUB",
          unit: "piece",
          availability: "Available",
          mappingRevision: "1",
          displayName: "Fixture",
        };
      if (catalogProofMode === "stale-revision")
        return {
          productRef,
          variantRef,
          offerRef,
          snapshotRevision: "0",
          supplierUnitMinor: "1",
          currency: "RUB",
          unit: "piece",
          availability: "Available",
          mappingRevision: "1",
          displayName: "Fixture",
        };
      return {
        productRef,
        variantRef,
        offerRef,
        snapshotRevision: "1",
        supplierUnitMinor: "1",
        currency: "RUB",
        unit: "piece",
        availability: "Available",
        mappingRevision: "1",
        displayName: "Fixture",
      };
    },
  };
  assert.equal(
    await store.runOnce(gateway, new AbortController().signal),
    "attempted",
  );
  assert.deepEqual(gatewayCalls, {
    read: 1,
    setQuantity: 0,
    remove: 0,
    catalogInput: 0,
  });
  assert.equal(copiedBytes, 0);
  assert.deepEqual(guardParameters, [
    [ownerInstanceId, "1", "1", "a".repeat(64), null],
    [ownerInstanceId, "1", "1", "a".repeat(64), "1"],
    [ownerInstanceId, "1", "1", "a".repeat(64), "1"],
    [ownerInstanceId, "1", "1", "a".repeat(64), "1"],
  ]);
  assert.deepEqual(
    messages.map(({ messageType }) => messageType),
    ["AromaObservationChanged.v1", "AromaConvergenceChanged.v1"],
  );
  assert.deepEqual(messages[0].payload, {
    cartScopeRef: "aroma-primary",
    observedRevision: "1",
    observedAt: capturedAt,
    observationState: "Complete",
    cartFingerprint: snapshot.cartFingerprint,
  });
  assert.equal(messages[0].aggregate.version, "1");
  assert.deepEqual(messages[1].payload, {
    cartScopeRef: "aroma-primary",
    desiredRevision: "1",
    observedRevision: "1",
    attemptRef,
    attemptState: "Blocked",
    changedAt: clockRow.now,
    blockerCodes: ["AROMA_MUTATIONS_DISABLED"],
  });
  assert.equal(messages[1].aggregate.version, "2");
  assert.equal(
    statements.some((sql) =>
      sql.includes("INSERT INTO orders.mutation_reservations"),
    ),
    false,
  );
  const reservationUpdates = statements.filter((sql) =>
    sql.includes("UPDATE orders.mutation_reservations"),
  );
  assert.equal(reservationUpdates.length, 1);
  assert.ok(
    reservationUpdates[0].startsWith(
      "UPDATE orders.mutation_reservations r SET state='UnknownOutcome'",
    ),
    "only the empty-attempt recovery sweep may touch reservation state",
  );
  assert.equal(
    statements.some((sql) => sql.includes("SET state='Dispatched'")),
    false,
  );
  assert.equal(
    statements.some((sql) =>
      sql.startsWith("UPDATE orders.mutation_reservations SET state=$2"),
    ),
    false,
  );
  assert.equal(
    statements.some((sql) =>
      sql.startsWith(
        "UPDATE orders.convergence_attempts SET state='MutationDispatched'",
      ),
    ),
    false,
  );
  assert.deepEqual(steps, [
    "work",
    "unresolved-reservations",
    "reservation-recovery-sweep",
    "attempt-clock",
    "start-attempt",
    "snapshot-lines",
    "observation-event-clock",
    "observation-outbox",
    "unresolved-reservations",
    "terminal-clock",
    "terminal-attempt",
    "terminal-event-clock",
    "terminal-outbox",
    "consume-work",
    "release-lease",
  ]);
  await nextTurn();
  assert.match(
    telemetry.render().join("\n"),
    /coffee_aroma_attempt_results_total\{result="blocked"\} 1/u,
  );
  assert.match(
    telemetry.render().join("\n"),
    /coffee_aroma_mutation_calls_total\{action="set_quantity"\} 0/u,
  );
  assert.equal(telemetry.ready, true);

  enabledScenario = true;
  dispatchCommitted = false;
  acknowledgementCommitted = false;
  mutationRequest = undefined;
  operationRef = undefined;
  mutationAck = undefined;
  attemptRef = undefined;
  clockReads = 0;
  copiedBytes = 0;
  copyPayloads = [];
  outboxSequence = 0;
  steps.length = 0;
  messages.length = 0;
  guardParameters.length = 0;
  reservationOutcomes.length = 0;
  Object.assign(gatewayCalls, {
    read: 0,
    setQuantity: 0,
    remove: 0,
    catalogInput: 0,
  });
  const enabledStart = statements.length;
  const enabledStore = createAromaConvergenceStore(
    database,
    {
      ownerInstanceId,
      mutationsEnabled: true,
      leaseMs: 30_000,
      heartbeatIntervalMs: 5_000,
      providerDeadlineMs: 10_000,
      safetyMarginMs: 1_000,
      retryBackoffMs: 1_000,
      maxSnapshotAgeMs: 60_000,
      maxLines: 100,
    },
    telemetry,
  );
  const enabledResult = await enabledStore.runOnce(
    gateway,
    new AbortController().signal,
  );
  assert.equal(enabledResult, "attempted");
  assert.deepEqual(gatewayCalls, {
    read: 2,
    setQuantity: 1,
    remove: 0,
    catalogInput: 1,
  });
  assert.ok(copiedBytes > 0);
  const verifiedLine =
    normalizeAromaCartSnapshot(verificationSnapshot).lines[0];
  assert.deepEqual(copyPayloads, [
    Buffer.alloc(0),
    Buffer.from(
      `aroma-primary\t2\t${offerRef}\t\\N\t1000\t${verifiedLine.sanitizedLineHash}\n`,
    ),
  ]);
  assert.equal(acknowledgementCommitted, true);
  assert.deepEqual(reservationOutcomes, [
    [operationRef, "Acknowledged", canonicalRequestHash(mutationAck)],
    [operationRef, "Verified", canonicalRequestHash(mutationAck)],
  ]);
  assert.deepEqual(
    messages.map(({ messageType }) => messageType),
    [
      "AromaObservationChanged.v1",
      "AromaObservationChanged.v1",
      "AromaConvergenceChanged.v1",
    ],
  );
  assert.deepEqual(messages[0].payload, {
    cartScopeRef: "aroma-primary",
    observedRevision: "1",
    observedAt: capturedAt,
    observationState: "Complete",
    cartFingerprint: snapshot.cartFingerprint,
  });
  assert.deepEqual(messages[1].payload, {
    cartScopeRef: "aroma-primary",
    observedRevision: "2",
    observedAt: capturedAt,
    observationState: "Complete",
    cartFingerprint: verificationSnapshot.cartFingerprint,
  });
  assert.deepEqual(messages[2].payload, {
    cartScopeRef: "aroma-primary",
    desiredRevision: "1",
    observedRevision: "2",
    attemptRef,
    attemptState: "VerifiedInSync",
    changedAt: clockRow.now,
    blockerCodes: [],
  });
  assert.equal(mutationRequest.quantity, "1");
  assert.equal(mutationRequest.cartScopeRef, "aroma-primary");
  assert.equal(mutationRequest.operationRef, operationRef);
  assert.equal(
    canonicalRequestHash(mutationAck),
    canonicalRequestHash({
      operationRef,
      cartScopeRef: "aroma-primary",
      offerRef,
      state: "Acknowledged",
    }),
  );
  assert.match(
    telemetry.render().join("\n"),
    /coffee_aroma_attempt_results_total\{result="verified_in_sync"\} 1/u,
  );
  assert.match(
    telemetry.render().join("\n"),
    /coffee_aroma_mutation_calls_total\{action="set_quantity"\} 1/u,
  );
  assert.equal(telemetry.ready, true);
  const enabledSql = statements.slice(enabledStart);
  const reservations = enabledSql.filter((sql) =>
    sql.startsWith("INSERT INTO orders.mutation_reservations"),
  );
  assert.equal(reservations.length, 1);
  const dispatches = enabledSql.filter((sql) =>
    sql.startsWith(
      "UPDATE orders.mutation_reservations SET state='Dispatched'",
    ),
  );
  assert.equal(dispatches.length, 1);
  const enabledReservationUpdates = enabledSql.filter((sql) =>
    sql.startsWith("UPDATE orders.mutation_reservations SET state=$2"),
  );
  assert.equal(enabledReservationUpdates.length, 2);
  assert.ok(
    steps.indexOf("initial-read") < steps.indexOf("catalog-proof") &&
      steps.indexOf("catalog-proof") < steps.indexOf("reserve") &&
      steps.indexOf("reserve") < steps.indexOf("dispatch-reservation") &&
      steps.indexOf("dispatch-reservation") <
        steps.indexOf("dispatch-attempt") &&
      steps.indexOf("dispatch-attempt") < steps.indexOf("dispatch-commit") &&
      steps.indexOf("dispatch-commit") < steps.indexOf("set-quantity") &&
      steps.indexOf("set-quantity") < steps.indexOf("acknowledged") &&
      steps.indexOf("acknowledged") < steps.indexOf("ack-commit") &&
      steps.indexOf("ack-commit") < steps.indexOf("verification-read") &&
      steps.indexOf("verification-read") <
        steps.indexOf("verified-reservation") &&
      steps.indexOf("verified-reservation") < steps.indexOf("terminal-attempt"),
    `unexpected successful mutation order: ${steps.join(" → ")}`,
  );
  assert.deepEqual(guardParameters[0], [
    ownerInstanceId,
    "1",
    "1",
    "a".repeat(64),
    null,
  ]);
  assert.ok(
    guardParameters
      .slice(1)
      .every(
        ([owner, fence, revision, desiredHash]) =>
          owner === ownerInstanceId &&
          fence === "1" &&
          revision === "1" &&
          desiredHash === "a".repeat(64),
      ),
  );
  await nextTurn();
  assert.ok(statements.slice(enabledStart).includes(unknownCountSql));
  assert.match(
    telemetry.render().join("\n"),
    /coffee_aroma_unknown_outcomes_current 0/u,
  );

  verificationUnavailable = true;
  dispatchCommitted = false;
  acknowledgementCommitted = false;
  mutationRequest = undefined;
  operationRef = undefined;
  mutationAck = undefined;
  attemptRef = undefined;
  clockReads = 0;
  copiedBytes = 0;
  copyPayloads = [];
  outboxSequence = 0;
  steps.length = 0;
  messages.length = 0;
  guardParameters.length = 0;
  reservationOutcomes.length = 0;
  Object.assign(gatewayCalls, {
    read: 0,
    setQuantity: 0,
    remove: 0,
    catalogInput: 0,
  });
  const unavailableVerificationStart = statements.length;
  const unavailableVerificationResult = await enabledStore.runOnce(
    gateway,
    new AbortController().signal,
  );
  assert.equal(unavailableVerificationResult, "attempted");
  assert.deepEqual(gatewayCalls, {
    read: 2,
    setQuantity: 1,
    remove: 0,
    catalogInput: 1,
  });
  assert.equal(acknowledgementCommitted, true);
  assert.deepEqual(copyPayloads, [Buffer.alloc(0)]);
  assert.deepEqual(
    messages.map(({ messageType }) => messageType),
    ["AromaObservationChanged.v1", "AromaConvergenceChanged.v1"],
  );
  assert.equal(messages[0].payload.observedRevision, "1");
  assert.deepEqual(messages[1].payload, {
    cartScopeRef: "aroma-primary",
    desiredRevision: "1",
    observedRevision: "1",
    attemptRef,
    attemptState: "UnknownOutcome",
    changedAt: clockRow.now,
    blockerCodes: ["AROMA_VERIFICATION_UNAVAILABLE"],
  });
  const unavailableVerificationSql = statements.slice(
    unavailableVerificationStart,
  );
  assert.deepEqual(reservationOutcomes, [
    [operationRef, "Acknowledged", canonicalRequestHash(mutationAck)],
    [operationRef, "UnknownOutcome", canonicalRequestHash(mutationAck)],
  ]);
  assert.equal(
    unavailableVerificationSql.some((sql) =>
      sql.startsWith("INSERT INTO orders.cart_observed_revisions"),
    ),
    true,
    "the baseline observation remains the last current fact",
  );
  assert.equal(
    unavailableVerificationSql.filter((sql) =>
      sql.startsWith("INSERT INTO orders.cart_observed_revisions"),
    ).length,
    1,
    "verification failure must not publish a new Observed revision",
  );
  assert.deepEqual(steps, [
    "work",
    "unresolved-reservations",
    "reservation-recovery-sweep",
    "attempt-clock",
    "start-attempt",
    "initial-read",
    "snapshot-lines",
    "baseline-observation-clock",
    "observation-outbox",
    "unresolved-reservations",
    "catalog-proof",
    "operation-clock",
    "select-action",
    "reserve",
    "extend-lease",
    "dispatch-reservation",
    "dispatch-attempt",
    "dispatch-commit",
    "set-quantity",
    "acknowledged",
    "ack-commit",
    "verification-read-failed",
    "unknown-outcome",
    "terminal-clock",
    "terminal-attempt",
    "terminal-event-clock",
    "terminal-outbox",
    "consume-work",
    "release-lease",
  ]);
  await nextTurn();
  assert.ok(
    statements.slice(unavailableVerificationStart).includes(unknownCountSql),
  );
  assert.match(
    telemetry.render().join("\n"),
    /coffee_aroma_unknown_outcomes_current 1/u,
  );
  assert.match(
    telemetry.render().join("\n"),
    /coffee_aroma_attempt_results_total\{result="unknown_outcome"\} 1/u,
  );
  assert.match(
    telemetry.render().join("\n"),
    /coffee_aroma_provider_failures_total 1/u,
  );
  assert.equal(telemetry.ready, false);

  const resetEnabledRun = ({
    proofMode = "valid",
    mappingChanged = false,
    outcome = "success",
    failInitialRead = false,
    invalidInitialSnapshot = false,
    invalidVerificationSnapshot = false,
  } = {}) => {
    verificationUnavailable = false;
    heartbeatSqlFailureScenario = false;
    terminalReleaseMiss = false;
    initialReadFailure = failInitialRead;
    initialSnapshotInvalid = invalidInitialSnapshot;
    verificationSnapshotInvalid = invalidVerificationSnapshot;
    catalogProofMode = proofMode;
    mappingChangesAfterProof = mappingChanged;
    catalogSourceReads = 0;
    mutationOutcome = outcome;
    dispatchCommitted = false;
    acknowledgementCommitted = false;
    mutationRequest = undefined;
    operationRef = undefined;
    mutationAck = undefined;
    attemptRef = undefined;
    clockReads = 0;
    copiedBytes = 0;
    copyPayloads = [];
    outboxSequence = 0;
    steps.length = 0;
    messages.length = 0;
    guardParameters.length = 0;
    reservationOutcomes.length = 0;
    Object.assign(gatewayCalls, {
      read: 0,
      setQuantity: 0,
      remove: 0,
      catalogInput: 0,
    });
  };

  for (const scenario of [
    {
      name: "initial Gateway GET failure",
      options: { failInitialRead: true },
      state: "Failed",
      blocker: "AROMA_OBSERVATION_UNAVAILABLE",
      rollback: false,
    },
    {
      name: "invalid initial snapshot",
      options: { invalidInitialSnapshot: true },
      state: "Failed",
      blocker: "AROMA_OBSERVATION_INVALID",
      rollback: true,
    },
  ]) {
    resetEnabledRun(scenario.options);
    const start = statements.length;
    assert.equal(
      await enabledStore.runOnce(gateway, new AbortController().signal),
      "attempted",
      scenario.name,
    );
    const scenarioSql = statements.slice(start);
    assert.deepEqual(gatewayCalls, {
      read: 1,
      setQuantity: 0,
      remove: 0,
      catalogInput: 0,
    });
    assert.equal(
      scenarioSql.some((sql) =>
        sql.startsWith("INSERT INTO orders.cart_observed_revisions"),
      ),
      false,
      `${scenario.name} must not publish an Observed revision`,
    );
    assert.equal(
      scenarioSql.some((sql) =>
        sql.startsWith("INSERT INTO orders.mutation_reservations"),
      ),
      false,
    );
    assert.equal(steps.includes("snapshot-lines"), false);
    assert.equal(steps.includes("catalog-proof"), false);
    assert.equal(scenarioSql.includes("ROLLBACK"), scenario.rollback);
    assert.deepEqual(copyPayloads, []);
    assert.deepEqual(reservationOutcomes, []);
    assert.deepEqual(
      messages.map(({ messageType }) => messageType),
      ["AromaConvergenceChanged.v1"],
    );
    assert.equal(messages[0].payload.attemptState, scenario.state);
    assert.equal(messages[0].payload.observedRevision, "0");
    assert.deepEqual(messages[0].payload.blockerCodes, [scenario.blocker]);
    assert.equal(steps.includes("initial-read"), true);
    assert.equal(steps.includes("terminal-attempt"), true);
  }

  resetEnabledRun({ invalidVerificationSnapshot: true });
  const invalidVerificationStart = statements.length;
  assert.equal(
    await enabledStore.runOnce(gateway, new AbortController().signal),
    "attempted",
  );
  const invalidVerificationSql = statements.slice(invalidVerificationStart);
  assert.deepEqual(gatewayCalls, {
    read: 2,
    setQuantity: 1,
    remove: 0,
    catalogInput: 1,
  });
  assert.equal(acknowledgementCommitted, true);
  assert.equal(steps.includes("verification-read-invalid"), true);
  assert.deepEqual(copyPayloads, [Buffer.alloc(0)]);
  assert.deepEqual(reservationOutcomes, [
    [operationRef, "Acknowledged", canonicalRequestHash(mutationAck)],
    [operationRef, "UnknownOutcome", canonicalRequestHash(mutationAck)],
  ]);
  assert.deepEqual(
    messages.map(({ messageType }) => messageType),
    ["AromaObservationChanged.v1", "AromaConvergenceChanged.v1"],
  );
  assert.equal(messages[0].payload.observedRevision, "1");
  assert.deepEqual(messages[1].payload, {
    cartScopeRef: "aroma-primary",
    desiredRevision: "1",
    observedRevision: "1",
    attemptRef,
    attemptState: "UnknownOutcome",
    changedAt: clockRow.now,
    blockerCodes: ["AROMA_VERIFICATION_INVALID"],
  });
  assert.equal(
    invalidVerificationSql.filter((sql) =>
      sql.startsWith("INSERT INTO orders.cart_observed_revisions"),
    ).length,
    1,
    "an invalid verification snapshot must leave only the baseline current",
  );
  assert.equal(
    invalidVerificationSql.includes("ROLLBACK"),
    true,
    "the invalid verification snapshot is rolled back before terminal UnknownOutcome",
  );
  assert.equal(steps.includes("verified-reservation"), false);
  assert.equal(steps.includes("unknown-outcome"), true);

  for (const proofMode of ["mismatched-offer", "stale-revision"]) {
    resetEnabledRun({ proofMode });
    const start = statements.length;
    assert.equal(
      await enabledStore.runOnce(gateway, new AbortController().signal),
      "attempted",
    );
    const scenarioSql = statements.slice(start);
    assert.deepEqual(gatewayCalls, {
      read: 1,
      setQuantity: 0,
      remove: 0,
      catalogInput: 1,
    });
    assert.equal(steps.includes("catalog-proof"), true);
    assert.equal(steps.includes("reserve"), false);
    assert.equal(
      scenarioSql.some((sql) =>
        sql.startsWith("INSERT INTO orders.mutation_reservations"),
      ),
      false,
    );
    assert.equal(
      scenarioSql.some((sql) =>
        sql.startsWith(
          "UPDATE orders.mutation_reservations SET state='Dispatched'",
        ),
      ),
      false,
    );
    assert.deepEqual(
      messages.map(({ messageType }) => messageType),
      ["AromaObservationChanged.v1", "AromaConvergenceChanged.v1"],
    );
    assert.equal(messages[1].payload.attemptState, "Blocked");
    assert.deepEqual(messages[1].payload.blockerCodes, [
      "AROMA_MAPPING_NOT_AVAILABLE",
    ]);
    assert.deepEqual(reservationOutcomes, []);
  }

  resetEnabledRun({ mappingChanged: true });
  const mappingChangeStart = statements.length;
  assert.equal(
    await enabledStore.runOnce(gateway, new AbortController().signal),
    "attempted",
  );
  const mappingChangeSql = statements.slice(mappingChangeStart);
  assert.equal(gatewayCalls.catalogInput, 1);
  assert.equal(catalogSourceReads, 2);
  assert.equal(gatewayCalls.read, 1);
  assert.equal(gatewayCalls.setQuantity, 0);
  assert.equal(steps.includes("catalog-proof"), true);
  assert.equal(steps.includes("reserve"), false);
  assert.ok(mappingChangeSql.includes("ROLLBACK"));
  assert.equal(
    mappingChangeSql.some((sql) =>
      sql.startsWith("INSERT INTO orders.mutation_reservations"),
    ),
    false,
  );
  assert.equal(
    mappingChangeSql.some((sql) =>
      sql.startsWith(
        "UPDATE orders.mutation_reservations SET state='Dispatched'",
      ),
    ),
    false,
  );
  assert.equal(
    mappingChangeSql.some((sql) =>
      sql.startsWith("UPDATE orders.convergence_attempts SET state=$2"),
    ),
    false,
  );
  assert.deepEqual(
    messages.map(({ messageType }) => messageType),
    ["AromaObservationChanged.v1"],
  );

  for (const [outcome, state, blocker] of [
    ["not-found", "Rejected", "AROMA_CART_ITEM_NOT_FOUND"],
    ["ambiguous", "UnknownOutcome", "AROMA_OPERATION_UNKNOWN_OUTCOME"],
    ["invalid-ack", "UnknownOutcome", "AROMA_OPERATION_UNKNOWN_OUTCOME"],
  ]) {
    resetEnabledRun({ outcome });
    const start = statements.length;
    assert.equal(
      await enabledStore.runOnce(gateway, new AbortController().signal),
      "attempted",
    );
    const scenarioSql = statements.slice(start);
    assert.deepEqual(gatewayCalls, {
      read: 1,
      setQuantity: 1,
      remove: 0,
      catalogInput: 1,
    });
    assert.deepEqual(
      reservationOutcomes.map(([, result]) => result),
      [state],
    );
    assert.equal(acknowledgementCommitted, false);
    assert.equal(steps.includes("verification-read"), false);
    assert.equal(
      scenarioSql.filter((sql) =>
        sql.startsWith("INSERT INTO orders.cart_observed_revisions"),
      ).length,
      1,
      "a mutation error must leave the baseline as the last complete observation",
    );
    assert.deepEqual(
      messages.map(({ messageType }) => messageType),
      ["AromaObservationChanged.v1", "AromaConvergenceChanged.v1"],
    );
    assert.equal(
      messages[1].payload.attemptState,
      state === "Rejected" ? "Blocked" : "UnknownOutcome",
    );
    assert.deepEqual(messages[1].payload.blockerCodes, [blocker]);
    assert.equal(
      reservationOutcomes[0][2],
      state === "Rejected"
        ? canonicalRequestHash({
            status: 404,
            problemCode: "AROMA_CART_ITEM_NOT_FOUND",
          })
        : null,
    );
  }

  resetEnabledRun();
  enabledScenario = false;
  recoveredAppliedScenario = true;
  unresolvedReads = 0;
  recoveredBarrierReads = 0;
  observedReadRevisions.length = 0;
  observedWriteRevisions.length = 0;
  const appliedRecoveryStart = statements.length;
  assert.equal(
    await enabledStore.runOnce(gateway, new AbortController().signal),
    "attempted",
  );
  const appliedRecoverySql = statements.slice(appliedRecoveryStart);
  assert.equal(unresolvedReads, 2);
  assert.equal(recoveredBarrierReads, 2);
  assert.deepEqual(observedReadRevisions, ["1"]);
  assert.deepEqual(observedWriteRevisions, ["2"]);
  assert.deepEqual(gatewayCalls, {
    read: 1,
    setQuantity: 0,
    remove: 0,
    catalogInput: 0,
  });
  assert.deepEqual(reservationOutcomes, [
    ["op_01ARZ3NDEKTSV4RRFFQ69G5FAV", "RecoveredApplied", null],
  ]);
  assert.equal(
    appliedRecoverySql.some((sql) =>
      sql.startsWith("INSERT INTO orders.mutation_reservations"),
    ),
    false,
    "an expired dispatched operation is reconciled, never reserved again",
  );
  assert.equal(
    appliedRecoverySql.some((sql) =>
      sql.startsWith(
        "UPDATE orders.mutation_reservations SET state='Dispatched'",
      ),
    ),
    false,
  );
  assert.deepEqual(
    messages.map(({ messageType }) => messageType),
    ["AromaObservationChanged.v1", "AromaConvergenceChanged.v1"],
  );
  assert.equal(messages[0].payload.observedRevision, "2");
  assert.deepEqual(messages[1].payload, {
    cartScopeRef: "aroma-primary",
    desiredRevision: "1",
    observedRevision: "2",
    attemptRef,
    attemptState: "NoOpInSync",
    changedAt: clockRow.now,
    blockerCodes: [],
  });
  assert.equal(messages[1].causationId, provenance.messageId);
  assert.equal(telemetry.ready, true);

  cleanupScenario = true;
  recoveredAppliedScenario = false;
  resetEnabledRun();
  const cleanupStart = statements.length;
  assert.equal(
    await enabledStore.runOnce(gateway, new AbortController().signal),
    "attempted",
  );
  const cleanupSql = statements.slice(cleanupStart);
  const normalizedCleanupLine = normalizeAromaCartSnapshot(
    cleanupBaselineSnapshot,
  ).lines[0];
  assert.deepEqual(gatewayCalls, {
    read: 2,
    setQuantity: 0,
    remove: 1,
    catalogInput: 0,
  });
  assert.deepEqual(copyPayloads, [
    Buffer.from(
      `aroma-primary\t1\t${offerRef}\t\\N\t1000\t${normalizedCleanupLine.sanitizedLineHash}\n`,
    ),
    Buffer.alloc(0),
  ]);
  assert.equal(acknowledgementCommitted, true);
  assert.deepEqual(
    reservationOutcomes.map(([, state]) => state),
    ["Acknowledged", "Verified"],
  );
  assert.deepEqual(
    messages.map(({ messageType }) => messageType),
    [
      "AromaObservationChanged.v1",
      "AromaObservationChanged.v1",
      "AromaConvergenceChanged.v1",
    ],
  );
  assert.equal(messages[0].payload.observedRevision, "1");
  assert.equal(messages[1].payload.observedRevision, "2");
  assert.deepEqual(messages[2].payload, {
    cartScopeRef: "aroma-primary",
    desiredRevision: "1",
    observedRevision: "2",
    attemptRef,
    attemptState: "Blocked",
    changedAt: clockRow.now,
    blockerCodes: ["PRODUCT_UNAVAILABLE"],
  });
  assert.equal(
    cleanupSql.filter((sql) =>
      sql.startsWith("INSERT INTO orders.mutation_reservations"),
    ).length,
    1,
  );
  assert.equal(
    cleanupSql.filter((sql) =>
      sql.startsWith(
        "UPDATE orders.mutation_reservations SET state='Dispatched'",
      ),
    ).length,
    1,
  );
  assert.ok(
    steps.indexOf("dispatch-commit") < steps.indexOf("remove") &&
      steps.indexOf("remove") < steps.indexOf("acknowledged") &&
      steps.indexOf("ack-commit") < steps.indexOf("verification-read") &&
      steps.indexOf("verification-read") <
        steps.indexOf("verified-reservation") &&
      steps.indexOf("verified-reservation") < steps.indexOf("terminal-attempt"),
    `cleanup mutation must be fenced and verified after a fresh GET: ${steps.join(" → ")}`,
  );

  cleanupAlreadyClean = true;
  resetEnabledRun();
  const cleanRetryStart = statements.length;
  assert.equal(
    await enabledStore.runOnce(gateway, new AbortController().signal),
    "attempted",
  );
  const cleanRetrySql = statements.slice(cleanRetryStart);
  assert.deepEqual(gatewayCalls, {
    read: 1,
    setQuantity: 0,
    remove: 0,
    catalogInput: 0,
  });
  assert.equal(
    cleanRetrySql.some((sql) =>
      sql.startsWith("INSERT INTO orders.mutation_reservations"),
    ),
    false,
    "a fresh empty cart is not blindly cleaned again",
  );
  assert.equal(messages[1].payload.attemptState, "Blocked");
  assert.deepEqual(messages[1].payload.blockerCodes, ["PRODUCT_UNAVAILABLE"]);

  resetEnabledRun();
  cleanupScenario = false;
  cleanupAlreadyClean = false;
  recoveredAppliedScenario = false;
  enabledScenario = true;
  heartbeatLossArmed = true;
  heartbeatFenceLost = false;
  lostFenceChecks = 0;
  mutationRpcStarted = Promise.withResolvers();
  mutationRpcAborted = Promise.withResolvers();
  heartbeatObserved = Promise.withResolvers();
  const lostLeaseStart = statements.length;
  const lostLeaseCaller = new AbortController();
  let lostLeaseRun;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    lostLeaseRun = enabledStore.runOnce(gateway, lostLeaseCaller.signal);
    await mutationRpcStarted.promise;
    t.mock.timers.tick(5_000);
    await heartbeatObserved.promise;
    await mutationRpcAborted.promise;
    assert.equal(await lostLeaseRun, "attempted");
    const lostLeaseSql = statements.slice(lostLeaseStart);
    assert.equal(dispatchCommitted, true);
    assert.equal(acknowledgementCommitted, false);
    assert.equal(gatewayCalls.setQuantity, 1);
    assert.equal(gatewayCalls.read, 1);
    assert.equal(mutationRequest.quantity, "1");
    assert.deepEqual(
      lostLeaseSql.filter((sql) =>
        sql.startsWith(
          "UPDATE orders.mutation_reservations SET state='Dispatched'",
        ),
      ).length,
      1,
    );
    assert.equal(
      lostLeaseSql.some((sql) =>
        sql.startsWith("UPDATE orders.mutation_reservations SET state=$2"),
      ),
      false,
    );
    assert.deepEqual(reservationOutcomes, []);
    assert.equal(lostFenceChecks, 1);
    assert.equal(lostLeaseSql.includes("ROLLBACK"), true);
    assert.equal(steps.includes("acknowledged"), false);
    assert.equal(steps.includes("terminal-attempt"), false);
    assert.equal(steps.includes("terminal-outbox"), false);
    assert.deepEqual(
      messages.map(({ messageType }) => messageType),
      ["AromaObservationChanged.v1"],
    );
  } finally {
    lostLeaseCaller.abort();
    t.mock.timers.reset();
    pendingMutationRpc?.resolve();
    if (lostLeaseRun !== undefined) await lostLeaseRun.catch(() => {});
  }

  resetEnabledRun();
  cleanupScenario = false;
  cleanupAlreadyClean = false;
  recoveredAppliedScenario = false;
  enabledScenario = true;
  heartbeatSqlFailureScenario = true;
  heartbeatLossArmed = true;
  heartbeatFenceLost = false;
  lostFenceChecks = 0;
  heartbeatSqlFailureArmed = true;
  mutationRpcStarted = Promise.withResolvers();
  mutationRpcAborted = Promise.withResolvers();
  heartbeatObserved = Promise.withResolvers();
  pendingMutationRpc = undefined;
  const heartbeatFailureStart = statements.length;
  const heartbeatFailureCaller = new AbortController();
  let heartbeatFailureRun;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    heartbeatFailureRun = enabledStore.runOnce(
      gateway,
      heartbeatFailureCaller.signal,
    );
    await mutationRpcStarted.promise;
    t.mock.timers.tick(5_000);
    await heartbeatObserved.promise;
    await mutationRpcAborted.promise;
    await assert.rejects(heartbeatFailureRun, (error) => {
      assert.equal(error.name, "DatabaseTransactionError");
      assert.equal(error.code, "DB_CONNECTION_LOST");
      return true;
    });
    const heartbeatFailureSql = statements.slice(heartbeatFailureStart);
    assert.equal(dispatchCommitted, true);
    assert.equal(acknowledgementCommitted, false);
    assert.deepEqual(gatewayCalls, {
      read: 1,
      setQuantity: 1,
      remove: 0,
      catalogInput: 1,
    });
    assert.deepEqual(
      reservationOutcomes.map(([, state, hash]) => [state, hash]),
      [["UnknownOutcome", null]],
    );
    assert.equal(lostFenceChecks, 0);
    assert.equal(heartbeatFailureSql.includes("ROLLBACK"), true);
    assert.equal(
      heartbeatFailureSql.some((sql) =>
        sql.startsWith(
          "UPDATE orders.mutation_reservations SET state='Dispatched'",
        ),
      ),
      true,
    );
    assert.equal(
      heartbeatFailureSql.some((sql) =>
        sql.startsWith("UPDATE orders.mutation_reservations SET state=$2"),
      ),
      true,
    );
    assert.equal(steps.includes("heartbeat-sql-error"), true);
    assert.equal(steps.includes("verification-read"), false);
    assert.ok(
      steps.indexOf("set-quantity") < steps.indexOf("heartbeat-sql-error") &&
        steps.indexOf("heartbeat-sql-error") <
          steps.indexOf("unknown-outcome") &&
        steps.indexOf("unknown-outcome") < steps.indexOf("terminal-outbox"),
      `unexpected heartbeat failure order: ${steps.join(" → ")}`,
    );
    assert.deepEqual(
      messages.map(({ messageType }) => messageType),
      ["AromaObservationChanged.v1", "AromaConvergenceChanged.v1"],
    );
    assert.equal(messages[1].payload.attemptState, "UnknownOutcome");
    assert.deepEqual(messages[1].payload.blockerCodes, [
      "AROMA_OPERATION_UNKNOWN_OUTCOME",
    ]);
  } finally {
    heartbeatFailureCaller.abort();
    t.mock.timers.reset();
    pendingMutationRpc?.resolve();
    if (heartbeatFailureRun !== undefined)
      await heartbeatFailureRun.catch(() => {});
  }

  resetEnabledRun();
  cleanupScenario = false;
  cleanupAlreadyClean = false;
  recoveredAppliedScenario = false;
  enabledScenario = true;
  terminalReleaseMiss = true;
  const terminalReleaseStart = statements.length;
  assert.equal(
    await enabledStore.runOnce(gateway, new AbortController().signal),
    "attempted",
  );
  const terminalReleaseSql = statements.slice(terminalReleaseStart);
  const terminalOutboxIndex = terminalReleaseSql.findLastIndex((sql) =>
    sql.startsWith('INSERT INTO "orders"."outbox_messages"'),
  );
  const consumeIndex = terminalReleaseSql.findIndex((sql) =>
    sql.startsWith("UPDATE orders.convergence_work SET dirty=$3"),
  );
  const releaseIndex = terminalReleaseSql.findIndex((sql) =>
    sql.startsWith(
      "UPDATE orders.convergence_leases SET expires_at=clock_timestamp()",
    ),
  );
  const rollbackIndex = terminalReleaseSql.lastIndexOf("ROLLBACK");
  assert.equal(steps.includes("release-lease-miss"), true);
  assert.ok(terminalOutboxIndex >= 0);
  assert.ok(consumeIndex > terminalOutboxIndex);
  assert.ok(releaseIndex > consumeIndex);
  assert.ok(rollbackIndex > releaseIndex);
  assert.equal(
    terminalReleaseSql.some(
      (sql, index) => sql === "COMMIT" && index > terminalOutboxIndex,
    ),
    false,
    "the terminal transaction must not commit after its final fenced release misses",
  );
});

void test("AROMA Gateway journal rereads unknown dispatch and rejection COMMITs without redispatch", async (t) => {
  const operationRef = `op_${"0".repeat(25)}1`;
  const offerRef = `off_${"0".repeat(25)}1`;
  const request = {
    operationRef,
    cartScopeRef: "aroma-primary",
    operationKind: "SetLineQuantity",
    offerRef,
    quantityMilli: "3",
  };
  const conflictingRequest = { ...request, quantityMilli: "4" };
  const acknowledgedRequest = {
    ...request,
    operationRef: `op_${"0".repeat(25)}2`,
    offerRef: `off_${"0".repeat(25)}2`,
    quantityMilli: "5",
  };
  const rejectedRequest = {
    ...request,
    operationRef: `op_${"0".repeat(25)}3`,
  };
  const reserveRaceRequest = {
    ...request,
    operationRef: `op_${"0".repeat(25)}4`,
  };
  const reserveRaceCompetitor = {
    ...reserveRaceRequest,
    quantityMilli: "4",
  };
  const providerUnknownRequest = {
    ...request,
    operationRef: `op_${"0".repeat(25)}5`,
    offerRef: `off_${"0".repeat(25)}5`,
  };
  const preparationRejectedRequest = {
    ...request,
    operationRef: `op_${"0".repeat(25)}6`,
    offerRef: `off_${"0".repeat(25)}6`,
  };
  const terminalRaceRequest = {
    ...request,
    operationRef: `op_${"0".repeat(25)}7`,
    offerRef: `off_${"0".repeat(25)}7`,
  };
  const delegation = {
    transportCaller: "api-internal",
    issuer: "api-internal",
    audience: "aroma-gateway",
    originalCaller: "aroma-convergence",
    operationId: "setAromaCartLineQuantity",
    callerIdentity: "api-internal",
    correlationId: "11111111-1111-4111-8111-111111111111",
    traceparent: "00-11111111111111111111111111111111-2222222222222222-01",
  };
  const reservationOwner = "33333333-3333-4333-8333-333333333333";
  const requestHash = canonicalMutationRequestHash(request, delegation);
  const timestamps = {
    created_at: "2026-10-26T10:00:00.000Z",
    started_at: "2026-10-26T10:00:00.000Z",
    lease_until: "2026-10-26T10:00:30.000Z",
    dispatched_at: null,
    completed_at: null,
    last_seen_at: "2026-10-26T10:00:00.000Z",
    retention_until: "2027-01-24T10:00:00.000Z",
  };
  const acknowledgedResponseBytes = Buffer.from(
    JSON.stringify({
      operationRef: acknowledgedRequest.operationRef,
      cartScopeRef: acknowledgedRequest.cartScopeRef,
      offerRef: acknowledgedRequest.offerRef,
      state: "Acknowledged",
    }),
  );
  const acknowledgedOutcomeHash = createHash("sha256")
    .update(acknowledgedResponseBytes)
    .digest("hex");
  const rejectedResponseBytes = Buffer.from(
    JSON.stringify({
      type: "about:blank",
      title: "AROMA_PROVIDER_REJECTED",
      status: 409,
      code: "AROMA_PROVIDER_REJECTED",
      detail: "The typed gateway mutation was rejected.",
      instance: "/api/internal-v1/aroma/cart-lines",
      correlationId: delegation.correlationId,
      errors: [],
    }),
  );
  const rejectedOutcomeHash = createHash("sha256")
    .update(rejectedResponseBytes)
    .digest("hex");
  const preparationRejectedResponseBytes = Buffer.from(
    JSON.stringify({
      type: "about:blank",
      title: "AROMA_CART_ITEM_NOT_FOUND",
      status: 404,
      code: "AROMA_CART_ITEM_NOT_FOUND",
      detail:
        "Provider mutation was not dispatched because safe preparation failed.",
      instance: "/api/internal-v1/aroma/cart-lines",
      correlationId: "00000000-0000-4000-8000-000000000000",
      errors: [],
    }),
  );
  const terminalRaceResponseBytes = Buffer.from(
    JSON.stringify({
      operationRef: terminalRaceRequest.operationRef,
      cartScopeRef: terminalRaceRequest.cartScopeRef,
      offerRef: terminalRaceRequest.offerRef,
      state: "Acknowledged",
    }),
  );
  const terminalRaceOutcomeHash = createHash("sha256")
    .update(terminalRaceResponseBytes)
    .digest("hex");
  const insertAttempts = [
    request,
    request,
    conflictingRequest,
    acknowledgedRequest,
    acknowledgedRequest,
    rejectedRequest,
    rejectedRequest,
    reserveRaceRequest,
    providerUnknownRequest,
    providerUnknownRequest,
    preparationRejectedRequest,
    preparationRejectedRequest,
    terminalRaceRequest,
    terminalRaceRequest,
  ];
  const journalRows = new Map();
  const queries = [];
  const selectedStates = [];
  let insertCount = 0;
  const dispatchUpdates = new Map();
  let acknowledgeUpdateCount = 0;
  let terminalRaceAcknowledgeUpdateCount = 0;
  let rejectUpdateCount = 0;
  let rejectReservationUpdateCount = 0;
  let unknownUpdateCount = 0;
  let rejectionCommitPending = false;
  let reserveCommitPending = false;
  let commitCount = 0;
  let rollbackCount = 0;
  let unknownCommitObserved = false;
  const { database } = mockDatabase(t, (sql, values) => {
    queries.push({ sql, values: [...values] });
    if (sql === "BEGIN") return { rows: [], rowCount: 0, command: "BEGIN" };
    if (sql.startsWith("SET LOCAL ")) {
      assert.match(
        sql,
        /^SET LOCAL (?:lock_timeout|statement_timeout|idle_in_transaction_session_timeout) = '[0-9]+ms'$/u,
      );
      return { rows: [], rowCount: 0, command: "SET" };
    }
    if (sql === "COMMIT") {
      commitCount++;
      if (reserveCommitPending) {
        reserveCommitPending = false;
        const journalRow = journalRows.get(reserveRaceRequest.operationRef);
        assert.ok(
          journalRow,
          "reserve callback must produce its tentative row",
        );
        // Model the original transaction not being committed, then a competing
        // valid reservation winning this operationRef before the reread.
        journalRows.set(reserveRaceRequest.operationRef, {
          ...journalRow,
          quantity_milli: reserveRaceCompetitor.quantityMilli,
          request_hash: canonicalMutationRequestHash(
            reserveRaceCompetitor,
            delegation,
          ),
          reservation_owner: "44444444-4444-4444-8444-444444444444",
        });
        unknownCommitObserved = true;
        queries.at(-1).unknownCommit = true;
        queries.at(-1).reserveRace = true;
        const error = new Error("simulated connection loss after COMMIT");
        error.code = "ECONNRESET";
        throw error;
      }
      if (commitCount === 2 || rejectionCommitPending) {
        rejectionCommitPending = false;
        unknownCommitObserved = true;
        queries.at(-1).unknownCommit = true;
        // Model the server applying the transition before its COMMIT reply is lost.
        const error = new Error("simulated connection loss after COMMIT");
        error.code = "ECONNRESET";
        throw error;
      }
      return { rows: [], rowCount: 0, command: "COMMIT" };
    }
    if (sql === "ROLLBACK") {
      rollbackCount++;
      return { rows: [], rowCount: 0, command: "ROLLBACK" };
    }
    if (sql.includes("INSERT INTO integration.provider_mutation_journal")) {
      insertCount++;
      const attemptedRequest = insertAttempts[insertCount - 1];
      assert.ok(attemptedRequest, "only expected commands may insert");
      const attemptedHash = canonicalMutationRequestHash(
        attemptedRequest,
        delegation,
      );
      assert.deepEqual(values, [
        attemptedRequest.operationRef,
        attemptedRequest.cartScopeRef,
        attemptedRequest.operationKind,
        attemptedRequest.offerRef,
        attemptedRequest.quantityMilli,
        null,
        attemptedHash,
        delegation.callerIdentity,
        delegation.originalCaller,
        delegation.operationId,
        delegation.correlationId,
        delegation.traceparent,
        reservationOwner,
        30_000,
      ]);
      if (journalRows.has(attemptedRequest.operationRef))
        return { rows: [], rowCount: 0, command: "INSERT" };
      assert.equal(
        attemptedRequest.operationRef,
        values[0],
        "new rows must match the canonical command parameters",
      );
      const journalRow = {
        operation_ref: values[0],
        cart_scope_ref: values[1],
        operation_kind: values[2],
        offer_ref: values[3],
        quantity_milli: values[4],
        source_grind_key_hash: values[5],
        request_hash: values[6],
        caller_identity: values[7],
        original_caller: values[8],
        operation_id: values[9],
        correlation_id: values[10],
        traceparent: values[11],
        state: "Reserved",
        reservation_owner: values[12],
        provider_status_code: null,
        outcome_hash: null,
        failure_code: null,
        response_status: null,
        response_body_bytes: null,
        ...timestamps,
      };
      journalRows.set(journalRow.operation_ref, journalRow);
      assert.ok(
        insertCount === 1 ||
          insertCount === 4 ||
          insertCount === 6 ||
          insertCount === 8 ||
          insertCount === 9 ||
          insertCount === 11 ||
          insertCount === 13,
        "only new commands may insert",
      );
      return {
        rows: [{ ...journalRow }],
        rowCount: 1,
        command: "INSERT",
      };
    }
    if (
      sql.includes("UPDATE integration.provider_mutation_journal") &&
      sql.includes("SET state = 'Dispatched'")
    ) {
      const journalRow = journalRows.get(values[0]);
      assert.ok(journalRow);
      assert.deepEqual(values, [
        journalRow.operation_ref,
        journalRow.request_hash,
        reservationOwner,
      ]);
      const dispatchCount = (dispatchUpdates.get(values[0]) ?? 0) + 1;
      dispatchUpdates.set(values[0], dispatchCount);
      assert.equal(dispatchCount, 1);
      assert.equal(journalRow.state, "Reserved");
      journalRow.state = "Dispatched";
      journalRow.dispatched_at = "2026-10-26T10:00:01.000Z";
      journalRow.last_seen_at = journalRow.dispatched_at;
      return {
        rows: [{ ...journalRow }],
        rowCount: 1,
        command: "UPDATE",
      };
    }
    if (
      sql.includes("UPDATE integration.provider_mutation_journal") &&
      sql.includes("SET state = 'Acknowledged'")
    ) {
      const journalRow = journalRows.get(values[0]);
      assert.ok(journalRow);
      if (values[0] === terminalRaceRequest.operationRef) {
        assert.deepEqual(values, [
          terminalRaceRequest.operationRef,
          reservationOwner,
          canonicalMutationRequestHash(terminalRaceRequest, delegation),
          200,
          terminalRaceOutcomeHash,
          200,
          new Uint8Array(terminalRaceResponseBytes),
        ]);
        assert.equal(journalRow.state, "Dispatched");
        terminalRaceAcknowledgeUpdateCount++;
        assert.equal(terminalRaceAcknowledgeUpdateCount, 1);
        // Recovery wins the terminal write after the provider has acknowledged.
        journalRow.state = "UnknownOutcome";
        journalRow.failure_code = "AROMA_PROVIDER_OUTCOME_UNKNOWN";
        journalRow.completed_at = "2026-10-26T10:00:02.000Z";
        journalRow.retention_until = "2027-01-24T10:00:02.000Z";
        journalRow.last_seen_at = journalRow.completed_at;
        return { rows: [], rowCount: 0, command: "UPDATE" };
      }
      assert.deepEqual(values, [
        acknowledgedRequest.operationRef,
        reservationOwner,
        canonicalMutationRequestHash(acknowledgedRequest, delegation),
        200,
        acknowledgedOutcomeHash,
        200,
        new Uint8Array(acknowledgedResponseBytes),
      ]);
      assert.equal(journalRow.state, "Dispatched");
      acknowledgeUpdateCount++;
      assert.equal(acknowledgeUpdateCount, 1);
      journalRow.state = "Acknowledged";
      journalRow.provider_status_code = values[3];
      journalRow.outcome_hash = values[4];
      journalRow.response_status = values[5];
      journalRow.response_body_bytes = values[6];
      journalRow.completed_at = "2026-10-26T10:00:02.000Z";
      journalRow.retention_until = "2027-01-24T10:00:02.000Z";
      journalRow.last_seen_at = journalRow.completed_at;
      return {
        rows: [{ ...journalRow }],
        rowCount: 1,
        command: "UPDATE",
      };
    }
    if (
      sql.includes("UPDATE integration.provider_mutation_journal") &&
      sql.includes("SET state = 'Rejected'")
    ) {
      const journalRow = journalRows.get(values[0]);
      assert.ok(journalRow);
      if (sql.includes("AND state = 'Reserved'")) {
        assert.deepEqual(values, [
          preparationRejectedRequest.operationRef,
          reservationOwner,
          canonicalMutationRequestHash(preparationRejectedRequest, delegation),
          null,
          createHash("sha256")
            .update(preparationRejectedResponseBytes)
            .digest("hex"),
          "AROMA_CART_ITEM_NOT_FOUND",
          404,
          new Uint8Array(preparationRejectedResponseBytes),
        ]);
        assert.equal(journalRow.state, "Reserved");
        rejectReservationUpdateCount++;
        assert.equal(rejectReservationUpdateCount, 1);
        journalRow.state = "Rejected";
        journalRow.outcome_hash = values[4];
        journalRow.failure_code = values[5];
        journalRow.response_status = values[6];
        journalRow.response_body_bytes = values[7];
        journalRow.dispatched_at = journalRow.started_at;
        journalRow.completed_at = "2026-10-26T10:00:02.000Z";
        journalRow.retention_until = "2027-01-24T10:00:02.000Z";
        journalRow.last_seen_at = journalRow.completed_at;
        return { rows: [{ ...journalRow }], rowCount: 1, command: "UPDATE" };
      }
      assert.match(sql, /AND state = 'Dispatched'/u);
      assert.deepEqual(values, [
        rejectedRequest.operationRef,
        reservationOwner,
        canonicalMutationRequestHash(rejectedRequest, delegation),
        409,
        rejectedOutcomeHash,
        "AROMA_PROVIDER_REJECTED",
        409,
        new Uint8Array(rejectedResponseBytes),
      ]);
      assert.equal(journalRow.state, "Dispatched");
      rejectUpdateCount++;
      assert.equal(rejectUpdateCount, 1);
      journalRow.state = "Rejected";
      journalRow.provider_status_code = values[3];
      journalRow.outcome_hash = values[4];
      journalRow.failure_code = values[5];
      journalRow.response_status = values[6];
      journalRow.response_body_bytes = values[7];
      journalRow.completed_at = "2026-10-26T10:00:02.000Z";
      journalRow.last_seen_at = journalRow.completed_at;
      rejectionCommitPending = true;
      return { rows: [{ ...journalRow }], rowCount: 1, command: "UPDATE" };
    }
    if (
      sql.includes("UPDATE integration.provider_mutation_journal") &&
      sql.includes("SET state = 'UnknownOutcome'")
    ) {
      const journalRow = journalRows.get(values[0]);
      assert.ok(journalRow);
      assert.deepEqual(values, [
        providerUnknownRequest.operationRef,
        reservationOwner,
        canonicalMutationRequestHash(providerUnknownRequest, delegation),
        "AROMA_PROVIDER_DISCONNECT",
      ]);
      assert.equal(journalRow.state, "Dispatched");
      unknownUpdateCount++;
      assert.equal(unknownUpdateCount, 1);
      journalRow.state = "UnknownOutcome";
      journalRow.failure_code = values[3];
      journalRow.completed_at = "2026-10-26T10:00:02.000Z";
      journalRow.retention_until = "2027-01-24T10:00:02.000Z";
      journalRow.last_seen_at = journalRow.completed_at;
      return { rows: [{ ...journalRow }], rowCount: 1, command: "UPDATE" };
    }
    if (
      sql.includes(
        "FROM integration.provider_mutation_journal WHERE operation_ref = $1",
      )
    ) {
      assert.ok(unknownCommitObserved, "recovery read must follow lost COMMIT");
      const journalRow = journalRows.get(values[0]);
      assert.ok(journalRow);
      assert.deepEqual(values, [journalRow.operation_ref]);
      selectedStates.push({ operationRef: values[0], state: journalRow.state });
      return { rows: [{ ...journalRow }], rowCount: 1, command: "SELECT" };
    }
    assert.fail(`Unexpected SQL in Gateway journal scenario: ${sql}`);
  });
  const gatewayMetrics = new GatewayMetrics();
  const gatewayTelemetry = createGatewayTelemetry(gatewayMetrics);
  const store = new ProviderMutationJournalStore(database, {
    reservationOwner,
    leaseMs: 30_000,
    telemetry: gatewayTelemetry,
  });
  let providerCalls = 0;
  const executor = new GatewayMutationExecutor(store, async (requestValue) => {
    providerCalls++;
    if (requestValue.operationRef === providerUnknownRequest.operationRef) {
      const error = new Error("private provider transport canary");
      error.code = "AROMA_PROVIDER_DISCONNECT";
      throw error;
    }
    if (requestValue.operationRef === rejectedRequest.operationRef) {
      return {
        state: "Rejected",
        statusCode: 409,
        providerStatusCode: 409,
        failureCode: "AROMA_PROVIDER_REJECTED",
        responseBodyBytes: rejectedResponseBytes,
      };
    }
    assert.ok(
      requestValue.operationRef === acknowledgedRequest.operationRef ||
        requestValue.operationRef === terminalRaceRequest.operationRef,
      "only fresh acknowledgment commands may reach the provider",
    );
    return {
      state: "Acknowledged",
      statusCode: 200,
      providerStatusCode: 200,
      responseBodyBytes:
        requestValue.operationRef === terminalRaceRequest.operationRef
          ? terminalRaceResponseBytes
          : acknowledgedResponseBytes,
    };
  });

  const first = await executor.execute(request, delegation);
  const replay = await executor.execute(request, delegation);
  const conflictHash = canonicalMutationRequestHash(
    conflictingRequest,
    delegation,
  );
  assert.notEqual(conflictHash, requestHash);
  await assert.rejects(executor.execute(conflictingRequest, delegation), {
    code: "AROMA_OPERATION_REF_CONFLICT",
  });
  assert.equal(providerCalls, 0, "conflicting operation ref must not dispatch");
  const acknowledged = await executor.execute(acknowledgedRequest, delegation);
  const acknowledgedReplay = await executor.execute(
    acknowledgedRequest,
    delegation,
  );

  const rejected = await executor.execute(rejectedRequest, delegation);
  const rejectedReplay = await executor.execute(rejectedRequest, delegation);
  reserveCommitPending = true;
  const providerCallsBeforeReserveRace = providerCalls;
  await assert.rejects(executor.execute(reserveRaceRequest, delegation), {
    code: "AROMA_OPERATION_REF_CONFLICT",
  });
  assert.equal(providerCalls, providerCallsBeforeReserveRace);
  const providerCallsBeforeUnknown = providerCalls;
  const providerUnknown = await executor.execute(
    providerUnknownRequest,
    delegation,
  );
  assert.equal(providerCalls, providerCallsBeforeUnknown + 1);
  const providerUnknownReplay = await executor.execute(
    providerUnknownRequest,
    delegation,
  );
  assert.equal(providerCalls, providerCallsBeforeUnknown + 1);
  let preparationProviderCalls = 0;
  const preparationRejectedExecutor = new GatewayMutationExecutor(
    store,
    async () => {
      preparationProviderCalls++;
      assert.fail("preparation rejection must not dispatch to the provider");
    },
    async () => {
      const error = new Error("provider cart line not found");
      error.code = "ProviderCartItemNotFound";
      throw error;
    },
  );
  const preparationRejected = await preparationRejectedExecutor.execute(
    preparationRejectedRequest,
    delegation,
  );
  const preparationRejectedReplay = await preparationRejectedExecutor.execute(
    preparationRejectedRequest,
    delegation,
  );
  const providerCallsBeforeTerminalRace = providerCalls;
  await assert.rejects(executor.execute(terminalRaceRequest, delegation), {
    code: "AROMA_OPERATION_UNKNOWN_OUTCOME",
  });
  assert.equal(providerCalls, providerCallsBeforeTerminalRace + 1);
  const terminalRaceReplay = await executor.execute(
    terminalRaceRequest,
    delegation,
  );
  assert.equal(providerCalls, providerCallsBeforeTerminalRace + 1);
  const reserveCommitIndex = queries.findIndex((query) => query.reserveRace);
  const reserveRecoveryReadIndex = queries.findIndex(
    (query, index) =>
      index > reserveCommitIndex &&
      query.sql.includes(
        "FROM integration.provider_mutation_journal WHERE operation_ref = $1",
      ) &&
      query.values[0] === reserveRaceRequest.operationRef,
  );
  assert.notEqual(reserveCommitIndex, -1);
  assert.notEqual(reserveRecoveryReadIndex, -1);
  assert.ok(reserveRecoveryReadIndex > reserveCommitIndex);
  assert.equal(queries.filter((query) => query.unknownCommit).length, 3);
  const unknownCommitIndex = queries.findIndex((query) => query.unknownCommit);
  const recoveryReadIndex = queries.findIndex(
    (query, index) =>
      index > unknownCommitIndex &&
      query.sql.includes(
        "FROM integration.provider_mutation_journal WHERE operation_ref = $1",
      ),
  );
  assert.notEqual(unknownCommitIndex, -1, "dispatch COMMIT loss must occur");
  assert.notEqual(
    recoveryReadIndex,
    -1,
    "unknown COMMIT must trigger a reread",
  );
  assert.ok(recoveryReadIndex > unknownCommitIndex);
  assert.deepEqual(selectedStates, [
    { operationRef, state: "Dispatched" },
    { operationRef, state: "Dispatched" },
    { operationRef, state: "Dispatched" },
    { operationRef, state: "Dispatched" },
    { operationRef, state: "Dispatched" },
    { operationRef: acknowledgedRequest.operationRef, state: "Acknowledged" },
    { operationRef: acknowledgedRequest.operationRef, state: "Acknowledged" },
    { operationRef: rejectedRequest.operationRef, state: "Rejected" },
    { operationRef: rejectedRequest.operationRef, state: "Rejected" },
    { operationRef: rejectedRequest.operationRef, state: "Rejected" },
    { operationRef: reserveRaceRequest.operationRef, state: "Reserved" },
    {
      operationRef: providerUnknownRequest.operationRef,
      state: "UnknownOutcome",
    },
    {
      operationRef: providerUnknownRequest.operationRef,
      state: "UnknownOutcome",
    },
    {
      operationRef: preparationRejectedRequest.operationRef,
      state: "Rejected",
    },
    {
      operationRef: preparationRejectedRequest.operationRef,
      state: "Rejected",
    },
    {
      operationRef: terminalRaceRequest.operationRef,
      state: "UnknownOutcome",
    },
    {
      operationRef: terminalRaceRequest.operationRef,
      state: "UnknownOutcome",
    },
    {
      operationRef: terminalRaceRequest.operationRef,
      state: "UnknownOutcome",
    },
  ]);
  assert.deepEqual(first, {
    state: "UnknownOutcome",
    failureCode: "AROMA_PROVIDER_OUTCOME_UNKNOWN",
    replayed: true,
  });
  assert.deepEqual(replay, first);
  assert.deepEqual(acknowledged, {
    state: "Acknowledged",
    statusCode: 200,
    responseBodyBytes: new Uint8Array(acknowledgedResponseBytes),
    replayed: false,
    providerStatusCode: 200,
  });
  assert.deepEqual(acknowledgedReplay, {
    ...acknowledged,
    replayed: true,
  });
  assert.deepEqual(rejected, {
    state: "Rejected",
    statusCode: 409,
    failureCode: "AROMA_PROVIDER_REJECTED",
    responseBodyBytes: new Uint8Array(rejectedResponseBytes),
    providerStatusCode: 409,
    replayed: true,
  });
  assert.deepEqual(rejectedReplay, rejected);
  assert.deepEqual(providerUnknown, {
    state: "UnknownOutcome",
    failureCode: "AROMA_PROVIDER_DISCONNECT",
    replayed: false,
  });
  assert.deepEqual(providerUnknownReplay, {
    ...providerUnknown,
    replayed: true,
  });
  assert.deepEqual(preparationRejected, {
    state: "Rejected",
    statusCode: 404,
    failureCode: "AROMA_CART_ITEM_NOT_FOUND",
    responseBodyBytes: new Uint8Array(preparationRejectedResponseBytes),
    replayed: false,
  });
  assert.deepEqual(preparationRejectedReplay, {
    ...preparationRejected,
    replayed: true,
  });
  assert.deepEqual(terminalRaceReplay, {
    state: "UnknownOutcome",
    failureCode: "AROMA_PROVIDER_OUTCOME_UNKNOWN",
    replayed: true,
  });
  assert.equal(insertCount, 14);
  assert.equal(dispatchUpdates.get(operationRef), 1);
  assert.equal(dispatchUpdates.get(acknowledgedRequest.operationRef), 1);
  assert.equal(acknowledgeUpdateCount, 1);
  assert.equal(terminalRaceAcknowledgeUpdateCount, 1);
  assert.equal(dispatchUpdates.get(rejectedRequest.operationRef), 1);
  assert.equal(rejectUpdateCount, 1);
  assert.equal(rejectReservationUpdateCount, 1);
  assert.equal(unknownUpdateCount, 1);
  assert.equal(dispatchUpdates.get(providerUnknownRequest.operationRef), 1);
  assert.equal(
    dispatchUpdates.has(preparationRejectedRequest.operationRef),
    false,
  );
  assert.equal(commitCount, 25);
  assert.equal(rollbackCount, 2);
  assert.equal(providerCalls, 4);
  assert.equal(preparationProviderCalls, 0);
  const renderedMetrics = gatewayMetrics.render();
  assert.ok(renderedMetrics.includes("aroma_gateway_journal_acquire_total 14"));
  assert.ok(renderedMetrics.includes("aroma_gateway_journal_dispatch_total 5"));
  assert.ok(
    renderedMetrics.includes(
      "aroma_gateway_journal_terminal_persistence_total 4",
    ),
  );
  assert.ok(
    renderedMetrics.includes("aroma_gateway_mutation_acknowledged_total 2"),
  );
  assert.ok(
    renderedMetrics.includes("aroma_gateway_mutation_rejected_total 4"),
  );
  assert.ok(renderedMetrics.includes("aroma_gateway_mutation_unknown_total 5"));
  assert.ok(
    renderedMetrics.includes(
      'aroma_gateway_mutation_outcomes_total{result="acknowledged"} 2',
    ),
  );
  assert.ok(
    renderedMetrics.includes(
      'aroma_gateway_mutation_outcomes_total{result="rejected"} 4',
    ),
  );
  assert.ok(
    renderedMetrics.includes(
      'aroma_gateway_mutation_outcomes_total{result="unknown"} 5',
    ),
  );
  assert.equal(journalRows.get(operationRef).state, "Dispatched");
  assert.equal(journalRows.get(operationRef).response_status, null);
  assert.equal(journalRows.get(operationRef).response_body_bytes, null);
  assert.equal(
    journalRows.get(acknowledgedRequest.operationRef).state,
    "Acknowledged",
  );
  assert.equal(
    journalRows.get(acknowledgedRequest.operationRef).outcome_hash,
    acknowledgedOutcomeHash,
  );
  assert.deepEqual(
    journalRows.get(acknowledgedRequest.operationRef).response_body_bytes,
    new Uint8Array(acknowledgedResponseBytes),
  );
  assert.equal(
    journalRows.get(providerUnknownRequest.operationRef).state,
    "UnknownOutcome",
  );
  assert.equal(
    journalRows.get(providerUnknownRequest.operationRef).failure_code,
    "AROMA_PROVIDER_DISCONNECT",
  );
  assert.equal(
    journalRows.get(providerUnknownRequest.operationRef).response_status,
    null,
  );
  assert.equal(
    journalRows.get(providerUnknownRequest.operationRef).response_body_bytes,
    null,
  );
  assert.equal(
    JSON.stringify(
      journalRows.get(providerUnknownRequest.operationRef),
    ).includes("private provider transport canary"),
    false,
  );
  assert.equal(
    journalRows.get(preparationRejectedRequest.operationRef).state,
    "Rejected",
  );
  assert.equal(
    journalRows.get(preparationRejectedRequest.operationRef).failure_code,
    "AROMA_CART_ITEM_NOT_FOUND",
  );
  assert.deepEqual(
    journalRows.get(preparationRejectedRequest.operationRef)
      .response_body_bytes,
    new Uint8Array(preparationRejectedResponseBytes),
  );
  assert.equal(
    journalRows.get(terminalRaceRequest.operationRef).state,
    "UnknownOutcome",
  );
  assert.equal(
    journalRows.get(terminalRaceRequest.operationRef).response_status,
    null,
  );
  assert.equal(
    journalRows.get(terminalRaceRequest.operationRef).response_body_bytes,
    null,
  );
});

void test("AROMA Gateway journal refuses dispatch after reservation takeover", async (t) => {
  const operationRef = `op_${"0".repeat(25)}8`;
  const requestHash = "a".repeat(64);
  const ownerA = "33333333-3333-4333-8333-333333333333";
  const ownerB = "44444444-4444-4444-8444-444444444444";
  const takeoverAt = "2026-10-26T10:00:31.000Z";
  const journalRow = {
    operation_ref: operationRef,
    cart_scope_ref: "aroma-primary",
    operation_kind: "SetLineQuantity",
    offer_ref: `off_${"0".repeat(25)}8`,
    quantity_milli: "3",
    source_grind_key_hash: null,
    request_hash: requestHash,
    caller_identity: "api-internal",
    original_caller: "aroma-convergence",
    operation_id: "setAromaCartLineQuantity",
    correlation_id: "11111111-1111-4111-8111-111111111111",
    traceparent: null,
    state: "Reserved",
    reservation_owner: ownerB,
    lease_until: "2026-10-26T10:01:01.000Z",
    provider_status_code: null,
    outcome_hash: null,
    failure_code: null,
    response_status: null,
    response_body_bytes: null,
    created_at: "2026-10-26T10:00:00.000Z",
    started_at: "2026-10-26T10:00:00.000Z",
    dispatched_at: null,
    completed_at: null,
    last_seen_at: takeoverAt,
    retention_until: "2027-01-24T10:00:00.000Z",
  };
  // Model the journal row after a legitimate takeover by ownerB.
  let dispatchSql;
  const { database } = mockDatabase(t, (sql, values) => {
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK")
      return { rows: [], rowCount: 0, command: sql };
    if (sql.startsWith("SET LOCAL "))
      return { rows: [], rowCount: 0, command: "SET" };
    if (
      sql.includes("UPDATE integration.provider_mutation_journal") &&
      sql.includes("SET state = 'Dispatched'")
    ) {
      dispatchSql = sql;
      assert.match(sql, /reservation_owner = \$3::uuid/u);
      assert.match(sql, /request_hash = \$2/u);
      assert.match(sql, /state = 'Reserved'/u);
      assert.match(sql, /lease_until > clock_timestamp\(\)/u);
      assert.deepEqual(values, [operationRef, requestHash, ownerA]);
      const matches =
        journalRow.operation_ref === values[0] &&
        journalRow.request_hash === values[1] &&
        journalRow.reservation_owner === values[2] &&
        journalRow.state === "Reserved" &&
        Date.parse(journalRow.lease_until) > Date.parse(takeoverAt);
      return matches
        ? { rows: [{ ...journalRow }], rowCount: 1, command: "UPDATE" }
        : { rows: [], rowCount: 0, command: "UPDATE" };
    }
    if (
      sql.includes(
        "FROM integration.provider_mutation_journal WHERE operation_ref = $1",
      )
    ) {
      assert.deepEqual(values, [operationRef]);
      return { rows: [{ ...journalRow }], rowCount: 1, command: "SELECT" };
    }
    assert.fail(`Unexpected SQL in Gateway stale-owner scenario: ${sql}`);
  });
  const store = new ProviderMutationJournalStore(database, {
    reservationOwner: ownerA,
    leaseMs: 30_000,
  });
  const staleReservation = {
    operationRef,
    requestHash,
    reservationOwner: ownerA,
    leaseUntil: "2026-10-26T10:00:30.000Z",
  };
  const journal = {
    reserve: async () => ({ kind: "Reserved", reservation: staleReservation }),
    markDispatched: (reservation) => store.markDispatched(reservation),
  };
  let providerCalls = 0;
  let preparationCalls = 0;
  const executor = new GatewayMutationExecutor(
    journal,
    async () => {
      providerCalls++;
      assert.fail("a stale owner must not reach the provider");
    },
    async () => {
      preparationCalls++;
      return { safe: true };
    },
  );

  await assert.rejects(
    executor.execute(
      {
        operationRef,
        cartScopeRef: journalRow.cart_scope_ref,
        operationKind: journalRow.operation_kind,
        offerRef: journalRow.offer_ref,
        quantityMilli: journalRow.quantity_milli,
      },
      {
        transportCaller: "api-internal",
        issuer: "api-internal",
        audience: "aroma-gateway",
        originalCaller: "aroma-convergence",
        operationId: journalRow.operation_id,
        callerIdentity: journalRow.caller_identity,
        correlationId: journalRow.correlation_id,
      },
    ),
    { code: "AROMA_RESERVATION_LOST" },
  );
  assert.equal(preparationCalls, 1);
  assert.equal(providerCalls, 0);
  assert.match(dispatchSql, /reservation_owner = \$3::uuid/u);
  assert.equal(journalRow.reservation_owner, ownerB);
});

void test("AROMA mutation journal restart recovery only expires stale Dispatched rows", async (t) => {
  const cutoff = "2026-10-26T10:00:00.000Z";
  const statements = [];
  let recoveryValues;
  let recoveryCallCount = 0;
  const { database } = mockDatabase(t, (sql, values) => {
    statements.push(sql);
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK")
      return { rows: [], rowCount: 0, command: sql };
    if (sql.startsWith("SET LOCAL ")) {
      assert.match(
        sql,
        /^SET LOCAL (?:lock_timeout|statement_timeout|idle_in_transaction_session_timeout) = '[0-9]+ms'$/u,
      );
      return { rows: [], rowCount: 0, command: "SET" };
    }
    assert.match(
      sql,
      /^UPDATE integration\.provider_mutation_journal\b/u,
      "restart recovery permits only the journal recovery statement",
    );
    recoveryValues = [...values];
    recoveryCallCount++;
    assert.match(sql, /SET state = 'UnknownOutcome', failure_code = \$2/u);
    assert.match(
      sql,
      /completed_at = COALESCE\(completed_at, clock_timestamp\(\)\)/u,
    );
    assert.match(
      sql,
      /WHERE state = 'Dispatched' AND dispatched_at IS NOT NULL/u,
    );
    assert.match(
      sql,
      /AND \(\$1::timestamptz IS NULL OR dispatched_at < \$1::timestamptz\)/u,
    );
    return {
      rows: [
        { operation_ref: `op_${"0".repeat(25)}1` },
        { operation_ref: `op_${"0".repeat(25)}2` },
      ],
      rowCount: 2,
      command: "UPDATE",
    };
  });
  const store = new ProviderMutationJournalStore(database, {
    reservationOwner: "33333333-3333-4333-8333-333333333333",
    leaseMs: 30_000,
  });

  assert.equal(await store.recoverAfterRestart(cutoff), 2);
  assert.deepEqual(recoveryValues, [cutoff, "AROMA_PROVIDER_OUTCOME_UNKNOWN"]);
  assert.equal(recoveryCallCount, 1);
  assert.equal(
    statements.filter((sql) =>
      sql.startsWith("UPDATE integration.provider_mutation_journal"),
    ).length,
    1,
  );

  assert.equal(await store.recoverAfterRestart(), 2);
  assert.deepEqual(recoveryValues, [null, "AROMA_PROVIDER_OUTCOME_UNKNOWN"]);
  assert.equal(recoveryCallCount, 2);
  assert.equal(
    statements.filter((sql) =>
      sql.startsWith("UPDATE integration.provider_mutation_journal"),
    ).length,
    2,
  );
  const statementCount = statements.length;
  await assert.rejects(store.recoverAfterRestart("not-a-timestamp"), {
    code: "AROMA_MUTATION_INVALID",
  });
  assert.equal(statements.length, statementCount);
});

void test("ProviderSessionStoreAdapter commits scoped opaque session lifecycle and rolls back corrupt rows", async (t) => {
  const scopeHash = createHash("sha256")
    .update("provider-scope\u0000canonical@example.test")
    .digest("hex");
  const key = Buffer.alloc(32, 23);
  const cookie = {
    name: "gateway_session",
    value: "provider-cookie-canary",
    domain: "provider.test",
    path: "/",
    expiresAt: null,
    secure: true,
    httpOnly: true,
    sameSite: "lax",
  };
  const originalCiphertext = encryptCookieMaterial([cookie], key);
  const updatedCiphertext = encryptCookieMaterial(
    [{ ...cookie, value: "rotated-cookie-canary" }],
    key,
  );
  const expectedSql = {
    load: "SELECT encrypted_cookie_material, expires_at::text, updated_at::text FROM integration.provider_sessions WHERE scope_hash = $1 FOR UPDATE",
    save: "INSERT INTO integration.provider_sessions (scope_hash, encrypted_cookie_material, expires_at, created_at, updated_at) VALUES ($1, $2, $3::timestamptz, clock_timestamp(), clock_timestamp()) ON CONFLICT (scope_hash) DO UPDATE SET encrypted_cookie_material = EXCLUDED.encrypted_cookie_material, expires_at = EXCLUDED.expires_at, updated_at = clock_timestamp() RETURNING scope_hash",
    delete:
      "DELETE FROM integration.provider_sessions WHERE scope_hash = $1 RETURNING scope_hash",
  };
  const allowedControlSql = new Set([
    "BEGIN",
    "COMMIT",
    "ROLLBACK",
    "SET LOCAL lock_timeout = '40ms'",
    "SET LOCAL statement_timeout = '100ms'",
    "SET LOCAL idle_in_transaction_session_timeout = '1000ms'",
  ]);
  let corruptRow = false;
  let storedRow = {
    encrypted_cookie_material: originalCiphertext,
    expires_at: "2026-10-26T10:00:00.000Z",
    updated_at: "2026-10-26T10:15:00.000Z",
  };
  const { database, statements, releases } = mockDatabase(t, (sql, values) => {
    const normalized = sql.trim().replace(/\s+/gu, " ");
    if (allowedControlSql.has(normalized)) return undefined;
    if (normalized === expectedSql.load) {
      assert.deepEqual(values, [scopeHash]);
      if (storedRow === undefined)
        return { rows: [], rowCount: 0, command: "SELECT" };
      return {
        rows: [
          corruptRow
            ? { ...storedRow, expires_at: "not-a-timestamp" }
            : storedRow,
        ],
        rowCount: 1,
        command: "SELECT",
      };
    }
    if (normalized === expectedSql.save) {
      assert.equal(values[0], scopeHash);
      assert.deepEqual(Buffer.from(values[1]), Buffer.from(updatedCiphertext));
      assert.equal(values[2], "2026-10-27T10:00:00.000Z");
      storedRow = {
        encrypted_cookie_material: new Uint8Array(values[1]),
        expires_at: values[2],
        updated_at: "2026-10-26T10:30:00.000Z",
      };
      return {
        rows: [{ scope_hash: scopeHash }],
        rowCount: 1,
        command: "INSERT",
      };
    }
    if (normalized === expectedSql.delete) {
      assert.deepEqual(values, [scopeHash]);
      storedRow = undefined;
      return {
        rows: [{ scope_hash: scopeHash }],
        rowCount: 1,
        command: "DELETE",
      };
    }
    assert.fail(`unexpected ProviderSessionStoreAdapter SQL: ${normalized}`);
  });
  const store = new ProviderSessionStoreAdapter(database);

  const loaded = await store.load(scopeHash);
  assert.ok(loaded);
  assert.deepEqual(
    Buffer.from(loaded.encryptedCookieMaterial),
    Buffer.from(originalCiphertext),
  );
  assert.equal(loaded.expiresAt, "2026-10-26T10:00:00Z");
  assert.equal(loaded.storedAt, "2026-10-26T10:15:00Z");

  await store.save(scopeHash, updatedCiphertext, "2026-10-27T10:00:00.000Z");
  const rotated = await store.load(scopeHash);
  assert.ok(rotated);
  assert.deepEqual(
    Buffer.from(rotated.encryptedCookieMaterial),
    Buffer.from(updatedCiphertext),
  );
  assert.equal(rotated.expiresAt, "2026-10-27T10:00:00Z");
  assert.equal(rotated.storedAt, "2026-10-26T10:30:00Z");

  await store.delete(scopeHash);
  assert.equal(await store.load(scopeHash), undefined);
  storedRow = {
    encrypted_cookie_material: originalCiphertext,
    expires_at: "2026-10-26T10:00:00.000Z",
    updated_at: "2026-10-26T10:15:00.000Z",
  };
  corruptRow = true;
  await assert.rejects(store.load(scopeHash), {
    message: "provider session row expiry is corrupt",
  });

  const tableQueries = statements
    .map((sql) => sql.trim().replace(/\s+/gu, " "))
    .filter((sql) => Object.values(expectedSql).includes(sql));
  assert.deepEqual(tableQueries, [
    expectedSql.load,
    expectedSql.save,
    expectedSql.load,
    expectedSql.delete,
    expectedSql.load,
    expectedSql.load,
  ]);
  assert.equal(statements.filter((sql) => sql === "COMMIT").length, 5);
  assert.equal(statements.filter((sql) => sql === "ROLLBACK").length, 1);
  assert.deepEqual(releases, [false, false, false, false, false, false]);
});

void test("AROMA offer binding export preserves provider identity across register replay and conflict", async (t) => {
  const snapshotRef = "snp_01ARZ3NDEKTSV4RRFFQ69G5FAW";
  const supplierRef = "sup_01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const foreignSupplierRef = "sup_01ARZ3NDEKTSV4RRFFQ69G5FAU";
  const offerRef = "off_01ARZ3NDEKTSV4RRFFQ69G5FAZ";
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  const identities = [
    {
      supplierRef,
      sourceIdentityScheme: CATALOG_SOURCE_IDENTITY_SCHEME,
      sourceProductKeyHash: hash("product-a"),
      sourceVariantKeyHash: hash("variant-a"),
      sourceOfferKeyHash: hash("offer-a"),
      rawProviderOfferId: "provider-offer-a",
      rawProviderProductId: "provider-product-a",
      rawProviderVariantId: "provider-variant-a",
      packing: null,
      grindId: "grind-a",
    },
    {
      supplierRef,
      sourceIdentityScheme: CATALOG_SOURCE_IDENTITY_SCHEME,
      sourceProductKeyHash: hash("product-b"),
      sourceVariantKeyHash: hash("variant-b"),
      sourceOfferKeyHash: hash("offer-b"),
      rawProviderOfferId: "provider-offer-b",
      rawProviderProductId: "provider-product-b",
      rawProviderVariantId: "provider-variant-b",
    },
  ];
  const items = identities.map((identity, index) => ({
    sourceProductKeyHash: identity.sourceProductKeyHash,
    sourceVariantKeyHash: identity.sourceVariantKeyHash,
    sourceOfferKeyHash: identity.sourceOfferKeyHash,
    displayName: `Coffee ${index}`,
    unit: "piece",
    supplierUnitMinor: "100",
    currency: "RUB",
    availability: "Available",
    imageUrl: null,
    supplierPromotions: [],
    sourceIdentityScheme: CATALOG_SOURCE_IDENTITY_SCHEME,
  }));
  const sourceOffers = items.map(
    ({
      sourceProductKeyHash: _sourceProductKeyHash,
      sourceVariantKeyHash: _sourceVariantKeyHash,
      sourceOfferKeyHash: _sourceOfferKeyHash,
      sourceIdentityScheme: _sourceIdentityScheme,
      ...offer
    }) => offer,
  );
  const identityByDisplayName = new Map(
    identities.map((identity, index) => [`Coffee ${index}`, identity]),
  );
  const recordsByBatch = new Map();
  let summary;
  const sourceRows = new Map();
  const exportOffers = new Set();
  const bindings = new Map();
  const batchRows = [];
  const batchOffers = [];
  let sourceInsertAttempts = 0;
  let exportOfferInsertAttempts = 0;
  let exportInsertAttempts = 0;
  let batchInsertAttempts = 0;
  let batchOfferInsertAttempts = 0;
  let bindingInsertAttempts = 0;
  let completionSummaryRollbackCount = 0;
  let loseNextCompletionCommit = false;
  let completionUpdateApplied = false;
  let mismatchNextCompletionCommit = false;
  let awaitingCompletionReread = false;
  let completionUpdateCount = 0;
  let completionRereadCount = 0;
  let loseNextBatchCommitFor;
  let batchCounterUpdateAppliedFor;
  let corruptSourceIdentityOnBatchCommit;
  let awaitingBatchReread = false;
  let batchRereadCount = 0;
  let rawBindingLookupCount = 0;
  let abortDeleteCount = 0;
  let abortUpdateCount = 0;
  let failExportUpdateCount = 0;
  let requireFailedRetryMembership = false;
  let recordingAbort = false;
  const abortSqlSequence = [];
  const exportRow = {
    snapshot_ref: snapshotRef,
    supplier_ref: supplierRef,
    source_identity_scheme: CATALOG_SOURCE_IDENTITY_SCHEME,
    state: "Exporting",
    content_hash: null,
    batch_count: 0,
    product_count: 0,
    variant_count: 0,
    offer_count: 0,
    next_batch_number: 0,
    last_batch_hash: null,
  };
  const knownSql = new Set([
    "INSERT INTO integration.provider_catalog_exports (snapshot_ref, supplier_ref, source_identity_scheme, state) VALUES ($1, $2, $3, 'Exporting') ON CONFLICT DO NOTHING RETURNING snapshot_ref, supplier_ref, source_identity_scheme, state, content_hash, batch_count, product_count, variant_count, offer_count, next_batch_number, last_batch_hash",
    "SELECT snapshot_ref, supplier_ref, source_identity_scheme, state, content_hash, batch_count, product_count, variant_count, offer_count, next_batch_number, last_batch_hash FROM integration.provider_catalog_exports WHERE snapshot_ref = $1 FOR UPDATE",
    "SELECT batch_number, offer_count, uncompressed_bytes, batch_hash, previous_batch_hash FROM integration.provider_export_batches WHERE snapshot_ref = $1 AND batch_number = $2",
    "SELECT ordinal, source_offer_key_hash FROM integration.provider_export_batch_offers WHERE snapshot_ref = $1 AND batch_number = $2 ORDER BY ordinal",
    "SELECT supplier_ref, source_identity_scheme, source_offer_key_hash, source_product_key_hash, source_variant_key_hash, raw_provider_offer_id, raw_provider_product_id, raw_provider_variant_id, provider_packing, provider_grind_id FROM integration.provider_source_offers WHERE supplier_ref = $1 AND source_identity_scheme = $2 AND source_offer_key_hash = $3",
    "INSERT INTO integration.provider_source_offers (supplier_ref, source_identity_scheme, source_offer_key_hash, source_product_key_hash, source_variant_key_hash, raw_provider_offer_id, raw_provider_product_id, raw_provider_variant_id, provider_packing, provider_grind_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT DO NOTHING RETURNING source_offer_key_hash",
    "INSERT INTO integration.provider_export_offers (snapshot_ref, supplier_ref, source_identity_scheme, source_offer_key_hash) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING source_offer_key_hash",
    "INSERT INTO integration.provider_export_batches (snapshot_ref, batch_number, offer_count, uncompressed_bytes, batch_hash, previous_batch_hash) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING RETURNING batch_number, offer_count, uncompressed_bytes, batch_hash, previous_batch_hash",
    "INSERT INTO integration.provider_export_batch_offers (snapshot_ref, batch_number, ordinal, supplier_ref, source_identity_scheme, source_offer_key_hash) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING RETURNING ordinal",
    "UPDATE integration.provider_catalog_exports SET batch_count = batch_count + 1, product_count = (SELECT count(DISTINCT s.source_product_key_hash) FROM integration.provider_export_batch_offers m JOIN integration.provider_source_offers s ON s.supplier_ref = m.supplier_ref AND s.source_identity_scheme = m.source_identity_scheme AND s.source_offer_key_hash = m.source_offer_key_hash WHERE m.snapshot_ref = $1), variant_count = (SELECT count(DISTINCT s.source_variant_key_hash) FROM integration.provider_export_batch_offers m JOIN integration.provider_source_offers s ON s.supplier_ref = m.supplier_ref AND s.source_identity_scheme = m.source_identity_scheme AND s.source_offer_key_hash = m.source_offer_key_hash WHERE m.snapshot_ref = $1), offer_count = (SELECT count(*) FROM integration.provider_export_batch_offers WHERE snapshot_ref = $1), next_batch_number = $2, last_batch_hash = $3, updated_at = clock_timestamp() WHERE snapshot_ref = $1",
    "SELECT batch_number, offer_count, uncompressed_bytes, batch_hash, previous_batch_hash FROM integration.provider_export_batches WHERE snapshot_ref = $1 ORDER BY batch_number",
    "SELECT (SELECT count(*) FROM integration.provider_export_batch_offers WHERE snapshot_ref = $1 AND supplier_ref = $2 AND source_identity_scheme = $3) AS membership_count, (SELECT count(*) FROM integration.provider_export_batch_offers WHERE snapshot_ref = $1 AND supplier_ref = $2 AND source_identity_scheme = $3) AS batch_membership_count, (SELECT count(DISTINCT s.source_product_key_hash) FROM integration.provider_export_batch_offers m JOIN integration.provider_source_offers s ON s.supplier_ref = m.supplier_ref AND s.source_identity_scheme = m.source_identity_scheme AND s.source_offer_key_hash = m.source_offer_key_hash WHERE m.snapshot_ref = $1 AND m.supplier_ref = $2 AND m.source_identity_scheme = $3) AS product_count, (SELECT count(DISTINCT s.source_variant_key_hash) FROM integration.provider_export_batch_offers m JOIN integration.provider_source_offers s ON s.supplier_ref = m.supplier_ref AND s.source_identity_scheme = m.source_identity_scheme AND s.source_offer_key_hash = m.source_offer_key_hash WHERE m.snapshot_ref = $1 AND m.supplier_ref = $2 AND m.source_identity_scheme = $3) AS variant_count",
    "UPDATE integration.provider_catalog_exports SET state = 'Completed', content_hash = $2, batch_count = $3, product_count = $4, variant_count = $5, offer_count = $6, updated_at = clock_timestamp() WHERE snapshot_ref = $1 AND state = 'Exporting' RETURNING snapshot_ref, supplier_ref, source_identity_scheme, state, content_hash, batch_count, product_count, variant_count, offer_count, next_batch_number, last_batch_hash",
    "SELECT EXISTS (SELECT 1 FROM integration.provider_source_offers WHERE supplier_ref = $1 AND source_identity_scheme = $2 AND source_offer_key_hash = $3) AS source_exists, COALESCE((SELECT state FROM integration.provider_catalog_exports WHERE snapshot_ref = $4 AND supplier_ref = $1 AND source_identity_scheme = $2), '') AS snapshot_state, EXISTS (SELECT 1 FROM integration.provider_export_batch_offers WHERE snapshot_ref = $4 AND supplier_ref = $1 AND source_identity_scheme = $2 AND source_offer_key_hash = $3) AS member",
    "INSERT INTO integration.provider_offer_bindings (offer_ref, supplier_ref, source_identity_scheme, source_offer_key_hash, first_snapshot_ref) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING RETURNING offer_ref, supplier_ref, source_identity_scheme, source_offer_key_hash, first_snapshot_ref, state",
    "SELECT offer_ref, supplier_ref, source_identity_scheme, source_offer_key_hash, first_snapshot_ref, state FROM integration.provider_offer_bindings WHERE offer_ref = $1",
    "SELECT b.offer_ref, s.supplier_ref, s.source_identity_scheme, s.source_offer_key_hash, s.raw_provider_offer_id, s.raw_provider_product_id, s.raw_provider_variant_id, s.provider_packing, s.provider_grind_id FROM integration.provider_offer_bindings b JOIN integration.provider_source_offers s ON s.supplier_ref = b.supplier_ref AND s.source_identity_scheme = b.source_identity_scheme AND s.source_offer_key_hash = b.source_offer_key_hash WHERE b.offer_ref = $1 AND b.supplier_ref = $2",
    "SELECT b.offer_ref, b.supplier_ref, b.source_identity_scheme, b.source_offer_key_hash, b.first_snapshot_ref, b.state FROM integration.provider_offer_bindings b JOIN integration.provider_source_offers s ON s.supplier_ref = b.supplier_ref AND s.source_identity_scheme = b.source_identity_scheme AND s.source_offer_key_hash = b.source_offer_key_hash WHERE b.source_identity_scheme = $1 AND b.supplier_ref = $2 AND s.raw_provider_offer_id = $3",
    "DELETE FROM integration.provider_export_batches WHERE snapshot_ref = $1",
    "UPDATE integration.provider_catalog_exports SET state = 'Failed', content_hash = NULL, batch_count = 0, product_count = 0, variant_count = 0, offer_count = 0, next_batch_number = 0, last_batch_hash = NULL, updated_at = clock_timestamp() WHERE snapshot_ref = $1 AND state = 'Exporting'",
    "UPDATE integration.provider_catalog_exports SET state = 'Exporting', content_hash = NULL, batch_count = 0, product_count = 0, variant_count = 0, offer_count = 0, next_batch_number = 0, last_batch_hash = NULL, updated_at = clock_timestamp() WHERE snapshot_ref = $1",
    "UPDATE integration.provider_catalog_exports SET state = 'Failed', updated_at = clock_timestamp() WHERE snapshot_ref = $1 AND state = 'Exporting'",
  ]);
  const { database } = mockDatabase(t, (sql, values) => {
    if (sql === "COMMIT") {
      if (loseNextCompletionCommit && completionUpdateApplied) {
        loseNextCompletionCommit = false;
        completionUpdateApplied = false;
        if (mismatchNextCompletionCommit) {
          exportRow.variant_count = summary.variantCount - 1;
          mismatchNextCompletionCommit = false;
        }
        awaitingCompletionReread = true;
        throw new Error("simulated lost completion COMMIT response");
      }
      if (
        loseNextBatchCommitFor !== undefined &&
        batchCounterUpdateAppliedFor === loseNextBatchCommitFor
      ) {
        const lostBatchNumber = loseNextBatchCommitFor;
        loseNextBatchCommitFor = undefined;
        batchCounterUpdateAppliedFor = undefined;
        if (corruptSourceIdentityOnBatchCommit !== undefined) {
          const saved = sourceRows.get(corruptSourceIdentityOnBatchCommit);
          assert.ok(
            saved,
            "lost batch must have persisted its source identity",
          );
          saved.raw_provider_offer_id = "durable-identity-mismatch";
          corruptSourceIdentityOnBatchCommit = undefined;
        }
        awaitingBatchReread = true;
        throw new Error(
          `simulated lost batch ${lostBatchNumber} COMMIT response`,
        );
      }
      return { rows: [], rowCount: 0, command: sql };
    }
    if (sql === "BEGIN") return { rows: [], rowCount: 0, command: sql };
    if (sql === "ROLLBACK") {
      completionSummaryRollbackCount++;
      return { rows: [], rowCount: 0, command: sql };
    }
    if (sql.startsWith("SET LOCAL ")) {
      assert.match(
        sql,
        /^SET LOCAL (?:lock_timeout|statement_timeout|idle_in_transaction_session_timeout) = '[0-9]+ms'$/u,
      );
      return { rows: [], rowCount: 0, command: "SET" };
    }
    assert.ok(
      knownSql.has(sql),
      `Unexpected SQL in offer binding scenario: ${sql}`,
    );
    if (sql.startsWith("INSERT INTO integration.provider_catalog_exports")) {
      exportInsertAttempts++;
      assert.deepEqual(values, [
        snapshotRef,
        supplierRef,
        CATALOG_SOURCE_IDENTITY_SCHEME,
      ]);
      return {
        rows: exportInsertAttempts === 1 ? [{ ...exportRow }] : [],
        rowCount: Number(exportInsertAttempts === 1),
        command: "INSERT",
      };
    }
    if (
      sql.startsWith(
        "SELECT snapshot_ref, supplier_ref, source_identity_scheme, state",
      )
    ) {
      assert.deepEqual(values, [snapshotRef]);
      if (recordingAbort) abortSqlSequence.push("read-export");
      if (awaitingCompletionReread) {
        completionRereadCount++;
        awaitingCompletionReread = false;
      }
      if (awaitingBatchReread) {
        batchRereadCount++;
        awaitingBatchReread = false;
      }
      return { rows: [{ ...exportRow }], rowCount: 1, command: "SELECT" };
    }
    if (
      sql.startsWith(
        "SELECT batch_number, offer_count, uncompressed_bytes, batch_hash, previous_batch_hash FROM integration.provider_export_batches WHERE snapshot_ref = $1 AND batch_number",
      )
    ) {
      assert.equal(values[0], snapshotRef);
      const existing = batchRows.find(
        (entry) => entry.batch_number === Number(values[1]),
      );
      return {
        rows: existing === undefined ? [] : [{ ...existing }],
        rowCount: Number(existing !== undefined),
        command: "SELECT",
      };
    }
    if (
      sql ===
      "SELECT ordinal, source_offer_key_hash FROM integration.provider_export_batch_offers WHERE snapshot_ref = $1 AND batch_number = $2 ORDER BY ordinal"
    ) {
      assert.equal(values[0], snapshotRef);
      const selectedBatchNumber = Number(values[1]);
      const rows = batchOffers
        .filter((entry) => entry.batch_number === selectedBatchNumber)
        .sort((left, right) => left.ordinal - right.ordinal)
        .map(({ ordinal, source_offer_key_hash }) => ({
          ordinal,
          source_offer_key_hash,
        }));
      return { rows, rowCount: rows.length, command: "SELECT" };
    }
    if (
      sql ===
      "SELECT supplier_ref, source_identity_scheme, source_offer_key_hash, source_product_key_hash, source_variant_key_hash, raw_provider_offer_id, raw_provider_product_id, raw_provider_variant_id, provider_packing, provider_grind_id FROM integration.provider_source_offers WHERE supplier_ref = $1 AND source_identity_scheme = $2 AND source_offer_key_hash = $3"
    ) {
      assert.deepEqual(values.slice(0, 2), [
        supplierRef,
        CATALOG_SOURCE_IDENTITY_SCHEME,
      ]);
      const saved = sourceRows.get(values[2]);
      return {
        rows: saved === undefined ? [] : [{ ...saved }],
        rowCount: Number(saved !== undefined),
        command: "SELECT",
      };
    }
    if (sql.startsWith("INSERT INTO integration.provider_source_offers")) {
      sourceInsertAttempts++;
      const identity = identities.find(
        (item) => item.sourceOfferKeyHash === values[2],
      );
      assert.ok(identity);
      assert.deepEqual(values, [
        supplierRef,
        CATALOG_SOURCE_IDENTITY_SCHEME,
        identity.sourceOfferKeyHash,
        identity.sourceProductKeyHash,
        identity.sourceVariantKeyHash,
        identity.rawProviderOfferId,
        identity.rawProviderProductId,
        identity.rawProviderVariantId,
        identity.packing === null ? "" : null,
        identity.grindId ?? null,
      ]);
      sourceRows.set(identity.sourceOfferKeyHash, {
        supplier_ref: supplierRef,
        source_identity_scheme: CATALOG_SOURCE_IDENTITY_SCHEME,
        source_offer_key_hash: identity.sourceOfferKeyHash,
        source_product_key_hash: identity.sourceProductKeyHash,
        source_variant_key_hash: identity.sourceVariantKeyHash,
        raw_provider_offer_id: identity.rawProviderOfferId,
        raw_provider_product_id: identity.rawProviderProductId,
        raw_provider_variant_id: identity.rawProviderVariantId,
        provider_packing: identity.packing === null ? "" : null,
        provider_grind_id: identity.grindId ?? null,
      });
      return {
        rows: [{ source_offer_key_hash: identity.sourceOfferKeyHash }],
        rowCount: 1,
        command: "INSERT",
      };
    }
    if (sql.startsWith("INSERT INTO integration.provider_export_offers")) {
      exportOfferInsertAttempts++;
      assert.equal(values[0], snapshotRef);
      assert.equal(values[1], supplierRef);
      assert.equal(values[2], CATALOG_SOURCE_IDENTITY_SCHEME);
      assert.ok(
        identities.some(
          (identity) => identity.sourceOfferKeyHash === values[3],
        ),
      );
      exportOffers.add(values[3]);
      return {
        rows: [{ source_offer_key_hash: values[3] }],
        rowCount: 1,
        command: "INSERT",
      };
    }
    if (sql.startsWith("INSERT INTO integration.provider_export_batches")) {
      batchInsertAttempts++;
      const batchNumber = Number(values[1]);
      const expected = recordsByBatch.get(batchNumber);
      assert.ok(expected, `missing stream batch ${batchNumber}`);
      assert.deepEqual(values, [
        snapshotRef,
        String(batchNumber),
        String(expected.record.offerCount),
        String(expected.record.uncompressedBytes),
        expected.record.batchHash,
        expected.record.previousBatchHash,
      ]);
      const saved = {
        batch_number: batchNumber,
        offer_count: expected.record.offerCount,
        uncompressed_bytes: expected.record.uncompressedBytes,
        batch_hash: expected.record.batchHash,
        previous_batch_hash: expected.record.previousBatchHash,
      };
      batchRows.push(saved);
      return { rows: [saved], rowCount: 1, command: "INSERT" };
    }
    if (
      sql.startsWith("INSERT INTO integration.provider_export_batch_offers")
    ) {
      batchOfferInsertAttempts++;
      const batchNumber = Number(values[1]);
      const expected = recordsByBatch.get(batchNumber);
      assert.ok(expected, `missing stream batch ${batchNumber}`);
      const identity = expected.identities[Number(values[2])];
      assert.ok(identity);
      assert.deepEqual(values, [
        snapshotRef,
        String(batchNumber),
        String(expected.identities.indexOf(identity)),
        supplierRef,
        CATALOG_SOURCE_IDENTITY_SCHEME,
        identity.sourceOfferKeyHash,
      ]);
      batchOffers.push({
        batch_number: batchNumber,
        ordinal: Number(values[2]),
        source_offer_key_hash: identity.sourceOfferKeyHash,
      });
      return { rows: [{ ordinal: values[2] }], rowCount: 1, command: "INSERT" };
    }
    if (
      sql.startsWith(
        "UPDATE integration.provider_catalog_exports SET batch_count",
      )
    ) {
      const expectedBatchNumber = Number(values[1]) - 1;
      const expected = recordsByBatch.get(expectedBatchNumber);
      assert.ok(expected, `missing stream batch ${expectedBatchNumber}`);
      assert.deepEqual(values, [
        snapshotRef,
        expectedBatchNumber + 1,
        expected.record.batchHash,
      ]);
      const savedIdentities = [...exportOffers].map((sourceOfferKeyHash) =>
        identities.find(
          (identity) => identity.sourceOfferKeyHash === sourceOfferKeyHash,
        ),
      );
      Object.assign(exportRow, {
        batch_count: batchRows.length,
        product_count: new Set(
          savedIdentities.map((identity) => identity.sourceProductKeyHash),
        ).size,
        variant_count: new Set(
          savedIdentities.map((identity) => identity.sourceVariantKeyHash),
        ).size,
        offer_count: batchOffers.length,
        next_batch_number: expectedBatchNumber + 1,
        last_batch_hash: expected.record.batchHash,
      });
      batchCounterUpdateAppliedFor = expectedBatchNumber;
      return { rows: [], rowCount: 1, command: "UPDATE" };
    }
    if (
      sql.startsWith(
        "SELECT batch_number, offer_count, uncompressed_bytes, batch_hash, previous_batch_hash FROM integration.provider_export_batches WHERE snapshot_ref = $1 ORDER BY",
      )
    ) {
      assert.deepEqual(values, [snapshotRef]);
      return {
        rows: batchRows.map((row) => ({ ...row })),
        rowCount: batchRows.length,
        command: "SELECT",
      };
    }
    if (
      sql.startsWith(
        "SELECT (SELECT count(*) FROM integration.provider_export_batch_offers",
      )
    ) {
      assert.deepEqual(values, [
        snapshotRef,
        supplierRef,
        CATALOG_SOURCE_IDENTITY_SCHEME,
      ]);
      assert.equal(exportOffers.size, 2);
      assert.equal(batchOffers.length, 2);
      return {
        rows: [
          {
            membership_count: 2,
            batch_membership_count: 2,
            product_count: 2,
            variant_count: 2,
          },
        ],
        rowCount: 1,
        command: "SELECT",
      };
    }
    if (
      sql.startsWith(
        "UPDATE integration.provider_catalog_exports SET state = 'Completed'",
      )
    ) {
      assert.ok(summary);
      completionUpdateCount++;
      completionUpdateApplied = true;
      assert.deepEqual(values, [
        snapshotRef,
        summary.contentHash,
        String(summary.batchCount),
        String(summary.productCount),
        String(summary.variantCount),
        String(summary.offerCount),
      ]);
      Object.assign(exportRow, {
        state: "Completed",
        content_hash: summary.contentHash,
      });
      return { rows: [{ ...exportRow }], rowCount: 1, command: "UPDATE" };
    }
    if (
      sql.startsWith(
        "SELECT EXISTS (SELECT 1 FROM integration.provider_source_offers",
      )
    ) {
      assert.equal(values[0], supplierRef);
      assert.equal(values[1], CATALOG_SOURCE_IDENTITY_SCHEME);
      assert.equal(values[3], snapshotRef);
      assert.ok(sourceRows.has(values[2]));
      const member = batchOffers.some(
        (entry) => entry.source_offer_key_hash === values[2],
      );
      if (requireFailedRetryMembership) assert.equal(member, true);
      return {
        rows: [
          {
            source_exists: true,
            snapshot_state: exportRow.state,
            member,
          },
        ],
        rowCount: 1,
        command: "SELECT",
      };
    }
    if (sql.startsWith("INSERT INTO integration.provider_offer_bindings")) {
      bindingInsertAttempts++;
      assert.equal(values[1], supplierRef);
      assert.equal(values[2], CATALOG_SOURCE_IDENTITY_SCHEME);
      assert.equal(values[4], snapshotRef);
      assert.ok(
        identities.some(
          (identity) => identity.sourceOfferKeyHash === values[3],
        ),
      );
      const existing = bindings.get(values[0]);
      if (existing !== undefined) {
        assert.equal(existing.supplier_ref, values[1]);
        assert.equal(values[0], offerRef);
        assert.equal(
          values[3],
          identities[bindingInsertAttempts - 2].sourceOfferKeyHash,
        );
        return { rows: [], rowCount: 0, command: "INSERT" };
      }
      const inserted = {
        offer_ref: values[0],
        supplier_ref: values[1],
        source_identity_scheme: values[2],
        source_offer_key_hash: values[3],
        first_snapshot_ref: values[4],
        state: "Bound",
      };
      bindings.set(values[0], inserted);
      return { rows: [{ ...inserted }], rowCount: 1, command: "INSERT" };
    }
    if (
      sql.startsWith(
        "SELECT offer_ref, supplier_ref, source_identity_scheme, source_offer_key_hash, first_snapshot_ref, state FROM integration.provider_offer_bindings WHERE offer_ref",
      )
    ) {
      assert.deepEqual(values, [offerRef]);
      const existing = bindings.get(values[0]);
      return {
        rows: existing === undefined ? [] : [{ ...existing }],
        rowCount: Number(existing !== undefined),
        command: "SELECT",
      };
    }
    if (
      sql.startsWith(
        "SELECT b.offer_ref, s.supplier_ref, s.source_identity_scheme, s.source_offer_key_hash, s.raw_provider_offer_id",
      )
    ) {
      assert.deepEqual(values, [offerRef, supplierRef]);
      const binding = bindings.get(values[0]);
      const source =
        binding === undefined
          ? undefined
          : sourceRows.get(binding.source_offer_key_hash);
      if (source === undefined)
        return { rows: [], rowCount: 0, command: "SELECT" };
      return {
        rows: [
          {
            offer_ref: binding.offer_ref,
            supplier_ref: source.supplier_ref,
            source_identity_scheme: source.source_identity_scheme,
            source_offer_key_hash: source.source_offer_key_hash,
            raw_provider_offer_id: source.raw_provider_offer_id,
            raw_provider_product_id: source.raw_provider_product_id,
            raw_provider_variant_id: source.raw_provider_variant_id,
            provider_packing: source.provider_packing,
            provider_grind_id: source.provider_grind_id,
          },
        ],
        rowCount: 1,
        command: "SELECT",
      };
    }
    if (
      sql ===
      "SELECT b.offer_ref, b.supplier_ref, b.source_identity_scheme, b.source_offer_key_hash, b.first_snapshot_ref, b.state FROM integration.provider_offer_bindings b JOIN integration.provider_source_offers s ON s.supplier_ref = b.supplier_ref AND s.source_identity_scheme = b.source_identity_scheme AND s.source_offer_key_hash = b.source_offer_key_hash WHERE b.source_identity_scheme = $1 AND b.supplier_ref = $2 AND s.raw_provider_offer_id = $3"
    ) {
      rawBindingLookupCount++;
      assert.equal(values[0], CATALOG_SOURCE_IDENTITY_SCHEME);
      assert.ok([supplierRef, foreignSupplierRef].includes(values[1]));
      assert.ok(
        [identities[0].rawProviderOfferId, "unknown-provider-offer"].includes(
          values[2],
        ),
      );
      const binding = [...bindings.values()].find((candidate) => {
        const source = sourceRows.get(candidate.source_offer_key_hash);
        return (
          candidate.supplier_ref === values[1] &&
          candidate.source_identity_scheme === values[0] &&
          source?.source_identity_scheme === values[0] &&
          source?.raw_provider_offer_id === values[2]
        );
      });
      return {
        rows: binding === undefined ? [] : [{ ...binding }],
        rowCount: Number(binding !== undefined),
        command: "SELECT",
      };
    }
    if (
      sql ===
      "DELETE FROM integration.provider_export_batches WHERE snapshot_ref = $1"
    ) {
      assert.deepEqual(values, [snapshotRef]);
      abortDeleteCount++;
      abortSqlSequence.push("delete-batches");
      batchRows.length = 0;
      batchOffers.length = 0;
      return { rows: [], rowCount: 2, command: "DELETE" };
    }
    if (
      sql ===
      "UPDATE integration.provider_catalog_exports SET state = 'Failed', content_hash = NULL, batch_count = 0, product_count = 0, variant_count = 0, offer_count = 0, next_batch_number = 0, last_batch_hash = NULL, updated_at = clock_timestamp() WHERE snapshot_ref = $1 AND state = 'Exporting'"
    ) {
      assert.deepEqual(values, [snapshotRef]);
      assert.equal(exportRow.state, "Exporting");
      abortUpdateCount++;
      abortSqlSequence.push("mark-failed");
      Object.assign(exportRow, {
        state: "Failed",
        content_hash: null,
        batch_count: 0,
        product_count: 0,
        variant_count: 0,
        offer_count: 0,
        next_batch_number: 0,
        last_batch_hash: null,
      });
      return { rows: [], rowCount: 1, command: "UPDATE" };
    }
    if (
      sql ===
      "UPDATE integration.provider_catalog_exports SET state = 'Exporting', content_hash = NULL, batch_count = 0, product_count = 0, variant_count = 0, offer_count = 0, next_batch_number = 0, last_batch_hash = NULL, updated_at = clock_timestamp() WHERE snapshot_ref = $1"
    ) {
      assert.deepEqual(values, [snapshotRef]);
      assert.equal(exportRow.state, "Failed");
      Object.assign(exportRow, {
        state: "Exporting",
        content_hash: null,
        batch_count: 0,
        product_count: 0,
        variant_count: 0,
        offer_count: 0,
        next_batch_number: 0,
        last_batch_hash: null,
      });
      return { rows: [], rowCount: 1, command: "UPDATE" };
    }
    if (
      sql ===
      "UPDATE integration.provider_catalog_exports SET state = 'Failed', updated_at = clock_timestamp() WHERE snapshot_ref = $1 AND state = 'Exporting'"
    ) {
      assert.deepEqual(values, [snapshotRef]);
      assert.equal(exportRow.state, "Exporting");
      failExportUpdateCount++;
      Object.assign(exportRow, { state: "Failed" });
      return { rows: [], rowCount: 1, command: "UPDATE" };
    }
    assert.fail(`Unhandled allowed SQL in offer binding scenario: ${sql}`);
  });
  const store = new OfferBindingStore(database);
  const request = {
    offerRef,
    supplierRef,
    snapshotRef,
    sourceIdentityScheme: CATALOG_SOURCE_IDENTITY_SCHEME,
    sourceOfferKeyHash: identities[0].sourceOfferKeyHash,
  };
  let prematureRegistrationRejected = false;
  const stream = createCatalogExportStream({
    source: {
      async *[Symbol.asyncIterator]() {
        yield* sourceOffers;
      },
    },
    request: {
      snapshotRef,
      supplierRef,
      providerSnapshotRef: `aroma-gateway:catalog-export:${snapshotRef}`,
    },
    boundary: {
      identity: {
        resolve: (offer) => {
          const identity = identityByDisplayName.get(offer.displayName);
          assert.ok(identity);
          return identity;
        },
      },
      hash: { sha256: sha256CatalogHash },
      persistence: {
        beginExport: () => store.beginExport(snapshotRef, supplierRef),
        recordBatch: async ({ record, identities: batchIdentities }) => {
          recordsByBatch.set(record.batchNumber, {
            record,
            identities: batchIdentities,
          });
          await store.recordBatch(
            snapshotRef,
            supplierRef,
            record,
            batchIdentities,
          );
          if (record.batchNumber === 0) {
            await assert.rejects(store.register(request), {
              code: "AROMA_BINDING_SNAPSHOT_INCOMPLETE",
            });
            prematureRegistrationRejected = true;
            assert.equal(bindingInsertAttempts, 0);
          }
        },
        completeExport: async (completedSummary) => {
          summary = completedSummary;
          const updatesBeforeRejectedSummaries = completionUpdateCount;
          const rollbacksBeforeRejectedSummaries =
            completionSummaryRollbackCount;
          const invalidSummaries = [
            { ...summary, supplierRef: foreignSupplierRef },
            { ...summary, batchCount: summary.batchCount + 1 },
            { ...summary, offerCount: summary.offerCount + 1 },
            { ...summary, productCount: summary.productCount + 1 },
            { ...summary, variantCount: summary.variantCount + 1 },
            {
              ...summary,
              contentHash:
                summary.contentHash === "0".repeat(64)
                  ? "1".repeat(64)
                  : "0".repeat(64),
            },
          ];
          for (const invalidSummary of invalidSummaries) {
            await assert.rejects(store.completeExport(invalidSummary), {
              code: "AROMA_BINDING_SNAPSHOT_INCOMPLETE",
            });
            assert.equal(exportRow.state, "Exporting");
            assert.equal(completionUpdateCount, updatesBeforeRejectedSummaries);
          }
          assert.equal(
            completionSummaryRollbackCount,
            rollbacksBeforeRejectedSummaries + invalidSummaries.length,
          );
          loseNextCompletionCommit = true;
          await store.completeExport(completedSummary);
        },
      },
    },
    clock: { now: () => "2026-10-26T12:00:00.000Z" },
    limits: { maxOffersPerBatch: 1 },
  });
  const emitted = [];
  for await (const chunk of stream)
    emitted.push(JSON.parse(Buffer.from(chunk).toString("utf8")));
  assert.deepEqual(
    emitted.map((record) => record.recordType),
    [
      "snapshot-started",
      "snapshot-batch",
      "snapshot-batch",
      "snapshot-completed",
    ],
  );
  const batches = emitted.filter(
    (record) => record.recordType === "snapshot-batch",
  );
  assert.equal(batches[0].batchNumber, 0);
  assert.equal(batches[0].previousBatchHash, null);
  assert.equal(batches[1].batchNumber, 1);
  assert.equal(batches[1].previousBatchHash, batches[0].batchHash);
  assert.deepEqual(
    batches.flatMap((record) => record.items),
    items,
  );
  assert.equal(prematureRegistrationRejected, true);
  assert.deepEqual(summary, {
    snapshotRef,
    supplierRef,
    batchCount: 2,
    productCount: 2,
    variantCount: 2,
    offerCount: 2,
    contentHash: createHash("sha256")
      .update(
        Buffer.concat(
          batches.map((record) => Buffer.from(record.batchHash, "hex")),
        ),
      )
      .digest("hex"),
  });
  assert.deepEqual(exportRow, {
    snapshot_ref: snapshotRef,
    supplier_ref: supplierRef,
    source_identity_scheme: CATALOG_SOURCE_IDENTITY_SCHEME,
    state: "Completed",
    content_hash: summary.contentHash,
    batch_count: 2,
    product_count: 2,
    variant_count: 2,
    offer_count: 2,
    next_batch_number: 2,
    last_batch_hash: batches[1].batchHash,
  });
  assert.equal(exportRow.state, "Completed");
  assert.equal(exportRow.content_hash, summary.contentHash);
  assert.equal(completionUpdateCount, 1);
  assert.equal(completionRereadCount, 1);

  // A visible COMMIT can still fail the exact persisted-summary proof. Model a
  // second completion attempt with one mismatched durable count, then make sure
  // the safe unknown outcome survives before any binding INSERT is attempted.
  exportRow.state = "Exporting";
  loseNextCompletionCommit = true;
  mismatchNextCompletionCommit = true;
  await assert.rejects(
    async () => {
      await store.completeExport(summary);
      await store.register(request);
    },
    { code: "TRANSACTION_OUTCOME_UNKNOWN" },
  );
  assert.equal(exportRow.state, "Completed");
  assert.equal(exportRow.variant_count, summary.variantCount - 1);
  assert.equal(completionUpdateCount, 2);
  assert.equal(completionRereadCount, 2);
  assert.equal(bindingInsertAttempts, 0);
  exportRow.variant_count = summary.variantCount;

  const registered = await store.register(request);
  assert.deepEqual(registered, {
    offerRef,
    supplierRef,
    sourceIdentityScheme: CATALOG_SOURCE_IDENTITY_SCHEME,
    sourceOfferKeyHash: identities[0].sourceOfferKeyHash,
    firstSnapshotRef: snapshotRef,
    state: "Bound",
  });
  assert.deepEqual(await store.register(request), registered);
  await assert.rejects(
    store.register({
      ...request,
      sourceOfferKeyHash: identities[1].sourceOfferKeyHash,
    }),
    { code: "AROMA_BINDING_CONFLICT" },
  );
  assert.deepEqual(
    await store.resolveByRawProviderOfferId(
      identities[0].rawProviderOfferId,
      supplierRef,
    ),
    registered,
  );
  assert.equal(
    await store.resolveByRawProviderOfferId(
      identities[0].rawProviderOfferId,
      foreignSupplierRef,
    ),
    undefined,
  );
  assert.equal(
    await store.resolveByRawProviderOfferId(
      "unknown-provider-offer",
      supplierRef,
    ),
    undefined,
  );
  assert.equal(rawBindingLookupCount, 3);
  const rawLookupBaseline = rawBindingLookupCount;
  await assert.rejects(store.resolveByRawProviderOfferId("", supplierRef), {
    code: "AROMA_BINDING_CONFLICT",
  });
  await assert.rejects(
    store.resolveByRawProviderOfferId("provider\u0000offer", supplierRef),
    { code: "AROMA_BINDING_CONFLICT" },
  );
  assert.equal(rawBindingLookupCount, rawLookupBaseline);
  assert.equal(
    Object.hasOwn(registered, "rawProviderOfferId"),
    false,
    "binding lookup does not expose the raw provider identifier",
  );
  assert.deepEqual(await store.resolveProviderOffer(offerRef, supplierRef), {
    offerRef,
    supplierRef,
    sourceIdentityScheme: CATALOG_SOURCE_IDENTITY_SCHEME,
    sourceOfferKeyHash: identities[0].sourceOfferKeyHash,
    rawProviderOfferId: identities[0].rawProviderOfferId,
    rawProviderProductId: identities[0].rawProviderProductId,
    rawProviderVariantId: identities[0].rawProviderVariantId,
    packing: null,
    grindId: identities[0].grindId,
    cartLineId: null,
  });
  const completedExport = { ...exportRow };
  const completedBatches = batchRows.map((entry) => ({ ...entry }));
  const completedBatchOffers = batchOffers.map((entry) => ({ ...entry }));
  recordingAbort = true;
  await store.abortExport(snapshotRef);
  recordingAbort = false;
  assert.deepEqual(abortSqlSequence, ["read-export"]);
  assert.equal(abortDeleteCount, 0);
  assert.equal(abortUpdateCount, 0);
  assert.deepEqual(exportRow, completedExport);
  assert.deepEqual(batchRows, completedBatches);
  assert.deepEqual(batchOffers, completedBatchOffers);

  // The batch COMMIT may succeed while its response is lost. Reconcile the
  // exact persisted chain and identities instead of executing the batch again.
  const batchInsertBaseline = batchInsertAttempts;
  const batchOfferInsertBaseline = batchOfferInsertAttempts;
  const sourceInsertBaseline = sourceInsertAttempts;
  const exportOfferInsertBaseline = exportOfferInsertAttempts;
  const completionUpdateBaseline = completionUpdateCount;
  sourceRows.clear();
  exportOffers.clear();
  batchRows.length = 0;
  batchOffers.length = 0;
  Object.assign(exportRow, {
    state: "Exporting",
    content_hash: null,
    batch_count: 0,
    product_count: 0,
    variant_count: 0,
    offer_count: 0,
    next_batch_number: 0,
    last_batch_hash: null,
  });
  batchCounterUpdateAppliedFor = undefined;

  const firstBatch = recordsByBatch.get(0);
  assert.ok(firstBatch);
  loseNextBatchCommitFor = 0;
  await store.recordBatch(
    snapshotRef,
    supplierRef,
    firstBatch.record,
    firstBatch.identities,
  );
  assert.equal(batchRereadCount, 1);
  assert.equal(exportRow.next_batch_number, 1);
  assert.equal(batchRows.length, 1);
  assert.equal(batchOffers.length, 1);

  // A lost response is not enough to claim success if the durable source row
  // no longer matches the submitted provider identity. Keep the unknown
  // outcome and do not continue the chain or repeat any write.
  const secondBatch = recordsByBatch.get(1);
  assert.ok(secondBatch);
  loseNextBatchCommitFor = 1;
  const mismatchedIdentityHash = secondBatch.identities[0]?.sourceOfferKeyHash;
  assert.ok(mismatchedIdentityHash);
  corruptSourceIdentityOnBatchCommit = mismatchedIdentityHash;
  await assert.rejects(
    store.recordBatch(
      snapshotRef,
      supplierRef,
      secondBatch.record,
      secondBatch.identities,
    ),
    { code: "TRANSACTION_OUTCOME_UNKNOWN" },
  );
  assert.equal(batchRereadCount, 2);
  assert.equal(exportRow.next_batch_number, 2);
  assert.equal(exportRow.state, "Exporting");
  assert.equal(batchRows.length, 2);
  assert.equal(batchOffers.length, 2);
  assert.equal(sourceRows.size, 2);
  assert.equal(exportOffers.size, 2);
  assert.equal(
    sourceRows.get(mismatchedIdentityHash)?.raw_provider_offer_id,
    "durable-identity-mismatch",
  );
  assert.equal(completionUpdateCount, completionUpdateBaseline);
  assert.equal(batchInsertAttempts - batchInsertBaseline, 2);
  assert.equal(batchOfferInsertAttempts - batchOfferInsertBaseline, 2);
  assert.equal(sourceInsertAttempts - sourceInsertBaseline, 2);
  assert.equal(exportOfferInsertAttempts - exportOfferInsertBaseline, 2);

  recordingAbort = true;
  await store.abortExport(snapshotRef);
  recordingAbort = false;
  assert.deepEqual(abortSqlSequence, [
    "read-export",
    "read-export",
    "delete-batches",
    "mark-failed",
  ]);
  assert.equal(abortDeleteCount, 1);
  assert.equal(abortUpdateCount, 1);
  assert.equal(exportRow.state, "Failed");
  assert.equal(exportRow.content_hash, null);
  assert.equal(exportRow.batch_count, 0);
  assert.equal(exportRow.product_count, 0);
  assert.equal(exportRow.variant_count, 0);
  assert.equal(exportRow.offer_count, 0);
  assert.equal(exportRow.next_batch_number, 0);
  assert.equal(exportRow.last_batch_hash, null);
  assert.deepEqual(batchRows, []);
  assert.deepEqual(batchOffers, []);
  assert.equal(
    bindings.size,
    1,
    "aborting export does not create another binding",
  );

  // A non-cancellation failure keeps the already committed batch for diagnosis,
  // but a Failed snapshot cannot become a new provider binding.
  await store.beginExport(snapshotRef, supplierRef);
  assert.equal(exportRow.state, "Exporting");
  batchCounterUpdateAppliedFor = undefined;
  await store.recordBatch(
    snapshotRef,
    supplierRef,
    firstBatch.record,
    firstBatch.identities,
  );
  assert.equal(exportRow.batch_count, 1);
  assert.equal(exportRow.next_batch_number, 1);
  assert.equal(batchRows.length, 1);
  assert.equal(batchOffers.length, 1);
  assert.equal(batchRows[0]?.batch_hash, firstBatch.record.batchHash);

  const failedExportDeleteBaseline = abortDeleteCount;
  await store.failExport(snapshotRef);
  assert.equal(exportRow.state, "Failed");
  assert.equal(failExportUpdateCount, 1);
  assert.equal(abortDeleteCount, failedExportDeleteBaseline);
  assert.equal(exportRow.batch_count, 1);
  assert.equal(exportRow.next_batch_number, 1);
  assert.equal(batchRows.length, 1);
  assert.equal(batchOffers.length, 1);
  const failedExportBindingInserts = bindingInsertAttempts;
  requireFailedRetryMembership = true;
  await assert.rejects(
    store.register({ ...request, offerRef: "off_01ARZ3NDEKTSV4RRFFQ69G5FAY" }),
    { code: "AROMA_BINDING_SNAPSHOT_INCOMPLETE" },
  );
  requireFailedRetryMembership = false;
  assert.equal(bindingInsertAttempts, failedExportBindingInserts);
});
