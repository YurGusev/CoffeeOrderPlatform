import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { load as parseYaml } from "js-yaml";
import {
  assertDatabaseAdmissionBudget,
  PlatformConfigError,
} from "../packages/platform-config/src/index.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNTIMES = [
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
];
const KAFKA_TOPICS = [
  "coffee.catalog.snapshot.v1",
  "coffee.catalog.mapping.v2",
  "coffee.orders.lifecycle.v1",
  "coffee.aroma.cart.commands.v1",
  "coffee.aroma.cart.events.v1",
  "coffee.realtime.invalidate.v1",
];
const EXPECTED_KAFKA_PRODUCERS = {
  "edge-gateway": [], "api-public": [], "api-internal": [], web: [],
  "customer-service": [], "catalog-service": [], "catalog-supplier-sync": [],
  "catalog-activation-worker": ["coffee.catalog.snapshot.v1", "coffee.catalog.mapping.v2"],
  "pricing-service": [],
  "orders-service": ["coffee.orders.lifecycle.v1", "coffee.aroma.cart.commands.v1", "coffee.realtime.invalidate.v1"],
  "orders-aroma-preparation": ["coffee.aroma.cart.commands.v1", "coffee.realtime.invalidate.v1"],
  "aroma-observer": ["coffee.aroma.cart.events.v1"],
  "aroma-convergence": ["coffee.aroma.cart.events.v1", "coffee.realtime.invalidate.v1"],
  "aroma-gateway": [], "realtime-gateway": [],
};
const EXPECTED_KAFKA_CONSUMERS = {
  "edge-gateway": [], "api-public": [], "api-internal": [], web: [],
  "customer-service": [], "catalog-service": [], "catalog-supplier-sync": [],
  "catalog-activation-worker": [], "pricing-service": [], "orders-service": [],
  "orders-aroma-preparation": [
    {groupId: "orders-catalog-mapping-v2", topics: ["coffee.catalog.mapping.v2"], processing: "durable"},
    {groupId: "orders-aroma-preparation-v1", topics: ["coffee.orders.lifecycle.v1"], processing: "durable"},
    {groupId: "orders-aroma-projection-v1", topics: ["coffee.aroma.cart.events.v1"], processing: "durable"},
  ],
  "aroma-observer": [],
  "aroma-convergence": [
    {groupId: "aroma-convergence-v1", topics: ["coffee.aroma.cart.commands.v1"], processing: "durable"},
  ],
  "aroma-gateway": [],
  "realtime-gateway": [
    {groupId: "realtime-gateway-v1", topics: ["coffee.realtime.invalidate.v1"], processing: "realtime"},
  ],
};
const ALLOWED_SOPS_FILES = new Set([
  "secrets/platform.secrets.sops.yaml",
  "secrets/platform-secrets.schema.json",
]);
const ENC_RE =
  /^ENC\[AES256_GCM,data:[^,]+,iv:[^,]+,tag:[^,]+,type:(str|bytes)\]$/;
const SECRET_LIKE_KEY_RE = /(?:password|token|private[_-]?key|secret)/i;
const ALLOWED_OPEN_SECRET_KEYS = new Set([
  "secrets",
  "secretRef",
  "secretRefs",
  "caPrivateKeyRuntimeAccess",
]);
const ALLOWED_LOCATOR_ENV_KEYS = new Set([
  "COFFEE_CONFIG_FILE",
  "COFFEE_RUNTIME_SECRETS_FILE",
  "COFFEE_COMPOSE_SECRETS_DIR",
  "SOPS_AGE_KEY_FILE",
]);
const SERVICE_BASELINE = {
  "edge-gateway": {
    port: 4000,
    replicas: 1,
    deadlineMs: 5000,
    concurrency: 500,
    database: null,
    pool: null,
    terminalTimeoutMs: null,
    transactionTimeoutMs: null,
  },
  "api-public": {
    port: 4050,
    replicas: 1,
    deadlineMs: 4500,
    concurrency: 400,
    database: null,
    pool: null,
    terminalTimeoutMs: null,
    transactionTimeoutMs: null,
  },
  "api-internal": {
    port: 4051,
    replicas: 1,
    deadlineMs: null,
    concurrency: 300,
    database: null,
    pool: null,
    terminalTimeoutMs: null,
    transactionTimeoutMs: null,
  },
  web: {
    port: 3000,
    replicas: 1,
    deadlineMs: 5000,
    concurrency: 500,
    database: null,
    pool: null,
    terminalTimeoutMs: null,
    transactionTimeoutMs: null,
  },
  "customer-service": {
    port: 4101,
    replicas: 1,
    deadlineMs: 2000,
    concurrency: 100,
    database: "coffee_platform_customer",
    pool: 8,
    terminalTimeoutMs: 2000,
    transactionTimeoutMs: 10000,
  },
  "catalog-service": {
    port: 4102,
    replicas: 1,
    deadlineMs: 2000,
    concurrency: 150,
    database: "coffee_platform_catalog",
    pool: 8,
    terminalTimeoutMs: 2000,
    transactionTimeoutMs: 10000,
  },
  "catalog-supplier-sync": {
    port: 4201,
    replicas: 1,
    deadlineMs: 900000,
    concurrency: 1,
    database: "coffee_platform_catalog",
    pool: 4,
    terminalTimeoutMs: 2000,
    transactionTimeoutMs: 10000,
  },
  "catalog-activation-worker": {
    port: 4202,
    replicas: 1,
    deadlineMs: 5000,
    concurrency: 1,
    database: "coffee_platform_catalog",
    pool: 4,
    terminalTimeoutMs: 2000,
    transactionTimeoutMs: 10000,
  },
  "pricing-service": {
    port: 4103,
    replicas: 1,
    deadlineMs: 5000,
    concurrency: 100,
    database: "coffee_platform_pricing",
    pool: 8,
    terminalTimeoutMs: 2000,
    transactionTimeoutMs: 10000,
  },
  "orders-service": {
    port: 4104,
    replicas: 1,
    deadlineMs: 5000,
    concurrency: 150,
    database: "coffee_platform_orders",
    pool: 4,
    terminalTimeoutMs: 2000,
    transactionTimeoutMs: 10000,
  },
  "orders-aroma-preparation": {
    port: 4203,
    replicas: 1,
    deadlineMs: 5000,
    concurrency: 16,
    database: "coffee_platform_orders",
    pool: 4,
    terminalTimeoutMs: 2000,
    transactionTimeoutMs: 10000,
  },
  "aroma-observer": {
    port: 4204,
    replicas: 1,
    deadlineMs: 15000,
    concurrency: 4,
    database: "coffee_platform_orders",
    pool: 4,
    terminalTimeoutMs: 2000,
    transactionTimeoutMs: 10000,
  },
  "aroma-convergence": {
    port: 4205,
    replicas: 1,
    deadlineMs: 30000,
    concurrency: 4,
    database: "coffee_platform_orders",
    pool: 4,
    terminalTimeoutMs: 2000,
    transactionTimeoutMs: 10000,
  },
  "aroma-gateway": {
    port: 4301,
    replicas: 1,
    deadlineMs: 10000,
    concurrency: 8,
    database: "coffee_platform_integration",
    pool: 8,
    terminalTimeoutMs: 2000,
    transactionTimeoutMs: 10000,
  },
  "realtime-gateway": {
    port: 4401,
    replicas: 1,
    deadlineMs: null,
    concurrency: 5000,
    database: null,
    pool: null,
    terminalTimeoutMs: null,
    transactionTimeoutMs: null,
  },
};

export class ConfigError extends Error {
  constructor(rule, message) {
    super(`${rule} ${message}`);
    this.name = "ConfigError";
    this.ruleId = rule;
  }
}

function fail(rule, message) {
  throw new ConfigError(rule, message);
}

async function readYaml(path) {
  try {
    return parseYaml(await readFile(path, "utf8"), { json: true });
  } catch (error) {
    fail("CONFIG-YAML", `${path}: ${error.message}`);
  }
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    fail("CONFIG-JSON", `${path}: ${error.message}`);
  }
}

function validate(schema, document, label) {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const valid = ajv.compile(schema)(document);
  if (!valid) {
    const details = ajv.errorsText(ajv.errors, { separator: "; " });
    fail("CONFIG-SCHEMA", `${label}: ${details}`);
  }
}

function sorted(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function exactSet(actual, expected, label) {
  const actualSorted = sorted(Object.keys(actual));
  const expectedSorted = sorted(expected);
  if (JSON.stringify(actualSorted) !== JSON.stringify(expectedSorted)) {
    const missing = expectedSorted.filter((key) => !actualSorted.includes(key));
    const unknown = actualSorted.filter((key) => !expectedSorted.includes(key));
    fail(
      "CONFIG-RUNTIME-SET",
      `${label}: missing=[${missing.join(",")}] unknown=[${unknown.join(",")}]`,
    );
  }
}

function walk(value, visit, path = []) {
  visit(value, path);
  if (Array.isArray(value)) {
    value.forEach((child, index) =>
      walk(child, visit, [...path, String(index)]),
    );
  } else if (value && typeof value === "object") {
    Object.entries(value).forEach(([key, child]) =>
      walk(child, visit, [...path, key]),
    );
  }
}

function checkConfigKeys(document) {
  walk(document, (_value, path) => {
    const key = path.at(-1);
    if (isSecretLikeKey(key)) {
      fail(
        "CONFIG-PLAINTEXT-KEY",
        `${path.join(".")}: secret-like key is not allowed in platform.yaml`,
      );
    }
  });
}

function checkKafkaConfiguration(config) {
  const configuredTopics = Object.values(config.kafka.topics).map((topic) => topic.name);
  if (JSON.stringify(sorted(configuredTopics)) !== JSON.stringify(sorted(KAFKA_TOPICS)))
    fail("CONFIG-KAFKA-TOPIC-ALLOWLIST", "Kafka topic registry differs from launch allowlist");
  for (const runtime of RUNTIMES) {
    const access = config.services[runtime].kafka;
    const expectedProducers = EXPECTED_KAFKA_PRODUCERS[runtime];
    if (JSON.stringify(access.producers) !== JSON.stringify(expectedProducers))
      fail("CONFIG-KAFKA-DIRECTION", `${runtime}.kafka.producers differs from launch mapping`);
    for (const topic of access.producers) {
      if (!KAFKA_TOPICS.includes(topic)) fail("CONFIG-KAFKA-TOPIC-ALLOWLIST", `${runtime}.kafka.producers contains ${topic}`);
    }
    for (const consumer of access.consumers) {
      if (!consumer.topics.every((topic) => KAFKA_TOPICS.includes(topic)))
        fail("CONFIG-KAFKA-TOPIC-ALLOWLIST", `${runtime}.kafka consumer contains an unknown topic`);
      if (consumer.processing === "realtime" &&
          (runtime !== "realtime-gateway" || consumer.groupId !== "realtime-gateway-v1" ||
            JSON.stringify(consumer.topics) !== JSON.stringify(["coffee.realtime.invalidate.v1"])))
        fail("CONFIG-KAFKA-REALTIME", `${runtime}.kafka.realtime is outside the sole realtime exception`);
    }
    if (JSON.stringify(access.consumers) !== JSON.stringify(EXPECTED_KAFKA_CONSUMERS[runtime]))
      fail("CONFIG-KAFKA-DIRECTION", `${runtime}.kafka.consumers differs from launch mapping`);
  }
}

function isSecretLikeKey(key) {
  return (
    typeof key === "string" &&
    SECRET_LIKE_KEY_RE.test(key) &&
    !ALLOWED_OPEN_SECRET_KEYS.has(key) &&
    !ALLOWED_LOCATOR_ENV_KEYS.has(key.toUpperCase())
  );
}

function isOpenConfigurationPath(path) {
  const normalized = path.replaceAll("\\", "/");
  const file = basename(normalized);
  if (/\.schema\.(?:json|ya?ml)$/i.test(file)) return false;
  if (normalized.startsWith("config/") || normalized.startsWith("platform/"))
    return true;
  if (/^(?:\.github|\.gitlab|\.circleci|\.buildkite|ci|cd)\//i.test(normalized))
    return true;
  return (
    /^(?:docker-)?compose(?:[-.]|$).+\.(?:ya?ml|json)$/i.test(file) ||
    /^(?:docker-)?compose\.(?:ya?ml|json)$/i.test(file)
  );
}

function checkOpenConfigurationText(text, label) {
  const lines = text.split(/\r?\n/u);
  const keyPattern =
    /(?:^|[{,\s-])(?:"([A-Za-z0-9_.-]+)"|'([A-Za-z0-9_.-]+)'|([A-Za-z0-9_.-]+))\s*:/gu;
  const assignmentPattern =
    /(?:^|[\s"'`])([A-Za-z_][A-Za-z0-9_.-]*(?:password|token|private[_-]?key|secret)[A-Za-z0-9_.-]*)\s*=/giu;
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//"))
      continue;
    for (const match of trimmed.matchAll(keyPattern)) {
      const key = match[1] ?? match[2] ?? match[3];
      if (isSecretLikeKey(key))
        fail(
          "CONFIG-PLAINTEXT-KEY",
          `${label}:${index + 1}: secret-like key ${key} is not allowed in open configuration`,
        );
    }
    for (const match of trimmed.matchAll(assignmentPattern)) {
      if (ALLOWED_LOCATOR_ENV_KEYS.has(match[1].toUpperCase())) continue;
      fail(
        "CONFIG-PLAINTEXT-KEY",
        `${label}:${index + 1}: secret-like environment key ${match[1]} is not allowed in open configuration`,
      );
    }
  }
}

function secretValueAt(environment, ref) {
  const [root, ...parts] = ref.split(".");
  let current = environment[root];
  for (const part of parts) current = current?.[part];
  return current;
}

function checkEncryptedLeaves(document) {
  walk(document, (value, path) => {
    if (
      path[0] === "sops" ||
      path.at(-1) === "username" ||
      path.at(-1) === "schemaVersion"
    )
      return;
    if (typeof value === "string" && !ENC_RE.test(value)) {
      fail(
        "CONFIG-PLAINTEXT-SECRET",
        `${path.join(".")}: encrypted SOPS value required`,
      );
    }
  });
}

async function checkForbiddenFiles(root) {
  async function visit(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else {
        const rel = relative(root, path).replaceAll("\\", "/");
        if (/^\.env(?:\.|$)/i.test(entry.name))
          fail("CONFIG-FORBIDDEN-FILE", `${rel}: .env files are forbidden`);
        const documentationFile =
          rel.startsWith("docs/") && /\.(?:md|rst|txt)$/i.test(entry.name);
        if (
          /secret/i.test(entry.name) &&
          !ALLOWED_SOPS_FILES.has(rel) &&
          entry.name !== ".sops.yaml" &&
          !documentationFile
        ) {
          fail(
            "CONFIG-FORBIDDEN-FILE",
            `${rel}: additional secret file is forbidden`,
          );
        }
        if (isOpenConfigurationPath(rel))
          checkOpenConfigurationText(await readFile(path, "utf8"), rel);
      }
    }
  }
  await visit(root);
}

function checkSopsRecipients(document, rules) {
  const creationRule = rules?.creation_rules?.find(
    (rule) => rule.path_regex === "secrets/platform\\.secrets\\.sops\\.yaml$",
  );
  const expected = creationRule?.age;
  if (!Array.isArray(expected) || expected.length !== 3)
    fail(
      "CONFIG-SOPS-RECIPIENT",
      ".sops.yaml must contain exactly three public age recipients",
    );
  const actual = document.sops.age;
  if (
    !Array.isArray(actual) ||
    actual.some(
      (item) =>
        typeof item?.recipient !== "string" ||
        typeof item?.enc !== "string" ||
        !item.enc.includes("BEGIN AGE ENCRYPTED FILE"),
    )
  ) {
    fail(
      "CONFIG-SOPS-RECIPIENT",
      "encrypted secrets must contain age recipient metadata",
    );
  }
  if (
    JSON.stringify(sorted(actual.map((item) => item.recipient))) !==
    JSON.stringify(sorted(expected))
  ) {
    fail(
      "CONFIG-SOPS-RECIPIENT",
      "encrypted secrets recipients differ from .sops.yaml",
    );
  }
}

function verifySopsMacIfRequested(path) {
  const keyFile = process.env.SOPS_AGE_KEY_FILE;
  const required = process.env.COFFEE_REQUIRE_SOPS_MAC === "1";
  if (!keyFile && !required) return;
  if (!keyFile)
    fail(
      "CONFIG-SOPS-MAC",
      "SOPS_AGE_KEY_FILE is required for cryptographic MAC verification",
    );
  const binary = process.env.SOPS_BIN || "sops";
  try {
    execFileSync(binary, ["--decrypt", "--output", "/dev/null", path], {
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, SOPS_AGE_KEY_FILE: keyFile },
    });
  } catch (error) {
    fail(
      "CONFIG-SOPS-MAC",
      `SOPS decryption/MAC validation failed: ${error.stderr?.toString().trim() || error.message}`,
    );
  }
}

export async function loadPlatformConfig(
  root = REPO_ROOT,
  configPath = join(root, "config/platform.yaml"),
) {
  const path = configPath;
  const schema = await readJson(join(root, "config/platform.schema.json"));
  const config = await readYaml(path);
  validate(schema, config, path);
  checkConfigKeys(config);
  exactSet(config.services, RUNTIMES, "platform.yaml services");
  checkKafkaConfiguration(config);
  try {
    assertDatabaseAdmissionBudget({services: config.services, postgres: config.postgres});
  } catch (error) {
    if (error instanceof PlatformConfigError) fail("CONFIG-DB-ADMISSION", error.message);
    throw error;
  }

  const catalog = await readJson(join(root, "config/service-catalog.json"));
  const profile = await readJson(
    join(root, "platform/launch-v1-runtime-profile.json"),
  );
  const catalogByName = new Map(
    catalog.runtimes.map((runtime) => [runtime.name, runtime]),
  );
  const profileByName = new Map(
    profile.runtimes.map((runtime) => [runtime.name, runtime]),
  );
  exactSet(Object.fromEntries(catalogByName), RUNTIMES, "service catalog");
  exactSet(
    Object.fromEntries(profileByName),
    RUNTIMES,
    "launch-v1 runtime profile",
  );
  for (const runtime of RUNTIMES) {
    const configured = config.services[runtime];
    const accepted = catalogByName.get(runtime);
    const authority = profileByName.get(runtime);
    if (!accepted)
      fail("CONFIG-RUNTIME-SET", `${runtime}: missing service catalog entry`);
    if (!authority)
      fail("CONFIG-RUNTIME-SET", `${runtime}: missing launch-v1 profile entry`);
    if (
      JSON.stringify(sorted(configured.secretRefs)) !==
      JSON.stringify(sorted(accepted.secretRefs))
    ) {
      fail(
        "CONFIG-SECRET-ALLOWLIST",
        `${runtime}: secretRefs differ from service catalog`,
      );
    }
    if (
      configured.database === null &&
      configured.secretRefs.some((ref) => ref.startsWith("postgres."))
    ) {
      fail(
        "CONFIG-DB-SECRET",
        `${runtime}: stateless runtime cannot receive postgres secret`,
      );
    }
    if (
      JSON.stringify(sorted(configured.secretRefs)) !==
      JSON.stringify(sorted(authority.secretRefs))
    ) {
      fail(
        "CONFIG-SECRET-ALLOWLIST",
        `${runtime}: secretRefs differ from launch-v1 profile`,
      );
    }
    const baseline = SERVICE_BASELINE[runtime];
    if (
      configured.listen.port !== baseline.port ||
      configured.deadlineMs !== baseline.deadlineMs ||
      configured.concurrency !== baseline.concurrency ||
      configured.replicas !== baseline.replicas ||
      configured.database !== baseline.database ||
      (configured.dbPool?.max ?? null) !== baseline.pool ||
      (configured.dbPool?.terminalTimeoutMs ?? null) !== baseline.terminalTimeoutMs ||
      (configured.dbPool?.transactionTimeoutMs ?? null) !== baseline.transactionTimeoutMs
    ) {
      fail(
        "CONFIG-RUNTIME-POLICY",
        `${runtime}: listen/deadline/concurrency/database/pool differs from runtime matrix`,
      );
    }
    for (const ref of configured.secretRefs) {
      if (!/^[a-z][a-zA-Z0-9-]*(\.[a-z][a-zA-Z0-9-]*)+$/.test(ref))
        fail("CONFIG-SECRET-REF", `${runtime}.${ref}: invalid secretRef`);
    }
  }
  return config;
}

export async function loadEncryptedSecrets(root = REPO_ROOT) {
  const path = join(root, "secrets/platform.secrets.sops.yaml");
  const schema = await readJson(
    join(root, "secrets/platform-secrets.schema.json"),
  );
  const document = await readYaml(path);
  validate(schema, document, path);
  checkEncryptedLeaves(document);
  if (!ENC_RE.test(document.sops.mac))
    fail("CONFIG-SOPS-MAC", `${path}: invalid encrypted SOPS MAC`);
  const rules = await readYaml(join(root, ".sops.yaml"));
  checkSopsRecipients(document, rules);
  verifySopsMacIfRequested(path);
  return document;
}

export async function checkPlatformConfig(root = REPO_ROOT) {
  await checkForbiddenFiles(root);
  const config = await loadPlatformConfig(root);
  const secrets = await loadEncryptedSecrets(root);
  const environment = secrets.environments[config.environment];
  for (const [runtime, service] of Object.entries(config.services)) {
    for (const ref of service.secretRefs) {
      if (secretValueAt(environment, ref) === undefined)
        fail(
          "CONFIG-SECRET-REF",
          `${runtime}.${ref}: secret does not exist for ${config.environment}`,
        );
    }
  }
  return {
    runtimeCount: Object.keys(config.services).length,
    environment: config.environment,
  };
}
