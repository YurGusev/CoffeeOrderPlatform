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
import { Buffer } from "node:buffer";
import { execFileSync, spawn } from "node:child_process";
import {request as httpsRequest} from "node:https";
import { join, resolve } from "node:path";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { load as parseYaml } from "js-yaml";
import {parsePublicTlsHostname, parsePublicTlsMaterial, parseServiceTransportMaterial, verifyTransportPeer} from "../packages/platform-security/src/index.ts";
import pg from "pg";
import {
  SERVER_IDENTITY_SQL,
  bootstrapDatabases,
  readJson,
  replaceDatabase,
  validateServerProbe,
} from "../scripts/db-bootstrap.mjs";
import {
  createDeliveryTables,
  dropDeliveryTables,
} from "../scripts/db-live-proof.mjs";

const { Client } = pg;

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
const RUNTIME_HEALTHCHECK = [
  "node",
  "-e",
  "import('@coffee-platform/runtime/healthcheck').then(({main}) => main(process.argv.slice(1)))",
];
const RUNTIME_HEALTH_STATUSES = [
  "node",
  "-e",
  "import('@coffee-platform/runtime/healthcheck').then(async ({readRuntimeHealthStatuses}) => { for (const status of await readRuntimeHealthStatuses(process.argv.slice(1))) console.log(status); }).catch((error) => { console.error(error instanceof Error ? error.message : 'runtime healthcheck failed'); process.exitCode = 1; })",
];
function usage() {
  return [
    "Usage: node tools/compose-smoke.mjs [options]",
    "",
    "Options:",
    "  --stub-secrets                     use empty, non-secret scoped stubs for topology-only smoke",
    "  --database-proof                  run the isolated customer PostgreSQL readiness proof",
    "  --recovery-proof                  run the isolated full 15-runtime PostgreSQL/Kafka recovery proof",
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
    recoveryProof: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--stub-secrets") options.stubSecrets = true;
    else if (argument === "--provision-empty-postgres-network")
      options.provisionNetwork = true;
    else if (argument === "--no-build") options.noBuild = true;
    else if (argument === "--database-proof") options.databaseProof = true;
    else if (argument === "--recovery-proof") options.recoveryProof = true;
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
  if (options.databaseProof && options.recoveryProof)
    throw new Error("--database-proof and --recovery-proof are mutually exclusive");
  if (options.recoveryProof && options.stubSecrets)
    throw new Error("--recovery-proof requires generated fixture credentials, not --stub-secrets");
  if (!options.stubSecrets && !options.databaseProof && !options.recoveryProof && !process.env.SOPS_AGE_KEY_FILE) {
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
    stdio: options.inherit
      ? "inherit"
      : [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    input: options.input,
  });
}

function spawnCompose(projectName, secretsDir, args, options = {}) {
  const env = {
    ...process.env,
    COFFEE_COMPOSE_SECRETS_DIR: secretsDir,
  };
  const child = spawn("docker", composeArgs(projectName, args, options.composeFile), {
    cwd: ROOT,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  let errorOutput = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { output += chunk; options.onOutput?.(chunk); });
  child.stderr.on("data", (chunk) => { errorOutput += chunk; });
  child.stdin.end(options.input ?? "");
  const done = new Promise((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolvePromise({output, errorOutput, signal});
      else reject(new Error(`docker compose exec exited ${code ?? signal}: ${errorOutput.trim()}`));
    });
  });
  return {child, done};
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

async function writeStubSecret(
  path,
  runtime,
  environment,
  refs,
  optionalRefs,
  databaseCredential,
  kafkaCredential,
  transportMaterial,
  publicTlsMaterial,
  securityMaterial,
) {
  // Ephemeral credentials belong only to this isolated run; placeholders do
  // not establish provider access or canonical SOPS provisioning.
  const secrets = {};
  for (const ref of refs) {
    const segments = ref.split(".");
    let current = secrets;
    for (const segment of segments.slice(0, -1)) {
      if (!Object.hasOwn(current, segment)) current[segment] = {};
      current = current[segment];
    }
    current[segments.at(-1)] = securityMaterial?.[ref] ?? (ref === `security.serviceTransportKeys.${runtime}`
      ? transportMaterial
      : ref === "edge.tlsPrivateKey" && publicTlsMaterial !== undefined
        ? publicTlsMaterial.keyPem
        : ref === "edge.tlsCertificate" && publicTlsMaterial !== undefined
          ? publicTlsMaterial.certPem
      : ref.startsWith("postgres.") && databaseCredential !== undefined
        ? databaseCredential
        : ref.startsWith("kafka.") && kafkaCredential !== undefined
          ? kafkaCredential
        : ref.startsWith("postgres.")
          ? {
              username: `compose_${runtime.replaceAll("-", "_")}`,
              password: "compose-smoke-placeholder",
            }
          : "compose-smoke-placeholder");
  }
  for (const ref of optionalRefs) {
    const value = ref === "edge.tlsCaBundle" ? publicTlsMaterial?.caPem : undefined;
    if (value === undefined) continue;
    const segments = ref.split(".");
    let current = secrets;
    for (const segment of segments.slice(0, -1)) {
      if (!Object.hasOwn(current, segment)) current[segment] = {};
      current = current[segment];
    }
    current[segments.at(-1)] = value;
  }
  const content = `${JSON.stringify({ schemaVersion: 1, environment, runtime, secrets })}\n`;
  await writeFile(path, content, { encoding: "utf8", mode: 0o400 });
  await chmod(path, 0o400);
}

function createEd25519KeySet() {
  const keyPair = () => generateKeyPairSync("ed25519");
  const active = keyPair();
  const previous = keyPair();
  const publicPem = (key) => key.export({type: "spki", format: "pem"});
  return {
    privateKey: active.privateKey.export({type: "pkcs8", format: "pem"}),
    verificationKeys: {active: publicPem(active.publicKey), previous: publicPem(previous.publicKey)},
  };
}

function createStubSecurityMaterial() {
  const actor = createEd25519KeySet();
  const apiPublicDelegation = createEd25519KeySet();
  const apiInternalDelegation = createEd25519KeySet();
  const ordersService = createEd25519KeySet();
  const customerCursor = createEd25519KeySet();
  return {
    "security.actorContextEdgeSigningPrivateKey": actor.privateKey,
    "security.actorContextEdgeVerificationPublicKeys": actor.verificationKeys,
    "security.apiPublicDelegationSigningPrivateKey": apiPublicDelegation.privateKey,
    "security.apiInternalDelegationSigningPrivateKey": apiInternalDelegation.privateKey,
    "security.serviceVerificationKeys.orders-service": ordersService.verificationKeys,
    "security.customerCursorSigningPrivateKey": customerCursor.privateKey,
    "security.customerCursorVerificationPublicKeys": customerCursor.verificationKeys,
    "security.delegationVerificationKeys.api-public": apiPublicDelegation.verificationKeys,
    "security.delegationVerificationKeys.api-internal": apiInternalDelegation.verificationKeys,
  };
}

async function createStubTransportMaterials(secretsDir, environment, publicHostname) {
  const directory = join(secretsDir, "transport-ca");
  await mkdir(directory, {recursive: true, mode: 0o700});
  const caKey = join(directory, "ca.key");
  const caCert = join(directory, "ca.crt");
  const serial = join(directory, "ca.srl");
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", caKey, "-out", caCert, "-days", "1",
    "-subj", "/CN=coffee-platform-compose-smoke-ca",
  ], {stdio: "ignore"});
  const caPem = await readFile(caCert, "utf8");
  const materials = new Map();
  for (const [index, runtime] of RUNTIMES.entries()) {
    const prefix = join(directory, runtime);
    const key = `${prefix}.key`;
    const csr = `${prefix}.csr`;
    const cert = `${prefix}.crt`;
    const ext = `${prefix}.ext`;
    await writeFile(ext, [
      `subjectAltName=URI:spiffe://coffee-platform/${environment}/${runtime}`,
      "extendedKeyUsage=serverAuth,clientAuth",
      "",
    ].join("\n"), {encoding: "utf8", mode: 0o400});
    execFileSync("openssl", [
      "req", "-new", "-newkey", "rsa:2048", "-nodes",
      "-keyout", key, "-out", csr, "-subj", `/CN=${runtime}`,
    ], {stdio: "ignore"});
    execFileSync("openssl", [
      "x509", "-req", "-in", csr, "-CA", caCert, "-CAkey", caKey,
      ...(index === 0 ? ["-CAcreateserial"] : ["-CAserial", serial]),
      "-out", cert, "-days", "1", "-sha256", "-extfile", ext,
    ], {stdio: "ignore"});
    materials.set(runtime, JSON.stringify({
      caPem,
      certPem: await readFile(cert, "utf8"),
      keyPem: await readFile(key, "utf8"),
    }));
  }
  const publicCaKey = join(directory, "edge-public-ca.key");
  const publicCaCert = join(directory, "edge-public-ca.crt");
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", publicCaKey, "-out", publicCaCert, "-days", "1",
    "-subj", "/CN=coffee-platform-compose-public-ca",
    "-addext", "basicConstraints=critical,CA:TRUE",
    "-addext", "keyUsage=critical,keyCertSign,cRLSign",
  ], {stdio: "ignore"});
  const publicCaPem = await readFile(publicCaCert, "utf8");
  const publicKey = join(directory, "edge-public.key");
  const publicCsr = join(directory, "edge-public.csr");
  const publicCert = join(directory, "edge-public.crt");
  const publicExt = join(directory, "edge-public.ext");
  await writeFile(publicExt, [
    `subjectAltName=DNS:${publicHostname}`,
    "extendedKeyUsage=serverAuth",
    "",
  ].join("\n"), {encoding: "utf8", mode: 0o400});
  execFileSync("openssl", [
    "req", "-new", "-newkey", "rsa:2048", "-nodes",
    "-keyout", publicKey, "-out", publicCsr, "-subj", `/CN=${publicHostname}`,
  ], {stdio: "ignore"});
  execFileSync("openssl", [
    "x509", "-req", "-in", publicCsr, "-CA", publicCaCert, "-CAkey", publicCaKey,
    "-CAcreateserial", "-out", publicCert, "-days", "1", "-sha256", "-extfile", publicExt,
  ], {stdio: "ignore"});
  return {
    service: materials,
    publicTls: {
      keyPem: await readFile(publicKey, "utf8"),
      certPem: await readFile(publicCert, "utf8"),
      caPem: publicCaPem,
    },
  };
}

async function readDatabaseProofCredentials() {
  const ownership = await readJson(join(ROOT, "config/database-ownership.json"));
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

async function readRecoveryProofCredentials() {
  const ownership = await readJson(join(ROOT, "config/database-ownership.json"));
  const roleMap = await readJson(join(ROOT, "config/database-role-map.json"));
  const runtimeClaims = ownership.runtimeClaims.filter(
    (claim) => claim.database !== null && claim.role !== null,
  );
  assert.equal(
    ownership.databases.length,
    5,
    "recovery proof requires five owner databases",
  );
  assert.equal(
    runtimeClaims.length,
    10,
    "recovery proof requires ten runtime database roles",
  );
  const rolePasswords = Object.fromEntries(
    roleMap.databases.flatMap((database) => [
      [database.migratorRole, `compose-migrator-${randomUUID()}`],
      ...database.runtimeRoles.map((runtime) => [
        runtime.role,
        `compose-runtime-${randomUUID()}`,
      ]),
    ]),
  );
  const admin = {
    username: `compose_admin_${randomUUID().replaceAll("-", "")}`,
    password: `compose-admin-${randomUUID()}`,
  };
  return {
    roleMap,
    ownership,
    admin,
    rolePasswords,
    databaseCredentialsByRuntime: Object.fromEntries(
      runtimeClaims.map((claim) => [
        claim.runtime,
        { username: claim.role, password: rolePasswords[claim.role] },
      ]),
    ),
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
  const kafkaCredential = await materializeKafkaTls(secretsDir);
  const platformConfig = parseYaml(
    await readFile(join(ROOT, "config/platform.yaml"), "utf8"),
    { json: true },
  );
  const publicHostname = parsePublicTlsHostname(platformConfig.platform?.publicBaseUrl);
  const stubTransportMaterials = options.stubSecrets || options.databaseProof || options.recoveryProof
    ? await createStubTransportMaterials(secretsDir, platformConfig.environment, publicHostname)
    : undefined;
  const stubSecurityMaterial = stubTransportMaterials === undefined ? undefined : createStubSecurityMaterial();
  for (const runtime of RUNTIMES) {
    const path = join(secretsDir, `${runtime}.yaml`);
    if (options.stubSecrets || options.databaseProof || options.recoveryProof) {
      const service = platformConfig.services[runtime];
      await writeStubSecret(
        path,
        runtime,
        platformConfig.environment,
        service.secretRefs,
        service.optionalSecretRefs ?? [],
        options.databaseProofCredentials?.[runtime] ??
          options.recoveryProofCredentials?.databaseCredentialsByRuntime?.[runtime],
        options.recoveryProof ? kafkaCredential : undefined,
        stubTransportMaterials?.service.get(runtime),
        runtime === "edge-gateway" ? stubTransportMaterials?.publicTls : undefined,
        stubSecurityMaterial,
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
  return { kafkaCredential };
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
  return {
    username: "kafka",
    password,
    caPem: await readFile(certificate, "utf8"),
  };
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

async function writeScopedComposeOverride(projectName) {
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

function startDatabaseProofContainer(
  projectName,
  networkName,
  credential,
  { initialDatabase = "coffee_platform_customer", publishHost = false } = {},
) {
  const container = `${projectName}-postgres-proof`;
  const args = [
    "run",
    "--detach",
    "--name",
    container,
    "--network",
    ...(publishHost ? ["bridge"] : [networkName, "--network-alias", "coffee_postgres"]),
    "--env",
    `POSTGRES_USER=${credential.username}`,
    "--env",
    `POSTGRES_PASSWORD=${credential.password}`,
    "--env",
    `POSTGRES_DB=${initialDatabase}`,
    "--health-cmd",
    `pg_isready -U ${credential.username} -d ${initialDatabase}`,
    "--health-interval",
    "1s",
    "--health-timeout",
    "1s",
    "--health-retries",
    "30",
    ...(publishHost ? ["--publish", "127.0.0.1::5432"] : []),
    DATABASE_PROOF_IMAGE,
  ];
  runDocker(args);
  if (publishHost) {
    runDocker(["network", "connect", "--alias", "coffee_postgres", networkName, container]);
  }
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

async function waitForDatabaseProofReady(
  container,
  admin,
  databaseName = "coffee_platform_customer",
  timeoutMs = 60_000,
) {
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
          databaseName,
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

function publishedDatabasePort(container) {
  const output = runDocker([
    "inspect",
    "--format",
    '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}',
    container,
  ]).trim();
  assert.match(output, /^\d+$/, "database proof did not publish PostgreSQL");
  return Number(output);
}

async function createPostgresClient(connectionString) {
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: 1000,
    query_timeout: 2000,
    statement_timeout: 2000,
  });
  client.on("error", () => {});
  try {
    await client.connect();
    return client;
  } catch (error) {
    await client.end().catch(() => undefined);
    throw error;
  }
}

async function waitForPostgresClient(connectionString, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const client = await createPostgresClient(connectionString);
      try {
        await client.query("SELECT 1");
      } finally {
        await client.end();
      }
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(
    `database proof host connection did not become ready: ${lastError?.message ?? "timeout"}`,
  );
}

async function bootstrapRecoveryDatabases(container, proofCredentials) {
  const port = publishedDatabasePort(container);
  const adminUrl = `postgresql://${encodeURIComponent(proofCredentials.admin.username)}:${encodeURIComponent(proofCredentials.admin.password)}@127.0.0.1:${port}/postgres`;
  await waitForPostgresClient(adminUrl);
  const adminClient = await createPostgresClient(adminUrl);
  try {
    const probe = (await adminClient.query(SERVER_IDENTITY_SQL)).rows[0];
    const identity = validateServerProbe(probe, {
      expectedServerIdentity: probe.system_identifier,
    });
    const connectClient = async (database) =>
      createPostgresClient(replaceDatabase(adminUrl, database));
    const result = await bootstrapDatabases({
      adminClient,
      adminUrl,
      connectClient,
      roleMap: proofCredentials.roleMap,
      ownership: proofCredentials.ownership,
      rolePasswords: proofCredentials.rolePasswords,
      expectedServerIdentity: identity.serverIdentity,
    });
    assert.equal(result.databases.length, 5);
    assert.equal(result.runtimeRoleCount, 10);
    return {
      port,
      databases: result.databases,
      runtimeRoleCount: result.runtimeRoleCount,
      idempotent: result.idempotent,
    };
  } finally {
    await adminClient.end();
  }
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

function assertKafkaDurableRetention(
  projectName,
  secretsDir,
  composeFile = COMPOSE_FILE,
) {
  const topic = `coffee.compose.smoke.${randomUUID().replaceAll("-", "")}`;
  const message = randomUUID();
  const produceScript = [
    `topic=${topic}`,
    `message=${message}`,
    "/opt/kafka/bin/kafka-topics.sh --bootstrap-server kafka:9092 --command-config /etc/kafka/secrets/client.properties --create --if-not-exists --topic \"$topic\" --partitions 1 --replication-factor 1 >/dev/null",
    "printf '%s\\n' \"$message\" | /opt/kafka/bin/kafka-console-producer.sh --sync --command-property acks=all --bootstrap-server kafka:9092 --command-config /etc/kafka/secrets/client.properties --topic \"$topic\"",
    "printf 'broker-ack:%s' \"$message\"",
  ].join("\n");
  const before = serviceRows(projectName, secretsDir, composeFile).find(
    (row) => row.Service === "kafka",
  );
  assert.ok(before, "Kafka is absent before retention proof");
  const beforeContainer = JSON.parse(runDocker(["inspect", before.ID]))[0];
  const logVolume = beforeContainer.Mounts.find((mount) => mount.Type === "volume" && mount.Destination === "/var/lib/kafka/data");
  assert.equal(logVolume?.Name, `${projectName}_kafka_data`, "Kafka log directory must use the project volume");
  assert.ok(beforeContainer.Config.Env.includes(`KAFKA_LOG_DIRS=${logVolume.Destination}`), "Kafka configured log directory differs from its volume");
  assert.equal(
    beforeContainer.Config.Labels?.["com.docker.compose.project"],
    projectName,
    "Kafka container is outside the requested Compose project",
  );
  const acknowledged = runCompose(
    projectName,
    secretsDir,
    ["exec", "-T", "kafka", "sh", "-ec", produceScript],
    {composeFile},
  ).trim();
  assert.equal(
    acknowledged,
    `broker-ack:${message}`,
    "Kafka broker acknowledgement was not observed",
  );

  runCompose(
    projectName,
    secretsDir,
    ["rm", "--force", "--stop", "kafka"],
    {composeFile},
  );
  runCompose(
    projectName,
    secretsDir,
    ["up", "--detach", "--wait", "--no-build", "kafka"],
    {composeFile},
  );

  const after = serviceRows(projectName, secretsDir, composeFile).find(
    (row) => row.Service === "kafka",
  );
  assert.ok(after, "Kafka is absent after broker recreate");
  assert.notEqual(after.ID, before.ID, "Kafka container was not recreated");
  assert.equal(after.State, "running", "Kafka is not running after recreate");
  assert.equal(after.Health, "healthy", "Kafka is not healthy after recreate");
  const afterContainer = JSON.parse(runDocker(["inspect", after.ID]))[0];
  assert.ok(afterContainer.Mounts.some((mount) => mount.Name === logVolume.Name && mount.Destination === logVolume.Destination), "Kafka recreate changed its log volume");
  assert.equal(
    afterContainer.Config.Labels?.["com.docker.compose.project"],
    projectName,
    "Kafka recreate changed the Compose project scope",
  );

  const recoveryScript = [
    `topic=${topic}`,
    `message=${message}`,
    "received=$(/opt/kafka/bin/kafka-console-consumer.sh --bootstrap-server kafka:9092 --command-config /etc/kafka/secrets/client.properties --topic \"$topic\" --group \"$topic-recovery\" --from-beginning --max-messages 1 --timeout-ms 15000 | tr -d '\\r')",
    "test \"$received\" = \"$message\"",
    "printf '%s' \"$received\"",
  ].join("\n");
  const retained = runCompose(
    projectName,
    secretsDir,
    ["exec", "-T", "kafka", "sh", "-ec", recoveryScript],
    {composeFile},
  ).trim();
  assert.equal(
    retained,
    message,
    "Kafka acknowledged record was not retained across broker recreate",
  );
  return {
    brokerAcknowledged: true,
    logDirectory: logVolume.Destination,
    volume: logVolume.Name,
    containerRecreated: true,
    sameComposeProject: true,
    recoveredHealthy: true,
    retainedRecord: true,
    replicationFactor: 1,
  };
}

async function prepareKafkaNativeFixture(
  projectName,
  secretsDir,
  runId,
  composeFile = COMPOSE_FILE,
) {
  const platformConfig = parseYaml(
    await readFile(join(ROOT, "config/platform.yaml"), "utf8"),
    {json: true},
  );
  const lifecycleTopic = platformConfig.kafka.topics.ordersLifecycle.name;
  const mappingTopic = platformConfig.kafka.topics.catalogMapping.name;
  const lifecyclePartitions = platformConfig.kafka.topics.ordersLifecycle.partitions;
  const mappingPartitions = platformConfig.kafka.topics.catalogMapping.partitions;
  const malformed = `issue63-malformed-${runId}`;
  const malformedEnvelope = {
    envelopeVersion: "1",
    messageId: malformed,
    messageType: "Issue63.LiveEvent",
    occurredAt: new Date().toISOString(),
    producer: "orders-service",
    correlationId: `correlation-${malformed}`,
    causationId: null,
    traceparent: `00-${randomUUID().replaceAll("-", "")}-${randomUUID().replaceAll("-", "").slice(0, 16)}-01`,
    aggregate: {type: "Issue63.Proof", ref: `issue63-malformed-${runId}`, version: "1"},
    payload: {value: "malformed-header", sequence: 1},
  };
  const malformedEncoded = Buffer.from(
    JSON.stringify(malformedEnvelope),
    "utf8",
  ).toString("base64");
  const script = [
    `lifecycle=${JSON.stringify(lifecycleTopic)}`,
    `mapping=${JSON.stringify(mappingTopic)}`,
    `lifecyclePartitions=${lifecyclePartitions}`,
    `mappingPartitions=${mappingPartitions}`,
    `/opt/kafka/bin/kafka-topics.sh --bootstrap-server kafka:9092 --command-config /etc/kafka/secrets/client.properties --create --if-not-exists --topic "$lifecycle" --partitions "$lifecyclePartitions" --replication-factor 1 >/dev/null`,
    `/opt/kafka/bin/kafka-topics.sh --bootstrap-server kafka:9092 --command-config /etc/kafka/secrets/client.properties --create --if-not-exists --topic "$mapping" --partitions "$mappingPartitions" --replication-factor 1 >/dev/null`,
    `/opt/kafka/bin/kafka-consumer-groups.sh --bootstrap-server kafka:9092 --command-config /etc/kafka/secrets/client.properties --group orders-aroma-preparation-v1 --topic "$lifecycle" --reset-offsets --to-earliest --execute >/dev/null`,
    `/opt/kafka/bin/kafka-consumer-groups.sh --bootstrap-server kafka:9092 --command-config /etc/kafka/secrets/client.properties --group orders-catalog-mapping-v2 --topic "$mapping" --reset-offsets --to-earliest --execute >/dev/null`,
    `printf '%s;%s|%s\\n' 'messageId:null' 'native-malformed' "$(printf '%s' '${malformedEncoded}' | base64 -d)" | /opt/kafka/bin/kafka-console-producer.sh --sync --command-property acks=all --property parse.headers=true --property headers.delimiter=';' --property headers.separator=',' --property headers.key.separator=':' --property null.marker=null --property parse.key=true --property key.separator='|' --bootstrap-server kafka:9092 --command-config /etc/kafka/secrets/client.properties --topic "$lifecycle" >/dev/null`,
  ].join("\n");
  runCompose(
    projectName,
    secretsDir,
    ["exec", "-T", "kafka", "sh", "-ec", script],
    {composeFile},
  );
  return {lifecycleTopic, mappingTopic, malformed, malformedEnvelope};
}

function nativeFoundationSource({
  runId,
  lifecycleTopic,
  mappingTopic,
  malformed,
  malformedEnvelope,
}) {
  return `import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';

const runId = ${JSON.stringify(runId)};
const lifecycleTopic = ${JSON.stringify(lifecycleTopic)};
const mappingTopic = ${JSON.stringify(mappingTopic)};
const malformed = ${JSON.stringify(malformed)};
const malformedEnvelope = ${JSON.stringify(malformedEnvelope)};
const runtimeRequire = createRequire(createRequire('/app/package.json').resolve('@coffee-platform/runtime'));
const importPackage = (name) => import(pathToFileURL(runtimeRequire.resolve(name)).href);
const kafkaRequire = createRequire(runtimeRequire.resolve('@coffee-platform/kafka-runtime'));
const importKafkaPackage = (name) => import(pathToFileURL(kafkaRequire.resolve(name)).href);
const {load} = await import(pathToFileURL(runtimeRequire.resolve('js-yaml')).href);
const configModule = await importPackage('@coffee-platform/config');
const databaseModule = await importPackage('@coffee-platform/database');
const {withTransaction} = databaseModule;
const ownerModule = await importPackage('@coffee-platform/database/owner');
const inboxModule = await importKafkaPackage('@coffee-platform/inbox');
const outboxModule = await importKafkaPackage('@coffee-platform/outbox');
const kafkaModule = await importPackage('@coffee-platform/kafka-runtime');
const nativeModule = await import(pathToFileURL(runtimeRequire.resolve('@coffee-platform/kafka-runtime')).href.replace(/index\\.js$/u, 'native.js'));
const config = await configModule.loadPlatformConfig('/app/config/platform.yaml', (text) => load(text, {json: true}));
const secret = load(await readFile('/run/secrets/coffee-platform.yaml', 'utf8'), {json: true});
const at = (path) => path.split('.').reduce((value, key) => value && typeof value === 'object' ? value[key] : undefined, secret.secrets);
const databaseCredential = at('postgres.ordersService');
const kafkaCredential = at('kafka.orders');
if (!databaseCredential || !kafkaCredential) throw new Error('scoped proof credentials are missing');
const ordersService = config.services['orders-service'];
const preparationService = config.services['orders-aroma-preparation'];
if (!ordersService.dbPool || !preparationService.kafka) throw new Error('proof service configuration is missing');
const delivery = config.kafka.delivery;
const databaseOptions = {
  owner: 'orders-service',
  database: ordersService.database,
  allowedDatabase: ordersService.database,
  host: config.postgres.host,
  port: config.postgres.port,
  user: databaseCredential.username,
  password: databaseCredential.password,
  ssl: config.postgres.sslMode === 'prefer' ? 'prefer' : true,
  pool: ordersService.dbPool,
  shutdownGraceMs: config.platform.shutdownGraceMs,
};
let database = databaseModule.createDatabase(databaseOptions);
await database.resource.start(AbortSignal.timeout(delivery.shutdownTimeoutMs));
const inboxOptions = {schema: 'orders', table: 'issue63_live_inbox_messages', quarantineTable: 'issue63_live_inbox_quarantine'};
const outboxOptions = {schema: 'orders', table: 'issue63_live_outbox_messages'};
let inbox = inboxModule.createSqlInboxStore(database, inboxOptions);
let outbox = outboxModule.createSqlOutboxStore(database, outboxOptions);
let ownerWrite = ownerModule.defineStatement(database, 'INSERT INTO orders.issue63_live_owner_effects (message_id, aggregate_ref, effect_value, applied_at) VALUES ($1, $2, $3, $4::timestamptz)');
const countRows = ownerModule.defineStatement(database, 'SELECT (SELECT count(*)::int FROM orders.issue63_live_owner_effects WHERE aggregate_ref = $1) AS owner_count, (SELECT count(*)::int FROM orders.issue63_live_inbox_messages WHERE message_id = ANY($2::text[])) AS inbox_count, (SELECT count(*)::int FROM orders.issue63_live_outbox_messages WHERE message_id = ANY($2::text[])) AS outbox_count, (SELECT count(*)::int FROM orders.issue63_live_inbox_quarantine WHERE reason = $3 AND envelope = $4::jsonb) AS malformed_count, (SELECT count(*)::int FROM orders.issue63_live_inbox_quarantine WHERE reason = $5 AND message_id = $6) AS conflict_count');
const waitFor = async (predicate, timeoutMs = 15000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('bounded proof wait exceeded');
};
const queryProofRows = async (aggregateRef, ids, malformedValue, conflictId) => withTransaction(database, {mode: 'background'}, (transaction) => countRows(transaction, [aggregateRef, ids, 'KAFKA_ENVELOPE_INVALID', JSON.stringify(malformedValue), 'INBOX_HASH_CONFLICT', conflictId]));
const traceparent = (id) => {
  const trace = createHash('sha256').update(id).digest('hex');
  return '00-' + trace.slice(0, 32) + '-' + trace.slice(0, 16) + '-01';
};
const envelope = (id, aggregateRef, sequence, payload) => ({
  envelopeVersion: '1', messageId: id, messageType: 'Issue63.LiveEvent',
  occurredAt: new Date().toISOString(), producer: 'orders-service',
  correlationId: 'correlation-' + id, causationId: null, traceparent: traceparent(id),
  aggregate: {type: 'Issue63.Proof', ref: aggregateRef, version: String(sequence)},
  payload: {...payload, sequence},
});
const calls = new Map();
const active = new Map();
let maxActive = 0;
const signalEventId = runId + '-sigterm';
let signalGateEntered = false;
let signalGateRelease;
const binding = {
  processing: 'durable', database, inbox,
  decode: (value) => value,
  handle: async (transaction, event, record) => {
    calls.set(event.messageId, (calls.get(event.messageId) ?? 0) + 1);
    const key = record.topic + ':' + record.partition;
    const current = (active.get(key) ?? 0) + 1;
    active.set(key, current); maxActive = Math.max(maxActive, current);
    if (event.messageId === signalEventId) {
      signalGateEntered = true;
      await new Promise((resolve) => { signalGateRelease = resolve; });
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    const sequence = Number(event.payload?.sequence);
    if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error('proof sequence is invalid');
    await ownerWrite(transaction, [event.messageId, event.aggregate.ref, JSON.stringify(event.payload), event.occurredAt]);
    const decision = await outbox.enqueue(transaction, {
      messageId: event.messageId, messageType: event.messageType, topic: record.topic,
      aggregateRef: event.aggregate.ref, aggregateSequence: sequence, ownerVersion: event.aggregate.version,
      partitionKey: record.key, schemaVersion: event.envelopeVersion, envelope: event,
      payload: event.payload, occurredAt: event.occurredAt, correlationId: event.correlationId,
      traceparent: event.traceparent,
    });
    if (decision !== 'created') throw new Error('proof Outbox decision was ' + decision);
    active.set(key, current - 1);
  },
};
const credentials = {username: kafkaCredential.username, password: kafkaCredential.password, caPem: kafkaCredential.caPem};
const nativeOptions = {
  brokers: config.kafka.brokers, clientId: 'issue63-native-' + runId, protocol: config.kafka.clientProtocol,
  username: credentials.username, password: credentials.password, sslCaPem: credentials.caPem,
  maxPending: delivery.queueCapacity, maxMessageBytes: delivery.maxMessageBytes,
  sendTimeoutMs: delivery.sendTimeoutMs, receiveTimeoutMs: delivery.receiveTimeoutMs,
  commitTimeoutMs: delivery.commitTimeoutMs, shutdownTimeoutMs: delivery.shutdownTimeoutMs,
};
const producerRuntime = kafkaModule.createKafkaRuntime({runtime: 'orders-service', config: config.kafka, service: ordersService.kafka, credentials});
const consumerService = preparationService.kafka;
const consumerA = kafkaModule.createKafkaRuntime({runtime: 'orders-aroma-preparation', config: config.kafka, service: consumerService, credentials});
const consumerB = kafkaModule.createKafkaRuntime({runtime: 'orders-aroma-preparation', config: config.kafka, service: consumerService, credentials});
consumerA.bind('orders-aroma-preparation-v1', binding);
consumerB.bind('orders-aroma-preparation-v1', binding);
await producerRuntime.resource.start(AbortSignal.timeout(delivery.shutdownTimeoutMs));
const malformedWire = JSON.stringify(malformedEnvelope);
await consumerA.resource.start(AbortSignal.timeout(delivery.shutdownTimeoutMs));
await consumerB.resource.start(AbortSignal.timeout(delivery.shutdownTimeoutMs));
await waitFor(() => consumerA.metrics().assigned > 0 && consumerB.metrics().assigned > 0);
const rebalanceBaseline = [consumerA.metrics().recoveryTotal, consumerB.metrics().recoveryTotal];
const orderedAggregate = 'issue63-order-' + runId;
const orderedKey = 'issue63-key-' + runId;
const ordered = [];
for (const sequence of [1, 2, 3]) {
  const id = runId + '-ordered-' + sequence;
  const ack = await producerRuntime.send(lifecycleTopic, orderedKey, envelope(id, orderedAggregate, sequence, {value: 'ordered-' + sequence}));
  if (ack.kind !== 'ack') throw new Error('native producer did not acknowledge ordered record');
  ordered.push({id, ack});
}
await waitFor(() => [...ordered].every(({id}) => (calls.get(id) ?? 0) === 1));
const partitions = new Set(ordered.map(({ack}) => ack.partition));
if (partitions.size !== 1 || maxActive !== 1) throw new Error('partition ordering or single-flight bound failed');
const offsets = ordered.map(({ack}) => BigInt(ack.offset));
if (!(offsets[0] < offsets[1] && offsets[1] < offsets[2])) throw new Error('producer offsets are not ordered');
const conflict = envelope(ordered[0].id, orderedAggregate, 9, {value: 'conflict'});
const conflictAck = await producerRuntime.send(lifecycleTopic, orderedKey, conflict);
if (conflictAck.kind !== 'ack') throw new Error('conflict fixture was not acknowledged');
await waitFor(async () => (await queryProofRows(orderedAggregate, ordered.map(({id}) => id), malformedWire, ordered[0].id)).rows[0]?.conflict_count === 1);
const normalRows = await queryProofRows(orderedAggregate, ordered.map(({id}) => id), malformedWire, ordered[0].id);
if (normalRows.rows[0]?.owner_count !== 3 || normalRows.rows[0]?.inbox_count !== 3 || normalRows.rows[0]?.outbox_count !== 3 || normalRows.rows[0]?.malformed_count !== 1 || normalRows.rows[0]?.conflict_count !== 1) throw new Error('durable normal/quarantine proof failed');
if (consumerA.metrics().recoveryTotal !== rebalanceBaseline[0] || consumerB.metrics().recoveryTotal !== rebalanceBaseline[1]) throw new Error('two-consumer rebalance recovery grew after stable assignment');
let signalReceived = false;
let activeAtSignal;
let signalStopComplete = false;
let signalStopError;
let signalStopPromise;
const signalHandler = () => {
  signalReceived = true;
  const consumerAMetrics = consumerA.metrics();
  const consumerBMetrics = consumerB.metrics();
  activeAtSignal = {
    consumerA: consumerAMetrics,
    consumerB: consumerBMetrics,
    total: consumerAMetrics.active + consumerBMetrics.active,
  };
  setTimeout(() => signalGateRelease?.(), 25).unref?.();
  signalStopPromise = Promise.all([
    consumerA.resource.stop(AbortSignal.timeout(delivery.shutdownTimeoutMs)),
    consumerB.resource.stop(AbortSignal.timeout(delivery.shutdownTimeoutMs)),
  ]).then(
    () => { signalStopComplete = true; },
    (error) => { signalStopError = error; signalStopComplete = true; },
  );
};
process.once('SIGTERM', signalHandler);
const signalAggregate = 'issue63-sigterm-' + runId;
const signalEvent = envelope(signalEventId, signalAggregate, 1, {value: 'sigterm'});
const signalAck = await producerRuntime.send(lifecycleTopic, 'issue63-sigterm-key-' + runId, signalEvent);
if (signalAck.kind !== 'ack') throw new Error('SIGTERM fixture event was not acknowledged');
await waitFor(() => signalGateEntered);
process.kill(process.pid, "SIGTERM");
await waitFor(() => signalStopPromise !== undefined);
await waitFor(() => signalStopComplete, delivery.shutdownTimeoutMs + delivery.revokeTimeoutMs + 1000);
if (signalStopError) throw signalStopError;
const closedMetrics = {consumerA: consumerA.metrics(), consumerB: consumerB.metrics()};
if (!signalReceived || !signalGateEntered || activeAtSignal?.total < 1) throw new Error('SIGTERM did not interrupt an active gated handler');
for (const metrics of Object.values(closedMetrics)) {
  if (metrics.assigned !== 0 || metrics.active !== 0 || metrics.pending !== 0) throw new Error('SIGTERM consumer stop left work in flight');
}
process.removeListener('SIGTERM', signalHandler);
const signalRows = await queryProofRows(signalAggregate, [signalEventId], malformedWire, ordered[0].id);
if (signalRows.rows[0]?.owner_count !== 1) throw new Error('SIGTERM fixture did not durably commit the owner effect');

const mapProducer = kafkaModule.createKafkaRuntime({runtime: 'catalog-activation-worker', config: config.kafka, service: config.services['catalog-activation-worker'].kafka, credentials});
await mapProducer.resource.start(AbortSignal.timeout(delivery.shutdownTimeoutMs));
const openNative = async (groupId) => {
  let native;
  let resolveAssignment;
  let rejectAssignment;
  const assigned = new Promise((resolve, reject) => {resolveAssignment = resolve; rejectAssignment = reject;});
  native = await nativeModule.createNativeConsumer({...nativeOptions, groupId, topics: [mappingTopic], autoOffsetReset: 'error'}, (event) => {
    if (event.type === 'assigned') void native.assign(event.partitions).then(() => resolveAssignment()).catch(rejectAssignment);
    else if (event.type === 'revoked') void native.unassign().catch(rejectAssignment);
    else rejectAssignment(new Error('native rebalance failed'));
  });
  await native.connect(); await native.subscribe([mappingTopic]);
  let assignmentDone = false;
  const buffered = [];
  void assigned.then(() => {assignmentDone = true;}, () => {assignmentDone = true;});
  await waitFor(async () => {
    buffered.push(...await native.poll(1, AbortSignal.timeout(delivery.receiveTimeoutMs)));
    return assignmentDone;
  });
  await assigned;
  return {...native, poll: async (limit, signal) => buffered.length ? buffered.splice(0, limit) : native.poll(limit, signal)};
};
const commitWithPoll = async (native, record) => {
  let finished = false;
  const poller = (async () => {
    while (!finished) {
      try {
        await native.poll(1, AbortSignal.timeout(delivery.receiveTimeoutMs));
      } catch {
        if (!finished) await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  })();
  try {
    return await native.commit(record.topic, record.partition, (BigInt(record.offset) + 1n).toString());
  } finally {
    finished = true;
    await poller;
  }
};
const mapId = runId + '-db-unknown';
const mapEvent = envelope(mapId, 'issue63-db-unknown-' + runId, 1, {value: 'db-unknown'});
const mapAck = await mapProducer.send(mappingTopic, 'issue63-map-' + runId, mapEvent);
if (mapAck.kind !== 'ack') throw new Error('mapping fixture was not acknowledged');
const firstNative = await openNative('orders-catalog-mapping-v2');
const firstRecords = [];
await waitFor(async () => {
  firstRecords.push(...await firstNative.poll(1, AbortSignal.timeout(delivery.receiveTimeoutMs)));
  return firstRecords.length === 1;
});
let unknownCode;
try {
  await kafkaModule.processKafkaRecord({...firstRecords[0], key: firstRecords[0].key ?? ''}, {
    runtime: 'orders-aroma-preparation', groupId: 'orders-catalog-mapping-v2', topics: [mappingTopic], binding,
    leaseMs: delivery.leaseMs, maxMessageBytes: delivery.maxMessageBytes, signal: new AbortController().signal,
    commit: async () => { throw new Error('offset commit blackhole'); },
  });
} catch (error) { unknownCode = error?.code; }
if (unknownCode !== 'OFFSET_COMMIT_OUTCOME_UNKNOWN') throw new Error('DB commit-before-offset proof returned ' + (unknownCode ?? 'no error'));
await firstNative.close();
const secondNative = await openNative('orders-catalog-mapping-v2');
const secondRecords = [];
await waitFor(async () => {
  secondRecords.push(...await secondNative.poll(1, AbortSignal.timeout(delivery.receiveTimeoutMs)));
  return secondRecords.length === 1;
});
await kafkaModule.processKafkaRecord({...secondRecords[0], key: secondRecords[0].key ?? ''}, {
  runtime: 'orders-aroma-preparation', groupId: 'orders-catalog-mapping-v2', topics: [mappingTopic], binding,
  leaseMs: delivery.leaseMs, maxMessageBytes: delivery.maxMessageBytes, signal: new AbortController().signal,
  commit: async (record) => commitWithPoll(secondNative, record),
});
if (calls.get(mapId) !== 1) throw new Error('DB unknown redelivery reran committed handler');
await secondNative.close();
for (let batch = 0; batch < 5; batch++) {
  const result = await outboxModule.relayOutboxBatch(outbox, database, async (claim, signal) => {
    const sender = claim.message.topic === mappingTopic ? mapProducer : producerRuntime;
    return sender.send(claim.message.topic, claim.message.partitionKey, claim.message.envelope, signal);
  }, {nowMs: Date.now(), leaseOwner: 'issue63-seed-relay', policy: delivery});
  if (result.unknown || result.failed) throw new Error('seed Outbox relay did not finalize known acknowledgements');
  if (result.claimed === 0) break;
  if (batch === 4) throw new Error('seed Outbox relay exceeded its bound');
}
await mapProducer.resource.stop(AbortSignal.timeout(delivery.shutdownTimeoutMs));

const crashId = runId + '-outbox-crash';
const crashEvent = envelope(crashId, 'issue63-outbox-crash-' + runId, 1, {value: 'outbox-crash'});
await withTransaction(database, {mode: 'background'}, (transaction) => outbox.enqueue(transaction, {
  messageId: crashId, messageType: crashEvent.messageType, topic: lifecycleTopic,
  aggregateRef: crashEvent.aggregate.ref, aggregateSequence: 1, ownerVersion: crashEvent.aggregate.version, partitionKey: orderedKey,
  schemaVersion: crashEvent.envelopeVersion, envelope: crashEvent, payload: crashEvent.payload,
  occurredAt: crashEvent.occurredAt, correlationId: crashEvent.correlationId, traceparent: crashEvent.traceparent,
}));
let brokerAckedBeforeFinalize = false;
let brokerAckMessageId;
try {
  await outboxModule.relayOutboxBatch(outbox, database, async (claim) => {
    if (claim.message.messageId !== crashEvent.messageId) throw new Error('outbox claim message ID changed before publish');
    const ack = await producerRuntime.send(claim.message.topic, claim.message.partitionKey, claim.message.envelope);
    if (ack.kind !== 'ack') throw new Error('outbox native ack was not known');
    brokerAckedBeforeFinalize = true;
    brokerAckMessageId = claim.message.messageId;
    database.resource.destroy();
    return {kind: 'ack'};
  }, {nowMs: Date.now(), leaseOwner: 'issue63-crash-' + runId, policy: delivery, signal: AbortSignal.timeout(delivery.shutdownTimeoutMs)});
} catch {}
if (!brokerAckedBeforeFinalize) throw new Error('broker ack-before-finalize fixture did not reach the ack');
database = databaseModule.createDatabase(databaseOptions);
await database.resource.start(AbortSignal.timeout(delivery.shutdownTimeoutMs));
outbox = outboxModule.createSqlOutboxStore(database, outboxOptions);
const expireLease = ownerModule.defineStatement(database, "UPDATE orders.issue63_live_outbox_messages SET lease_until = clock_timestamp() - interval '1 millisecond' WHERE message_id = $1");
await withTransaction(database, {mode: 'background'}, (transaction) => expireLease(transaction, [crashId]));
const recovered = await producerRuntime.relay(outbox, database, AbortSignal.timeout(delivery.shutdownTimeoutMs));
const stateRow = ownerModule.defineStatement(database, 'SELECT state FROM orders.issue63_live_outbox_messages WHERE message_id = $1');
const crashState = await withTransaction(database, {mode: 'background'}, (transaction) => stateRow(transaction, [crashId]));
if (recovered.published !== 1 || crashState.rows[0]?.state !== 'Published' || brokerAckMessageId !== crashEvent.messageId) throw new Error('Outbox ack-before-finalize recovery failed');
await producerRuntime.resource.stop(AbortSignal.timeout(delivery.shutdownTimeoutMs));
await database.resource.stop(AbortSignal.timeout(delivery.shutdownTimeoutMs));
console.log(JSON.stringify({
  ordered: {acknowledged: true, records: ordered.length, partition: ordered[0].ack.partition, offsets: ordered.map(({ack}) => ack.offset), maxActive},
  rebalance: {twoConsumersAssigned: true, bounded: true, recoveryTotal: [consumerA.metrics().recoveryTotal, consumerB.metrics().recoveryTotal]},
  quarantine: {malformed: true, malformedHeader: 'known-header-empty-value', conflict: true},
  sigterm: {received: signalReceived, gateEntered: signalGateEntered, activeAtSignal, closedMetrics, ownerCount: signalRows.rows[0]?.owner_count},
  dbCommitBeforeOffset: {code: unknownCode, redelivered: true, handlerCalls: calls.get(mapId)},
  outboxAckBeforeFinalize: {brokerAcked: brokerAckedBeforeFinalize, recovered: recovered.published === 1, stableMessageId: brokerAckMessageId === crashEvent.messageId},
}));`;
}

function nativeKafkaBlackholeSource({runId, mappingTopic}) {
  return `import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {pathToFileURL} from 'node:url';

const runId = ${JSON.stringify(runId)};
const mappingTopic = ${JSON.stringify(mappingTopic)};
const runtimeRequire = createRequire(createRequire('/app/package.json').resolve('@coffee-platform/runtime'));
const importPackage = (name) => import(pathToFileURL(runtimeRequire.resolve(name)).href);
const kafkaRequire = createRequire(runtimeRequire.resolve('@coffee-platform/kafka-runtime'));
const importKafkaPackage = (name) => import(pathToFileURL(kafkaRequire.resolve(name)).href);
const {load} = await import(pathToFileURL(runtimeRequire.resolve('js-yaml')).href);
const configModule = await importPackage('@coffee-platform/config');
const databaseModule = await importPackage('@coffee-platform/database');
const ownerModule = await importPackage('@coffee-platform/database/owner');
const inboxModule = await importKafkaPackage('@coffee-platform/inbox');
const outboxModule = await importKafkaPackage('@coffee-platform/outbox');
const kafkaModule = await importPackage('@coffee-platform/kafka-runtime');
const nativeModule = await import(pathToFileURL(runtimeRequire.resolve('@coffee-platform/kafka-runtime')).href.replace(/index\\.js$/u, 'native.js'));
const config = await configModule.loadPlatformConfig('/app/config/platform.yaml', (text) => load(text, {json: true}));
const secret = load(await readFile('/run/secrets/coffee-platform.yaml', 'utf8'), {json: true});
const at = (path) => path.split('.').reduce((value, key) => value && typeof value === 'object' ? value[key] : undefined, secret.secrets);
const databaseCredential = at('postgres.ordersService');
const kafkaCredential = at('kafka.orders');
if (!databaseCredential || !kafkaCredential) throw new Error('scoped proof credentials are missing');
const ordersService = config.services['orders-service'];
const delivery = config.kafka.delivery;
const databaseOptions = {
  owner: 'orders-service', database: ordersService.database, allowedDatabase: ordersService.database,
  host: config.postgres.host, port: config.postgres.port, user: databaseCredential.username,
  password: databaseCredential.password, ssl: config.postgres.sslMode === 'prefer' ? 'prefer' : true,
  pool: ordersService.dbPool, shutdownGraceMs: config.platform.shutdownGraceMs,
};
const database = databaseModule.createDatabase(databaseOptions);
await database.resource.start(AbortSignal.timeout(delivery.shutdownTimeoutMs));
const inbox = inboxModule.createSqlInboxStore(database, {schema: 'orders', table: 'issue63_live_inbox_messages', quarantineTable: 'issue63_live_inbox_quarantine'});
const outbox = outboxModule.createSqlOutboxStore(database, {schema: 'orders', table: 'issue63_live_outbox_messages'});
const ownerWrite = ownerModule.defineStatement(database, 'INSERT INTO orders.issue63_live_owner_effects (message_id, aggregate_ref, effect_value, applied_at) VALUES ($1, $2, $3, $4::timestamptz)');
const ownerCount = ownerModule.defineStatement(database, 'SELECT count(*)::int AS count FROM orders.issue63_live_owner_effects WHERE message_id = $1');
const binding = {
  processing: 'durable', database, inbox,
  decode: (value) => value,
  handle: async (transaction, event) => {
    await ownerWrite(transaction, [event.messageId, event.aggregate.ref, JSON.stringify(event.payload), event.occurredAt]);
    const decision = await outbox.enqueue(transaction, {
      messageId: event.messageId, messageType: event.messageType, topic: mappingTopic,
      aggregateRef: event.aggregate.ref, aggregateSequence: Number(event.payload?.sequence), ownerVersion: event.aggregate.version,
      partitionKey: event.aggregate.ref, schemaVersion: event.envelopeVersion, envelope: event,
      payload: event.payload, occurredAt: event.occurredAt, correlationId: event.correlationId,
      traceparent: event.traceparent,
    });
    if (decision !== 'created') throw new Error('blackhole Outbox decision was ' + decision);
  },
};
const credentials = {username: kafkaCredential.username, password: kafkaCredential.password, caPem: kafkaCredential.caPem};
const openConsumer = async () => {
  let target;
  let resolveAssignment;
  let rejectAssignment;
  const assignment = new Promise((resolve, reject) => { resolveAssignment = resolve; rejectAssignment = reject; });
  target = await nativeModule.createNativeConsumer({
    brokers: config.kafka.brokers, clientId: 'issue63-blackhole-' + runId, protocol: config.kafka.clientProtocol,
    username: credentials.username, password: credentials.password, sslCaPem: credentials.caPem,
    maxPending: delivery.queueCapacity, maxMessageBytes: delivery.maxMessageBytes,
    sendTimeoutMs: delivery.sendTimeoutMs, receiveTimeoutMs: delivery.receiveTimeoutMs,
    commitTimeoutMs: delivery.commitTimeoutMs, shutdownTimeoutMs: delivery.shutdownTimeoutMs,
    groupId: 'orders-catalog-mapping-v2', topics: [mappingTopic], autoOffsetReset: 'error',
  }, (event) => {
    if (event.type === 'assigned') void target.assign(event.partitions).then(resolveAssignment).catch(rejectAssignment);
    else if (event.type === 'revoked') void target.unassign().catch(rejectAssignment);
    else rejectAssignment(event.error);
  });
  await target.connect();
  await target.subscribe([mappingTopic]);
  let assignmentDone = false;
  const buffered = [];
  void assignment.then(() => {assignmentDone = true;}, () => {assignmentDone = true;});
  const deadline = Date.now() + 15000;
  while (!assignmentDone && Date.now() < deadline) buffered.push(...await target.poll(1, AbortSignal.timeout(delivery.receiveTimeoutMs)));
  if (!assignmentDone) throw new Error('paused-broker assignment wait exceeded');
  await assignment;
  return {...target, poll: async (limit, signal) => buffered.length ? buffered.splice(0, limit) : target.poll(limit, signal)};
};
const commitWithPoll = async (native, record) => {
  let finished = false;
  const poller = (async () => {
    while (!finished) {
      try {
        await native.poll(1, AbortSignal.timeout(delivery.receiveTimeoutMs));
      } catch {
        if (!finished) await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  })();
  try {
    return await native.commit(record.topic, record.partition, (BigInt(record.offset) + 1n).toString());
  } finally {
    finished = true;
    await poller;
  }
};
const messageIdOf = (value) => {
  if (value === null) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value).toString('utf8'));
    return parsed && typeof parsed === 'object' && typeof parsed.messageId === 'string' ? parsed.messageId : undefined;
  } catch {
    return undefined;
  }
};
const eventId = runId + '-broker-blackhole';
let consumer = await openConsumer();
const records = [];
const recordDeadline = Date.now() + 15000;
while (records.length === 0 && Date.now() < recordDeadline) {
  try {
    records.push(...await consumer.poll(1, AbortSignal.timeout(Math.max(1, Math.min(delivery.receiveTimeoutMs, recordDeadline - Date.now())))));
  } catch {
    /* Keep polling until the fixture's bounded deadline. */
  }
}
if (records.length !== 1 || messageIdOf(records[0].value) !== eventId) throw new Error('paused-broker fixture did not consume the expected record');
const record = {...records[0], key: records[0].key ?? ''};
let releaseGate;
const release = new Promise((resolve) => { releaseGate = resolve; });
let continueGate;
const continueCommit = new Promise((resolve) => { continueGate = resolve; });
const server = createServer((request, response) => {
  if (request.url === '/go') { continueGate(); response.end('go'); return; }
  if (request.url === '/release') { releaseGate(); response.end('release'); return; }
  response.statusCode = 404; response.end();
});
let port;
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(); });
});
let commitCode;
const commitStartedAt = Date.now();
try {
  await kafkaModule.processKafkaRecord(record, {
    runtime: 'orders-aroma-preparation', groupId: 'orders-catalog-mapping-v2', topics: [mappingTopic], binding,
    leaseMs: delivery.leaseMs, maxMessageBytes: delivery.maxMessageBytes, signal: new AbortController().signal,
    commit: async (processed) => {
      console.log('BLACKHOLE_READY:' + port);
      await continueCommit;
      await commitWithPoll(consumer, processed);
    },
  });
  throw new Error('paused broker unexpectedly allowed commit');
} catch (error) {
  commitCode = error?.code;
}
const commitElapsedMs = Date.now() - commitStartedAt;
if (commitCode !== 'OFFSET_COMMIT_OUTCOME_UNKNOWN') throw new Error('paused-broker commit outcome was ' + (commitCode ?? 'unknown'));
if (commitElapsedMs > delivery.commitTimeoutMs + delivery.receiveTimeoutMs + 1000) throw new Error('paused-broker commit exceeded its bounded deadline: ' + commitElapsedMs + 'ms');
const owner = await databaseModule.withTransaction(database, {mode: 'background'}, (transaction) => ownerCount(transaction, [eventId]));
if (owner.rows?.[0]?.count !== 1) throw new Error('DB commit did not precede paused-broker offset outcome');
console.log('BLACKHOLE_UNKNOWN:' + commitCode);
await release;
try {
  await consumer.poll(1, AbortSignal.timeout(delivery.receiveTimeoutMs));
} catch {}
await new Promise((resolve) => server.close(resolve));
await consumer.close();
const recoveredConsumer = await openConsumer();
const redelivery = [];
const redeliveryDeadline = Date.now() + 15000;
while (redelivery.length === 0 && Date.now() < redeliveryDeadline) {
  try {
    redelivery.push(...await recoveredConsumer.poll(1, AbortSignal.timeout(Math.max(1, Math.min(delivery.receiveTimeoutMs, redeliveryDeadline - Date.now())))));
  } catch {
    /* A committed offset is a valid bounded no-redelivery observation. */
  }
}
const redelivered = redelivery.length === 1;
if (redelivery.length > 1) throw new Error('paused-broker recovery returned more than one record');
if (redelivered && messageIdOf(redelivery[0].value) !== eventId) throw new Error('paused-broker redelivery was not the expected record');
if (redelivered) {
  await kafkaModule.processKafkaRecord({...redelivery[0], key: redelivery[0].key ?? ''}, {
    runtime: 'orders-aroma-preparation', groupId: 'orders-catalog-mapping-v2', topics: [mappingTopic], binding,
    leaseMs: delivery.leaseMs, maxMessageBytes: delivery.maxMessageBytes, signal: new AbortController().signal,
    commit: async (processed) => commitWithPoll(recoveredConsumer, processed),
  });
}
const recoveredOwner = await databaseModule.withTransaction(database, {mode: 'background'}, (transaction) => ownerCount(transaction, [eventId]));
if (recoveredOwner.rows?.[0]?.count !== 1) throw new Error('paused-broker recovery duplicated the owner effect');
await recoveredConsumer.close();
await database.resource.stop(AbortSignal.timeout(delivery.shutdownTimeoutMs));
console.log(JSON.stringify({kind: 'paused-broker', commitOutcome: commitCode, bounded: true, commitElapsedMs, redelivered, recoveryObservation: redelivered ? 'duplicate-no-second-effect' : 'offset-committed', recovered: true, recordMessageId: eventId, recordPartition: record.partition, recordOffset: record.offset}));`;
}

async function runKafkaBlackholeProof(
  projectName,
  secretsDir,
  runId,
  mappingTopic,
  composeFile,
) {
  const messageId = `${runId}-broker-blackhole`;
  const trace = randomUUID().replaceAll("-", "").padEnd(32, "0").slice(0, 32);
  const envelope = {
    envelopeVersion: "1",
    messageId,
    messageType: "Issue63.LiveEvent",
    occurredAt: new Date().toISOString(),
    producer: "orders-service",
    correlationId: `${runId}-broker-blackhole-correlation`,
    causationId: null,
    traceparent: `00-${trace}-${trace.slice(0, 16)}-01`,
    aggregate: {type: "Issue63.Proof", ref: `${runId}-broker-blackhole-aggregate`, version: "1"},
    payload: {sequence: 1, value: "broker-blackhole"},
  };
  const encoded = Buffer.from(JSON.stringify(envelope), "utf8").toString(
    "base64",
  );
  const resetAndProduce = [
    `mapping=${JSON.stringify(mappingTopic)}`,
    `/opt/kafka/bin/kafka-consumer-groups.sh --bootstrap-server kafka:9092 --command-config /etc/kafka/secrets/client.properties --group orders-catalog-mapping-v2 --topic "$mapping" --reset-offsets --to-latest --execute >/dev/null`,
    `printf '%s|%s\\n' blackhole-${runId} "$(printf '%s' '${encoded}' | base64 -d)" | /opt/kafka/bin/kafka-console-producer.sh --sync --command-property acks=all --property parse.key=true --property key.separator='|' --bootstrap-server kafka:9092 --command-config /etc/kafka/secrets/client.properties --topic "$mapping" >/dev/null`,
  ].join("\n");
  runCompose(
    projectName,
    secretsDir,
    ["exec", "-T", "kafka", "sh", "-ec", resetAndProduce],
    {composeFile},
  );

  const kafka = serviceRows(projectName, secretsDir, composeFile).find(
    (row) => row.Service === "kafka",
  );
  const orders = serviceRows(projectName, secretsDir, composeFile).find(
    (row) => row.Service === "orders-service",
  );
  assert.ok(kafka, "Kafka is absent before paused-broker proof");
  assert.ok(orders, "orders-service is absent before paused-broker proof");
  const outputLines = [];
  const waiters = [];
  let outputBuffer = "";
  const onOutput = (chunk) => {
    outputBuffer += chunk;
    const lines = outputBuffer.split("\n");
    outputBuffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      outputLines.push(trimmed);
      for (let index = waiters.length - 1; index >= 0; index -= 1) {
        if (trimmed.startsWith(waiters[index].prefix)) {
          const waiter = waiters.splice(index, 1)[0];
          clearTimeout(waiter.timer);
          waiter.resolve(trimmed);
        }
      }
    }
  };
  const waitForLine = (prefix, timeoutMs) => {
    const previous = outputLines.find((line) => line.startsWith(prefix));
    if (previous) return Promise.resolve(previous);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = waiters.findIndex((waiter) => waiter.resolve === resolve);
        if (index >= 0) waiters.splice(index, 1);
        reject(new Error(`${prefix} was not observed within ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      waiters.push({prefix, resolve, reject, timer});
    });
  };
  const child = spawnCompose(
    projectName,
    secretsDir,
    ["exec", "-T", "orders-service", "node", "--input-type=module"],
    {
      composeFile,
      input: nativeKafkaBlackholeSource({runId, mappingTopic}),
      onOutput,
    },
  );
  let paused = false;
  let finished = false;
  const waitForKafkaApi = async (timeoutMs = 30_000) => {
    const deadline = Date.now() + timeoutMs;
    let lastError;
    while (Date.now() < deadline) {
      try {
        runCompose(
          projectName,
          secretsDir,
          [
            "exec",
            "-T",
            "kafka",
            "sh",
            "-ec",
            "/opt/kafka/bin/kafka-broker-api-versions.sh --bootstrap-server kafka:9092 --command-config /etc/kafka/secrets/client.properties >/dev/null",
          ],
          {composeFile},
        );
        return;
      } catch (error) {
        lastError = error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(
      `paused-broker recovery did not restore Kafka API: ${lastError?.message ?? "timeout"}`,
    );
  };
  void child.done.then(
    () => { finished = true; },
    () => { finished = true; },
  );
  try {
    const readyLine = await waitForLine("BLACKHOLE_READY:", 15000);
    const port = Number(readyLine.slice("BLACKHOLE_READY:".length));
    assert.ok(Number.isSafeInteger(port) && port > 0 && port < 65536);
    runDocker(["pause", kafka.ID]);
    paused = true;
    runDocker([
      "exec",
      orders.ID,
      "node",
      "-e",
      `fetch('http://127.0.0.1:${port}/go').then(() => process.exit(0)).catch(() => process.exit(1))`,
    ]);
    const unknownLine = await waitForLine("BLACKHOLE_UNKNOWN:", 15000);
    assert.equal(
      unknownLine,
      "BLACKHOLE_UNKNOWN:OFFSET_COMMIT_OUTCOME_UNKNOWN",
      "paused-broker commit did not become a bounded unknown outcome",
    );
    runDocker(["unpause", kafka.ID]);
    paused = false;
    await waitForDockerHealthy(kafka.ID);
    await waitForKafkaApi();
    runDocker([
      "exec",
      orders.ID,
      "node",
      "-e",
      `fetch('http://127.0.0.1:${port}/release').then(() => process.exit(0)).catch(() => process.exit(1))`,
    ]);
    await child.done;
    const finalLine = [...outputLines].reverse().find((line) => line.startsWith("{"));
    assert.ok(finalLine, "paused-broker proof did not return evidence JSON");
    const evidence = JSON.parse(finalLine);
    assert.equal(evidence.kind, "paused-broker");
    assert.equal(evidence.commitOutcome, "OFFSET_COMMIT_OUTCOME_UNKNOWN");
    assert.ok(Number.isSafeInteger(evidence.commitElapsedMs) && evidence.commitElapsedMs >= 0, "paused-broker commit elapsed bound evidence is missing");
    assert.equal(evidence.bounded, true);
    assert.equal(evidence.recovered, true);
    assert.equal(evidence.recordMessageId, messageId);
    if (evidence.redelivered) {
      assert.equal(evidence.recoveryObservation, "duplicate-no-second-effect");
    } else {
      assert.equal(evidence.recoveryObservation, "offset-committed");
      const offsetOutput = runCompose(
        projectName,
        secretsDir,
        [
          "exec",
          "-T",
          "kafka",
          "sh",
          "-ec",
          `/opt/kafka/bin/kafka-consumer-groups.sh --bootstrap-server kafka:9092 --command-config /etc/kafka/secrets/client.properties --group orders-catalog-mapping-v2 --describe`,
        ],
        {composeFile},
      );
      const committed = offsetOutput
        .split("\n")
        .map((line) => line.trim().split(/\s+/u))
        .find((fields) => fields[0] === "orders-catalog-mapping-v2" && fields[1] === mappingTopic && fields[2] === String(evidence.recordPartition));
      assert.ok(committed, "paused-broker proof did not expose the recovered group offset");
      assert.ok(BigInt(committed[3]) >= BigInt(evidence.recordOffset) + 1n, "paused-broker group offset did not advance after recovery");
    }
    return evidence;
  } finally {
    if (paused) {
      try {
        runDocker(["unpause", kafka.ID]);
        await waitForDockerHealthy(kafka.ID);
        await waitForKafkaApi();
      } catch {
        /* preserve the original proof failure */
      }
    }
    if (!finished) {
      child.child.kill("SIGTERM");
      await child.done.catch(() => undefined);
    }
  }
}

async function assertReadiness(
  projectName,
  secretsDir,
  composeFile = COMPOSE_FILE,
) {
  const publicTlsConfig = await readPublicTlsConfig();
  for (const runtime of RUNTIMES) {
    const output = runCompose(
      projectName,
      secretsDir,
      [
        "exec",
        "-T",
        runtime,
        ...RUNTIME_HEALTHCHECK,
        "/health/live",
        "/health/ready",
        "/metrics",
      ],
      {composeFile},
    ).trim();
    void output;
  }
  for (const path of ["/health/live", "/health/ready", "/metrics"]) {
    assert.equal(
      await hostRuntimeHealthStatus(secretsDir, "edge-gateway", path, 4000, publicTlsConfig),
      200,
      `edge host endpoint ${path} is not available`,
    );
  }
}

async function readPublicTlsConfig() {
  const config = parseYaml(await readFile(join(ROOT, "config/platform.yaml"), "utf8"), {json: true});
  const hostname = parsePublicTlsHostname(config.platform?.publicBaseUrl);
  const optionalRefs = config.services?.["edge-gateway"]?.optionalSecretRefs;
  if (optionalRefs !== undefined && (!Array.isArray(optionalRefs) || optionalRefs.some((ref) => typeof ref !== "string"))) {
    throw new Error("edge-gateway optional public TLS refs are invalid");
  }
  return {hostname, hasCaBundle: optionalRefs?.includes("edge.tlsCaBundle") === true};
}

async function hostRuntimeTransport(secretsDir, runtime, publicTlsConfig) {
  const document = parseYaml(
    await readFile(join(secretsDir, `${runtime}.yaml`), "utf8"),
    {json: true},
  );
  const material = parseServiceTransportMaterial(
    document.secrets?.security?.serviceTransportKeys?.[runtime],
    document.environment,
    runtime,
  );
  const publicTls = runtime === "edge-gateway"
    ? parsePublicTlsMaterial(
      document.secrets?.edge?.tlsPrivateKey,
      document.secrets?.edge?.tlsCertificate,
      publicTlsConfig.hostname,
      publicTlsConfig.hasCaBundle ? document.secrets?.edge?.tlsCaBundle : undefined,
    )
    : undefined;
  return {
    environment: document.environment,
    material,
    publicTls,
  };
}

function hostRuntimeHealthStatus(secretsDir, runtime, path, port, publicTlsConfig) {
  return hostRuntimeTransport(secretsDir, runtime, publicTlsConfig).then(({environment, material, publicTls}) => new Promise((resolvePromise, reject) => {
    const isPublic = runtime === "edge-gateway";
    const publicTrust = isPublic && publicTls?.caPem !== undefined ? {ca: publicTls.caPem} : {};
    const request = httpsRequest({
      host: "127.0.0.1",
      port,
      path,
      method: "GET",
      ...(isPublic ? publicTrust : {ca: material.caPem}),
      ...(isPublic ? {} : {cert: material.certPem, key: material.keyPem}),
      minVersion: "TLSv1.3",
      rejectUnauthorized: true,
      ...(isPublic ? {servername: publicTls.hostname} : {}),
      timeout: 5_000,
      ...(isPublic ? {} : {checkServerIdentity: (_hostname, certificate) => {
        try {
          verifyTransportPeer(certificate, environment, runtime);
          return undefined;
        } catch (error) {
          return error instanceof Error ? error : new Error("transport peer identity is invalid");
        }
      },
      }),
    }, (response) => {
      response.resume();
      response.once("end", () => resolvePromise(response.statusCode ?? 0));
    });
    request.once("timeout", () => request.destroy(new Error("host healthcheck timed out")));
    request.once("error", reject);
    request.end();
  }));
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
      ...RUNTIME_HEALTH_STATUSES,
      path,
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
  const effectiveCompose = JSON.parse(runCompose(projectName, secretsDir, ["config", "--format", "json"], {composeFile}));
  const hostIngress = JSON.parse(
    runDocker(["network", "inspect", effectiveCompose.networks.coffee_host_ingress.name]),
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
  let recoveryDatabaseProof;
  let recoveryProofCredentials;
  let recoveryAdminUrl;
  let recoveryDeliveryDatabase;
  let recoveryDeliveryTables = false;
  try {
    const databaseProofCredentials = options.databaseProof
      ? await readDatabaseProofCredentials()
      : undefined;
    recoveryProofCredentials = options.recoveryProof
      ? await readRecoveryProofCredentials()
      : undefined;
    if (options.databaseProof || options.recoveryProof) {
      composeFile = await writeScopedComposeOverride(projectName);
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
      recoveryProofCredentials,
    });
    runCompose(projectName, secretsDir, ["config", "--quiet"], {composeFile});
    if (!options.databaseProof && !options.recoveryProof)
      provisionedNetwork = ensureExternalNetwork(options);
    if (options.databaseProof || options.recoveryProof) {
      const postgresCredentials = options.databaseProof
        ? databaseProofCredentials
        : recoveryProofCredentials;
      assert.ok(postgresCredentials, "PostgreSQL proof credentials are missing");
      databaseProofContainer = startDatabaseProofContainer(
        projectName,
        databaseProofNetwork,
        postgresCredentials.admin,
        {
          initialDatabase: options.recoveryProof
            ? "postgres"
            : "coffee_platform_customer",
          publishHost: options.recoveryProof,
        },
      );
      await waitForDockerHealthy(databaseProofContainer);
      await waitForDatabaseProofReady(
        databaseProofContainer,
        postgresCredentials.admin,
        options.recoveryProof ? "postgres" : "coffee_platform_customer",
      );
      if (options.databaseProof) {
        bootstrapDatabaseProofRole(
          databaseProofContainer,
          postgresCredentials.admin,
          postgresCredentials.owner,
        );
        assertDatabaseProofRole(
          databaseProofContainer,
          postgresCredentials.admin,
          postgresCredentials.owner,
        );
      } else {
        recoveryDatabaseProof = await bootstrapRecoveryDatabases(
          databaseProofContainer,
          postgresCredentials,
        );
        const deliveryDatabase = recoveryProofCredentials.roleMap.databases.find(
          (candidate) => candidate.name === "coffee_platform_orders",
        );
        assert.ok(deliveryDatabase, "recovery proof orders database is missing");
        const ordersRole = deliveryDatabase.runtimeRoles.find(
          (candidate) => candidate.runtime === "orders-service",
        );
        assert.ok(ordersRole, "recovery proof orders-service role is missing");
        recoveryAdminUrl = `postgresql://${encodeURIComponent(postgresCredentials.admin.username)}:${encodeURIComponent(postgresCredentials.admin.password)}@127.0.0.1:${recoveryDatabaseProof.port}/postgres`;
        await createDeliveryTables(
          recoveryAdminUrl,
          deliveryDatabase,
          recoveryProofCredentials.rolePasswords,
          ordersRole.role,
        );
        recoveryDeliveryDatabase = deliveryDatabase;
        recoveryDeliveryTables = true;
      }
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
    let kafkaRetention;
    let nativeFoundation;
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
      kafkaRetention = assertKafkaDurableRetention(
        projectName,
        secretsDir,
        composeFile,
      );
      assertTelemetryEnvironment(rows);
      assertSecretMounts(projectName, secretsDir, rows, composeFile);
      await assertReadiness(projectName, secretsDir, composeFile);
      assertHostExposure(projectName, secretsDir, rows, composeFile);
      if (options.recoveryProof) {
        runCompose(
          projectName,
          secretsDir,
          ["stop", "orders-aroma-preparation"],
          {composeFile},
        );
        try {
          const fixture = await prepareKafkaNativeFixture(
            projectName,
            secretsDir,
            projectName,
            composeFile,
          );
          const foundationOutput = runCompose(
            projectName,
            secretsDir,
            ["exec", "-T", "orders-service", "node", "--input-type=module"],
            {composeFile, input: nativeFoundationSource({runId: projectName, ...fixture})},
          ).trim();
          const foundationLine = foundationOutput
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean)
            .at(-1);
          assert.ok(foundationLine, "native foundation proof did not return evidence JSON");
          const normalEvidence = JSON.parse(foundationLine);
          assert.equal(normalEvidence.sigterm?.received, true, "SIGTERM fixture did not observe the signal");
          assert.equal(normalEvidence.sigterm?.gateEntered, true, "SIGTERM fixture did not gate a handler");
          assert.ok(normalEvidence.sigterm?.activeAtSignal?.total >= 1, "SIGTERM fixture had no active handler at signal time");
          assert.equal(normalEvidence.sigterm?.ownerCount, 1, "SIGTERM fixture owner effect was not durable");
          assert.ok(normalEvidence.sigterm?.closedMetrics, "SIGTERM fixture closed metrics are missing");
          for (const metrics of Object.values(normalEvidence.sigterm.closedMetrics)) {
            assert.equal(metrics.assigned, 0, "SIGTERM fixture left a partition assigned");
            assert.equal(metrics.active, 0, "SIGTERM fixture left active work");
            assert.equal(metrics.pending, 0, "SIGTERM fixture left pending work");
          }
          nativeFoundation = {
            ...normalEvidence,
            blackhole: await runKafkaBlackholeProof(
              projectName,
              secretsDir,
              projectName,
              fixture.mappingTopic,
              composeFile,
            ),
          };
        } finally {
          runCompose(
            projectName,
            secretsDir,
            ["up", "--detach", "--wait", "--no-build", "orders-aroma-preparation"],
            {composeFile},
          );
          await waitForRuntimeReadiness(
            projectName,
            secretsDir,
            "orders-aroma-preparation",
            200,
            30_000,
            composeFile,
          );
        }
      }
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
        kafkaRetention: options.databaseProof ? undefined : kafkaRetention,
        recoveryProof: options.recoveryProof
          ? {postgres: recoveryDatabaseProof, kafka: kafkaRetention, native: nativeFoundation}
          : undefined,
        telemetry: !options.databaseProof,
        healthEndpoints: ["/health/live", "/health/ready", "/metrics"],
        stubSecrets: options.stubSecrets || options.databaseProof,
        dbIntegrationProof: options.databaseProof || options.recoveryProof,
        hostPublish: options.databaseProof ? [] : ["4000:4000"],
        gracefulShutdown: true,
      }),
    );
  } finally {
    if (
      recoveryDeliveryTables &&
      !options.keep &&
      recoveryAdminUrl &&
      recoveryDeliveryDatabase &&
      recoveryProofCredentials
    ) {
      try {
        await dropDeliveryTables(
          recoveryAdminUrl,
          recoveryDeliveryDatabase,
          recoveryProofCredentials.rolePasswords,
        );
      } catch {
        /* preserve the original recovery proof result */
      }
    }
    if (composeAttempted && !options.keep) {
      try {
        runCompose(
          projectName,
          secretsDir,
          options.databaseProof
            ? ["down", "--volumes", "--remove-orphans"]
            : ["down", "--volumes", "--remove-orphans"],
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
