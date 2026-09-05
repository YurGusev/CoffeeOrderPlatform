#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  chmod,
  chown,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { load as parseYaml } from "js-yaml";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const COMPOSE_FILE = join(ROOT, "compose.yaml");
const BOOTSTRAP = join(ROOT, "tools/config-bootstrap/index.mjs");
const SECRETS_TMPFS_ROOT = "/dev/shm";
const EXTERNAL_POSTGRES_NETWORK = "coffee_postgres_data";
const DATABASE_PROOF_RUNTIME = "customer-service";
const COMPOSE_NETWORKS = [
  "coffee_host_ingress",
  "coffee_public_ingress",
  "coffee_edge_backend",
  "coffee_public_api_backend",
  "coffee_internal_api",
  "coffee_postgres_data",
  "coffee_kafka_event",
  "coffee_provider_egress",
];
const DATABASE_PROOF_IMAGE =
  "postgres:17.11-alpine@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73";
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
function usage() {
  return [
    "Usage: node tools/compose-smoke.mjs [options]",
    "",
    "Options:",
    "  --stub-secrets                     use empty, non-secret scoped stubs for topology-only smoke",
    "  --database-proof                  run the isolated customer PostgreSQL readiness proof",
    "  --provision-empty-postgres-network create coffee_postgres_data only when absent; never starts PostgreSQL",
    "  --no-build                         use already-built runtime images",
    "  --project-name <name>              explicit isolated Compose project name",
    "  --keep                             leave the stack and tmpfs secret directory running",
  ].join("\n");
}

function parseArguments(argv) {
  const options = {
    stubSecrets: false,
    provisionNetwork: false,
    noBuild: false,
    keep: false,
    databaseProof: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--stub-secrets") options.stubSecrets = true;
    else if (argument === "--provision-empty-postgres-network")
      options.provisionNetwork = true;
    else if (argument === "--no-build") options.noBuild = true;
    else if (argument === "--database-proof") options.databaseProof = true;
    else if (argument === "--keep") options.keep = true;
    else if (argument === "--project-name") {
      const value = argv[++index];
      if (!value || !/^[a-z0-9][a-z0-9_-]*$/.test(value))
        throw new Error(
          "--project-name must be a lowercase Compose project name",
        );
      options.projectName = value;
    } else if (argument === "--help" || argument === "-h") {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`unknown option ${argument}\n\n${usage()}`);
    }
  }
  if (!options.stubSecrets && !options.databaseProof && !process.env.SOPS_AGE_KEY_FILE) {
    throw new Error(
      "SOPS_AGE_KEY_FILE is required for decrypted scoped secrets; use --stub-secrets only for topology smoke without DB/provider proof",
    );
  }
  return options;
}

function composeArgs(projectName, args, composeFile = COMPOSE_FILE) {
  return [
    "compose",
    "--project-name",
    projectName,
    "-f",
    COMPOSE_FILE,
    ...(composeFile === COMPOSE_FILE ? [] : ["-f", composeFile]),
    ...args,
  ];
}

function runCompose(projectName, secretsDir, args, options = {}) {
  const env = {
    ...process.env,
    COFFEE_COMPOSE_SECRETS_DIR: secretsDir,
  };
  return execFileSync("docker", composeArgs(projectName, args, options.composeFile), {
    cwd: ROOT,
    env,
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
  });
}

function runDocker(args, options = {}) {
  return execFileSync("docker", args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: options.inherit
      ? "inherit"
      : [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    input: options.input,
  });
}

function buildRuntimeImages(projectName, runtimes = RUNTIMES) {
  for (const runtime of runtimes) {
    execFileSync(
      process.execPath,
      [
        join(ROOT, "tools/docker-build.mjs"),
        "--build-arg",
        `RUNTIME=${runtime}`,
        "--target",
        "runtime",
        "--load",
        "-t",
        `${projectName}-${runtime}:latest`,
        ROOT,
      ],
      { cwd: ROOT, env: process.env, stdio: "inherit" },
    );
  }
}

async function writeStubSecret(path, runtime, environment, refs, databaseCredential) {
  // These placeholders satisfy the scoped-ref contract but are not credentials
  // and cannot prove DB/provider access. No real secret leaves enter the smoke.
  const secrets = {};
  for (const ref of refs) {
    const segments = ref.split(".");
    let current = secrets;
    for (const segment of segments.slice(0, -1)) {
      if (!Object.hasOwn(current, segment)) current[segment] = {};
      current = current[segment];
    }
    current[segments.at(-1)] =
      ref.startsWith("postgres.") && databaseCredential !== undefined
        ? databaseCredential
        : ref.startsWith("postgres.")
          ? {
              username: `compose_${runtime.replaceAll("-", "_")}`,
              password: "compose-smoke-placeholder",
            }
          : "compose-smoke-placeholder";
  }
  const content = `${JSON.stringify({ schemaVersion: 1, environment, runtime, secrets })}\n`;
  await writeFile(path, content, { encoding: "utf8", mode: 0o400 });
  await chmod(path, 0o400);
}

async function readDatabaseProofCredentials() {
  const ownership = JSON.parse(
    await readFile(join(ROOT, "config/database-ownership.json"), "utf8"),
  );
  const owner = ownership.runtimeClaims.find(
    (candidate) => candidate.runtime === DATABASE_PROOF_RUNTIME,
  );
  assert.ok(owner, `${DATABASE_PROOF_RUNTIME} database ownership is missing`);
  assert.ok(owner.role, `${DATABASE_PROOF_RUNTIME} database role is missing`);
  assert.match(owner.role, /^[a-z][a-z0-9_]*$/);
  return {
    owner: {
      username: owner.role,
      password: `compose-proof-${randomUUID()}`,
    },
    admin: {
      username: `compose_admin_${randomUUID().replaceAll("-", "")}`,
      password: `compose-admin-${randomUUID()}`,
    },
  };
}

function bootstrapEnvironment(path) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("COFFEE_") && !key.startsWith("SOPS_"))
      env[key] = value;
  }
  env.COFFEE_CONFIG_FILE = join(ROOT, "config/platform.yaml");
  env.COFFEE_RUNTIME_SECRETS_FILE = path;
  if (process.env.SOPS_AGE_KEY_FILE)
    env.SOPS_AGE_KEY_FILE = process.env.SOPS_AGE_KEY_FILE;
  return env;
}

async function materializeSecrets(secretsDir, options) {
  await mkdir(secretsDir, { recursive: true, mode: 0o700 });
  await materializeKafkaTls(secretsDir);
  const platformConfig = parseYaml(
    await readFile(join(ROOT, "config/platform.yaml"), "utf8"),
    { json: true },
  );
  for (const runtime of RUNTIMES) {
    const path = join(secretsDir, `${runtime}.yaml`);
    if (options.stubSecrets || options.databaseProof) {
      const service = platformConfig.services[runtime];
      await writeStubSecret(
        path,
        runtime,
        platformConfig.environment,
        service.secretRefs,
        options.databaseProofCredentials?.[runtime],
      );
    } else {
      execFileSync(process.execPath, [BOOTSTRAP, "--runtime", runtime], {
        cwd: ROOT,
        env: bootstrapEnvironment(path),
        encoding: "utf8",
        stdio: ["ignore", "ignore", "pipe"],
      });
    }
    // Docker Compose's local file-secret backend ignores long-syntax uid/gid/mode
    // and bind-mounts the source inode. Own it by the exact non-root runtime UID
    // before Compose starts so the container can read mode 0400 without secrets
    // ever touching persistent storage.
    await chown(path, 1000, 1000);
    const fileStat = await stat(path);
    assert.equal(
      fileStat.mode & 0o777,
      0o400,
      `${runtime} scoped secret mode must be 0400`,
    );
    assert.equal(
      fileStat.uid,
      1000,
      `${runtime} scoped secret owner must be UID 1000`,
    );
    assert.equal(
      fileStat.gid,
      1000,
      `${runtime} scoped secret group must be GID 1000`,
    );
  }
}

async function materializeKafkaTls(secretsDir) {
  const kafkaDir = join(secretsDir, "kafka");
  await mkdir(kafkaDir, { recursive: true, mode: 0o700 });
  const password = randomUUID();
  const keystore = join(kafkaDir, "kafka.keystore.p12");
  const certificate = join(kafkaDir, "kafka.crt");
  const truststore = join(kafkaDir, "kafka.truststore.p12");
  execFileSync("keytool", [
    "-genkeypair",
    "-alias",
    "kafka",
    "-keyalg",
    "RSA",
    "-keysize",
    "2048",
    "-validity",
    "1",
    "-dname",
    "CN=kafka",
    "-ext",
    "SAN=dns:kafka,dns:localhost,ip:127.0.0.1",
    "-keystore",
    keystore,
    "-storetype",
    "PKCS12",
    "-storepass",
    password,
    "-keypass",
    password,
  ], { stdio: "ignore" });
  execFileSync("keytool", [
    "-exportcert",
    "-alias",
    "kafka",
    "-keystore",
    keystore,
    "-storepass",
    password,
    "-rfc",
    "-file",
    certificate,
  ], { stdio: "ignore" });
  execFileSync("keytool", [
    "-importcert",
    "-noprompt",
    "-alias",
    "kafka",
    "-file",
    certificate,
    "-keystore",
    truststore,
    "-storetype",
    "PKCS12",
    "-storepass",
    password,
  ], { stdio: "ignore" });
  await writeFile(join(kafkaDir, "kafka.keystore.password"), `${password}\n`, { encoding: "utf8", mode: 0o400 });
  await writeFile(join(kafkaDir, "kafka_jaas.conf"), [
    "KafkaServer {",
    "  org.apache.kafka.common.security.plain.PlainLoginModule required",
    `  username="kafka" password="${password}" user_kafka="${password}";`,
    "};",
    "",
  ].join("\n"), { encoding: "utf8", mode: 0o400 });
  await writeFile(join(kafkaDir, "client.properties"), [
    "security.protocol=SASL_SSL",
    "sasl.mechanism=PLAIN",
    `sasl.jaas.config=org.apache.kafka.common.security.plain.PlainLoginModule required username="kafka" password="${password}";`,
    "ssl.truststore.type=PKCS12",
    "ssl.truststore.location=/etc/kafka/secrets/kafka.truststore.p12",
    `ssl.truststore.password=${password}`,
    "ssl.endpoint.identification.algorithm=",
    "",
  ].join("\n"), { encoding: "utf8", mode: 0o400 });
  for (const path of [kafkaDir, keystore, certificate, truststore]) {
    await chown(path, 1000, 1000);
  }
  for (const name of ["kafka.keystore.password", "kafka_jaas.conf", "client.properties"]) {
    const path = join(kafkaDir, name);
    await chown(path, 1000, 1000);
    await chmod(path, 0o400);
  }
}

function ensureExternalNetwork(options) {
  const assertInternal = () => {
    const [network] = JSON.parse(
      runDocker(["network", "inspect", EXTERNAL_POSTGRES_NETWORK]),
    );
    assert.equal(
      network?.Internal,
      true,
      `${EXTERNAL_POSTGRES_NETWORK} must be an existing Internal network`,
    );
  };
  try {
    runDocker(["network", "inspect", EXTERNAL_POSTGRES_NETWORK]);
    assertInternal();
    return false;
  } catch {
    if (!options.provisionNetwork) {
      throw new Error(
        `${EXTERNAL_POSTGRES_NETWORK} is absent; create the pre-existing PostgreSQL network first or explicitly use --provision-empty-postgres-network`,
      );
    }
    runDocker([
      "network",
      "create",
      "--internal",
      "--label",
      "coffee.platform.compose-smoke=true",
      EXTERNAL_POSTGRES_NETWORK,
    ]);
    assertInternal();
    return true;
  }
}

async function writeDatabaseProofComposeOverride(projectName) {
  const path = join(
    SECRETS_TMPFS_ROOT,
    `coffee-platform-compose-${projectName}-${randomUUID().slice(0, 8)}.yaml`,
  );
  const content = [
    "networks:",
    ...COMPOSE_NETWORKS.flatMap((network) => [
      `  ${network}:`,
      `    name: ${projectName}_${network}`,
      `    external: ${network === EXTERNAL_POSTGRES_NETWORK ? "true" : "false"}`,
    ]),
    "",
  ].join("\n");
  await writeFile(path, content, { encoding: "utf8", mode: 0o400 });
  await chmod(path, 0o400);
  return path;
}

function databaseProofNetworkNames(projectName) {
  return COMPOSE_NETWORKS.map((network) => `${projectName}_${network}`);
}

function createDatabaseProofNetwork(networkName) {
  try {
    runDocker(["network", "inspect", networkName]);
  } catch {
    runDocker(["network", "create", "--internal", networkName]);
    return true;
  }
  throw new Error(`database proof network already exists: ${networkName}`);
}

function startDatabaseProofContainer(projectName, networkName, credential) {
  const container = `${projectName}-postgres-proof`;
  runDocker([
    "run",
    "--detach",
    "--name",
    container,
    "--network",
    networkName,
    "--network-alias",
    "coffee_postgres",
    "--env",
    `POSTGRES_USER=${credential.username}`,
    "--env",
    `POSTGRES_PASSWORD=${credential.password}`,
    "--env",
    "POSTGRES_DB=coffee_platform_customer",
    "--health-cmd",
    `pg_isready -U ${credential.username} -d coffee_platform_customer`,
    "--health-interval",
    "1s",
    "--health-timeout",
    "1s",
    "--health-retries",
    "30",
    DATABASE_PROOF_IMAGE,
  ]);
  return container;
}

function bootstrapDatabaseProofRole(container, admin, owner) {
  runDocker(
    [
      "exec",
      "--interactive",
      container,
      "psql",
      "--username",
      admin.username,
      "--dbname",
      "coffee_platform_customer",
      "--no-psqlrc",
    ],
    {
      input: [
        `CREATE ROLE "${owner.username}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD '${owner.password}';`,
        `REVOKE ALL ON DATABASE "coffee_platform_customer" FROM PUBLIC;`,
        `GRANT CONNECT ON DATABASE "coffee_platform_customer" TO "${owner.username}";`,
        "",
      ].join("\n"),
    },
  );
}

function assertDatabaseProofRole(container, admin, owner) {
  const output = runDocker(
    [
      "exec",
      "--interactive",
      container,
      "psql",
      "--username",
      admin.username,
      "--dbname",
      "coffee_platform_customer",
      "--tuples-only",
      "--no-align",
      "--no-psqlrc",
      "--command",
      `SELECT json_build_object('isSuperuser', rolsuper, 'canCreateDb', rolcreatedb, 'canCreateRole', rolcreaterole, 'bypassRls', rolbypassrls, 'connect', has_database_privilege('${owner.username}', 'coffee_platform_customer', 'CONNECT'), 'create', has_database_privilege('${owner.username}', 'coffee_platform_customer', 'CREATE')) FROM pg_roles WHERE rolname = '${owner.username}'`,
    ],
    {input: ""},
  ).trim();
  const role = JSON.parse(output.split("\n").at(-1));
  assert.deepEqual(
    role,
    {
      isSuperuser: false,
      canCreateDb: false,
      canCreateRole: false,
      bypassRls: false,
      connect: true,
      create: false,
    },
    "database proof owner role is over-privileged",
  );
}

async function waitForDockerHealthy(container, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let status = "unknown";
  while (Date.now() < deadline) {
    try {
      status = runDocker([
        "inspect",
        "--format",
        "{{.State.Health.Status}}",
        container,
      ]).trim();
    } catch {
      status = "unknown";
    }
    if (status === "healthy") return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${container} did not become healthy: ${status}`);
}

async function waitForDatabaseProofReady(container, admin, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let postmasterStart;
  while (Date.now() < deadline) {
    try {
      const output = runDocker(
        [
          "exec",
          "--interactive",
          container,
          "psql",
          "--username",
          admin.username,
          "--dbname",
          "coffee_platform_customer",
          "--host",
          "127.0.0.1",
          "--tuples-only",
          "--no-align",
          "--no-psqlrc",
          "--command",
          "SELECT pg_postmaster_start_time()",
        ],
        {input: ""},
      ).trim();
      const currentStart = output.split("\n").at(-1);
      if (currentStart !== undefined && currentStart === postmasterStart)
        return;
      postmasterStart = currentStart;
    } catch {
      postmasterStart = undefined;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`${container} database did not become queryable`);
}

function parseComposePs(output) {
  const trimmed = output.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return trimmed
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }
}

function serviceRows(projectName, secretsDir, composeFile = COMPOSE_FILE) {
  return parseComposePs(
    runCompose(projectName, secretsDir, ["ps", "--all", "--format", "json"], {
      composeFile,
    }),
  );
}

function assertHealthy(projectName, secretsDir, composeFile = COMPOSE_FILE) {
  const rows = serviceRows(projectName, secretsDir, composeFile);
  const byService = new Map(rows.map((row) => [row.Service, row]));
  for (const service of [...RUNTIMES, "kafka"]) {
    const row = byService.get(service);
    assert.ok(row, `${service} is absent from Compose ps`);
    assert.equal(row.State, "running", `${service} is not running`);
    assert.equal(row.Health, "healthy", `${service} is not healthy`);
  }
  return byService;
}

function assertTelemetryEnvironment(rows) {
  for (const runtime of RUNTIMES) {
    const row = rows.get(runtime);
    const container = JSON.parse(runDocker(["inspect", row.ID]))[0];
    const environment = Object.fromEntries(
      (container.Config.Env ?? []).map((entry) => {
        const separator = entry.indexOf("=");
        return [entry.slice(0, separator), entry.slice(separator + 1)];
      }),
    );
    assert.equal(
      environment.OTEL_SERVICE_NAME,
      runtime,
      `${runtime} OTEL service identity is missing`,
    );
    assert.equal(
      environment.OTEL_PROPAGATORS,
      "tracecontext,baggage",
      `${runtime} OTEL propagators drifted`,
    );
    assert.equal(
      environment.OTEL_RESOURCE_ATTRIBUTES,
      "service.namespace=coffee-platform,deployment.environment=development",
      `${runtime} OTEL resource identity drifted`,
    );
    assert.equal(
      environment.OTEL_EXPORTER_OTLP_PROTOCOL,
      "http/protobuf",
      `${runtime} OTEL protocol drifted`,
    );
  }
}

function assertSecretMounts(
  projectName,
  secretsDir,
  rows,
  composeFile = COMPOSE_FILE,
) {
  for (const runtime of RUNTIMES) {
    const row = rows.get(runtime);
    const container = JSON.parse(runDocker(["inspect", row.ID]))[0];
    const mount = container.Mounts.find(
      (candidate) =>
        candidate.Destination === "/run/secrets/coffee-platform.yaml",
    );
    assert.ok(mount, `${runtime} scoped secret mount is absent`);
    assert.equal(
      mount.RW,
      false,
      `${runtime} scoped secret mount must be read-only`,
    );
    assert.equal(
      resolve(mount.Source),
      resolve(join(secretsDir, `${runtime}.yaml`)),
      `${runtime} secret source is not the ephemeral tmpfs directory`,
    );
    assert.equal(
      container.Config.User,
      "node",
      `${runtime} image must run as node`,
    );
    const modeOutput = runCompose(
      projectName,
      secretsDir,
      [
        "exec",
        "-T",
        runtime,
        "node",
        "-e",
        "const fs=require('node:fs'); const {execFileSync}=require('node:child_process'); const s=fs.statSync(process.env.COFFEE_RUNTIME_SECRETS_FILE); const df=execFileSync('df',['-T','/run/secrets'],{encoding:'utf8'}); console.log(JSON.stringify({mode:s.mode & 0o777,uid:process.getuid(),tmpfs:df.includes('tmpfs')}));",
      ],
      {composeFile},
    ).trim();
    const mode = JSON.parse(modeOutput.split("\n").at(-1));
    assert.deepEqual(
      mode,
      { mode: 0o400, uid: 1000, tmpfs: true },
      `${runtime} scoped secret ownership/mode/tmpfs mismatch`,
    );
  }
}

function assertKafkaCompatibility(
  projectName,
  secretsDir,
  composeFile = COMPOSE_FILE,
) {
  const topic = `coffee.compose.smoke.${randomUUID().replaceAll("-", "")}`;
  const message = randomUUID();
  const script = [
    `topic=${topic}`,
    `message=${message}`,
    "/opt/kafka/bin/kafka-topics.sh --bootstrap-server kafka:9092 --command-config /etc/kafka/secrets/client.properties --create --if-not-exists --topic \"$topic\" --partitions 1 --replication-factor 1 >/dev/null",
    "printf '%s\\n' \"$message\" | /opt/kafka/bin/kafka-console-producer.sh --bootstrap-server kafka:9092 --command-config /etc/kafka/secrets/client.properties --topic \"$topic\"",
    "received=$(/opt/kafka/bin/kafka-console-consumer.sh --bootstrap-server kafka:9092 --command-config /etc/kafka/secrets/client.properties --topic \"$topic\" --group \"$topic\" --from-beginning --max-messages 1 --timeout-ms 15000 | tr -d '\\r')",
    "test \"$received\" = \"$message\"",
    "printf '%s' \"$received\"",
  ].join("\n");
  const output = runCompose(
    projectName,
    secretsDir,
    ["exec", "-T", "kafka", "sh", "-ec", script],
    {composeFile},
  ).trim();
  assert.equal(output, message, "Kafka SASL_SSL client produce/consume proof failed");
}

async function assertReadiness(
  projectName,
  secretsDir,
  composeFile = COMPOSE_FILE,
) {
  for (const runtime of RUNTIMES) {
    const output = runCompose(
      projectName,
      secretsDir,
      [
        "exec",
        "-T",
        runtime,
        "node",
        "-e",
        "Promise.all(['/health/live', '/health/ready', '/metrics'].map(async (path) => { const response = await fetch('http://127.0.0.1:' + process.env.PORT + path); if (!response.ok) throw new Error(path + ':' + response.status); })).catch(() => process.exit(1));",
      ],
      {composeFile},
    ).trim();
    void output;
  }
  for (const path of ["/health/live", "/health/ready", "/metrics"]) {
    const response = await fetch(`http://127.0.0.1:4000${path}`, {
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(
      response.status,
      200,
      `edge host endpoint ${path} is not available`,
    );
  }
}

function runtimeHealthStatus(
  projectName,
  secretsDir,
  runtime,
  path,
  composeFile = COMPOSE_FILE,
) {
  const output = runCompose(
    projectName,
    secretsDir,
    [
      "exec",
      "-T",
      runtime,
      "node",
      "-e",
      `fetch('http://127.0.0.1:' + process.env.PORT + '${path}').then((response) => console.log(response.status)).catch(() => console.log('0'))`,
    ],
    {composeFile},
  ).trim();
  return Number(output.split("\n").at(-1));
}

function runtimeReadinessStatus(
  projectName,
  secretsDir,
  runtime,
  composeFile = COMPOSE_FILE,
) {
  return runtimeHealthStatus(
    projectName,
    secretsDir,
    runtime,
    "/health/ready",
    composeFile,
  );
}

async function waitForRuntimeReadiness(
  projectName,
  secretsDir,
  runtime,
  expected,
  timeoutMs = 10_000,
  composeFile = COMPOSE_FILE,
) {
  const deadline = Date.now() + timeoutMs;
  let status = 0;
  while (Date.now() < deadline) {
    status = runtimeReadinessStatus(projectName, secretsDir, runtime, composeFile);
    if (status === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `${runtime} readiness did not reach ${expected}; last status was ${status}`,
  );
}

async function assertDatabaseProof(
  projectName,
  secretsDir,
  container,
  composeFile = COMPOSE_FILE,
) {
  assert.equal(
    runtimeReadinessStatus(
      projectName,
      secretsDir,
      DATABASE_PROOF_RUNTIME,
      composeFile,
    ),
    200,
    "customer-service database readiness did not start healthy",
  );
  for (const path of ["/health/live", "/metrics"]) {
    assert.equal(
      runtimeHealthStatus(
        projectName,
        secretsDir,
        DATABASE_PROOF_RUNTIME,
        path,
        composeFile,
      ),
      200,
      `customer-service ${path} did not start healthy`,
    );
  }
  runDocker(["stop", container]);
  await waitForRuntimeReadiness(
    projectName,
    secretsDir,
    DATABASE_PROOF_RUNTIME,
    503,
    10_000,
    composeFile,
  );
  runDocker(["start", container]);
  await waitForDockerHealthy(container);
  await waitForRuntimeReadiness(
    projectName,
    secretsDir,
    DATABASE_PROOF_RUNTIME,
    200,
    10_000,
    composeFile,
  );
  for (const path of ["/health/live", "/metrics"]) {
    assert.equal(
      runtimeHealthStatus(
        projectName,
        secretsDir,
        DATABASE_PROOF_RUNTIME,
        path,
        composeFile,
      ),
      200,
      `customer-service ${path} did not recover`,
    );
  }
}

function assertHostExposure(
  projectName,
  secretsDir,
  rows,
  composeFile = COMPOSE_FILE,
) {
  const edgeContainer = JSON.parse(
    runDocker(["inspect", rows.get("edge-gateway").ID]),
  )[0];
  const hostIngress = JSON.parse(
    runDocker(["network", "inspect", "coffee_host_ingress"]),
  )[0];
  assert.deepEqual(
    Object.keys(hostIngress.Containers ?? {}),
    [edgeContainer.Id],
    "coffee_host_ingress must contain only edge-gateway",
  );
  assert.equal(
    runCompose(
      projectName,
      secretsDir,
      ["port", "edge-gateway", "4000"],
      {composeFile},
    ).trim(),
    "127.0.0.1:4000",
    "edge-gateway must expose the actual loopback host mapping",
  );
  const edgeBindings =
    edgeContainer.HostConfig.PortBindings?.["4000/tcp"] ?? [];
  assert.deepEqual(
    edgeBindings.map((binding) => binding.HostPort),
    ["4000"],
    "edge-gateway must publish only host port 4000",
  );
  for (const runtime of RUNTIMES.filter(
    (candidate) => candidate !== "edge-gateway",
  )) {
    const container = JSON.parse(
      runDocker(["inspect", rows.get(runtime).ID]),
    )[0];
    const bindings = Object.values(
      container.HostConfig.PortBindings ?? {},
    ).flat();
    assert.deepEqual(
      bindings,
      [],
      `${runtime} unexpectedly publishes a host port`,
    );
  }
}

function assertStopped(projectName, secretsDir, composeFile = COMPOSE_FILE) {
  for (const row of serviceRows(projectName, secretsDir, composeFile)) {
    const container = JSON.parse(runDocker(["inspect", row.ID]))[0];
    assert.equal(
      container.State.Running,
      false,
      `${row.Service} did not stop after SIGTERM`,
    );
    const expectedExitCodes = row.Service === "kafka" ? [0, 143] : [0];
    assert.ok(
      expectedExitCodes.includes(container.State.ExitCode),
      `${row.Service} exited with ${container.State.ExitCode}`,
    );
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const projectName =
    options.projectName ??
    `coffee-compose-smoke-${process.pid}-${randomUUID().slice(0, 8)}`;
  const secretsDir = await mkdtemp(
    join(SECRETS_TMPFS_ROOT, "coffee-platform-secrets-"),
  );
  let provisionedNetwork = false;
  let databaseProofNetwork;
  let composeFile = COMPOSE_FILE;
  let composeAttempted = false;
  let databaseProofContainer;
  try {
    const databaseProofCredentials = options.databaseProof
      ? await readDatabaseProofCredentials()
      : undefined;
    if (options.databaseProof) {
      composeFile = await writeDatabaseProofComposeOverride(projectName);
      const networkNames = databaseProofNetworkNames(projectName);
      for (const networkName of networkNames) {
        try {
          runDocker(["network", "inspect", networkName]);
        } catch {
          continue;
        }
        throw new Error(`database proof network already exists: ${networkName}`);
      }
      databaseProofNetwork = `${projectName}_${EXTERNAL_POSTGRES_NETWORK}`;
      createDatabaseProofNetwork(databaseProofNetwork);
    }
    await materializeSecrets(secretsDir, {
      ...options,
      databaseProofCredentials: databaseProofCredentials === undefined
        ? undefined
        : {[DATABASE_PROOF_RUNTIME]: databaseProofCredentials.owner},
    });
    runCompose(projectName, secretsDir, ["config", "--quiet"], {composeFile});
    if (!options.databaseProof)
      provisionedNetwork = ensureExternalNetwork(options);
    if (options.databaseProof) {
      databaseProofContainer = startDatabaseProofContainer(
        projectName,
        databaseProofNetwork,
        databaseProofCredentials.admin,
      );
      await waitForDockerHealthy(databaseProofContainer);
      await waitForDatabaseProofReady(
        databaseProofContainer,
        databaseProofCredentials.admin,
      );
      bootstrapDatabaseProofRole(
        databaseProofContainer,
        databaseProofCredentials.admin,
        databaseProofCredentials.owner,
      );
      assertDatabaseProofRole(
        databaseProofContainer,
        databaseProofCredentials.admin,
        databaseProofCredentials.owner,
      );
    }
    if (!options.noBuild)
      buildRuntimeImages(
        projectName,
        options.databaseProof ? [DATABASE_PROOF_RUNTIME] : RUNTIMES,
      );
    const upArguments = options.databaseProof
      ? [
          "up",
          "--detach",
          "--wait",
          "--no-build",
          DATABASE_PROOF_RUNTIME,
        ]
      : ["up", "--detach", "--wait", "--no-build"];
    composeAttempted = true;
    runCompose(projectName, secretsDir, upArguments, {composeFile, inherit: true});
    const rows = options.databaseProof
      ? new Map(
          serviceRows(projectName, secretsDir, composeFile).map((row) => [row.Service, row]),
        )
      : assertHealthy(projectName, secretsDir, composeFile);
    if (options.databaseProof) {
      const row = rows.get(DATABASE_PROOF_RUNTIME);
      assert.ok(row, `${DATABASE_PROOF_RUNTIME} is absent from Compose ps`);
      assert.equal(row.State, "running");
      assert.equal(row.Health, "healthy");
      await assertDatabaseProof(
        projectName,
        secretsDir,
        databaseProofContainer,
        composeFile,
      );
    } else {
      assertKafkaCompatibility(projectName, secretsDir, composeFile);
      assertTelemetryEnvironment(rows);
      assertSecretMounts(projectName, secretsDir, rows, composeFile);
      await assertReadiness(projectName, secretsDir, composeFile);
      assertHostExposure(projectName, secretsDir, rows, composeFile);
    }
    if (!options.keep) {
      runCompose(
        projectName,
        secretsDir,
        ["stop", "--timeout", "30"],
        {composeFile, inherit: true},
      );
      assertStopped(projectName, secretsDir, composeFile);
    }
    console.log(
      JSON.stringify({
        project: projectName,
        runtimes: options.databaseProof ? 1 : RUNTIMES.length,
        kafka: !options.databaseProof,
        kafkaCompatibility: !options.databaseProof,
        telemetry: !options.databaseProof,
        healthEndpoints: ["/health/live", "/health/ready", "/metrics"],
        stubSecrets: options.stubSecrets || options.databaseProof,
        dbIntegrationProof: options.databaseProof,
        hostPublish: options.databaseProof ? [] : ["4000:4000"],
        gracefulShutdown: true,
      }),
    );
  } finally {
    if (composeAttempted && !options.keep) {
      try {
        runCompose(
          projectName,
          secretsDir,
          options.databaseProof
            ? ["down", "--volumes", "--remove-orphans"]
            : ["down", "--remove-orphans"],
          {composeFile},
        );
      } catch {
        /* preserve original smoke failure */
      }
    }
    if (databaseProofContainer && !options.keep) {
      try {
        runDocker(["rm", "--force", "--volumes", databaseProofContainer]);
      } catch {
        /* preserve original smoke failure */
      }
    }
    if (databaseProofNetwork && !options.keep) {
      try {
        runDocker(["network", "rm", databaseProofNetwork]);
      } catch {
        /* preserve original smoke failure */
      }
    }
    if (provisionedNetwork && !options.keep) {
      try {
        runDocker(["network", "rm", EXTERNAL_POSTGRES_NETWORK]);
      } catch {
        /* never remove a network adopted by another workload */
      }
    }
    if (composeFile !== COMPOSE_FILE && !options.keep)
      await rm(composeFile, {force: true});
    if (!options.keep) await rm(secretsDir, { recursive: true, force: true });
    else
      console.log(
        `compose-smoke: kept project=${projectName} secretsDir=${secretsDir}`,
      );
  }
}

try {
  await main();
} catch (error) {
  console.error(
    `compose-smoke: FAIL: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
