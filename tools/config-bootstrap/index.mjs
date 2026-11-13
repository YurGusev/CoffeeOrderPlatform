#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  pbkdf2Sync,
  randomBytes,
  randomUUID,
  X509Certificate,
} from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  statfs,
  rename,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { isIP } from "node:net";
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
  bootstrapDatabases,
  renderDatabaseObjectSql,
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
const BACKUP_SOCKET_HOST = /^\/dev\/shm\/coffee-g17-[a-f0-9]{16,64}$/;
const BACKUP_SERVER_IDENTITY_KEYS = [
  "candidateSha",
  "host",
  "port",
  "runId",
  "schemaVersion",
  "systemIdentifier",
  "version",
];
const BACKUP_RUNTIME_OWNERS = Object.freeze({
  "orders-aroma-preparation": "orders",
  "aroma-convergence": "orders",
  "aroma-gateway": "integration",
});
const MIGRATION_ADMIN_SOURCE = Object.freeze({
  name: "coffee_postgres",
  containerId:
    "267958ce276e65d96c4a5d2cfc4541de35f9785de3dd15c04c34798cf7b1c85f",
  imageId:
    "sha256:1bea307dfb3ee30541a7acf7de14b58bcd6948da98e5d31a04c627c4d35ec64b",
  network: "coffee_network",
});
const MIGRATION_ADMIN_SOURCE_INSPECT_FORMAT =
  "{{.Id}}{{println}}{{.Image}}{{println}}{{.State.Running}}{{println}}{{json .NetworkSettings.Networks}}";
const MIGRATION_ENCRYPTION_RULE_IDS = new Set([
  "CONFIG-SCHEMA",
  "CONFIG-PLAINTEXT-SECRET",
  "CONFIG-SOPS-MAC",
  "CONFIG-SOPS-RECIPIENT",
  "CONFIG-SOPS-PLAINTEXT",
  "CONFIG-MIGRATIONS-SOPS-OUTPUT",
]);

function safeMigrationEncryptionRuleId(error) {
  return error?.name === "ConfigError" &&
    MIGRATION_ENCRYPTION_RULE_IDS.has(error.ruleId)
    ? error.ruleId
    : undefined;
}

function fail(rule, message) {
  throw new ConfigError(rule, message);
}

function failMigrationWithFacts(rule, message, facts) {
  const error = new ConfigError(rule, message);
  error.facts = facts;
  throw error;
}

function migrationDatabaseFailureFacts(error, stage) {
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

function migrationQueryFailure(error, stage) {
  const failure = new Error("G08 PostgreSQL query failed");
  failure.migrationFacts = migrationDatabaseFailureFacts(error, stage);
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
  return materializeRuntimeProjection({
    runtime,
    outputDir,
    env,
    config,
    environment,
  });
}

async function materializeRuntimeProjection({
  runtime,
  outputDir,
  env,
  config,
  environment,
}) {
  const nativeNginx = runtime === "edge-nginx";
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
      publicCertificateFingerprint: new X509Certificate(publicCert)
        .fingerprint256,
      transportCaFingerprint: new X509Certificate(transport.caPem)
        .fingerprint256,
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

async function readInfrastructureSecrets({ root, env, scope }) {
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
  return { values: infrastructureValues(refs, environment), config };
}

function infrastructureValues(refs, environment) {
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
  const { values } = await readInfrastructureSecrets({
    root,
    env,
    scope: "otel-collector",
  });
  await writePrivateSecret(scopedPath, JSON.stringify(values) + "\n");
  return { path: scopedPath, runtime: "otel-collector" };
}

export async function materializeGrafanaAdminSecret({
  root = REPO_ROOT,
  outputDir = "/dev/shm/coffee-platform-grafana-bootstrap",
  env = process.env,
} = {}) {
  await ensurePrivateSecretDirectory(outputDir);
  const path = join(outputDir, "admin-secret");
  const { values } = await readInfrastructureSecrets({
    root,
    env,
    scope: "grafana-bootstrap",
  });
  await writePrivateSecret(path, `${values["admin-secret"]}\n`);
  return { path, runtime: "config-bootstrap" };
}

/** Derive the normal release config without changing the formal source config. */
export function projectLocalRuntimeConfig(config) {
  if (
    config.browserOidc !== null ||
    !config.localIdentity ||
    config.verification.databaseIsolation.enabled !== false ||
    config.verification.kafkaNamespaceIsolation !== false
  )
    fail(
      "CONFIG-LOCAL-RELEASE",
      "source is not the normal null-profile configuration",
    );
  const projected = structuredClone(config);
  const identity = projected.localIdentity;
  const publicRealm = `${identity.publicBaseUrl}/realms/${identity.realm}`;
  const privateRealm = `${identity.privateBaseUrl}/realms/${identity.realm}`;
  projected.browserOidc = {
    issuer: publicRealm,
    clientId: identity.clientId,
    authorizationUrl: `${publicRealm}/protocol/openid-connect/auth`,
    tokenUrl: `${privateRealm}/protocol/openid-connect/token`,
    jwksUrl: `${privateRealm}/protocol/openid-connect/certs`,
    redirectUri: `${projected.platform.publicBaseUrl}/auth/callback`,
    allowedAlgorithms: ["RS256"],
    actorRefClaim: "actor_ref",
    permissionsClaim: "permissions",
  };
  return projected;
}

export async function materializeKeycloakRealm({
  root = REPO_ROOT,
  outputDir = "/dev/shm/coffee-platform-secrets/keycloak-import",
  env = process.env,
} = {}) {
  const { values, config } = await readInfrastructureSecrets({
    root,
    env,
    scope: "keycloak-operator",
  });
  return materializeKeycloakRealmProjection({
    root,
    outputDir,
    values,
    config,
  });
}

async function materializeKeycloakRealmProjection({
  root,
  outputDir,
  values,
  config,
}) {
  const source = structuredClone(config);
  source.browserOidc = null;
  if (
    !isDeepStrictEqual(
      config.browserOidc,
      projectLocalRuntimeConfig(source).browserOidc,
    ) ||
    !/^[A-Za-z0-9_-]{32,128}$/u.test(values["operator-password"]) ||
    !resolve(outputDir).startsWith("/dev/shm/")
  )
    fail("CONFIG-IDENTITY-SECRET", "operator bootstrap inputs are invalid");
  const { clientV1BrowserOperations } = await import(
    pathToFileURL(join(root, "apps/edge-gateway/src/client-operations.gen.ts"))
      .href
  );
  const permissions = [
    ...new Set(
      clientV1BrowserOperations.flatMap((operation) =>
        "permission" in operation ? [operation.permission] : [],
      ),
    ),
  ];
  const { localIdentity: identity, browserOidc: oidc } = config;
  const mapper = (claim, multi) => ({
    name: claim,
    protocol: "openid-connect",
    protocolMapper: "oidc-usermodel-attribute-mapper",
    config: {
      "user.attribute": claim,
      "claim.name": claim,
      "jsonType.label": "String",
      "id.token.claim": "true",
      "access.token.claim": "false",
      "userinfo.token.claim": "false",
      multivalued: String(multi),
    },
  });
  const realm = {
    realm: identity.realm,
    enabled: true,
    registrationAllowed: false,
    resetPasswordAllowed: false,
    clients: [
      {
        clientId: identity.clientId,
        enabled: true,
        protocol: "openid-connect",
        publicClient: true,
        standardFlowEnabled: true,
        implicitFlowEnabled: false,
        directAccessGrantsEnabled: false,
        serviceAccountsEnabled: false,
        redirectUris: [oidc.redirectUri],
        webOrigins: [new URL(oidc.redirectUri).origin],
        attributes: { "pkce.code.challenge.method": "S256" },
        protocolMappers: [
          mapper(oidc.actorRefClaim, false),
          mapper(oidc.permissionsClaim, true),
        ],
      },
    ],
    users: [
      {
        username: identity.operatorUsername,
        enabled: true,
        clientRoles: { "realm-management": ["realm-admin"] },
        attributes: {
          [oidc.actorRefClaim]: [identity.actorRef],
          [oidc.permissionsClaim]: permissions,
        },
        credentials: [
          {
            type: "password",
            value: values["operator-password"],
            temporary: false,
          },
        ],
      },
    ],
  };
  await ensurePrivateSecretDirectory(outputDir);
  if ((await statfs(outputDir)).type !== 0x01021994)
    fail("CONFIG-IDENTITY-SECRET", "operator bootstrap requires private tmpfs");
  const path = join(outputDir, `${identity.realm}-realm.json`);
  await writePrivateSecret(path, `${JSON.stringify(realm)}\n`);
  return { runtime: "keycloak", path };
}

export async function materializeKeycloakSecrets({
  root = REPO_ROOT,
  outputDir = "/dev/shm/coffee-platform-secrets/keycloak",
  includeBootstrap = true,
  env = process.env,
} = {}) {
  const { values, config } = await readInfrastructureSecrets({
    root,
    env,
    scope: "keycloak-runtime",
  });
  return materializeKeycloakSecretsProjection({
    outputDir,
    includeBootstrap,
    values,
    config,
  });
}

async function materializeKeycloakSecretsProjection({
  outputDir,
  includeBootstrap,
  values,
  config,
}) {
  if (
    !config.browserOidc ||
    ["database-password", "bootstrap-admin-password"].some(
      (key) => !/^[A-Za-z0-9_-]{32,128}$/u.test(values[key]),
    )
  )
    fail(
      "CONFIG-IDENTITY-SECRET",
      "identity profile or credentials are invalid",
    );
  const source = structuredClone(config);
  source.browserOidc = null;
  if (
    !isDeepStrictEqual(
      config.browserOidc,
      projectLocalRuntimeConfig(source).browserOidc,
    )
  )
    fail(
      "CONFIG-IDENTITY-SECRET",
      "identity OIDC profile differs from the normal release",
    );
  try {
    const urls = [
      config.browserOidc.issuer,
      config.browserOidc.authorizationUrl,
      config.browserOidc.tokenUrl,
      config.browserOidc.jwksUrl,
    ].map((value) => new URL(value));
    const certificate = new X509Certificate(values["tls-cert"]);
    const authority = new X509Certificate(values["tls-ca"]);
    if (
      urls.some(
        (url) =>
          url.protocol !== "https:" || !certificate.checkHost(url.hostname),
      ) ||
      !authority.ca ||
      !certificate.verify(authority.publicKey) ||
      createPublicKey(createPrivateKey(values["tls-key"]))
        .export({ type: "spki", format: "der" })
        .compare(
          certificate.publicKey.export({ type: "spki", format: "der" }),
        ) !== 0 ||
      Date.now() < Date.parse(certificate.validFrom) ||
      Date.now() >= Date.parse(certificate.validTo)
    )
      throw new Error("invalid identity certificate");
  } catch {
    fail("CONFIG-IDENTITY-SECRET", "identity TLS material is invalid");
  }
  if (!resolve(outputDir).startsWith("/dev/shm/"))
    fail("CONFIG-IDENTITY-SECRET", "identity secrets require private tmpfs");
  await ensurePrivateSecretDirectory(outputDir);
  if ((await statfs(outputDir)).type !== 0x01021994)
    fail("CONFIG-IDENTITY-SECRET", "identity secrets require private tmpfs");
  const files = {
    "keycloak.conf": `db-password=${values["database-password"]}\n${includeBootstrap ? `bootstrap-admin-password=${values["bootstrap-admin-password"]}\n` : ""}`,
    "tls.key": values["tls-key"],
    "tls.crt": values["tls-cert"],
    "ca.crt": values["tls-ca"],
  };
  for (const [name, content] of Object.entries(files))
    await writePrivateSecret(join(outputDir, name), content);
  return {
    runtime: "keycloak",
    path: outputDir,
    files: Object.keys(files),
    publicCertificateFingerprint: new X509Certificate(values["tls-cert"])
      .fingerprint256,
    publicKeySha256: createHash("sha256")
      .update(
        new X509Certificate(values["tls-cert"]).publicKey.export({
          type: "spki",
          format: "der",
        }),
      )
      .digest("hex"),
    caFingerprint: new X509Certificate(values["tls-ca"]).fingerprint256,
  };
}

export async function retireKeycloakBootstrapSecret({ outputDir } = {}) {
  if (
    typeof outputDir !== "string" ||
    resolve(outputDir) !== outputDir ||
    !outputDir.startsWith("/dev/shm/")
  )
    fail("CONFIG-IDENTITY-SECRET", "owned identity scope is required");
  const directory = await lstat(outputDir);
  const path = join(outputDir, "keycloak.conf");
  const info = await lstat(path);
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    directory.uid !== process.getuid() ||
    (directory.mode & 0o777) !== 0o700 ||
    (await realpath(outputDir)) !== outputDir ||
    (await statfs(outputDir)).type !== 0x01021994 ||
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid() ||
    (info.mode & 0o777) !== 0o400 ||
    info.size > 1024
  )
    fail("CONFIG-IDENTITY-SECRET", "identity scope is invalid");
  const contents = await readFile(path, "utf8");
  const match =
    /^db-password=([A-Za-z0-9_-]{32,128})\nbootstrap-admin-password=[A-Za-z0-9_-]{32,128}\n$/u.exec(
      contents,
    );
  if (!match)
    fail(
      "CONFIG-IDENTITY-SECRET",
      "identity bootstrap configuration is invalid",
    );
  await writePrivateSecret(path, `db-password=${match[1]}\n`);
}

export async function materializeKafkaBrokerSecrets({
  root = REPO_ROOT,
  outputDir = "/dev/shm/coffee-platform-secrets/kafka",
  env = process.env,
} = {}) {
  const { values } = await readInfrastructureSecrets({
    root,
    env,
    scope: "kafka-broker",
  });
  return materializeKafkaBrokerSecretsProjection({ outputDir, values });
}

async function materializeKafkaBrokerSecretsProjection({ outputDir, values }) {
  const roles = ["broker", "catalog", "orders", "realtime"];
  if (
    roles.some(
      (role) =>
        values[`${role}-user`] !== (role === "broker" ? "kafka" : role) ||
        !/^[A-Za-z0-9_-]{32,128}$/u.test(values[`${role}-password`]),
    ) ||
    !/^[A-Za-z0-9_-]{32,128}$/u.test(values["store-password"])
  )
    fail("CONFIG-KAFKA-SECRET", "broker credentials are invalid");
  try {
    const certificate = new X509Certificate(values["tls-cert"]);
    const authority = new X509Certificate(values["tls-ca"]);
    if (
      !authority.ca ||
      !certificate.verify(authority.publicKey) ||
      !certificate.checkHost("kafka") ||
      !certificate.checkHost("localhost") ||
      ["catalog", "orders", "realtime"].some(
        (role) =>
          new X509Certificate(values[`${role}-ca`]).fingerprint256 !==
          authority.fingerprint256,
      ) ||
      createPublicKey(createPrivateKey(values["tls-key"]))
        .export({ type: "spki", format: "der" })
        .compare(
          certificate.publicKey.export({ type: "spki", format: "der" }),
        ) !== 0 ||
      Date.now() < Date.parse(certificate.validFrom) ||
      Date.now() >= Date.parse(certificate.validTo)
    )
      throw new Error("invalid broker certificate");
  } catch {
    fail("CONFIG-KAFKA-SECRET", "broker TLS material is invalid");
  }
  if (!resolve(outputDir).startsWith("/dev/shm/"))
    fail("CONFIG-KAFKA-SECRET", "broker secrets require private tmpfs");
  const parent = dirname(outputDir);
  await ensurePrivateSecretDirectory(parent);
  if ((await statfs(parent)).type !== 0x01021994)
    fail("CONFIG-KAFKA-SECRET", "broker secrets require private tmpfs");
  await mkdir(outputDir, { mode: 0o700 });
  try {
    const path = (name) => join(outputDir, name);
    const passwordPath = path("kafka.keystore.password");
    for (const [name, content] of Object.entries({
      "kafka.keystore.password": `${values["store-password"]}\n`,
      "server.key": values["tls-key"],
      "server.crt": values["tls-cert"],
      "ca.crt": values["tls-ca"],
      "kafka_jaas.conf": [
        "KafkaServer {",
        "  org.apache.kafka.common.security.plain.PlainLoginModule required",
        `  username="kafka" password="${values["broker-password"]}"`,
        ...roles.map(
          (role) =>
            `  user_${values[`${role}-user`]}="${values[`${role}-password`]}"`,
        ),
        ";",
        "};",
        "",
      ].join("\n"),
      "client.properties": [
        "security.protocol=SASL_SSL",
        "sasl.mechanism=PLAIN",
        `sasl.jaas.config=org.apache.kafka.common.security.plain.PlainLoginModule required username="kafka" password="${values["broker-password"]}";`,
        "ssl.truststore.type=PKCS12",
        "ssl.truststore.location=/etc/kafka/secrets/kafka.truststore.p12",
        `ssl.truststore.password=${values["store-password"]}`,
        "",
      ].join("\n"),
    }))
      await writePrivateSecret(path(name), content);
    execFileSync(
      "openssl",
      [
        "pkcs12",
        "-export",
        "-name",
        "kafka",
        "-inkey",
        path("server.key"),
        "-in",
        path("server.crt"),
        "-certfile",
        path("ca.crt"),
        "-passout",
        `file:${passwordPath}`,
        "-out",
        path("kafka.keystore.p12"),
      ],
      { stdio: "ignore", timeout: 30_000 },
    );
    execFileSync(
      "keytool",
      [
        "-importcert",
        "-noprompt",
        "-alias",
        "kafka-ca",
        "-file",
        path("ca.crt"),
        "-keystore",
        path("kafka.truststore.p12"),
        "-storetype",
        "PKCS12",
        "-storepass:file",
        passwordPath,
      ],
      { stdio: "ignore", timeout: 30_000 },
    );
    await chmod(path("kafka.keystore.p12"), 0o400);
    await chmod(path("kafka.truststore.p12"), 0o400);
    for (const name of ["server.key", "server.crt", "ca.crt"])
      await unlink(path(name));
    return { runtime: "kafka", path: outputDir };
  } catch (error) {
    await rm(outputDir, { recursive: true, force: true });
    throw error;
  }
}

function localPasswordVerifier(password) {
  // Normal provisioning uses strong ASCII/base64url secrets; Unicode secrets
  // remain supported by the existing general bootstrap and are not rotated here.
  if (
    typeof password !== "string" ||
    !/^[A-Za-z0-9_-]{32,128}$/u.test(password)
  )
    fail(
      "CONFIG-LOCAL-PASSWORD",
      "normal bootstrap requires base64url passwords",
    );
  const salt = randomBytes(16);
  const salted = pbkdf2Sync(password, salt, 4096, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest("base64");
  const serverKey = createHmac("sha256", salted)
    .update("Server Key")
    .digest("base64");
  return `SCRAM-SHA-256$4096:${salt.toString("base64")}$${storedKey}:${serverKey}`;
}

/** Bootstrap only the identity-owned database on the explicitly approved server. */
export async function bootstrapLocalIdentityDatabase({
  adminClient,
  connectIdentity,
  identity,
  roleMap,
  password,
  expectedServerIdentity,
  requireExisting = false,
  expectedDatabaseOid,
}) {
  const { databaseName, databaseRole } = identity;
  if (
    !/^coffee_platform_[a-z][a-z0-9_]{0,39}$/u.test(databaseName) ||
    !/^coffee_[a-z_]{1,48}_rw$/u.test(databaseRole) ||
    !/^[0-9]{10,30}$/u.test(expectedServerIdentity) ||
    roleMap.databases.some(
      (database) =>
        database.name === databaseName ||
        database.migratorRole === databaseRole ||
        database.runtimeRoles.some((role) => role.role === databaseRole),
    )
  )
    fail("CONFIG-IDENTITY-DATABASE", "identity database target is invalid");
  const verifier = localPasswordVerifier(password);
  await adminClient.query(
    "SELECT pg_advisory_lock(hashtextextended('coffee-platform:database-bootstrap:v1', 0))",
  );
  try {
    const probe = await adminClient.query(SERVER_IDENTITY_SQL);
    validateServerProbe(probe.rows[0], { expectedServerIdentity });
    const roleResult = await adminClient.query(
      `SELECT r.rolcanlogin, r.rolinherit, r.rolsuper, r.rolcreatedb,
              r.rolcreaterole, r.rolreplication, r.rolbypassrls,
              r.rolconnlimit, r.rolvaliduntil,
              shobj_description(r.oid, 'pg_authid') AS owner_marker,
              EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = r.oid OR m.roleid = r.oid) AS has_memberships,
              EXISTS (SELECT 1 FROM pg_database d WHERE d.datdba = r.oid AND d.datname <> $2) AS owns_other_database
         FROM pg_roles r WHERE r.rolname = $1`,
      [databaseRole, databaseName],
    );
    const databaseResult = await adminClient.query(
      "SELECT datname, oid::text AS database_oid, pg_get_userbyid(datdba) AS owner, shobj_description(oid, 'pg_database') AS owner_marker FROM pg_database WHERE datname = $1",
      [databaseName],
    );
    const role = roleResult.rows[0];
    const database = databaseResult.rows[0];
    if (
      requireExisting &&
      (!role ||
        !database ||
        !/^[0-9]+$/u.test(database.database_oid ?? "") ||
        (expectedDatabaseOid !== undefined &&
          database.database_oid !== expectedDatabaseOid))
    )
      fail(
        "CONFIG-IDENTITY-DATABASE",
        "existing identity database binding is not proven",
      );
    if (requireExisting) {
      const publicAccess = await adminClient.query(
        `SELECT d.datname FROM pg_database d WHERE d.datname = $1 AND EXISTS (
           SELECT 1 FROM aclexplode(COALESCE(d.datacl, acldefault('d', d.datdba))) a
           WHERE a.grantee = 0 AND a.privilege_type = 'CONNECT'
         )`,
        [databaseName],
      );
      if (publicAccess.rows.length !== 0)
        fail(
          "CONFIG-IDENTITY-DATABASE",
          "identity database permits public connections",
        );
    }
    if (
      (database &&
        (!role ||
          database.owner !== databaseRole ||
          database.owner_marker !== "coffee-platform:local-identity:v1")) ||
      (role &&
        (role.owner_marker !== "coffee-platform:local-identity:v1" ||
          !role.rolcanlogin ||
          role.rolinherit ||
          role.rolsuper ||
          role.rolcreatedb ||
          role.rolcreaterole ||
          role.rolreplication ||
          role.rolbypassrls ||
          role.rolconnlimit !== 20 ||
          role.rolvaliduntil !== null ||
          role.has_memberships ||
          role.owns_other_database))
    )
      fail(
        "CONFIG-IDENTITY-DATABASE",
        "existing identity ownership is not trusted",
      );
    if (role) {
      const foreignAccess = await adminClient.query(
        "SELECT datname FROM pg_database WHERE datname = ANY($1::text[]) AND has_database_privilege($2, oid, 'CONNECT')",
        [roleMap.databases.map((entry) => entry.name), databaseRole],
      );
      if (foreignAccess.rows.length !== 0)
        fail(
          "CONFIG-IDENTITY-DATABASE",
          "identity role can access a business database",
        );
    } else {
      const publicAccess = await adminClient.query(
        `SELECT d.datname FROM pg_database d
         WHERE d.datname = ANY($1::text[]) AND EXISTS (
           SELECT 1 FROM aclexplode(COALESCE(d.datacl, acldefault('d', d.datdba))) a
           WHERE a.grantee = 0 AND a.privilege_type = 'CONNECT'
         )`,
        [roleMap.databases.map((entry) => entry.name)],
      );
      if (publicAccess.rows.length !== 0)
        fail(
          "CONFIG-IDENTITY-DATABASE",
          "business database permits public connections",
        );
    }
    if (!role) {
      await adminClient.query(renderRoleSql(databaseRole, verifier));
      await adminClient.query(
        `COMMENT ON ROLE "${databaseRole}" IS 'coffee-platform:local-identity:v1'`,
      );
    }
    if (!database) {
      await adminClient.query(
        `CREATE DATABASE "${databaseName}" OWNER "${databaseRole}" TEMPLATE template0`,
      );
      await adminClient.query(
        `COMMENT ON DATABASE "${databaseName}" IS 'coffee-platform:local-identity:v1'`,
      );
    }
    if (!requireExisting)
      await adminClient.query(
        `REVOKE ALL ON DATABASE "${databaseName}" FROM PUBLIC`,
      );
    const client = await connectIdentity();
    try {
      await client.query("SELECT 1");
    } finally {
      await client.end();
    }
    return {
      database: databaseName,
      role: databaseRole,
      created: !database,
      ...(requireExisting ? { databaseOid: database.database_oid } : {}),
    };
  } finally {
    await adminClient.query(
      "SELECT pg_advisory_unlock(hashtextextended('coffee-platform:database-bootstrap:v1', 0))",
    );
  }
}

export async function provisionLocalIdentityDatabase({
  root = REPO_ROOT,
  expectedServerIdentity,
  requireExisting = false,
  expectedDatabaseOid,
  env = process.env,
} = {}) {
  const config = await loadPlatformConfig(
    root,
    join(root, "config/platform.yaml"),
  );
  if (!config.localIdentity)
    fail("CONFIG-IDENTITY-DATABASE", "local identity configuration is missing");
  const secrets = await readSandboxSecrets(root, env, config);
  const roleMap = JSON.parse(
    await readFile(join(root, "config/database-role-map.json"), "utf8"),
  );
  const ownership = JSON.parse(
    await readFile(join(root, "config/database-ownership.json"), "utf8"),
  );
  validateRoleMap(roleMap, ownership);
  const target = {
    config,
    adminPassword: secrets.bootstrap?.postgresAdminPassword,
  };
  if (
    typeof target.adminPassword !== "string" ||
    !target.adminPassword ||
    target.adminPassword === secrets.identity?.databasePassword
  )
    fail("CONFIG-IDENTITY-DATABASE", "bootstrap credential is missing");
  const adminClient = await openMigrationAdminClient(target);
  const { Client } = await import("pg");
  let stage = "identity-connect";
  try {
    await adminClient.connect();
    const serverAddress = adminClient.connection.stream.remoteAddress;
    if (!isIP(serverAddress ?? ""))
      fail(
        "CONFIG-IDENTITY-DATABASE",
        "PostgreSQL peer address is unavailable",
      );
    stage = "identity-bootstrap";
    return await bootstrapLocalIdentityDatabase({
      adminClient,
      identity: config.localIdentity,
      roleMap,
      password: secrets.identity?.databasePassword,
      expectedServerIdentity,
      requireExisting,
      expectedDatabaseOid,
      connectIdentity: async () => {
        const client = new Client({
          host: serverAddress,
          port: config.postgres.port,
          database: config.localIdentity.databaseName,
          user: config.localIdentity.databaseRole,
          password: secrets.identity.databasePassword,
          ssl: false,
          connectionTimeoutMillis: 3_000,
        });
        await client.connect();
        return client;
      },
    });
  } catch (error) {
    const facts = migrationDatabaseFailureFacts(error, stage);
    fail(
      "CONFIG-IDENTITY-DATABASE",
      `${facts.stage}: ${facts.failureCategory}`,
    );
  } finally {
    await adminClient.end().catch(() => {});
  }
}

/** Prepare the five canonical business owners with the existing migrations. */
export async function provisionLocalBusinessDatabases({
  root = REPO_ROOT,
  expectedServerIdentity,
  env = process.env,
} = {}) {
  const configPath = env.COFFEE_CONFIG_FILE
    ? resolve(env.COFFEE_CONFIG_FILE)
    : join(root, "config/platform.yaml");
  const config = await loadPlatformConfig(root, configPath);
  if (
    config.verification.databaseIsolation.enabled !== false ||
    config.verification.kafkaNamespaceIsolation !== false
  )
    fail(
      "CONFIG-LOCAL-DATABASE",
      "normal bootstrap requires canonical isolation settings",
    );
  const secrets = await readSandboxSecrets(root, env, config);
  const roleMap = JSON.parse(
    await readFile(join(root, "config/database-role-map.json"), "utf8"),
  );
  const ownership = JSON.parse(
    await readFile(join(root, "config/database-ownership.json"), "utf8"),
  );
  validateRoleMap(roleMap, ownership);
  const passwords = migratorRolePasswords({ ownership, roleMap, secrets });
  const adminPassword = secrets.bootstrap?.postgresAdminPassword;
  if (
    typeof adminPassword !== "string" ||
    !adminPassword ||
    [...passwords.values()].includes(adminPassword) ||
    secrets.identity?.databasePassword === adminPassword ||
    !/^[0-9]{10,30}$/u.test(expectedServerIdentity)
  )
    fail("CONFIG-LOCAL-DATABASE", "approved PostgreSQL target is missing");
  // Validate every new normal credential before the first DDL statement.
  const verifiers = Object.fromEntries(
    [...passwords].map(([role, password]) => [
      role,
      localPasswordVerifier(password),
    ]),
  );
  localPasswordVerifier(secrets.identity?.databasePassword);

  // These controller modules are loaded only for an explicitly compiled launch.
  const {
    databaseProofService,
    proofDatabaseOptions,
    externalOwnerMigrations,
  } = await import("../compose-smoke.mjs");
  const { createDatabase } =
    await import("../../packages/platform-database/dist/index.js");
  const { applyMigrations } =
    await import("../../packages/platform-migrations/dist/index.js");
  const { Client } = await import("pg");
  const adminClient = await openMigrationAdminClient({ config, adminPassword });
  let serverAddress;
  const connectAdmin = async (database) => {
    const client = new Client({
      host: serverAddress,
      port: config.postgres.port,
      database,
      user: config.postgres.bootstrapUsername,
      password: adminPassword,
      ssl: false,
      connectionTimeoutMillis: 3_000,
    });
    await client.connect();
    return client;
  };
  const adminUrl = new URL(
    `postgresql://${config.postgres.host}:${config.postgres.port}/postgres`,
  );
  adminUrl.username = config.postgres.bootstrapUsername;
  adminUrl.password = adminPassword;
  let stage = "business-connect";
  try {
    await adminClient.connect();
    serverAddress = adminClient.connection.stream.remoteAddress;
    if (!isIP(serverAddress ?? ""))
      fail("CONFIG-LOCAL-DATABASE", "PostgreSQL peer address is unavailable");
    stage = "business-bootstrap";
    await bootstrapDatabases({
      adminClient,
      adminUrl: adminUrl.toString(),
      connectClient: connectAdmin,
      roleMap,
      ownership,
      rolePasswords: verifiers,
      expectedServerIdentity,
    });
    for (const database of roleMap.databases) {
      const owner = ownership.databases.find(
        (entry) => entry.name === database.name,
      );
      const claim = ownership.runtimeClaims.find(
        (entry) => entry.database === database.name && entry.role,
      );
      const service = databaseProofService(config, ownership, claim.runtime);
      stage = `migrate-${owner.owner}`;
      const migrator = createDatabase(
        proofDatabaseOptions(
          `${owner.owner}-local-migrator`,
          service,
          config.postgres.port,
          {
            username: database.migratorRole,
            password: passwords.get(database.migratorRole),
          },
          serverAddress,
        ),
      );
      await migrator.resource.start(AbortSignal.timeout(10_000));
      try {
        await applyMigrations(
          migrator,
          await externalOwnerMigrations(root, owner),
          {
            schema: database.schema,
            ledgerTable: "platform_schema_migrations",
            lockKey: `coffee-platform:${owner.owner}:migrations:v1`,
          },
        );
      } finally {
        await migrator.resource.stop(AbortSignal.timeout(10_000));
      }
      stage = `grants-${owner.owner}`;
      const ownerAdmin = await connectAdmin(database.name);
      try {
        const probe = (await ownerAdmin.query(SERVER_IDENTITY_SQL)).rows[0];
        if (
          probe.system_identifier !== expectedServerIdentity ||
          probe.current_database !== database.name ||
          probe.is_superuser !== true ||
          String(probe.server_version).split(" ")[0] !== "17.11"
        )
          fail(
            "CONFIG-LOCAL-DATABASE",
            "business database server identity changed",
          );
        await ownerAdmin.query(renderDatabaseObjectSql(database));
      } finally {
        await ownerAdmin.end();
      }
    }
    return { owners: ownership.databases.map((entry) => entry.owner) };
  } catch (error) {
    const facts = migrationDatabaseFailureFacts(error, stage);
    fail("CONFIG-LOCAL-DATABASE", `${facts.stage}: ${facts.failureCategory}`);
  } finally {
    await adminClient.end().catch(() => {});
  }
}

export async function provisionDevelopmentGrafanaAdmin({
  root = REPO_ROOT,
  outputDir = "/dev/shm/coffee-platform-grafana-bootstrap",
  env = process.env,
} = {}) {
  assertLocatorEnv(env, true);
  const config = await loadPlatformConfig(
    root,
    env.COFFEE_CONFIG_FILE
      ? resolve(env.COFFEE_CONFIG_FILE)
      : join(root, "config/platform.yaml"),
  );
  if (config.environment !== "development")
    fail(
      "CONFIG-GRAFANA-PROVISION",
      "Grafana admin provisioning is restricted to development",
    );
  const secretPath = join(root, "secrets/platform.secrets.sops.yaml");
  await assertPreparationNoSymlinkPath(secretPath);
  const encrypted = await loadEncryptedSecrets(root);
  await ensurePrivateSecretDirectory(outputDir);
  if ((await statfs(outputDir)).type !== 0x01021994)
    fail("CONFIG-GRAFANA-PROVISION", "Grafana admin output must be on tmpfs");
  if (
    secretValueAt(
      encrypted.environments.development,
      "telemetry.grafanaAdmin",
    ) !== undefined
  ) {
    const scoped = await materializeGrafanaAdminSecret({
      root,
      outputDir,
      env,
    });
    return { created: false, path: scoped.path };
  }
  const info = await lstat(secretPath);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid())
    fail(
      "CONFIG-GRAFANA-PROVISION",
      "encrypted secret bundle is not an owned regular file",
    );
  const original = await readFile(secretPath);
  const plaintext = assertPlainSecretDocument(
    encrypted,
    decryptInMemory(secretPath, env),
  );
  const credential = randomBytes(32).toString("hex");
  const expected = structuredClone(plaintext);
  setSecretAt(
    expected.environments.development,
    "telemetry.grafanaAdmin",
    credential,
  );
  const temporary = join(outputDir, `.grafana-${randomUUID()}.yaml`);
  try {
    const handle = await open(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(original);
    } finally {
      await handle.close();
    }
    try {
      execFileSync(
        "sops",
        [
          "set",
          "--input-type",
          "yaml",
          "--output-type",
          "yaml",
          "--value-stdin",
          temporary,
          '["environments"]["development"]["telemetry"]["grafanaAdmin"]',
        ],
        {
          cwd: root,
          env,
          input: JSON.stringify(credential),
          timeout: 30_000,
          maxBuffer: 16 * 1024 * 1024,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
    } catch {
      fail("CONFIG-GRAFANA-PROVISION", "trusted SOPS update failed");
    }
    const updatedBytes = await readFile(temporary);
    const updated = parseYaml(updatedBytes.toString("utf8"), { json: true });
    await validateEncryptedSecretsDocument(root, updated, temporary);
    const previousLeaves = structuredClone(updated.environments);
    delete previousLeaves.development.telemetry.grafanaAdmin;
    if (
      !isDeepStrictEqual(previousLeaves, encrypted.environments) ||
      updatedBytes.includes(credential)
    )
      fail(
        "CONFIG-GRAFANA-PROVISION",
        "SOPS update changed other ciphertext or exposed plaintext",
      );
    const roundtrip = assertPlainSecretDocument(
      updated,
      decryptInMemory(temporary, env),
    );
    if (!isDeepStrictEqual(roundtrip, expected))
      fail(
        "CONFIG-GRAFANA-PROVISION",
        "SOPS update changed existing secret values",
      );
    const currentInfo = await lstat(secretPath);
    if (
      currentInfo.dev !== info.dev ||
      currentInfo.ino !== info.ino ||
      !(await readFile(secretPath)).equals(original)
    )
      fail(
        "CONFIG-GRAFANA-PROVISION",
        "encrypted secret bundle changed during provisioning",
      );
    await writePrivateSecret(secretPath, updatedBytes);
    await chmod(secretPath, 0o600);
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  const scoped = await materializeGrafanaAdminSecret({ root, outputDir, env });
  return { created: true, path: scoped.path };
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
    fail("CONFIG-AROMA-RUN-ID", "G16 run id is invalid");
  const normalized = runId.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  return Object.fromEntries(
    [...AROMA_SANDBOX_OWNERS].map((owner) => {
      const name = `coffee_verify_${normalized}_${owner}`;
      if (!AROMA_SANDBOX_IDENTIFIER.test(name))
        fail("CONFIG-AROMA-DATABASE", "G16 database name is invalid");
      return [owner, name];
    }),
  );
}

async function sandboxPostgresVersion(root) {
  const toolchain = JSON.parse(
    await readFile(join(root, "config/toolchain-versions.json"), "utf8"),
  );
  if (
    toolchain?.schemaVersion !== 1 ||
    typeof toolchain.postgresql !== "string" ||
    !/^\d+\.\d+(?:\.\d+)?$/.test(toolchain.postgresql)
  )
    fail("CONFIG-AROMA-POSTGRES-PIN", "canonical PostgreSQL pin is invalid");
  return toolchain.postgresql;
}

function quoteSandboxIdentifier(value) {
  if (typeof value !== "string" || !AROMA_SANDBOX_IDENTIFIER.test(value))
    fail("CONFIG-AROMA-IDENTIFIER", "G16 database identifier is invalid");
  return `"${value}"`;
}

async function readSandboxSecrets(root, env, config) {
  assertLocatorEnv(env, true);
  const secretPath = join(root, "secrets/platform.secrets.sops.yaml");
  const encrypted = await loadEncryptedSecrets(root);
  const decrypted = assertPlainSecretDocument(
    encrypted,
    decryptInMemory(secretPath, env),
  );
  return decrypted.environments[config.environment];
}

async function readMigrationSecretBundle(root, env) {
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
    fail("CONFIG-MIGRATIONS-SECRET-BUNDLE", "trusted G08 secret bundle is invalid");
  }
  return { encrypted, decrypted };
}

function sandboxBootstrapEnv(env) {
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

async function assertPreparationNoSymlinkPath(path) {
  const absolute = resolve(path);
  let current = "/";
  for (const part of absolute.slice(1).split("/")) {
    current = join(current, part);
    const info = await lstat(current).catch(() => null);
    if (!info || info.isSymbolicLink())
      fail("CONFIG-MIGRATIONS-CONTEXT", "G08 context path is missing or symlinked");
  }
  if ((await realpath(absolute)) !== absolute)
    fail("CONFIG-MIGRATIONS-CONTEXT", "G08 context path is not canonical");
}

async function validateMigrationTarget({ root, contextPath, env }) {
  const contextEnv = sandboxBootstrapEnv(env);
  assertLocatorEnv(contextEnv, true);
  if (
    typeof contextPath !== "string" ||
    !contextPath.startsWith("/") ||
    resolve(contextPath) !== contextPath
  )
    fail("CONFIG-MIGRATIONS-CONTEXT", "G08 launch context locator is required");
  await assertPreparationNoSymlinkPath(contextPath);
  const contextInfo = await lstat(contextPath);
  if (
    !contextInfo.isFile() ||
    contextInfo.uid !== process.getuid() ||
    (contextInfo.mode & 0o777) !== 0o400
  )
    fail(
      "CONFIG-MIGRATIONS-CONTEXT",
      "G08 launch context must be an owner-only readonly regular file",
    );
  let validated;
  try {
    const { validateLaunchContext } =
      await import("../../verification/launch/v1/report.mjs");
    validated = await validateLaunchContext(contextPath);
  } catch {
    fail("CONFIG-MIGRATIONS-CONTEXT", "G08 launch context is invalid");
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
    fail("CONFIG-MIGRATIONS-CONTEXT", "G08 launch context changed during validation");
  if (
    candidateRoot !== resolve(root) ||
    !/^[0-9a-f]{64}$/u.test(context.baseConfigSha256 ?? "")
  )
    fail("CONFIG-MIGRATIONS-CONTEXT", "G08 context does not match candidate/config");

  const configPath = join(root, "config/platform.yaml");
  const configStat = await lstat(configPath).catch(() => null);
  if (
    !configStat?.isFile() ||
    configStat.isSymbolicLink() ||
    configStat.uid !== process.getuid() ||
    (configStat.mode & 0o022) !== 0 ||
    (await realpath(configPath)) !== configPath
  )
    fail("CONFIG-MIGRATIONS-CONFIG", "G08 config is not a canonical regular file");
  const configBytes = await readFile(configPath);
  const configSha256 = createHash("sha256").update(configBytes).digest("hex");
  if (configSha256 !== context.baseConfigSha256)
    fail("CONFIG-MIGRATIONS-CONFIG", "G08 config differs from launch context");
  const config = await loadPlatformConfig(root, configPath);
  if (
    config.environment === "production" ||
    config.postgres.host !== "coffee_postgres" ||
    config.postgres.port !== 5432 ||
    (await sandboxPostgresVersion(root)) !== "17.11"
  )
    fail(
      "CONFIG-MIGRATIONS-TARGET",
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
    fail("CONFIG-MIGRATIONS-CONFIG", "G08 config changed during validation");

  const ownership = JSON.parse(
    await readFile(join(root, "config/database-ownership.json"), "utf8"),
  );
  const roleMap = JSON.parse(
    await readFile(join(root, "config/database-role-map.json"), "utf8"),
  );
  try {
    validateRoleMap(roleMap, ownership);
  } catch {
    fail("CONFIG-MIGRATIONS-ROLE-MAP", "canonical database role map is invalid");
  }
  const roles = [
    ...roleMap.databases.map((database) => database.migratorRole),
    ...roleMap.databases.flatMap((database) =>
      database.runtimeRoles.map((runtime) => runtime.role),
    ),
  ];
  if (roles.length !== 15 || new Set(roles).size !== 15)
    fail("CONFIG-MIGRATIONS-ROLE-MAP", "canonical role set is incomplete");

  try {
    const { inspectLaunchCheckout } =
      await import("../../verification/launch/v1/scenarios/rollback.mjs");
    await inspectLaunchCheckout(candidateRoot, context.candidateSha);
  } catch {
    fail(
      "CONFIG-MIGRATIONS-CHECKOUT",
      "G08 candidate checkout is not clean and bound to its committed HEAD",
    );
  }

  let secretBundle;
  try {
    secretBundle = await readMigrationSecretBundle(root, contextEnv);
  } catch {
    fail("CONFIG-MIGRATIONS-ADMIN-SECRET", "trusted G08 admin secret is unavailable");
  }
  const secrets = secretBundle.decrypted.environments[config.environment];
  const adminPassword = secretValueAt(
    secrets,
    "bootstrap.postgresAdminPassword",
  );
  if (typeof adminPassword !== "string" || adminPassword.length === 0)
    fail("CONFIG-MIGRATIONS-ADMIN-SECRET", "trusted G08 admin secret is unavailable");
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

async function captureMigrationBundleSnapshot(root) {
  const path = join(root, "secrets/platform.secrets.sops.yaml");
  await assertPreparationNoSymlinkPath(path);
  const info = await lstat(path).catch(() => null);
  if (
    !info?.isFile() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid() ||
    (info.mode & 0o022) !== 0 ||
    info.size > 2 * 1024 * 1024
  )
    fail(
      "CONFIG-MIGRATIONS-BUNDLE",
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
    fail("CONFIG-MIGRATIONS-BUNDLE", "G08 encrypted bundle changed during snapshot");
  return {
    path,
    dev: info.dev,
    ino: info.ino,
    mode: info.mode & 0o777,
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

async function assertMigrationBundleSnapshot(snapshot) {
  let info;
  let bytes;
  try {
    info = await lstat(snapshot.path);
    bytes = await readFile(snapshot.path);
  } catch {
    fail("CONFIG-MIGRATIONS-BUNDLE_CHANGED", "G08 encrypted bundle changed");
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
    fail("CONFIG-MIGRATIONS-BUNDLE_CHANGED", "G08 encrypted bundle changed");
}

function encryptMigrationSecretBundle(root, env, snapshot, secretDocument) {
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
    fail("CONFIG-MIGRATIONS-SOPS-ENCRYPT", "trusted G08 SOPS encryption failed");
  }
  return Buffer.from(encryptedText, "utf8");
}

function assertEncryptedBundleHasNoPlaintext(ciphertext, value, path = []) {
  if (typeof value === "string") {
    if (
      path.at(-1) !== "username" &&
      path.at(-1) !== "schemaVersion" &&
      value.length > 0 &&
      ciphertext.includes(value)
    )
      fail("CONFIG-MIGRATIONS-SOPS-OUTPUT", "G08 ciphertext contains plaintext");
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertEncryptedBundleHasNoPlaintext(ciphertext, entry, [
        ...path,
        String(index),
      ]),
    );
    return;
  }
  if (value && typeof value === "object")
    for (const [key, entry] of Object.entries(value))
      assertEncryptedBundleHasNoPlaintext(ciphertext, entry, [...path, key]);
}

async function validateMigrationEncryptedDocument(
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
    assertEncryptedBundleHasNoPlaintext(
      contents.toString("utf8"),
      expectedPlaintext,
    );
  } catch (error) {
    const ruleId = safeMigrationEncryptionRuleId(error);
    failMigrationWithFacts(
      "CONFIG-MIGRATIONS-SOPS-OUTPUT",
      "trusted G08 encrypted bundle failed validation",
      {
        validationStage,
        ...(ruleId ? { ruleId } : {}),
      },
    );
  }
  return encrypted;
}

async function validateMigrationEncryptedTemporary(
  root,
  env,
  temporary,
  expectedPlaintext,
) {
  const encrypted = await validateMigrationEncryptedDocument(
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
    const ruleId = safeMigrationEncryptionRuleId(error);
    failMigrationWithFacts(
      "CONFIG-MIGRATIONS-SOPS-OUTPUT",
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
      fail("CONFIG-MIGRATIONS-SOPS-ROUNDTRIP", "G08 SOPS output was not decrypted");
  }
}

async function writeMigrationEncryptedBundle(
  snapshot,
  contents,
  { root, env, expectedPlaintext },
) {
  await validateMigrationEncryptedDocument(
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
    await validateMigrationEncryptedTemporary(
      root,
      env,
      temporary,
      expectedPlaintext,
    );
    await assertMigrationBundleSnapshot(snapshot);
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
        "CONFIG-MIGRATIONS-BUNDLE_WRITE",
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
    fail("CONFIG-MIGRATIONS-BUNDLE_WRITE", "G08 encrypted bundle write failed");
  } finally {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch((error) => {
      if (error.code !== "ENOENT")
        fail("CONFIG-MIGRATIONS-BUNDLE_TEMP", "G08 temporary bundle cleanup failed");
    });
  }
}

function dockerHubPullAuth(value) {
  if (
    typeof value !== "string" ||
    value.length > 16_384 ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)
  )
    fail(
      "CONFIG-REGISTRY-AUTH",
      "Docker Hub pull credential is missing or invalid",
    );
  const decoded = Buffer.from(value, "base64");
  const separator = decoded.indexOf(58);
  if (
    decoded.toString("base64") !== value ||
    separator <= 0 ||
    separator === decoded.length - 1 ||
    decoded.includes(0)
  )
    fail("CONFIG-REGISTRY-AUTH", "Docker Hub pull credential is invalid");
  return value;
}

export async function materializeBuildRegistryCredentials({
  root = REPO_ROOT,
  outputDir,
  env = process.env,
} = {}) {
  assertLocatorEnv(env, true);
  if (typeof outputDir !== "string" || !outputDir.startsWith("/dev/shm/"))
    fail("CONFIG-REGISTRY-AUTH", "registry credentials require private tmpfs");
  await ensurePrivateSecretDirectory(outputDir);
  if ((await statfs(outputDir)).type !== 0x01021994)
    fail("CONFIG-REGISTRY-AUTH", "registry credentials require private tmpfs");
  const config = await loadPlatformConfig(root);
  const { decrypted } = await readMigrationSecretBundle(root, env);
  const auth = dockerHubPullAuth(
    secretValueAt(
      decrypted.environments[config.environment],
      "bootstrap.dockerHubPullAuth",
    ),
  );
  const path = join(outputDir, "config.json");
  await writePrivateSecret(
    path,
    JSON.stringify({ auths: { "https://index.docker.io/v1/": { auth } } }) +
      "\n",
  );
  return { path, secretRefs: ["bootstrap.dockerHubPullAuth"] };
}

// Новый публичный CA создаётся только по явной команде; запись — только ciphertext.
export async function prepareDevelopmentRuntimeSecrets({
  root = REPO_ROOT,
  env = process.env,
  provisionPublicAuthority = false,
  dockerHubAuthFile,
} = {}) {
  assertLocatorEnv(env, true);
  const config = await loadPlatformConfig(
    root,
    env.COFFEE_CONFIG_FILE
      ? resolve(env.COFFEE_CONFIG_FILE)
      : join(root, "config/platform.yaml"),
  );
  if (config.environment !== "development")
    fail(
      "CONFIG-DEVELOPMENT-SECRET",
      "runtime secret preparation is restricted to development",
    );
  const snapshot = await captureMigrationBundleSnapshot(root);
  const { decrypted } = await readMigrationSecretBundle(root, env);
  await assertMigrationBundleSnapshot(snapshot);
  const secrets = decrypted.environments[config.environment];
  const { authority, authorityPem, authorityKeyPem, updatedRuntimes } =
    await renewDevelopmentTransportMaterial({ secrets, config, env });
  const changed = updatedRuntimes.map(
    (runtime) => `security.serviceTransportKeys.${runtime}`,
  );

  if (dockerHubAuthFile !== undefined) {
    let auth;
    try {
      const metadata = await lstat(dockerHubAuthFile);
      if (
        !metadata.isFile() ||
        metadata.uid !== process.getuid() ||
        (metadata.mode & 0o077) !== 0 ||
        (await realpath(dockerHubAuthFile)) !== resolve(dockerHubAuthFile)
      )
        throw new Error();
      const supplied = JSON.parse(await readFile(dockerHubAuthFile, "utf8"));
      auth = dockerHubPullAuth(
        supplied.auths?.["https://index.docker.io/v1/"]?.auth,
      );
    } catch {
      fail(
        "CONFIG-REGISTRY-AUTH",
        "owned private Docker Hub credential file is required",
      );
    }
    const ref = "bootstrap.dockerHubPullAuth";
    const existing = secretValueAt(secrets, ref);
    if (existing !== undefined && existing !== auth)
      fail(
        "CONFIG-REGISTRY-AUTH",
        "existing Docker Hub credential differs; rotation requires a separate operation",
      );
    if (existing === undefined) {
      setSecretAt(secrets, ref, auth);
      changed.push(ref);
    }
  }

  const passwordRefs = [
    "identity.databasePassword",
    "identity.bootstrapAdminPassword",
    "identity.operatorPassword",
    "kafka.broker.password",
    "kafka.broker.storePassword",
  ];
  for (const ref of passwordRefs) {
    const value = secretValueAt(secrets, ref);
    if (value === undefined) {
      setSecretAt(secrets, ref, randomBytes(36).toString("base64url"));
      changed.push(ref);
    } else if (
      typeof value !== "string" ||
      !/^[A-Za-z0-9_-]{32,128}$/u.test(value)
    ) {
      fail(
        "CONFIG-DEVELOPMENT-SECRET",
        `${ref}: existing credential is invalid`,
      );
    }
  }
  const brokerUsername = secretValueAt(secrets, "kafka.broker.username");
  if (brokerUsername === undefined) {
    setSecretAt(secrets, "kafka.broker.username", "kafka");
    changed.push("kafka.broker.username");
  } else if (brokerUsername !== "kafka") {
    fail("CONFIG-DEVELOPMENT-SECRET", "kafka.broker.username is invalid");
  }
  for (const role of ["catalog", "orders", "realtime"]) {
    if (
      secretValueAt(secrets, `kafka.${role}.username`) !== role ||
      !/^[A-Za-z0-9_-]{32,128}$/u.test(
        secretValueAt(secrets, `kafka.${role}.password`) ?? "",
      )
    )
      fail(
        "CONFIG-DEVELOPMENT-SECRET",
        `kafka.${role}: existing credentials are invalid`,
      );
    const ref = `kafka.${role}.caPem`;
    const value = secretValueAt(secrets, ref);
    if (value === undefined) {
      setSecretAt(secrets, ref, authorityPem);
      changed.push(ref);
    } else {
      try {
        if (
          new X509Certificate(value).fingerprint256 !== authority.fingerprint256
        )
          throw new Error();
      } catch {
        fail("CONFIG-DEVELOPMENT-CA", `${ref}: existing CA differs`);
      }
    }
  }

  changed.push(
    ...(await prepareDevelopmentInfrastructureMaterial({
      secrets,
      config,
      env,
      authority,
      authorityPem,
      authorityKeyPem,
      allowProvision: true,
      provisionPublicAuthority,
    })),
  );
  if (!changed.length) {
    await assertMigrationBundleSnapshot(snapshot);
    return { changed: false, authorityFingerprint: authority.fingerprint256 };
  }
  const ciphertext = encryptMigrationSecretBundle(
    root,
    env,
    snapshot,
    decrypted,
  );
  const result = await writeMigrationEncryptedBundle(snapshot, ciphertext, {
    root,
    env,
    expectedPlaintext: decrypted,
  });
  return {
    changed: true,
    updatedRefs: changed,
    authorityFingerprint: authority.fingerprint256,
    encryptedSha256: result.sha256,
  };
}

async function prepareDevelopmentInfrastructureMaterial({
  secrets,
  config,
  env,
  authority,
  authorityPem,
  authorityKeyPem,
  allowProvision,
  provisionPublicAuthority = false,
}) {
  const now = Date.now();
  const threshold = config.security.certificateRenewBeforeHours * 3_600_000;
  const exactDns = { subject: "never", wildcards: false };
  const changed = [];
  const publicKey = secretValueAt(secrets, "edge.tlsPrivateKey");
  const publicCertificate = secretValueAt(secrets, "edge.tlsCertificate");
  let publicLeaf;
  try {
    publicLeaf = new X509Certificate(publicCertificate);
    if (
      publicLeaf.ca ||
      !publicLeaf.checkPrivateKey(createPrivateKey(publicKey)) ||
      !publicLeaf.checkHost(config.nginxTransport.publicHost, exactDns) ||
      now < Date.parse(publicLeaf.validFrom)
    )
      throw new Error();
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    fail(
      "CONFIG-DEVELOPMENT-LEAF",
      "public edge certificate identity or key is invalid",
    );
  }

  if (!allowProvision && Date.now() >= Date.parse(publicLeaf.validTo))
    fail("CONFIG-DEVELOPMENT-LEAF", "public edge certificate is expired");

  const hosts = [
    config.localIdentity.publicBaseUrl,
    config.localIdentity.privateBaseUrl,
  ].map((value) => {
    const url = new URL(value);
    if (url.protocol !== "https:" || !/^[a-z0-9.-]+$/u.test(url.hostname))
      fail("CONFIG-DEVELOPMENT-LEAF", "identity HTTPS host is invalid");
    return url.hostname;
  });
  const temporary = await mkdtemp("/dev/shm/coffee-development-pki-");
  try {
    await ensurePrivateSecretDirectory(temporary);
    if ((await statfs(temporary)).type !== 0x01021994)
      fail("CONFIG-DEVELOPMENT-PKI", "private tmpfs is required");
    const caPath = join(temporary, "ca.pem");
    const caKeyPath = join(temporary, "ca.key");
    const keyPath = join(temporary, "leaf.key");
    const certPath = join(temporary, "leaf.crt");
    const csrPath = join(temporary, "leaf.csr");
    const resultPath = join(temporary, "signed.crt");
    const openssl = (args) =>
      execFileSync("openssl", args, { env, stdio: "ignore", timeout: 30_000 });
    const serviceIssuer = { authority, authorityPem, authorityKeyPem };
    const publicAuthorityRef = "security.publicTransportAuthority";
    let publicMaterial = secretValueAt(secrets, publicAuthorityRef);
    const replacePublicIssuer =
      publicMaterial === undefined && provisionPublicAuthority;
    if (replacePublicIssuer) {
      const { privateKey } = generateKeyPairSync("rsa", {
        modulusLength: 3072,
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
        publicKeyEncoding: { type: "spki", format: "pem" },
      });
      await writePrivateSecret(caKeyPath, privateKey);
      openssl([
        "req",
        "-x509",
        "-new",
        "-key",
        caKeyPath,
        "-sha256",
        "-out",
        caPath,
        "-subj",
        "/CN=Coffee Platform Public TLS CA",
        "-days",
        String(config.security.publicAuthorityValidityHours / 24),
        "-addext",
        "basicConstraints=critical,CA:TRUE,pathlen:0",
        "-addext",
        "keyUsage=critical,keyCertSign,cRLSign",
      ]);
      publicMaterial = JSON.stringify({
        certificatePem: await readFile(caPath, "utf8"),
        privateKeyPem: privateKey,
      });
      setSecretAt(secrets, publicAuthorityRef, publicMaterial);
      changed.push(publicAuthorityRef);
    }
    let publicIssuer = serviceIssuer;
    if (publicMaterial !== undefined) {
      try {
        const material = JSON.parse(publicMaterial);
        if (
          !material ||
          Object.keys(material).sort().join(",") !==
            "certificatePem,privateKeyPem"
        )
          throw new Error();
        const certificate = new X509Certificate(material.certificatePem);
        const key = createPrivateKey(material.privateKeyPem);
        if (
          !certificate.ca ||
          key.asymmetricKeyType !== "rsa" ||
          key.asymmetricKeyDetails.modulusLength < 2048 ||
          !certificate.checkPrivateKey(key) ||
          !certificate.checkIssued(certificate) ||
          !certificate.verify(certificate.publicKey) ||
          now < Date.parse(certificate.validFrom) ||
          now >= Date.parse(certificate.validTo)
        )
          throw new Error();
        publicIssuer = {
          authority: certificate,
          authorityPem: material.certificatePem,
          authorityKeyPem: material.privateKeyPem,
        };
      } catch {
        fail("CONFIG-DEVELOPMENT-CA", "public CA key or validity is invalid");
      }
    }
    if (
      publicMaterial !== undefined &&
      createPrivateKey(publicKey).asymmetricKeyType !== "rsa"
    )
      fail("CONFIG-DEVELOPMENT-LEAF", "public HTTPS requires an RSA leaf key");
    if (
      !replacePublicIssuer &&
      (publicMaterial !== undefined ||
        (allowProvision &&
          Date.parse(publicLeaf.validTo) - now <= threshold)) &&
      (!publicLeaf.checkIssued(publicIssuer.authority) ||
        !publicLeaf.verify(publicIssuer.authority.publicKey))
    )
      fail(
        "CONFIG-DEVELOPMENT-CA",
        "public edge renewal requires its existing trusted issuer",
      );
    if (publicMaterial !== undefined && !replacePublicIssuer) {
      const ca = secretValueAt(secrets, "edge.tlsCaBundle");
      if (
        typeof ca !== "string" ||
        new X509Certificate(ca).fingerprint256 !==
          publicIssuer.authority.fingerprint256
      )
        fail("CONFIG-DEVELOPMENT-CA", "public edge CA bundle differs");
    }
    const sign = async ({
      key,
      certificate,
      names,
      issuer = serviceIssuer,
      validityHours = config.security.certificateValidityHours,
    }) => {
      const { authority, authorityPem, authorityKeyPem } = issuer;
      if (
        Date.parse(authority.validTo) - now <
        validityHours * 3_600_000 + 60_000
      )
        fail(
          "CONFIG-DEVELOPMENT-CA",
          "development CA expires too soon to issue a leaf",
        );
      await writePrivateSecret(caPath, authorityPem);
      await writePrivateSecret(caKeyPath, authorityKeyPem);
      await writePrivateSecret(keyPath, key);
      if (certificate) {
        await writePrivateSecret(certPath, certificate);
        openssl([
          "x509",
          "-in",
          certPath,
          "-x509toreq",
          "-signkey",
          keyPath,
          "-copy_extensions",
          "copy",
          "-out",
          csrPath,
        ]);
      } else {
        openssl([
          "req",
          "-new",
          "-key",
          keyPath,
          "-subj",
          `/CN=${names[0]}`,
          "-addext",
          `subjectAltName=${names.map((name) => `DNS:${name}`).join(",")}`,
          "-addext",
          "basicConstraints=critical,CA:FALSE",
          "-addext",
          "extendedKeyUsage=serverAuth",
          "-out",
          csrPath,
        ]);
      }
      openssl([
        "x509",
        "-req",
        "-in",
        csrPath,
        "-CA",
        caPath,
        "-CAkey",
        caKeyPath,
        "-set_serial",
        `0x${randomBytes(16).toString("hex")}`,
        "-days",
        String(validityHours / 24),
        "-copy_extensions",
        "copy",
        "-out",
        resultPath,
      ]);
      const result = await readFile(resultPath, "utf8");
      const signed = new X509Certificate(result);
      const issuedNow = Date.now();
      if (
        signed.ca ||
        !signed.checkIssued(authority) ||
        !signed.verify(authority.publicKey) ||
        !signed.checkPrivateKey(createPrivateKey(key)) ||
        issuedNow < Date.parse(signed.validFrom) ||
        issuedNow >= Date.parse(signed.validTo) ||
        Date.parse(signed.validTo) - Date.parse(signed.validFrom) !==
          validityHours * 3_600_000 ||
        Date.parse(signed.validTo) > Date.parse(authority.validTo) ||
        (certificate &&
          signed.subjectAltName !==
            new X509Certificate(certificate).subjectAltName) ||
        (names && names.some((name) => !signed.checkHost(name, exactDns)))
      )
        fail("CONFIG-DEVELOPMENT-LEAF", "issued leaf failed verification");
      return result;
    };

    if (
      replacePublicIssuer ||
      (allowProvision && Date.parse(publicLeaf.validTo) - now <= threshold)
    ) {
      setSecretAt(
        secrets,
        "edge.tlsCertificate",
        await sign({
          key: publicKey,
          certificate: publicCertificate,
          issuer: publicIssuer,
          validityHours:
            publicMaterial === undefined
              ? config.security.certificateValidityHours
              : config.security.publicCertificateValidityHours,
        }),
      );
      changed.push("edge.tlsCertificate");
      if (replacePublicIssuer) {
        setSecretAt(secrets, "edge.tlsCaBundle", publicIssuer.authorityPem);
        changed.push("edge.tlsCaBundle");
      }
    }
    for (const [prefix, names] of [
      ["identity", hosts],
      ["kafka.broker", ["kafka", "localhost"]],
    ]) {
      const issuer = prefix === "identity" ? publicIssuer : serviceIssuer;
      const { authority, authorityPem } = issuer;
      const refs = [
        `${prefix}.tlsPrivateKey`,
        `${prefix}.tlsCertificate`,
        `${prefix}.tlsCaBundle`,
      ];
      const values = refs.map((ref) => secretValueAt(secrets, ref));
      if (values.every((value) => value === undefined)) {
        if (!allowProvision)
          fail(
            "CONFIG-DEVELOPMENT-LEAF",
            `${prefix}: existing TLS material is missing`,
          );
        const { privateKey } = generateKeyPairSync("rsa", {
          modulusLength: 2048,
          privateKeyEncoding: { type: "pkcs8", format: "pem" },
          publicKeyEncoding: { type: "spki", format: "pem" },
        });
        const certificate = await sign({ key: privateKey, names, issuer });
        [privateKey, certificate, authorityPem].forEach((value, index) =>
          setSecretAt(secrets, refs[index], value),
        );
        changed.push(...refs);
      } else {
        try {
          const certificate = new X509Certificate(values[1]);
          const ca = new X509Certificate(values[2]);
          if (
            (!(replacePublicIssuer && prefix === "identity") &&
              (ca.fingerprint256 !== authority.fingerprint256 ||
                !certificate.checkIssued(authority) ||
                !certificate.verify(authority.publicKey))) ||
            certificate.ca ||
            !certificate.checkPrivateKey(createPrivateKey(values[0])) ||
            (prefix === "identity" &&
              publicMaterial !== undefined &&
              createPrivateKey(values[0]).asymmetricKeyType !== "rsa") ||
            names.some((name) => !certificate.checkHost(name, exactDns)) ||
            now < Date.parse(certificate.validFrom)
          )
            throw new Error();
          if (
            (replacePublicIssuer && prefix === "identity") ||
            Date.parse(certificate.validTo) - now <= threshold
          ) {
            setSecretAt(
              secrets,
              refs[1],
              await sign({ key: values[0], certificate: values[1], issuer }),
            );
            changed.push(refs[1]);
            if (replacePublicIssuer && prefix === "identity") {
              setSecretAt(secrets, refs[2], authorityPem);
              changed.push(refs[2]);
            }
          }
        } catch (error) {
          if (error instanceof ConfigError) throw error;
          fail(
            "CONFIG-DEVELOPMENT-LEAF",
            `${prefix}: existing TLS material is invalid`,
          );
        }
      }
    }
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    fail(
      "CONFIG-DEVELOPMENT-PKI",
      "development certificate preparation failed",
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  return changed;
}

async function renewDevelopmentTransportMaterial({ secrets, config, env }) {
  const materials = [];
  const upstreamNames = Object.fromEntries(
    Object.values(config.nginxTransport.upstreams).map(
      ({ host, serverName }) => [host, serverName],
    ),
  );
  const exactDns = { subject: "never", wildcards: false };
  let authority;
  let authorityPem;
  let authorityKeyPem;
  try {
    const issuedAuthority = JSON.parse(
      secretValueAt(secrets, "security.serviceTransportAuthority"),
    );
    if (
      !issuedAuthority ||
      Object.keys(issuedAuthority).sort().join(",") !==
        "certificatePem,privateKeyPem"
    )
      fail("CONFIG-DEVELOPMENT-CA", "development CA authority is invalid");
    authorityPem = issuedAuthority.certificatePem;
    authorityKeyPem = issuedAuthority.privateKeyPem;
    authority = new X509Certificate(authorityPem);
    const key = createPrivateKey(authorityKeyPem);
    if (
      !authority.ca ||
      key.asymmetricKeyType !== "ed25519" ||
      !authority.checkPrivateKey(key) ||
      !authority.checkIssued(authority) ||
      !authority.verify(authority.publicKey) ||
      Date.now() < Date.parse(authority.validFrom) ||
      Date.now() >= Date.parse(authority.validTo)
    )
      fail(
        "CONFIG-DEVELOPMENT-CA",
        "development CA key or validity is invalid",
      );
    for (const runtime of [...Object.keys(config.services), "edge-nginx"]) {
      const ref = `security.serviceTransportKeys.${runtime}`;
      const material = JSON.parse(secretValueAt(secrets, ref));
      if (
        !material ||
        Object.keys(material).sort().join(",") !== "caPem,certPem,keyPem"
      )
        fail(
          "CONFIG-DEVELOPMENT-LEAF",
          `${runtime}: transport material is invalid`,
        );
      const ca = new X509Certificate(material.caPem);
      if (ca.fingerprint256 !== authority.fingerprint256)
        fail(
          "CONFIG-DEVELOPMENT-CA",
          `${runtime}: CA fingerprint ${ca.fingerprint256} differs from ${authority.fingerprint256}`,
        );
      const certificate = new X509Certificate(material.certPem);
      const key = createPrivateKey(material.keyPem);
      const identitySans = (
        certificate.subjectAltName?.split(",").map((value) => value.trim()) ??
        []
      ).filter((value) => value.startsWith("URI:"));
      if (
        certificate.ca ||
        !certificate.checkIssued(authority) ||
        !certificate.verify(authority.publicKey) ||
        key.asymmetricKeyType !== "ed25519" ||
        !certificate.checkPrivateKey(key) ||
        Date.now() < Date.parse(certificate.validFrom) ||
        identitySans.length !== 1 ||
        identitySans[0] !==
          `URI:spiffe://coffee-platform/development/${runtime}` ||
        !certificate.checkHost(
          `${runtime}.development.svc.coffee-platform.internal`,
          exactDns,
        ) ||
        (upstreamNames[runtime] &&
          !certificate.checkHost(upstreamNames[runtime], exactDns))
      )
        fail(
          "CONFIG-DEVELOPMENT-LEAF",
          `${runtime}: certificate identity, key or signature is invalid`,
        );
      materials.push({ runtime, ref, material, certificate });
    }
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    fail(
      "CONFIG-DEVELOPMENT-CA",
      "development CA or scoped transport material is invalid",
    );
  }
  const due = materials.filter(
    ({ certificate }) =>
      Date.parse(certificate.validTo) - Date.now() <=
      config.security.certificateRenewBeforeHours * 3_600_000,
  );
  if (due.length === 0)
    return { authority, authorityPem, authorityKeyPem, updatedRuntimes: [] };
  if (
    Date.parse(authority.validTo) - Date.now() <
    config.security.certificateValidityHours * 3_600_000 + 60_000
  )
    fail(
      "CONFIG-DEVELOPMENT-CA",
      "development CA expires too soon to issue a leaf",
    );
  const temporary = await mkdtemp("/dev/shm/coffee-development-transport-");
  try {
    await ensurePrivateSecretDirectory(temporary);
    if ((await statfs(temporary)).type !== 0x01021994)
      fail("CONFIG-DEVELOPMENT-TRANSPORT", "private tmpfs is required");
    const caPath = join(temporary, "ca.pem");
    const caKeyPath = join(temporary, "ca.key");
    const keyPath = join(temporary, "leaf.key");
    const certPath = join(temporary, "leaf.crt");
    const csrPath = join(temporary, "leaf.csr");
    const resultPath = join(temporary, "signed.crt");
    await writePrivateSecret(caPath, authorityPem);
    await writePrivateSecret(caKeyPath, authorityKeyPem);
    const openssl = (args) =>
      execFileSync("openssl", args, { env, stdio: "ignore", timeout: 30_000 });
    for (const { ref, material, certificate } of due) {
      await writePrivateSecret(keyPath, material.keyPem);
      await writePrivateSecret(certPath, material.certPem);
      openssl([
        "x509",
        "-in",
        certPath,
        "-x509toreq",
        "-signkey",
        keyPath,
        "-copy_extensions",
        "copy",
        "-out",
        csrPath,
      ]);
      openssl([
        "x509",
        "-req",
        "-in",
        csrPath,
        "-CA",
        caPath,
        "-CAkey",
        caKeyPath,
        "-set_serial",
        `0x${randomBytes(16).toString("hex")}`,
        "-days",
        "1",
        "-copy_extensions",
        "copy",
        "-out",
        resultPath,
      ]);
      const certPem = await readFile(resultPath, "utf8");
      const signed = new X509Certificate(certPem);
      const issuedNow = Date.now();
      if (
        signed.ca ||
        !signed.checkIssued(authority) ||
        !signed.verify(authority.publicKey) ||
        !signed.checkPrivateKey(createPrivateKey(material.keyPem)) ||
        issuedNow < Date.parse(signed.validFrom) ||
        issuedNow >= Date.parse(signed.validTo) ||
        Date.parse(signed.validTo) > Date.parse(authority.validTo) ||
        Date.parse(signed.validTo) - Date.parse(signed.validFrom) !==
          config.security.certificateValidityHours * 3_600_000 ||
        signed.subjectAltName !== certificate.subjectAltName
      )
        fail("CONFIG-DEVELOPMENT-LEAF", "issued leaf failed verification");
      setSecretAt(secrets, ref, JSON.stringify({ ...material, certPem }));
    }
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    fail(
      "CONFIG-DEVELOPMENT-TRANSPORT",
      "development transport renewal failed",
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  return {
    authority,
    authorityPem,
    authorityKeyPem,
    updatedRuntimes: due.map(({ runtime }) => runtime),
  };
}

export async function materializeLocalRuntimeSecrets({
  root = REPO_ROOT,
  outputDir,
  includeBootstrap = true,
  env = process.env,
} = {}) {
  assertLocatorEnv(env, true);
  if (typeof outputDir !== "string" || resolve(outputDir) !== outputDir)
    fail("CONFIG-LOCAL-SECRET", "owned private tmpfs directory is required");
  const directory = resolve(outputDir);
  const info = await lstat(directory);
  if (
    !directory.startsWith("/dev/shm/") ||
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid() ||
    (info.mode & 0o777) !== 0o700 ||
    (await realpath(directory)) !== directory ||
    (await statfs(directory)).type !== 0x01021994
  )
    fail("CONFIG-LOCAL-SECRET", "owned private tmpfs directory is required");
  const config = await loadPlatformConfig(
    root,
    env.COFFEE_CONFIG_FILE
      ? resolve(env.COFFEE_CONFIG_FILE)
      : join(root, "config/platform.yaml"),
  );
  if (config.environment !== "development")
    fail(
      "CONFIG-LOCAL-SECRET",
      "local materialization is restricted to development",
    );
  const snapshot = await captureMigrationBundleSnapshot(root);
  const { decrypted } = await readMigrationSecretBundle(root, env);
  await assertMigrationBundleSnapshot(snapshot);
  const environment = decrypted.environments.development;
  const { authority, authorityPem, authorityKeyPem, updatedRuntimes } =
    await renewDevelopmentTransportMaterial({
      secrets: environment,
      config,
      env,
    });
  await prepareDevelopmentInfrastructureMaterial({
    secrets: environment,
    config,
    env,
    authority,
    authorityPem,
    authorityKeyPem,
    allowProvision: false,
  });
  let nginxIdentity;
  for (const runtime of [...Object.keys(config.services), "edge-nginx"]) {
    const runtimeEnv = {
      ...env,
      COFFEE_RUNTIME_SECRETS_FILE: join(
        directory,
        runtime === "edge-nginx" ? runtime : `${runtime}.yaml`,
      ),
    };
    const identity = await materializeRuntimeProjection({
      runtime,
      outputDir: directory,
      env: runtimeEnv,
      config,
      environment,
    });
    if (runtime === "edge-nginx") nginxIdentity = identity;
  }
  const valuesFor = async (scope) =>
    infrastructureValues(
      await infrastructureSecretEntries(scope, { root }),
      environment,
    );
  await materializeKafkaBrokerSecretsProjection({
    outputDir: join(directory, "kafka"),
    values: await valuesFor("kafka-broker"),
  });
  const keycloakIdentity = await materializeKeycloakSecretsProjection({
    outputDir: join(directory, "keycloak"),
    includeBootstrap,
    values: await valuesFor("keycloak-runtime"),
    config,
  });
  if (includeBootstrap)
    await materializeKeycloakRealmProjection({
      root,
      outputDir: join(directory, "keycloak-import"),
      values: await valuesFor("keycloak-operator"),
      config,
    });
  await assertMigrationBundleSnapshot(snapshot);
  return { nginxIdentity, keycloakIdentity, updatedRuntimes };
}

export async function renewDevelopmentTransportSecrets({
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
  if (config.environment !== "development")
    fail(
      "CONFIG-DEVELOPMENT-TRANSPORT",
      "transport renewal is restricted to development",
    );
  const snapshot = await captureMigrationBundleSnapshot(root);
  const { decrypted } = await readMigrationSecretBundle(root, env);
  await assertMigrationBundleSnapshot(snapshot);
  const { authority, updatedRuntimes } =
    await renewDevelopmentTransportMaterial({
      secrets: decrypted.environments.development,
      config,
      env,
    });
  if (!updatedRuntimes.length) {
    await assertMigrationBundleSnapshot(snapshot);
    return {
      changed: false,
      authorityFingerprint: authority.fingerprint256,
      updatedRuntimes,
    };
  }
  const ciphertext = encryptMigrationSecretBundle(
    root,
    env,
    snapshot,
    decrypted,
  );
  const result = await writeMigrationEncryptedBundle(snapshot, ciphertext, {
    root,
    env,
    expectedPlaintext: decrypted,
  });
  return {
    changed: true,
    authorityFingerprint: authority.fingerprint256,
    updatedRuntimes,
    encryptedSha256: result.sha256,
  };
}

async function readSavedMigrationSecretBundle(root, env, expectedSnapshot) {
  await assertMigrationBundleSnapshot(expectedSnapshot);
  const bundle = await readMigrationSecretBundle(root, env);
  await assertMigrationBundleSnapshot(expectedSnapshot);
  return bundle;
}

function migratorRolePasswords({ ownership, roleMap, secrets }) {
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
      fail("CONFIG-MIGRATIONS-MIGRATOR-SECRET", "G08 migrator credential is invalid");
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
        fail("CONFIG-MIGRATIONS-RUNTIME-SECRET", "G08 runtime credential is invalid");
      passwords.set(runtime.role, credential.password);
    }
  }
  if (passwords.size !== 15)
    fail("CONFIG-MIGRATIONS-ROLE-MAP", "G08 role credential inventory is incomplete");
  return passwords;
}

function migrationExactKeys(value, keys) {
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
export function validateMigrationPreparationConfigTransition(
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
      "CONFIG-MIGRATIONS-PREPARATION-CONFIG",
      "G08 preparation config identity is invalid",
    );

  const preparationText = preparationConfigBytes.toString("utf8");
  const currentText = currentConfigBytes.toString("utf8");
  if (
    !Buffer.from(preparationText, "utf8").equals(preparationConfigBytes) ||
    !Buffer.from(currentText, "utf8").equals(currentConfigBytes)
  )
    fail(
      "CONFIG-MIGRATIONS-PREPARATION-CONFIG",
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
      "CONFIG-MIGRATIONS-PREPARATION-CONFIG",
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
          "CONFIG-MIGRATIONS-PREPARATION-CONFIG",
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
      "CONFIG-MIGRATIONS-PREPARATION-CONFIG",
      "G08 config changed outside the approved isolation and coverage additions",
    );
  return true;
}

/** Validate the shared G08 receipt shape against a run and the saved secret bundle. */
export function validateMigrationPreparationArtifact(
  value,
  context,
  secretsSha256,
) {
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
    !migrationExactKeys(value, wrapperKeys) ||
    value.schemaVersion !== 1 ||
    value.runId !== context.runId ||
    value.candidateSha !== context.candidateSha ||
    value.baseConfigSha256 !== context.baseConfigSha256 ||
    !migrationExactKeys(prep, prepKeys) ||
    prep.schemaVersion !== 1 ||
    !["roles-created", "roles-verified"].includes(prep.stage) ||
    !/^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{7}$/u.test(prep.runId ?? "") ||
    !/^[0-9a-f]{40}$/u.test(prep.candidateSha ?? "") ||
    !prep.runId.endsWith(`-${prep.candidateSha.slice(0, 7)}`) ||
    !/^[0-9a-f]{64}$/u.test(prep.baseConfigSha256 ?? "") ||
    prep.configSha256 !== prep.baseConfigSha256 ||
    !migrationExactKeys(prep.postgres, postgresKeys) ||
    prep.postgres.host !== "coffee_postgres" ||
    prep.postgres.port !== 5432 ||
    prep.postgres.version !== "17.11" ||
    prep.postgres.database !== "postgres" ||
    !/^[0-9]{1,20}$/u.test(prep.postgres.systemIdentifier ?? "") ||
    typeof prep.postgres.user !== "string" ||
    !migrationExactKeys(prep.bundle, bundleKeys) ||
    !/^[0-9a-f]{64}$/u.test(prep.bundle.beforeSha256 ?? "") ||
    prep.bundle.resultingSha256 !== secretsSha256 ||
    !Array.isArray(prep.roleNames) ||
    prep.roleNames.length !== 15 ||
    prep.roleNames.some((role) => typeof role !== "string") ||
    new Set(prep.roleNames).size !== 15 ||
    (prep.stage === "roles-created"
      ? prep.createdCount !== 15 || prep.transaction !== "committed"
      : prep.createdCount !== 0 ||
        prep.transaction !== "read-only" ||
        prep.runId !== context.runId ||
        prep.candidateSha !== context.candidateSha ||
        prep.baseConfigSha256 !== context.baseConfigSha256 ||
        prep.bundle.beforeSha256 !== secretsSha256)
  )
    fail(
      "CONFIG-MIGRATIONS-PREPARATION",
      "G08 preparation receipt does not match this run",
    );
  return prep;
}

function migrationCreateRoleSql(role, password) {
  if (
    typeof role !== "string" ||
    !/^coffee_[a-z_]+_(?:migrator|rw|ro)$/u.test(role) ||
    typeof password !== "string" ||
    password.length === 0 ||
    password.includes("\0")
  )
    fail("CONFIG-MIGRATIONS-ROLE-CREATE", "G08 role definition is invalid");
  const escapedPassword = password
    .replaceAll("\\", "\\\\")
    .replaceAll("'", "''");
  return `CREATE ROLE "${role}" WITH LOGIN PASSWORD E'${escapedPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 20`;
}

async function readMigrationServerState(
  client,
  target,
  expectedSystemIdentifier,
) {
  let identityResult;
  try {
    identityResult = await client.query(SERVER_IDENTITY_SQL);
  } catch (error) {
    throw migrationQueryFailure(error, "identity");
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
    fail("CONFIG-MIGRATIONS-PROBE", "G08 PostgreSQL admin identity is invalid");
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
    throw migrationQueryFailure(error, "role-inventory");
  }
  const rows = inventory.rows ?? [];
  const rowByName = new Map();
  for (const row of rows) {
    if (!target.roles.includes(row.rolname) || rowByName.has(row.rolname))
      fail("CONFIG-MIGRATIONS-ROLE-INVENTORY", "G08 role inventory is invalid");
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

async function openMigrationAdminClient(
  target,
  adminPassword = target.adminPassword,
) {
  const { Client } = await import("pg").catch(() =>
    fail("CONFIG-MIGRATIONS-PG-DEPENDENCY", "pg dependency is unavailable"),
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

async function probeMigrationTargetState(
  target,
  expectedSystemIdentifier,
  adminPassword = target.adminPassword,
) {
  const client = await openMigrationAdminClient(target, adminPassword);
  let state;
  let failureFacts;
  let stage = "connect";
  try {
    await client.connect();
    stage = "identity";
    state = await readMigrationServerState(
      client,
      target,
      expectedSystemIdentifier,
    );
  } catch (error) {
    failureFacts =
      error?.migrationFacts ?? migrationDatabaseFailureFacts(error, stage);
  }
  await client.end().catch((error) => {
    if (!failureFacts)
      failureFacts = migrationDatabaseFailureFacts(error, "close");
  });
  if (failureFacts)
    failMigrationWithFacts(
      "CONFIG-MIGRATIONS-PROBE",
      "G08 canonical target probe failed",
      failureFacts,
    );
  return state;
}

function inspectMigrationAdminSource(env, stage) {
  let output;
  try {
    output = execFileSync(
      "docker",
      [
        "inspect",
        "--format",
        MIGRATION_ADMIN_SOURCE_INSPECT_FORMAT,
        MIGRATION_ADMIN_SOURCE.name,
      ],
      {
        env: sandboxBootstrapEnv(env),
        encoding: "utf8",
        timeout: 5_000,
        maxBuffer: 64 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch {
    failMigrationWithFacts(
      "CONFIG-MIGRATIONS-ADMIN-SOURCE",
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
    failMigrationWithFacts(
      "CONFIG-MIGRATIONS-ADMIN-SOURCE",
      "approved PostgreSQL credential source identity is invalid",
      { stage },
    );
  }
  const networkId = networks?.[MIGRATION_ADMIN_SOURCE.network]?.NetworkID;
  const source = {
    containerId: lines[0],
    imageId: lines[1],
    running: lines[2] === "true",
    networkId,
  };
  if (
    source.containerId !== MIGRATION_ADMIN_SOURCE.containerId ||
    source.imageId !== MIGRATION_ADMIN_SOURCE.imageId ||
    !source.running ||
    typeof source.networkId !== "string" ||
    !/^[0-9a-f]{64}$/u.test(source.networkId)
  )
    failMigrationWithFacts(
      "CONFIG-MIGRATIONS-ADMIN-SOURCE",
      "approved PostgreSQL credential source identity changed",
      {
        stage,
        containerId: source.containerId,
        imageId: source.imageId,
        running: source.running,
        networkName: MIGRATION_ADMIN_SOURCE.network,
      },
    );
  return source;
}

function readMigrationAdminPasswordFromSource(env) {
  const before = inspectMigrationAdminSource(env, "container-before-extract");
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
        env: sandboxBootstrapEnv(env),
        timeout: 5_000,
        maxBuffer: 4_096,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch {
    failMigrationWithFacts(
      "CONFIG-MIGRATIONS-ADMIN-SOURCE",
      "approved PostgreSQL credential is unavailable",
      { stage: "credential-extract" },
    );
  }
  const after = inspectMigrationAdminSource(env, "container-after-extract");
  if (!isDeepStrictEqual(before, after))
    failMigrationWithFacts(
      "CONFIG-MIGRATIONS-ADMIN-SOURCE_CHANGED",
      "PostgreSQL credential source changed during extraction",
      {
        stage: "container-after-extract",
        containerId: after.containerId,
        imageId: after.imageId,
        networkName: MIGRATION_ADMIN_SOURCE.network,
      },
    );
  const password = passwordBytes.toString("utf8");
  if (
    password.length === 0 ||
    !Buffer.from(password, "utf8").equals(passwordBytes)
  )
    failMigrationWithFacts(
      "CONFIG-MIGRATIONS-ADMIN-SOURCE",
      "approved PostgreSQL credential is invalid",
      { stage: "credential-validate" },
    );
  return password;
}

function isMigrationAdminAuthenticationFailure(error) {
  return (
    error instanceof ConfigError &&
    error.ruleId === "CONFIG-MIGRATIONS-PROBE" &&
    error.facts?.stage === "connect" &&
    error.facts?.failureCategory === "authentication" &&
    error.facts?.sqlState === "28P01"
  );
}

function assertMigrationAdminIdentityAndRoles(state, expectedSystemIdentifier) {
  if (
    state.postgres.systemIdentifier !== expectedSystemIdentifier ||
    state.postgres.version !== "17.11" ||
    state.postgres.user !== "coffeeuser" ||
    state.postgres.database !== "postgres"
  )
    failMigrationWithFacts(
      "CONFIG-MIGRATIONS-IDENTITY",
      "G08 target differs from approved identity",
      {
        stage: "readonly-probe",
        expectedSystemIdentifier,
        postgres: state.postgres,
      },
    );
  if (!state.roleInventory.allAbsent)
    failMigrationWithFacts(
      "CONFIG-MIGRATIONS-ROLE-PRESENT",
      "G08 admin credential synchronization requires all canonical roles absent",
      {
        stage: "readonly-probe",
        postgres: state.postgres,
        roleInventory: state.roleInventory,
      },
    );
}

/** Read-only G08 probe; it never creates roles or databases. */
export async function probeCanonicalMigrationTarget({
  root = REPO_ROOT,
  contextPath = process.env.COFFEE_LAUNCH_CONTEXT_FILE,
  env = process.env,
} = {}) {
  let target;
  try {
    target = await validateMigrationTarget({ root, contextPath, env });
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    fail("CONFIG-MIGRATIONS-TARGET", "G08 canonical target validation failed");
  }
  const state = await probeMigrationTargetState(target);
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

/** Verify the current canonical roles and credentials without modifying PostgreSQL or SOPS. */
export async function attestCanonicalMigrationPreparation({
  root = REPO_ROOT,
  contextPath = process.env.COFFEE_LAUNCH_CONTEXT_FILE,
  env = process.env,
  expectedSystemIdentifier,
} = {}) {
  if (
    typeof expectedSystemIdentifier !== "string" ||
    !/^[0-9]{1,20}$/u.test(expectedSystemIdentifier)
  )
    fail("CONFIG-MIGRATIONS-IDENTITY", "approved G08 system identifier is required");
  const snapshot = await captureMigrationBundleSnapshot(root);
  const target = await validateMigrationTarget({ root, contextPath, env });
  const contextBytes = await readFile(contextPath);
  if (
    !isDeepStrictEqual(
      JSON.parse(contextBytes.toString("utf8")),
      target.context,
    )
  )
    fail(
      "CONFIG-MIGRATIONS-CONTEXT",
      "G08 launch context changed during verification",
    );
  await assertMigrationBundleSnapshot(snapshot);
  const passwords = migratorRolePasswords(target);
  const before = await probeMigrationTargetState(
    target,
    expectedSystemIdentifier,
  );
  assertPreparedMigrationRoleInventory(before, target.roles);
  const { Client } = await import("pg").catch(() =>
    fail("CONFIG-MIGRATIONS-PG-DEPENDENCY", "pg dependency is unavailable"),
  );
  for (const [role, password] of passwords) {
    const client = new Client({
      host: target.config.postgres.host,
      port: target.config.postgres.port,
      database: "postgres",
      user: role,
      password,
      ssl: false,
      connectionTimeoutMillis: 3_000,
      query_timeout: 3_000,
    });
    let md5Auth = false;
    let saslAuth = false;
    let saslFinal = false;
    client.connection.on("authenticationSASL", () => {
      saslAuth = true;
    });
    client.connection.on("authenticationMD5Password", () => {
      md5Auth = true;
    });
    client.connection.on("authenticationSASLFinal", () => {
      saslFinal = true;
    });
    let valid = false;
    try {
      await client.connect();
      const result = await client.query(
        "SELECT current_user, current_database()",
      );
      valid =
        (md5Auth || (saslAuth && saslFinal)) &&
        result.rows?.length === 1 &&
        result.rows[0].current_user === role &&
        result.rows[0].current_database === "postgres";
    } catch {
      valid = false;
    } finally {
      await client.end().catch(() => {
        valid = false;
      });
    }
    if (!valid)
      fail("CONFIG-MIGRATIONS-ROLE-AUTH", "G08 role password authentication failed");
  }
  const after = await probeMigrationTargetState(
    target,
    expectedSystemIdentifier,
  );
  assertPreparedMigrationRoleInventory(after, target.roles);
  await assertMigrationBundleSnapshot(snapshot);
  const current = await validateMigrationTarget({ root, contextPath, env });
  await assertMigrationBundleSnapshot(snapshot);
  if (
    !isDeepStrictEqual(before, after) ||
    !isDeepStrictEqual(target.context, current.context) ||
    !contextBytes.equals(await readFile(contextPath)) ||
    target.contextInfo.dev !== current.contextInfo.dev ||
    target.contextInfo.ino !== current.contextInfo.ino ||
    !isDeepStrictEqual(target.roleMap, current.roleMap) ||
    !isDeepStrictEqual(target.ownership, current.ownership) ||
    !isDeepStrictEqual(target.secrets, current.secrets)
  )
    fail(
      "CONFIG-MIGRATIONS-IDENTITY_CHANGED",
      "G08 target or context changed during verification",
    );
  return {
    schemaVersion: 1,
    stage: "roles-verified",
    runId: target.context.runId,
    candidateSha: target.context.candidateSha,
    baseConfigSha256: target.context.baseConfigSha256,
    configSha256: target.configSha256,
    postgres: before.postgres,
    bundle: { beforeSha256: snapshot.sha256, resultingSha256: snapshot.sha256 },
    roleNames: target.roles,
    createdCount: 0,
    transaction: "read-only",
  };
}

/** Return the prepared PostgreSQL identity only after a fresh G08-bound probe. */
export async function readPreparedPostgresIdentity({
  root = REPO_ROOT,
  contextPath = process.env.COFFEE_LAUNCH_CONTEXT_FILE,
  preparationContextPath,
  env = process.env,
} = {}) {
  const bundleSnapshot = await captureMigrationBundleSnapshot(root);
  const target = await validateMigrationTarget({ root, contextPath, env });
  await assertMigrationBundleSnapshot(bundleSnapshot);
  const preparationSource = await readMigrationPreparationSource(
    target,
    root,
    preparationContextPath,
  );
  const { preparation, snapshot: preparationSnapshot } =
    await readMigrationPreparationSnapshot(
      target,
      root,
      bundleSnapshot,
      preparationSource,
    );
  const state = await probeMigrationTargetState(
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
      "CONFIG-MIGRATIONS-IDENTITY",
      "G08 live target differs from preparation receipt",
    );
  assertPreparedMigrationRoleInventory(state, target.roles);
  await assertMigrationBundleSnapshot(bundleSnapshot);
  await assertMigrationPreparationSnapshot(preparationSnapshot);
  await assertMigrationPreparationSource(target, root, preparationSource);
  return Object.freeze({ ...state.postgres });
}

/** Verify the existing admin credential, syncing only its SOPS field on exact 28P01. */
export async function synchronizeMigrationAdminCredential({
  root = REPO_ROOT,
  contextPath = process.env.COFFEE_LAUNCH_CONTEXT_FILE,
  env = process.env,
  expectedSystemIdentifier,
} = {}) {
  if (
    typeof expectedSystemIdentifier !== "string" ||
    !/^[0-9]{1,20}$/u.test(expectedSystemIdentifier)
  )
    fail("CONFIG-MIGRATIONS-IDENTITY", "approved G08 system identifier is required");

  const contextEnv = sandboxBootstrapEnv(env);
  assertLocatorEnv(contextEnv, true);
  const bundleSnapshot = await captureMigrationBundleSnapshot(root);
  let target;
  try {
    target = await validateMigrationTarget({
      root,
      contextPath,
      env: contextEnv,
    });
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    fail("CONFIG-MIGRATIONS-TARGET", "G08 canonical target validation failed");
  }
  await assertMigrationBundleSnapshot(bundleSnapshot);
  if (
    target.config.environment !== "development" ||
    target.config.postgres.bootstrapUsername !== "coffeeuser"
  )
    fail(
      "CONFIG-MIGRATIONS-TARGET",
      "admin credential sync requires development coffeeuser",
    );

  let state;
  try {
    state = await probeMigrationTargetState(target, expectedSystemIdentifier);
  } catch (error) {
    if (!isMigrationAdminAuthenticationFailure(error)) throw error;
    const sourcePassword = readMigrationAdminPasswordFromSource(contextEnv);
    state = await probeMigrationTargetState(
      target,
      expectedSystemIdentifier,
      sourcePassword,
    );
    assertMigrationAdminIdentityAndRoles(state, expectedSystemIdentifier);

    const proposedDocument = structuredClone(target.secretDocument);
    setSecretAt(
      proposedDocument.environments.development,
      "bootstrap.postgresAdminPassword",
      sourcePassword,
    );
    const encrypted = encryptMigrationSecretBundle(
      root,
      contextEnv,
      bundleSnapshot,
      proposedDocument,
    );
    const resultingSnapshot = await writeMigrationEncryptedBundle(
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
    const savedBundle = await readSavedMigrationSecretBundle(
      root,
      contextEnv,
      savedSnapshot,
    );
    if (!isDeepStrictEqual(savedBundle.decrypted, proposedDocument))
      failMigrationWithFacts(
        "CONFIG-MIGRATIONS-SOPS-ROUNDTRIP",
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
        containerId: MIGRATION_ADMIN_SOURCE.containerId,
        imageId: MIGRATION_ADMIN_SOURCE.imageId,
        networkName: MIGRATION_ADMIN_SOURCE.network,
      },
      bundle: {
        beforeSha256: bundleSnapshot.sha256,
        resultingSha256: resultingSnapshot.sha256,
      },
    };
  }

  assertMigrationAdminIdentityAndRoles(state, expectedSystemIdentifier);
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
export async function prepareCanonicalMigratorRoles({
  root = REPO_ROOT,
  contextPath = process.env.COFFEE_LAUNCH_CONTEXT_FILE,
  env = process.env,
  expectedSystemIdentifier,
} = {}) {
  if (
    typeof expectedSystemIdentifier !== "string" ||
    !/^[0-9]{1,20}$/u.test(expectedSystemIdentifier)
  )
    fail("CONFIG-MIGRATIONS-IDENTITY", "approved G08 system identifier is required");

  const contextEnv = sandboxBootstrapEnv(env);
  assertLocatorEnv(contextEnv, true);
  const bundleSnapshot = await captureMigrationBundleSnapshot(root);
  let target;
  try {
    target = await validateMigrationTarget({
      root,
      contextPath,
      env: contextEnv,
    });
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    fail("CONFIG-MIGRATIONS-TARGET", "G08 canonical target validation failed");
  }
  await assertMigrationBundleSnapshot(bundleSnapshot);

  const initialState = await probeMigrationTargetState(target);
  if (
    initialState.postgres.systemIdentifier !== expectedSystemIdentifier ||
    initialState.postgres.version !== "17.11"
  )
    failMigrationWithFacts(
      "CONFIG-MIGRATIONS-IDENTITY",
      "G08 target differs from approved identity",
      {
        stage: "readonly-probe",
        expectedSystemIdentifier,
        postgres: initialState.postgres,
        bundleSha256: bundleSnapshot.sha256,
      },
    );
  if (!initialState.roleInventory.allAbsent)
    failMigrationWithFacts(
      "CONFIG-MIGRATIONS-ROLE-PRESENT",
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
      failMigrationWithFacts(
        "CONFIG-MIGRATIONS-MIGRATOR-BLOCK_PRESENT",
        "G08 migrator credentials already exist; refusing regeneration",
        {
          stage: "preparation-admission",
          postgres: initialState.postgres,
          roleInventory: initialState.roleInventory,
          bundleSha256: bundleSnapshot.sha256,
        },
      );

  await assertMigrationBundleSnapshot(bundleSnapshot);
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
    fail("CONFIG-MIGRATIONS-ROLE-MAP", "G08 owner set is not canonical");
  const generatedMigrators = Object.fromEntries(
    ownerNames.map((owner) => [owner, randomBytes(32).toString("base64url")]),
  );
  selectedEnvironment.bootstrap.migrators = generatedMigrators;
  const proposedPasswords = migratorRolePasswords({
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
      "CONFIG-MIGRATIONS-ROLE-SECRET",
      "G08 role credentials must be distinct from admin",
    );

  const encryptedContents = encryptMigrationSecretBundle(
    root,
    contextEnv,
    bundleSnapshot,
    secretDocument,
  );
  const resultBundleSnapshot = await writeMigrationEncryptedBundle(
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
  const savedBundle = await readSavedMigrationSecretBundle(root, contextEnv, {
    ...savedBundleSnapshot,
  });
  const savedWithoutMigrators = structuredClone(savedBundle.decrypted);
  delete savedWithoutMigrators.environments[target.config.environment].bootstrap
    .migrators;
  if (!isDeepStrictEqual(savedWithoutMigrators, target.secretDocument))
    fail(
      "CONFIG-MIGRATIONS-SOPS-ROUNDTRIP",
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
      "CONFIG-MIGRATIONS-SOPS-ROUNDTRIP",
      "G08 saved migrator credentials do not match",
    );

  const savedEnvironment =
    savedBundle.decrypted.environments[target.config.environment];
  const savedAdminPassword = secretValueAt(
    savedEnvironment,
    "bootstrap.postgresAdminPassword",
  );
  const rolePasswords = migratorRolePasswords({
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
    fail("CONFIG-MIGRATIONS-ROLE-SECRET", "G08 saved role credentials are invalid");

  target.adminPassword = savedAdminPassword;
  const client = await openMigrationAdminClient(target);
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
      transactionState = await readMigrationServerState(client, target);
    } catch {
      failureCode = "CONFIG-MIGRATIONS-TRANSACTION-PROBE";
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
      failureCode = "CONFIG-MIGRATIONS-IDENTITY_CHANGED";
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
      failureCode = "CONFIG-MIGRATIONS-ROLE_CONFLICT";
      failureFacts = {
        stage: "role-transaction",
        postgres: transactionState.postgres,
        roleInventory: transactionState.roleInventory,
        bundleBeforeSha256: bundleSnapshot.sha256,
        bundleResultingSha256: resultBundleSnapshot.sha256,
      };
      throw new Error("G08 role inventory changed before role creation");
    }
    await assertMigrationBundleSnapshot(savedBundleSnapshot);
    for (const [role, password] of rolePasswords)
      await client.query(migrationCreateRoleSql(role, password));
    commitAttempted = true;
    await client.query("COMMIT");
    transactionOpen = false;
    committed = true;
  } catch (error) {
    if (commitAttempted) {
      failureCode = "CONFIG-MIGRATIONS-COMMIT-UNKNOWN";
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
        failureCode = "CONFIG-MIGRATIONS-ROLLBACK-UNKNOWN";
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
        error.ruleId === "CONFIG-MIGRATIONS-BUNDLE_CHANGED"
      ) {
        failureCode = "CONFIG-MIGRATIONS-BUNDLE_CHANGED";
        failureFacts = {
          stage: "bundle-changed-before-role-create",
          expectedSystemIdentifier,
          bundleBeforeSha256: bundleSnapshot.sha256,
          bundleResultingSha256: resultBundleSnapshot.sha256,
          roleNames: target.roles,
        };
      } else {
        failureCode = "CONFIG-MIGRATIONS-ROLE-CREATE";
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
    if (failureCode === "CONFIG-MIGRATIONS-COMMIT-UNKNOWN")
      failMigrationWithFacts(
        failureCode,
        "G08 COMMIT outcome is unknown; no automatic repair or retry was attempted",
        failureFacts,
      );
    if (failureCode === "CONFIG-MIGRATIONS-ROLLBACK-UNKNOWN")
      failMigrationWithFacts(
        failureCode,
        "G08 rollback outcome is unknown; no automatic repair was attempted",
        failureFacts,
      );
    failMigrationWithFacts(
      failureCode,
      "G08 canonical role preparation failed",
      failureFacts,
    );
  }
  if (!committed)
    fail("CONFIG-MIGRATIONS-ROLE-CREATE", "G08 canonical role preparation failed");
  if (closeFailed)
    failMigrationWithFacts(
      "CONFIG-MIGRATIONS-COMMIT-CLOSE",
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

async function readMigrationPreparationSource(
  target,
  root,
  preparationContextPath,
) {
  const rawResources = target.context.resources;
  if (
    rawResources !== undefined &&
    (!rawResources ||
      typeof rawResources !== "object" ||
      Array.isArray(rawResources))
  )
    fail("CONFIG-MIGRATIONS-PREPARATION", "G08 preparation metadata is invalid");
  const resources = rawResources ?? {};

  if (preparationContextPath === undefined) {
    if (
      Object.keys(resources).some(
        (key) =>
          key === "g08PreparationContextPath" || key.startsWith("g15Parent"),
      )
    )
      fail(
        "CONFIG-MIGRATIONS-BROWSER-LINEAGE",
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
    !migrationExactKeys(resources, parentKeys) ||
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
      "CONFIG-MIGRATIONS-BROWSER-LINEAGE",
      "G15 parent preparation reference is invalid",
    );

  await assertPreparationNoSymlinkPath(preparationContextPath);
  const contextInfo = await lstat(preparationContextPath).catch(() => null);
  if (
    !contextInfo?.isFile() ||
    contextInfo.uid !== process.getuid() ||
    (contextInfo.mode & 0o777) !== 0o400 ||
    contextInfo.size > 16 * 1024
  )
    fail("CONFIG-MIGRATIONS-BROWSER-LINEAGE", "G15 parent launch context is not trusted");
  const contextBytes = await readFile(preparationContextPath);
  let sourceContext;
  try {
    sourceContext = JSON.parse(contextBytes.toString("utf8"));
  } catch {
    fail("CONFIG-MIGRATIONS-BROWSER-LINEAGE", "G15 parent context is invalid");
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
      "CONFIG-MIGRATIONS-BROWSER-LINEAGE",
      "G15 parent context does not match child identity",
    );

  let sourceValidated;
  try {
    const reportPath = join(
      sourceContext.sourceRepoRoot,
      "verification/launch/v1/report.mjs",
    );
    await assertPreparationNoSymlinkPath(reportPath);
    const { validateLaunchContext } = await import(
      pathToFileURL(reportPath).href
    );
    sourceValidated = await validateLaunchContext(preparationContextPath);
  } catch {
    fail(
      "CONFIG-MIGRATIONS-BROWSER-LINEAGE",
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
      "CONFIG-MIGRATIONS-BROWSER-LINEAGE",
      "G15 parent context changed during validation",
    );

  let lineage;
  try {
    const { readBrowserFixtureLineage } = await import("./browser-fixture.mjs");
    lineage = await readBrowserFixtureLineage({
      root: target.context.sourceRepoRoot,
      contextPath: target.contextPath,
      baseCandidateSha: sourceContext.candidateSha,
    });
  } catch {
    fail(
      "CONFIG-MIGRATIONS-BROWSER-LINEAGE",
      "G15 child is not the exact approved OIDC-only config variant",
    );
  }
  if (
    lineage.baseCandidateSha !== sourceContext.candidateSha ||
    lineage.candidateSha !== target.context.candidateSha ||
    lineage.baseConfigSha256 !== sourceContext.baseConfigSha256 ||
    lineage.configSha256 !== target.context.baseConfigSha256
  )
    fail("CONFIG-MIGRATIONS-BROWSER-LINEAGE", "G15 config lineage does not match");

  let inspectLaunchCheckout;
  try {
    ({ inspectLaunchCheckout } =
      await import("../../verification/launch/v1/scenarios/rollback.mjs"));
    await inspectLaunchCheckout(
      resources.g15ParentCheckoutRoot,
      sourceContext.candidateSha,
      dirname(target.context.checkoutDir) === resources.g15ParentCheckoutRoot
        ? { ownedChildRoot: target.context.checkoutDir }
        : undefined,
    );
  } catch {
    fail(
      "CONFIG-MIGRATIONS-BROWSER-LINEAGE",
      "G15 parent checkout is not clean and bound to its context",
    );
  }

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
    fail("CONFIG-MIGRATIONS-BROWSER-LINEAGE", "G15 parent config blob is unavailable");
  }
  if (
    createHash("sha256").update(configBytes).digest("hex") !==
    sourceContext.baseConfigSha256
  )
    fail("CONFIG-MIGRATIONS-BROWSER-LINEAGE", "G15 parent config hash differs");

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

async function assertMigrationPreparationSource(target, root, source) {
  if (!source.g15) return;
  const current = await readMigrationPreparationSource(
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
    fail("CONFIG-MIGRATIONS-PREPARATION_CHANGED", "G15 preparation source changed");
}

async function readMigrationPreparationSnapshot(
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
    "gates/migrations/artifacts/canonical-preparation.json",
  );
  await assertPreparationNoSymlinkPath(path);
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
      fail("CONFIG-MIGRATIONS-PREPARATION", "G08 preparation receipt is untrusted");
    bytes = await readFile(path);
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    fail("CONFIG-MIGRATIONS-PREPARATION", "G08 preparation receipt is unavailable");
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
      "CONFIG-MIGRATIONS-PREPARATION",
      "G08 preparation receipt changed while read",
    );

  let wrapper;
  try {
    wrapper = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("CONFIG-MIGRATIONS-PREPARATION", "G08 preparation receipt is invalid");
  }
  const roleNames = [...target.roles].sort((left, right) =>
    left.localeCompare(right),
  );
  let prep;
  try {
    prep = validateMigrationPreparationArtifact(
      wrapper,
      source.context,
      bundleSnapshot.sha256,
    );
  } catch {
    fail(
      "CONFIG-MIGRATIONS-PREPARATION",
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
      "CONFIG-MIGRATIONS-PREPARATION",
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
      "CONFIG-MIGRATIONS-PREPARATION",
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
      "CONFIG-MIGRATIONS-PREPARATION",
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
      "CONFIG-MIGRATIONS-PREPARATION-CONFIG",
      "G08 current config changed during preparation validation",
    );
  validateMigrationPreparationConfigTransition(
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

async function assertMigrationPreparationSnapshot(snapshot) {
  await assertPreparationNoSymlinkPath(snapshot.path);
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
    fail("CONFIG-MIGRATIONS-PREPARATION_CHANGED", "G08 preparation receipt changed");
}

function assertPreparedMigrationRoleInventory(state, roles) {
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
    failMigrationWithFacts(
      "CONFIG-MIGRATIONS-ROLE-INVENTORY",
      "G08 canonical prepared roles do not match the approved role contract",
      {
        stage: "credential-admission",
        roleCount: existing?.length ?? 0,
      },
    );
}

/** Return one G08 credential only after binding it to the current committed preparation. */
export async function readMigrationCredential({
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
    fail("CONFIG-MIGRATIONS-CREDENTIAL-REQUEST", "G08 credential request is invalid");
  const bundleSnapshot = await captureMigrationBundleSnapshot(root);
  const target = await validateMigrationTarget({ root, contextPath, env });
  await assertMigrationBundleSnapshot(bundleSnapshot);
  if (
    target.config.environment !== "development" ||
    target.config.verification?.databaseIsolation?.enabled !== true
  )
    fail(
      "CONFIG-MIGRATIONS-TARGET",
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
      "CONFIG-MIGRATIONS-CREDENTIAL-OWNER",
      "G08 credential owner is not canonical",
    );

  const preparationSource = await readMigrationPreparationSource(
    target,
    root,
    preparationContextPath,
  );
  const { preparation, snapshot: preparationSnapshot } =
    await readMigrationPreparationSnapshot(
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
    fail("CONFIG-MIGRATIONS-IDENTITY", "G08 preparation server identity differs");

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
      "CONFIG-MIGRATIONS-MIGRATOR-SECRET",
      "G08 prepared migrator credentials are invalid",
    );

  const state = await probeMigrationTargetState(target, boundSystemIdentifier);
  if (
    state.postgres.host !== target.config.postgres.host ||
    state.postgres.port !== target.config.postgres.port ||
    state.postgres.version !== preparation.postgres.version ||
    state.postgres.systemIdentifier !== preparation.postgres.systemIdentifier ||
    state.postgres.user !== target.config.postgres.bootstrapUsername ||
    state.postgres.database !== preparation.postgres.database
  )
    fail(
      "CONFIG-MIGRATIONS-IDENTITY",
      "G08 live target differs from preparation receipt",
    );
  assertPreparedMigrationRoleInventory(state, target.roles);
  await assertMigrationBundleSnapshot(bundleSnapshot);
  await assertMigrationPreparationSnapshot(preparationSnapshot);
  await assertMigrationPreparationSource(target, root, preparationSource);

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
        "CONFIG-MIGRATIONS-CREDENTIAL-RUNTIME",
        "G08 runtime credential claim is not canonical",
      );
    const credential = secretValueAt(target.secrets, claim.secretRef);
    if (
      credential?.username !== runtimeRole.role ||
      typeof credential.password !== "string" ||
      credential.password.length === 0 ||
      credential.password.includes("\0")
    )
      fail("CONFIG-MIGRATIONS-RUNTIME-SECRET", "G08 runtime credential is invalid");
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
      "CONFIG-AROMA-SECRET-PATH",
      "G16 secrets must be materialized in the private tmpfs directory",
    );
  await ensurePrivateSecretDirectory(outputDir);
  const config = await loadPlatformConfig(
    root,
    join(root, "config/platform.yaml"),
  );
  if (config.environment === "production")
    fail("CONFIG-AROMA-ENVIRONMENT", "G16 sandbox is forbidden in production");
  await sandboxPostgresVersion(root);
  const secretEnv = sandboxBootstrapEnv(env);
  const secrets = await readSandboxSecrets(root, secretEnv, config);
  const adminPassword = secretValueAt(
    secrets,
    "bootstrap.postgresAdminPassword",
  );
  if (typeof adminPassword !== "string" || adminPassword.length === 0)
    fail("CONFIG-AROMA-ADMIN-SECRET", "G16 PostgreSQL admin secret is missing");
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
      "CONFIG-AROMA-ENDPOINT",
      "G16 PostgreSQL endpoint must be loopback with a dynamic port",
    );
  if (!outputDir || !outputDir.startsWith("/dev/shm/coffee-g16-secrets-"))
    fail(
      "CONFIG-AROMA-SECRET-PATH",
      "G16 secrets must be materialized in the private tmpfs directory",
    );
  const secretEnv = sandboxBootstrapEnv(env);
  const config = await loadPlatformConfig(
    root,
    join(root, "config/platform.yaml"),
  );
  if (config.environment === "production")
    fail("CONFIG-AROMA-ENVIRONMENT", "G16 sandbox is forbidden in production");
  const postgresVersion = await sandboxPostgresVersion(root);
  const secrets = await readSandboxSecrets(root, secretEnv, config);
  const adminPassword = secretValueAt(
    secrets,
    "bootstrap.postgresAdminPassword",
  );
  if (typeof adminPassword !== "string" || adminPassword.length === 0)
    fail("CONFIG-AROMA-ADMIN-SECRET", "G16 PostgreSQL admin secret is missing");
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
    fail("CONFIG-AROMA-ROLE-MAP", "database ownership authority is invalid");
  try {
    validateRoleMap(roleMap, ownership);
  } catch {
    fail("CONFIG-AROMA-ROLE-MAP", "canonical database role map is invalid");
  }
  const selected = roleMap.databases.filter((database) =>
    AROMA_SANDBOX_OWNERS.has(
      ownership.databases.find(
        (entry) => entry.migratorRole === database.migratorRole,
      )?.owner,
    ),
  );
  if (selected.length !== AROMA_SANDBOX_OWNERS.size)
    fail("CONFIG-AROMA-ROLE-MAP", "G16 owner roles are incomplete");
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
      fail("CONFIG-AROMA-ROLE-MAP", "G16 database owner mapping is invalid");
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
          "CONFIG-AROMA-ROLE-CLAIM",
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
          "CONFIG-AROMA-RUNTIME-SECRET",
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
    fail("CONFIG-AROMA-PG-DEPENDENCY", "pg dependency is unavailable"),
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
        "CONFIG-AROMA-SERVER-IDENTITY",
        "G16 PostgreSQL instance does not match the canonical toolchain pin",
      );
    const systemIdentifier = probe.system_identifier;
    for (const database of selected) {
      const owner = ownership.databases.find(
        (entry) => entry.migratorRole === database.migratorRole,
      ).owner;
      const name = databaseNames[owner];
      const databaseRoles = { ...database, name };
      const migratorRole = quoteSandboxIdentifier(database.migratorRole);
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
        `CREATE DATABASE ${quoteSandboxIdentifier(name)} OWNER ${migratorRole} TEMPLATE template0`,
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
          `DROP DATABASE IF EXISTS ${quoteSandboxIdentifier(name)}`,
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
    fail("CONFIG-AROMA-MIGRATOR-INPUT", "G16 migrator target is invalid");
  const ownership = JSON.parse(
    await readFile(join(root, "config/database-ownership.json"), "utf8"),
  );
  const roleMap = JSON.parse(
    await readFile(join(root, "config/database-role-map.json"), "utf8"),
  );
  try {
    validateRoleMap(roleMap, ownership);
  } catch {
    fail("CONFIG-AROMA-MIGRATOR-ROLE", "canonical database role map is invalid");
  }
  const roleDatabase = roleMap.databases.find(
    (database) =>
      ownership.databases.find(
        (entry) => entry.migratorRole === database.migratorRole,
      )?.owner === owner,
  );
  if (!roleDatabase)
    fail("CONFIG-AROMA-MIGRATOR-ROLE", "G16 canonical migrator role is missing");
  const config = await loadPlatformConfig(
    root,
    join(root, "config/platform.yaml"),
  );
  if (config.environment === "production")
    fail("CONFIG-AROMA-ENVIRONMENT", "G16 sandbox is forbidden in production");
  const postgresVersion = await sandboxPostgresVersion(root);
  const secrets = await readSandboxSecrets(
    root,
    sandboxBootstrapEnv(env),
    config,
  );
  const adminPassword = secretValueAt(
    secrets,
    "bootstrap.postgresAdminPassword",
  );
  if (typeof adminPassword !== "string" || adminPassword.length === 0)
    fail("CONFIG-AROMA-ADMIN-SECRET", "G16 PostgreSQL admin secret is missing");
  const { Client } = await import("pg").catch(() =>
    fail("CONFIG-AROMA-PG-DEPENDENCY", "pg dependency is unavailable"),
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
      fail("CONFIG-AROMA-MIGRATOR_TARGET_MISMATCH");
    await client.query(
      `SET ROLE ${quoteSandboxIdentifier(roleDatabase.migratorRole)}`,
    );
    await client.query(
      `SET search_path = ${quoteSandboxIdentifier(roleDatabase.schema)}, pg_catalog`,
    );
    const identity = (await client.query("SELECT current_user, session_user"))
      .rows[0];
    if (
      identity.current_user !== roleDatabase.migratorRole ||
      identity.session_user !== "postgres"
    )
      fail("CONFIG-AROMA-MIGRATOR_ROLE_MISMATCH");
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
      "CONFIG-AROMA-FINALIZE-INPUT",
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
    fail("CONFIG-AROMA-FINALIZE-ROLE", "canonical database role map is invalid");
  }
  const roleDatabase = roleMap.databases.find(
    (database) =>
      ownership.databases.find(
        (entry) => entry.migratorRole === database.migratorRole,
      )?.owner === owner,
  );
  if (!roleDatabase)
    fail("CONFIG-AROMA-FINALIZE-ROLE", "G16 canonical database role is missing");
  const config = await loadPlatformConfig(
    root,
    join(root, "config/platform.yaml"),
  );
  if (config.environment === "production")
    fail("CONFIG-AROMA-ENVIRONMENT", "G16 sandbox is forbidden in production");
  const postgresVersion = await sandboxPostgresVersion(root);
  const secrets = await readSandboxSecrets(
    root,
    sandboxBootstrapEnv(env),
    config,
  );
  const adminPassword = secretValueAt(
    secrets,
    "bootstrap.postgresAdminPassword",
  );
  if (typeof adminPassword !== "string" || adminPassword.length === 0)
    fail("CONFIG-AROMA-ADMIN-SECRET", "G16 PostgreSQL admin secret is missing");
  const { Client } = await import("pg").catch(() =>
    fail("CONFIG-AROMA-PG-DEPENDENCY", "pg dependency is unavailable"),
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
      fail("CONFIG-AROMA-FINALIZE-TARGET_MISMATCH");
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

export function selectBackupRuntimeCredentialClaim({
  owner,
  runtime,
  roleMap,
  ownership,
} = {}) {
  if (
    !Object.hasOwn(BACKUP_RUNTIME_OWNERS, runtime) ||
    BACKUP_RUNTIME_OWNERS[runtime] !== owner
  )
    fail(
      "CONFIG-BACKUP-RUNTIME",
      "G17 runtime credential is not approved for this owner",
    );
  try {
    validateRoleMap(roleMap, ownership);
  } catch {
    fail("CONFIG-BACKUP-ROLE-MAP", "canonical database role map is invalid");
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
      "CONFIG-BACKUP-RUNTIME",
      "canonical G17 runtime credential claim is invalid",
    );
  }
  return { username: runtimeRole.role, secretRef: claim.secretRef };
}

/** Read one G17 bootstrap credential in-process after binding it to an exact launch target. */
export async function readBackupCredential({
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
    fail("CONFIG-BACKUP-IDENTITY", "G17 launch identity or owner is invalid");
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
      "CONFIG-BACKUP-DATABASE",
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
    fail("CONFIG-BACKUP-TARGET", "G17 PostgreSQL target identity is invalid");
  }
  const { config } = await validateBackupTarget({
    root,
    contextPath,
    runId,
    candidateSha,
    host,
    port,
    expectedSystemIdentifier,
  });
  const secretEnv = sandboxBootstrapEnv(env);
  await sandboxPostgresVersion(root);
  let runtimeClaim;
  if (runtime !== undefined) {
    const ownership = JSON.parse(
      await readFile(join(root, "config/database-ownership.json"), "utf8"),
    );
    const roleMap = JSON.parse(
      await readFile(join(root, "config/database-role-map.json"), "utf8"),
    );
    runtimeClaim = selectBackupRuntimeCredentialClaim({
      owner,
      runtime,
      roleMap,
      ownership,
    });
  }
  const secrets = await readSandboxSecrets(root, secretEnv, config);
  const scopedCredential = runtimeClaim
    ? secretValueAt(secrets, runtimeClaim.secretRef)
    : null;
  const password = runtimeClaim
    ? scopedCredential?.password
    : secretValueAt(secrets, "bootstrap.postgresAdminPassword");
  if (typeof password !== "string" || !password)
    fail("CONFIG-BACKUP-SECRET", "G17 bootstrap credential is unavailable");
  return { username: runtimeClaim?.username ?? "postgres", password };
}

export function isBackupSocketHost(host) {
  return typeof host === "string" && BACKUP_SOCKET_HOST.test(host);
}

export function validateBackupServerIdentity(
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
      [...BACKUP_SERVER_IDENTITY_KEYS].sort().join(",") ||
    value.schemaVersion !== 1 ||
    value.runId !== context?.runId ||
    value.candidateSha !== context?.candidateSha ||
    value.host !== config?.postgres?.host ||
    value.port !== config?.postgres?.port ||
    value.version !== "17.11" ||
    config.environment === "production" ||
    config.verification?.databaseIsolation?.enabled !== true ||
    (value.host !== "coffee_postgres" && !isBackupSocketHost(value.host)) ||
    !/^[0-9]+$/u.test(value.systemIdentifier ?? "") ||
    (expectedSystemIdentifier !== undefined &&
      value.systemIdentifier !== expectedSystemIdentifier)
  )
    fail(
      "CONFIG-BACKUP-SERVER-IDENTITY",
      "G00 server identity does not match the exact G17 target",
    );
  return {
    host: value.host,
    port: value.port,
    systemIdentifier: value.systemIdentifier,
  };
}

export function validateBackupSocketDirectoryMetadata(
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

export async function validateBackupSocketDirectory(host) {
  if (!isBackupSocketHost(host))
    fail("CONFIG-BACKUP-SOCKET-PATH", "G17 Unix socket path is invalid");
  let current = "/";
  for (const part of host.slice(1).split("/")) {
    current = join(current, part);
    const info = await lstat(current).catch(() => null);
    if (!info || info.isSymbolicLink())
      fail(
        "CONFIG-BACKUP-SOCKET-PATH",
        "G17 Unix socket path is missing or contains a symlink",
      );
    if (current !== host && !info.isDirectory())
      fail(
        "CONFIG-BACKUP-SOCKET-PATH",
        "G17 Unix socket parent is not a directory",
      );
  }
  const info = await lstat(host);
  if (
    !validateBackupSocketDirectoryMetadata(info, process.getuid()) ||
    (await realpath(host)) !== host
  )
    fail(
      "CONFIG-BACKUP-SOCKET-OWNER",
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
        "CONFIG-BACKUP-PATH",
        "G17 evidence path is missing or contains a symlink",
      );
  }
  if ((await realpath(absolute)) !== absolute)
    fail("CONFIG-BACKUP-PATH", "G17 evidence path is not canonical");
}

/** Bind G17 bootstrap to the validated run, exact YAML bytes, and G00 server identity. */
export async function validateBackupTarget({
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
    fail("CONFIG-BACKUP-CONTEXT", "G17 launch context locator is required");
  await assertNoSymlinkPath(contextPath);
  const contextInfo = await lstat(contextPath);
  if (
    !contextInfo.isFile() ||
    contextInfo.uid !== process.getuid() ||
    (contextInfo.mode & 0o777) !== 0o400
  )
    fail(
      "CONFIG-BACKUP-CONTEXT",
      "G17 launch context must be a readonly owner-only regular file",
    );
  let validated;
  try {
    const { validateLaunchContext } =
      await import("../../verification/launch/v1/report.mjs");
    validated = await validateLaunchContext(contextPath);
  } catch {
    fail("CONFIG-BACKUP-CONTEXT", "G17 launch context is invalid");
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
    fail("CONFIG-BACKUP-CONTEXT", "G17 launch context changed during validation");
  if (
    candidateRoot !== resolve(root) ||
    (runId !== undefined && context.runId !== runId) ||
    (candidateSha !== undefined && context.candidateSha !== candidateSha) ||
    !/^[0-9a-f]{64}$/u.test(context.baseConfigSha256 ?? "")
  )
    fail(
      "CONFIG-BACKUP-CONTEXT",
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
      "CONFIG-BACKUP-CONFIG",
      "G17 config file is not a canonical regular file",
    );
  const configBytes = await readFile(configPath);
  if (
    createHash("sha256").update(configBytes).digest("hex") !==
    context.baseConfigSha256
  )
    fail(
      "CONFIG-BACKUP-CONFIG",
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
    fail("CONFIG-BACKUP-CONFIG", "G17 config changed during validation");
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
      "CONFIG-BACKUP-CONFIG",
      "G17 target differs from the isolated non-production config",
    );
  if (isBackupSocketHost(targetHost))
    await validateBackupSocketDirectory(targetHost);
  else if (targetHost !== "coffee_postgres")
    fail(
      "CONFIG-BACKUP-TARGET",
      "G17 endpoint is neither canonical nor the approved private socket",
    );

  const identityPath = join(
    evidenceDir,
    "gates/preflight/artifacts/postgres-server-identity.json",
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
      "CONFIG-BACKUP-SERVER-IDENTITY",
      "G00 server identity artifact is not a private regular file",
    );
  let identity;
  try {
    identity = JSON.parse(await readFile(identityPath, "utf8"));
  } catch {
    fail(
      "CONFIG-BACKUP-SERVER-IDENTITY",
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
      "CONFIG-BACKUP-SERVER-IDENTITY",
      "G00 server identity changed during validation",
    );
  const target = validateBackupServerIdentity(
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
  const renewDevelopmentTransport = process.argv.includes(
    "--renew-development-transport",
  );
  const prepareDevelopmentRuntime = process.argv.includes(
    "--prepare-development-runtime",
  );
  const dockerHubAuthIndex = process.argv.indexOf("--import-docker-hub-auth");
  const dockerHubAuthFile =
    dockerHubAuthIndex >= 0 ? process.argv[dockerHubAuthIndex + 1] : undefined;
  const provisionPublicAuthority = process.argv.includes(
    "--provision-public-authority",
  );
  try {
    if (
      dockerHubAuthIndex >= 0 &&
      (!prepareDevelopmentRuntime ||
        !dockerHubAuthFile ||
        dockerHubAuthFile.startsWith("--"))
    )
      fail(
        "CONFIG-REGISTRY-AUTH",
        "registry import requires development preparation and an input file",
      );
    if (provisionPublicAuthority && !prepareDevelopmentRuntime)
      fail(
        "CONFIG-DEVELOPMENT-CA",
        "public CA provisioning requires development preparation",
      );
    if (
      renewDevelopmentTransport &&
      (runtimeIndex >= 0 || prepareDevelopmentRuntime)
    ) {
      fail(
        "CONFIG-DEVELOPMENT-TRANSPORT",
        "renewal and other operations are separate",
      );
    } else if (renewDevelopmentTransport) {
      console.log(
        JSON.stringify(await renewDevelopmentTransportSecrets({ root })),
      );
    } else if (prepareDevelopmentRuntime && runtimeIndex >= 0) {
      fail(
        "CONFIG-DEVELOPMENT-SECRET",
        "preparation and runtime are separate operations",
      );
    } else if (prepareDevelopmentRuntime) {
      console.log(
        JSON.stringify(
          await prepareDevelopmentRuntimeSecrets({
            root,
            provisionPublicAuthority,
            dockerHubAuthFile,
          }),
        ),
      );
    } else if (!runtime) {
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
