import {readFile} from "node:fs/promises";

export const RUNTIME_NAMES = [
  "edge-gateway",
  "api-public",
  "api-internal",
  "web",
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

export type ListenConfig = Readonly<{host: string; port: number}>;
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
  port: number;
  sslMode: "prefer" | "require" | "verify-full";
  maxConnections: number;
  reservedConnections: number;
  rolloutReplicas: number;
}>;
export type DatabaseAdmissionInput = Readonly<{
  services: Readonly<Record<string, Pick<RuntimeConfig, "replicas" | "dbPool" | "database">>>;
  postgres: Pick<PostgresConfig, "maxConnections" | "reservedConnections" | "rolloutReplicas">;
}>;
export type DatabaseAdmissionBudget = Readonly<{
  steadyConnections: number;
  rolloutConnections: number;
  reservedConnections: number;
  requiredConnections: number;
  maxConnections: number;
  largestPool: number;
}>;
export type KafkaConfig = Readonly<{
  mode: "none" | "producer" | "consumer" | "consumer+producer";
  topics: readonly string[];
  groups: readonly string[];
}>;
export type PermissionConfig = Readonly<{
  manifest: string;
  net: readonly string[];
  fsRead: readonly string[];
  fsWrite: readonly string[];
  childProcess: boolean;
  workers: boolean;
}>;
export type RuntimeConfig = Readonly<{
  listen: ListenConfig;
  health: HealthConfig;
  deadlineMs: number | null;
  deadlineProfiles: Readonly<Record<string, number | null>>;
  concurrency: number;
  replicas: number;
  dbPool: DatabasePoolConfig | null;
  database: string | null;
  secretRefs: readonly string[];
  outbound: readonly string[];
  kafka: KafkaConfig;
  permissions: PermissionConfig;
  mutationCapability: boolean;
}>;
export type PlatformConfig = Readonly<{
  $schema: "./platform.schema.json";
  schemaVersion: 1;
  environment: EnvironmentName;
  toolchainRef: string;
  platform: Readonly<Record<string, unknown>>;
  postgres: PostgresConfig;
  kafka: Readonly<Record<string, unknown>>;
  aroma: Readonly<Record<string, unknown>>;
  security: Readonly<Record<string, unknown>>;
  services: Readonly<Record<RuntimeName, RuntimeConfig>>;
}>;

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

function exactKeys(value: UnknownRecord, expected: readonly string[], path: string): void {
  const expectedSet = new Set(expected);
  for (const key of Object.keys(value)) {
    if (!expectedSet.has(key)) throw new PlatformConfigError(`${path}.${key}`, "неизвестный ключ");
  }
  for (const key of expected) {
    if (!Object.hasOwn(value, key)) throw new PlatformConfigError(`${path}.${key}`, "обязательное значение отсутствует");
  }
}

function stringValue(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) throw new PlatformConfigError(path, "ожидалась непустая строка");
  return value;
}

function integerValue(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new PlatformConfigError(path, "ожидалось целое неотрицательное число");
  }
  return value;
}

function positiveIntegerValue(value: unknown, path: string): number {
  const result = integerValue(value, path);
  if (result < 1) throw new PlatformConfigError(path, "ожидалось положительное целое число");
  return result;
}

function nullableIntegerValue(value: unknown, path: string): number | null {
  return value === null ? null : integerValue(value, path);
}

function stringArray(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value)) throw new PlatformConfigError(path, "ожидался массив строк");
  return value.map((entry, index) => stringValue(entry, `${path}[${index}]`));
}

function opaqueObject(value: unknown, path: string): Readonly<Record<string, unknown>> {
  return Object.freeze({...record(value, path)});
}

function healthConfig(value: unknown, path: string): HealthConfig {
  const health = record(value, path);
  exactKeys(health, ["livePath", "readyPath", "metricsPath", "intervalMs", "timeoutMs", "startupGraceMs", "failureThreshold", "successThreshold"], path);
  return Object.freeze({
    livePath: stringValue(health["livePath"], `${path}.livePath`),
    readyPath: stringValue(health["readyPath"], `${path}.readyPath`),
    metricsPath: stringValue(health["metricsPath"], `${path}.metricsPath`),
    intervalMs: integerValue(health["intervalMs"], `${path}.intervalMs`),
    timeoutMs: integerValue(health["timeoutMs"], `${path}.timeoutMs`),
    startupGraceMs: integerValue(health["startupGraceMs"], `${path}.startupGraceMs`),
    failureThreshold: integerValue(health["failureThreshold"], `${path}.failureThreshold`),
    successThreshold: integerValue(health["successThreshold"], `${path}.successThreshold`),
  });
}

function databasePoolConfig(value: unknown, path: string, shutdownGraceMs: number): DatabasePoolConfig | null {
  if (value === null) return null;
  const pool = record(value, path);
  exactKeys(pool, ["max", "checkoutTimeoutMs", "lockTimeoutMs", "interactiveStatementTimeoutMs", "backgroundStatementTimeoutMs", "terminalTimeoutMs", "transactionTimeoutMs", "idleTimeoutMs", "maxLifetimeMs"], path);
  const terminalTimeoutMs = positiveIntegerValue(pool["terminalTimeoutMs"], `${path}.terminalTimeoutMs`);
  const transactionTimeoutMs = positiveIntegerValue(pool["transactionTimeoutMs"], `${path}.transactionTimeoutMs`);
  if (terminalTimeoutMs >= shutdownGraceMs || transactionTimeoutMs >= shutdownGraceMs) {
    throw new PlatformConfigError(path, "DB timeout должен быть меньше platform.shutdownGraceMs");
  }
  return Object.freeze({
    max: integerValue(pool["max"], `${path}.max`),
    checkoutTimeoutMs: integerValue(pool["checkoutTimeoutMs"], `${path}.checkoutTimeoutMs`),
    lockTimeoutMs: integerValue(pool["lockTimeoutMs"], `${path}.lockTimeoutMs`),
    interactiveStatementTimeoutMs: integerValue(pool["interactiveStatementTimeoutMs"], `${path}.interactiveStatementTimeoutMs`),
    backgroundStatementTimeoutMs: integerValue(pool["backgroundStatementTimeoutMs"], `${path}.backgroundStatementTimeoutMs`),
    terminalTimeoutMs,
    transactionTimeoutMs,
    idleTimeoutMs: integerValue(pool["idleTimeoutMs"], `${path}.idleTimeoutMs`),
    maxLifetimeMs: integerValue(pool["maxLifetimeMs"], `${path}.maxLifetimeMs`),
  });
}

function deadlineProfiles(value: unknown, path: string): Readonly<Record<string, number | null>> {
  const profiles = record(value, path);
  const allowed = new Set(["defaultMs", "readMs", "cartMs", "mutationMs"]);
  for (const name of Object.keys(profiles)) if (!allowed.has(name)) throw new PlatformConfigError(`${path}.${name}`, "неизвестный deadline profile");
  if (!Object.hasOwn(profiles, "defaultMs")) throw new PlatformConfigError(`${path}.defaultMs`, "обязательное значение отсутствует");
  const result: Record<string, number | null> = {};
  for (const [name, deadline] of Object.entries(profiles)) result[name] = nullableIntegerValue(deadline, `${path}.${name}`);
  return Object.freeze(result);
}

function runtimeConfig(value: unknown, path: string, shutdownGraceMs: number): RuntimeConfig {
  const source = record(value, path);
  exactKeys(source, ["listen", "health", "deadlineMs", "deadlineProfiles", "concurrency", "replicas", "dbPool", "database", "kafka", "outbound", "secretRefs", "permissions", "mutationCapability"], path);
  const listen = record(source["listen"], `${path}.listen`);
  exactKeys(listen, ["host", "port"], `${path}.listen`);
  const database = source["database"] === null ? null : stringValue(source["database"], `${path}.database`);

  const kafka = record(source["kafka"], `${path}.kafka`);
  exactKeys(kafka, ["mode", "topics", "groups"], `${path}.kafka`);
  if (kafka["mode"] !== "none" && kafka["mode"] !== "producer" && kafka["mode"] !== "consumer" && kafka["mode"] !== "consumer+producer") {
    throw new PlatformConfigError(`${path}.kafka.mode`, "неизвестный режим Kafka");
  }

  const permissions = record(source["permissions"], `${path}.permissions`);
  exactKeys(permissions, ["manifest", "net", "fsRead", "fsWrite", "childProcess", "workers"], `${path}.permissions`);
  if (typeof permissions["childProcess"] !== "boolean") throw new PlatformConfigError(`${path}.permissions.childProcess`, "ожидался boolean");
  if (typeof permissions["workers"] !== "boolean") throw new PlatformConfigError(`${path}.permissions.workers`, "ожидался boolean");
  if (typeof source["mutationCapability"] !== "boolean") throw new PlatformConfigError(`${path}.mutationCapability`, "ожидался boolean");
  return Object.freeze({
    listen: Object.freeze({host: stringValue(listen["host"], `${path}.listen.host`), port: integerValue(listen["port"], `${path}.listen.port`)}),
    health: healthConfig(source["health"], `${path}.health`),
    deadlineMs: nullableIntegerValue(source["deadlineMs"], `${path}.deadlineMs`),
    deadlineProfiles: deadlineProfiles(source["deadlineProfiles"], `${path}.deadlineProfiles`),
    concurrency: integerValue(source["concurrency"], `${path}.concurrency`),
    replicas: positiveIntegerValue(source["replicas"], `${path}.replicas`),
    dbPool: databasePoolConfig(source["dbPool"], `${path}.dbPool`, shutdownGraceMs),
    database,
    secretRefs: stringArray(source["secretRefs"], `${path}.secretRefs`),
    outbound: stringArray(source["outbound"], `${path}.outbound`),
    kafka: Object.freeze({
      mode: kafka["mode"],
      topics: stringArray(kafka["topics"], `${path}.kafka.topics`),
      groups: stringArray(kafka["groups"], `${path}.kafka.groups`),
    }),
    permissions: Object.freeze({
      manifest: stringValue(permissions["manifest"], `${path}.permissions.manifest`),
      net: stringArray(permissions["net"], `${path}.permissions.net`),
      fsRead: stringArray(permissions["fsRead"], `${path}.permissions.fsRead`),
      fsWrite: stringArray(permissions["fsWrite"], `${path}.permissions.fsWrite`),
      childProcess: permissions["childProcess"],
      workers: permissions["workers"],
    }),
    mutationCapability: source["mutationCapability"],
  });
}

function postgresConfig(value: unknown, path: string): PostgresConfig {
  const postgres = record(value, path);
  exactKeys(postgres, ["host", "port", "sslMode", "maxConnections", "reservedConnections", "rolloutReplicas"], path);
  const sslMode = postgres["sslMode"];
  if (sslMode !== "prefer" && sslMode !== "require" && sslMode !== "verify-full") {
    throw new PlatformConfigError(`${path}.sslMode`, "неизвестный sslMode");
  }
  const rolloutReplicas = positiveIntegerValue(postgres["rolloutReplicas"], `${path}.rolloutReplicas`);
  if (rolloutReplicas !== 1) {
    throw new PlatformConfigError(`${path}.rolloutReplicas`, "первый запуск разрешает только одну serial rollout replica");
  }
  return Object.freeze({
    host: stringValue(postgres["host"], `${path}.host`),
    port: positiveIntegerValue(postgres["port"], `${path}.port`),
    sslMode,
    maxConnections: positiveIntegerValue(postgres["maxConnections"], `${path}.maxConnections`),
    reservedConnections: positiveIntegerValue(postgres["reservedConnections"], `${path}.reservedConnections`),
    rolloutReplicas,
  });
}

function checkedSum(left: number, right: number, path: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw new PlatformConfigError(path, "budget выходит за пределы safe integer");
  return result;
}

export function calculateDatabaseAdmissionBudget(input: DatabaseAdmissionInput): DatabaseAdmissionBudget {
  if (input === null || typeof input !== "object" || input.postgres === null || typeof input.postgres !== "object") {
    throw new PlatformConfigError("config", "database admission input должен быть объектом");
  }
  if (input.services === null || typeof input.services !== "object" || Array.isArray(input.services)) {
    throw new PlatformConfigError("config.services", "database admission services должен быть объектом");
  }
  if (!Number.isSafeInteger(input.postgres.maxConnections) || input.postgres.maxConnections < 1) {
    throw new PlatformConfigError("config.postgres.maxConnections", "ожидалось положительное целое число");
  }
  if (!Number.isSafeInteger(input.postgres.reservedConnections) || input.postgres.reservedConnections < 0) {
    throw new PlatformConfigError("config.postgres.reservedConnections", "ожидалось целое неотрицательное число");
  }
  let steadyConnections = 0;
  let largestPool = 0;
  for (const [runtime, service] of Object.entries(input.services)) {
    if (service === null || typeof service !== "object") {
      throw new PlatformConfigError(`config.services.${runtime}`, "runtime должен быть объектом");
    }
    if (!Object.hasOwn(service, "replicas") || !Object.hasOwn(service, "dbPool") || !Object.hasOwn(service, "database")) {
      throw new PlatformConfigError(`config.services.${runtime}`, "replicas, database и dbPool обязательны для admission");
    }
    const hasDbPool = service.dbPool !== null && service.dbPool !== undefined;
    const hasDatabase = service.database !== null && service.database !== undefined;
    if (hasDbPool !== hasDatabase) {
      throw new PlatformConfigError(`config.services.${runtime}`, "database и dbPool должны быть заданы одновременно");
    }
    if (!hasDbPool) continue;
    if (!Number.isSafeInteger(service.replicas) || service.replicas < 1) {
      throw new PlatformConfigError(`config.services.${runtime}.replicas`, "ожидалось положительное целое число");
    }
    if (!Number.isSafeInteger(service.dbPool.max) || service.dbPool.max < 1) {
      throw new PlatformConfigError(`config.services.${runtime}.dbPool.max`, "ожидалось положительное целое число");
    }
    steadyConnections = checkedSum(steadyConnections, service.replicas * service.dbPool.max, `config.services.${runtime}`);
    largestPool = Math.max(largestPool, service.dbPool.max);
  }
  if (!Number.isSafeInteger(input.postgres.rolloutReplicas) || input.postgres.rolloutReplicas < 1) {
    throw new PlatformConfigError("config.postgres.rolloutReplicas", "ожидалось положительное целое число");
  }
  const rolloutConnections = largestPool * input.postgres.rolloutReplicas;
  if (!Number.isSafeInteger(rolloutConnections)) {
    throw new PlatformConfigError("config.postgres.rolloutReplicas", "rollout budget выходит за пределы safe integer");
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

export function assertDatabaseAdmissionBudget(input: DatabaseAdmissionInput): DatabaseAdmissionBudget {
  const budget = calculateDatabaseAdmissionBudget(input);
  if (budget.requiredConnections > budget.maxConnections) {
    throw new PlatformConfigError(
      "config.postgres",
      `DB admission budget ${budget.requiredConnections} exceeds maxConnections ${budget.maxConnections} (steady=${budget.steadyConnections}, rollout=${budget.rolloutConnections}, reserve=${budget.reservedConnections})`,
    );
  }
  return budget;
}

export function parsePlatformConfig(value: unknown): PlatformConfig {
  const source = record(value, "config");
  exactKeys(source, ["$schema", "schemaVersion", "environment", "toolchainRef", "platform", "postgres", "kafka", "aroma", "security", "services"], "config");
  if (source["$schema"] !== "./platform.schema.json") throw new PlatformConfigError("config.$schema", "должен ссылаться на platform.schema.json");
  if (source["schemaVersion"] !== 1) throw new PlatformConfigError("config.schemaVersion", "поддерживается только версия 1");
  if (source["environment"] !== "development" && source["environment"] !== "staging" && source["environment"] !== "production") {
    throw new PlatformConfigError("config.environment", "неизвестное окружение");
  }
  const platform = record(source["platform"], "config.platform");
  const shutdownGraceMs = positiveIntegerValue(platform["shutdownGraceMs"], "config.platform.shutdownGraceMs");
  const services = record(source["services"], "config.services");
  const expected = new Set<string>(RUNTIME_NAMES);
  for (const name of Object.keys(services)) {
    if (!expected.has(name)) throw new PlatformConfigError(`config.services.${name}`, "runtime отсутствует в нормативном каталоге");
  }
  for (const name of RUNTIME_NAMES) {
    if (!Object.hasOwn(services, name)) throw new PlatformConfigError(`config.services.${name}`, "runtime не сконфигурирован");
  }
  const typedServices = Object.fromEntries(RUNTIME_NAMES.map((name) => [name, runtimeConfig(services[name], `config.services.${name}`, shutdownGraceMs)])) as Record<RuntimeName, RuntimeConfig>;
  const postgres = postgresConfig(source["postgres"], "config.postgres");
  assertDatabaseAdmissionBudget({services: typedServices, postgres});
  return Object.freeze({
    schemaVersion: 1,
    $schema: "./platform.schema.json",
    environment: source["environment"],
    toolchainRef: stringValue(source["toolchainRef"], "config.toolchainRef"),
    platform: opaqueObject(source["platform"], "config.platform"),
    postgres,
    kafka: opaqueObject(source["kafka"], "config.kafka"),
    aroma: opaqueObject(source["aroma"], "config.aroma"),
    security: opaqueObject(source["security"], "config.security"),
    services: Object.freeze(typedServices),
  });
}

export type ConfigParser = (text: string, sourcePath: string) => unknown;

export async function loadPlatformConfig(path: string, parse: ConfigParser = (text) => JSON.parse(text) as unknown): Promise<PlatformConfig> {
  const text = await readFile(path, "utf8");
  return parsePlatformConfig(parse(text, path));
}
