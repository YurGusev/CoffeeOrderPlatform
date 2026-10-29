#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  randomUUID,
  X509Certificate,
} from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  checkPlatformConfig,
  ConfigError,
  infrastructureSecretEntries,
  loadEncryptedSecrets,
  loadPlatformConfig,
  validateEncryptedSecretsDocument,
} from "../../scripts/config-lib.mjs";
import { load as parseYaml, dump as dumpYaml } from "js-yaml";
import {
  SERVER_IDENTITY_SQL,
  renderDatabaseSql,
  renderRoleSql,
  validateRoleMap,
  validateServerProbe,
} from "../../scripts/db-bootstrap.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const NGINX_SECRET_FILES = [
  "public.crt",
  "public.key",
  "upstream-ca.crt",
  "client.crt",
  "client.key",
];
const LOCATOR_ENV = new Set([
  "COFFEE_CONFIG_FILE",
  "COFFEE_RUNTIME_SECRETS_FILE",
]);
const BOOTSTRAP_LOCATOR_ENV = new Set([...LOCATOR_ENV, "SOPS_AGE_KEY_FILE"]);
const AROMA_SANDBOX_OWNERS = new Set(["catalog", "orders", "integration"]);
const AROMA_SANDBOX_RUNTIMES = Object.freeze([
  "orders-aroma-preparation",
  "aroma-convergence",
  "catalog-supplier-sync",
  "catalog-activation-worker",
  "catalog-service",
  "aroma-gateway",
]);
const AROMA_SANDBOX_RUN_ID = /^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{7}$/;
const AROMA_SANDBOX_IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/;
const G17_SOCKET_HOST = /^\/dev\/shm\/coffee-g17-[a-f0-9]{16,64}$/;
const G17_SERVER_IDENTITY_KEYS = [
  "candidateSha",
  "host",
  "port",
  "runId",
  "schemaVersion",
  "systemIdentifier",
  "version",
];
const G17_RUNTIME_OWNERS = Object.freeze({
  "orders-aroma-preparation": "orders",
  "aroma-convergence": "orders",
  "aroma-gateway": "integration",
});
const G08_ADMIN_SOURCE = Object.freeze({
  name: "coffee_postgres",
  containerId:
    "267958ce276e65d96c4a5d2cfc4541de35f9785de3dd15c04c34798cf7b1c85f",
  imageId:
    "sha256:1bea307dfb3ee30541a7acf7de14b58bcd6948da98e5d31a04c627c4d35ec64b",
  network: "coffee_network",
});
const G08_ADMIN_SOURCE_INSPECT_FORMAT =
  "{{.Id}}{{println}}{{.Image}}{{println}}{{.State.Running}}{{println}}{{json .NetworkSettings.Networks}}";
const G08_ENCRYPTION_RULE_IDS = new Set([
  "CONFIG-SCHEMA",
  "CONFIG-PLAINTEXT-SECRET",
  "CONFIG-SOPS-MAC",
  "CONFIG-SOPS-RECIPIENT",
  "CONFIG-SOPS-PLAINTEXT",
  "CONFIG-G08-SOPS-OUTPUT",
]);

function g08SafeEncryptionRuleId(error) {
  return error?.name === "ConfigError" &&
    G08_ENCRYPTION_RULE_IDS.has(error.ruleId)
    ? error.ruleId
    : undefined;
}

function fail(rule, message) {
  throw new ConfigError(rule, message);
}

function failG08WithFacts(rule, message, facts) {
  const error = new ConfigError(rule, message);
  error.facts = facts;
  throw error;
}

function g08DatabaseFailureFacts(error, stage) {
  const sqlStateCategories = new Map([
    ["28P01", "authentication"],
    ["28000", "authentication"],
    ["42501", "authorization"],
    ["42883", "missing_function"],
  ]);
  const networkCategories = new Map([
    ["ENOTFOUND", "dns"],
    ["EAI_AGAIN", "dns_temporary"],
    ["ECONNREFUSED", "connection_refused"],
    ["ETIMEDOUT", "timeout"],
    ["EHOSTUNREACH", "host_unreachable"],
    ["ENETUNREACH", "network_unreachable"],
    ["ECONNRESET", "connection_reset"],
  ]);
  const code = typeof error?.code === "string" ? error.code : "";
  const sqlState = sqlStateCategories.has(code) ? code : undefined;
  return {
    stage,
    failureCategory:
      sqlStateCategories.get(code) ??
      networkCategories.get(code) ??
      (error instanceof ConfigError ? "invalid_response" : "unknown"),
    ...(sqlState ? { sqlState } : {}),
  };
}

function g08QueryFailure(error, stage) {
  const failure = new Error("G08 PostgreSQL query failed");
  failure.g08Facts = g08DatabaseFailureFacts(error, stage);
  return failure;
}

function assertLocatorEnv(env, bootstrap) {
  const allowed = bootstrap ? BOOTSTRAP_LOCATOR_ENV : LOCATOR_ENV;
  for (const key of Object.keys(env)) {
    if (
      (key.startsWith("COFFEE_") || key.startsWith("SOPS_")) &&
      !allowed.has(key)
    ) {
      fail(
        "CONFIG-ENV-OVERRIDE",
        `${key}: only configuration locator variables are allowed`,
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

function setSecretAt(target, ref, value) {
  const parts = ref.split(".");
  let current = target;
  for (const part of parts.slice(0, -1)) {
    current[part] ??= {};
    current = current[part];
  }
  current[parts.at(-1)] = value;
}

function decryptInMemory(secretPath, env) {
  const binary = "sops";
  try {
    return parseYaml(
      execFileSync(binary, ["--decrypt", secretPath], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      }).toString("utf8"),
      { json: true },
    );
  } catch (error) {
    fail(
      "CONFIG-SOPS-MAC",
      `cannot decrypt ${secretPath}: ${error.stderr?.toString().trim() || error.message}`,
    );
  }
}

function assertPlainSecretDocument(encrypted, decrypted) {
  if (
    decrypted?.schemaVersion !== 1 ||
    !decrypted?.environments ||
    decrypted?.sops !== undefined
  ) {
    fail("CONFIG-SOPS-PLAINTEXT", "decrypted document has invalid metadata");
  }
  for (const environment of ["development", "staging", "production"]) {
    if (!decrypted.environments[environment])
      fail(
        "CONFIG-SOPS-PLAINTEXT",
        `${environment}: decrypted environment is missing`,
      );
  }
  const encryptedPaths = [];
  const collect = (value, path) => {
    if (path[0] === "sops" || path.at(-1) === "username") return;
    if (typeof value === "string") encryptedPaths.push(path);
    else if (Array.isArray(value))
      value.forEach((child, index) => collect(child, [...path, String(index)]));
    else if (value && typeof value === "object")
      Object.entries(value).forEach(([key, child]) =>
        collect(child, [...path, key]),
      );
  };
  collect(encrypted, []);
  for (const path of encryptedPaths) {
    let current = decrypted;
    for (const part of path) current = current?.[part];
    if (
      typeof current !== "string" ||
      current.length === 0 ||
      current.startsWith("ENC[")
    ) {
      fail(
        "CONFIG-SOPS-PLAINTEXT",
        `${path.join(".")}: decrypted secret is missing`,
      );
    }
  }
  return decrypted;
}

export async function ensureNginxSecretOwnership(directory) {
  const toolchain = JSON.parse(
    await readFile(join(REPO_ROOT, "config/toolchain-versions.json"), "utf8"),
  );
  const nodeImage = toolchain.nodeImage;
  if (
    typeof nodeImage !== "string" ||
    !/^node:[^\s@]+@sha256:[0-9a-f]{64}$/u.test(nodeImage)
  )
    fail("CONFIG-NODE-IMAGE-PIN", "canonical Node image pin is invalid");
  const sourceDir = resolve(directory);
  const secretMountArgs = NGINX_SECRET_FILES.flatMap((name) => [
    "--mount",
    `type=bind,source=${join(sourceDir, name)},target=/secret-input/${name}`,
  ]);
  const ownershipScript = `set -eu; for name in ${NGINX_SECRET_FILES.join(" ")}; do path="/secret-input/$name"; test -f "$path"; test ! -L "$path"; chown 101:101 "$path"; chmod 0400 "$path"; done`;
  execFileSync(
    "docker",
    [
      "run",
      "--rm",
      "--network",
      "none",
      "--read-only",
      "--user",
      "0:0",
      "--cap-drop",
      "ALL",
      "--cap-add",
      "CHOWN",
      "--cap-add",
      "FOWNER",
      ...secretMountArgs,
      nodeImage,
      "sh",
      "-ceu",
      ownershipScript,
    ],
    { stdio: "ignore" },
  );
  const probe = `const fs=require('node:fs'); for (const name of ${JSON.stringify(NGINX_SECRET_FILES)}) { const path='/run/secrets/edge-nginx/'+name; const s=fs.statSync(path); if (s.uid!==101 || s.gid!==101 || (s.mode&0o777)!==0o400) process.exit(3); fs.readFileSync(path); } console.log('edge-nginx PEM ownership/readability verified');`;
  const probeMountArgs = NGINX_SECRET_FILES.flatMap((name) => [
    "--mount",
    `type=bind,source=${join(sourceDir, name)},target=/run/secrets/edge-nginx/${name},readonly`,
  ]);
  execFileSync(
    "docker",
    [
      "run",
      "--rm",
      "--network",
      "none",
      "--read-only",
      "--user",
      "101:101",
      "--cap-drop",
      "ALL",
      ...probeMountArgs,
      nodeImage,
      "node",
      "-e",
      probe,
    ],
    { stdio: "ignore" },
  );
}

export async function materializeRuntimeSecrets({
  root = REPO_ROOT,
  runtime,
  outputDir = "/run/secrets",
  env = process.env,
} = {}) {
  if (!runtime || typeof runtime !== "string")
    fail("CONFIG-RUNTIME", "runtime is required");
  assertLocatorEnv(env, true);
  const secretPath = join(root, "secrets/platform.secrets.sops.yaml");
  const configPath = env.COFFEE_CONFIG_FILE
    ? resolve(env.COFFEE_CONFIG_FILE)
    : join(root, "config/platform.yaml");
  const config = await loadPlatformConfig(root, configPath);
  const nativeNginx = runtime === "edge-nginx";
  if (!nativeNginx && !config.services[runtime])
    fail("CONFIG-RUNTIME", `${runtime}: unknown runtime`);
  if (
    nativeNginx &&
    (!config.nginxTransport ||
      config.nginxTransport.tls?.publicCertificate !==
        "/run/secrets/edge-nginx/public.crt" ||
      config.nginxTransport.tls?.publicPrivateKey !==
        "/run/secrets/edge-nginx/public.key")
  ) {
    fail(
      "CONFIG-NGINX-SECRET",
      "edge-nginx secret paths do not match the native runtime contract",
    );
  }
  const encrypted = await loadEncryptedSecrets(root);
  const decrypted = assertPlainSecretDocument(
    encrypted,
    decryptInMemory(secretPath, env),
  );
  const environment = decrypted.environments[config.environment];
  const refs = nativeNginx
    ? [
        "edge.tlsPrivateKey",
        "edge.tlsCertificate",
        "security.serviceTransportKeys.edge-nginx",
      ]
    : config.services[runtime].secretRefs;
  const optionalRefs = nativeNginx
    ? []
    : (config.services[runtime].optionalSecretRefs ?? []);
  const scoped = {};
  for (const ref of refs) {
    const value = secretValueAt(environment, ref);
    if (value === undefined)
      fail("CONFIG-SECRET-REF", `${runtime}.${ref}: secret does not exist`);
    setSecretAt(scoped, ref, value);
  }
  for (const ref of optionalRefs) {
    const value = secretValueAt(environment, ref);
    if (value !== undefined) setSecretAt(scoped, ref, value);
  }
  if (runtime === "edge-nginx") {
    const publicKey = secretValueAt(scoped, "edge.tlsPrivateKey");
    const publicCert = secretValueAt(scoped, "edge.tlsCertificate");
    const clientRaw = secretValueAt(
      scoped,
      "security.serviceTransportKeys.edge-nginx",
    );
    if (
      typeof publicKey !== "string" ||
      typeof publicCert !== "string" ||
      typeof clientRaw !== "string"
    ) {
      fail(
        "CONFIG-NGINX-SECRET",
        "edge-nginx TLS and service identity material are required",
      );
    }
    const transport = JSON.parse(clientRaw);
    if (
      !transport ||
      Object.keys(transport).sort().join(",") !== "caPem,certPem,keyPem" ||
      ["caPem", "certPem", "keyPem"].some(
        (key) => typeof transport[key] !== "string" || !transport[key],
      )
    ) {
      fail(
        "CONFIG-NGINX-SECRET",
        "edge-nginx service identity material is invalid",
      );
    }
    try {
      const privateKey = createPrivateKey(publicKey);
      const certificate = new X509Certificate(publicCert);
      if (
        createPublicKey(privateKey)
          .export({ type: "spki", format: "der" })
          .compare(
            certificate.publicKey.export({ type: "spki", format: "der" }),
          ) !== 0 ||
        !certificate.checkHost(config.nginxTransport.publicHost)
      ) {
        fail(
          "CONFIG-NGINX-SECRET",
          "edge-nginx public TLS key/certificate does not match configured host",
        );
      }
      const clientKey = createPrivateKey(transport.keyPem);
      const clientCert = new X509Certificate(transport.certPem);
      if (
        createPublicKey(clientKey)
          .export({ type: "spki", format: "der" })
          .compare(
            clientCert.publicKey.export({ type: "spki", format: "der" }),
          ) !== 0 ||
        !clientCert.subjectAltName
          ?.split(",")
          .map((name) => name.trim())
          .includes(
            `URI:spiffe://coffee-platform/${config.environment}/edge-nginx`,
          )
      ) {
        fail(
          "CONFIG-NGINX-SECRET",
          "edge-nginx service identity certificate is invalid",
        );
      }
      new X509Certificate(transport.caPem);
    } catch (error) {
      if (error instanceof ConfigError) throw error;
      fail("CONFIG-NGINX-SECRET", "edge-nginx PEM material is invalid");
    }
    const directory =
      env.COFFEE_RUNTIME_SECRETS_FILE ?? join(outputDir, "edge-nginx");
    await ensurePrivateSecretDirectory(directory);
    const files = {
      "public.crt": publicCert,
      "public.key": publicKey,
      "upstream-ca.crt": transport.caPem,
      "client.crt": transport.certPem,
      "client.key": transport.keyPem,
    };
    for (const [name, value] of Object.entries(files)) {
      const path = join(directory, name);
      await writePrivateSecret(path, value);
    }
    await ensureNginxSecretOwnership(directory);
    return {
      path: directory,
      runtime,
      secretRefs: [...refs],
      files: Object.keys(files),
    };
  }
  const destination =
    env.COFFEE_RUNTIME_SECRETS_FILE ?? join(outputDir, "coffee-platform.yaml");
  await ensurePrivateSecretDirectory(dirname(destination));
  const materialized = dumpYaml(
    {
      schemaVersion: 1,
      environment: config.environment,
      runtime,
      secrets: scoped,
    },
    { noRefs: true, lineWidth: 120 },
  );
  await writePrivateSecret(destination, materialized);
  return { path: destination, runtime, secretRefs: [...refs] };
}

async function readTelemetrySecrets({ root, env, scope }) {
  const refs = await infrastructureSecretEntries(scope, { root });
  assertLocatorEnv(env, true);
  const config = await loadPlatformConfig(
    root,
    env.COFFEE_CONFIG_FILE
      ? resolve(env.COFFEE_CONFIG_FILE)
      : join(root, "config/platform.yaml"),
  );
  const secretPath = join(root, "secrets/platform.secrets.sops.yaml");
  const encrypted = await loadEncryptedSecrets(root);
  for (const entry of refs) {
    const ref = entry[1];
    if (
      secretValueAt(encrypted.environments[config.environment], ref) ===
      undefined
    )
      fail(
        "CONFIG-SECRET-REF",
        `config-bootstrap.${ref}: secret does not exist for ${config.environment}`,
      );
  }
  const decrypted = assertPlainSecretDocument(
    encrypted,
    decryptInMemory(secretPath, env),
  );
  const environment = decrypted.environments[config.environment];
  const values = {};
  for (const [name, ref] of refs) {
    const value = secretValueAt(environment, ref);
    if (typeof value !== "string" || value.length === 0)
      fail(
        "CONFIG-SECRET-REF",
        `config-bootstrap.${ref}: secret does not exist for ${config.environment}`,
      );
    values[name] = value;
  }
  return values;
}

export async function materializeCollectorSecrets({
  root = REPO_ROOT,
  outputDir = "/dev/shm/coffee-platform-observability-secrets",
  env = process.env,
} = {}) {
  await ensurePrivateSecretDirectory(outputDir);
  const scopedPath = join(outputDir, "collector.json");
  const values = await readTelemetrySecrets({
    root,
    env,
    scope: "otel-collector",
  });
  await writePrivateSecret(scopedPath, JSON.stringify(values) + "\n");
  return { path: scopedPath, runtime: "otel-collector" };
}

export async function materializeOpenObserveAdminSecret({
  root = REPO_ROOT,
  outputDir = "/dev/shm/coffee-platform-openobserve-bootstrap",
  env = process.env,
} = {}) {
  await ensurePrivateSecretDirectory(outputDir);
  const path = join(outputDir, "admin-secret");
  const values = await readTelemetrySecrets({
    root,
    env,
    scope: "openobserve-bootstrap",
  });
  await writePrivateSecret(path, `${values["admin-secret"]}\n`);
  return { path, runtime: "config-bootstrap" };
}

export async function ensurePrivateSecretDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await lstat(directory);
  if (
    !metadata.isDirectory() ||
    metadata.uid !== process.getuid() ||
    (await realpath(directory)) !== resolve(directory)
  ) {
    fail(
      "CONFIG-SECRET-OUTPUT",
      "secret output directory must be a real directory owned by config-bootstrap",
    );
  }
  await chmod(directory, 0o700);
}

export async function writePrivateSecret(path, contents) {
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${randomUUID()}.tmp`,
  );
  let handle;
  try {
    const existing = await lstat(path).catch((error) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (existing && !existing.isFile()) {
      fail(
        "CONFIG-SECRET-OUTPUT",
        "existing secret output must be a regular file",
      );
    }
    handle = await open(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(contents, "utf8");
    await handle.chmod(0o400);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch((cleanupError) => {
      if (cleanupError.code !== "ENOENT") throw cleanupError;
    });
    throw error;
  }
}

export async function readTastyCredentials({
  root = REPO_ROOT,
  env = process.env,
} = {}) {
  assertLocatorEnv(env, true);
  const config = await loadPlatformConfig(
    root,
    env.COFFEE_CONFIG_FILE
      ? resolve(env.COFFEE_CONFIG_FILE)
      : join(root, "config/platform.yaml"),
  );
  const encrypted = await loadEncryptedSecrets(root);
  if (!encrypted.environments[config.environment]?.tasty)
    fail("CONFIG-TASTY-CREDENTIAL", "Tasty credentials are not provisioned");
  const decrypted = assertPlainSecretDocument(
    encrypted,
    decryptInMemory(join(root, "secrets/platform.secrets.sops.yaml"), env),
  );
  const { login, password } = decrypted.environments[config.environment].tasty;
  return { login, password };
}

export async function loadRuntimeConfig({
  root = REPO_ROOT,
  runtime,
  env = process.env,
} = {}) {
  if (!runtime || typeof runtime !== "string")
    fail("CONFIG-RUNTIME", "runtime is required");
  assertLocatorEnv(env, false);
  const configPath = env.COFFEE_CONFIG_FILE
    ? resolve(env.COFFEE_CONFIG_FILE)
    : join(root, "config/platform.yaml");
  const config = await loadPlatformConfig(root, configPath);
  if (!config.services[runtime])
    fail("CONFIG-RUNTIME", `${runtime}: unknown runtime`);
  return config.services[runtime];
}

export async function removeMaterializedSecrets(path) {
  await unlink(path).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
}

function aromaSandboxDatabaseNames(runId) {
  if (typeof runId !== "string" || !AROMA_SANDBOX_RUN_ID.test(runId))
    fail("CONFIG-G16-RUN-ID", "G16 run id is invalid");
  const normalized = runId.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  return Object.fromEntries(
    [...AROMA_SANDBOX_OWNERS].map((owner) => {
      const name = `coffee_verify_${normalized}_${owner}`;
      if (!AROMA_SANDBOX_IDENTIFIER.test(name))
        fail("CONFIG-G16-DATABASE", "G16 database name is invalid");
      return [owner, name];
    }),
  );
}

async function g16PostgresVersion(root) {
  const toolchain = JSON.parse(
    await readFile(join(root, "config/toolchain-versions.json"), "utf8"),
  );
  if (
    toolchain?.schemaVersion !== 1 ||
    typeof toolchain.postgresql !== "string" ||
    !/^\d+\.\d+(?:\.\d+)?$/.test(toolchain.postgresql)
  )
    fail("CONFIG-G16-POSTGRES-PIN", "canonical PostgreSQL pin is invalid");
  return toolchain.postgresql;
}

function quoteG16Identifier(value) {
  if (typeof value !== "string" || !AROMA_SANDBOX_IDENTIFIER.test(value))
    fail("CONFIG-G16-IDENTIFIER", "G16 database identifier is invalid");
  return `"${value}"`;
}

async function readG16Secrets(root, env, config) {
  assertLocatorEnv(env, true);
  const secretPath = join(root, "secrets/platform.secrets.sops.yaml");
  const encrypted = await loadEncryptedSecrets(root);
  const decrypted = assertPlainSecretDocument(
    encrypted,
    decryptInMemory(secretPath, env),
  );
  return decrypted.environments[config.environment];
}

async function readG08SecretBundle(root, env) {
  const secretPath = join(root, "secrets/platform.secrets.sops.yaml");
  const encrypted = await loadEncryptedSecrets(root);
  let decrypted;
  try {
    decrypted = parseYaml(
      execFileSync("sops", ["--decrypt", secretPath], {
        cwd: root,
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30_000,
        maxBuffer: 16 * 1024 * 1024,
      }),
      { json: true },
    );
    assertPlainSecretDocument(encrypted, decrypted);
  } catch {
    fail("CONFIG-G08-SECRET-BUNDLE", "trusted G08 secret bundle is invalid");
  }
  return { encrypted, decrypted };
}

function g16BootstrapEnv(env) {
  return {
    ...(typeof env.PATH === "string" ? { PATH: env.PATH } : {}),
    ...(typeof env.HOME === "string" ? { HOME: env.HOME } : {}),
    ...(typeof env.XDG_CONFIG_HOME === "string"
      ? { XDG_CONFIG_HOME: env.XDG_CONFIG_HOME }
      : {}),
    ...(env.SOPS_AGE_KEY_FILE
      ? { SOPS_AGE_KEY_FILE: env.SOPS_AGE_KEY_FILE }
      : {}),
  };
}

async function assertG08NoSymlinkPath(path) {
  const absolute = resolve(path);
  let current = "/";
  for (const part of absolute.slice(1).split("/")) {
    current = join(current, part);
    const info = await lstat(current).catch(() => null);
    if (!info || info.isSymbolicLink())
      fail("CONFIG-G08-CONTEXT", "G08 context path is missing or symlinked");
  }
  if ((await realpath(absolute)) !== absolute)
    fail("CONFIG-G08-CONTEXT", "G08 context path is not canonical");
}

async function validateG08Target({ root, contextPath, env }) {
  const contextEnv = g16BootstrapEnv(env);
  assertLocatorEnv(contextEnv, true);
  if (
    typeof contextPath !== "string" ||
    !contextPath.startsWith("/") ||
    resolve(contextPath) !== contextPath
  )
    fail("CONFIG-G08-CONTEXT", "G08 launch context locator is required");
  await assertG08NoSymlinkPath(contextPath);
  const contextInfo = await lstat(contextPath);
  if (
    !contextInfo.isFile() ||
    contextInfo.uid !== process.getuid() ||
    (contextInfo.mode & 0o777) !== 0o400
  )
    fail(
      "CONFIG-G08-CONTEXT",
      "G08 launch context must be an owner-only readonly regular file",
    );
  let validated;
  try {
    const { validateLaunchContext } =
      await import("../../verification/launch/v1/report.mjs");
    validated = await validateLaunchContext(contextPath);
  } catch {
    fail("CONFIG-G08-CONTEXT", "G08 launch context is invalid");
  }
  const { context, candidateRoot } = validated;
  const contextAfter = await lstat(contextPath).catch(() => null);
  if (
    !contextAfter?.isFile() ||
    contextAfter.isSymbolicLink() ||
    contextAfter.uid !== process.getuid() ||
    (contextAfter.mode & 0o777) !== 0o400 ||
    contextAfter.dev !== contextInfo.dev ||
    contextAfter.ino !== contextInfo.ino
  )
    fail("CONFIG-G08-CONTEXT", "G08 launch context changed during validation");
  if (
    candidateRoot !== resolve(root) ||
    !/^[0-9a-f]{64}$/u.test(context.baseConfigSha256 ?? "")
  )
    fail("CONFIG-G08-CONTEXT", "G08 context does not match candidate/config");

  const configPath = join(root, "config/platform.yaml");
  const configStat = await lstat(configPath).catch(() => null);
  if (
    !configStat?.isFile() ||
    configStat.isSymbolicLink() ||
    configStat.uid !== process.getuid() ||
    (configStat.mode & 0o022) !== 0 ||
    (await realpath(configPath)) !== configPath
  )
    fail("CONFIG-G08-CONFIG", "G08 config is not a canonical regular file");
  const configBytes = await readFile(configPath);
  const configSha256 = createHash("sha256").update(configBytes).digest("hex");
  if (configSha256 !== context.baseConfigSha256)
    fail("CONFIG-G08-CONFIG", "G08 config differs from launch context");
  const config = await loadPlatformConfig(root, configPath);
  if (
    config.environment === "production" ||
    config.postgres.host !== "coffee_postgres" ||
    config.postgres.port !== 5432 ||
    (await g16PostgresVersion(root)) !== "17.11"
  )
    fail(
      "CONFIG-G08-TARGET",
      "G08 requires the canonical non-production PostgreSQL 17.11 endpoint",
    );
  const configStatAfter = await lstat(configPath).catch(() => null);
  const configBytesAfter = await readFile(configPath);
  if (
    !configStatAfter?.isFile() ||
    configStatAfter.isSymbolicLink() ||
    configStatAfter.dev !== configStat.dev ||
    configStatAfter.ino !== configStat.ino ||
    createHash("sha256").update(configBytesAfter).digest("hex") !==
      context.baseConfigSha256
  )
    fail("CONFIG-G08-CONFIG", "G08 config changed during validation");

  const ownership = JSON.parse(
    await readFile(join(root, "config/database-ownership.json"), "utf8"),
  );
  const roleMap = JSON.parse(
    await readFile(join(root, "config/database-role-map.json"), "utf8"),
  );
  try {
    validateRoleMap(roleMap, ownership);
  } catch {
    fail("CONFIG-G08-ROLE-MAP", "canonical database role map is invalid");
  }
  const roles = [
    ...roleMap.databases.map((database) => database.migratorRole),
    ...roleMap.databases.flatMap((database) =>
      database.runtimeRoles.map((runtime) => runtime.role),
    ),
  ];
  if (roles.length !== 15 || new Set(roles).size !== 15)
    fail("CONFIG-G08-ROLE-MAP", "canonical role set is incomplete");

  try {
    const { inspectLaunchCheckout } =
      await import("../../verification/launch/v1/scenarios/rollback.mjs");
    await inspectLaunchCheckout(candidateRoot, context.candidateSha);
  } catch {
    fail(
      "CONFIG-G08-CHECKOUT",
      "G08 candidate checkout is not clean and bound to its committed HEAD",
    );
  }

  let secretBundle;
  try {
    secretBundle = await readG08SecretBundle(root, contextEnv);
  } catch {
    fail("CONFIG-G08-ADMIN-SECRET", "trusted G08 admin secret is unavailable");
  }
  const secrets = secretBundle.decrypted.environments[config.environment];
  const adminPassword = secretValueAt(
    secrets,
    "bootstrap.postgresAdminPassword",
  );
  if (typeof adminPassword !== "string" || adminPassword.length === 0)
    fail("CONFIG-G08-ADMIN-SECRET", "trusted G08 admin secret is unavailable");
  return {
    context,
    contextPath,
    evidenceDir: validated.evidenceDir,
    config,
    configSha256,
    roles,
    adminPassword,
    secrets,
    secretDocument: secretBundle.decrypted,
    encryptedDocument: secretBundle.encrypted,
    ownership,
    roleMap,
    contextInfo,
  };
}

async function captureG08BundleSnapshot(root) {
  const path = join(root, "secrets/platform.secrets.sops.yaml");
  await assertG08NoSymlinkPath(path);
  const info = await lstat(path).catch(() => null);
  if (
    !info?.isFile() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid() ||
    (info.mode & 0o022) !== 0 ||
    info.size > 2 * 1024 * 1024
  )
    fail(
      "CONFIG-G08-BUNDLE",
      "G08 encrypted bundle is not a trusted regular file",
    );
  const bytes = await readFile(path);
  const after = await lstat(path).catch(() => null);
  if (
    !after?.isFile() ||
    after.isSymbolicLink() ||
    after.uid !== process.getuid() ||
    after.dev !== info.dev ||
    after.ino !== info.ino ||
    (after.mode & 0o777) !== (info.mode & 0o777) ||
    after.size !== bytes.length
  )
    fail("CONFIG-G08-BUNDLE", "G08 encrypted bundle changed during snapshot");
  return {
    path,
    dev: info.dev,
    ino: info.ino,
    mode: info.mode & 0o777,
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

async function assertG08BundleSnapshot(snapshot) {
  let info;
  let bytes;
  try {
    info = await lstat(snapshot.path);
    bytes = await readFile(snapshot.path);
  } catch {
    fail("CONFIG-G08-BUNDLE_CHANGED", "G08 encrypted bundle changed");
  }
  const after = await lstat(snapshot.path).catch(() => null);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid() ||
    (info.mode & 0o022) !== 0 ||
    info.dev !== snapshot.dev ||
    info.ino !== snapshot.ino ||
    (info.mode & 0o777) !== snapshot.mode ||
    !after?.isFile() ||
    after.isSymbolicLink() ||
    after.dev !== info.dev ||
    after.ino !== info.ino ||
    (after.mode & 0o777) !== (info.mode & 0o777) ||
    bytes.length !== snapshot.size ||
    createHash("sha256").update(bytes).digest("hex") !== snapshot.sha256
  )
    fail("CONFIG-G08-BUNDLE_CHANGED", "G08 encrypted bundle changed");
}

function encryptG08SecretBundle(root, env, snapshot, secretDocument) {
  let encryptedText;
  try {
    encryptedText = execFileSync(
      "sops",
      [
        "encrypt",
        "--input-type",
        "json",
        "--output-type",
        "yaml",
        "--filename-override",
        snapshot.path,
      ],
      {
        cwd: root,
        env,
        input: JSON.stringify(secretDocument),
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 16 * 1024 * 1024,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
  } catch {
    fail("CONFIG-G08-SOPS-ENCRYPT", "trusted G08 SOPS encryption failed");
  }
  return Buffer.from(encryptedText, "utf8");
}

function assertG08NoPlaintextCiphertext(ciphertext, value, path = []) {
  if (typeof value === "string") {
    if (
      path.at(-1) !== "username" &&
      path.at(-1) !== "schemaVersion" &&
      value.length > 0 &&
      ciphertext.includes(value)
    )
      fail("CONFIG-G08-SOPS-OUTPUT", "G08 ciphertext contains plaintext");
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertG08NoPlaintextCiphertext(ciphertext, entry, [
        ...path,
        String(index),
      ]),
    );
    return;
  }
  if (value && typeof value === "object")
    for (const [key, entry] of Object.entries(value))
      assertG08NoPlaintextCiphertext(ciphertext, entry, [...path, key]);
}

async function validateG08EncryptedDocument(
  root,
  contents,
  label,
  expectedPlaintext,
) {
  let encrypted;
  let validationStage = "ciphertext-parse";
  try {
    encrypted = parseYaml(contents.toString("utf8"), { json: true });
    validationStage = "encrypted-document-validation";
    await validateEncryptedSecretsDocument(root, encrypted, label);
    validationStage = "plaintext-document-validation";
    assertPlainSecretDocument(encrypted, expectedPlaintext);
    validationStage = "plaintext-leak-check";
    assertG08NoPlaintextCiphertext(
      contents.toString("utf8"),
      expectedPlaintext,
    );
  } catch (error) {
    const ruleId = g08SafeEncryptionRuleId(error);
    failG08WithFacts(
      "CONFIG-G08-SOPS-OUTPUT",
      "trusted G08 encrypted bundle failed validation",
      {
        validationStage,
        ...(ruleId ? { ruleId } : {}),
      },
    );
  }
  return encrypted;
}

async function validateG08EncryptedTemporary(
  root,
  env,
  temporary,
  expectedPlaintext,
) {
  const encrypted = await validateG08EncryptedDocument(
    root,
    await readFile(temporary),
    temporary,
    expectedPlaintext,
  );
  let decrypted;
  let validationStage = "temporary-decrypt";
  try {
    const decryptedText = execFileSync(
      "sops",
      ["--decrypt", "--input-type", "yaml", "--output-type", "yaml", temporary],
      {
        cwd: root,
        env,
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 16 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    decrypted = parseYaml(decryptedText, { json: true });
    validationStage = "temporary-plaintext-validation";
    assertPlainSecretDocument(encrypted, decrypted);
    validationStage = "temporary-roundtrip-validation";
    if (!isDeepStrictEqual(decrypted, expectedPlaintext))
      throw new Error("G08 SOPS round-trip changed secrets");
  } catch (error) {
    const ruleId = g08SafeEncryptionRuleId(error);
    failG08WithFacts(
      "CONFIG-G08-SOPS-OUTPUT",
      "trusted G08 encrypted temporary bundle failed validation",
      {
        validationStage,
        ...(ruleId ? { ruleId } : {}),
      },
    );
  }
  for (const environment of Object.values(decrypted.environments)) {
    const migrators = environment?.bootstrap?.migrators;
    if (
      migrators &&
      Object.values(migrators).some(
        (value) => typeof value === "string" && value.startsWith("ENC["),
      )
    )
      fail("CONFIG-G08-SOPS-ROUNDTRIP", "G08 SOPS output was not decrypted");
  }
}

async function writeG08EncryptedBundle(
  snapshot,
  contents,
  { root, env, expectedPlaintext },
) {
  await validateG08EncryptedDocument(
    root,
    contents,
    snapshot.path,
    expectedPlaintext,
  );
  const temporary = join(
    dirname(snapshot.path),
    `.${basename(snapshot.path)}.${randomUUID()}.tmp`,
  );
  let handle;
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(contents);
    await handle.chmod(0o600);
    await handle.sync();
    const temporaryInfo = await handle.stat();
    await handle.close();
    handle = undefined;
    await validateG08EncryptedTemporary(
      root,
      env,
      temporary,
      expectedPlaintext,
    );
    await assertG08BundleSnapshot(snapshot);
    await rename(temporary, snapshot.path);
    const directory = await open(dirname(snapshot.path), constants.O_RDONLY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    const resultInfo = await lstat(snapshot.path);
    const resultBytes = await readFile(snapshot.path);
    const resultInfoAfter = await lstat(snapshot.path).catch(() => null);
    const resultSha256 = createHash("sha256").update(resultBytes).digest("hex");
    if (
      !resultInfo.isFile() ||
      resultInfo.isSymbolicLink() ||
      resultInfo.uid !== process.getuid() ||
      (resultInfo.mode & 0o777) !== 0o600 ||
      resultInfo.dev !== temporaryInfo.dev ||
      resultInfo.ino !== temporaryInfo.ino ||
      !resultInfoAfter?.isFile() ||
      resultInfoAfter.isSymbolicLink() ||
      resultInfoAfter.dev !== resultInfo.dev ||
      resultInfoAfter.ino !== resultInfo.ino ||
      !resultBytes.equals(contents)
    )
      fail(
        "CONFIG-G08-BUNDLE_WRITE",
        "G08 encrypted bundle write is unverified",
      );
    return {
      dev: resultInfo.dev,
      ino: resultInfo.ino,
      size: resultBytes.length,
      sha256: resultSha256,
    };
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    fail("CONFIG-G08-BUNDLE_WRITE", "G08 encrypted bundle write failed");
  } finally {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch((error) => {
      if (error.code !== "ENOENT")
        fail("CONFIG-G08-BUNDLE_TEMP", "G08 temporary bundle cleanup failed");
    });
  }
}

async function readG08SavedSecretBundle(root, env, expectedSnapshot) {
  await assertG08BundleSnapshot(expectedSnapshot);
  const bundle = await readG08SecretBundle(root, env);
  await assertG08BundleSnapshot(expectedSnapshot);
  return bundle;
}

function g08RolePasswords({ ownership, roleMap, secrets }) {
  const passwords = new Map();
  for (const database of roleMap.databases) {
    const owner = ownership.databases.find(
      (entry) => entry.name === database.name,
    )?.owner;
    const migratorPassword = secretValueAt(
      secrets,
      `bootstrap.migrators.${owner}`,
    );
    if (
      typeof owner !== "string" ||
      typeof migratorPassword !== "string" ||
      migratorPassword.length === 0
    )
      fail("CONFIG-G08-MIGRATOR-SECRET", "G08 migrator credential is invalid");
    passwords.set(database.migratorRole, migratorPassword);
    for (const runtime of database.runtimeRoles) {
      const claim = ownership.runtimeClaims.find(
        (entry) =>
          entry.runtime === runtime.runtime && entry.role === runtime.role,
      );
      const credential = claim && secretValueAt(secrets, claim.secretRef);
      if (
        !credential ||
        credential.username !== runtime.role ||
        typeof credential.password !== "string" ||
        credential.password.length === 0
      )
        fail("CONFIG-G08-RUNTIME-SECRET", "G08 runtime credential is invalid");
      passwords.set(runtime.role, credential.password);
    }
  }
  if (passwords.size !== 15)
    fail("CONFIG-G08-ROLE-MAP", "G08 role credential inventory is incomplete");
  return passwords;
}

function g08ExactKeys(value, keys) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(
      Object.keys(value).sort((left, right) => left.localeCompare(right)),
    ) ===
      JSON.stringify([...keys].sort((left, right) => left.localeCompare(right)))
  );
}

/** Permit only the approved isolation and unit-coverage additions after G08. */
export function validateG08PreparationConfigTransition(
  preparationConfigBytes,
  currentConfigBytes,
  preparationConfigSha256,
) {
  if (
    !Buffer.isBuffer(preparationConfigBytes) ||
    !Buffer.isBuffer(currentConfigBytes) ||
    !/^[0-9a-f]{64}$/u.test(preparationConfigSha256 ?? "") ||
    createHash("sha256").update(preparationConfigBytes).digest("hex") !==
      preparationConfigSha256
  )
    fail(
      "CONFIG-G08-PREPARATION-CONFIG",
      "G08 preparation config identity is invalid",
    );

  const preparationText = preparationConfigBytes.toString("utf8");
  const currentText = currentConfigBytes.toString("utf8");
  if (
    !Buffer.from(preparationText, "utf8").equals(preparationConfigBytes) ||
    !Buffer.from(currentText, "utf8").equals(currentConfigBytes)
  )
    fail(
      "CONFIG-G08-PREPARATION-CONFIG",
      "G08 preparation config is not valid UTF-8",
    );
  if (preparationConfigBytes.equals(currentConfigBytes)) return true;

  const matches = (text, pattern) => [...text.matchAll(pattern)].length;
  const databaseIsolationPattern =
    /^  databaseIsolation:(\r?\n)    enabled: false(?=\r?$)/gmu;
  const kafkaIsolationPattern = /^  kafkaNamespaceIsolation: false(?=\r?$)/gmu;
  if (
    matches(preparationText, databaseIsolationPattern) !== 1 ||
    matches(preparationText, kafkaIsolationPattern) !== 1
  )
    fail(
      "CONFIG-G08-PREPARATION-CONFIG",
      "G08 preparation config has no approved isolation transition",
    );

  const expectedText = preparationText
    .replace(
      databaseIsolationPattern,
      "  databaseIsolation:$1    enabled: true",
    )
    .replace(kafkaIsolationPattern, "  kafkaNamespaceIsolation: true");
  if (Buffer.from(expectedText, "utf8").equals(currentConfigBytes)) return true;

  const approvedCoveragePaths = new Set([
    "tests/aroma/api-internal-operations.test.mjs",
    "tests/aroma/safe-read-http.test.mjs",
    "tests/aroma/scoping-provenance.test.mjs",
    "tests/aroma/source-identity.test.mjs",
    "tests/orders/security.test.mjs",
    "tests/orders/observability.test.mjs",
    "tests/aroma/catalog-export.test.mjs",
    "tests/edge-auth/operations.test.mjs",
    "tests/realtime/auth.test.mjs",
    "tests/realtime/contract.test.mjs",
    "tests/realtime/replay.test.mjs",
    "tests/realtime/backpressure.test.mjs",
  ]);
  const foundCoveragePaths = new Set();
  const currentWithoutCoverageAdditions = [];
  let inVerification = false;
  let inUnitCoverage = false;
  let inTestFiles = false;
  for (const line of currentText.split(/(?<=\n)/u)) {
    const content = line.replace(/\r?\n$/u, "");
    if (content === "verification:") inVerification = true;
    else if (inVerification && content.length > 0 && !content.startsWith(" ")) {
      inVerification = false;
      inUnitCoverage = false;
      inTestFiles = false;
    }

    if (inVerification && content === "  unitCoverage:") inUnitCoverage = true;
    else if (inUnitCoverage && /^  [A-Za-z][^:]*:/u.test(content)) {
      inUnitCoverage = false;
      inTestFiles = false;
    }

    if (inUnitCoverage && content === "    testFiles:") inTestFiles = true;
    else if (inTestFiles && /^    [A-Za-z][^:]*:/u.test(content))
      inTestFiles = false;

    const testPath =
      inVerification && inUnitCoverage && inTestFiles
        ? /^      - (.+)$/u.exec(content)?.[1]
        : undefined;
    if (testPath && approvedCoveragePaths.has(testPath)) {
      if (foundCoveragePaths.has(testPath))
        fail(
          "CONFIG-G08-PREPARATION-CONFIG",
          "G08 config repeats an approved coverage test path",
        );
      foundCoveragePaths.add(testPath);
    } else {
      currentWithoutCoverageAdditions.push(line);
    }
  }
  if (
    foundCoveragePaths.size !== approvedCoveragePaths.size ||
    !Buffer.from(expectedText, "utf8").equals(
      Buffer.from(currentWithoutCoverageAdditions.join(""), "utf8"),
    )
  )
    fail(
      "CONFIG-G08-PREPARATION-CONFIG",
      "G08 config changed outside the approved isolation and coverage additions",
    );
  return true;
}

/** Validate the shared G08 receipt shape against a run and the saved secret bundle. */
export function validateG08PreparationArtifact(value, context, secretsSha256) {
  const wrapperKeys = [
    "schemaVersion",
    "runId",
    "candidateSha",
    "baseConfigSha256",
    "preparation",
  ];
  const prepKeys = [
    "schemaVersion",
    "stage",
    "runId",
    "candidateSha",
    "baseConfigSha256",
    "configSha256",
    "postgres",
    "bundle",
    "roleNames",
    "createdCount",
    "transaction",
  ];
  const postgresKeys = [
    "host",
    "port",
    "version",
    "systemIdentifier",
    "database",
    "user",
  ];
  const bundleKeys = ["beforeSha256", "resultingSha256"];
  const prep = value?.preparation;
  if (
    !g08ExactKeys(value, wrapperKeys) ||
    value.schemaVersion !== 1 ||
    value.runId !== context.runId ||
    value.candidateSha !== context.candidateSha ||
    value.baseConfigSha256 !== context.baseConfigSha256 ||
    !g08ExactKeys(prep, prepKeys) ||
    prep.schemaVersion !== 1 ||
    prep.stage !== "roles-created" ||
    !/^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{7}$/u.test(prep.runId ?? "") ||
    !/^[0-9a-f]{40}$/u.test(prep.candidateSha ?? "") ||
    !prep.runId.endsWith(`-${prep.candidateSha.slice(0, 7)}`) ||
    !/^[0-9a-f]{64}$/u.test(prep.baseConfigSha256 ?? "") ||
    prep.configSha256 !== prep.baseConfigSha256 ||
    !g08ExactKeys(prep.postgres, postgresKeys) ||
    prep.postgres.host !== "coffee_postgres" ||
    prep.postgres.port !== 5432 ||
    prep.postgres.version !== "17.11" ||
    prep.postgres.database !== "postgres" ||
    !/^[0-9]{1,20}$/u.test(prep.postgres.systemIdentifier ?? "") ||
    typeof prep.postgres.user !== "string" ||
    !g08ExactKeys(prep.bundle, bundleKeys) ||
    !/^[0-9a-f]{64}$/u.test(prep.bundle.beforeSha256 ?? "") ||
    prep.bundle.resultingSha256 !== secretsSha256 ||
    !Array.isArray(prep.roleNames) ||
    prep.roleNames.length !== 15 ||
    prep.roleNames.some((role) => typeof role !== "string") ||
    new Set(prep.roleNames).size !== 15 ||
    prep.createdCount !== 15 ||
    prep.transaction !== "committed"
  )
    fail(
      "CONFIG-G08-PREPARATION",
      "G08 preparation receipt does not match this run",
    );
  return prep;
}

function g08CreateRoleSql(role, password) {
  if (
    typeof role !== "string" ||
    !/^coffee_[a-z_]+_(?:migrator|rw|ro)$/u.test(role) ||
    typeof password !== "string" ||
    password.length === 0 ||
    password.includes("\0")
  )
    fail("CONFIG-G08-ROLE-CREATE", "G08 role definition is invalid");
  const escapedPassword = password
    .replaceAll("\\", "\\\\")
    .replaceAll("'", "''");
  return `CREATE ROLE "${role}" WITH LOGIN PASSWORD E'${escapedPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 20`;
}

async function readG08ServerState(client, target, expectedSystemIdentifier) {
  let identityResult;
  try {
    identityResult = await client.query(SERVER_IDENTITY_SQL);
  } catch (error) {
    throw g08QueryFailure(error, "identity");
  }
  const probe = identityResult.rows?.[0];
  if (
    !probe ||
    probe.current_user !== target.config.postgres.bootstrapUsername ||
    probe.current_database !== "postgres" ||
    typeof probe.system_identifier !== "string" ||
    !/^[0-9]{1,20}$/u.test(probe.system_identifier) ||
    String(probe.server_version_num) !== "170011"
  )
    fail("CONFIG-G08-PROBE", "G08 PostgreSQL admin identity is invalid");
  const identity = validateServerProbe(probe, {
    expectedServerIdentity: expectedSystemIdentifier ?? probe.system_identifier,
    expectedServerVersion: "17.11",
  });
  let inventory;
  try {
    inventory = await client.query(
      "SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolinherit, rolreplication, rolbypassrls, rolconnlimit FROM pg_roles WHERE rolname = ANY($1::text[])",
      [target.roles],
    );
  } catch (error) {
    throw g08QueryFailure(error, "role-inventory");
  }
  const rows = inventory.rows ?? [];
  const rowByName = new Map();
  for (const row of rows) {
    if (!target.roles.includes(row.rolname) || rowByName.has(row.rolname))
      fail("CONFIG-G08-ROLE-INVENTORY", "G08 role inventory is invalid");
    rowByName.set(row.rolname, row);
  }
  const existingRoles = target.roles.flatMap((role) => {
    const row = rowByName.get(role);
    return row
      ? [
          {
            role,
            login: row.rolcanlogin === true,
            superuser: row.rolsuper === true,
            createDb: row.rolcreatedb === true,
            createRole: row.rolcreaterole === true,
            inherit: row.rolinherit === true,
            replication: row.rolreplication === true,
            bypassRls: row.rolbypassrls === true,
            connectionLimit: row.rolconnlimit,
          },
        ]
      : [];
  });
  return {
    postgres: {
      host: target.config.postgres.host,
      port: target.config.postgres.port,
      version: identity.serverVersion,
      systemIdentifier: probe.system_identifier,
      database: probe.current_database,
      user: probe.current_user,
    },
    roleInventory: {
      expectedCount: target.roles.length,
      existing: existingRoles,
      allAbsent: existingRoles.length === 0,
    },
  };
}

async function openG08AdminClient(
  target,
  adminPassword = target.adminPassword,
) {
  const { Client } = await import("pg").catch(() =>
    fail("CONFIG-G08-PG-DEPENDENCY", "pg dependency is unavailable"),
  );
  return new Client({
    host: target.config.postgres.host,
    port: target.config.postgres.port,
    database: "postgres",
    user: target.config.postgres.bootstrapUsername,
    password: adminPassword,
    ssl: false,
    connectionTimeoutMillis: 3_000,
  });
}

async function probeG08TargetState(
  target,
  expectedSystemIdentifier,
  adminPassword = target.adminPassword,
) {
  const client = await openG08AdminClient(target, adminPassword);
  let state;
  let failureFacts;
  let stage = "connect";
  try {
    await client.connect();
    stage = "identity";
    state = await readG08ServerState(client, target, expectedSystemIdentifier);
  } catch (error) {
    failureFacts = error?.g08Facts ?? g08DatabaseFailureFacts(error, stage);
  }
  await client.end().catch((error) => {
    if (!failureFacts) failureFacts = g08DatabaseFailureFacts(error, "close");
  });
  if (failureFacts)
    failG08WithFacts(
      "CONFIG-G08-PROBE",
      "G08 canonical target probe failed",
      failureFacts,
    );
  return state;
}

function inspectG08AdminSource(env, stage) {
  let output;
  try {
    output = execFileSync(
      "docker",
      [
        "inspect",
        "--format",
        G08_ADMIN_SOURCE_INSPECT_FORMAT,
        G08_ADMIN_SOURCE.name,
      ],
      {
        env: g16BootstrapEnv(env),
        encoding: "utf8",
        timeout: 5_000,
        maxBuffer: 64 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch {
    failG08WithFacts(
      "CONFIG-G08-ADMIN-SOURCE",
      "approved PostgreSQL credential source could not be inspected",
      { stage },
    );
  }
  const lines = output.trimEnd().split("\n");
  let networks;
  try {
    if (lines.length !== 4) throw new Error("invalid docker inspect output");
    networks = JSON.parse(lines[3]);
  } catch {
    failG08WithFacts(
      "CONFIG-G08-ADMIN-SOURCE",
      "approved PostgreSQL credential source identity is invalid",
      { stage },
    );
  }
  const networkId = networks?.[G08_ADMIN_SOURCE.network]?.NetworkID;
  const source = {
    containerId: lines[0],
    imageId: lines[1],
    running: lines[2] === "true",
    networkId,
  };
  if (
    source.containerId !== G08_ADMIN_SOURCE.containerId ||
    source.imageId !== G08_ADMIN_SOURCE.imageId ||
    !source.running ||
    typeof source.networkId !== "string" ||
    !/^[0-9a-f]{64}$/u.test(source.networkId)
  )
    failG08WithFacts(
      "CONFIG-G08-ADMIN-SOURCE",
      "approved PostgreSQL credential source identity changed",
      {
        stage,
        containerId: source.containerId,
        imageId: source.imageId,
        running: source.running,
        networkName: G08_ADMIN_SOURCE.network,
      },
    );
  return source;
}

function readG08AdminPasswordFromSource(env) {
  const before = inspectG08AdminSource(env, "container-before-extract");
  let passwordBytes;
  try {
    passwordBytes = execFileSync(
      "docker",
      [
        "exec",
        before.containerId,
        "/bin/sh",
        "-c",
        'printf %s "$POSTGRES_PASSWORD"',
      ],
      {
        env: g16BootstrapEnv(env),
        timeout: 5_000,
        maxBuffer: 4_096,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch {
    failG08WithFacts(
      "CONFIG-G08-ADMIN-SOURCE",
      "approved PostgreSQL credential is unavailable",
      { stage: "credential-extract" },
    );
  }
  const after = inspectG08AdminSource(env, "container-after-extract");
  if (!isDeepStrictEqual(before, after))
    failG08WithFacts(
      "CONFIG-G08-ADMIN-SOURCE_CHANGED",
      "PostgreSQL credential source changed during extraction",
      {
        stage: "container-after-extract",
        containerId: after.containerId,
        imageId: after.imageId,
        networkName: G08_ADMIN_SOURCE.network,
      },
    );
  const password = passwordBytes.toString("utf8");
  if (
    password.length === 0 ||
    !Buffer.from(password, "utf8").equals(passwordBytes)
  )
    failG08WithFacts(
      "CONFIG-G08-ADMIN-SOURCE",
      "approved PostgreSQL credential is invalid",
      { stage: "credential-validate" },
    );
  return password;
}

function isG08AdminAuthenticationFailure(error) {
  return (
    error instanceof ConfigError &&
    error.ruleId === "CONFIG-G08-PROBE" &&
    error.facts?.stage === "connect" &&
    error.facts?.failureCategory === "authentication" &&
    error.facts?.sqlState === "28P01"
  );
}

function assertG08AdminIdentityAndRoles(state, expectedSystemIdentifier) {
  if (
    state.postgres.systemIdentifier !== expectedSystemIdentifier ||
    state.postgres.version !== "17.11" ||
    state.postgres.user !== "coffeeuser" ||
    state.postgres.database !== "postgres"
  )
    failG08WithFacts(
      "CONFIG-G08-IDENTITY",
      "G08 target differs from approved identity",
      {
        stage: "readonly-probe",
        expectedSystemIdentifier,
        postgres: state.postgres,
      },
    );
  if (!state.roleInventory.allAbsent)
    failG08WithFacts(
      "CONFIG-G08-ROLE-PRESENT",
      "G08 admin credential synchronization requires all canonical roles absent",
      {
        stage: "readonly-probe",
        postgres: state.postgres,
        roleInventory: state.roleInventory,
      },
    );
}

/** Read-only G08 probe; it never creates roles or databases. */
export async function probeG08CanonicalTarget({
  root = REPO_ROOT,
  contextPath = process.env.COFFEE_LAUNCH_CONTEXT_FILE,
  env = process.env,
} = {}) {
  let target;
  try {
    target = await validateG08Target({ root, contextPath, env });
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    fail("CONFIG-G08-TARGET", "G08 canonical target validation failed");
  }
  const state = await probeG08TargetState(target);
  return {
    schemaVersion: 1,
    stage: "readonly-probe",
    runId: target.context.runId,
    candidateSha: target.context.candidateSha,
    baseConfigSha256: target.context.baseConfigSha256,
    configSha256: target.configSha256,
    ...state,
  };
}

/** Return the prepared PostgreSQL identity only after a fresh G08-bound probe. */
export async function readG08PreparedPostgresIdentity({
  root = REPO_ROOT,
  contextPath = process.env.COFFEE_LAUNCH_CONTEXT_FILE,
  preparationContextPath,
  env = process.env,
} = {}) {
  const bundleSnapshot = await captureG08BundleSnapshot(root);
  const target = await validateG08Target({ root, contextPath, env });
  await assertG08BundleSnapshot(bundleSnapshot);
  const preparationSource = await readG08PreparationSource(
    target,
    root,
    preparationContextPath,
  );
  const { preparation, snapshot: preparationSnapshot } =
    await readG08PreparationSnapshot(
      target,
      root,
      bundleSnapshot,
      preparationSource,
    );
  const state = await probeG08TargetState(
    target,
    preparation.postgres.systemIdentifier,
  );
  if (
    state.postgres.host !== preparation.postgres.host ||
    state.postgres.port !== preparation.postgres.port ||
    state.postgres.version !== preparation.postgres.version ||
    state.postgres.systemIdentifier !== preparation.postgres.systemIdentifier ||
    state.postgres.user !== preparation.postgres.user ||
    state.postgres.database !== preparation.postgres.database
  )
    fail(
      "CONFIG-G08-IDENTITY",
      "G08 live target differs from preparation receipt",
    );
  assertG08PreparedRoleInventory(state, target.roles);
  await assertG08BundleSnapshot(bundleSnapshot);
  await assertG08PreparationSnapshot(preparationSnapshot);
  await assertG08PreparationSource(target, root, preparationSource);
  return Object.freeze({ ...state.postgres });
}

/** Verify the existing admin credential, syncing only its SOPS field on exact 28P01. */
export async function synchronizeG08AdminCredential({
  root = REPO_ROOT,
  contextPath = process.env.COFFEE_LAUNCH_CONTEXT_FILE,
  env = process.env,
  expectedSystemIdentifier,
} = {}) {
  if (
    typeof expectedSystemIdentifier !== "string" ||
    !/^[0-9]{1,20}$/u.test(expectedSystemIdentifier)
  )
    fail("CONFIG-G08-IDENTITY", "approved G08 system identifier is required");

  const contextEnv = g16BootstrapEnv(env);
  assertLocatorEnv(contextEnv, true);
  const bundleSnapshot = await captureG08BundleSnapshot(root);
  let target;
  try {
    target = await validateG08Target({ root, contextPath, env: contextEnv });
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    fail("CONFIG-G08-TARGET", "G08 canonical target validation failed");
  }
  await assertG08BundleSnapshot(bundleSnapshot);
  if (
    target.config.environment !== "development" ||
    target.config.postgres.bootstrapUsername !== "coffeeuser"
  )
    fail(
      "CONFIG-G08-TARGET",
      "admin credential sync requires development coffeeuser",
    );

  let state;
  try {
    state = await probeG08TargetState(target, expectedSystemIdentifier);
  } catch (error) {
    if (!isG08AdminAuthenticationFailure(error)) throw error;
    const sourcePassword = readG08AdminPasswordFromSource(contextEnv);
    state = await probeG08TargetState(
      target,
      expectedSystemIdentifier,
      sourcePassword,
    );
    assertG08AdminIdentityAndRoles(state, expectedSystemIdentifier);

    const proposedDocument = structuredClone(target.secretDocument);
    setSecretAt(
      proposedDocument.environments.development,
      "bootstrap.postgresAdminPassword",
      sourcePassword,
    );
    const encrypted = encryptG08SecretBundle(
      root,
      contextEnv,
      bundleSnapshot,
      proposedDocument,
    );
    const resultingSnapshot = await writeG08EncryptedBundle(
      bundleSnapshot,
      encrypted,
      { root, env: contextEnv, expectedPlaintext: proposedDocument },
    );
    const savedSnapshot = {
      path: bundleSnapshot.path,
      dev: resultingSnapshot.dev,
      ino: resultingSnapshot.ino,
      mode: 0o600,
      size: resultingSnapshot.size,
      sha256: resultingSnapshot.sha256,
    };
    const savedBundle = await readG08SavedSecretBundle(
      root,
      contextEnv,
      savedSnapshot,
    );
    if (!isDeepStrictEqual(savedBundle.decrypted, proposedDocument))
      failG08WithFacts(
        "CONFIG-G08-SOPS-ROUNDTRIP",
        "G08 admin credential write changed another secret field",
        {
          stage: "admin-secret-saved",
          bundleBeforeSha256: bundleSnapshot.sha256,
          bundleResultingSha256: resultingSnapshot.sha256,
          systemIdentifier: expectedSystemIdentifier,
        },
      );
    return {
      schemaVersion: 1,
      stage: "admin-credential-synchronized",
      runId: target.context.runId,
      candidateSha: target.context.candidateSha,
      systemIdentifier: expectedSystemIdentifier,
      credentialSource: "approved-container",
      source: {
        containerId: G08_ADMIN_SOURCE.containerId,
        imageId: G08_ADMIN_SOURCE.imageId,
        networkName: G08_ADMIN_SOURCE.network,
      },
      bundle: {
        beforeSha256: bundleSnapshot.sha256,
        resultingSha256: resultingSnapshot.sha256,
      },
    };
  }

  assertG08AdminIdentityAndRoles(state, expectedSystemIdentifier);
  return {
    schemaVersion: 1,
    stage: "admin-credential-verified",
    runId: target.context.runId,
    candidateSha: target.context.candidateSha,
    systemIdentifier: expectedSystemIdentifier,
    credentialSource: "existing-sops",
    bundleSha256: bundleSnapshot.sha256,
    postgres: state.postgres,
    roleInventory: state.roleInventory,
  };
}

/** Conditionally prepare the canonical migrator LOGIN roles from trusted SOPS data. */
export async function prepareG08CanonicalMigratorRoles({
  root = REPO_ROOT,
  contextPath = process.env.COFFEE_LAUNCH_CONTEXT_FILE,
  env = process.env,
  expectedSystemIdentifier,
} = {}) {
  if (
    typeof expectedSystemIdentifier !== "string" ||
    !/^[0-9]{1,20}$/u.test(expectedSystemIdentifier)
  )
    fail("CONFIG-G08-IDENTITY", "approved G08 system identifier is required");

  const contextEnv = g16BootstrapEnv(env);
  assertLocatorEnv(contextEnv, true);
  const bundleSnapshot = await captureG08BundleSnapshot(root);
  let target;
  try {
    target = await validateG08Target({ root, contextPath, env: contextEnv });
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    fail("CONFIG-G08-TARGET", "G08 canonical target validation failed");
  }
  await assertG08BundleSnapshot(bundleSnapshot);

  const initialState = await probeG08TargetState(target);
  if (
    initialState.postgres.systemIdentifier !== expectedSystemIdentifier ||
    initialState.postgres.version !== "17.11"
  )
    failG08WithFacts(
      "CONFIG-G08-IDENTITY",
      "G08 target differs from approved identity",
      {
        stage: "readonly-probe",
        expectedSystemIdentifier,
        postgres: initialState.postgres,
        bundleSha256: bundleSnapshot.sha256,
      },
    );
  if (!initialState.roleInventory.allAbsent)
    failG08WithFacts(
      "CONFIG-G08-ROLE-PRESENT",
      "G08 preparation requires all canonical roles to be absent",
      {
        stage: "readonly-probe",
        postgres: initialState.postgres,
        roleInventory: initialState.roleInventory,
        bundleSha256: bundleSnapshot.sha256,
      },
    );

  for (const environment of Object.values(target.secretDocument.environments))
    if (environment?.bootstrap?.migrators !== undefined)
      failG08WithFacts(
        "CONFIG-G08-MIGRATOR-BLOCK_PRESENT",
        "G08 migrator credentials already exist; refusing regeneration",
        {
          stage: "preparation-admission",
          postgres: initialState.postgres,
          roleInventory: initialState.roleInventory,
          bundleSha256: bundleSnapshot.sha256,
        },
      );

  await assertG08BundleSnapshot(bundleSnapshot);
  const secretDocument = structuredClone(target.secretDocument);
  const selectedEnvironment =
    secretDocument.environments[target.config.environment];
  const ownerNames = target.ownership.databases.map(
    (database) => database.owner,
  );
  const canonicalOwners = [
    "customer",
    "catalog",
    "pricing",
    "orders",
    "integration",
  ];
  if (
    ownerNames.length !== canonicalOwners.length ||
    new Set(ownerNames).size !== canonicalOwners.length ||
    [...ownerNames]
      .sort((left, right) => left.localeCompare(right))
      .join(",") !==
      [...canonicalOwners]
        .sort((left, right) => left.localeCompare(right))
        .join(",")
  )
    fail("CONFIG-G08-ROLE-MAP", "G08 owner set is not canonical");
  const generatedMigrators = Object.fromEntries(
    ownerNames.map((owner) => [owner, randomBytes(32).toString("base64url")]),
  );
  selectedEnvironment.bootstrap.migrators = generatedMigrators;
  const proposedPasswords = g08RolePasswords({
    ownership: target.ownership,
    roleMap: target.roleMap,
    secrets: selectedEnvironment,
  });
  const adminPassword = secretValueAt(
    selectedEnvironment,
    "bootstrap.postgresAdminPassword",
  );
  if (
    [...proposedPasswords.values()].some(
      (password) => password === adminPassword,
    )
  )
    fail(
      "CONFIG-G08-ROLE-SECRET",
      "G08 role credentials must be distinct from admin",
    );

  const encryptedContents = encryptG08SecretBundle(
    root,
    contextEnv,
    bundleSnapshot,
    secretDocument,
  );
  const resultBundleSnapshot = await writeG08EncryptedBundle(
    bundleSnapshot,
    encryptedContents,
    { root, env: contextEnv, expectedPlaintext: secretDocument },
  );
  const savedBundleSnapshot = {
    path: bundleSnapshot.path,
    dev: resultBundleSnapshot.dev,
    ino: resultBundleSnapshot.ino,
    mode: 0o600,
    size: resultBundleSnapshot.size,
    sha256: resultBundleSnapshot.sha256,
  };
  const savedBundle = await readG08SavedSecretBundle(root, contextEnv, {
    ...savedBundleSnapshot,
  });
  const savedWithoutMigrators = structuredClone(savedBundle.decrypted);
  delete savedWithoutMigrators.environments[target.config.environment].bootstrap
    .migrators;
  if (!isDeepStrictEqual(savedWithoutMigrators, target.secretDocument))
    fail(
      "CONFIG-G08-SOPS-ROUNDTRIP",
      "G08 encrypted bundle changed data outside the migrator block",
    );
  const savedMigrators =
    savedBundle.decrypted.environments[target.config.environment].bootstrap
      .migrators;
  if (
    !savedMigrators ||
    Object.keys(savedMigrators).sort().join(",") !==
      [...canonicalOwners].sort().join(",") ||
    !canonicalOwners.every(
      (owner) => savedMigrators[owner] === generatedMigrators[owner],
    )
  )
    fail(
      "CONFIG-G08-SOPS-ROUNDTRIP",
      "G08 saved migrator credentials do not match",
    );

  const savedEnvironment =
    savedBundle.decrypted.environments[target.config.environment];
  const savedAdminPassword = secretValueAt(
    savedEnvironment,
    "bootstrap.postgresAdminPassword",
  );
  const rolePasswords = g08RolePasswords({
    ownership: target.ownership,
    roleMap: target.roleMap,
    secrets: savedEnvironment,
  });
  if (
    typeof savedAdminPassword !== "string" ||
    savedAdminPassword.length === 0 ||
    [...rolePasswords.values()].some(
      (password) => password === savedAdminPassword,
    )
  )
    fail("CONFIG-G08-ROLE-SECRET", "G08 saved role credentials are invalid");

  target.adminPassword = savedAdminPassword;
  const client = await openG08AdminClient(target);
  let transactionOpen = false;
  let commitAttempted = false;
  let committed = false;
  let failureCode;
  let failureFacts;
  try {
    await client.connect();
    await client.query("BEGIN");
    transactionOpen = true;
    let transactionState;
    try {
      transactionState = await readG08ServerState(client, target);
    } catch {
      failureCode = "CONFIG-G08-TRANSACTION-PROBE";
      failureFacts = {
        stage: "role-transaction-probe-failed",
        expectedSystemIdentifier,
        bundleBeforeSha256: bundleSnapshot.sha256,
        bundleResultingSha256: resultBundleSnapshot.sha256,
        roleNames: target.roles,
      };
      throw new Error("G08 transaction probe failed");
    }
    if (
      transactionState.postgres.systemIdentifier !== expectedSystemIdentifier ||
      transactionState.postgres.version !== "17.11"
    ) {
      failureCode = "CONFIG-G08-IDENTITY_CHANGED";
      failureFacts = {
        stage: "role-transaction",
        expectedSystemIdentifier,
        postgres: transactionState.postgres,
        bundleBeforeSha256: bundleSnapshot.sha256,
        bundleResultingSha256: resultBundleSnapshot.sha256,
      };
      throw new Error("G08 target identity changed before role creation");
    }
    if (!transactionState.roleInventory.allAbsent) {
      failureCode = "CONFIG-G08-ROLE_CONFLICT";
      failureFacts = {
        stage: "role-transaction",
        postgres: transactionState.postgres,
        roleInventory: transactionState.roleInventory,
        bundleBeforeSha256: bundleSnapshot.sha256,
        bundleResultingSha256: resultBundleSnapshot.sha256,
      };
      throw new Error("G08 role inventory changed before role creation");
    }
    await assertG08BundleSnapshot(savedBundleSnapshot);
    for (const [role, password] of rolePasswords)
      await client.query(g08CreateRoleSql(role, password));
    commitAttempted = true;
    await client.query("COMMIT");
    transactionOpen = false;
    committed = true;
  } catch (error) {
    if (commitAttempted) {
      failureCode = "CONFIG-G08-COMMIT-UNKNOWN";
      failureFacts = {
        stage: "commit-outcome-unknown",
        expectedSystemIdentifier,
        bundleBeforeSha256: bundleSnapshot.sha256,
        bundleResultingSha256: resultBundleSnapshot.sha256,
        roleNames: target.roles,
      };
      transactionOpen = false;
    } else if (transactionOpen) {
      try {
        await client.query("ROLLBACK");
        transactionOpen = false;
      } catch {
        failureCode = "CONFIG-G08-ROLLBACK-UNKNOWN";
        failureFacts = {
          stage: "rollback-outcome-unknown",
          expectedSystemIdentifier,
          bundleBeforeSha256: bundleSnapshot.sha256,
          bundleResultingSha256: resultBundleSnapshot.sha256,
          roleNames: target.roles,
        };
        transactionOpen = false;
      }
    }
    if (!failureCode) {
      if (
        error instanceof ConfigError &&
        error.ruleId === "CONFIG-G08-BUNDLE_CHANGED"
      ) {
        failureCode = "CONFIG-G08-BUNDLE_CHANGED";
        failureFacts = {
          stage: "bundle-changed-before-role-create",
          expectedSystemIdentifier,
          bundleBeforeSha256: bundleSnapshot.sha256,
          bundleResultingSha256: resultBundleSnapshot.sha256,
          roleNames: target.roles,
        };
      } else {
        failureCode = "CONFIG-G08-ROLE-CREATE";
        failureFacts = {
          stage: "role-transaction-rolled-back",
          expectedSystemIdentifier,
          bundleBeforeSha256: bundleSnapshot.sha256,
          bundleResultingSha256: resultBundleSnapshot.sha256,
          roleNames: target.roles,
        };
      }
    }
  }
  let closeFailed = false;
  await client.end().catch(() => {
    closeFailed = true;
  });
  if (failureCode) {
    if (failureCode === "CONFIG-G08-COMMIT-UNKNOWN")
      failG08WithFacts(
        failureCode,
        "G08 COMMIT outcome is unknown; no automatic repair or retry was attempted",
        failureFacts,
      );
    if (failureCode === "CONFIG-G08-ROLLBACK-UNKNOWN")
      failG08WithFacts(
        failureCode,
        "G08 rollback outcome is unknown; no automatic repair was attempted",
        failureFacts,
      );
    failG08WithFacts(
      failureCode,
      "G08 canonical role preparation failed",
      failureFacts,
    );
  }
  if (!committed)
    fail("CONFIG-G08-ROLE-CREATE", "G08 canonical role preparation failed");
  if (closeFailed)
    failG08WithFacts(
      "CONFIG-G08-COMMIT-CLOSE",
      "G08 roles committed but the database connection did not close cleanly",
      {
        stage: "roles-committed-close-failed",
        expectedSystemIdentifier,
        bundleBeforeSha256: bundleSnapshot.sha256,
        bundleResultingSha256: resultBundleSnapshot.sha256,
        roleNames: target.roles,
      },
    );
  return {
    schemaVersion: 1,
    stage: "roles-created",
    runId: target.context.runId,
    candidateSha: target.context.candidateSha,
    baseConfigSha256: target.context.baseConfigSha256,
    configSha256: target.configSha256,
    postgres: initialState.postgres,
    bundle: {
      beforeSha256: bundleSnapshot.sha256,
      resultingSha256: resultBundleSnapshot.sha256,
    },
    roleNames: target.roles,
    createdCount: rolePasswords.size,
    transaction: "committed",
  };
}

async function readG08PreparationSource(target, root, preparationContextPath) {
  const rawResources = target.context.resources;
  if (
    rawResources !== undefined &&
    (!rawResources ||
      typeof rawResources !== "object" ||
      Array.isArray(rawResources))
  )
    fail("CONFIG-G08-PREPARATION", "G08 preparation metadata is invalid");
  const resources = rawResources ?? {};

  if (preparationContextPath === undefined) {
    if (
      Object.keys(resources).some(
        (key) =>
          key === "g08PreparationContextPath" || key.startsWith("g15Parent"),
      )
    )
      fail(
        "CONFIG-G08-G15-LINEAGE",
        "G15 parent preparation reference is required",
      );
    return {
      context: target.context,
      evidenceDir: target.evidenceDir,
      contextPath: target.contextPath,
      configBytes: await readFile(join(root, "config/platform.yaml")),
      g15: false,
    };
  }

  const parentKeys = [
    "composeProject",
    "g08PreparationContextPath",
    "g15ParentCandidateSha",
    "g15ParentCheckoutRoot",
    "g15ParentRunId",
    "kafkaPrefix",
  ];
  if (
    !g08ExactKeys(resources, parentKeys) ||
    typeof preparationContextPath !== "string" ||
    !preparationContextPath.startsWith("/") ||
    resolve(preparationContextPath) !== preparationContextPath ||
    resources.g08PreparationContextPath !== preparationContextPath ||
    !/^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{7}$/u.test(resources.g15ParentRunId ?? "") ||
    !/^[0-9a-f]{40}$/u.test(resources.g15ParentCandidateSha ?? "") ||
    !/^\/[^\0]+$/u.test(resources.g15ParentCheckoutRoot ?? "") ||
    target.context.runId === resources.g15ParentRunId ||
    resources.kafkaPrefix !== target.context.runId ||
    resources.composeProject !==
      `coffee-launch-${target.context.runId.toLowerCase()}`
  )
    fail(
      "CONFIG-G08-G15-LINEAGE",
      "G15 parent preparation reference is invalid",
    );

  await assertG08NoSymlinkPath(preparationContextPath);
  const contextInfo = await lstat(preparationContextPath).catch(() => null);
  if (
    !contextInfo?.isFile() ||
    contextInfo.uid !== process.getuid() ||
    (contextInfo.mode & 0o777) !== 0o400 ||
    contextInfo.size > 16 * 1024
  )
    fail("CONFIG-G08-G15-LINEAGE", "G15 parent launch context is not trusted");
  const contextBytes = await readFile(preparationContextPath);
  let sourceContext;
  try {
    sourceContext = JSON.parse(contextBytes.toString("utf8"));
  } catch {
    fail("CONFIG-G08-G15-LINEAGE", "G15 parent context is invalid");
  }
  if (
    sourceContext.runId !== resources.g15ParentRunId ||
    sourceContext.candidateSha !== resources.g15ParentCandidateSha ||
    sourceContext.checkoutDir !== resources.g15ParentCheckoutRoot ||
    !/^[0-9a-f]{64}$/u.test(sourceContext.baseConfigSha256 ?? "") ||
    !sourceContext.evidenceDir ||
    resolve(preparationContextPath) !==
      resolve(sourceContext.evidenceDir, "context.json")
  )
    fail(
      "CONFIG-G08-G15-LINEAGE",
      "G15 parent context does not match child identity",
    );

  let sourceValidated;
  try {
    const reportPath = join(
      sourceContext.sourceRepoRoot,
      "verification/launch/v1/report.mjs",
    );
    await assertG08NoSymlinkPath(reportPath);
    const { validateLaunchContext } = await import(
      pathToFileURL(reportPath).href
    );
    sourceValidated = await validateLaunchContext(preparationContextPath);
  } catch {
    fail(
      "CONFIG-G08-G15-LINEAGE",
      "G15 parent launch context could not be validated",
    );
  }
  const contextInfoAfter = await lstat(preparationContextPath).catch(
    () => null,
  );
  const contextBytesAfter = await readFile(preparationContextPath).catch(
    () => null,
  );
  if (
    !contextInfoAfter?.isFile() ||
    contextInfoAfter.isSymbolicLink() ||
    contextInfoAfter.uid !== process.getuid() ||
    (contextInfoAfter.mode & 0o777) !== 0o400 ||
    contextInfoAfter.dev !== contextInfo.dev ||
    contextInfoAfter.ino !== contextInfo.ino ||
    !contextBytesAfter?.equals(contextBytes) ||
    !isDeepStrictEqual(sourceValidated.context, sourceContext) ||
    sourceValidated.candidateRoot !== resources.g15ParentCheckoutRoot
  )
    fail(
      "CONFIG-G08-G15-LINEAGE",
      "G15 parent context changed during validation",
    );

  let inspectLaunchCheckout;
  try {
    ({ inspectLaunchCheckout } =
      await import("../../verification/launch/v1/scenarios/rollback.mjs"));
    await inspectLaunchCheckout(
      resources.g15ParentCheckoutRoot,
      sourceContext.candidateSha,
    );
  } catch {
    fail(
      "CONFIG-G08-G15-LINEAGE",
      "G15 parent checkout is not clean and bound to its context",
    );
  }

  let lineage;
  try {
    const { readG15FixtureLineage } = await import("./browser-fixture.mjs");
    lineage = await readG15FixtureLineage({
      root: target.context.sourceRepoRoot,
      contextPath: target.contextPath,
      baseCandidateSha: sourceContext.candidateSha,
    });
  } catch {
    fail(
      "CONFIG-G08-G15-LINEAGE",
      "G15 child is not the exact approved OIDC-only config variant",
    );
  }
  if (
    lineage.baseCandidateSha !== sourceContext.candidateSha ||
    lineage.candidateSha !== target.context.candidateSha ||
    lineage.baseConfigSha256 !== sourceContext.baseConfigSha256 ||
    lineage.configSha256 !== target.context.baseConfigSha256
  )
    fail("CONFIG-G08-G15-LINEAGE", "G15 config lineage does not match");

  let configBytes;
  try {
    configBytes = execFileSync(
      "git",
      [
        "--no-optional-locks",
        "-C",
        root,
        "cat-file",
        "blob",
        `${sourceContext.candidateSha}:config/platform.yaml`,
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30_000,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
  } catch {
    fail("CONFIG-G08-G15-LINEAGE", "G15 parent config blob is unavailable");
  }
  if (
    createHash("sha256").update(configBytes).digest("hex") !==
    sourceContext.baseConfigSha256
  )
    fail("CONFIG-G08-G15-LINEAGE", "G15 parent config hash differs");

  return {
    context: sourceContext,
    contextPath: preparationContextPath,
    contextDev: contextInfo.dev,
    contextIno: contextInfo.ino,
    contextSha256: createHash("sha256").update(contextBytes).digest("hex"),
    evidenceDir: sourceValidated.evidenceDir,
    configBytes,
    g15: true,
  };
}

async function assertG08PreparationSource(target, root, source) {
  if (!source.g15) return;
  const current = await readG08PreparationSource(
    target,
    root,
    source.contextPath,
  );
  if (
    current.contextDev !== source.contextDev ||
    current.contextIno !== source.contextIno ||
    current.contextSha256 !== source.contextSha256 ||
    current.context.runId !== source.context.runId ||
    current.context.candidateSha !== source.context.candidateSha ||
    !current.configBytes.equals(source.configBytes)
  )
    fail("CONFIG-G08-PREPARATION_CHANGED", "G15 preparation source changed");
}

async function readG08PreparationSnapshot(
  target,
  root,
  bundleSnapshot,
  source = {
    context: target.context,
    evidenceDir: target.evidenceDir,
    configBytes: null,
  },
) {
  const path = join(
    source.evidenceDir,
    "gates/G08_MIGRATIONS/artifacts/canonical-preparation.json",
  );
  await assertG08NoSymlinkPath(path);
  let info;
  let bytes;
  try {
    info = await lstat(path);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.uid !== process.getuid() ||
      (info.mode & 0o777) !== 0o400 ||
      info.size > 16 * 1024
    )
      fail("CONFIG-G08-PREPARATION", "G08 preparation receipt is untrusted");
    bytes = await readFile(path);
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    fail("CONFIG-G08-PREPARATION", "G08 preparation receipt is unavailable");
  }
  const after = await lstat(path).catch(() => null);
  if (
    !after?.isFile() ||
    after.isSymbolicLink() ||
    after.uid !== process.getuid() ||
    (after.mode & 0o777) !== 0o400 ||
    after.dev !== info.dev ||
    after.ino !== info.ino ||
    after.size !== bytes.length
  )
    fail(
      "CONFIG-G08-PREPARATION",
      "G08 preparation receipt changed while read",
    );

  let wrapper;
  try {
    wrapper = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("CONFIG-G08-PREPARATION", "G08 preparation receipt is invalid");
  }
  const roleNames = [...target.roles].sort((left, right) =>
    left.localeCompare(right),
  );
  let prep;
  try {
    prep = validateG08PreparationArtifact(
      wrapper,
      source.context,
      bundleSnapshot.sha256,
    );
  } catch {
    fail(
      "CONFIG-G08-PREPARATION",
      "G08 preparation receipt does not match this run",
    );
  }
  if (
    prep.postgres.host !== target.config.postgres.host ||
    prep.postgres.port !== target.config.postgres.port ||
    prep.postgres.user !== target.config.postgres.bootstrapUsername ||
    [...prep.roleNames]
      .sort((left, right) => left.localeCompare(right))
      .join(",") !== roleNames.join(",")
  )
    fail(
      "CONFIG-G08-PREPARATION",
      "G08 preparation receipt differs from target",
    );

  try {
    execFileSync(
      "git",
      [
        "merge-base",
        "--is-ancestor",
        prep.candidateSha,
        source.context.candidateSha,
      ],
      { cwd: root, stdio: "ignore" },
    );
  } catch {
    fail(
      "CONFIG-G08-PREPARATION",
      "G08 preparation is not in candidate ancestry",
    );
  }
  let preparationConfigBytes;
  try {
    preparationConfigBytes = execFileSync(
      "git",
      ["show", `${prep.candidateSha}:config/platform.yaml`],
      { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch {
    fail(
      "CONFIG-G08-PREPARATION",
      "G08 preparation config is unavailable from its candidate",
    );
  }
  const currentConfigBytes =
    source.configBytes ?? (await readFile(join(root, "config/platform.yaml")));
  if (
    createHash("sha256").update(currentConfigBytes).digest("hex") !==
    source.context.baseConfigSha256
  )
    fail(
      "CONFIG-G08-PREPARATION-CONFIG",
      "G08 current config changed during preparation validation",
    );
  validateG08PreparationConfigTransition(
    preparationConfigBytes,
    currentConfigBytes,
    prep.configSha256,
  );
  return {
    preparation: prep,
    snapshot: {
      path,
      dev: info.dev,
      ino: info.ino,
      mode: info.mode & 0o777,
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
  };
}

async function assertG08PreparationSnapshot(snapshot) {
  await assertG08NoSymlinkPath(snapshot.path);
  const info = await lstat(snapshot.path).catch(() => null);
  const bytes = await readFile(snapshot.path).catch(() => null);
  if (
    !info?.isFile() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid() ||
    (info.mode & 0o777) !== 0o400 ||
    info.dev !== snapshot.dev ||
    info.ino !== snapshot.ino ||
    bytes?.length !== snapshot.size ||
    createHash("sha256")
      .update(bytes ?? "")
      .digest("hex") !== snapshot.sha256
  )
    fail("CONFIG-G08-PREPARATION_CHANGED", "G08 preparation receipt changed");
}

function assertG08PreparedRoleInventory(state, roles) {
  const expected = [...roles].sort((left, right) => left.localeCompare(right));
  const existing = state.roleInventory.existing;
  if (
    !Array.isArray(existing) ||
    existing.length !== expected.length ||
    existing
      .map((role) => role.role)
      .sort((left, right) => left.localeCompare(right))
      .join(",") !== expected.join(",") ||
    existing.some(
      (role) =>
        role.login !== true ||
        role.superuser !== false ||
        role.createDb !== false ||
        role.createRole !== false ||
        role.inherit !== false ||
        role.replication !== false ||
        role.bypassRls !== false ||
        role.connectionLimit !== 20,
    )
  )
    failG08WithFacts(
      "CONFIG-G08-ROLE-INVENTORY",
      "G08 canonical prepared roles do not match the approved role contract",
      {
        stage: "credential-admission",
        roleCount: existing?.length ?? 0,
      },
    );
}

/** Return one G08 credential only after binding it to the current committed preparation. */
export async function readG08MigrationCredential({
  root = REPO_ROOT,
  contextPath = process.env.COFFEE_LAUNCH_CONTEXT_FILE,
  preparationContextPath,
  owner,
  kind,
  runtime,
  expectedSystemIdentifier,
  env = process.env,
} = {}) {
  if (
    !["admin", "migrator", "runtime"].includes(kind) ||
    typeof owner !== "string" ||
    !/^[a-z][a-z-]*$/u.test(owner) ||
    (kind === "runtime" &&
      (typeof runtime !== "string" || !/^[a-z][a-z0-9-]*$/u.test(runtime))) ||
    (kind !== "runtime" && runtime !== undefined) ||
    (expectedSystemIdentifier !== undefined &&
      (typeof expectedSystemIdentifier !== "string" ||
        !/^[0-9]{1,20}$/u.test(expectedSystemIdentifier)))
  )
    fail("CONFIG-G08-CREDENTIAL-REQUEST", "G08 credential request is invalid");
  const bundleSnapshot = await captureG08BundleSnapshot(root);
  const target = await validateG08Target({ root, contextPath, env });
  await assertG08BundleSnapshot(bundleSnapshot);
  if (
    target.config.environment !== "development" ||
    target.config.verification?.databaseIsolation?.enabled !== true
  )
    fail(
      "CONFIG-G08-TARGET",
      "G08 credentials require isolated development config",
    );

  const ownerDatabase = target.ownership.databases.find(
    (database) => database.owner === owner,
  );
  const mappedDatabase = ownerDatabase
    ? target.roleMap.databases.find(
        (database) => database.name === ownerDatabase.name,
      )
    : null;
  if (
    !ownerDatabase ||
    !mappedDatabase ||
    mappedDatabase.migratorRole !== ownerDatabase.migratorRole
  )
    fail(
      "CONFIG-G08-CREDENTIAL-OWNER",
      "G08 credential owner is not canonical",
    );

  const preparationSource = await readG08PreparationSource(
    target,
    root,
    preparationContextPath,
  );
  const { preparation, snapshot: preparationSnapshot } =
    await readG08PreparationSnapshot(
      target,
      root,
      bundleSnapshot,
      preparationSource,
    );
  const boundSystemIdentifier = preparation.postgres.systemIdentifier;
  if (
    expectedSystemIdentifier !== undefined &&
    boundSystemIdentifier !== expectedSystemIdentifier
  )
    fail("CONFIG-G08-IDENTITY", "G08 preparation server identity differs");

  const migrators = target.secrets?.bootstrap?.migrators;
  const canonicalOwners = target.ownership.databases.map(
    (database) => database.owner,
  );
  if (
    !migrators ||
    typeof migrators !== "object" ||
    Array.isArray(migrators) ||
    Object.keys(migrators)
      .sort((left, right) => left.localeCompare(right))
      .join(",") !==
      [...canonicalOwners]
        .sort((left, right) => left.localeCompare(right))
        .join(",") ||
    canonicalOwners.some(
      (canonicalOwner) =>
        typeof migrators[canonicalOwner] !== "string" ||
        migrators[canonicalOwner].length === 0 ||
        migrators[canonicalOwner].includes("\0"),
    )
  )
    fail(
      "CONFIG-G08-MIGRATOR-SECRET",
      "G08 prepared migrator credentials are invalid",
    );

  const state = await probeG08TargetState(target, boundSystemIdentifier);
  if (
    state.postgres.host !== target.config.postgres.host ||
    state.postgres.port !== target.config.postgres.port ||
    state.postgres.version !== preparation.postgres.version ||
    state.postgres.systemIdentifier !== preparation.postgres.systemIdentifier ||
    state.postgres.user !== target.config.postgres.bootstrapUsername ||
    state.postgres.database !== preparation.postgres.database
  )
    fail(
      "CONFIG-G08-IDENTITY",
      "G08 live target differs from preparation receipt",
    );
  assertG08PreparedRoleInventory(state, target.roles);
  await assertG08BundleSnapshot(bundleSnapshot);
  await assertG08PreparationSnapshot(preparationSnapshot);
  await assertG08PreparationSource(target, root, preparationSource);

  if (kind === "admin")
    return {
      username: target.config.postgres.bootstrapUsername,
      password: target.adminPassword,
    };
  if (kind === "runtime") {
    const runtimeRole = mappedDatabase.runtimeRoles.find(
      (entry) => entry.runtime === runtime,
    );
    const claim = target.ownership.runtimeClaims.find(
      (entry) => entry.runtime === runtime,
    );
    if (
      !runtimeRole ||
      !claim ||
      claim.database !== ownerDatabase.name ||
      claim.role !== runtimeRole.role ||
      typeof claim.secretRef !== "string" ||
      !claim.secretRef
    )
      fail(
        "CONFIG-G08-CREDENTIAL-RUNTIME",
        "G08 runtime credential claim is not canonical",
      );
    const credential = secretValueAt(target.secrets, claim.secretRef);
    if (
      credential?.username !== runtimeRole.role ||
      typeof credential.password !== "string" ||
      credential.password.length === 0 ||
      credential.password.includes("\0")
    )
      fail("CONFIG-G08-RUNTIME-SECRET", "G08 runtime credential is invalid");
    return { username: runtimeRole.role, password: credential.password };
  }
  return {
    username: mappedDatabase.migratorRole,
    password: migrators[owner],
  };
}

export async function materializeAromaSandboxSecrets({
  root = REPO_ROOT,
  runId,
  outputDir,
  env = process.env,
} = {}) {
  aromaSandboxDatabaseNames(runId);
  if (!outputDir || !outputDir.startsWith("/dev/shm/coffee-g16-secrets-"))
    fail(
      "CONFIG-G16-SECRET-PATH",
      "G16 secrets must be materialized in the private tmpfs directory",
    );
  await ensurePrivateSecretDirectory(outputDir);
  const config = await loadPlatformConfig(
    root,
    join(root, "config/platform.yaml"),
  );
  if (config.environment === "production")
    fail("CONFIG-G16-ENVIRONMENT", "G16 sandbox is forbidden in production");
  await g16PostgresVersion(root);
  const secretEnv = g16BootstrapEnv(env);
  const secrets = await readG16Secrets(root, secretEnv, config);
  const adminPassword = secretValueAt(
    secrets,
    "bootstrap.postgresAdminPassword",
  );
  if (typeof adminPassword !== "string" || adminPassword.length === 0)
    fail("CONFIG-G16-ADMIN-SECRET", "G16 PostgreSQL admin secret is missing");
  const adminPasswordFile = join(outputDir, "postgres-admin-password");
  await writePrivateSecret(adminPasswordFile, `${adminPassword}\n`);
  const runtimes = {};
  for (const runtime of AROMA_SANDBOX_RUNTIMES) {
    const materialized = await materializeRuntimeSecrets({
      root,
      runtime,
      outputDir: join(outputDir, runtime),
      env: secretEnv,
    });
    runtimes[runtime] = { scopedSecretRef: materialized.path };
  }
  return { adminPasswordFile, runtimes };
}

export async function provisionAromaSandboxDatabases({
  root = REPO_ROOT,
  runId,
  host,
  port,
  outputDir,
  env = process.env,
} = {}) {
  const databaseNames = aromaSandboxDatabaseNames(runId);
  if (
    host !== "127.0.0.1" ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  )
    fail(
      "CONFIG-G16-ENDPOINT",
      "G16 PostgreSQL endpoint must be loopback with a dynamic port",
    );
  if (!outputDir || !outputDir.startsWith("/dev/shm/coffee-g16-secrets-"))
    fail(
      "CONFIG-G16-SECRET-PATH",
      "G16 secrets must be materialized in the private tmpfs directory",
    );
  const secretEnv = g16BootstrapEnv(env);
  const config = await loadPlatformConfig(
    root,
    join(root, "config/platform.yaml"),
  );
  if (config.environment === "production")
    fail("CONFIG-G16-ENVIRONMENT", "G16 sandbox is forbidden in production");
  const postgresVersion = await g16PostgresVersion(root);
  const secrets = await readG16Secrets(root, secretEnv, config);
  const adminPassword = secretValueAt(
    secrets,
    "bootstrap.postgresAdminPassword",
  );
  if (typeof adminPassword !== "string" || adminPassword.length === 0)
    fail("CONFIG-G16-ADMIN-SECRET", "G16 PostgreSQL admin secret is missing");
  const ownership = JSON.parse(
    await readFile(join(root, "config/database-ownership.json"), "utf8"),
  );
  const roleMap = JSON.parse(
    await readFile(join(root, "config/database-role-map.json"), "utf8"),
  );
  if (
    ownership?.schemaVersion !== 1 ||
    roleMap?.schemaVersion !== 2 ||
    ownership.authorityRef !== roleMap.authorityRef
  )
    fail("CONFIG-G16-ROLE-MAP", "database ownership authority is invalid");
  try {
    validateRoleMap(roleMap, ownership);
  } catch {
    fail("CONFIG-G16-ROLE-MAP", "canonical database role map is invalid");
  }
  const selected = roleMap.databases.filter((database) =>
    AROMA_SANDBOX_OWNERS.has(
      ownership.databases.find(
        (entry) => entry.migratorRole === database.migratorRole,
      )?.owner,
    ),
  );
  if (selected.length !== AROMA_SANDBOX_OWNERS.size)
    fail("CONFIG-G16-ROLE-MAP", "G16 owner roles are incomplete");
  const migrators = {};
  const runtimeSecretRefs = {};

  for (const database of selected) {
    const owner = ownership.databases.find(
      (entry) => entry.migratorRole === database.migratorRole,
    )?.owner;
    if (
      !AROMA_SANDBOX_OWNERS.has(owner) ||
      database.name !== `coffee_platform_${owner}`
    )
      fail("CONFIG-G16-ROLE-MAP", "G16 database owner mapping is invalid");
    migrators[owner] = { username: database.migratorRole };
    for (const runtime of database.runtimeRoles) {
      const claim = ownership.runtimeClaims.find(
        (entry) => entry.runtime === runtime.runtime,
      );
      if (
        !claim ||
        claim.database !== database.name ||
        claim.role !== runtime.role ||
        !claim.secretRef
      )
        fail(
          "CONFIG-G16-ROLE-CLAIM",
          "G16 runtime role differs from ownership manifest",
        );
      const credential = secretValueAt(secrets, claim.secretRef);
      if (
        credential?.username !== runtime.role ||
        typeof credential.password !== "string" ||
        credential.password.length === 0 ||
        credential.password === adminPassword
      )
        fail(
          "CONFIG-G16-RUNTIME-SECRET",
          "G16 runtime role credential does not match the ownership manifest",
        );
      if (AROMA_SANDBOX_RUNTIMES.includes(runtime.runtime))
        runtimeSecretRefs[runtime.runtime] = {
          username: runtime.role,
          scopedSecretRef: join(
            outputDir,
            runtime.runtime,
            "coffee-platform.yaml",
          ),
        };
    }
  }

  const { Client } = await import("pg").catch(() =>
    fail("CONFIG-G16-PG-DEPENDENCY", "pg dependency is unavailable"),
  );
  const adminClient = new Client({
    host,
    port,
    database: "postgres",
    user: "postgres",
    password: adminPassword,
    ssl: false,
    connectionTimeoutMillis: 3_000,
  });
  const createdDatabases = [];
  try {
    await adminClient.connect();
    const probe = (
      await adminClient.query(
        `SELECT current_database(), current_user, current_setting('server_version') AS server_version, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS is_superuser, (SELECT system_identifier::text FROM pg_control_system()) AS system_identifier`,
      )
    ).rows[0];
    if (
      probe.current_database !== "postgres" ||
      probe.current_user !== "postgres" ||
      probe.is_superuser !== true ||
      probe.server_version.split(" ")[0] !== postgresVersion ||
      typeof probe.system_identifier !== "string" ||
      !probe.system_identifier
    )
      fail(
        "CONFIG-G16-SERVER-IDENTITY",
        "G16 PostgreSQL instance does not match the canonical toolchain pin",
      );
    const systemIdentifier = probe.system_identifier;
    for (const database of selected) {
      const owner = ownership.databases.find(
        (entry) => entry.migratorRole === database.migratorRole,
      ).owner;
      const name = databaseNames[owner];
      const databaseRoles = { ...database, name };
      const migratorRole = quoteG16Identifier(database.migratorRole);
      await adminClient.query(
        `CREATE ROLE ${migratorRole} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`,
      );
      for (const runtime of database.runtimeRoles) {
        const claim = ownership.runtimeClaims.find(
          (entry) => entry.runtime === runtime.runtime,
        );
        await adminClient.query(
          renderRoleSql(
            runtime.role,
            secretValueAt(secrets, claim.secretRef).password,
          ),
        );
      }
      await adminClient.query(
        `CREATE DATABASE ${quoteG16Identifier(name)} OWNER ${migratorRole} TEMPLATE template0`,
      );
      createdDatabases.push({ owner, name, databaseRoles });
    }
    for (const { name, databaseRoles } of createdDatabases) {
      const ownerClient = new Client({
        host,
        port,
        database: name,
        user: "postgres",
        password: adminPassword,
        ssl: false,
        connectionTimeoutMillis: 3_000,
      });
      try {
        await ownerClient.connect();
        await ownerClient.query(renderDatabaseSql(databaseRoles));
      } finally {
        await ownerClient.end().catch(() => {});
      }
    }
    return {
      systemIdentifier,
      databases: Object.fromEntries(
        createdDatabases.map(({ owner }) => [
          owner,
          {
            migrator: migrators[owner],
            runtimes: selected
              .find(
                (database) =>
                  ownership.databases.find(
                    (entry) => entry.migratorRole === database.migratorRole,
                  ).owner === owner,
              )
              .runtimeRoles.map((runtime) => ({
                runtime: runtime.runtime,
                role: runtime.role,
                scopedSecretRef:
                  runtimeSecretRefs[runtime.runtime]?.scopedSecretRef ?? null,
              })),
          },
        ]),
      ),
    };
  } catch (error) {
    for (const { name } of createdDatabases.reverse()) {
      try {
        await adminClient.query(
          `DROP DATABASE IF EXISTS ${quoteG16Identifier(name)}`,
        );
      } catch {
        /* preserve setup failure */
      }
    }
    throw error;
  } finally {
    await adminClient.end().catch(() => {});
  }
}

export async function openAromaSandboxMigrator({
  root = REPO_ROOT,
  runId,
  owner,
  host,
  port,
  expectedSystemIdentifier,
  env = process.env,
} = {}) {
  const databaseNames = aromaSandboxDatabaseNames(runId);
  if (
    !AROMA_SANDBOX_OWNERS.has(owner) ||
    host !== "127.0.0.1" ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    typeof expectedSystemIdentifier !== "string"
  )
    fail("CONFIG-G16-MIGRATOR-INPUT", "G16 migrator target is invalid");
  const ownership = JSON.parse(
    await readFile(join(root, "config/database-ownership.json"), "utf8"),
  );
  const roleMap = JSON.parse(
    await readFile(join(root, "config/database-role-map.json"), "utf8"),
  );
  try {
    validateRoleMap(roleMap, ownership);
  } catch {
    fail("CONFIG-G16-MIGRATOR-ROLE", "canonical database role map is invalid");
  }
  const roleDatabase = roleMap.databases.find(
    (database) =>
      ownership.databases.find(
        (entry) => entry.migratorRole === database.migratorRole,
      )?.owner === owner,
  );
  if (!roleDatabase)
    fail("CONFIG-G16-MIGRATOR-ROLE", "G16 canonical migrator role is missing");
  const config = await loadPlatformConfig(
    root,
    join(root, "config/platform.yaml"),
  );
  if (config.environment === "production")
    fail("CONFIG-G16-ENVIRONMENT", "G16 sandbox is forbidden in production");
  const postgresVersion = await g16PostgresVersion(root);
  const secrets = await readG16Secrets(root, g16BootstrapEnv(env), config);
  const adminPassword = secretValueAt(
    secrets,
    "bootstrap.postgresAdminPassword",
  );
  if (typeof adminPassword !== "string" || adminPassword.length === 0)
    fail("CONFIG-G16-ADMIN-SECRET", "G16 PostgreSQL admin secret is missing");
  const { Client } = await import("pg").catch(() =>
    fail("CONFIG-G16-PG-DEPENDENCY", "pg dependency is unavailable"),
  );
  const client = new Client({
    host,
    port,
    database: databaseNames[owner],
    user: "postgres",
    password: adminPassword,
    ssl: false,
    connectionTimeoutMillis: 3_000,
  });
  try {
    await client.connect();
    const probe = (
      await client.query(
        "SELECT current_database(), current_user, current_setting('server_version') AS server_version, (SELECT system_identifier::text FROM pg_control_system()) AS system_identifier",
      )
    ).rows[0];
    if (
      probe.current_database !== databaseNames[owner] ||
      probe.current_user !== "postgres" ||
      probe.server_version.split(" ")[0] !== postgresVersion ||
      probe.system_identifier !== expectedSystemIdentifier
    )
      fail("CONFIG-G16-MIGRATOR_TARGET_MISMATCH");
    await client.query(
      `SET ROLE ${quoteG16Identifier(roleDatabase.migratorRole)}`,
    );
    await client.query(
      `SET search_path = ${quoteG16Identifier(roleDatabase.schema)}, pg_catalog`,
    );
    const identity = (await client.query("SELECT current_user, session_user"))
      .rows[0];
    if (
      identity.current_user !== roleDatabase.migratorRole ||
      identity.session_user !== "postgres"
    )
      fail("CONFIG-G16-MIGRATOR_ROLE_MISMATCH");
    return client;
  } catch (error) {
    await client.end().catch(() => {});
    throw error;
  }
}

export async function finalizeAromaSandboxDatabase({
  root = REPO_ROOT,
  runId,
  owner,
  host,
  port,
  expectedSystemIdentifier,
  env = process.env,
} = {}) {
  const databaseNames = aromaSandboxDatabaseNames(runId);
  if (
    !AROMA_SANDBOX_OWNERS.has(owner) ||
    host !== "127.0.0.1" ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    typeof expectedSystemIdentifier !== "string" ||
    !expectedSystemIdentifier
  )
    fail(
      "CONFIG-G16-FINALIZE-INPUT",
      "G16 database finalization target is invalid",
    );
  const ownership = JSON.parse(
    await readFile(join(root, "config/database-ownership.json"), "utf8"),
  );
  const roleMap = JSON.parse(
    await readFile(join(root, "config/database-role-map.json"), "utf8"),
  );
  try {
    validateRoleMap(roleMap, ownership);
  } catch {
    fail("CONFIG-G16-FINALIZE-ROLE", "canonical database role map is invalid");
  }
  const roleDatabase = roleMap.databases.find(
    (database) =>
      ownership.databases.find(
        (entry) => entry.migratorRole === database.migratorRole,
      )?.owner === owner,
  );
  if (!roleDatabase)
    fail("CONFIG-G16-FINALIZE-ROLE", "G16 canonical database role is missing");
  const config = await loadPlatformConfig(
    root,
    join(root, "config/platform.yaml"),
  );
  if (config.environment === "production")
    fail("CONFIG-G16-ENVIRONMENT", "G16 sandbox is forbidden in production");
  const postgresVersion = await g16PostgresVersion(root);
  const secrets = await readG16Secrets(root, g16BootstrapEnv(env), config);
  const adminPassword = secretValueAt(
    secrets,
    "bootstrap.postgresAdminPassword",
  );
  if (typeof adminPassword !== "string" || adminPassword.length === 0)
    fail("CONFIG-G16-ADMIN-SECRET", "G16 PostgreSQL admin secret is missing");
  const { Client } = await import("pg").catch(() =>
    fail("CONFIG-G16-PG-DEPENDENCY", "pg dependency is unavailable"),
  );
  const database = databaseNames[owner];
  const client = new Client({
    host,
    port,
    database,
    user: "postgres",
    password: adminPassword,
    ssl: false,
    connectionTimeoutMillis: 3_000,
  });
  try {
    await client.connect();
    const probe = (
      await client.query(
        "SELECT current_database(), current_user, current_setting('server_version') AS server_version, (SELECT system_identifier::text FROM pg_control_system()) AS system_identifier",
      )
    ).rows[0];
    if (
      probe.current_database !== database ||
      probe.current_user !== "postgres" ||
      probe.server_version.split(" ")[0] !== postgresVersion ||
      probe.system_identifier !== expectedSystemIdentifier
    )
      fail("CONFIG-G16-FINALIZE-TARGET_MISMATCH");
    await client.query(renderDatabaseSql({ ...roleDatabase, name: database }));
    return {
      owner,
      database,
      migratorRole: roleDatabase.migratorRole,
      systemIdentifier: probe.system_identifier,
    };
  } finally {
    await client.end().catch(() => {});
  }
}

export function selectG17RuntimeCredentialClaim({
  owner,
  runtime,
  roleMap,
  ownership,
} = {}) {
  if (
    !Object.hasOwn(G17_RUNTIME_OWNERS, runtime) ||
    G17_RUNTIME_OWNERS[runtime] !== owner
  )
    fail(
      "CONFIG-G17-RUNTIME",
      "G17 runtime credential is not approved for this owner",
    );
  try {
    validateRoleMap(roleMap, ownership);
  } catch {
    fail("CONFIG-G17-ROLE-MAP", "canonical database role map is invalid");
  }
  const ownedDatabase = ownership.databases.find(
    (entry) => entry.owner === owner,
  );
  const database = roleMap.databases.find(
    (entry) => entry.name === ownedDatabase?.name,
  );
  const runtimeRole = database?.runtimeRoles.find(
    (entry) => entry.runtime === runtime,
  );
  const claim = ownership.runtimeClaims.find(
    (entry) => entry.runtime === runtime,
  );
  if (
    !ownedDatabase ||
    !database ||
    !runtimeRole ||
    !claim ||
    claim.database !== database.name ||
    claim.role !== runtimeRole.role ||
    typeof claim.secretRef !== "string" ||
    !claim.secretRef
  ) {
    fail(
      "CONFIG-G17-RUNTIME",
      "canonical G17 runtime credential claim is invalid",
    );
  }
  return { username: runtimeRole.role, secretRef: claim.secretRef };
}

/** Read one G17 bootstrap credential in-process after binding it to an exact launch target. */
export async function readG17BackupCredential({
  root = REPO_ROOT,
  runId,
  candidateSha,
  owner,
  runtime,
  sourceDatabase,
  restoreDatabase,
  host,
  port,
  expectedSystemIdentifier,
  contextPath = process.env.COFFEE_LAUNCH_CONTEXT_FILE,
  env = process.env,
} = {}) {
  const owners = new Set([
    "customer",
    "catalog",
    "pricing",
    "orders",
    "integration",
  ]);
  if (
    !/^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{7}$/.test(runId ?? "") ||
    !/^[0-9a-f]{40}$/.test(candidateSha ?? "") ||
    !runId.endsWith(`-${candidateSha.slice(0, 7)}`) ||
    !owners.has(owner)
  ) {
    fail("CONFIG-G17-IDENTITY", "G17 launch identity or owner is invalid");
  }
  const expectedSource = `coffee_verify_${runId.toLowerCase().replace("-", "_")}_${owner}`;
  const expectedRestore = `coffee_restore_${runId}_${owner}`;
  if (
    sourceDatabase !== expectedSource ||
    sourceDatabase.length > 63 ||
    restoreDatabase !== expectedRestore ||
    Buffer.byteLength(restoreDatabase, "utf8") > 63
  ) {
    fail(
      "CONFIG-G17-DATABASE",
      "G17 source or restore database does not match the launch identity",
    );
  }
  if (
    typeof host !== "string" ||
    !host ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    typeof expectedSystemIdentifier !== "string" ||
    !/^[0-9]+$/.test(expectedSystemIdentifier)
  ) {
    fail("CONFIG-G17-TARGET", "G17 PostgreSQL target identity is invalid");
  }
  const { config } = await validateG17BackupTarget({
    root,
    contextPath,
    runId,
    candidateSha,
    host,
    port,
    expectedSystemIdentifier,
  });
  const secretEnv = g16BootstrapEnv(env);
  await g16PostgresVersion(root);
  let runtimeClaim;
  if (runtime !== undefined) {
    const ownership = JSON.parse(
      await readFile(join(root, "config/database-ownership.json"), "utf8"),
    );
    const roleMap = JSON.parse(
      await readFile(join(root, "config/database-role-map.json"), "utf8"),
    );
    runtimeClaim = selectG17RuntimeCredentialClaim({
      owner,
      runtime,
      roleMap,
      ownership,
    });
  }
  const secrets = await readG16Secrets(root, secretEnv, config);
  const scopedCredential = runtimeClaim
    ? secretValueAt(secrets, runtimeClaim.secretRef)
    : null;
  const password = runtimeClaim
    ? scopedCredential?.password
    : secretValueAt(secrets, "bootstrap.postgresAdminPassword");
  if (typeof password !== "string" || !password)
    fail("CONFIG-G17-SECRET", "G17 bootstrap credential is unavailable");
  return { username: runtimeClaim?.username ?? "postgres", password };
}

export function isG17SocketHost(host) {
  return typeof host === "string" && G17_SOCKET_HOST.test(host);
}

export function validateG17ServerIdentity(
  value,
  context,
  config,
  expectedSystemIdentifier,
) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !==
      [...G17_SERVER_IDENTITY_KEYS].sort().join(",") ||
    value.schemaVersion !== 1 ||
    value.runId !== context?.runId ||
    value.candidateSha !== context?.candidateSha ||
    value.host !== config?.postgres?.host ||
    value.port !== config?.postgres?.port ||
    value.version !== "17.11" ||
    config.environment === "production" ||
    config.verification?.databaseIsolation?.enabled !== true ||
    (value.host !== "coffee_postgres" && !isG17SocketHost(value.host)) ||
    !/^[0-9]+$/u.test(value.systemIdentifier ?? "") ||
    (expectedSystemIdentifier !== undefined &&
      value.systemIdentifier !== expectedSystemIdentifier)
  )
    fail(
      "CONFIG-G17-SERVER-IDENTITY",
      "G00 server identity does not match the exact G17 target",
    );
  return {
    host: value.host,
    port: value.port,
    systemIdentifier: value.systemIdentifier,
  };
}

export function validateG17SocketDirectoryMetadata(
  metadata,
  expectedUid = process.getuid(),
) {
  return Boolean(
    typeof metadata?.isDirectory === "function" &&
    metadata.isDirectory() &&
    metadata.uid === expectedUid &&
    (metadata.mode & 0o777) === 0o700,
  );
}

export async function validateG17SocketDirectory(host) {
  if (!isG17SocketHost(host))
    fail("CONFIG-G17-SOCKET-PATH", "G17 Unix socket path is invalid");
  let current = "/";
  for (const part of host.slice(1).split("/")) {
    current = join(current, part);
    const info = await lstat(current).catch(() => null);
    if (!info || info.isSymbolicLink())
      fail(
        "CONFIG-G17-SOCKET-PATH",
        "G17 Unix socket path is missing or contains a symlink",
      );
    if (current !== host && !info.isDirectory())
      fail(
        "CONFIG-G17-SOCKET-PATH",
        "G17 Unix socket parent is not a directory",
      );
  }
  const info = await lstat(host);
  if (
    !validateG17SocketDirectoryMetadata(info, process.getuid()) ||
    (await realpath(host)) !== host
  )
    fail(
      "CONFIG-G17-SOCKET-OWNER",
      "G17 Unix socket directory must be a canonical mode-0700 directory owned by the current user",
    );
  return host;
}

async function assertNoSymlinkPath(path) {
  const absolute = resolve(path);
  let current = "/";
  for (const part of absolute.slice(1).split("/")) {
    current = join(current, part);
    const info = await lstat(current).catch(() => null);
    if (!info || info.isSymbolicLink())
      fail(
        "CONFIG-G17-PATH",
        "G17 evidence path is missing or contains a symlink",
      );
  }
  if ((await realpath(absolute)) !== absolute)
    fail("CONFIG-G17-PATH", "G17 evidence path is not canonical");
}

/** Bind G17 bootstrap to the validated run, exact YAML bytes, and G00 server identity. */
export async function validateG17BackupTarget({
  root = REPO_ROOT,
  contextPath = process.env.COFFEE_LAUNCH_CONTEXT_FILE,
  runId,
  candidateSha,
  host,
  port,
  expectedSystemIdentifier,
} = {}) {
  if (
    typeof contextPath !== "string" ||
    !contextPath.startsWith("/") ||
    resolve(contextPath) !== contextPath
  )
    fail("CONFIG-G17-CONTEXT", "G17 launch context locator is required");
  await assertNoSymlinkPath(contextPath);
  const contextInfo = await lstat(contextPath);
  if (
    !contextInfo.isFile() ||
    contextInfo.uid !== process.getuid() ||
    (contextInfo.mode & 0o777) !== 0o400
  )
    fail(
      "CONFIG-G17-CONTEXT",
      "G17 launch context must be a readonly owner-only regular file",
    );
  let validated;
  try {
    const { validateLaunchContext } =
      await import("../../verification/launch/v1/report.mjs");
    validated = await validateLaunchContext(contextPath);
  } catch {
    fail("CONFIG-G17-CONTEXT", "G17 launch context is invalid");
  }
  const { context, candidateRoot, evidenceDir } = validated;
  const contextAfter = await lstat(contextPath).catch(() => null);
  if (
    !contextAfter?.isFile() ||
    contextAfter.isSymbolicLink() ||
    contextAfter.uid !== process.getuid() ||
    (contextAfter.mode & 0o777) !== 0o400 ||
    contextAfter.dev !== contextInfo.dev ||
    contextAfter.ino !== contextInfo.ino
  )
    fail("CONFIG-G17-CONTEXT", "G17 launch context changed during validation");
  if (
    candidateRoot !== resolve(root) ||
    (runId !== undefined && context.runId !== runId) ||
    (candidateSha !== undefined && context.candidateSha !== candidateSha) ||
    !/^[0-9a-f]{64}$/u.test(context.baseConfigSha256 ?? "")
  )
    fail(
      "CONFIG-G17-CONTEXT",
      "G17 context does not match candidate/run identity",
    );
  const configPath = join(root, "config/platform.yaml");
  const configStat = await lstat(configPath).catch(() => null);
  if (
    !configStat?.isFile() ||
    configStat.isSymbolicLink() ||
    configStat.uid !== process.getuid() ||
    (configStat.mode & 0o022) !== 0 ||
    (await realpath(configPath)) !== configPath
  )
    fail(
      "CONFIG-G17-CONFIG",
      "G17 config file is not a canonical regular file",
    );
  const configBytes = await readFile(configPath);
  if (
    createHash("sha256").update(configBytes).digest("hex") !==
    context.baseConfigSha256
  )
    fail(
      "CONFIG-G17-CONFIG",
      "G17 config bytes differ from the readonly launch context",
    );
  const config = await loadPlatformConfig(root, configPath);
  const configStatAfter = await lstat(configPath).catch(() => null);
  const configBytesAfter = await readFile(configPath);
  if (
    !configStatAfter?.isFile() ||
    configStatAfter.isSymbolicLink() ||
    configStatAfter.dev !== configStat.dev ||
    configStatAfter.ino !== configStat.ino ||
    createHash("sha256").update(configBytesAfter).digest("hex") !==
      context.baseConfigSha256
  )
    fail("CONFIG-G17-CONFIG", "G17 config changed during validation");
  const targetHost = host ?? config.postgres.host;
  const targetPort = port ?? config.postgres.port;
  if (
    config.environment === "production" ||
    config.verification?.databaseIsolation?.enabled !== true ||
    config.postgres.host !== targetHost ||
    config.postgres.port !== targetPort ||
    (expectedSystemIdentifier !== undefined &&
      (typeof expectedSystemIdentifier !== "string" ||
        !/^[0-9]+$/u.test(expectedSystemIdentifier)))
  )
    fail(
      "CONFIG-G17-CONFIG",
      "G17 target differs from the isolated non-production config",
    );
  if (isG17SocketHost(targetHost)) await validateG17SocketDirectory(targetHost);
  else if (targetHost !== "coffee_postgres")
    fail(
      "CONFIG-G17-TARGET",
      "G17 endpoint is neither canonical nor the approved private socket",
    );

  const identityPath = join(
    evidenceDir,
    "gates/G00_PREFLIGHT/artifacts/postgres-server-identity.json",
  );
  await assertNoSymlinkPath(identityPath);
  const identityStat = await lstat(identityPath);
  if (
    !identityStat.isFile() ||
    identityStat.size > 16 * 1024 ||
    identityStat.uid !== process.getuid() ||
    (identityStat.mode & 0o022) !== 0
  )
    fail(
      "CONFIG-G17-SERVER-IDENTITY",
      "G00 server identity artifact is not a private regular file",
    );
  let identity;
  try {
    identity = JSON.parse(await readFile(identityPath, "utf8"));
  } catch {
    fail(
      "CONFIG-G17-SERVER-IDENTITY",
      "G00 server identity artifact is invalid",
    );
  }
  const identityStatAfter = await lstat(identityPath).catch(() => null);
  if (
    !identityStatAfter?.isFile() ||
    identityStatAfter.isSymbolicLink() ||
    identityStatAfter.dev !== identityStat.dev ||
    identityStatAfter.ino !== identityStat.ino
  )
    fail(
      "CONFIG-G17-SERVER-IDENTITY",
      "G00 server identity changed during validation",
    );
  const target = validateG17ServerIdentity(
    identity,
    context,
    {
      ...config,
      postgres: { ...config.postgres, host: targetHost, port: targetPort },
    },
    expectedSystemIdentifier,
  );
  return { context, config, target };
}

export async function checkBootstrap(root = REPO_ROOT) {
  assertLocatorEnv(process.env, true);
  await checkPlatformConfig(root);
  return {
    role: "config-bootstrap",
    lifecycle: "init-only",
    listener: false,
    longRunning: false,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const rootIndex = process.argv.indexOf("--root");
  const root = rootIndex >= 0 ? process.argv[rootIndex + 1] : REPO_ROOT;
  const runtimeIndex = process.argv.indexOf("--runtime");
  const runtime =
    runtimeIndex >= 0 ? process.argv[runtimeIndex + 1] : undefined;
  try {
    if (!runtime) {
      await checkBootstrap(root);
      console.log(
        "config-bootstrap: config and encrypted secret checks passed",
      );
    } else {
      const result = await materializeRuntimeSecrets({ runtime, root });
      console.log(
        `config-bootstrap: materialized ${result.runtime} (${result.path})`,
      );
    }
  } catch (error) {
    console.error(`config-bootstrap: FAIL: ${error.message}`);
    process.exitCode = 1;
  }
}
