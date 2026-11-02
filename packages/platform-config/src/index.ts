import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
export {
  CANONICAL_DATABASE_OWNERS,
  deriveLaunchDatabaseName,
  deriveRuntimeDatabaseTarget,
  validateLaunchDatabaseIdentity,
  validateLaunchRunIdentity,
  verifyLaunchConfigBytes,
} from "./launch-database-target.js";
export type {
  DatabaseOwnershipDocument,
  LaunchConfigAttestation,
  LaunchDatabaseIdentity,
  LaunchRunIdentity,
  RuntimeDatabaseTarget,
} from "./launch-database-target.js";
export {
  CANONICAL_KAFKA_TOPIC_NAMES,
  deriveLaunchKafkaRegistryTarget,
  deriveRuntimeKafkaTarget,
  launchKafkaLogicalTopic,
  launchKafkaPhysicalName,
} from "./launch-kafka-target.js";
export type {
  LaunchKafkaRegistryTarget,
  LaunchKafkaTarget,
} from "./launch-kafka-target.js";

export const RUNTIME_NAMES = [
  "edge-gateway",
  "api-public",
  "api-internal",
  "customer-service",
  "catalog-service",
  "catalog-supplier-sync",
  "catalog-activation-worker",
  "pricing-service",
  "orders-service",
  "orders-aroma-preparation",
  "aroma-observer",
  "aroma-convergence",
  "aroma-gateway",
  "realtime-gateway",
] as const;

export type RuntimeName = (typeof RUNTIME_NAMES)[number];
export type EnvironmentName = "development" | "staging" | "production";
export type TransportMode = "public-tls" | "mtls";

export const AROMA_SUPPLIER_REF = "sup_00000000000000000000000001" as const;
export const AROMA_SCOPE_REF = "aroma-primary" as const;
export const AROMA_DEFAULT_PACKING = "Aroma" as const;

export const KAFKA_TOPIC_NAMES: readonly KafkaTopicName[] = [
  "coffee.catalog.snapshot.v1",
  "coffee.catalog.mapping.v2",
  "coffee.orders.lifecycle.v1",
  "coffee.aroma.cart.commands.v1",
  "coffee.aroma.cart.events.v1",
  "coffee.realtime.invalidate.v1",
] as const;

export const KAFKA_GROUP_IDS: readonly KafkaGroupId[] = [
  "orders-catalog-mapping-v2",
  "orders-aroma-preparation-v1",
  "orders-aroma-projection-v1",
  "aroma-convergence-v1",
  "realtime-gateway-v1",
] as const;

export type ListenConfig = Readonly<{ host: string; port: number }>;
export type HealthConfig = Readonly<{
  livePath: string;
  readyPath: string;
  metricsPath: string;
  intervalMs: number;
  timeoutMs: number;
  startupGraceMs: number;
  failureThreshold: number;
  successThreshold: number;
}>;
export type DatabasePoolConfig = Readonly<{
  max: number;
  maxWaiting?: number;
  checkoutTimeoutMs: number;
  lockTimeoutMs: number;
  interactiveStatementTimeoutMs: number;
  backgroundStatementTimeoutMs: number;
  terminalTimeoutMs: number;
  transactionTimeoutMs: number;
  idleTimeoutMs: number;
  maxLifetimeMs: number;
}>;
export type PostgresConfig = Readonly<{
  host: string;
  bootstrapUsername: "coffeeuser";
  port: number;
  sslMode: "prefer" | "require" | "verify-full";
  maxConnections: number;
  reservedConnections: number;
  rolloutReplicas: number;
}>;
export type DatabaseAdmissionInput = Readonly<{
  localIdentity?: Readonly<Record<string, unknown>> | undefined;
  services: Readonly<
    Record<string, Pick<RuntimeConfig, "replicas" | "dbPool" | "database">>
  >;
  postgres: Pick<
    PostgresConfig,
    "maxConnections" | "reservedConnections" | "rolloutReplicas"
  >;
}>;
export type DatabaseAdmissionBudget = Readonly<{
  steadyConnections: number;
  rolloutConnections: number;
  reservedConnections: number;
  requiredConnections: number;
  maxConnections: number;
  largestPool: number;
}>;
export type KafkaTopicName =
  | "coffee.catalog.snapshot.v1"
  | "coffee.catalog.mapping.v2"
  | "coffee.orders.lifecycle.v1"
  | "coffee.aroma.cart.commands.v1"
  | "coffee.aroma.cart.events.v1"
  | "coffee.realtime.invalidate.v1";
export type KafkaGroupId =
  | "orders-catalog-mapping-v2"
  | "orders-aroma-preparation-v1"
  | "orders-aroma-projection-v1"
  | "aroma-convergence-v1"
  | "realtime-gateway-v1";
export type KafkaProcessing = "durable" | "realtime";
export type KafkaConsumerConfig = Readonly<{
  groupId: KafkaGroupId;
  topics: readonly KafkaTopicName[];
  processing: KafkaProcessing;
}>;
export type KafkaServiceConfig = Readonly<{
  producers: readonly KafkaTopicName[];
  consumers: readonly KafkaConsumerConfig[];
}>;
export type KafkaTopicConfig = Readonly<{
  name: KafkaTopicName;
  partitions: number;
  retentionHours: number;
  dlq: string;
}>;
export type KafkaTopicKey =
  | "catalogSnapshot"
  | "catalogMapping"
  | "ordersLifecycle"
  | "aromaCommands"
  | "aromaEvents"
  | "realtimeInvalidate";
export type KafkaRetryConfig = Readonly<{
  baseMs: number;
  maxMs: number;
  maxAttempts: number;
}>;
export type KafkaQuarantineConfig = Readonly<{
  durable: "owner-database";
  realtime: "topic-dlq";
}>;
export type KafkaDeliveryConfig = Readonly<{
  producerRetries: number;
  maxMessageBytes: number;
  maxPartitions: number;
  maxInFlight: number;
  queueCapacity: number;
  sendTimeoutMs: number;
  receiveTimeoutMs: number;
  commitTimeoutMs: number;
  revokeTimeoutMs: number;
  shutdownTimeoutMs: number;
  leaseMs: number;
  retry: KafkaRetryConfig;
  quarantine: KafkaQuarantineConfig;
}>;
export type KafkaConfig = Readonly<{
  brokers: readonly string[];
  clientProtocol: "SASL_SSL";
  autoTopicCreation: false;
  topics: Readonly<Record<KafkaTopicKey, KafkaTopicConfig>>;
  delivery: KafkaDeliveryConfig;
}>;
export type PermissionConfig = Readonly<{
  manifest: string;
  net: readonly string[];
  fsRead: readonly string[];
  fsWrite: readonly string[];
  childProcess: boolean;
  workers: boolean;
}>;
export type CatalogSchedulerConfig = Readonly<{
  intervalMs: 3_600_000;
  startupImport: true;
  overlapPolicy: "skip";
}>;
export type CatalogSnapshotProofConfig = Readonly<{ maxAgeMs: number }>;
export type AromaPreparationConfig = Readonly<{
  pollIntervalMs: number;
  batchSize: number;
  maxOrders: number;
  maxLines: number;
}>;
export type AromaObservationConfig = Readonly<{
  pollIntervalMs: number;
  intervalMs: number;
  leaseMs: number;
  maxSnapshotAgeMs: number;
  maxLines: number;
  maxResponseBytes: number;
}>;
export type AromaConvergenceConfig = Readonly<{
  pollIntervalMs: number;
  leaseMs: number;
  heartbeatIntervalMs: number;
  providerDeadlineMs: number;
  safetyMarginMs: number;
  retryBackoffMs: number;
  maxSnapshotAgeMs: number;
  maxLines: number;
  maxResponseBytes: number;
}>;
export type RealtimeConfig = Readonly<{
  shutdownGraceMs: number;
  maxConnections: number;
  queueMaxRecords: number;
  queueMaxBytes: number;
  totalQueueMaxRecords: number;
  totalQueueMaxBytes: number;
  ringMaxRecords: number;
  ringMaxBytes: number;
  ringMaxAgeMs: number;
  coalesceMs: number;
  writeTimeoutMs: number;
  heartbeatMs: number;
  authCheckMs: number;
  maxEventDataBytes: number;
  rssBudgetBytes: number;
  fdBudget: number;
}>;
export type RuntimeConfig = Readonly<{
  transportMode: TransportMode;
  listen: ListenConfig;
  health: HealthConfig;
  deadlineMs: number | null;
  deadlineProfiles: Readonly<Record<string, number | null>>;
  concurrency: number;
  replicas: number;
  dbPool: DatabasePoolConfig | null;
  database: string | null;
  secretRefs: readonly string[];
  optionalSecretRefs: readonly string[];
  outbound: readonly string[];
  kafka: KafkaServiceConfig;
  permissions: PermissionConfig;
  mutationCapability: boolean;
  scheduler: CatalogSchedulerConfig | null;
  catalogSnapshotProof?: CatalogSnapshotProofConfig;
  mutationsEnabled?: boolean;
  aromaPreparation?: AromaPreparationConfig;
  aromaObservation?: AromaObservationConfig;
  aromaConvergence?: AromaConvergenceConfig;
  realtime?: RealtimeConfig;
}>;
export type AromaConfig = Readonly<{
  supplierRef: typeof AROMA_SUPPLIER_REF;
  scopeRef: typeof AROMA_SCOPE_REF;
  origin: Readonly<{ scheme: "https"; host: "aromateacoffee.ru"; port: 443 }>;
  redirectsAllowed: false;
  defaultPacking: typeof AROMA_DEFAULT_PACKING;
}>;
export type BrowserOidcProfile = Readonly<{
  issuer: string;
  clientId: string;
  authorizationUrl: string;
  tokenUrl: string;
  jwksUrl: string;
  redirectUri: string;
  allowedAlgorithms: readonly ["RS256"];
  actorRefClaim: string;
  permissionsClaim: string;
}>;
export type PricingPolicyConfig = Readonly<{
  policyVersionRef: string;
  version: string;
  currency: "RUB";
  markupBasisPoints: number;
  minimumMarginMinor: string;
  quoteTtlSeconds: number;
  quantityScale: 3;
  roundingMode: "CEILING";
}>;

export type TelemetryConfig = Readonly<{
  namespace: string;
  releaseDigest: string;
  nginxStatusEndpoint: string;
  collector: Readonly<{
    otlpEndpoint: string;
    healthEndpoint: string;
    memoryLimitMiB: number;
    memorySpikeMiB: number;
    containerMemoryMiB: number;
    memoryCheckIntervalMs: number;
    batchSize: number;
    batchTimeoutMs: number;
    queueCapacity: number;
    queueConsumers: number;
    exportTimeoutMs: number;
    retryInitialMs: number;
    retryMaxMs: number;
    retryWindowMs: number;
    maxLogRecordBytes: number;
  }>;
  producer: Readonly<{
    queueCapacity: number;
    maxRecordBytes: number;
    batchSize: number;
    batchIntervalMs: number;
    exportTimeoutMs: number;
    diagnosticIntervalMs: number;
    flushTimeoutMs: number;
  }>;
  logging: Readonly<{ maxSizeMiB: number; maxFiles: number }>;
  diskWatermarkPercent: number;
  externalReportingEnabled: false;
  grafana: Readonly<{
    endpoint: string;
    memoryLimitMiB: number;
    maxDiskBytes: number;
  }>;
  loki: Readonly<{
    endpoint: string;
    memoryLimitMiB: number;
    maxDiskBytes: number;
    retentionDays: number;
  }>;
  prometheus: Readonly<{
    endpoint: string;
    memoryLimitMiB: number;
    maxDiskBytes: number;
    retentionDays: number;
    outOfOrderWindowMs: number;
  }>;
  tempo: Readonly<{
    endpoint: string;
    otlpEndpoint: string;
    memoryLimitMiB: number;
    maxDiskBytes: number;
    retentionDays: number;
    finishOnShutdownTimeoutMs: number;
  }>;
  alerts: Readonly<{
    version: 1;
    evaluationIntervalMs: number;
    notificationEndpoint: "http://alert-sink:9091/alerts";
    diskUsage: Readonly<{ forMs: 0 }>;
    sinkMemoryMiB: number;
    notReady: Readonly<{ forMs: number; threshold: number }>;
    consumerLag: Readonly<{ forMs: number; threshold: number }>;
    outboxOldestAge: Readonly<{ forMs: number; threshold: number }>;
    unknownOutcome: Readonly<{ forMs: number; threshold: number }>;
    sseDropRate: Readonly<{ forMs: number; threshold: number }>;
  }>;
}>;

export type PlatformConfig = Readonly<{
  $schema: "./platform.schema.json";
  schemaVersion: 1;
  environment: EnvironmentName;
  toolchainRef: string;
  platform: Readonly<Record<string, unknown>>;
  postgres: PostgresConfig;
  localIdentity?: Readonly<Record<string, unknown>>;
  kafka: KafkaConfig;
  aroma: AromaConfig;
  pricingPolicy: PricingPolicyConfig;
  telemetry: TelemetryConfig;
  browserOidc: BrowserOidcProfile | null;
  databaseIsolation: Readonly<{ enabled: boolean }>;
  kafkaNamespaceIsolation: boolean;
  unitCoverage: UnitCoverageVerificationConfig | null;
  nginxTransport: Readonly<Record<string, unknown>>;
  security: Readonly<
    Record<string, unknown> & {
      certificateValidityHours: 24;
      certificateRenewBeforeHours: 6;
    }
  >;
  services: Readonly<Record<RuntimeName, RuntimeConfig>>;
}>;

export type SecurityScanVerificationConfig = Readonly<{
  enabled: true;
  cpu: 2;
  memoryMiB: 2048;
  parallel: 1;
  minimumFreeDiskGiB: 20;
  maximumDatabaseAgeHours: 24;
  approvedFixed: readonly ("CVE-2026-21728" | "CVE-2026-28377")[];
  egressRepositories: readonly [
    "ghcr.io/aquasecurity/trivy-db",
    "ghcr.io/aquasecurity/trivy-java-db",
  ];
}>;

export type UnitCoverageVerificationConfig = Readonly<{
  thresholds: Readonly<{ lines: 90; functions: 90; branches: 85 }>;
  criticalModules: readonly Readonly<{
    id: string;
    sourceRoots: readonly string[];
    coverageRoots: readonly string[];
    format: "js" | "mjs";
  }>[];
  testFiles: readonly string[];
}>;

const UNIT_COVERAGE_MODULES = [
  {
    id: "platform-config",
    sourceRoots: ["packages/platform-config/src"],
    coverageRoots: ["packages/platform-config/dist"],
    format: "js",
  },
  {
    id: "trusted-config-bootstrap",
    sourceRoots: ["tools/config-bootstrap"],
    coverageRoots: ["tools/config-bootstrap"],
    format: "mjs",
  },
  {
    id: "platform-runtime",
    sourceRoots: ["packages/platform-runtime/src"],
    coverageRoots: ["packages/platform-runtime/dist"],
    format: "js",
  },
  {
    id: "persistence-foundation",
    sourceRoots: [
      "packages/platform-database/src",
      "packages/platform-migrations/src",
    ],
    coverageRoots: [
      "packages/platform-database/dist",
      "packages/platform-migrations/dist",
    ],
    format: "js",
  },
  {
    id: "durable-delivery",
    sourceRoots: [
      "packages/platform-outbox/src",
      "packages/platform-inbox/src",
      "packages/platform-idempotency/src",
    ],
    coverageRoots: [
      "packages/platform-outbox/dist",
      "packages/platform-inbox/dist",
      "packages/platform-idempotency/dist",
    ],
    format: "js",
  },
  {
    id: "kafka-runtime",
    sourceRoots: ["packages/platform-kafka-runtime/src"],
    coverageRoots: ["packages/platform-kafka-runtime/dist"],
    format: "js",
  },
  {
    id: "security-trust",
    sourceRoots: [
      "packages/platform-security/src",
      "packages/platform-http/src",
    ],
    coverageRoots: [
      "packages/platform-security/dist",
      "packages/platform-http/dist",
    ],
    format: "js",
  },
  {
    id: "customer-service",
    sourceRoots: ["apps/customer-service/src"],
    coverageRoots: ["apps/customer-service/dist"],
    format: "js",
  },
  {
    id: "catalog-service",
    sourceRoots: [
      "apps/catalog-service/src",
      "apps/catalog-supplier-sync/src",
      "apps/catalog-activation-worker/src",
    ],
    coverageRoots: [
      "apps/catalog-service/dist",
      "apps/catalog-supplier-sync/dist",
      "apps/catalog-activation-worker/dist",
    ],
    format: "js",
  },
  {
    id: "pricing-service",
    sourceRoots: ["apps/pricing-service/src"],
    coverageRoots: ["apps/pricing-service/dist"],
    format: "js",
  },
  {
    id: "orders-service",
    sourceRoots: ["apps/orders-service/src"],
    coverageRoots: ["apps/orders-service/dist"],
    format: "js",
  },
  {
    id: "aroma-convergence",
    sourceRoots: ["apps/aroma-convergence/src"],
    coverageRoots: ["apps/aroma-convergence/dist"],
    format: "js",
  },
  {
    id: "aroma-preparation",
    sourceRoots: ["apps/orders-aroma-preparation/src"],
    coverageRoots: ["apps/orders-aroma-preparation/dist"],
    format: "js",
  },
  {
    id: "aroma-observer",
    sourceRoots: ["apps/aroma-observer/src"],
    coverageRoots: ["apps/aroma-observer/dist"],
    format: "js",
  },
  {
    id: "aroma-gateway",
    sourceRoots: ["apps/aroma-gateway/src"],
    coverageRoots: ["apps/aroma-gateway/dist"],
    format: "js",
  },
  {
    id: "public-api-trust",
    sourceRoots: [
      "apps/api-public/src",
      "apps/api-internal/src",
      "apps/edge-gateway/src",
      "apps/realtime-gateway/src",
    ],
    coverageRoots: [
      "apps/api-public/dist",
      "apps/api-internal/dist",
      "apps/edge-gateway/dist",
      "apps/realtime-gateway/dist",
    ],
    format: "js",
  },
] as const;
const UNIT_COVERAGE_TEST_FILE_COUNT = 60;

export class PlatformConfigError extends Error {
  public readonly path: string;

  public constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "PlatformConfigError";
    this.path = path;
  }
}

type UnknownRecord = Record<string, unknown>;

function record(value: unknown, path: string): UnknownRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new PlatformConfigError(path, "ожидался объект");
  }
  return value as UnknownRecord;
}

function exactKeys(
  value: UnknownRecord,
  expected: readonly string[],
  path: string,
  optional: readonly string[] = [],
): void {
  const expectedSet = new Set([...expected, ...optional]);
  for (const key of Object.keys(value)) {
    if (!expectedSet.has(key))
      throw new PlatformConfigError(`${path}.${key}`, "неизвестный ключ");
  }
  for (const key of expected) {
    if (!Object.hasOwn(value, key))
      throw new PlatformConfigError(
        `${path}.${key}`,
        "обязательное значение отсутствует",
      );
  }
}

function stringValue(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new PlatformConfigError(path, "ожидалась непустая строка");
  return value;
}

function integerValue(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new PlatformConfigError(
      path,
      "ожидалось целое неотрицательное число",
    );
  }
  return value;
}

function positiveIntegerValue(value: unknown, path: string): number {
  const result = integerValue(value, path);
  if (result < 1)
    throw new PlatformConfigError(path, "ожидалось положительное целое число");
  return result;
}

function nullableIntegerValue(value: unknown, path: string): number | null {
  return value === null ? null : integerValue(value, path);
}

function stringArray(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value))
    throw new PlatformConfigError(path, "ожидался массив строк");
  return value.map((entry, index) => stringValue(entry, `${path}[${index}]`));
}

export function parseSecurityScanVerification(
  value: unknown,
): SecurityScanVerificationConfig {
  const path = "config.verification.securityScan";
  const source = record(value, path);
  exactKeys(
    source,
    [
      "enabled",
      "cpu",
      "memoryMiB",
      "parallel",
      "minimumFreeDiskGiB",
      "maximumDatabaseAgeHours",
      "approvedFixed",
      "egressRepositories",
    ],
    path,
  );
  if (source["enabled"] !== true)
    throw new PlatformConfigError(
      `${path}.enabled`,
      "G12 обязателен и должен быть включён",
    );
  const constants = {
    cpu: [source["cpu"], 2],
    memoryMiB: [source["memoryMiB"], 2048],
    parallel: [source["parallel"], 1],
    minimumFreeDiskGiB: [source["minimumFreeDiskGiB"], 20],
    maximumDatabaseAgeHours: [source["maximumDatabaseAgeHours"], 24],
  } as const;
  for (const [key, [actual, expected]] of Object.entries(constants)) {
    if (actual !== expected)
      throw new PlatformConfigError(
        `${path}.${key}`,
        `ожидалось нормативное значение ${expected}`,
      );
  }
  const approvedFixed = stringArray(
    source["approvedFixed"],
    `${path}.approvedFixed`,
  );
  const approvedCves = ["CVE-2026-21728", "CVE-2026-28377"] as const;
  if (
    approvedFixed.length !== 0 &&
    (approvedFixed.length !== 2 ||
      approvedCves.some((cve) => !approvedFixed.includes(cve)))
  )
    throw new PlatformConfigError(
      `${path}.approvedFixed`,
      "разрешены только два согласованных already-fixed Tempo findings или пустой набор",
    );
  const egressRepositories = stringArray(
    source["egressRepositories"],
    `${path}.egressRepositories`,
  );
  const expectedRepositories = [
    "ghcr.io/aquasecurity/trivy-db",
    "ghcr.io/aquasecurity/trivy-java-db",
  ] as const;
  if (
    egressRepositories.length !== expectedRepositories.length ||
    egressRepositories.some(
      (entry, index) => entry !== expectedRepositories[index],
    )
  ) {
    throw new PlatformConfigError(
      `${path}.egressRepositories`,
      "разрешены только официальные GHCR Trivy vulnerability DB registries",
    );
  }
  return Object.freeze({
    enabled: true,
    cpu: 2,
    memoryMiB: 2048,
    parallel: 1,
    minimumFreeDiskGiB: 20,
    maximumDatabaseAgeHours: 24,
    approvedFixed: Object.freeze([
      ...approvedFixed,
    ]) as SecurityScanVerificationConfig["approvedFixed"],
    egressRepositories: Object.freeze([
      ...expectedRepositories,
    ]) as unknown as SecurityScanVerificationConfig["egressRepositories"],
  });
}

function parseUnitCoverageVerification(
  value: unknown,
): UnitCoverageVerificationConfig {
  const path = "config.verification.unitCoverage";
  const source = record(value, path);
  exactKeys(source, ["thresholds", "criticalModules", "testFiles"], path);
  const thresholdSource = record(source["thresholds"], `${path}.thresholds`);
  exactKeys(
    thresholdSource,
    ["lines", "functions", "branches"],
    `${path}.thresholds`,
  );
  if (
    thresholdSource["lines"] !== 90 ||
    thresholdSource["functions"] !== 90 ||
    thresholdSource["branches"] !== 85
  )
    throw new PlatformConfigError(
      `${path}.thresholds`,
      "ожидаются нормативные floors 90/90/85 для lines/functions/branches",
    );
  if (!Array.isArray(source["criticalModules"]))
    throw new PlatformConfigError(
      `${path}.criticalModules`,
      "ожидался массив критических модулей",
    );
  const criticalModules = source["criticalModules"].map((entry, index) => {
    const modulePath = `${path}.criticalModules[${index}]`;
    const item = record(entry, modulePath);
    exactKeys(
      item,
      ["id", "sourceRoots", "coverageRoots", "format"],
      modulePath,
    );
    const id = stringValue(item["id"], `${modulePath}.id`);
    const expected = UNIT_COVERAGE_MODULES[index];
    const sourceRoots = stringArray(
      item["sourceRoots"],
      `${modulePath}.sourceRoots`,
    );
    const coverageRoots = stringArray(
      item["coverageRoots"],
      `${modulePath}.coverageRoots`,
    );
    if (sourceRoots.length === 0 || coverageRoots.length === 0)
      throw new PlatformConfigError(
        modulePath,
        "каждому модулю нужны source и coverage roots",
      );
    const format = item["format"];
    if (format !== "js" && format !== "mjs")
      throw new PlatformConfigError(
        `${modulePath}.format`,
        "ожидался js или mjs",
      );
    if (
      !expected ||
      id !== expected.id ||
      JSON.stringify(sourceRoots) !== JSON.stringify(expected.sourceRoots) ||
      JSON.stringify(coverageRoots) !==
        JSON.stringify(expected.coverageRoots) ||
      format !== expected.format
    )
      throw new PlatformConfigError(
        modulePath,
        "критический inventory имеет неверный порядок, состав или artifact mapping",
      );
    return Object.freeze({ id, sourceRoots, coverageRoots, format });
  });
  if (criticalModules.length !== UNIT_COVERAGE_MODULES.length)
    throw new PlatformConfigError(
      `${path}.criticalModules`,
      "неполный критический inventory",
    );
  const testFiles = stringArray(source["testFiles"], `${path}.testFiles`);
  if (
    testFiles.length !== UNIT_COVERAGE_TEST_FILE_COUNT ||
    new Set(testFiles).size !== testFiles.length ||
    testFiles.some(
      (file) =>
        !/^(?:(?:tests|packages)\/[a-z0-9-]+(?:\/[a-z0-9-]+)*\.test\.mjs|verification\/launch\/v1\/scenarios\/backup-restore\.test\.mjs)$/u.test(
          file,
        ),
    )
  )
    throw new PlatformConfigError(
      `${path}.testFiles`,
      `ожидается ровно ${UNIT_COVERAGE_TEST_FILE_COUNT} уникальных путей локальных .test.mjs файлов`,
    );
  return Object.freeze({
    thresholds: Object.freeze({ lines: 90, functions: 90, branches: 85 }),
    criticalModules: Object.freeze(criticalModules),
    testFiles,
  });
}

function exactStringArray<T extends string>(
  value: unknown,
  path: string,
  allowed: readonly T[],
): readonly T[] {
  const values = stringArray(value, path);
  const allowedSet = new Set<string>(allowed);
  if (new Set(values).size !== values.length)
    throw new PlatformConfigError(path, "массив не должен содержать дубликаты");
  for (const [index, entry] of values.entries()) {
    if (!allowedSet.has(entry))
      throw new PlatformConfigError(
        `${path}[${index}]`,
        "значение отсутствует в Kafka allowlist",
      );
  }
  return values as readonly T[];
}

function sameStrings(
  actual: readonly string[],
  expected: readonly string[],
  path: string,
): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new PlatformConfigError(
      path,
      `значения не совпадают с нормативной mapping: [${expected.join(", ")}]`,
    );
  }
}

const EXPECTED_KAFKA_PRODUCERS: Readonly<
  Record<RuntimeName, readonly KafkaTopicName[]>
> = {
  "edge-gateway": [],
  "api-public": [],
  "api-internal": [],
  "customer-service": [],
  "catalog-service": [],
  "catalog-supplier-sync": [],
  "catalog-activation-worker": [
    "coffee.catalog.snapshot.v1",
    "coffee.catalog.mapping.v2",
  ],
  "pricing-service": [],
  "orders-service": [
    "coffee.orders.lifecycle.v1",
    "coffee.aroma.cart.commands.v1",
    "coffee.realtime.invalidate.v1",
  ],
  "orders-aroma-preparation": [
    "coffee.aroma.cart.commands.v1",
    "coffee.realtime.invalidate.v1",
  ],
  "aroma-observer": ["coffee.aroma.cart.events.v1"],
  "aroma-convergence": [
    "coffee.aroma.cart.events.v1",
    "coffee.realtime.invalidate.v1",
  ],
  "aroma-gateway": [],
  "realtime-gateway": [],
};

const EXPECTED_KAFKA_CONSUMERS: Readonly<
  Record<RuntimeName, readonly KafkaConsumerConfig[]>
> = {
  "edge-gateway": [],
  "api-public": [],
  "api-internal": [],
  "customer-service": [],
  "catalog-service": [],
  "catalog-supplier-sync": [],
  "catalog-activation-worker": [],
  "pricing-service": [],
  "orders-service": [],
  "orders-aroma-preparation": [
    {
      groupId: "orders-catalog-mapping-v2",
      topics: ["coffee.catalog.mapping.v2"],
      processing: "durable",
    },
    {
      groupId: "orders-aroma-preparation-v1",
      topics: ["coffee.orders.lifecycle.v1"],
      processing: "durable",
    },
    {
      groupId: "orders-aroma-projection-v1",
      topics: ["coffee.aroma.cart.events.v1"],
      processing: "durable",
    },
  ],
  "aroma-observer": [],
  "aroma-convergence": [
    {
      groupId: "aroma-convergence-v1",
      topics: ["coffee.aroma.cart.commands.v1"],
      processing: "durable",
    },
  ],
  "aroma-gateway": [],
  "realtime-gateway": [
    {
      groupId: "realtime-gateway-v1",
      topics: ["coffee.realtime.invalidate.v1"],
      processing: "realtime",
    },
  ],
};

function opaqueObject(
  value: unknown,
  path: string,
): Readonly<Record<string, unknown>> {
  return Object.freeze({ ...record(value, path) });
}

function aromaConfig(value: unknown, path: string): AromaConfig {
  const aroma = record(value, path);
  exactKeys(
    aroma,
    ["supplierRef", "scopeRef", "origin", "redirectsAllowed", "defaultPacking"],
    path,
  );
  if (aroma["supplierRef"] !== AROMA_SUPPLIER_REF)
    throw new PlatformConfigError(
      `${path}.supplierRef`,
      `ожидался supplierRef ${AROMA_SUPPLIER_REF}`,
    );
  if (aroma["scopeRef"] !== AROMA_SCOPE_REF)
    throw new PlatformConfigError(
      `${path}.scopeRef`,
      `ожидался scopeRef ${AROMA_SCOPE_REF}`,
    );
  const origin = record(aroma["origin"], `${path}.origin`);
  exactKeys(origin, ["scheme", "host", "port"], `${path}.origin`);
  if (
    origin["scheme"] !== "https" ||
    origin["host"] !== "aromateacoffee.ru" ||
    origin["port"] !== 443
  )
    throw new PlatformConfigError(
      `${path}.origin`,
      "origin не совпадает с каноническим AROMA origin",
    );
  if (aroma["redirectsAllowed"] !== false)
    throw new PlatformConfigError(
      `${path}.redirectsAllowed`,
      "redirectsAllowed должен быть false",
    );
  if (aroma["defaultPacking"] !== AROMA_DEFAULT_PACKING)
    throw new PlatformConfigError(
      `${path}.defaultPacking`,
      `ожидался defaultPacking ${AROMA_DEFAULT_PACKING}`,
    );
  return Object.freeze({
    supplierRef: AROMA_SUPPLIER_REF,
    scopeRef: AROMA_SCOPE_REF,
    origin: Object.freeze({
      scheme: "https",
      host: "aromateacoffee.ru",
      port: 443,
    }),
    redirectsAllowed: false,
    defaultPacking: AROMA_DEFAULT_PACKING,
  });
}

function healthConfig(value: unknown, path: string): HealthConfig {
  const health = record(value, path);
  exactKeys(
    health,
    [
      "livePath",
      "readyPath",
      "metricsPath",
      "intervalMs",
      "timeoutMs",
      "startupGraceMs",
      "failureThreshold",
      "successThreshold",
    ],
    path,
  );
  return Object.freeze({
    livePath: stringValue(health["livePath"], `${path}.livePath`),
    readyPath: stringValue(health["readyPath"], `${path}.readyPath`),
    metricsPath: stringValue(health["metricsPath"], `${path}.metricsPath`),
    intervalMs: integerValue(health["intervalMs"], `${path}.intervalMs`),
    timeoutMs: integerValue(health["timeoutMs"], `${path}.timeoutMs`),
    startupGraceMs: integerValue(
      health["startupGraceMs"],
      `${path}.startupGraceMs`,
    ),
    failureThreshold: integerValue(
      health["failureThreshold"],
      `${path}.failureThreshold`,
    ),
    successThreshold: integerValue(
      health["successThreshold"],
      `${path}.successThreshold`,
    ),
  });
}

function kafkaConsumerConfig(
  value: unknown,
  path: string,
): KafkaConsumerConfig {
  const consumer = record(value, path);
  exactKeys(consumer, ["groupId", "topics", "processing"], path);
  const groupId = stringValue(consumer["groupId"], `${path}.groupId`);
  const topicValues = exactStringArray(
    consumer["topics"],
    `${path}.topics`,
    KAFKA_TOPIC_NAMES,
  );
  if (topicValues.length === 0)
    throw new PlatformConfigError(
      `${path}.topics`,
      "consumer должен иметь хотя бы один topic",
    );
  if (!(KAFKA_GROUP_IDS as readonly string[]).includes(groupId))
    throw new PlatformConfigError(
      `${path}.groupId`,
      "значение отсутствует в Kafka group allowlist",
    );
  const processing = consumer["processing"];
  if (processing !== "durable" && processing !== "realtime")
    throw new PlatformConfigError(
      `${path}.processing`,
      "неизвестный processing mode",
    );
  return Object.freeze({
    groupId: groupId as KafkaGroupId,
    topics: topicValues,
    processing,
  });
}

export function validateKafkaServiceConfig(
  value: unknown,
  runtime: RuntimeName,
  path = "config.service.kafka",
): KafkaServiceConfig {
  const kafka = record(value, path);
  exactKeys(kafka, ["producers", "consumers"], path);
  const producers = exactStringArray(
    kafka["producers"],
    `${path}.producers`,
    KAFKA_TOPIC_NAMES,
  );
  const consumersValue = kafka["consumers"];
  if (!Array.isArray(consumersValue))
    throw new PlatformConfigError(
      `${path}.consumers`,
      "ожидался массив consumers",
    );
  const consumers = consumersValue.map((consumer, index) =>
    kafkaConsumerConfig(consumer, `${path}.consumers[${index}]`),
  );
  const expectedProducers = EXPECTED_KAFKA_PRODUCERS[runtime];
  sameStrings(producers, expectedProducers, `${path}.producers`);
  if (
    JSON.stringify(consumers) !==
    JSON.stringify(EXPECTED_KAFKA_CONSUMERS[runtime])
  ) {
    throw new PlatformConfigError(
      `${path}.consumers`,
      `mapping не совпадает с нормативной конфигурацией runtime ${runtime}`,
    );
  }
  for (const consumer of consumers) {
    if (
      consumer.processing === "realtime" &&
      (runtime !== "realtime-gateway" ||
        consumer.groupId !== "realtime-gateway-v1" ||
        JSON.stringify(consumer.topics) !==
          JSON.stringify(["coffee.realtime.invalidate.v1"]))
    ) {
      throw new PlatformConfigError(
        `${path}.consumers`,
        "processing=realtime разрешён только realtime-gateway/realtime-invalidate/realtime-gateway-v1",
      );
    }
  }
  return Object.freeze({ producers, consumers });
}

function kafkaTopicConfig(
  value: unknown,
  path: string,
  expectedName: KafkaTopicName,
): KafkaTopicConfig {
  const topic = record(value, path);
  exactKeys(topic, ["name", "partitions", "retentionHours", "dlq"], path);
  const name = stringValue(topic["name"], `${path}.name`);
  if (name !== expectedName)
    throw new PlatformConfigError(
      `${path}.name`,
      `ожидался topic ${expectedName}`,
    );
  const partitions = positiveIntegerValue(
    topic["partitions"],
    `${path}.partitions`,
  );
  const retentionHours = positiveIntegerValue(
    topic["retentionHours"],
    `${path}.retentionHours`,
  );
  const dlq = stringValue(topic["dlq"], `${path}.dlq`);
  if (dlq !== `${name}.dlq`)
    throw new PlatformConfigError(`${path}.dlq`, `ожидался DLQ ${name}.dlq`);
  return Object.freeze({ name, partitions, retentionHours, dlq });
}

function kafkaDeliveryConfig(
  value: unknown,
  path: string,
): KafkaDeliveryConfig {
  const delivery = record(value, path);
  exactKeys(
    delivery,
    [
      "producerRetries",
      "maxMessageBytes",
      "maxPartitions",
      "maxInFlight",
      "queueCapacity",
      "sendTimeoutMs",
      "receiveTimeoutMs",
      "commitTimeoutMs",
      "revokeTimeoutMs",
      "shutdownTimeoutMs",
      "leaseMs",
      "retry",
      "quarantine",
    ],
    path,
  );
  const expected = {
    producerRetries: 3,
    maxMessageBytes: 1048576,
    maxPartitions: 24,
    maxInFlight: 4,
    queueCapacity: 32,
    sendTimeoutMs: 2000,
    receiveTimeoutMs: 1000,
    commitTimeoutMs: 2000,
    revokeTimeoutMs: 2000,
    shutdownTimeoutMs: 5000,
    leaseMs: 30000,
  } as const;
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (delivery[key] !== expectedValue)
      throw new PlatformConfigError(
        `${path}.${key}`,
        `ожидалось фиксированное значение ${expectedValue}`,
      );
  }
  const retry = record(delivery["retry"], `${path}.retry`);
  exactKeys(retry, ["baseMs", "maxMs", "maxAttempts"], `${path}.retry`);
  if (
    retry["baseMs"] !== 1000 ||
    retry["maxMs"] !== 60000 ||
    retry["maxAttempts"] !== 12
  )
    throw new PlatformConfigError(
      `${path}.retry`,
      "retry policy не совпадает с launch policy",
    );
  const quarantine = record(delivery["quarantine"], `${path}.quarantine`);
  exactKeys(quarantine, ["durable", "realtime"], `${path}.quarantine`);
  if (
    quarantine["durable"] !== "owner-database" ||
    quarantine["realtime"] !== "topic-dlq"
  )
    throw new PlatformConfigError(
      `${path}.quarantine`,
      "разрешены только owner-database для durable и topic-dlq для realtime",
    );
  return Object.freeze({
    ...expected,
    retry: Object.freeze({ baseMs: 1000, maxMs: 60000, maxAttempts: 12 }),
    quarantine: Object.freeze({
      durable: "owner-database",
      realtime: "topic-dlq",
    }),
  });
}

export function parseKafkaConfig(
  value: unknown,
  path = "config.kafka",
): KafkaConfig {
  const kafka = record(value, path);
  exactKeys(
    kafka,
    ["brokers", "clientProtocol", "autoTopicCreation", "topics", "delivery"],
    path,
  );
  const brokers = exactStringArray(kafka["brokers"], `${path}.brokers`, [
    "kafka:9092",
  ]);
  if (kafka["clientProtocol"] !== "SASL_SSL")
    throw new PlatformConfigError(
      `${path}.clientProtocol`,
      "поддерживается только SASL_SSL",
    );
  if (kafka["autoTopicCreation"] !== false)
    throw new PlatformConfigError(
      `${path}.autoTopicCreation`,
      "auto topic creation должен быть выключен",
    );
  const topicsRecord = record(kafka["topics"], `${path}.topics`);
  const topics = Object.fromEntries(
    KAFKA_TOPIC_NAMES.map((name) => {
      const aliases: Record<KafkaTopicName, KafkaTopicKey> = {
        "coffee.catalog.snapshot.v1": "catalogSnapshot",
        "coffee.catalog.mapping.v2": "catalogMapping",
        "coffee.orders.lifecycle.v1": "ordersLifecycle",
        "coffee.aroma.cart.commands.v1": "aromaCommands",
        "coffee.aroma.cart.events.v1": "aromaEvents",
        "coffee.realtime.invalidate.v1": "realtimeInvalidate",
      };
      const property = aliases[name];
      return [
        property,
        kafkaTopicConfig(
          topicsRecord[property],
          `${path}.topics.${property}`,
          name,
        ),
      ];
    }),
  ) as Record<KafkaTopicKey, KafkaTopicConfig>;
  exactKeys(
    topicsRecord,
    [
      "catalogSnapshot",
      "catalogMapping",
      "ordersLifecycle",
      "aromaCommands",
      "aromaEvents",
      "realtimeInvalidate",
    ],
    `${path}.topics`,
  );
  return Object.freeze({
    brokers,
    clientProtocol: "SASL_SSL",
    autoTopicCreation: false,
    topics: Object.freeze(topics),
    delivery: kafkaDeliveryConfig(kafka["delivery"], `${path}.delivery`),
  });
}

function databasePoolConfig(
  value: unknown,
  path: string,
  shutdownGraceMs: number,
): DatabasePoolConfig | null {
  if (value === null) return null;
  const pool = record(value, path);
  exactKeys(
    pool,
    [
      "max",
      "checkoutTimeoutMs",
      "lockTimeoutMs",
      "interactiveStatementTimeoutMs",
      "backgroundStatementTimeoutMs",
      "terminalTimeoutMs",
      "transactionTimeoutMs",
      "idleTimeoutMs",
      "maxLifetimeMs",
    ],
    path,
    ["maxWaiting"],
  );
  const terminalTimeoutMs = positiveIntegerValue(
    pool["terminalTimeoutMs"],
    `${path}.terminalTimeoutMs`,
  );
  const transactionTimeoutMs = positiveIntegerValue(
    pool["transactionTimeoutMs"],
    `${path}.transactionTimeoutMs`,
  );
  if (
    terminalTimeoutMs >= shutdownGraceMs ||
    transactionTimeoutMs >= shutdownGraceMs
  ) {
    throw new PlatformConfigError(
      path,
      "DB timeout должен быть меньше platform.shutdownGraceMs",
    );
  }
  return Object.freeze({
    max: integerValue(pool["max"], `${path}.max`),
    maxWaiting: Object.hasOwn(pool, "maxWaiting")
      ? integerValue(pool["maxWaiting"], `${path}.maxWaiting`)
      : 0,
    checkoutTimeoutMs: integerValue(
      pool["checkoutTimeoutMs"],
      `${path}.checkoutTimeoutMs`,
    ),
    lockTimeoutMs: integerValue(pool["lockTimeoutMs"], `${path}.lockTimeoutMs`),
    interactiveStatementTimeoutMs: integerValue(
      pool["interactiveStatementTimeoutMs"],
      `${path}.interactiveStatementTimeoutMs`,
    ),
    backgroundStatementTimeoutMs: integerValue(
      pool["backgroundStatementTimeoutMs"],
      `${path}.backgroundStatementTimeoutMs`,
    ),
    terminalTimeoutMs,
    transactionTimeoutMs,
    idleTimeoutMs: integerValue(pool["idleTimeoutMs"], `${path}.idleTimeoutMs`),
    maxLifetimeMs: integerValue(pool["maxLifetimeMs"], `${path}.maxLifetimeMs`),
  });
}

function deadlineProfiles(
  value: unknown,
  path: string,
): Readonly<Record<string, number | null>> {
  const profiles = record(value, path);
  const allowed = new Set(["defaultMs", "readMs", "cartMs", "mutationMs"]);
  for (const name of Object.keys(profiles))
    if (!allowed.has(name))
      throw new PlatformConfigError(
        `${path}.${name}`,
        "неизвестный deadline profile",
      );
  if (!Object.hasOwn(profiles, "defaultMs"))
    throw new PlatformConfigError(
      `${path}.defaultMs`,
      "обязательное значение отсутствует",
    );
  const result: Record<string, number | null> = {};
  for (const [name, deadline] of Object.entries(profiles))
    result[name] = nullableIntegerValue(deadline, `${path}.${name}`);
  return Object.freeze(result);
}

function aromaSettings<T extends string>(
  value: unknown,
  path: string,
  names: readonly T[],
): Readonly<Record<T, number>> {
  const source = record(value, path);
  exactKeys(source, names, path);
  const result = {} as Record<T, number>;
  for (const name of names) {
    const setting = positiveIntegerValue(source[name], `${path}.${name}`);
    if (name === "maxResponseBytes" && setting !== 2_097_152)
      throw new PlatformConfigError(
        `${path}.${name}`,
        "допустим только лимит ответа 2 MiB",
      );
    const maximum =
      name === "maxResponseBytes"
        ? 2_097_152
        : name === "maxLines" || name === "maxOrders"
          ? 10_000
          : name === "batchSize"
            ? 1000
            : 300_000;
    if (setting > maximum)
      throw new PlatformConfigError(
        `${path}.${name}`,
        "значение превышает допустимый предел",
      );
    result[name] = setting;
  }
  return Object.freeze(result);
}

function realtimeSettings(value: unknown, path: string): RealtimeConfig {
  const source = record(value, path);
  const maxima: RealtimeConfig = {
    shutdownGraceMs: 20000,
    maxConnections: 512,
    queueMaxRecords: 64,
    queueMaxBytes: 262144,
    totalQueueMaxRecords: 262144,
    totalQueueMaxBytes: 67108864,
    ringMaxRecords: 10000,
    ringMaxBytes: 16777216,
    ringMaxAgeMs: 300000,
    coalesceMs: 250,
    writeTimeoutMs: 5000,
    heartbeatMs: 15000,
    authCheckMs: 30000,
    maxEventDataBytes: 2048,
    rssBudgetBytes: 536870912,
    fdBudget: 12288,
  };
  exactKeys(source, Object.keys(maxima), path);
  const result = {} as Record<keyof RealtimeConfig, number>;
  for (const name of Object.keys(maxima) as (keyof RealtimeConfig)[]) {
    const setting = positiveIntegerValue(source[name], `${path}.${name}`);
    if (setting > maxima[name])
      throw new PlatformConfigError(
        `${path}.${name}`,
        "значение превышает предел первого запуска",
      );
    result[name] = setting;
  }
  if (
    result.totalQueueMaxRecords < result.queueMaxRecords ||
    result.totalQueueMaxBytes < result.queueMaxBytes ||
    result.totalQueueMaxBytes + result.ringMaxBytes >
      result.rssBudgetBytes / 4 ||
    result.fdBudget < result.maxConnections + 64
  )
    throw new PlatformConfigError(
      path,
      "совокупные queue/ring/RSS/FD бюджеты не оставляют ресурсный запас",
    );
  return Object.freeze(result);
}

function runtimeConfig(
  value: unknown,
  path: string,
  shutdownGraceMs: number,
  runtime: RuntimeName,
): RuntimeConfig {
  const source = record(value, path);
  exactKeys(
    source,
    [
      "transportMode",
      "listen",
      "health",
      "deadlineMs",
      "deadlineProfiles",
      "concurrency",
      "replicas",
      "dbPool",
      "database",
      "kafka",
      "outbound",
      "secretRefs",
      "permissions",
      "mutationCapability",
    ],
    path,
    [
      "optionalSecretRefs",
      "scheduler",
      "catalogSnapshotProof",
      "mutationsEnabled",
      "aromaPreparation",
      "aromaObservation",
      "aromaConvergence",
      "realtime",
    ],
  );
  if (
    runtime !== "catalog-service" &&
    Object.hasOwn(source, "catalogSnapshotProof")
  )
    throw new PlatformConfigError(
      `${path}.catalogSnapshotProof`,
      "настройка разрешена только для catalog-service",
    );
  let catalogSnapshotProof: CatalogSnapshotProofConfig | undefined;
  if (source["catalogSnapshotProof"] !== undefined) {
    const configured = record(
      source["catalogSnapshotProof"],
      `${path}.catalogSnapshotProof`,
    );
    exactKeys(configured, ["maxAgeMs"], `${path}.catalogSnapshotProof`);
    catalogSnapshotProof = Object.freeze({
      maxAgeMs: positiveIntegerValue(
        configured["maxAgeMs"],
        `${path}.catalogSnapshotProof.maxAgeMs`,
      ),
    });
  }
  const owners = {
    mutationsEnabled: "aroma-convergence",
    aromaPreparation: "orders-aroma-preparation",
    aromaObservation: "aroma-observer",
    aromaConvergence: "aroma-convergence",
    realtime: "realtime-gateway",
  } as const;
  for (const [property, owner] of Object.entries(owners)) {
    if (runtime === owner && source[property] === undefined)
      throw new PlatformConfigError(
        `${path}.${property}`,
        "обязательное значение отсутствует",
      );
    if (runtime !== owner && Object.hasOwn(source, property))
      throw new PlatformConfigError(
        `${path}.${property}`,
        "настройка запрещена для этой роли",
      );
  }
  if (
    runtime === "aroma-convergence" &&
    typeof source["mutationsEnabled"] !== "boolean"
  )
    throw new PlatformConfigError(
      `${path}.mutationsEnabled`,
      "ожидался explicit boolean",
    );
  const aromaPreparation =
    runtime === "orders-aroma-preparation"
      ? aromaSettings(source["aromaPreparation"], `${path}.aromaPreparation`, [
          "pollIntervalMs",
          "batchSize",
          "maxOrders",
          "maxLines",
        ])
      : undefined;
  const aromaObservation =
    runtime === "aroma-observer"
      ? aromaSettings(source["aromaObservation"], `${path}.aromaObservation`, [
          "pollIntervalMs",
          "intervalMs",
          "leaseMs",
          "maxSnapshotAgeMs",
          "maxLines",
          "maxResponseBytes",
        ])
      : undefined;
  const aromaConvergence =
    runtime === "aroma-convergence"
      ? aromaSettings(source["aromaConvergence"], `${path}.aromaConvergence`, [
          "pollIntervalMs",
          "leaseMs",
          "heartbeatIntervalMs",
          "providerDeadlineMs",
          "safetyMarginMs",
          "retryBackoffMs",
          "maxSnapshotAgeMs",
          "maxLines",
          "maxResponseBytes",
        ])
      : undefined;
  const realtime =
    runtime === "realtime-gateway"
      ? realtimeSettings(source["realtime"], `${path}.realtime`)
      : undefined;
  if (
    realtime !== undefined &&
    (source["replicas"] !== 1 ||
      source["database"] !== null ||
      source["dbPool"] !== null ||
      source["concurrency"] !== realtime.maxConnections ||
      source["mutationCapability"] !== false)
  )
    throw new PlatformConfigError(
      path,
      "realtime требует одну stateless replica и согласованный admission budget",
    );
  if (realtime !== undefined) {
    const refs = stringArray(source["secretRefs"], `${path}.secretRefs`);
    if (
      !refs.includes("security.actorContextEdgeVerificationPublicKeys") ||
      refs.some((ref) => /SigningPrivateKey|^postgres\./u.test(ref))
    )
      throw new PlatformConfigError(
        `${path}.secretRefs`,
        "realtime получает только scoped public actor verifier, не signing/DB material",
      );
  }
  if (
    aromaObservation !== undefined &&
    aromaObservation.leaseMs <= Number(source["deadlineMs"])
  )
    throw new PlatformConfigError(
      `${path}.aromaObservation.leaseMs`,
      "lease должен покрывать deadline чтения",
    );
  if (
    aromaConvergence !== undefined &&
    (aromaConvergence.leaseMs !== 30_000 ||
      aromaConvergence.heartbeatIntervalMs !== 10_000 ||
      aromaConvergence.leaseMs <=
        aromaConvergence.providerDeadlineMs + aromaConvergence.safetyMarginMs ||
      aromaConvergence.heartbeatIntervalMs * 2 >= aromaConvergence.leaseMs ||
      aromaConvergence.providerDeadlineMs > Number(source["deadlineMs"]))
  )
    throw new PlatformConfigError(
      `${path}.aromaConvergence`,
      "lease/heartbeat/provider deadline не образуют безопасное окно",
    );
  const schedulerValue = source["scheduler"];
  if (runtime === "catalog-supplier-sync" && schedulerValue === undefined)
    throw new PlatformConfigError(
      `${path}.scheduler`,
      "scheduler обязателен для catalog-supplier-sync",
    );
  if (runtime !== "catalog-supplier-sync" && schedulerValue !== undefined)
    throw new PlatformConfigError(
      `${path}.scheduler`,
      "scheduler разрешён только catalog-supplier-sync",
    );
  let scheduler: CatalogSchedulerConfig | null = null;
  if (schedulerValue !== undefined) {
    const configured = record(schedulerValue, `${path}.scheduler`);
    exactKeys(
      configured,
      ["intervalMs", "startupImport", "overlapPolicy"],
      `${path}.scheduler`,
    );
    if (
      configured["intervalMs"] !== 3_600_000 ||
      configured["startupImport"] !== true ||
      configured["overlapPolicy"] !== "skip"
    )
      throw new PlatformConfigError(
        `${path}.scheduler`,
        "ожидался hourly single-flight skip scheduler",
      );
    scheduler = Object.freeze({
      intervalMs: 3_600_000,
      startupImport: true,
      overlapPolicy: "skip",
    });
  }
  const listen = record(source["listen"], `${path}.listen`);
  exactKeys(listen, ["host", "port"], `${path}.listen`);
  const transportMode = source["transportMode"];
  if (transportMode !== "public-tls" && transportMode !== "mtls")
    throw new PlatformConfigError(
      `${path}.transportMode`,
      "неизвестный режим TLS",
    );
  const database =
    source["database"] === null
      ? null
      : stringValue(source["database"], `${path}.database`);

  const kafka = validateKafkaServiceConfig(
    source["kafka"],
    runtime,
    `${path}.kafka`,
  );

  const permissions = record(source["permissions"], `${path}.permissions`);
  exactKeys(
    permissions,
    ["manifest", "net", "fsRead", "fsWrite", "childProcess", "workers"],
    `${path}.permissions`,
  );
  if (typeof permissions["childProcess"] !== "boolean")
    throw new PlatformConfigError(
      `${path}.permissions.childProcess`,
      "ожидался boolean",
    );
  if (typeof permissions["workers"] !== "boolean")
    throw new PlatformConfigError(
      `${path}.permissions.workers`,
      "ожидался boolean",
    );
  if (typeof source["mutationCapability"] !== "boolean")
    throw new PlatformConfigError(
      `${path}.mutationCapability`,
      "ожидался boolean",
    );
  const dbPool = databasePoolConfig(
    source["dbPool"],
    `${path}.dbPool`,
    shutdownGraceMs,
  );
  if (
    dbPool !== null &&
    ((dbPool.maxWaiting ?? 0) > 100 ||
      (runtime !== "orders-service" && (dbPool.maxWaiting ?? 0) > 0))
  )
    throw new PlatformConfigError(
      `${path}.dbPool.maxWaiting`,
      "очередь до 100 разрешена только для orders-service",
    );
  return Object.freeze({
    transportMode,
    listen: Object.freeze({
      host: stringValue(listen["host"], `${path}.listen.host`),
      port: integerValue(listen["port"], `${path}.listen.port`),
    }),
    health: healthConfig(source["health"], `${path}.health`),
    deadlineMs: nullableIntegerValue(
      source["deadlineMs"],
      `${path}.deadlineMs`,
    ),
    deadlineProfiles: deadlineProfiles(
      source["deadlineProfiles"],
      `${path}.deadlineProfiles`,
    ),
    concurrency: integerValue(source["concurrency"], `${path}.concurrency`),
    replicas: positiveIntegerValue(source["replicas"], `${path}.replicas`),
    dbPool,
    database,
    secretRefs: stringArray(source["secretRefs"], `${path}.secretRefs`),
    optionalSecretRefs: stringArray(
      source["optionalSecretRefs"] ?? [],
      `${path}.optionalSecretRefs`,
    ),
    outbound: stringArray(source["outbound"], `${path}.outbound`),
    kafka,
    permissions: Object.freeze({
      manifest: stringValue(
        permissions["manifest"],
        `${path}.permissions.manifest`,
      ),
      net: stringArray(permissions["net"], `${path}.permissions.net`),
      fsRead: stringArray(permissions["fsRead"], `${path}.permissions.fsRead`),
      fsWrite: stringArray(
        permissions["fsWrite"],
        `${path}.permissions.fsWrite`,
      ),
      childProcess: permissions["childProcess"],
      workers: permissions["workers"],
    }),
    mutationCapability: source["mutationCapability"],
    scheduler,
    ...(catalogSnapshotProof === undefined ? {} : { catalogSnapshotProof }),
    ...(runtime === "aroma-convergence"
      ? { mutationsEnabled: source["mutationsEnabled"] as boolean }
      : {}),
    ...(aromaPreparation === undefined ? {} : { aromaPreparation }),
    ...(aromaObservation === undefined ? {} : { aromaObservation }),
    ...(aromaConvergence === undefined ? {} : { aromaConvergence }),
    ...(realtime === undefined ? {} : { realtime }),
  });
}

function postgresConfig(
  value: unknown,
  path: string,
  environment: EnvironmentName,
  databaseIsolationEnabled: boolean,
): PostgresConfig {
  const postgres = record(value, path);
  exactKeys(
    postgres,
    [
      "host",
      "bootstrapUsername",
      "port",
      "sslMode",
      "maxConnections",
      "reservedConnections",
      "rolloutReplicas",
    ],
    path,
  );
  const sslMode = postgres["sslMode"];
  if (
    sslMode !== "prefer" &&
    sslMode !== "require" &&
    sslMode !== "verify-full"
  ) {
    throw new PlatformConfigError(`${path}.sslMode`, "неизвестный sslMode");
  }
  const rolloutReplicas = positiveIntegerValue(
    postgres["rolloutReplicas"],
    `${path}.rolloutReplicas`,
  );
  if (rolloutReplicas !== 1) {
    throw new PlatformConfigError(
      `${path}.rolloutReplicas`,
      "первый запуск разрешает только одну serial rollout replica",
    );
  }
  const host = stringValue(postgres["host"], `${path}.host`);
  const bootstrapUsername = stringValue(
    postgres["bootstrapUsername"],
    `${path}.bootstrapUsername`,
  );
  if (bootstrapUsername !== "coffeeuser")
    throw new PlatformConfigError(
      `${path}.bootstrapUsername`,
      "canonical bootstrap LOGIN must be coffeeuser",
    );
  if (host !== "coffee_postgres") {
    if (!/^\/dev\/shm\/coffee-g17-[a-f0-9]{16,64}$/u.test(host))
      throw new PlatformConfigError(
        `${path}.host`,
        "разрешён только canonical endpoint или private G17 Unix socket path",
      );
    if (environment === "production" || !databaseIsolationEnabled)
      throw new PlatformConfigError(
        `${path}.host`,
        "G17 Unix socket разрешён только вне production при включённой database isolation",
      );
  }
  return Object.freeze({
    host,
    bootstrapUsername,
    port: positiveIntegerValue(postgres["port"], `${path}.port`),
    sslMode,
    maxConnections: positiveIntegerValue(
      postgres["maxConnections"],
      `${path}.maxConnections`,
    ),
    reservedConnections: positiveIntegerValue(
      postgres["reservedConnections"],
      `${path}.reservedConnections`,
    ),
    rolloutReplicas,
  });
}

function checkedSum(left: number, right: number, path: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result))
    throw new PlatformConfigError(
      path,
      "budget выходит за пределы safe integer",
    );
  return result;
}

export function calculateDatabaseAdmissionBudget(
  input: DatabaseAdmissionInput,
): DatabaseAdmissionBudget {
  if (
    input === null ||
    typeof input !== "object" ||
    input.postgres === null ||
    typeof input.postgres !== "object"
  ) {
    throw new PlatformConfigError(
      "config",
      "database admission input должен быть объектом",
    );
  }
  if (
    input.services === null ||
    typeof input.services !== "object" ||
    Array.isArray(input.services)
  ) {
    throw new PlatformConfigError(
      "config.services",
      "database admission services должен быть объектом",
    );
  }
  if (
    !Number.isSafeInteger(input.postgres.maxConnections) ||
    input.postgres.maxConnections < 1
  ) {
    throw new PlatformConfigError(
      "config.postgres.maxConnections",
      "ожидалось положительное целое число",
    );
  }
  if (
    !Number.isSafeInteger(input.postgres.reservedConnections) ||
    input.postgres.reservedConnections < 0
  ) {
    throw new PlatformConfigError(
      "config.postgres.reservedConnections",
      "ожидалось целое неотрицательное число",
    );
  }
  const identityPoolMax =
    input.localIdentity === undefined
      ? 0
      : positiveIntegerValue(
          input.localIdentity["databasePoolMax"],
          "config.localIdentity.databasePoolMax",
        );
  let steadyConnections = identityPoolMax;
  let largestPool = identityPoolMax;
  for (const [runtime, service] of Object.entries(input.services)) {
    if (service === null || typeof service !== "object") {
      throw new PlatformConfigError(
        `config.services.${runtime}`,
        "runtime должен быть объектом",
      );
    }
    if (
      !Object.hasOwn(service, "replicas") ||
      !Object.hasOwn(service, "dbPool") ||
      !Object.hasOwn(service, "database")
    ) {
      throw new PlatformConfigError(
        `config.services.${runtime}`,
        "replicas, database и dbPool обязательны для admission",
      );
    }
    const hasDbPool = service.dbPool !== null && service.dbPool !== undefined;
    const hasDatabase =
      service.database !== null && service.database !== undefined;
    if (hasDbPool !== hasDatabase) {
      throw new PlatformConfigError(
        `config.services.${runtime}`,
        "database и dbPool должны быть заданы одновременно",
      );
    }
    if (!hasDbPool) continue;
    if (!Number.isSafeInteger(service.replicas) || service.replicas < 1) {
      throw new PlatformConfigError(
        `config.services.${runtime}.replicas`,
        "ожидалось положительное целое число",
      );
    }
    if (!Number.isSafeInteger(service.dbPool.max) || service.dbPool.max < 1) {
      throw new PlatformConfigError(
        `config.services.${runtime}.dbPool.max`,
        "ожидалось положительное целое число",
      );
    }
    steadyConnections = checkedSum(
      steadyConnections,
      service.replicas * service.dbPool.max,
      `config.services.${runtime}`,
    );
    largestPool = Math.max(largestPool, service.dbPool.max);
  }
  if (
    !Number.isSafeInteger(input.postgres.rolloutReplicas) ||
    input.postgres.rolloutReplicas < 1
  ) {
    throw new PlatformConfigError(
      "config.postgres.rolloutReplicas",
      "ожидалось положительное целое число",
    );
  }
  const rolloutConnections = largestPool * input.postgres.rolloutReplicas;
  if (!Number.isSafeInteger(rolloutConnections)) {
    throw new PlatformConfigError(
      "config.postgres.rolloutReplicas",
      "rollout budget выходит за пределы safe integer",
    );
  }
  const requiredConnections = checkedSum(
    checkedSum(steadyConnections, rolloutConnections, "config.postgres"),
    input.postgres.reservedConnections,
    "config.postgres",
  );
  return Object.freeze({
    steadyConnections,
    rolloutConnections,
    reservedConnections: input.postgres.reservedConnections,
    requiredConnections,
    maxConnections: input.postgres.maxConnections,
    largestPool,
  });
}

export function assertDatabaseAdmissionBudget(
  input: DatabaseAdmissionInput,
): DatabaseAdmissionBudget {
  const budget = calculateDatabaseAdmissionBudget(input);
  if (budget.requiredConnections > budget.maxConnections) {
    throw new PlatformConfigError(
      "config.postgres",
      `DB admission budget ${budget.requiredConnections} exceeds maxConnections ${budget.maxConnections} (steady=${budget.steadyConnections}, rollout=${budget.rolloutConnections}, reserve=${budget.reservedConnections})`,
    );
  }
  return budget;
}

function browserOidcProfile(
  value: unknown,
  path: string,
): BrowserOidcProfile | null {
  if (value === null) return null;
  const source = record(value, path);
  exactKeys(
    source,
    [
      "issuer",
      "clientId",
      "authorizationUrl",
      "tokenUrl",
      "jwksUrl",
      "redirectUri",
      "allowedAlgorithms",
      "actorRefClaim",
      "permissionsClaim",
    ],
    path,
  );
  const algorithms = stringArray(
    source["allowedAlgorithms"],
    `${path}.allowedAlgorithms`,
  );
  if (algorithms.length !== 1 || algorithms[0] !== "RS256")
    throw new PlatformConfigError(
      `${path}.allowedAlgorithms`,
      "разрешён только RS256",
    );
  return Object.freeze({
    issuer: stringValue(source["issuer"], `${path}.issuer`),
    clientId: stringValue(source["clientId"], `${path}.clientId`),
    authorizationUrl: stringValue(
      source["authorizationUrl"],
      `${path}.authorizationUrl`,
    ),
    tokenUrl: stringValue(source["tokenUrl"], `${path}.tokenUrl`),
    jwksUrl: stringValue(source["jwksUrl"], `${path}.jwksUrl`),
    redirectUri: stringValue(source["redirectUri"], `${path}.redirectUri`),
    allowedAlgorithms: ["RS256"] as const,
    actorRefClaim: stringValue(
      source["actorRefClaim"],
      `${path}.actorRefClaim`,
    ),
    permissionsClaim: stringValue(
      source["permissionsClaim"],
      `${path}.permissionsClaim`,
    ),
  });
}

function telemetryConfig(value: unknown): TelemetryConfig {
  const path = "config.telemetry";
  const source = record(value, path);
  exactKeys(
    source,
    [
      "namespace",
      "releaseDigest",
      "nginxStatusEndpoint",
      "collector",
      "producer",
      "logging",
      "diskWatermarkPercent",
      "externalReportingEnabled",
      "grafana",
      "loki",
      "prometheus",
      "tempo",
      "alerts",
    ],
    path,
  );
  const collector = record(source["collector"], `${path}.collector`);
  exactKeys(
    collector,
    [
      "otlpEndpoint",
      "healthEndpoint",
      "memoryLimitMiB",
      "memorySpikeMiB",
      "containerMemoryMiB",
      "memoryCheckIntervalMs",
      "batchSize",
      "batchTimeoutMs",
      "queueCapacity",
      "queueConsumers",
      "exportTimeoutMs",
      "retryInitialMs",
      "retryMaxMs",
      "retryWindowMs",
      "maxLogRecordBytes",
    ],
    `${path}.collector`,
  );
  const producer = record(source["producer"], `${path}.producer`);
  exactKeys(
    producer,
    [
      "queueCapacity",
      "maxRecordBytes",
      "batchSize",
      "batchIntervalMs",
      "exportTimeoutMs",
      "diagnosticIntervalMs",
      "flushTimeoutMs",
    ],
    `${path}.producer`,
  );
  const logging = record(source["logging"], `${path}.logging`);
  exactKeys(logging, ["maxSizeMiB", "maxFiles"], `${path}.logging`);
  const alerts = record(source["alerts"], `${path}.alerts`);
  exactKeys(
    alerts,
    [
      "version",
      "evaluationIntervalMs",
      "notificationEndpoint",
      "diskUsage",
      "sinkMemoryMiB",
      "notReady",
      "consumerLag",
      "outboxOldestAge",
      "unknownOutcome",
      "sseDropRate",
    ],
    `${path}.alerts`,
  );
  const alert = (
    key: string,
  ): Readonly<{ forMs: number; threshold: number }> => {
    const item = record(alerts[key], `${path}.alerts.${key}`);
    exactKeys(item, ["forMs", "threshold"], `${path}.alerts.${key}`);
    const threshold = item["threshold"];
    if (
      typeof threshold !== "number" ||
      !Number.isFinite(threshold) ||
      threshold < 0
    )
      throw new PlatformConfigError(
        `${path}.alerts.${key}.threshold`,
        "ожидалось конечное неотрицательное число",
      );
    return Object.freeze({
      forMs: positiveIntegerValue(item["forMs"], `${path}.alerts.${key}.forMs`),
      threshold,
    });
  };
  const endpoint = (input: unknown, field: string): string => {
    const result = stringValue(input, field);
    try {
      const parsed = new URL(result);
      if (
        parsed.protocol !== "http:" ||
        parsed.username ||
        parsed.password ||
        parsed.hash
      )
        throw new Error();
    } catch {
      throw new PlatformConfigError(
        field,
        "ожидался внутренний HTTP endpoint без credentials и fragment",
      );
    }
    return result;
  };
  const collectorEndpoint = (input: unknown, field: string): string => {
    const result = endpoint(input, field);
    const parsed = new URL(result);
    if (
      !result.startsWith("http://otel-collector:") ||
      parsed.hostname !== "otel-collector" ||
      !parsed.port ||
      Number(parsed.port) < 1 ||
      parsed.pathname !== "/" ||
      parsed.search ||
      result.includes("?") ||
      result.includes("#")
    )
      throw new PlatformConfigError(
        field,
        "ожидался HTTP origin Collector с явным портом 1..65535 и только корневым путём",
      );
    return result;
  };
  const namespace = stringValue(source["namespace"], `${path}.namespace`);
  const nginxStatusEndpoint = endpoint(
    source["nginxStatusEndpoint"],
    `${path}.nginxStatusEndpoint`,
  );
  const nginxStatusPort = Number(new URL(nginxStatusEndpoint).port);
  if (
    !/^http:\/\/edge-nginx:[1-9][0-9]{0,4}\/nginx_status$/u.test(
      nginxStatusEndpoint,
    ) ||
    !nginxStatusPort ||
    nginxStatusPort > 65535 ||
    nginxStatusPort === 8443
  )
    throw new PlatformConfigError(
      `${path}.nginxStatusEndpoint`,
      "ожидался приватный native nginx status endpoint",
    );
  const releaseDigest = stringValue(
    source["releaseDigest"],
    `${path}.releaseDigest`,
  );
  if (
    !/^[a-z][a-z0-9.-]{0,62}$/u.test(namespace) ||
    !/^[a-zA-Z0-9._:-]{1,128}$/u.test(releaseDigest)
  )
    throw new PlatformConfigError(
      path,
      "некорректные namespace или releaseDigest",
    );
  const positive = (
    obj: UnknownRecord,
    keys: readonly string[],
    prefix: string,
  ): Record<string, number> =>
    Object.fromEntries(
      keys.map((key) => [
        key,
        positiveIntegerValue(obj[key], `${prefix}.${key}`),
      ]),
    );
  const collectorValues = positive(
    collector,
    [
      "memoryLimitMiB",
      "memorySpikeMiB",
      "containerMemoryMiB",
      "memoryCheckIntervalMs",
      "batchSize",
      "batchTimeoutMs",
      "queueCapacity",
      "queueConsumers",
      "exportTimeoutMs",
      "retryInitialMs",
      "retryMaxMs",
      "retryWindowMs",
      "maxLogRecordBytes",
    ],
    `${path}.collector`,
  );
  const producerValues = positive(
    producer,
    [
      "queueCapacity",
      "maxRecordBytes",
      "batchSize",
      "batchIntervalMs",
      "exportTimeoutMs",
      "diagnosticIntervalMs",
      "flushTimeoutMs",
    ],
    `${path}.producer`,
  );
  const loggingValues = positive(
    logging,
    ["maxSizeMiB", "maxFiles"],
    `${path}.logging`,
  );
  if (source["externalReportingEnabled"] !== false)
    throw new PlatformConfigError(
      `${path}.externalReportingEnabled`,
      "внешняя телеметрия запрещена",
    );
  const diskWatermarkPercent = integerValue(
    source["diskWatermarkPercent"],
    `${path}.diskWatermarkPercent`,
  );
  const backend = (name: "grafana" | "loki" | "prometheus" | "tempo") => {
    const field = `${path}.${name}`;
    const item = record(source[name], field);
    const keys = [
      "endpoint",
      "memoryLimitMiB",
      "maxDiskBytes",
      ...(name === "grafana" ? [] : ["retentionDays"]),
      ...(name === "tempo"
        ? ["otlpEndpoint", "finishOnShutdownTimeoutMs"]
        : []),
      ...(name === "prometheus" ? ["outOfOrderWindowMs"] : []),
    ];
    exactKeys(item, keys, field);
    const privateEndpoint = (key: string) => {
      const result = endpoint(item[key], `${field}.${key}`);
      const parsed = new URL(result);
      if (
        parsed.hostname !== name ||
        !parsed.port ||
        Number(parsed.port) < 1 ||
        parsed.pathname !== "/" ||
        parsed.search ||
        result.includes("?") ||
        result.includes("#") ||
        result.includes("@") ||
        result.endsWith("/")
      )
        throw new PlatformConfigError(
          `${field}.${key}`,
          "ожидался приватный HTTP origin с явным портом",
        );
      return result;
    };
    const values = positive(
      item,
      [
        "memoryLimitMiB",
        "maxDiskBytes",
        ...(name === "grafana" ? [] : ["retentionDays"]),
        ...(name === "prometheus" ? ["outOfOrderWindowMs"] : []),
        ...(name === "tempo" ? ["finishOnShutdownTimeoutMs"] : []),
      ],
      field,
    );
    if (
      values["maxDiskBytes"]! < 268435456 ||
      (name !== "grafana" && values["retentionDays"]! < 3) ||
      (name === "prometheus" && values["outOfOrderWindowMs"]! > 1800000)
    )
      throw new PlatformConfigError(
        field,
        "недопустимый бюджет telemetry storage",
      );
    if (name === "grafana" && values["memoryLimitMiB"]! < 512)
      throw new PlatformConfigError(
        `${field}.memoryLimitMiB`,
        "минимум для Grafana — 512 MiB",
      );
    if (name === "tempo" && values["finishOnShutdownTimeoutMs"] !== 10000)
      throw new PlatformConfigError(
        `${field}.finishOnShutdownTimeoutMs`,
        "разрешён только проверенный timeout 10000ms",
      );
    return Object.freeze({
      endpoint: privateEndpoint("endpoint"),
      ...values,
      ...(name === "tempo"
        ? { otlpEndpoint: privateEndpoint("otlpEndpoint") }
        : {}),
    });
  };
  const grafana = backend("grafana") as TelemetryConfig["grafana"];
  const loki = backend("loki") as TelemetryConfig["loki"];
  const prometheus = backend("prometheus") as TelemetryConfig["prometheus"];
  const tempo = backend("tempo") as TelemetryConfig["tempo"];
  const collectorGuardMiB =
    collectorValues["containerMemoryMiB"]! - collectorValues["memorySpikeMiB"]!;
  const collectorContainerBytes =
    collectorValues["containerMemoryMiB"]! * 1024 * 1024;
  const collectorPorts = [
    Number(
      new URL(
        collectorEndpoint(
          collector["otlpEndpoint"],
          `${path}.collector.otlpEndpoint`,
        ),
      ).port,
    ),
    Number(
      new URL(
        collectorEndpoint(
          collector["healthEndpoint"],
          `${path}.collector.healthEndpoint`,
        ),
      ).port,
    ),
  ];
  if (new Set(collectorPorts).size !== collectorPorts.length)
    throw new PlatformConfigError(
      `${path}.collector`,
      "порты OTLP и health Collector должны различаться",
    );
  if (
    diskWatermarkPercent < 1 ||
    diskWatermarkPercent > 99 ||
    alerts["evaluationIntervalMs"] !== 60_000 ||
    collectorValues["memorySpikeMiB"]! > collectorValues["memoryLimitMiB"]! ||
    collectorGuardMiB <= collectorValues["memoryLimitMiB"]! ||
    !Number.isSafeInteger(collectorContainerBytes) ||
    collectorValues["retryInitialMs"]! > collectorValues["retryMaxMs"]! ||
    collectorValues["batchSize"]! > collectorValues["queueCapacity"]! ||
    producerValues["batchSize"]! > producerValues["queueCapacity"]! ||
    producerValues["exportTimeoutMs"]! > producerValues["batchIntervalMs"]!
  )
    throw new PlatformConfigError(path, "telemetry budgets are inconsistent");
  const diskUsage = record(alerts["diskUsage"], `${path}.alerts.diskUsage`);
  exactKeys(diskUsage, ["forMs"], `${path}.alerts.diskUsage`);
  if (diskUsage["forMs"] !== 0)
    throw new PlatformConfigError(
      `${path}.alerts.diskUsage.forMs`,
      "ожидалось немедленное предупреждение",
    );
  if (alerts["notificationEndpoint"] !== "http://alert-sink:9091/alerts")
    throw new PlatformConfigError(
      `${path}.alerts.notificationEndpoint`,
      "ожидался приватный alert sink",
    );
  if (alerts["version"] !== 1)
    throw new PlatformConfigError(
      `${path}.alerts.version`,
      "поддерживается только версия 1",
    );
  return Object.freeze({
    namespace,
    releaseDigest,
    nginxStatusEndpoint,
    collector: Object.freeze({
      otlpEndpoint: collectorEndpoint(
        collector["otlpEndpoint"],
        `${path}.collector.otlpEndpoint`,
      ),
      healthEndpoint: collectorEndpoint(
        collector["healthEndpoint"],
        `${path}.collector.healthEndpoint`,
      ),
      ...collectorValues,
    } as TelemetryConfig["collector"]),
    producer: Object.freeze(producerValues as TelemetryConfig["producer"]),
    logging: Object.freeze(loggingValues as TelemetryConfig["logging"]),
    diskWatermarkPercent,
    externalReportingEnabled: false,
    grafana,
    loki,
    prometheus,
    tempo,
    alerts: Object.freeze({
      version: 1,
      evaluationIntervalMs: 60_000,
      notificationEndpoint: "http://alert-sink:9091/alerts",
      diskUsage: Object.freeze({ forMs: 0 }),
      sinkMemoryMiB: positiveIntegerValue(
        alerts["sinkMemoryMiB"],
        `${path}.alerts.sinkMemoryMiB`,
      ),
      notReady: alert("notReady"),
      consumerLag: alert("consumerLag"),
      outboxOldestAge: alert("outboxOldestAge"),
      unknownOutcome: alert("unknownOutcome"),
      sseDropRate: alert("sseDropRate"),
    } as TelemetryConfig["alerts"]),
  });
}

export function parsePlatformConfig(value: unknown): PlatformConfig {
  const source = record(value, "config");
  exactKeys(
    source,
    [
      "$schema",
      "schemaVersion",
      "environment",
      "toolchainRef",
      "platform",
      "postgres",
      "kafka",
      "aroma",
      "pricingPolicy",
      "telemetry",
      "security",
      "nginxTransport",
      "services",
    ],
    "config",
    ["browserOidc", "localIdentity", "verification"],
  );
  if (source["verification"] !== undefined) {
    const verification = record(source["verification"], "config.verification");
    exactKeys(
      verification,
      ["aromaSandbox", "securityScan", "unitCoverage", "realtimeQualification"],
      "config.verification",
      ["databaseIsolation", "kafkaNamespaceIsolation"],
    );
    const path = "config.verification.realtimeQualification";
    const policy = record(verification["realtimeQualification"], path);
    exactKeys(policy, ["budgetSeconds", "maximumAgeSeconds"], path);
    positiveIntegerValue(policy["budgetSeconds"], `${path}.budgetSeconds`);
    positiveIntegerValue(
      policy["maximumAgeSeconds"],
      `${path}.maximumAgeSeconds`,
    );
    if (verification["aromaSandbox"] !== null)
      record(verification["aromaSandbox"], "config.verification.aromaSandbox");
    parseSecurityScanVerification(verification["securityScan"]);
    parseUnitCoverageVerification(verification["unitCoverage"]);
    if (verification["databaseIsolation"] !== undefined) {
      const isolation = record(
        verification["databaseIsolation"],
        "config.verification.databaseIsolation",
      );
      exactKeys(
        isolation,
        ["enabled"],
        "config.verification.databaseIsolation",
      );
      if (typeof isolation["enabled"] !== "boolean")
        throw new PlatformConfigError(
          "config.verification.databaseIsolation.enabled",
          "ожидался explicit boolean",
        );
    }
    if (
      verification["kafkaNamespaceIsolation"] !== undefined &&
      typeof verification["kafkaNamespaceIsolation"] !== "boolean"
    )
      throw new PlatformConfigError(
        "config.verification.kafkaNamespaceIsolation",
        "ожидался explicit boolean",
      );
  }
  if (source["$schema"] !== "./platform.schema.json")
    throw new PlatformConfigError(
      "config.$schema",
      "должен ссылаться на platform.schema.json",
    );
  if (source["schemaVersion"] !== 1)
    throw new PlatformConfigError(
      "config.schemaVersion",
      "поддерживается только версия 1",
    );
  if (
    source["environment"] !== "development" &&
    source["environment"] !== "staging" &&
    source["environment"] !== "production"
  ) {
    throw new PlatformConfigError(
      "config.environment",
      "неизвестное окружение",
    );
  }
  const platform = record(source["platform"], "config.platform");
  if (Object.hasOwn(platform, "realtimeFullProfileMemoryBytes")) {
    throw new PlatformConfigError(
      "config.platform.realtimeFullProfileMemoryBytes",
      "устаревший memory override запрещён; используется штатный бюджет realtime",
    );
  }
  const pricingSource = record(source["pricingPolicy"], "config.pricingPolicy");
  exactKeys(
    pricingSource,
    [
      "policyVersionRef",
      "version",
      "currency",
      "markupBasisPoints",
      "minimumMarginMinor",
      "quoteTtlSeconds",
      "quantityScale",
      "roundingMode",
    ],
    "config.pricingPolicy",
  );
  const pricingRef = stringValue(
    pricingSource["policyVersionRef"],
    "config.pricingPolicy.policyVersionRef",
  );
  const pricingVersion = stringValue(
    pricingSource["version"],
    "config.pricingPolicy.version",
  );
  const pricingMargin = stringValue(
    pricingSource["minimumMarginMinor"],
    "config.pricingPolicy.minimumMarginMinor",
  );
  const pricingMarkup = integerValue(
    pricingSource["markupBasisPoints"],
    "config.pricingPolicy.markupBasisPoints",
  );
  const pricingTtl = positiveIntegerValue(
    pricingSource["quoteTtlSeconds"],
    "config.pricingPolicy.quoteTtlSeconds",
  );
  if (
    !/^pvr_[0-9A-HJKMNP-TV-Z]{26}$/u.test(pricingRef) ||
    !/^[1-9][0-9]*$/u.test(pricingVersion) ||
    !/^(0|[1-9][0-9]*)$/u.test(pricingMargin) ||
    BigInt(pricingMargin) > 9_223_372_036_854_775_807n ||
    pricingMarkup > 100_000 ||
    pricingTtl < 60 ||
    pricingTtl > 3_600 ||
    pricingSource["currency"] !== "RUB" ||
    pricingSource["quantityScale"] !== 3 ||
    pricingSource["roundingMode"] !== "CEILING"
  ) {
    throw new PlatformConfigError(
      "config.pricingPolicy",
      "некорректные значения версии или формулы Pricing",
    );
  }
  const pricingPolicy: PricingPolicyConfig = Object.freeze({
    policyVersionRef: pricingRef,
    version: pricingVersion,
    currency: "RUB",
    markupBasisPoints: pricingMarkup,
    minimumMarginMinor: pricingMargin,
    quoteTtlSeconds: pricingTtl,
    quantityScale: 3,
    roundingMode: "CEILING",
  });
  const telemetry = telemetryConfig(source["telemetry"]);
  if (
    source["environment"] !== "development" &&
    !/^sha256:[0-9a-f]{64}$/u.test(telemetry.releaseDigest)
  )
    throw new PlatformConfigError(
      "config.telemetry.releaseDigest",
      "staging/production требуют immutable sha256 release digest",
    );
  const shutdownGraceMs = positiveIntegerValue(
    platform["shutdownGraceMs"],
    "config.platform.shutdownGraceMs",
  );
  if (telemetry.tempo.finishOnShutdownTimeoutMs >= shutdownGraceMs)
    throw new PlatformConfigError(
      "config.telemetry.tempo.finishOnShutdownTimeoutMs",
      "timeout Tempo должен быть меньше platform.shutdownGraceMs",
    );
  const services = record(source["services"], "config.services");
  const expected = new Set<string>(RUNTIME_NAMES);
  for (const name of Object.keys(services)) {
    if (!expected.has(name))
      throw new PlatformConfigError(
        `config.services.${name}`,
        "runtime отсутствует в нормативном каталоге",
      );
  }
  for (const name of RUNTIME_NAMES) {
    if (!Object.hasOwn(services, name))
      throw new PlatformConfigError(
        `config.services.${name}`,
        "runtime не сконфигурирован",
      );
  }
  const kafka = parseKafkaConfig(source["kafka"], "config.kafka");
  const typedServices = Object.fromEntries(
    RUNTIME_NAMES.map((name) => [
      name,
      runtimeConfig(
        services[name],
        `config.services.${name}`,
        shutdownGraceMs,
        name,
      ),
    ]),
  ) as Record<RuntimeName, RuntimeConfig>;
  const verification =
    source["verification"] === undefined
      ? undefined
      : record(source["verification"], "config.verification");
  const isolation =
    verification?.["databaseIsolation"] === undefined
      ? undefined
      : record(
          verification["databaseIsolation"],
          "config.verification.databaseIsolation",
        );
  const databaseIsolationEnabled = isolation?.["enabled"] === true;
  const postgres = postgresConfig(
    source["postgres"],
    "config.postgres",
    source["environment"],
    databaseIsolationEnabled,
  );
  const browserOidc = browserOidcProfile(
    source["browserOidc"] ?? null,
    "config.browserOidc",
  );
  const nginxTransport = opaqueObject(
    source["nginxTransport"],
    "config.nginxTransport",
  );
  const security = opaqueObject(source["security"], "config.security");
  if (security["certificateValidityHours"] !== 24)
    throw new PlatformConfigError(
      "config.security.certificateValidityHours",
      "ожидалось значение 24",
    );
  if (security["certificateRenewBeforeHours"] !== 6)
    throw new PlatformConfigError(
      "config.security.certificateRenewBeforeHours",
      "ожидалось значение 6",
    );
  const localIdentity =
    source["localIdentity"] === undefined
      ? undefined
      : opaqueObject(source["localIdentity"], "config.localIdentity");
  assertDatabaseAdmissionBudget({
    services: typedServices,
    postgres,
    localIdentity,
  });
  return Object.freeze({
    schemaVersion: 1,
    $schema: "./platform.schema.json",
    environment: source["environment"],
    toolchainRef: stringValue(source["toolchainRef"], "config.toolchainRef"),
    platform: opaqueObject(source["platform"], "config.platform"),
    postgres,
    ...(localIdentity === undefined ? {} : { localIdentity }),
    kafka,
    aroma: aromaConfig(source["aroma"], "config.aroma"),
    pricingPolicy,
    telemetry,
    browserOidc,
    databaseIsolation: Object.freeze({
      enabled: isolation?.["enabled"] === true,
    }),
    kafkaNamespaceIsolation: verification?.["kafkaNamespaceIsolation"] === true,
    unitCoverage:
      verification?.["unitCoverage"] === undefined
        ? null
        : parseUnitCoverageVerification(verification["unitCoverage"]),
    nginxTransport,
    security: Object.freeze({
      ...security,
      certificateValidityHours: 24,
      certificateRenewBeforeHours: 6,
    }),
    services: Object.freeze(typedServices),
  });
}

export type ConfigParser = (text: string, sourcePath: string) => unknown;

export type LoadedPlatformConfig = Readonly<{
  config: PlatformConfig;
  sourceSha256: string;
  sourceBytes: Uint8Array;
}>;

export async function loadPlatformConfigWithSource(
  path: string,
  parse: ConfigParser = (text) => JSON.parse(text) as unknown,
): Promise<LoadedPlatformConfig> {
  const bytes = await readFile(path);
  const text = bytes.toString("utf8");
  return Object.freeze({
    config: parsePlatformConfig(parse(text, path)),
    sourceSha256: createHash("sha256").update(bytes).digest("hex"),
    sourceBytes: bytes,
  });
}

export async function loadPlatformConfig(
  path: string,
  parse: ConfigParser = (text) => JSON.parse(text) as unknown,
): Promise<PlatformConfig> {
  return (await loadPlatformConfigWithSource(path, parse)).config;
}
