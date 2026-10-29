#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  createPrivateKey,
  createPublicKey,
  randomUUID,
  X509Certificate,
} from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkPlatformConfig,
  ConfigError,
  infrastructureSecretEntries,
  loadEncryptedSecrets,
  loadPlatformConfig,
} from "../../scripts/config-lib.mjs";
import { load as parseYaml, dump as dumpYaml } from "js-yaml";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const NODE_IMAGE =
  "node:26.8.1-bookworm-slim@sha256:27f5e13512830beb5d9a574108daa6701a0a0b91528aeaf1ee84ecdcddaeeaae";
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

function fail(rule, message) {
  throw new ConfigError(rule, message);
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
      NODE_IMAGE,
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
      NODE_IMAGE,
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
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const files = {
      "public.crt": publicCert,
      "public.key": publicKey,
      "upstream-ca.crt": transport.caPem,
      "client.crt": transport.certPem,
      "client.key": transport.keyPem,
    };
    for (const [name, value] of Object.entries(files)) {
      const path = join(directory, name);
      await unlink(path).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
      await writeFile(path, value, { encoding: "utf8", mode: 0o400 });
      await chmod(path, 0o400);
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
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const materialized = dumpYaml(
    {
      schemaVersion: 1,
      environment: config.environment,
      runtime,
      secrets: scoped,
    },
    { noRefs: true, lineWidth: 120 },
  );
  await writeFile(destination, materialized, { encoding: "utf8", mode: 0o400 });
  await chmod(destination, 0o400);
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
