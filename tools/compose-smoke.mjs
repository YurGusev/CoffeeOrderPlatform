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
import {createWriteStream} from "node:fs";
import { Buffer } from "node:buffer";
import { execFileSync, spawn } from "node:child_process";
import {request as httpsRequest} from "node:https";
import { join, resolve } from "node:path";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dump as dumpYaml, load as parseYaml } from "js-yaml";
import {parsePublicTlsHostname, parsePublicTlsMaterial, parseServiceTransportMaterial, verifyTransportPeer} from "../packages/platform-security/src/index.ts";
import {createDatabase} from "../packages/platform-database/dist/index.js";
import {applyMigrations, migrationChecksum} from "../packages/platform-migrations/dist/index.js";
import {OfferBindingStore} from "../apps/aroma-gateway/dist/infrastructure/database/offer-binding-store.js";
import {createSourceIdentity} from "../apps/aroma-gateway/dist/domain/source-identity.js";
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
const CUSTOMER_TEST_IMAGE =
  "node:26.8.1-bookworm-slim@sha256:27f5e13512830beb5d9a574108daa6701a0a0b91528aeaf1ee84ecdcddaeeaae";
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
    "  --customer-proof                 run the isolated Customer integration suite",
    "  --recovery-proof                  run the isolated full 15-runtime PostgreSQL/Kafka recovery proof",
    "  --aroma-binding-proof             run the isolated native HTTPS AROMA offer-binding proof",
    "  --aroma-cart-proof                run the isolated native mTLS safe cart-read proof with a local provider fixture",
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
    customerProof: false,
    recoveryProof: false,
    aromaBindingProof: false,
    aromaCartProof: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument === "--stub-secrets") options.stubSecrets = true;
    else if (argument === "--provision-empty-postgres-network")
      options.provisionNetwork = true;
    else if (argument === "--no-build") options.noBuild = true;
    else if (argument === "--database-proof") options.databaseProof = true;
    else if (argument === "--customer-proof") options.customerProof = true;
    else if (argument === "--recovery-proof") options.recoveryProof = true;
    else if (argument === "--aroma-binding-proof") options.aromaBindingProof = true;
    else if (argument === "--aroma-cart-proof") options.aromaCartProof = true;
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
  if ([options.databaseProof, options.customerProof, options.recoveryProof, options.aromaBindingProof, options.aromaCartProof].filter(Boolean).length > 1)
    throw new Error("--database-proof, --customer-proof, --recovery-proof, --aroma-binding-proof and --aroma-cart-proof are mutually exclusive");
  if (options.recoveryProof && options.stubSecrets)
    throw new Error("--recovery-proof requires generated fixture credentials, not --stub-secrets");
  if (!options.stubSecrets && !options.databaseProof && !options.customerProof && !options.recoveryProof && !options.aromaBindingProof && !options.aromaCartProof && !process.env.SOPS_AGE_KEY_FILE) {
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
    env: options.env === undefined ? process.env : {...process.env, ...options.env},
    stdio: options.inherit
      ? "inherit"
      : [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    input: options.input,
  });
}

function runDockerAsync(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, {
      cwd: ROOT,
      env: options.env === undefined ? process.env : {...process.env, ...options.env},
      stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    });
    let errorOutput = "";
    if (!options.inherit) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => { errorOutput += chunk; });
    }
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`docker exited ${code ?? signal}: ${errorOutput.trim()}`));
    });
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
      : ref === "aroma.email"
        ? "issue10-safe-read@example.invalid"
        : ref === "aroma.password"
          ? "compose-aroma-fixture-password"
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

async function writeCustomerProofFixtures(secretsDir, securityMaterial, transportMaterials) {
  const fixtures = {
    signing: join(secretsDir, "customer-test-signing.json"),
    publicTransport: join(secretsDir, "customer-test-api-public.json"),
    internalTransport: join(secretsDir, "customer-test-api-internal.json"),
  };
  await writeFile(fixtures.signing, JSON.stringify({
    public: securityMaterial["security.apiPublicDelegationSigningPrivateKey"],
    internal: securityMaterial["security.apiInternalDelegationSigningPrivateKey"],
  }) + "\n", {encoding: "utf8", mode: 0o400});
  await writeFile(fixtures.publicTransport, transportMaterials.service.get("api-public"), {encoding: "utf8", mode: 0o400});
  await writeFile(fixtures.internalTransport, transportMaterials.service.get("api-internal"), {encoding: "utf8", mode: 0o400});
  for (const path of Object.values(fixtures)) await chmod(path, 0o400);
  return fixtures;
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
  const stubTransportMaterials = options.stubSecrets || options.databaseProof || options.customerProof || options.recoveryProof || options.aromaBindingProof || options.aromaCartProof
    ? await createStubTransportMaterials(secretsDir, platformConfig.environment, publicHostname)
    : undefined;
  const stubSecurityMaterial = stubTransportMaterials === undefined ? undefined : createStubSecurityMaterial();
  for (const runtime of RUNTIMES) {
    const path = join(secretsDir, `${runtime}.yaml`);
    if (options.stubSecrets || options.databaseProof || options.customerProof || options.recoveryProof || options.aromaBindingProof || options.aromaCartProof) {
      const service = platformConfig.services[runtime];
      await writeStubSecret(
        path,
        runtime,
        platformConfig.environment,
        service.secretRefs,
        service.optionalSecretRefs ?? [],
        options.databaseProofCredentials?.[runtime] ??
          options.recoveryProofCredentials?.databaseCredentialsByRuntime?.[runtime],
        options.stubSecrets || options.recoveryProof || options.aromaBindingProof || options.aromaCartProof ? kafkaCredential : undefined,
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
      const kafkaRefs = platformConfig.services[runtime].secretRefs.filter((ref) => ref.startsWith("kafka."));
      if (kafkaRefs.length > 0) {
        const document = parseYaml(await readFile(path, "utf8"), {json: true});
        for (const ref of kafkaRefs) {
          const segments = ref.split(".");
          let target = document.secrets;
          for (const segment of segments.slice(0, -1)) target = target[segment] ??= {};
          target[segments.at(-1)] = kafkaCredential;
        }
        await chmod(path, 0o600);
        await writeFile(path, dumpYaml(document, {noRefs: true, lineWidth: 120}), {encoding: "utf8", mode: 0o400});
        await chmod(path, 0o400);
      }
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
  return {kafkaCredential, securityMaterial: stubSecurityMaterial, transportMaterials: stubTransportMaterials};
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

async function writeScopedComposeOverride(projectName, options = {}) {
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
      ...(network === "coffee_provider_egress" && (options.aromaCartProof || options.recoveryProof)
        ? ["    internal: true"]
        : []),
    ]),
    ...(options.aromaBindingProof ? [
      "",
      "services:",
      "  aroma-gateway:",
      "    networks: !override",
      "      - coffee_internal_api",
      "      - coffee_postgres_data",
      "    environment:",
      "      NODE_OPTIONS: --enable-source-maps --import=/app/dist/.aroma-proof-tls-observer.mjs",
      "    volumes:",
      `      - \${COFFEE_COMPOSE_SECRETS_DIR}/aroma-gateway-tls-observer.mjs:/app/dist/.aroma-proof-tls-observer.mjs:ro`,
    ] : []),
    ...(options.aromaCartProof || options.recoveryProof ? [
      "",
      "services:",
      "  aroma-gateway:",
      "    networks: !override",
      "      - coffee_internal_api",
      "      - coffee_postgres_data",
      "      - coffee_provider_egress",
      "    environment:",
      "      NODE_EXTRA_CA_CERTS: /run/aroma-proof/provider-ca.crt",
      "    volumes:",
      `      - \${COFFEE_COMPOSE_SECRETS_DIR}/aroma-cart-proof:/run/aroma-proof:ro`,
      "  aroma-provider-fixture:",
      `    image: ${CUSTOMER_TEST_IMAGE}`,
      "    command: [node, /run/aroma-proof/provider-server.mjs]",
      "    networks:",
      "      coffee_provider_egress:",
      "        aliases:",
      "          - aromateacoffee.ru",
      "    volumes:",
      `      - \${COFFEE_COMPOSE_SECRETS_DIR}/aroma-cart-proof:/run/aroma-proof`,
      "    healthcheck:",
      "      test:",
      "        - CMD",
      "        - node",
      "        - -e",
      "        - const net=require('node:net'); const socket=net.connect(443, '127.0.0.1', () => { socket.destroy(); process.exit(0); }); socket.on('error', () => process.exit(1));",
      "      interval: 1s",
      "      timeout: 1s",
      "      retries: 30",
    ] : []),
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
    ...(publishHost ? ["bridge"] : [networkName, "--network-alias", "coffee_postgres", "--network-alias", "customer_db"]),
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
    runDocker(["network", "connect", "--alias", "coffee_postgres", "--alias", "customer_db", networkName, container]);
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

function bootstrapCustomerProofRoles(container, admin) {
  const migrator = {username: "coffee_customer_migrator", password: `compose-migrator-${randomUUID()}`};
  runDocker(["exec", "--interactive", container, "psql", "--username", admin.username, "--dbname", "coffee_platform_customer", "--no-psqlrc"], {
    input: [
      `CREATE ROLE "${migrator.username}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD '${migrator.password}';`,
      `GRANT CONNECT, CREATE ON DATABASE "coffee_platform_customer" TO "${migrator.username}";`,
      `CREATE DATABASE "coffee_platform_customer_foreign";`,
      `REVOKE ALL ON DATABASE "coffee_platform_customer_foreign" FROM PUBLIC;`,
      "",
    ].join("\n"),
  });
  return {migrator, foreignDatabase: "coffee_platform_customer_foreign"};
}

async function runCustomerIntegrationProof(projectName, secretsDir, credentials, roles, composeFile) {
  const databaseUrl = (username, password, database, host = "customer_db") => `postgresql://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:5432/${database}`;
  const environment = [
    "run", "--rm", "--add-host", "customer-harness:127.0.0.1", "--add-host", "coffee_postgres:127.0.0.1", "--network", `${projectName}_coffee_public_api_backend`, "--network", `${projectName}_coffee_postgres_data`,
    "--volume", `${ROOT}:/workspace:ro`,
    "--volume", `${secretsDir}:/run/customer-secrets:ro`,
    "--volume", `${secretsDir}/customer-logs:/run/customer-logs:rw`,
    "--workdir", "/workspace",
    "--env", "CUSTOMER_INTEGRATION_REQUIRED=1",
    "--env", "CUSTOMER_TEST_ENVIRONMENT=development",
    "--env", "CUSTOMER_SERVICE_ORIGIN=https://customer-service:4101",
    "--env", "CUSTOMER_TEST_SIGNING_KEY_FILE=/run/customer-secrets/customer-test-signing.json",
    "--env", "CUSTOMER_TEST_CLIENT_TRANSPORT_FILE=/run/customer-secrets/customer-test-api-public.json",
    "--env", "CUSTOMER_TEST_INTERNAL_TRANSPORT_FILE=/run/customer-secrets/customer-test-api-internal.json",
    "--env", "CUSTOMER_DATABASE_URL",
    "--env", "CUSTOMER_RUNTIME_DATABASE_URL",
    "--env", "CUSTOMER_MIGRATOR_DATABASE_URL",
    "--env", "CUSTOMER_FOREIGN_DATABASE_URL",
    "--env", "CUSTOMER_TEST_LOG_FILE=/run/customer-logs/customer-service.log",
    "--env", "CUSTOMER_UNKNOWN_COMMIT_CONFIG_FILE=/workspace/config/platform.yaml",
    "--env", "CUSTOMER_UNKNOWN_COMMIT_SECRETS_FILE=/run/customer-secrets/customer-service.yaml",
    "--env", "CUSTOMER_UNKNOWN_COMMIT_DATABASE_URL",
    "--env", "CUSTOMER_UNKNOWN_COMMIT_OBSERVER_DATABASE_URL",
    "--env", "CUSTOMER_UNKNOWN_COMMIT_DB_TARGET_HOST=customer_db",
    "--env", "CUSTOMER_UNKNOWN_COMMIT_DB_TARGET_PORT=5432",
    "--env", "CUSTOMER_UNKNOWN_COMMIT_CLIENT_TRANSPORT_FILE=/run/customer-secrets/customer-test-api-public.json",
    "--env", "CUSTOMER_UNKNOWN_COMMIT_HEADERS_JSON={}",
    "--env", "CUSTOMER_UNKNOWN_COMMIT_ACTOR_REF=actor_customer_test",
    "--env", "CUSTOMER_UNKNOWN_COMMIT_SERVICE_ORIGIN=https://customer-harness:4101",
    "--env", "CUSTOMER_UNKNOWN_COMMIT_DB_ADAPTER_LOG_FILE=/run/customer-logs/db-adapter.log",
    "--env", "CUSTOMER_UNKNOWN_COMMIT_ENTRY=/workspace/apps/customer-service/dist/main.js",
    CUSTOMER_TEST_IMAGE,
    "sh", "-lc",
    "node --experimental-strip-types --test --test-concurrency=1 tests/customer/customer-normalization.test.mjs && node --experimental-strip-types --test --test-concurrency=1 tests/customer/customer-schema.test.mjs && node --experimental-strip-types --test --test-concurrency=1 tests/customer/customer-live.test.mjs",
  ];
  await mkdir(join(secretsDir, "customer-logs"), {recursive: true, mode: 0o700});
  await writeFile(join(secretsDir, "customer-logs/customer-service.log"), "", {encoding: "utf8", mode: 0o600});
  await writeFile(join(secretsDir, "customer-logs/db-adapter.log"), "", {encoding: "utf8", mode: 0o600});
  const logPath = join(secretsDir, "customer-logs/customer-service.log");
  const log = createWriteStream(logPath, {flags: "w", mode: 0o600});
  const logProcess = spawnCompose(projectName, secretsDir, ["logs", "--no-log-prefix", "--follow", "customer-service"], {composeFile});
  void logProcess.done.catch(() => {});
  logProcess.child.stdout.pipe(log);
  logProcess.child.stderr.pipe(log);
  try {
  await runDockerAsync(environment, {inherit: true, env: {
    CUSTOMER_DATABASE_URL: databaseUrl(credentials.owner.username, credentials.owner.password, "coffee_platform_customer"),
    CUSTOMER_RUNTIME_DATABASE_URL: databaseUrl(credentials.owner.username, credentials.owner.password, "coffee_platform_customer"),
    CUSTOMER_MIGRATOR_DATABASE_URL: databaseUrl(roles.migrator.username, roles.migrator.password, "coffee_platform_customer"),
    CUSTOMER_FOREIGN_DATABASE_URL: databaseUrl(credentials.owner.username, credentials.owner.password, roles.foreignDatabase),
    CUSTOMER_UNKNOWN_COMMIT_DATABASE_URL: `postgresql://${encodeURIComponent(credentials.owner.username)}:${encodeURIComponent(credentials.owner.password)}@127.0.0.1:5432/coffee_platform_customer`,
    CUSTOMER_UNKNOWN_COMMIT_OBSERVER_DATABASE_URL: databaseUrl(credentials.owner.username, credentials.owner.password, "coffee_platform_customer", "customer_db"),
  }});
  } finally {
    logProcess.child.kill("SIGTERM");
    log.end();
  }
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
  const adminUrl = ["postgresql://", encodeURIComponent(proofCredentials.admin.username), ":", encodeURIComponent(proofCredentials.admin.password), "@127.0.0.1:", port, "/postgres"].join("");
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

function proofDatabaseOptions(runtime, service, port, credential) {
  return {
    owner: runtime,
    database: service.database,
    allowedDatabase: service.database,
    host: "127.0.0.1",
    port,
    user: credential.username,
    password: credential.password,
    ssl: false,
    pool: service.dbPool,
    shutdownGraceMs: 30_000,
  };
}

async function applyAromaBindingMigration(port, credentials, platformConfig) {
  const database = platformConfig.databases?.integration ?? "coffee_platform_integration";
  const integration = credentials.roleMap.databases.find((candidate) => candidate.name === database);
  assert.ok(integration, "aroma binding integration database is missing");
  const migratorPassword = credentials.rolePasswords[integration.migratorRole];
  assert.ok(migratorPassword, "aroma binding migrator password is missing");
  const migrator = createDatabase(proofDatabaseOptions(
    "aroma-binding-migrator",
    {database, dbPool: {max: 2, checkoutTimeoutMs: 250, lockTimeoutMs: 250, interactiveStatementTimeoutMs: 2000, backgroundStatementTimeoutMs: 5000, terminalTimeoutMs: 2000, transactionTimeoutMs: 10000, idleTimeoutMs: 30000, maxLifetimeMs: 1800000}},
    port,
    {username: integration.migratorRole, password: migratorPassword},
  ));
  await migrator.resource.start(AbortSignal.timeout(10_000));
  try {
    const migrationIds = [
      "0001_provider_sessions",
      "0002_provider_mutation_journal",
      "0003_offer_bindings",
      "0004_provider_offer_identity",
      "0005_catalog_export_attempts",
      "0006_provider_mutation_retention",
      "0007_provider_mutation_grind",
    ];
    const migrations = [];
    for (const id of migrationIds) {
      const sql = await readFile(join(ROOT, `apps/aroma-gateway/migrations/${id}.sql`), "utf8");
      migrations.push({id, sql, checksum: migrationChecksum(sql)});
    }
    await applyMigrations(migrator, migrations, {
      schema: "integration",
      ledgerTable: "platform_schema_migrations",
      lockKey: "compose-smoke-aroma-cart-proof",
    });
  } finally {
    await migrator.resource.stop(AbortSignal.timeout(10_000));
  }
}

async function applyCatalogMigrations(port, credentials, platformConfig) {
  const service = platformConfig.services["catalog-supplier-sync"];
  const database = service?.database;
  assert.equal(database, "coffee_platform_catalog", "Catalog recovery proof database is missing");
  const catalog = credentials.roleMap.databases.find((candidate) => candidate.name === database);
  assert.ok(catalog, "Catalog recovery proof role map is missing");
  const migratorPassword = credentials.rolePasswords[catalog.migratorRole];
  assert.ok(migratorPassword, "Catalog recovery proof migrator password is missing");
  const migrator = createDatabase(proofDatabaseOptions(
    "catalog-compose-migrator",
    service,
    port,
    {username: catalog.migratorRole, password: migratorPassword},
  ));
  await migrator.resource.start(AbortSignal.timeout(10_000));
  try {
    const migrationIds = [
      "0001_supplier_snapshots",
      "0002_snapshot_batches",
      "0003_snapshot_staging",
    ];
    const migrations = [];
    for (const id of migrationIds) {
      const sql = await readFile(join(ROOT, `apps/catalog-service/migrations/${id}.sql`), "utf8");
      migrations.push({id, sql, checksum: migrationChecksum(sql)});
    }
    await applyMigrations(migrator, migrations, {
      schema: "catalog",
      ledgerTable: "platform_schema_migrations",
      lockKey: "compose-smoke-catalog-recovery-proof",
    });
  } finally {
    await migrator.resource.stop(AbortSignal.timeout(10_000));
  }
}

async function seedAromaBindingSnapshot(port, credentials, platformConfig, runId) {
  const service = platformConfig.services["aroma-gateway"];
  const credential = credentials.databaseCredentialsByRuntime["aroma-gateway"];
  assert.ok(service && credential, "aroma gateway database credentials are missing");
  const database = createDatabase(proofDatabaseOptions("aroma-gateway", service, port, credential));
  await database.resource.start(AbortSignal.timeout(10_000));
  const store = new OfferBindingStore(database);
  const supplierRef = "sup_00000000000000000000000001";
  const snapshotRef = "snp_00000000000000000000000001";
  const identities = [
    {supplierRef, sourceIdentityScheme: "hmac-sha256-v1", sourceOfferKeyHash: "a".repeat(64), rawProviderOfferId: `compose-proof-raw-provider-canary-${runId}`},
    {supplierRef, sourceIdentityScheme: "hmac-sha256-v1", sourceOfferKeyHash: "b".repeat(64), rawProviderOfferId: `compose-proof-raw-provider-second-${runId}`},
  ];
  try {
    await store.beginExport(snapshotRef, supplierRef);
    await store.recordBatch(snapshotRef, supplierRef, identities);
    await store.completeExport(snapshotRef, "c".repeat(64));
  } catch (error) {
    await database.resource.stop(AbortSignal.timeout(10_000));
    throw error;
  }
  return {database, supplierRef, snapshotRef, identities, rawCanary: identities[0].rawProviderOfferId};
}

async function createUntrustedAromaProofMaterial(secretsDir, environment, serverCaPem) {
  const directory = join(secretsDir, "aroma-proof-untrusted");
  await mkdir(directory, {recursive: true, mode: 0o700});
  const caKey = join(directory, "ca.key");
  const caCert = join(directory, "ca.crt");
  const key = join(directory, "caller.key");
  const csr = join(directory, "caller.csr");
  const cert = join(directory, "caller.crt");
  const ext = join(directory, "caller.ext");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", caKey, "-out", caCert, "-days", "1", "-subj", "/CN=compose-smoke-untrusted-ca"], {stdio: "ignore"});
  await writeFile(ext, `subjectAltName=URI:spiffe://coffee-platform/${environment}/catalog-activation-worker\\nextendedKeyUsage=clientAuth\\n`, {encoding: "utf8", mode: 0o400});
  execFileSync("openssl", ["req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", csr, "-subj", "/CN=catalog-activation-worker"], {stdio: "ignore"});
  execFileSync("openssl", ["x509", "-req", "-in", csr, "-CA", caCert, "-CAkey", caKey, "-CAcreateserial", "-out", cert, "-days", "1", "-sha256", "-extfile", ext], {stdio: "ignore"});
  return JSON.stringify({caPem: serverCaPem, certPem: await readFile(cert, "utf8"), keyPem: await readFile(key, "utf8")});
}

async function writeAromaBindingProofFixtures(secretsDir, materialized, environment, tlsObserver) {
  assert.ok(tlsObserver, "aroma binding TLS observer is missing");
  const directory = join(secretsDir, "aroma-proof");
  await mkdir(directory, {recursive: true, mode: 0o700});
  const writeMaterial = async (name, value) => {
    const path = join(directory, name);
    await writeFile(path, value, {encoding: "utf8", mode: 0o400});
    await chmod(path, 0o400);
    return path;
  };
  const caller = await writeMaterial("caller.json", materialized.transportMaterials.service.get("catalog-activation-worker"));
  const foreign = await writeMaterial("foreign.json", materialized.transportMaterials.service.get("orders-service"));
  const gateway = await writeMaterial("gateway.json", materialized.transportMaterials.service.get("aroma-gateway"));
  const apiInternal = await writeMaterial("api-internal.json", JSON.stringify({
    material: JSON.parse(materialized.transportMaterials.service.get("api-internal")),
    signingKey: materialized.securityMaterial["security.apiInternalDelegationSigningPrivateKey"],
  }));
  const untrusted = await writeMaterial("untrusted.json", await createUntrustedAromaProofMaterial(secretsDir, environment, JSON.parse(materialized.transportMaterials.service.get("aroma-gateway")).caPem));
  return {directory, caller, foreign, gateway, apiInternal, untrusted};
}

function findAromaTrackedSocket(trackedSockets, suppliedSocket) {
  if (suppliedSocket === undefined || suppliedSocket === null) return undefined;
  const suppliedParent = suppliedSocket._parent;
  const hasSuppliedParent = suppliedParent !== undefined && suppliedParent !== null;
  return trackedSockets.find(({socket}) => {
    if (socket === suppliedSocket) return true;
    if (hasSuppliedParent && socket === suppliedParent) return true;
    const trackedParent = socket?._parent;
    const hasTrackedParent = trackedParent !== undefined && trackedParent !== null;
    if (hasTrackedParent && trackedParent === suppliedSocket) return true;
    return hasSuppliedParent && hasTrackedParent && trackedParent === suppliedParent;
  });
}

function assertAromaGatewaySocketAssociationRegression() {
  const sharedParent = {};
  const knownSocket = {_parent: sharedParent};
  const tracked = [{socket: knownSocket, remotePort: 41001, localPort: 4301}];
  assert.equal(findAromaTrackedSocket(tracked, knownSocket), tracked[0], "direct socket identity must match");
  assert.equal(findAromaTrackedSocket(tracked, {_parent: sharedParent}), tracked[0], "shared parent identity must match");
  assert.equal(findAromaTrackedSocket([{socket: {_parent: undefined}}], {_parent: undefined}), undefined, "missing parents must not match");
  assert.equal(findAromaTrackedSocket([{socket: knownSocket}], {}), undefined, "unknown socket must not match");
}

const AROMA_BINDING_TLS_OBSERVER_SOURCE = `import {Server as TLSServer} from "node:tls";
import {Server as NetServer} from "node:net";
let sequence = 0;
const sockets = [];
${findAromaTrackedSocket.toString()}
const certificateVerificationCodes = new Set([
  "ERR_SSL_CERTIFICATE_VERIFY_FAILED",
  "ERR_SSL_PEER_DID_NOT_RETURN_A_CERTIFICATE",
  "ERR_SSL_SSLV3_ALERT_CERTIFICATE_UNKNOWN",
  "ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED",
  "ERR_SSL_TLSV1_ALERT_UNKNOWN_CA",
  "ERR_SSL_TLSV3_ALERT_BAD_CERTIFICATE",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_UNTRUSTED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);
const certificateVerificationMessage = /certificate (?:verify failed|required)|peer did not return a certificate|unknown ca|bad certificate/i;
const trackSocket = (socket) => {
  if (sockets.some(({socket: knownSocket}) => knownSocket === socket)) return;
  const tracked = {socket, remotePort: null, localPort: null};
  const refresh = () => {
    if (Number.isInteger(socket.remotePort)) tracked.remotePort = socket.remotePort;
    if (Number.isInteger(socket.localPort)) tracked.localPort = socket.localPort;
  };
  sockets.push(tracked);
  refresh();
  socket.once("connect", refresh);
  socket.once("secureConnect", refresh);
  socket.once("close", refresh);
};
const originalNetEmit = NetServer.prototype.emit;
NetServer.prototype.emit = function (event, ...args) {
  if (event === "connection" && args[0] !== undefined) trackSocket(args[0]);
  return originalNetEmit.call(this, event, ...args);
};
const originalEmit = TLSServer.prototype.emit;
const record = (error, socket, connection = {}, verificationSocket = socket) => {
  const associated = socket !== undefined && Number.isInteger(connection.remotePort) && Number.isInteger(connection.localPort);
  const errorCode = associated && typeof verificationSocket?.authorizationError === "string"
    ? verificationSocket.authorizationError
    : associated && typeof error?.code === "string" ? error.code : "unknown";
  const message = error instanceof Error ? error.message : String(error);
  const category = associated && (certificateVerificationCodes.has(errorCode) || certificateVerificationMessage.test(message))
    ? "client-certificate-verification"
    : "unassociated-tls-client-error";
  process.stderr.write("AROMA_BINDING_TLS_PROOF " + JSON.stringify({
    event: "tlsClientError",
    sequence: ++sequence,
    category,
    errorCode,
    authorizationError: associated && typeof verificationSocket?.authorizationError === "string" ? verificationSocket.authorizationError : null,
    remotePort: associated ? connection.remotePort : null,
    localPort: associated ? connection.localPort : null,
  }) + "\\n");
};
TLSServer.prototype.emit = function (event, ...args) {
  if (event === "connection" && args[0] !== undefined) trackSocket(args[0]);
  if (event === "tlsClientError") {
    const error = args[0];
    const suppliedSocket = args[1];
    const trackedSocket = findAromaTrackedSocket(sockets, suppliedSocket);
    if (trackedSocket === undefined) record(error, undefined, {}, suppliedSocket);
    else record(error, trackedSocket.socket, {remotePort: trackedSocket.remotePort, localPort: trackedSocket.localPort}, suppliedSocket);
  }
  return originalEmit.call(this, event, ...args);
};
`;

async function prepareAromaBindingTlsObserver(secretsDir) {
  const observer = join(secretsDir, "aroma-gateway-tls-observer.mjs");
  await writeFile(observer, AROMA_BINDING_TLS_OBSERVER_SOURCE, {encoding: "utf8", mode: 0o400});
  await chmod(observer, 0o400);
  await chown(observer, 1000, 1000);
  return {observer};
}

function aromaBindingProofSource({phase, supplierRef, snapshotRef, identities, environment, rawCanary}) {
  return `import {readFile} from "node:fs/promises";
import {request as httpsRequest} from "node:https";
import {sign} from "node:crypto";

const phase = ${JSON.stringify(phase)};
const supplierRef = ${JSON.stringify(supplierRef)};
const snapshotRef = ${JSON.stringify(snapshotRef)};
const identities = ${JSON.stringify(identities.map(({sourceOfferKeyHash}) => sourceOfferKeyHash))};
const expectedEnvironment = ${JSON.stringify(environment)};
const rawCanary = ${JSON.stringify(rawCanary)};
const operationId = "registerAromaOfferBinding";
const originalCaller = "catalog-activation-worker";
const read = async (name) => JSON.parse(await readFile("/run/aroma-proof/" + name, "utf8"));
const caller = await read("caller.json");
const foreign = await read("foreign.json");
const gateway = await read("gateway.json");
const apiInternal = await read("api-internal.json");
const untrusted = await read("untrusted.json");
const callerMaterial = caller;
const gatewayMaterial = gateway;
const apiMaterial = apiInternal.material;
const observedResponses = [];
const tlsCertificateRejectionCodes = new Set([
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_UNTRUSTED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "ERR_SSL_SSLV3_ALERT_CERTIFICATE_UNKNOWN",
  "ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED",
  "ERR_SSL_TLSV1_ALERT_UNKNOWN_CA",
  "ERR_SSL_TLSV3_ALERT_BAD_CERTIFICATE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);
const isTlsCertificateRejection = (error) => {
  const code = typeof error?.code === "string" ? error.code : "";
  if (tlsCertificateRejectionCodes.has(code)) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /(?:ssl|tls)v?[0-9]+(?:[.][0-9]+)?_alert_(?:unknown_ca|bad_certificate|certificate_required)|certificate (?:required|verify failed|has expired)|unable to verify (?:the )?first certificate|self[- ]signed certificate/i.test(message);
};
const status = async ({host, port, path, material, body, token, expectedServerRuntime, rawBody}) => new Promise((resolve, reject) => {
  let localPort;
  const options = {
    host, port, method: "POST", path, servername: host, ca: material.caPem, minVersion: "TLSv1.3", rejectUnauthorized: true,
    headers: {"content-type": "application/json", "content-length": Buffer.byteLength(rawBody ?? JSON.stringify(body ?? {}))},
    checkServerIdentity: (_hostname, certificate) => {
      const san = certificate.subjectaltname?.split(",").map((value) => value.trim()).find((value) => value.startsWith("URI:"));
      if (san !== "URI:spiffe://coffee-platform/" + expectedEnvironment + "/" + expectedServerRuntime) return new Error("target server SAN is invalid");
      return undefined;
    },
  };
  if (material.certPem !== undefined && material.keyPem !== undefined) { options.cert = material.certPem; options.key = material.keyPem; }
  if (token !== undefined) options.headers["x-service-delegation"] = token;
  const request = httpsRequest(options, (response) => {
    let value = "";
    response.setEncoding("utf8");
    response.on("data", (chunk) => { value += chunk; if (value.length > 65536) request.destroy(new Error("response exceeded bound")); });
    response.once("end", () => { let parsed; try { parsed = value ? JSON.parse(value) : undefined; } catch { parsed = undefined; } const result = {kind: "http", status: response.statusCode ?? 0, body: parsed, rawBody: value}; observedResponses.push(result); resolve(result); });
  });
  request.once("socket", (socket) => {
    socket.once("connect", () => { localPort = socket.localPort; });
    socket.once("secureConnect", () => { localPort = socket.localPort; });
  });
  request.once("timeout", () => request.destroy(new Error("bounded HTTPS request timeout")));
  request.once("error", (error) => {
    if (isTlsCertificateRejection(error)) {
      resolve({kind: "tls-rejected", code: error.code ?? "certificate-rejection", localPort});
      return;
    }
    if (error instanceof Error) error.localPort = localPort;
    reject(error);
  });
  request.setTimeout(5000);
  request.end(rawBody ?? JSON.stringify(body));
});
const baseBody = {offerRef: "off_00000000000000000000000001", supplierRef, sourceIdentityScheme: "hmac-sha256-v1", sourceOfferKeyHash: identities[0], snapshotRef};
const expectedBinding = {offerRef: baseBody.offerRef, supplierRef, sourceIdentityScheme: baseBody.sourceIdentityScheme, sourceOfferKeyHash: baseBody.sourceOfferKeyHash, firstSnapshotRef: snapshotRef, state: "Bound"};
const requestApi = (body, rawBody) => status({host: "api-internal", port: 4051, path: "/api/internal-v1/aroma/offer-bindings", material: callerMaterial, body, rawBody, expectedServerRuntime: "api-internal"});
const requestGateway = (material, token, body = baseBody, rawBody) => status({host: "aroma-gateway", port: 4301, path: "/api/internal-v1/aroma/offer-bindings", material, token, body, rawBody, expectedServerRuntime: "aroma-gateway"});
const assertNoRawCanaryInResponses = () => { if (observedResponses.some(({body, rawBody}) => JSON.stringify(body ?? "").includes(rawCanary) || rawBody.includes(rawCanary))) throw new Error("raw provider canary appeared in an HTTP response"); };
const canonical = (value) => value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number" ? JSON.stringify(value) : Array.isArray(value) ? "[" + value.map(canonical).join(",") + "]" : "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
const assertNormativeBinding = (result, label) => {
  if (result.kind !== "http" || result.status !== 200) throw new Error(label + " did not return 200");
  if (canonical(result.body) !== canonical(expectedBinding)) throw new Error(label + " body was not the normative binding");
};
const assertUnavailableEndpointRejected = async () => {
  let result;
  try {
    result = await status({host: "aroma-proof-unreachable.invalid", port: 1, path: "/api/internal-v1/aroma/offer-bindings", material: callerMaterial, body: baseBody, expectedServerRuntime: "aroma-gateway"});
  } catch (error) {
    if (isTlsCertificateRejection(error)) throw new Error("unavailable endpoint was misclassified as TLS rejection");
    return {kind: "network-rejected"};
  }
  throw new Error("unavailable endpoint unexpectedly returned " + result.kind + ":" + (result.status ?? "unknown"));
};
const requestGatewayForCertificateVerification = async (material, label) => {
  let result;
  let error;
  try {
    result = await requestGateway(material, undefined);
  } catch (candidate) {
    error = candidate;
  }
  if (result?.kind === "http") throw new Error(label + " unexpectedly returned HTTP " + result.status);
  if (error !== undefined && error.code !== "ECONNRESET" && result?.kind !== "tls-rejected") throw error;
  const localPort = result?.localPort ?? error?.localPort;
  if (!Number.isInteger(localPort)) throw new Error(label + " did not expose a local probe port");
  return {kind: "gateway-certificate-rejection-pending", localPort};
};
const delegation = (overrides = {}) => { const now = Math.floor(Date.now() / 1000); return {iss: "api-internal", aud: "aroma-gateway", originalCaller, operationId, correlationId: "compose-proof-correlation", traceparent: "00-00000000000000000000000000000000-0000000000000000-00", iat: now, exp: now + 30, jti: "compose-proof-jti-" + now, kid: "api-internal-delegation-v1", ...overrides}; };
const signed = (claims) => { const payload = Buffer.from(canonical(claims)); return payload.toString("base64url") + "." + sign(null, payload, apiInternal.signingKey).toString("base64url"); };
if (phase === "replay") {
  const replay = await requestApi(baseBody);
  assertNormativeBinding(replay, "restart replay");
  assertNoRawCanaryInResponses();
  console.log(JSON.stringify({phase, replayStatus: replay.status, normativeExistingResult: true, normativeBindingBody: true}));
} else {
  const allowed = await requestApi(baseBody);
  assertNormativeBinding(allowed, "allowed caller registration");
  const replay = await requestApi(baseBody);
  assertNormativeBinding(replay, "exact replay");
  const offerConflict = await requestApi({...baseBody, sourceOfferKeyHash: identities[1]});
  const sourceConflict = await requestApi({...baseBody, offerRef: "off_00000000000000000000000002"});
  if (offerConflict.kind !== "http" || offerConflict.status !== 409 || sourceConflict.kind !== "http" || sourceConflict.status !== 409) throw new Error("binding conflict was accepted");
  const noCertificate = await requestGateway({...gateway, certPem: undefined, keyPem: undefined}, undefined);
  const untrustedCertificate = await requestGatewayForCertificateVerification(untrusted, "untrusted client certificate");
  const foreignIdentity = await requestGateway(foreign, undefined);
  const unavailableEndpoint = await assertUnavailableEndpointRejected();
  if (noCertificate.kind !== "tls-rejected" || untrustedCertificate.kind !== "gateway-certificate-rejection-pending" || unavailableEndpoint.kind !== "network-rejected" || foreignIdentity.kind !== "http" || foreignIdentity.status !== 401) throw new Error("transport identity rejection proof failed");
  const forged = signed(delegation()).split("."); forged[1] = "AA";
  const expired = signed(delegation({iat: Math.floor(Date.now() / 1000) - 30, exp: Math.floor(Date.now() / 1000) - 10}));
  const wrongCaller = signed(delegation({originalCaller: "orders-service"}));
  const wrongOperation = signed(delegation({operationId: "wrongOperation"}));
  const delegationStatuses = [];
  for (const token of [forged.join("."), expired, wrongCaller, wrongOperation]) delegationStatuses.push((await requestGateway(apiMaterial, token)).status);
  if (delegationStatuses.some((value) => value !== 403)) throw new Error("invalid delegation was accepted: " + delegationStatuses.join(","));
  const malformed = await requestApi(baseBody, "{");
  if (malformed.kind !== "http" || malformed.status !== 400) throw new Error("malformed JSON did not return contract 400");
  assertNoRawCanaryInResponses();
  console.log(JSON.stringify({phase, allowedStatus: allowed.status, replayStatus: replay.status, normativeExistingResult: true, normativeBindingBody: true, offerRefConflictStatus: offerConflict.status, sourceIdentityConflictStatus: sourceConflict.status, noClientCertificate: noCertificate.kind, untrustedClientCertificate: untrustedCertificate.kind, untrustedClientPort: untrustedCertificate.localPort, unavailableEndpoint: unavailableEndpoint.kind, foreignIdentityStatus: foreignIdentity.status, forgedDelegationStatus: delegationStatuses[0], expiredDelegationStatus: delegationStatuses[1], wrongOriginalCallerStatus: delegationStatuses[2], wrongOperationStatus: delegationStatuses[3], malformedJsonStatus: malformed.status}));
}`;
}

async function runAromaBindingProofFixture(projectName, secretsDir, composeFile, fixture, phase, snapshot, environment) {
  const beforeEvents = aromaGatewayTlsProofEvents(projectName, secretsDir, composeFile);
  const source = aromaBindingProofSource({phase, supplierRef: snapshot.supplierRef, snapshotRef: snapshot.snapshotRef, identities: snapshot.identities, environment, rawCanary: snapshot.rawCanary});
  const output = runDocker(["run", "--rm", "--interactive", "--network", `${projectName}_coffee_internal_api`, "--volume", `${fixture.directory}:/run/aroma-proof:ro`, CUSTOMER_TEST_IMAGE, "node", "--input-type=module"], {input: source});
  const line = output.trim().split("\\n").filter(Boolean).at(-1);
  assert.ok(line, `aroma binding ${phase} fixture returned no evidence`);
  const result = JSON.parse(line);
  if (result.untrustedClientPort !== undefined) {
    assertAromaGatewayClientCertificateVerification(projectName, secretsDir, composeFile, beforeEvents, result.untrustedClientPort, phase);
    result.untrustedClientCertificate = "tls-rejected";
    result.gatewayClientCertificateVerification = true;
    delete result.untrustedClientPort;
  }
  return result;
}

async function queryAromaBindingCount(port, snapshot, credentials, platformConfig) {
  const credential = credentials.databaseCredentialsByRuntime["aroma-gateway"];
  const connectionString = ["postgresql://", encodeURIComponent(credential.username), ":", encodeURIComponent(credential.password), "@127.0.0.1:", port, "/", platformConfig.services["aroma-gateway"].database].join("");
  const client = await createPostgresClient(connectionString);
  try {
    const result = await client.query("SELECT count(*)::int AS count FROM integration.provider_offer_bindings WHERE supplier_ref = $1", [snapshot.supplierRef]);
    return result.rows[0]?.count;
  } finally {
    await client.end();
  }
}

async function assertAromaBindingTopology(projectName, secretsDir, composeFile) {
  const rows = serviceRows(projectName, secretsDir, composeFile);
  assert.equal(rows.length, 2, "aroma binding proof must start exactly two Compose services");
  const byService = new Map(rows.map((row) => [row.Service, row]));
  for (const runtime of ["api-internal", "aroma-gateway"]) {
    const row = byService.get(runtime);
    assert.ok(row, `${runtime} is absent from aroma binding proof`);
    assert.equal(row.State, "running", `${runtime} is not running`);
    assert.equal(row.Health, "healthy", `${runtime} is not healthy`);
    const container = JSON.parse(runDocker(["inspect", row.ID]))[0];
    const networks = Object.keys(container.NetworkSettings.Networks ?? {}).sort();
    const expected = runtime === "api-internal"
      ? [`${projectName}_coffee_internal_api`]
      : [`${projectName}_coffee_internal_api`, `${projectName}_coffee_postgres_data`].sort();
    assert.deepEqual(networks, expected, `${runtime} connected to an unexpected network`);
    assert.equal(networks.some((network) => network.includes("coffee_provider_egress")), false, `${runtime} connected to provider egress`);
  }
  return byService;
}

function aromaGatewayTlsProofEvents(projectName, secretsDir, composeFile) {
  const marker = "AROMA_BINDING_TLS_PROOF ";
  return runCompose(projectName, secretsDir, ["logs", "--no-color", "--no-log-prefix", "--tail", "200", "aroma-gateway"], {composeFile})
    .split("\n")
    .flatMap((line) => {
      const markerIndex = line.indexOf(marker);
      if (markerIndex === -1) return [];
      try {
        return [JSON.parse(line.slice(markerIndex + marker.length))];
      } catch {
        throw new Error("Gateway TLS proof log marker is not valid JSON");
      }
    });
}

function assertAromaGatewayClientCertificateVerification(projectName, secretsDir, composeFile, beforeEvents, localPort, phase) {
  const beforeMaxSequence = Math.max(0, ...beforeEvents.map((event) => typeof event.sequence === "number" ? event.sequence : 0));
  const event = aromaGatewayTlsProofEvents(projectName, secretsDir, composeFile).find((candidate) =>
    candidate.event === "tlsClientError" &&
    candidate.category === "client-certificate-verification" &&
    candidate.errorCode !== "unknown" &&
    typeof candidate.authorizationError === "string" &&
    candidate.sequence > beforeMaxSequence &&
    candidate.localPort === 4301 &&
    candidate.remotePort === localPort,
  );
  assert.ok(event, `aroma binding ${phase} has no Gateway-side client certificate verification error for this connection`);
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
    ["rm", "--force", "--stop", "--volumes", "kafka"],
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

async function prepareAromaCartProviderFixture(secretsDir) {
  const directory = join(secretsDir, "aroma-cart-proof");
  await mkdir(directory, {recursive: true, mode: 0o700});
  const caKey = join(directory, "provider-ca.key");
  const caCert = join(directory, "provider-ca.crt");
  const key = join(directory, "provider.key");
  const csr = join(directory, "provider.csr");
  const cert = join(directory, "provider.crt");
  const ext = join(directory, "provider.ext");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", caKey, "-out", caCert, "-days", "1", "-subj", "/CN=issue10-aroma-provider-fixture"], {stdio: "ignore"});
  await writeFile(ext, "subjectAltName=DNS:aromateacoffee.ru\nextendedKeyUsage=serverAuth\n", {encoding: "utf8", mode: 0o400});
  execFileSync("openssl", ["req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", csr, "-subj", "/CN=aromateacoffee.ru"], {stdio: "ignore"});
  execFileSync("openssl", ["x509", "-req", "-in", csr, "-CA", caCert, "-CAkey", caKey, "-CAcreateserial", "-out", cert, "-days", "1", "-sha256", "-extfile", ext], {stdio: "ignore"});
  await writeFile(join(directory, "add-one-get.json"), await readFile(join(ROOT, "evidence/aroma-provider/2026-09-12-cart-mutations/add-one-get.json"), "utf8"), {encoding: "utf8", mode: 0o400});
  const scopedGateway = parseYaml(await readFile(join(secretsDir, "aroma-gateway.yaml"), "utf8"), {json: true});
  const supplierRef = "sup_00000000000000000000000001";
  const catalogIdentityKey = Buffer.from(scopedGateway.secrets.aroma.catalogIdentityKeyV1, "utf8");
  const grinds = Array.from({length: 12}, (_, index) => ({id: String(index + 1), name: `Fixture grind ${index + 1}`}));
  await writeFile(join(directory, "catalog-grinds.json"), JSON.stringify(grinds) + "\n", {encoding: "utf8", mode: 0o400});
  await writeFile(join(directory, "selected-grind.json"), JSON.stringify({rawId: "1", sourceGrindKeyHash: createSourceIdentity({supplierRef, entityType: "grind", rawProviderIdentifier: "1", sourceIdentityKey: catalogIdentityKey}).sourceIdentityHash}) + "\n", {encoding: "utf8", mode: 0o400});
  await writeFile(join(directory, "provider-count.json"), JSON.stringify({login: 0, catalog: 0, cart: 0, post: 0, put: 0, delete: 0}) + "\n", {encoding: "utf8", mode: 0o600});
  await writeFile(join(directory, "provider-server.mjs"), `import {createServer} from "node:https";
import {readFile, writeFile} from "node:fs/promises";
const key = await readFile("/run/aroma-proof/provider.key");
const cert = await readFile("/run/aroma-proof/provider.crt");
let cart = JSON.parse(await readFile("/run/aroma-proof/add-one-get.json", "utf8"));
const grinds = JSON.parse(await readFile("/run/aroma-proof/catalog-grinds.json", "utf8"));
if (cart.products[0] !== undefined) cart.products[0].grind_id = "1";
let counts = {login: 0, catalog: 0, cart: 0, post: 0, put: 0, delete: 0};
const persist = () => writeFile("/run/aroma-proof/provider-count.json", JSON.stringify(counts) + String.fromCharCode(10));
const json = (response, status, body, headers = {}) => { response.writeHead(status, {"content-type": "application/json", ...headers}); response.end(body); };
const currentLine = (cartLineId) => cart.products.find((product) => String(product.id) === String(cartLineId));
const cartBytes = () => JSON.stringify(cart);
const addLine = (offerId, quantity, packing, grindId) => {
  const template = cart.products[0] ?? {id: 300001, offer: {id: Number(offerId), name: "Fixture coffee", vendor_code: "C-200-26", price: 852.6, params: []}, product_name: "Fixture coffee", preview: {path: "https://fixture.invalid/image", title: null, description: null}, offer_name: "Fixture coffee", grind_id: null, packing: packing ?? "Aroma", quantity: 1, price: 620, discount_value: 0, total_with_discount: 620, product_type: "coffee", product_slug: "fixture-coffee", category_composite_slug: "kofe/monosorta", show_on_wholesale: true, product_on_stop: false, sold_by_piece: false, disable_volume_discount: false, disable_personal_discount: false};
  cart.products = [{...template, id: 300001, offer: {...template.offer, id: Number(offerId)}, quantity: Number(quantity), packing: packing ?? "Aroma", grind_id: grindId ?? "1"}];
};
const server = createServer({key, cert}, async (request, response) => {
  if (request.method === "POST" && request.url === "/api/v1/auth/login") {
    counts.login += 1; await persist();
    let input = ""; for await (const chunk of request) input += chunk;
    const email = JSON.parse(input).email;
    json(response, 200, JSON.stringify({data: {email, wholesale: true, retail: false}}), {"set-cookie": "aroma_session=fixture-cookie; Path=/; HttpOnly; Secure"}); return;
  }
  if (request.method === "GET" && request.url === "/api/v1/cart/") {
    counts.cart += 1; await persist(); json(response, 200, cartBytes()); return;
  }
  if (request.method === "GET" && request.url === "/api/v1/catalog/grinds") {
    json(response, 200, JSON.stringify({data: grinds})); return;
  }
  if (request.method === "GET" && request.url?.startsWith("/api/v1/catalog/wholesale/products?")) {
    counts.catalog += 1; await persist();
    const url = new URL(request.url, "https://aromateacoffee.ru");
    const page = Number(url.searchParams.get("page"));
    const perPage = Number(url.searchParams.get("per_page"));
    if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(perPage) || perPage < 1) {
      json(response, 400, JSON.stringify({error: "invalid pagination"})); return;
    }
    json(response, 200, JSON.stringify({data: [], meta: {current_page: page, total: 0, last_page: 1, per_page: perPage}})); return;
  }
  if (request.url === "/api/v1/cart/" && request.method === "POST") {
    counts.post += 1; await persist();
    let input = ""; for await (const chunk of request) input += chunk;
    const form = new URLSearchParams(input);
    addLine(form.get("offer_id"), form.get("quantity"), form.get("packing"), form.get("grind_id"));
    if (form.get("quantity") === "3") { json(response, 200, JSON.stringify({malformed: true})); return; }
    json(response, 200, cartBytes()); return;
  }
  if (request.url?.startsWith("/api/v1/cart/") && request.method === "PUT") {
    const cartLineId = request.url.slice("/api/v1/cart/".length);
    counts.put += 1; await persist();
    let input = ""; for await (const chunk of request) input += chunk;
    const payload = JSON.parse(input);
    const line = currentLine(cartLineId);
    if (line === undefined) { json(response, 404, JSON.stringify({error: "not found", field: "cartLineId"})); return; }
    line.quantity = Number(payload.quantity);
    if (payload.packing !== undefined) line.packing = payload.packing;
    if (payload.grind_id !== undefined) line.grind_id = payload.grind_id;
    if (payload.quantity === 4) { response.destroy(); return; }
    json(response, 200, cartBytes()); return;
  }
  if (request.url?.startsWith("/api/v1/cart/") && request.method === "DELETE") {
    const cartLineId = request.url.slice("/api/v1/cart/".length);
    counts.delete += 1; await persist();
    cart.products = cart.products.filter((product) => String(product.id) !== cartLineId);
    if (cart.products.length === 0) cart = {products: [], prices: {categories: [], weights: [], discounts: [], prices: [], total: {default: 0, promo: 0}}};
    json(response, 200, cartBytes()); return;
  }
  json(response, 404, JSON.stringify({error: "not found"}));
});
const shutdown = () => server.close((error) => { if (error) throw error; });
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
server.listen(443, "0.0.0.0");
`, {encoding: "utf8", mode: 0o400});
  return {directory, caCert: join(directory, "provider-ca.crt"), countFile: join(directory, "provider-count.json")};
}

function aromaCartProofSource(environment, expectedInitialQuantity) {
  const source = String.raw`import {readFile} from "node:fs/promises";
import {request as httpsRequest} from "node:https";
const caller = JSON.parse(await readFile("/run/aroma-proof/caller.json", "utf8"));
const convergence = JSON.parse(await readFile("/run/aroma-proof/convergence.json", "utf8"));
const foreign = JSON.parse(await readFile("/run/aroma-proof/foreign.json", "utf8"));
const selectedGrind = JSON.parse(await readFile("/run/aroma-proof/selected-grind.json", "utf8"));
const expectedSan = "URI:spiffe://coffee-platform/__ENV__/api-internal";
const offerRef = "off_00000000000000000000000001";
const readPath = "/api/internal-v1/aroma/cart-snapshots:read";
const setPath = "/api/internal-v1/aroma/cart-lines/" + offerRef + ":set-quantity";
const removePath = "/api/internal-v1/aroma/cart-lines/" + offerRef + ":remove";
const requestApi = (material, path, body, headers = {}) => new Promise((resolve, reject) => {
  const raw = JSON.stringify(body);
  const options = {host: "api-internal", port: 4051, method: "POST", path, ca: material.caPem, cert: material.certPem, key: material.keyPem, servername: "api-internal", minVersion: "TLSv1.3", rejectUnauthorized: true, headers: {"content-type": "application/json", "content-length": Buffer.byteLength(raw), ...headers}, checkServerIdentity: (_hostname, certificate) => certificate.subjectaltname?.split(",").map((value) => value.trim()).includes(expectedSan) ? undefined : new Error("api-internal SAN mismatch")};
  const request = httpsRequest(options, (response) => { let value = ""; response.setEncoding("utf8"); response.on("data", (chunk) => { value += chunk; if (value.length > 2 * 1024 * 1024) request.destroy(new Error("response exceeded bound")); }); response.once("end", () => { let parsed; try { parsed = JSON.parse(value); } catch { parsed = undefined; } resolve({status: response.statusCode ?? 0, body: parsed, responseBytes: Buffer.from(value), requestBytes: Buffer.from(raw)}); }); });
  request.setTimeout(15000, () => request.destroy(new Error("bounded probe timeout"))); request.once("error", reject); request.end(raw);
});
const readCounts = async () => JSON.parse(await readFile("/run/aroma-proof/provider-count.json", "utf8"));
const readBody = {cartScopeRef: "aroma-primary"};
const unauthorized = await requestApi(foreign, readPath, readBody);
const spoofed = await requestApi(caller, readPath, readBody, {"x-service-delegation": "forged-by-fixture"});
const malformed = await requestApi(caller, readPath, {cartScopeRef: "wrong"});
const safe = await requestApi(caller, readPath, readBody);
if (unauthorized.status !== 401 || spoofed.status !== 403 || malformed.status !== 400 || safe.status !== 200) throw new Error("safe-read authorization matrix failed: " + [unauthorized.status, spoofed.status, malformed.status, safe.status].join("/"));
if (JSON.stringify(safe.body).includes("300000") || JSON.stringify(safe.body).includes("fixture-cookie")) throw new Error("provider material crossed the API boundary");
if (safe.body?.cartScopeRef !== "aroma-primary" || safe.body?.lines?.length !== 1 || safe.body.lines[0].offerRef !== offerRef || safe.body.lines[0].quantity !== "__INITIAL_QUANTITY__" || safe.body.lines[0].sourceGrindKeyHash !== selectedGrind.sourceGrindKeyHash) throw new Error("sanitized cart snapshot mismatch");
const setBody = {operationRef: "op_00000000000000000000000001", cartScopeRef: "aroma-primary", quantity: "2", sourceGrindKeyHash: selectedGrind.sourceGrindKeyHash};
const set = await requestApi(convergence, setPath, setBody);
if (set.status !== 200 || set.body?.state !== "Acknowledged" || set.body?.operationRef !== setBody.operationRef || set.body?.sourceGrindKeyHash !== selectedGrind.sourceGrindKeyHash) throw new Error("set mutation was not acknowledged: status=" + set.status + " state=" + String(set.body?.state ?? "none") + " code=" + String(set.body?.code ?? "none"));
const afterSet = await requestApi(caller, readPath, readBody);
if (afterSet.status !== 200 || afterSet.body?.lines?.[0]?.quantity !== "__AFTER_SET_QUANTITY__" || afterSet.body?.lines?.[0]?.sourceGrindKeyHash !== selectedGrind.sourceGrindKeyHash) throw new Error("set fresh cart read-back mismatch");
const setCounts = await readCounts();
const setReplay = await requestApi(convergence, setPath, setBody);
if (setReplay.status !== 200 || Buffer.compare(set.responseBytes, setReplay.responseBytes) !== 0) throw new Error("set replay response bytes changed");
if (JSON.stringify(await readCounts()) !== JSON.stringify(setCounts)) throw new Error("set replay dispatched a second unsafe call");
const removeBody = {operationRef: "op_00000000000000000000000002", cartScopeRef: "aroma-primary", sourceGrindKeyHash: selectedGrind.sourceGrindKeyHash};
const remove = await requestApi(convergence, removePath, removeBody);
if (remove.status !== 200 || remove.body?.state !== "Acknowledged" || remove.body?.operationRef !== removeBody.operationRef || remove.body?.sourceGrindKeyHash !== selectedGrind.sourceGrindKeyHash) throw new Error("remove mutation was not acknowledged");
const afterRemove = await requestApi(caller, readPath, readBody);
if (afterRemove.status !== 200 || afterRemove.body?.lines?.length !== __AFTER_REMOVE_LINES__) throw new Error("remove fresh cart read-back mismatch");
const removeCounts = await readCounts();
const removeReplay = await requestApi(convergence, removePath, removeBody);
if (removeReplay.status !== 200 || Buffer.compare(remove.responseBytes, removeReplay.responseBytes) !== 0) throw new Error("remove replay response bytes changed");
if (JSON.stringify(await readCounts()) !== JSON.stringify(removeCounts)) throw new Error("remove replay dispatched a second unsafe call");
const malformedBody = {operationRef: "op_00000000000000000000000003", cartScopeRef: "aroma-primary", quantity: "3", sourceGrindKeyHash: selectedGrind.sourceGrindKeyHash};
const malformedMutation = await requestApi(convergence, setPath, malformedBody);
if (malformedMutation.status !== 409 || malformedMutation.body?.code !== "AROMA_OPERATION_UNKNOWN_OUTCOME") throw new Error("malformed post-dispatch did not become UnknownOutcome");
const malformedCounts = await readCounts();
const malformedReplay = await requestApi(convergence, setPath, malformedBody);
if (malformedReplay.status !== 409 || malformedReplay.body?.code !== "AROMA_OPERATION_UNKNOWN_OUTCOME") throw new Error("malformed UnknownOutcome replay failed");
if (JSON.stringify(await readCounts()) !== JSON.stringify(malformedCounts)) throw new Error("malformed UnknownOutcome replay redispatched");
const lostBody = {operationRef: "op_00000000000000000000000004", cartScopeRef: "aroma-primary", quantity: "4", sourceGrindKeyHash: selectedGrind.sourceGrindKeyHash};
const lost = await requestApi(convergence, setPath, lostBody);
if (lost.status !== 409 || lost.body?.code !== "AROMA_OPERATION_UNKNOWN_OUTCOME") throw new Error("lost post-dispatch did not become UnknownOutcome");
const lostCounts = await readCounts();
const lostReplay = await requestApi(convergence, setPath, lostBody);
if (lostReplay.status !== 409 || lostReplay.body?.code !== "AROMA_OPERATION_UNKNOWN_OUTCOME") throw new Error("lost UnknownOutcome replay failed");
if (JSON.stringify(await readCounts()) !== JSON.stringify(lostCounts)) throw new Error("lost UnknownOutcome replay redispatched");
const afterLost = await requestApi(caller, readPath, readBody);
if (afterLost.status !== 200 || afterLost.body?.lines?.[0]?.quantity !== "4") throw new Error("lost post-dispatch effect was not visible on fresh read-back");
console.log(JSON.stringify({unauthorizedStatus: unauthorized.status, spoofedDelegationStatus: spoofed.status, malformedStatus: malformed.status, successStatus: safe.status, sanitizedSnapshot: true, providerMaterialRedacted: true, typedSuccess: true, freshCartReadBack: true, exactReplaySameBytes: true, unknownOutcomeAfterMalformed: true, unknownOutcomeAfterLost: true, unknownReplayWithoutRedispatch: true, providerAccess: false, providerKind: "local-fake", liveProviderAcceptance: false, providerCalls: await readCounts()}));
`;
  return source.replace("__ENV__", environment).replace("__INITIAL_QUANTITY__", expectedInitialQuantity).replace("__AFTER_SET_QUANTITY__", expectedInitialQuantity === "1" ? "2" : "4").replace("__AFTER_REMOVE_LINES__", expectedInitialQuantity === "1" ? "0" : "1");
}

async function runAromaCartProofFixture(projectName, secretsDir, composeFile, fixture, environment, expectedInitialQuantity = "1") {
  const output = runDocker(["run", "--rm", "--interactive", "--network", `${projectName}_coffee_internal_api`, "--volume", `${fixture.directory}:/run/aroma-proof:ro`, CUSTOMER_TEST_IMAGE, "node", "--input-type=module"], {input: aromaCartProofSource(environment, expectedInitialQuantity)});
  const line = output.trim().split("\\n").filter(Boolean).at(-1);
  assert.ok(line, "aroma cart fixture returned no evidence");
  return JSON.parse(line);
}

async function seedAromaCartReadBinding(port, credentials, platformConfig) {
  const service = platformConfig.services["aroma-gateway"];
  const credential = credentials.databaseCredentialsByRuntime["aroma-gateway"];
  assert.ok(service && credential, "aroma gateway database credentials are missing");
  const database = createDatabase(proofDatabaseOptions("aroma-gateway", service, port, credential));
  await database.resource.start(AbortSignal.timeout(10_000));
  const store = new OfferBindingStore(database);
  const supplierRef = "sup_00000000000000000000000001";
  const snapshotRef = "snp_00000000000000000000000002";
  const offerRef = "off_00000000000000000000000001";
  try {
    await store.beginExport(snapshotRef, supplierRef);
    await store.recordBatch(snapshotRef, supplierRef, [{
      supplierRef,
      sourceIdentityScheme: "hmac-sha256-v1",
      sourceOfferKeyHash: "d".repeat(64),
      rawProviderOfferId: "300000",
      rawProviderProductId: "300001",
      rawProviderVariantId: "300000",
      packing: "Aroma",
      grindId: "1",
    }]);
    await store.completeExport(snapshotRef, "e".repeat(64));
    await store.register({offerRef, supplierRef, snapshotRef, sourceIdentityScheme: "hmac-sha256-v1", sourceOfferKeyHash: "d".repeat(64)});
  } catch (error) {
    await database.resource.stop(AbortSignal.timeout(10_000));
    throw error;
  }
  return {database, supplierRef, snapshotRef, offerRef};
}

async function assertAromaCartTopology(projectName, secretsDir, composeFile) {
  const rows = serviceRows(projectName, secretsDir, composeFile);
  assert.equal(rows.length, 3, "aroma cart proof must start exactly three services");
  const byService = new Map(rows.map((row) => [row.Service, row]));
  for (const runtime of ["api-internal", "aroma-gateway", "aroma-provider-fixture"]) {
    const row = byService.get(runtime);
    assert.ok(row, `${runtime} is absent from aroma cart proof`);
    assert.equal(row.State, "running", `${runtime} is not running`);
    assert.equal(row.Health, "healthy", `${runtime} is not healthy`);
    const container = JSON.parse(runDocker(["inspect", row.ID]))[0];
    const networks = Object.keys(container.NetworkSettings.Networks ?? {}).sort();
    const expected = runtime === "api-internal" ? [`${projectName}_coffee_internal_api`] : runtime === "aroma-gateway" ? [`${projectName}_coffee_internal_api`, `${projectName}_coffee_postgres_data`, `${projectName}_coffee_provider_egress`].sort() : [`${projectName}_coffee_provider_egress`];
    assert.deepEqual(networks, expected, `${runtime} connected to an unexpected network`);
  }
  return byService;
}

async function readAromaCartProviderCounts(countFile) {
  const counts = JSON.parse(await readFile(countFile, "utf8"));
  assert.deepEqual(Object.keys(counts).sort(), ["cart", "catalog", "delete", "login", "post", "put"]);
  return counts;
}

async function readAromaMutationJournal(port, credentials, platformConfig, operationRefs) {
  const service = platformConfig.services["aroma-gateway"];
  const credential = credentials.databaseCredentialsByRuntime["aroma-gateway"];
  const database = service.database;
  assert.ok(service && credential, "aroma gateway journal credentials are missing");
  const client = new Client({host: "127.0.0.1", port, database, user: credential.username, password: credential.password, ssl: false, connectionTimeoutMillis: 10_000});
  await client.connect();
  try {
    const result = await client.query(
      `SELECT operation_ref, operation_kind, offer_ref, source_grind_key_hash, state, response_status, octet_length(response_body_bytes) AS response_bytes, outcome_hash, failure_code, caller_identity, original_caller, dispatched_at IS NOT NULL AS dispatched
       FROM integration.provider_mutation_journal
       WHERE operation_ref = ANY($1::varchar[])
       ORDER BY operation_ref`,
      [operationRefs],
    );
    return result.rows.map((row) => ({
      operationRef: row.operation_ref,
      operationKind: row.operation_kind,
      offerRef: row.offer_ref,
      sourceGrindKeyHash: row.source_grind_key_hash,
      state: row.state,
      responseStatus: row.response_status,
      responseBytes: row.response_bytes,
      outcomeHash: row.outcome_hash,
      failureCode: row.failure_code,
      callerIdentity: row.caller_identity,
      originalCaller: row.original_caller,
      dispatched: row.dispatched,
    }));
  } finally {
    await client.end();
  }
}

function assertAromaMutationJournal(rows, sourceGrindKeyHash) {
  assert.equal(rows.length, 4, "cart mutation proof must persist exactly four journal rows");
  const byRef = new Map(rows.map((row) => [row.operationRef, row]));
  const acknowledged = ["op_00000000000000000000000001", "op_00000000000000000000000002"];
  for (const operationRef of acknowledged) {
    const row = byRef.get(operationRef);
    assert.ok(row, `missing acknowledged journal row ${operationRef}`);
    assert.equal(row.state, "Acknowledged");
    assert.equal(row.responseStatus, 200);
    assert.equal(row.responseBytes > 0, true);
    assert.match(row.outcomeHash, /^[a-f0-9]{64}$/u);
    assert.equal(row.failureCode, null);
    assert.equal(row.dispatched, true);
    assert.equal(row.callerIdentity, "api-internal");
    assert.equal(row.originalCaller, "aroma-convergence");
    assert.equal(row.sourceGrindKeyHash, sourceGrindKeyHash);
  }
  const unknownFailures = new Map([
    ["op_00000000000000000000000003", "AROMA_PROVIDER_INVALID_RESPONSE"],
    ["op_00000000000000000000000004", "AROMA_PROVIDER_OUTCOME_UNKNOWN"],
  ]);
  for (const [operationRef, failureCode] of unknownFailures) {
    const row = byRef.get(operationRef);
    assert.ok(row, `missing unknown-outcome journal row ${operationRef}`);
    assert.equal(row.state, "UnknownOutcome");
    assert.equal(row.responseStatus, null);
    assert.equal(row.responseBytes, null);
    assert.equal(row.outcomeHash, null);
    assert.equal(row.failureCode, failureCode);
    assert.equal(row.dispatched, true);
    assert.equal(row.callerIdentity, "api-internal");
    assert.equal(row.originalCaller, "aroma-convergence");
    assert.equal(row.sourceGrindKeyHash, sourceGrindKeyHash);
  }
  return rows;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.aromaBindingProof) assertAromaGatewaySocketAssociationRegression();
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
  let customerProofRoles;
  let aromaBindingSnapshot;
  let aromaBindingTlsObserver;
  let aromaBindingFixture;
  let aromaBindingEvidence;
  let aromaBindingRestartEvidence;
  let aromaBindingCleanupReceipt;
  let aromaCartProviderFixture;
  let recoveryProviderFixtureCalls;
  let aromaCartFixture;
  let aromaCartSnapshot;
  let aromaCartEvidence;
  let aromaCartRestartEvidence;
  let aromaCartCleanupReceipt;
  const platformConfig = parseYaml(await readFile(join(ROOT, "config/platform.yaml"), "utf8"), {json: true});
  try {
    const databaseProofCredentials = options.databaseProof || options.customerProof
      ? await readDatabaseProofCredentials()
      : undefined;
    recoveryProofCredentials = options.recoveryProof || options.aromaBindingProof || options.aromaCartProof
      ? await readRecoveryProofCredentials()
      : undefined;
    if (options.databaseProof || options.customerProof || options.recoveryProof || options.aromaBindingProof || options.aromaCartProof) {
      composeFile = await writeScopedComposeOverride(projectName, {
        aromaBindingProof: options.aromaBindingProof,
        aromaCartProof: options.aromaCartProof,
        recoveryProof: options.recoveryProof,
      });
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
    const materialized = await materializeSecrets(secretsDir, {
      ...options,
      databaseProofCredentials: databaseProofCredentials === undefined
        ? undefined
        : {[DATABASE_PROOF_RUNTIME]: databaseProofCredentials.owner},
      recoveryProofCredentials,
    });
    if (options.aromaBindingProof) aromaBindingTlsObserver = await prepareAromaBindingTlsObserver(secretsDir);
    if (options.aromaCartProof || options.recoveryProof) {
      aromaCartProviderFixture = await prepareAromaCartProviderFixture(secretsDir);
    }
    if (options.aromaCartProof) {
      const directory = join(secretsDir, "aroma-cart-proof");
      await writeFile(join(directory, "caller.json"), materialized.transportMaterials.service.get("aroma-observer"), {encoding: "utf8", mode: 0o400});
      await writeFile(join(directory, "convergence.json"), materialized.transportMaterials.service.get("aroma-convergence"), {encoding: "utf8", mode: 0o400});
      await writeFile(join(directory, "foreign.json"), materialized.transportMaterials.service.get("orders-service"), {encoding: "utf8", mode: 0o400});
      aromaCartFixture = {directory};
    }
    runCompose(projectName, secretsDir, ["config", "--quiet"], {composeFile});
    if (!options.databaseProof && !options.customerProof && !options.recoveryProof && !options.aromaBindingProof && !options.aromaCartProof)
      provisionedNetwork = ensureExternalNetwork(options);
    if (options.databaseProof || options.customerProof || options.recoveryProof || options.aromaBindingProof || options.aromaCartProof) {
      const postgresCredentials = options.databaseProof || options.customerProof
        ? databaseProofCredentials
        : recoveryProofCredentials;
      assert.ok(postgresCredentials, "PostgreSQL proof credentials are missing");
      databaseProofContainer = startDatabaseProofContainer(
        projectName,
        databaseProofNetwork,
        postgresCredentials.admin,
        {
          initialDatabase: options.recoveryProof || options.aromaBindingProof || options.aromaCartProof
            ? "postgres"
            : "coffee_platform_customer",
          publishHost: options.recoveryProof || options.aromaBindingProof || options.aromaCartProof,
        },
      );
      await waitForDockerHealthy(databaseProofContainer);
      await waitForDatabaseProofReady(
        databaseProofContainer,
        postgresCredentials.admin,
        options.recoveryProof || options.aromaBindingProof || options.aromaCartProof ? "postgres" : "coffee_platform_customer",
      );
      if (options.aromaBindingProof) {
        recoveryDatabaseProof = await bootstrapRecoveryDatabases(databaseProofContainer, postgresCredentials);
        const port = recoveryDatabaseProof.port;
        await applyAromaBindingMigration(port, recoveryProofCredentials, platformConfig);
        aromaBindingSnapshot = await seedAromaBindingSnapshot(port, recoveryProofCredentials, platformConfig, projectName);
      } else if (options.aromaCartProof) {
        recoveryDatabaseProof = await bootstrapRecoveryDatabases(databaseProofContainer, postgresCredentials);
        const port = recoveryDatabaseProof.port;
        await applyAromaBindingMigration(port, recoveryProofCredentials, platformConfig);
        aromaCartSnapshot = await seedAromaCartReadBinding(port, recoveryProofCredentials, platformConfig);

      } else if (options.databaseProof || options.customerProof) {
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
        if (options.customerProof) customerProofRoles = bootstrapCustomerProofRoles(databaseProofContainer, postgresCredentials.admin);
      } else {
        recoveryDatabaseProof = await bootstrapRecoveryDatabases(
          databaseProofContainer,
          postgresCredentials,
        );
        await applyAromaBindingMigration(recoveryDatabaseProof.port, recoveryProofCredentials, platformConfig);
        await applyCatalogMigrations(recoveryDatabaseProof.port, recoveryProofCredentials, platformConfig);
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
        options.databaseProof || options.customerProof
          ? [DATABASE_PROOF_RUNTIME]
          : options.aromaBindingProof || options.aromaCartProof
            ? ["api-internal", "aroma-gateway"]
            : RUNTIMES,
      );
    if (options.customerProof) await writeCustomerProofFixtures(secretsDir, materialized.securityMaterial, materialized.transportMaterials);
    if (options.aromaBindingProof) aromaBindingFixture = await writeAromaBindingProofFixtures(secretsDir, materialized, platformConfig.environment, aromaBindingTlsObserver);
    const upArguments = options.databaseProof || options.customerProof
      ? [
          "up",
          "--detach",
          "--wait",
          "--no-build",
          DATABASE_PROOF_RUNTIME,
        ]
      : options.aromaBindingProof || options.aromaCartProof
        ? ["up", "--detach", "--wait", "--no-build", "api-internal", "aroma-gateway", ...(options.aromaCartProof ? ["aroma-provider-fixture"] : [])]
        : ["up", "--detach", "--wait", "--no-build"];
    composeAttempted = true;
    runCompose(projectName, secretsDir, upArguments, {composeFile, inherit: true});
    const rows = options.databaseProof || options.customerProof || options.aromaBindingProof || options.aromaCartProof
      ? new Map(
          serviceRows(projectName, secretsDir, composeFile).map((row) => [row.Service, row]),
        )
      : assertHealthy(projectName, secretsDir, composeFile);
    let kafkaRetention;
    let nativeFoundation;
    if (options.aromaBindingProof) {
      assert.ok(aromaBindingSnapshot && aromaBindingFixture && recoveryDatabaseProof, "aroma binding proof fixtures are missing");
      const initialRows = await assertAromaBindingTopology(projectName, secretsDir, composeFile);
      aromaBindingEvidence = await runAromaBindingProofFixture(projectName, secretsDir, composeFile, aromaBindingFixture, "baseline", aromaBindingSnapshot, platformConfig.environment);
      const afterRegisterCount = await queryAromaBindingCount(recoveryDatabaseProof.port, aromaBindingSnapshot, recoveryProofCredentials, platformConfig);
      assert.equal(afterRegisterCount, 1, "allowed registration did not create exactly one durable binding");
      runCompose(projectName, secretsDir, ["stop", "--timeout", "30", "aroma-gateway"], {composeFile, inherit: true});
      runCompose(projectName, secretsDir, ["up", "--detach", "--wait", "--no-build", "aroma-gateway"], {composeFile, inherit: true});
      const restartedRows = await assertAromaBindingTopology(projectName, secretsDir, composeFile);
      assert.equal(restartedRows.get("api-internal")?.ID, initialRows.get("api-internal")?.ID, "api-internal was restarted unexpectedly");
      assert.equal(restartedRows.get("aroma-gateway")?.State, "running", "aroma-gateway did not restart");
      aromaBindingRestartEvidence = await runAromaBindingProofFixture(projectName, secretsDir, composeFile, aromaBindingFixture, "replay", aromaBindingSnapshot, platformConfig.environment);
      const afterRestartCount = await queryAromaBindingCount(recoveryDatabaseProof.port, aromaBindingSnapshot, recoveryProofCredentials, platformConfig);
      assert.equal(afterRestartCount, 1, "restart replay created a second binding");
      const boundedLogs = runCompose(projectName, secretsDir, ["logs", "--no-color", "--no-log-prefix", "--tail", "200", "api-internal", "aroma-gateway"], {composeFile});
      assert.ok(boundedLogs.length <= 100_000, "proof logs exceeded the bounded redaction window");
      const redactionCanaries = [
        aromaBindingSnapshot.rawCanary,
        recoveryProofCredentials.admin.password,
        recoveryProofCredentials.databaseCredentialsByRuntime["aroma-gateway"].password,
        materialized.kafkaCredential.password,
      ];
      for (const canary of redactionCanaries) {
        assert.equal(boundedLogs.includes(canary), false, "proof logs exposed a secret or raw provider canary");
        assert.equal(JSON.stringify({aromaBindingEvidence, aromaBindingRestartEvidence}).includes(canary), false, "proof output exposed a secret or raw provider canary");
      }
      aromaBindingCleanupReceipt = {composeProject: projectName, disposableDatabase: databaseProofContainer, fixture: "--rm", networks: [`${projectName}_coffee_internal_api`, `${projectName}_coffee_postgres_data`], boundedLogLines: 200, redacted: true};
    } else if (options.aromaCartProof) {
      assert.ok(aromaCartSnapshot && aromaCartFixture && aromaCartProviderFixture && recoveryDatabaseProof && recoveryProofCredentials, "aroma cart proof fixtures are missing");
      const initialRows = await assertAromaCartTopology(projectName, secretsDir, composeFile);
      const selectedGrind = JSON.parse(await readFile(join(aromaCartFixture.directory, "selected-grind.json"), "utf8"));
      aromaCartEvidence = await runAromaCartProofFixture(projectName, secretsDir, composeFile, aromaCartFixture, platformConfig.environment);
      const firstCounts = await readAromaCartProviderCounts(aromaCartProviderFixture.countFile);
      assert.deepEqual(firstCounts, {login: 1, catalog: 0, cart: 11, post: 1, put: 2, delete: 1}, "cart mutation provider call counts were not exact");
      const operationRefs = [
        "op_00000000000000000000000001",
        "op_00000000000000000000000002",
        "op_00000000000000000000000003",
        "op_00000000000000000000000004",
      ];
      const firstJournalRows = assertAromaMutationJournal(await readAromaMutationJournal(recoveryDatabaseProof.port, recoveryProofCredentials, platformConfig, operationRefs), selectedGrind.sourceGrindKeyHash);
      aromaCartEvidence = {...aromaCartEvidence, journalRows: firstJournalRows, realPostgresJournal: true, providerAccess: false, providerKind: "local-fake", liveProviderAcceptance: false};
      runCompose(projectName, secretsDir, ["stop", "--timeout", "30", "aroma-gateway"], {composeFile, inherit: true});
      runCompose(projectName, secretsDir, ["up", "--detach", "--wait", "--no-build", "aroma-gateway"], {composeFile, inherit: true});
      const restartedRows = await assertAromaCartTopology(projectName, secretsDir, composeFile);
      assert.equal(restartedRows.get("api-internal")?.ID, initialRows.get("api-internal")?.ID, "api-internal was restarted unexpectedly");
      aromaCartRestartEvidence = await runAromaCartProofFixture(projectName, secretsDir, composeFile, aromaCartFixture, platformConfig.environment, "4");
      const secondCounts = await readAromaCartProviderCounts(aromaCartProviderFixture.countFile);
      assert.deepEqual(secondCounts, {login: 1, catalog: 0, cart: 15, post: 1, put: 2, delete: 1}, "restart did not reuse the encrypted PostgreSQL session or replay terminal mutations");
      const secondJournalRows = assertAromaMutationJournal(await readAromaMutationJournal(recoveryDatabaseProof.port, recoveryProofCredentials, platformConfig, operationRefs), selectedGrind.sourceGrindKeyHash);
      assert.deepEqual(secondJournalRows, firstJournalRows, "restart changed durable mutation journal rows");
      aromaCartRestartEvidence = {...aromaCartRestartEvidence, journalRows: secondJournalRows, realPostgresJournal: true, providerAccess: false, providerKind: "local-fake", liveProviderAcceptance: false};
      const boundedLogs = runCompose(projectName, secretsDir, ["logs", "--no-color", "--no-log-prefix", "--tail", "200", "api-internal", "aroma-gateway", "aroma-provider-fixture"], {composeFile});
      assert.ok(boundedLogs.length <= 100_000, "proof logs exceeded the bounded redaction window");
      for (const canary of ["fixture-cookie", '"id": 300000', '"id":300000', recoveryProofCredentials.admin.password, recoveryProofCredentials.databaseCredentialsByRuntime["aroma-gateway"].password, materialized.kafkaCredential.password]) {
        assert.equal(boundedLogs.includes(canary), false, "safe-read logs exposed a secret or raw provider canary");
        assert.equal(JSON.stringify({aromaCartEvidence, aromaCartRestartEvidence}).includes(canary), false, "safe-read evidence exposed a secret or raw provider canary");
      }
      aromaCartCleanupReceipt = {composeProject: projectName, disposableDatabase: databaseProofContainer, providerFixture: "aroma-provider-fixture", fixture: "--rm", networks: [`${projectName}_coffee_internal_api`, `${projectName}_coffee_postgres_data`, `${projectName}_coffee_provider_egress`], boundedLogLines: 200, redacted: true};
    } else if (options.databaseProof) {
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
    } else if (options.customerProof) {
      assert.ok(customerProofRoles, "customer proof roles are missing");
      await runCustomerIntegrationProof(projectName, secretsDir, databaseProofCredentials, customerProofRoles, composeFile);
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
        assert.ok(aromaCartProviderFixture, "recovery proof local provider fixture is missing");
        const providerFixtureCalls = await readAromaCartProviderCounts(aromaCartProviderFixture.countFile);
        assert.ok(providerFixtureCalls.catalog >= 1, "recovery proof did not reach the local provider fixture for Catalog traversal");
        recoveryProviderFixtureCalls = providerFixtureCalls;
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
        runtimes: options.aromaBindingProof || options.aromaCartProof ? ["api-internal", "aroma-gateway"] : options.databaseProof || options.customerProof ? 1 : RUNTIMES.length,
        kafka: options.aromaBindingProof || options.aromaCartProof ? false : !(options.databaseProof || options.customerProof),
        kafkaCompatibility: options.aromaBindingProof || options.aromaCartProof ? false : !(options.databaseProof || options.customerProof),
        ephemeralKafkaBroker: !(options.databaseProof || options.customerProof || options.aromaBindingProof || options.aromaCartProof),
        credentialSource: options.stubSecrets || options.databaseProof || options.customerProof || options.recoveryProof || options.aromaBindingProof || options.aromaCartProof
          ? "local-fixture"
          : "canonical-runtime-plus-local-kafka-fixture",
        kafkaRetention: options.aromaBindingProof || options.aromaCartProof ? undefined : options.databaseProof || options.customerProof ? undefined : kafkaRetention,
        recoveryProof: options.recoveryProof
          ? {postgres: recoveryDatabaseProof, kafka: kafkaRetention, native: nativeFoundation, providerFixture: recoveryProviderFixtureCalls}
          : undefined,
        aromaBindingProof: options.aromaBindingProof
          ? {services: ["api-internal", "aroma-gateway"], baseline: aromaBindingEvidence, restartReplay: aromaBindingRestartEvidence, durableBindingCount: 1, cleanup: aromaBindingCleanupReceipt}
          : undefined,
        aromaCartProof: options.aromaCartProof
          ? {services: ["api-internal", "aroma-gateway", "aroma-provider-fixture"], baseline: aromaCartEvidence, restartReplay: aromaCartRestartEvidence, providerCalls: {first: aromaCartEvidence?.providerCalls, restart: aromaCartRestartEvidence?.providerCalls}, cleanup: aromaCartCleanupReceipt}
          : undefined,
        telemetry: options.aromaBindingProof || options.aromaCartProof ? false : !(options.databaseProof || options.customerProof),
        healthEndpoints: options.customerProof ? [] : ["/health/live", "/health/ready", "/metrics"],
        stubSecrets: options.stubSecrets || options.databaseProof || options.customerProof || options.aromaBindingProof || options.aromaCartProof,
        dbIntegrationProof: options.databaseProof || options.customerProof || options.recoveryProof || options.aromaBindingProof || options.aromaCartProof,
        customerIntegrationProof: options.customerProof,
        hostPublish: options.databaseProof || options.customerProof || options.aromaBindingProof || options.aromaCartProof ? [] : ["4000:4000"],
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
    for (const snapshot of [aromaBindingSnapshot, aromaCartSnapshot]) {
      if (snapshot?.database && !options.keep) {
        try {
          await snapshot.database.resource.stop(AbortSignal.timeout(10_000));
        } catch {
          /* preserve the original smoke failure */
        }
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
