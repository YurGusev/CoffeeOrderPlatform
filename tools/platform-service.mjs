#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomUUID,
  X509Certificate,
} from "node:crypto";
import { closeSync, existsSync, openSync } from "node:fs";
import { request } from "node:https";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRuntimeLoggingOverride } from "./observability/generate.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROJECT = "coffee-platform";
const DOCKER_COMMAND_TIMEOUT_MS = 120_000;
const TELEMETRY_UNIT_QUERY_TIMEOUT_MS = 10_000;
const STOP_METADATA_TIMEOUT_MS = 10_000;
const STOP_COMMAND_OVERHEAD_MS = 5_000;
const OBSERVABILITY = [
  "grafana",
  "loki",
  "prometheus",
  "tempo",
  "otel-collector",
  "alert-sink",
];

export function isLocalRuntimeReady(entry) {
  return (
    entry.status === "running" &&
    (entry.health === "healthy" ||
      (entry.service === "alert-sink" && entry.health === "none"))
  );
}

/** User unit starts the exact accepted release after observability provisioning. */
export function renderLocalRuntimeUnit({
  root,
  nodePath,
  pnpmPath,
  flockPath,
  lockPath,
  contextFile,
  expectedServerIdentity,
  releaseId,
  ageKeyFile,
  ownedServiceCount,
  shutdownGraceMs,
}) {
  if (
    [
      root,
      nodePath,
      pnpmPath,
      flockPath,
      lockPath,
      contextFile,
      ageKeyFile,
    ].some(
      (value) =>
        typeof value !== "string" ||
        resolve(value) !== value ||
        /[\r\n\0]/u.test(value),
    ) ||
    !/^\d{10,30}$/u.test(expectedServerIdentity) ||
    !Number.isSafeInteger(ownedServiceCount) ||
    ownedServiceCount < 1 ||
    !Number.isSafeInteger(shutdownGraceMs) ||
    shutdownGraceMs < 1 ||
    !/^[a-f0-9]{40}-[a-f0-9]{16}-[a-f0-9]{12}$/u.test(releaseId)
  )
    throw new Error("local unit release locators are invalid");
  const quote = (value) =>
    `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;
  const service = join(root, "tools/platform-service.mjs");
  const stopTimeoutMs =
    2 * STOP_METADATA_TIMEOUT_MS +
    ownedServiceCount *
      (Math.ceil(shutdownGraceMs / 1000) * 1000 + STOP_COMMAND_OVERHEAD_MS) +
    STOP_METADATA_TIMEOUT_MS;
  if (!Number.isSafeInteger(stopTimeoutMs))
    throw new Error("local unit stop timeout is invalid");
  return [
    "[Unit]",
    "Description=Coffee platform local runtime",
    "Wants=coffee-observability.service",
    "After=coffee-observability.service",
    "StartLimitIntervalSec=300",
    "StartLimitBurst=6",
    "",
    "[Service]",
    "Type=oneshot",
    "RemainAfterExit=yes",
    "Restart=no",
    `WorkingDirectory=${quote(root)}`,
    `Environment=${quote(`PATH=${dirname(nodePath)}:${dirname(pnpmPath)}:/usr/bin:/bin`)}`,
    `Environment=${quote(`COFFEE_LAUNCH_CONTEXT_FILE=${contextFile}`)}`,
    `Environment=${quote(`COFFEE_DB_EXPECTED_SERVER_IDENTITY=${expectedServerIdentity}`)}`,
    `Environment=${quote(`COFFEE_LOCAL_RELEASE_ID=${releaseId}`)}`,
    `Environment=${quote(`SOPS_AGE_KEY_FILE=${ageKeyFile}`)}`,
    `ExecStart=${quote(flockPath)} --no-fork --timeout=7200 ${quote(lockPath)} ${quote(nodePath)} ${quote(service)} start`,
    `ExecReload=${quote(flockPath)} --no-fork --timeout=7200 ${quote(lockPath)} ${quote(nodePath)} ${quote(service)} maintain-certificates`,
    `ExecStopPost=${quote(nodePath)} ${quote(service)} stop`,
    `TimeoutStopSec=${Math.ceil(stopTimeoutMs / 1000)}`,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

export function renderLocalCertificateMaintenanceUnits(options) {
  const intervalHours = options.certificateRenewBeforeHours / 2;
  if (
    !Number.isInteger(intervalHours) ||
    intervalHours < 1 ||
    24 % intervalHours !== 0
  )
    throw new Error("certificate maintenance interval is invalid");
  const runtimeUnit = renderLocalRuntimeUnit(options);
  const environment = runtimeUnit
    .split("\n")
    .filter((line) => /^(?:WorkingDirectory|Environment)=/u.test(line));
  const quote = (value) =>
    `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;
  return {
    service: [
      "[Unit]",
      "Description=Coffee platform certificate maintenance",
      "After=coffee-platform.service",
      "",
      "[Service]",
      "Type=oneshot",
      ...environment,
      "ExecCondition=/usr/bin/systemctl --user is-active --quiet coffee-platform.service",
      `ExecStart=${quote(options.nodePath)} ${quote(join(options.root, "tools/platform-service.mjs"))} dispatch-maintenance`,
      "",
    ].join("\n"),
    timer: [
      "[Unit]",
      "Description=Coffee platform certificate maintenance schedule",
      "",
      "[Timer]",
      `OnCalendar=*-*-* 00/${intervalHours}:00:00 UTC`,
      "Persistent=true",
      "OnClockChange=true",
      "AccuracySec=1min",
      "Unit=coffee-platform-certificates.service",
      "",
      "[Install]",
      "WantedBy=timers.target",
      "",
    ].join("\n"),
  };
}

export async function identityState({
  identity,
  bootstrap,
  directory = join(homedir(), "coffee-platform/runtime/state"),
}) {
  await bootstrap.ensurePrivateSecretDirectory(directory);
  const path = join(directory, "identity.json");
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return { path, stage: "pending" };
    throw error;
  }
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid() ||
    (info.mode & 0o777) !== 0o600
  )
    throw new Error(
      "RECOVERY_REQUIRED: identity retirement receipt is invalid",
    );
  let state;
  try {
    state = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error(
      "RECOVERY_REQUIRED: identity retirement receipt is invalid",
    );
  }
  if (
    state.postgresSystemIdentifier !== identity.postgresSystemIdentifier ||
    state.databaseName !== identity.databaseName ||
    state.databaseRole !== identity.databaseRole ||
    state.realm !== identity.realm ||
    !/^[0-9]+$/u.test(state.databaseOid ?? "") ||
    !/^[a-f0-9]{64}$/u.test(state.signingKeySha256 ?? "") ||
    !["retiring", "retired"].includes(state.stage)
  )
    throw new Error(
      "RECOVERY_REQUIRED: identity retirement receipt is invalid",
    );
  if (state.stage === "retiring")
    throw new Error("RECOVERY_REQUIRED: identity retirement was interrupted");
  return {
    path,
    stage: state.stage,
    databaseOid: state.databaseOid,
    signingKeySha256: state.signingKeySha256,
  };
}

export function identitySigningKeysHash(jwks) {
  if (!Array.isArray(jwks?.keys))
    throw new Error("RECOVERY_REQUIRED: identity signing keys are invalid");
  let keys;
  try {
    keys = jwks.keys
      .filter(
        (key) => key.kty === "RSA" && key.use === "sig" && key.alg === "RS256",
      )
      .map((key) => {
        createPublicKey({
          key: { kty: key.kty, n: key.n, e: key.e },
          format: "jwk",
        });
        return createHash("sha256")
          .update(JSON.stringify({ e: key.e, kty: "RSA", n: key.n }))
          .digest("hex");
      });
  } catch {
    throw new Error("RECOVERY_REQUIRED: identity signing keys are invalid");
  }
  if (keys.length === 0)
    throw new Error("RECOVERY_REQUIRED: identity signing keys are missing");
  const canonical = [...new Set(keys)].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

async function identityRequest({
  base,
  ca,
  timeoutMs,
  maxBytes,
  path,
  method = "GET",
  token,
  body,
  expected = 200,
}) {
  return new Promise((resolveCall, reject) => {
    const req = request(
      new URL(path, base),
      {
        method,
        ca,
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body
            ? { "content-type": "application/x-www-form-urlencoded" }
            : {}),
        },
      },
      (res) => {
        const parts = [];
        let size = 0;
        res.on("data", (part) => {
          size += part.length;
          if (size > maxBytes) req.destroy();
          else parts.push(part);
        });
        res.on("end", () => {
          if (res.statusCode !== expected)
            return reject(
              new Error("RECOVERY_REQUIRED: identity API rejected request"),
            );
          try {
            resolveCall(
              parts.length
                ? JSON.parse(Buffer.concat(parts).toString("utf8"))
                : undefined,
            );
          } catch {
            reject(
              new Error("RECOVERY_REQUIRED: identity API response is invalid"),
            );
          }
        });
      },
    );
    req.on("error", () =>
      reject(new Error("RECOVERY_REQUIRED: identity HTTPS request failed")),
    );
    if (body) req.write(body);
    req.end();
  });
}

/** Compose uses the existing product services and binds only verified images. */
export function createLocalComposeOverride({
  config,
  runtimes,
  runtimeImages,
  kafkaImageId,
  keycloakImageId,
  configPath,
  secretsDir,
  steadyIdentity = false,
}) {
  const imageId = /^sha256:[a-f0-9]{64}$/u;
  if (
    !Number.isInteger(config.platform.localRestartMaxAttempts) ||
    config.platform.localRestartMaxAttempts < 1 ||
    config.platform.localRestartMaxAttempts > 10
  )
    throw new Error("local container restart policy is invalid");
  const restart = `on-failure:${config.platform.localRestartMaxAttempts}`;
  const expected = [...runtimes, "edge-nginx"];
  const images = new Map(
    runtimeImages.map((entry) => [entry.service, entry.imageId]),
  );
  if (
    images.size !== expected.length ||
    runtimeImages.length !== expected.length ||
    !runtimes.includes("edge-gateway") ||
    expected.some((service) => !imageId.test(images.get(service) ?? "")) ||
    !imageId.test(kafkaImageId) ||
    !imageId.test(keycloakImageId) ||
    resolve(configPath) !== configPath ||
    resolve(secretsDir) !== secretsDir ||
    !secretsDir.startsWith("/dev/shm/")
  )
    throw new Error("local release image or path binding is invalid");
  const services = Object.fromEntries(
    runtimes.map((service) => [
      service,
      {
        image: images.get(service),
        pull_policy: "never",
        restart,
        volumes: [
          {
            type: "bind",
            source: configPath,
            target: "/app/config/platform.yaml",
            read_only: true,
          },
        ],
      },
    ]),
  );
  services["edge-gateway"].environment = {
    NODE_EXTRA_CA_CERTS: "/run/identity-ca/ca.crt",
  };
  services["edge-gateway"].volumes.push({
    type: "bind",
    source: join(secretsDir, "keycloak/ca.crt"),
    target: "/run/identity-ca/ca.crt",
    read_only: true,
  });
  services["edge-nginx"] = {
    image: images.get("edge-nginx"),
    pull_policy: "never",
    restart,
  };
  services.kafka = { image: kafkaImageId, pull_policy: "never", restart };
  const identity = config.localIdentity;
  const publicPort = new URL(identity.publicBaseUrl).port;
  const privatePort = new URL(identity.privateBaseUrl).port;
  const cacheName = `keycloak-cache-${keycloakImageId.slice(7, 19)}`;
  services.keycloak = {
    image: keycloakImageId,
    pull_policy: "never",
    init: true,
    restart,
    read_only: true,
    security_opt: ["no-new-privileges:true"],
    cap_drop: ["ALL"],
    mem_limit: `${identity.memoryLimitMiB}m`,
    tmpfs: [
      "/tmp:rw,noexec,nosuid,nodev",
      "/opt/keycloak/data:rw,noexec,nosuid,nodev,uid=1000,gid=0,mode=0700",
    ],
    command: [
      "--config-file=/run/keycloak/keycloak.conf",
      "start",
      ...(steadyIdentity ? [] : ["--import-realm"]),
    ],
    environment: {
      KC_DB: "postgres",
      KC_DB_URL_HOST: config.postgres.host,
      KC_DB_URL_PORT: String(config.postgres.port),
      KC_DB_URL_DATABASE: identity.databaseName,
      KC_DB_USERNAME: identity.databaseRole,
      KC_DB_POOL_INITIAL_SIZE: String(identity.databasePoolMax),
      KC_DB_POOL_MIN_SIZE: String(identity.databasePoolMax),
      KC_DB_POOL_MAX_SIZE: String(identity.databasePoolMax),
      KC_HOSTNAME: identity.publicBaseUrl,
      KC_HOSTNAME_BACKCHANNEL_DYNAMIC: "true",
      KC_HTTPS_PORT: privatePort,
      KC_HTTPS_CERTIFICATE_FILE: "/run/keycloak/tls.crt",
      KC_HTTPS_CERTIFICATE_KEY_FILE: "/run/keycloak/tls.key",
      ...(steadyIdentity
        ? {}
        : { KC_BOOTSTRAP_ADMIN_USERNAME: identity.bootstrapAdminUsername }),
      KC_HEALTH_ENABLED: "true",
      KC_METRICS_ENABLED: "true",
      KC_HTTP_MANAGEMENT_SCHEME: "http",
      KC_HTTP_MANAGEMENT_HOST: "127.0.0.1",
    },
    ports: [`127.0.0.1:${publicPort}:${privatePort}`],
    networks: [
      "coffee_host_ingress",
      "coffee_edge_backend",
      "coffee_postgres_data",
    ],
    volumes: [
      {
        type: "bind",
        source: join(secretsDir, "keycloak"),
        target: "/run/keycloak",
        read_only: true,
      },
      ...(!steadyIdentity
        ? [
            {
              type: "bind",
              source: join(secretsDir, "keycloak-import"),
              target: "/opt/keycloak/data/import",
              read_only: true,
            },
          ]
        : []),
      {
        type: "volume",
        source: cacheName,
        target: "/opt/keycloak/lib/quarkus",
      },
    ],
    healthcheck: {
      test: [
        "CMD",
        "wget",
        "-q",
        "--spider",
        "http://127.0.0.1:9000/health/ready",
      ],
      interval: `${config.platform.health.intervalMs}ms`,
      timeout: `${config.platform.health.timeoutMs}ms`,
      start_period: `${config.platform.health.startupGraceMs}ms`,
      retries: config.platform.health.failureThreshold,
    },
  };
  const logging = createRuntimeLoggingOverride({ config }).services.kafka
    .logging;
  for (const service of Object.values(services)) service.logging = logging;
  return {
    services,
    volumes: {
      [cacheName]: {
        labels: {
          "coffee.owner": "operations",
          "coffee.lifecycle": "persistent",
        },
      },
    },
  };
}

/** Capture assets only from the verified nginx image and remove our temporary container. */
export async function captureLocalFrontend({
  root,
  releaseDir,
  nginxImageId,
  run,
}) {
  const name = `coffee-local-assets-${randomUUID().replaceAll("-", "")}`;
  const id = run([
    "create",
    "--pull",
    "never",
    "--name",
    name,
    "--network",
    "none",
    "--read-only",
    "--label",
    "coffee.owner=operations",
    "--label",
    "coffee.lifecycle=temporary",
    "--entrypoint",
    "/bin/true",
    nginxImageId,
  ]).trim();
  let owned = false;
  try {
    const rows = JSON.parse(run(["inspect", id]));
    if (
      !/^[a-f0-9]{64}$/u.test(id) ||
      rows.length !== 1 ||
      rows[0].Id !== id ||
      rows[0].Image !== nginxImageId ||
      rows[0].Config?.Labels?.["coffee.owner"] !== "operations" ||
      rows[0].Config?.Labels?.["coffee.lifecycle"] !== "temporary"
    )
      throw new Error(
        "RECOVERY_REQUIRED: asset container ownership is unknown",
      );
    owned = true;
    run(["cp", `${id}:/etc/nginx/nginx.conf`, join(releaseDir, "nginx.conf")]);
    const assetFile = join(releaseDir, "browser-assets.tar");
    const fd = openSync(assetFile, "wx", 0o600);
    try {
      execFileSync("docker", ["cp", `${id}:/usr/share/nginx/html`, "-"], {
        cwd: root,
        stdio: ["ignore", fd, "pipe"],
        timeout: 120_000,
      });
    } finally {
      closeSync(fd);
    }
    await chmod(join(releaseDir, "nginx.conf"), 0o400);
    await chmod(assetFile, 0o400);
    return {
      nginxSha256: createHash("sha256")
        .update(await readFile(join(releaseDir, "nginx.conf")))
        .digest("hex"),
      browserAssetsSha256: createHash("sha256")
        .update(await readFile(assetFile))
        .digest("hex"),
    };
  } finally {
    if (owned) run(["rm", id]);
  }
}

/** Remove only the incomplete bundle and scoped secrets created before database work. */
export async function prepareLocalRelease({
  releaseDir,
  secretsDir,
  existingRelease,
  prepare,
}) {
  const createdReleaseInfo = existingRelease
    ? undefined
    : await lstat(releaseDir);
  let createdSecretsInfo;
  let preDatabase = true;
  try {
    return await prepare({
      secretsCreated: async () => {
        createdSecretsInfo = await lstat(secretsDir);
      },
      beforeDatabase: () => {
        preDatabase = false;
      },
    });
  } catch (error) {
    if (!existingRelease && preDatabase) {
      try {
        if (createdSecretsInfo) {
          const current = await lstat(secretsDir);
          if (
            !current.isDirectory() ||
            current.isSymbolicLink() ||
            current.uid !== process.getuid() ||
            current.dev !== createdSecretsInfo.dev ||
            current.ino !== createdSecretsInfo.ino
          )
            throw new Error(
              "RECOVERY_REQUIRED: temporary secret directory changed",
            );
          await rm(secretsDir, { recursive: true });
        }
        const current = await lstat(releaseDir);
        if (
          !current.isDirectory() ||
          current.isSymbolicLink() ||
          current.uid !== process.getuid() ||
          current.dev !== createdReleaseInfo.dev ||
          current.ino !== createdReleaseInfo.ino
        )
          throw new Error("RECOVERY_REQUIRED: new release directory changed");
        await chmod(releaseDir, 0o700);
        await rm(releaseDir, { recursive: true });
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "RECOVERY_REQUIRED: failed to remove incomplete local release",
        );
      }
    }
    throw error;
  }
}

/** Start the exact scanned source release; persistent storage is never removed. */
export async function startLocalRuntime({
  root = ROOT,
  env = process.env,
} = {}) {
  const contextFile = env.COFFEE_LAUNCH_CONTEXT_FILE;
  const expectedServerIdentity = env.COFFEE_DB_EXPECTED_SERVER_IDENTITY;
  if (!contextFile || !/^\d{10,30}$/u.test(expectedServerIdentity ?? ""))
    throw new Error(
      "launch context and approved PostgreSQL identity are required",
    );
  const run = (args) =>
    execFileSync("docker", args, {
      cwd: root,
      encoding: "utf8",
      timeout: 120_000,
    });
  const git = (args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      timeout: 30_000,
    }).trim();
  if (git(["status", "--porcelain", "--untracked-files=all"]))
    throw new Error("source checkout must be clean before starting a release");
  const refs = JSON.parse(
    await readFile(join(root, "config/toolchain-versions.json"), "utf8"),
  );
  if (process.versions.node !== refs.node)
    throw new Error("Node version differs from the pinned toolchain");
  if (!existsSync(join(root, "node_modules")))
    execFileSync(
      "pnpm",
      ["install", "--offline", "--frozen-lockfile", "--ignore-scripts"],
      { cwd: root, stdio: "inherit" },
    );
  // The existing Compose and migration helpers use compiled controller modules.
  execFileSync("pnpm", ["exec", "tsc", "-b", "--pretty", "false"], {
    cwd: root,
    stdio: "inherit",
  });
  const { validateLaunchContext } =
    await import("../verification/launch/v1/report.mjs");
  const {
    readVerifiedRuntimeImages,
    loadVerifiedGateImage,
    inspectDockerImage,
  } = await import("./verified-infrastructure-image.mjs");
  const { loadPlatformConfig } = await import("../scripts/config-lib.mjs");
  const bootstrap = await import("./config-bootstrap/index.mjs");
  const smoke = await import("./compose-smoke.mjs");
  const active = await validateLaunchContext(contextFile);
  if (
    active.candidateRoot !== root ||
    active.context.candidateSha !== git(["rev-parse", "HEAD"])
  )
    throw new Error("launch context does not bind the current source checkout");
  const sourceConfig = await loadPlatformConfig(root);
  const projected = bootstrap.projectLocalRuntimeConfig(sourceConfig);
  const runtimeImages = await readVerifiedRuntimeImages({ contextFile });
  const kafkaProof = await loadVerifiedGateImage({
    target: "kafka",
    contextFile,
    loadImage: false,
  });
  const keycloakProof = await loadVerifiedGateImage({
    target: "keycloak",
    contextFile,
    loadImage: false,
  });
  const before = await inspectLocalRuntime({ root });
  if (
    before
      .filter((entry) => OBSERVABILITY.includes(entry.service))
      .some((entry) => !isLocalRuntimeReady(entry))
  )
    throw new Error("RECOVERY_REQUIRED: observability is not ready");
  const inspectOptional = (type, name) => {
    try {
      const rows = JSON.parse(run([type, "inspect", name]));
      if (!Array.isArray(rows) || rows.length !== 1 || rows[0]?.Name !== name)
        throw new Error("invalid inspection response");
      return rows[0];
    } catch (error) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      const missing = new RegExp(
        `(?:^|\\n)(?:(?:Error response from daemon: )|(?:Error: ))?No such ${type}: ${escaped}$`,
        "u",
      );
      if (error.status === 1 && missing.test(String(error.message).trim()))
        return undefined;
      throw new Error(
        `RECOVERY_REQUIRED: ${type} ${name} cannot be safely inspected`,
      );
    }
  };
  for (const [name, internal] of Object.entries({
    coffee_host_ingress: false,
    coffee_edge_backend: true,
    coffee_public_api_backend: true,
    coffee_internal_api: true,
    coffee_kafka_event: true,
    coffee_provider_egress: false,
  })) {
    const network = inspectOptional("network", name);
    if (
      network &&
      (network.Driver !== "bridge" ||
        network.Internal !== internal ||
        network.Labels?.["com.docker.compose.project"] !== PROJECT ||
        network.Labels["com.docker.compose.network"] !== name)
    )
      throw new Error(`RECOVERY_REQUIRED: network ${name} is foreign`);
  }
  const postgresNetwork = inspectOptional("network", "coffee_postgres_data");
  if (
    !postgresNetwork ||
    postgresNetwork.Driver !== "bridge" ||
    Object.values(postgresNetwork.Containers ?? {}).filter(
      (entry) => entry.Name === "coffee_postgres",
    ).length !== 1
  )
    throw new Error(
      "RECOVERY_REQUIRED: approved PostgreSQL network is unavailable",
    );
  const cacheName = `keycloak-cache-${keycloakProof.imageId.slice(7, 19)}`;
  for (const [volumeName, logicalName, service] of [
    [`${PROJECT}_kafka_data`, "kafka_data", "kafka"],
    [`${PROJECT}_${cacheName}`, cacheName, "keycloak"],
  ]) {
    const volume = inspectOptional("volume", volumeName);
    if (!volume) continue;
    if (
      volume.Driver !== "local" ||
      Object.keys(volume.Options ?? {}).length ||
      volume.Labels?.["com.docker.compose.project"] !== PROJECT ||
      volume.Labels["com.docker.compose.volume"] !== logicalName ||
      (service === "keycloak" &&
        (volume.Labels["coffee.owner"] !== "operations" ||
          volume.Labels["coffee.lifecycle"] !== "persistent"))
    )
      throw new Error(`RECOVERY_REQUIRED: volume ${volumeName} is foreign`);
    const references = run([
      "ps",
      "--all",
      "--quiet",
      "--no-trunc",
      "--filter",
      `volume=${volumeName}`,
    ])
      .trim()
      .split(/\s+/u)
      .filter(Boolean);
    const owner = before.find(
      (entry) => entry.service === service,
    )?.containerId;
    if (references.some((id) => !/^[a-f0-9]{64}$/u.test(id) || id !== owner))
      throw new Error(
        `RECOVERY_REQUIRED: volume ${volumeName} has foreign consumers`,
      );
  }
  const catalog = JSON.parse(
    await readFile(join(root, "config/service-catalog.json"), "utf8"),
  );
  const runtimes = catalog.runtimes
    .map((entry) => entry.name)
    .filter((name) => name !== "edge-nginx");
  const missing = [];
  for (const image of runtimeImages) {
    const actual = inspectDockerImage(run, image.imageId);
    if (!actual) missing.push(image.service);
    else if (actual.imageId !== image.imageId)
      throw new Error("image ID mismatch");
  }
  const builtImages = [];
  if (missing.length) {
    const temporary = await mkdtemp(join(tmpdir(), "coffee-local-build-"));
    try {
      const { createBuildInputSnapshot, verifyBuildInputSnapshot } =
        await import("./security-scan.mjs");
      const snapshot = await createBuildInputSnapshot({
        candidateRoot: root,
        candidateSha: active.context.candidateSha,
        temporary,
      });
      await verifyBuildInputSnapshot(snapshot);
      const project = `coffee-local-build-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
      smoke.buildRuntimeImages(
        project,
        missing.filter((service) => service !== "edge-nginx"),
        builtImages,
        snapshot.contextPath,
        { includeNginx: missing.includes("edge-nginx") },
      );
      await verifyBuildInputSnapshot(snapshot);
      for (const service of missing) {
        const expected = runtimeImages.find(
          (entry) => entry.service === service,
        ).imageId;
        if (
          run([
            "image",
            "inspect",
            "--format",
            "{{.Id}}",
            `${project}-${service}:latest`,
          ]).trim() !== expected
        )
          throw new Error(
            `${service}: rebuilt image differs from the scanned ID`,
          );
      }
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
  const kafka = await loadVerifiedGateImage({
    target: "kafka",
    contextFile,
    loadImage: true,
  });
  if (kafka.imageId !== kafkaProof.imageId)
    throw new Error("Kafka image binding changed");
  const keycloak = await loadVerifiedGateImage({
    target: "keycloak",
    contextFile,
    loadImage: true,
  });
  if (keycloak.imageId !== keycloakProof.imageId)
    throw new Error("Keycloak image binding changed");
  const { dump } = await import("js-yaml");
  const configBytes = Buffer.from(dump(projected));
  const configSha256 = createHash("sha256").update(configBytes).digest("hex");
  const encryptedSecretsSha256 = createHash("sha256")
    .update(await readFile(join(root, "secrets/platform.secrets.sops.yaml")))
    .digest("hex");
  const releaseId = `${active.context.candidateSha}-${configSha256.slice(0, 16)}-${encryptedSecretsSha256.slice(0, 12)}`;
  if (env.COFFEE_LOCAL_RELEASE_ID && env.COFFEE_LOCAL_RELEASE_ID !== releaseId)
    throw new Error(
      "RECOVERY_REQUIRED: requested local release differs from the approved unit",
    );
  const releaseParent = join(homedir(), "coffee-platform/runtime/releases");
  await bootstrap.ensurePrivateSecretDirectory(releaseParent);
  const releaseDir = join(releaseParent, releaseId);
  const configPath = join(releaseDir, "platform.yaml");
  const secretsDir = join("/dev/shm", `coffee-platform-local-${releaseId}`);
  const identity = {
    sourceSha: active.context.candidateSha,
    configSha256,
    encryptedSecretsSha256,
    runtimeImages,
    kafkaImageId: kafka.imageId,
    keycloakImageId: keycloak.imageId,
  };
  const identityBinding = {
    postgresSystemIdentifier: expectedServerIdentity,
    databaseName: projected.localIdentity.databaseName,
    databaseRole: projected.localIdentity.databaseRole,
    realm: projected.localIdentity.realm,
  };
  const retirement = await identityState({
    identity: identityBinding,
    bootstrap,
  });
  const overrideOptions = {
    config: projected,
    runtimes,
    runtimeImages,
    kafkaImageId: kafka.imageId,
    keycloakImageId: keycloak.imageId,
    configPath,
    secretsDir,
  };
  const overridePath = join(releaseDir, "compose.json");
  const steadyOverridePath = join(releaseDir, "compose-steady.json");
  const overrideBytes = JSON.stringify(
    createLocalComposeOverride(overrideOptions),
  );
  const steadyOverrideBytes = JSON.stringify(
    createLocalComposeOverride({ ...overrideOptions, steadyIdentity: true }),
  );
  let existingRelease = false;
  try {
    await mkdir(releaseDir, { mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    existingRelease = true;
    const info = await lstat(releaseDir);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.uid !== process.getuid() ||
      (info.mode & 0o777) !== 0o500
    )
      throw new Error(
        "RECOVERY_REQUIRED: release directory ownership is unknown",
      );
    const prior = JSON.parse(
      await readFile(join(releaseDir, "release.json"), "utf8"),
    );
    const { certificates, artifacts, ...priorIdentity } = prior;
    if (
      JSON.stringify(priorIdentity) !== JSON.stringify(identity) ||
      !(await readFile(configPath)).equals(configBytes) ||
      !certificates ||
      !artifacts ||
      (await readFile(overridePath, "utf8")) !== overrideBytes ||
      (await readFile(steadyOverridePath, "utf8")) !== steadyOverrideBytes ||
      createHash("sha256").update(overrideBytes).digest("hex") !==
        artifacts.composeSha256 ||
      createHash("sha256").update(steadyOverrideBytes).digest("hex") !==
        artifacts.steadyComposeSha256 ||
      createHash("sha256")
        .update(await readFile(join(releaseDir, "nginx.conf")))
        .digest("hex") !== artifacts.nginxSha256 ||
      createHash("sha256")
        .update(await readFile(join(releaseDir, "browser-assets.tar")))
        .digest("hex") !== artifacts.browserAssetsSha256
    )
      throw new Error("RECOVERY_REQUIRED: release identity differs");
  }
  return prepareLocalRelease({
    releaseDir,
    secretsDir,
    existingRelease,
    prepare: async ({ secretsCreated, beforeDatabase }) => {
      const own = before.filter(
        (entry) => !OBSERVABILITY.includes(entry.service),
      );
      const expectedImages = new Map(
        runtimeImages.map((entry) => [entry.service, entry.imageId]),
      );
      expectedImages.set("kafka", kafka.imageId);
      expectedImages.set("keycloak", keycloak.imageId);
      if (
        own.some(
          (entry) =>
            entry.status !== "missing" &&
            entry.imageId !== expectedImages.get(entry.service),
        )
      )
        throw new Error("RECOVERY_REQUIRED: an existing runtime image differs");
      if (
        existingRelease &&
        own.every(
          (entry) =>
            entry.status === "running" &&
            entry.health === "healthy" &&
            entry.imageId === expectedImages.get(entry.service),
        ) &&
        before
          .filter((entry) => OBSERVABILITY.includes(entry.service))
          .every(isLocalRuntimeReady)
      )
        return {
          releaseDir,
          sourceSha: identity.sourceSha,
          configSha256,
          state:
            retirement.stage === "retired"
              ? "awaiting-owner-relogin"
              : "active-awaiting-operator-confirmation",
        };
      if (
        own.some(
          (entry) =>
            entry.status === "running" || entry.status === "restarting",
        )
      )
        throw new Error(
          "RECOVERY_REQUIRED: an incomplete local runtime is still running",
        );
      if (!existingRelease)
        await writeFile(configPath, configBytes, { flag: "wx", mode: 0o400 });
      let priorSecrets;
      try {
        priorSecrets = await lstat(secretsDir);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (priorSecrets) {
        const marker = await readFile(
          join(secretsDir, "owner.json"),
          "utf8",
        ).catch(() => "");
        if (
          !priorSecrets.isDirectory() ||
          priorSecrets.isSymbolicLink() ||
          priorSecrets.uid !== process.getuid() ||
          marker !== `${releaseId}\n`
        )
          throw new Error(
            "RECOVERY_REQUIRED: temporary secret ownership is unknown",
          );
        await rm(secretsDir, { recursive: true });
      }
      await mkdir(secretsDir, { mode: 0o700 });
      await secretsCreated();
      await writeFile(join(secretsDir, "owner.json"), `${releaseId}\n`, {
        flag: "wx",
        mode: 0o400,
      });
      const bootstrapEnv = smoke.bootstrapEnvironment(
        join(secretsDir, "unused"),
        env,
        root,
      );
      bootstrapEnv.COFFEE_CONFIG_FILE = configPath;
      const { nginxIdentity, keycloakIdentity } =
        await bootstrap.materializeLocalRuntimeSecrets({
          root,
          outputDir: secretsDir,
          includeBootstrap: retirement.stage !== "retired",
          env: bootstrapEnv,
        });
      let artifacts;
      if (existingRelease) {
        artifacts = JSON.parse(
          await readFile(join(releaseDir, "release.json"), "utf8"),
        ).artifacts;
      } else {
        artifacts = await captureLocalFrontend({
          root,
          releaseDir,
          nginxImageId: expectedImages.get("edge-nginx"),
          run,
        });
        artifacts.composeSha256 = createHash("sha256")
          .update(overrideBytes)
          .digest("hex");
        artifacts.steadyComposeSha256 = createHash("sha256")
          .update(steadyOverrideBytes)
          .digest("hex");
      }
      const metadata = {
        ...identity,
        artifacts,
        certificates: {
          edge: nginxIdentity.publicCertificateFingerprint,
          transportCa: nginxIdentity.transportCaFingerprint,
          identityKeySha256: keycloakIdentity.publicKeySha256,
          identityCa: keycloakIdentity.caFingerprint,
        },
      };
      if (existingRelease) {
        if (
          (await readFile(overridePath, "utf8")) !== overrideBytes ||
          (await readFile(join(releaseDir, "release.json"), "utf8")) !==
            JSON.stringify(metadata)
        )
          throw new Error("RECOVERY_REQUIRED: release materialization differs");
      } else {
        await writeFile(overridePath, overrideBytes, {
          flag: "wx",
          mode: 0o400,
        });
        await writeFile(steadyOverridePath, steadyOverrideBytes, {
          flag: "wx",
          mode: 0o400,
        });
        await writeFile(
          join(releaseDir, "release.json"),
          JSON.stringify(metadata),
          { flag: "wx", mode: 0o400 },
        );
        await chmod(releaseDir, 0o500);
      }
      beforeDatabase();
      await bootstrap.provisionLocalIdentityDatabase({
        root,
        expectedServerIdentity,
        requireExisting: retirement.stage === "retired",
        expectedDatabaseOid: retirement.databaseOid,
        env: bootstrapEnv,
      });
      const composeEnv = { ...env, COFFEE_COMPOSE_SECRETS_DIR: secretsDir };
      delete composeEnv.COFFEE_LAUNCH_CONTEXT_FILE;
      const compose = (...args) =>
        execFileSync(
          "docker",
          [
            "compose",
            "--project-name",
            PROJECT,
            "--project-directory",
            root,
            "--file",
            join(root, "compose.yaml"),
            "--file",
            retirement.stage === "retired" ? steadyOverridePath : overridePath,
            ...args,
          ],
          { cwd: root, env: composeEnv, stdio: "inherit", timeout: 300_000 },
        );
      compose(
        "up",
        "--no-deps",
        "--force-recreate",
        "--no-build",
        "--pull",
        "never",
        "--wait",
        "kafka",
        "keycloak",
      );
      if (retirement.stage === "retired") {
        const ca = await readFile(join(secretsDir, "keycloak/ca.crt"));
        const jwks = await identityRequest({
          base: projected.localIdentity.publicBaseUrl,
          ca,
          timeoutMs: projected.platform.requestDeadlineMs,
          maxBytes: projected.platform.bodyLimitBytes,
          path: `/realms/${encodeURIComponent(identityBinding.realm)}/protocol/openid-connect/certs`,
        });
        if (identitySigningKeysHash(jwks) !== retirement.signingKeySha256)
          throw new Error(
            "RECOVERY_REQUIRED: identity signing keys differ from the retired authority",
          );
      }
      await bootstrap.provisionLocalBusinessDatabases({
        root,
        expectedServerIdentity,
        env: bootstrapEnv,
      });
      const topicCommands = smoke.buildKafkaRegistryBootstrapScript(projected);
      compose("exec", "-T", "kafka", "sh", "-ceu", topicCommands.join("\n"));
      compose(
        "up",
        "--no-deps",
        "--force-recreate",
        "--no-build",
        "--pull",
        "never",
        "--wait",
        ...runtimes,
        "edge-nginx",
      );
      if (retirement.stage !== "retired")
        await rm(
          join(
            secretsDir,
            "keycloak-import",
            `${projected.localIdentity.realm}-realm.json`,
          ),
        );
      const after = await inspectLocalRuntime({ root });
      if (
        after.some(
          (entry) =>
            !isLocalRuntimeReady(entry) ||
            (!OBSERVABILITY.includes(entry.service) &&
              entry.imageId !== expectedImages.get(entry.service)),
        )
      )
        throw new Error(
          "RECOVERY_REQUIRED: runtime or observability readiness is not confirmed",
        );
      const { refreshLocalCollector } =
        await import("./observability/service.mjs");
      await refreshLocalCollector({
        expectedRuntimes: after.filter((entry) =>
          [...runtimes, "edge-nginx"].includes(entry.service),
        ),
      });
      const refreshed = await inspectLocalRuntime({ root });
      if (
        refreshed.some(
          (entry) =>
            !isLocalRuntimeReady(entry) ||
            (!OBSERVABILITY.includes(entry.service) &&
              !after.some(
                (prior) =>
                  prior.service === entry.service &&
                  prior.containerId === entry.containerId &&
                  prior.imageId === entry.imageId,
              )),
        )
      )
        throw new Error("RECOVERY_REQUIRED: Collector refresh is not ready");
      for (const tag of builtImages) run(["image", "rm", tag]);
      return {
        releaseDir,
        sourceSha: metadata.sourceSha,
        configSha256,
        state:
          retirement.stage === "retired"
            ? "awaiting-owner-relogin"
            : "awaiting-operator-confirmation",
      };
    },
  });
}

/** Check the real owner session and effective realm role before revoking temporary access. */
export async function authorizeIdentityRetirement({
  config,
  bootstrapPassword,
  call,
  beforeDelete,
}) {
  const form = new URLSearchParams({
    grant_type: "password",
    client_id: "admin-cli",
    username: config.localIdentity.bootstrapAdminUsername,
    password: bootstrapPassword,
  }).toString();
  const tokenReply = await call(
    "/realms/master/protocol/openid-connect/token",
    { method: "POST", body: form },
  );
  if (typeof tokenReply?.access_token !== "string" || !tokenReply.access_token)
    throw new Error("RECOVERY_REQUIRED: temporary admin token is unavailable");
  const token = tokenReply.access_token;
  const realm = encodeURIComponent(config.localIdentity.realm);
  const query = (value) => encodeURIComponent(value);
  const ownerRows = await call(
    `/admin/realms/${realm}/users?username=${query(config.localIdentity.operatorUsername)}&exact=true`,
    { token },
  );
  if (
    !Array.isArray(ownerRows) ||
    ownerRows.length !== 1 ||
    ownerRows[0].username !== config.localIdentity.operatorUsername ||
    ownerRows[0].enabled !== true ||
    !ownerRows[0].id
  )
    throw new Error("RECOVERY_REQUIRED: owner identity is ambiguous");
  const ownerId = query(ownerRows[0].id);
  const sessions = await call(
    `/admin/realms/${realm}/users/${ownerId}/sessions`,
    { token },
  );
  if (
    !Array.isArray(sessions) ||
    !sessions.some((session) =>
      Object.values(session.clients ?? {}).includes(
        config.localIdentity.clientId,
      ),
    )
  )
    throw new Error("RECOVERY_REQUIRED: owner browser session is not present");
  const clients = await call(
    `/admin/realms/${realm}/clients?clientId=realm-management`,
    { token },
  );
  if (
    !Array.isArray(clients) ||
    clients.length !== 1 ||
    clients[0].clientId !== "realm-management" ||
    !clients[0].id
  )
    throw new Error("RECOVERY_REQUIRED: realm management client is ambiguous");
  const roles = await call(
    `/admin/realms/${realm}/users/${ownerId}/role-mappings/clients/${query(clients[0].id)}/composite`,
    { token },
  );
  if (
    !Array.isArray(roles) ||
    !roles.some(
      (role) => role.name === "realm-admin" && role.clientRole === true,
    )
  )
    throw new Error("RECOVERY_REQUIRED: owner realm-admin is not proven");
  const admins = await call(
    `/admin/realms/master/users?username=${query(config.localIdentity.bootstrapAdminUsername)}&exact=true&briefRepresentation=true`,
    { token },
  );
  if (
    !Array.isArray(admins) ||
    admins.length !== 1 ||
    admins[0].username !== config.localIdentity.bootstrapAdminUsername ||
    !admins[0].id ||
    !admins[0].attributes?.is_temporary_admin?.includes("true")
  )
    throw new Error("RECOVERY_REQUIRED: temporary master admin is ambiguous");
  await beforeDelete();
  await call(`/admin/realms/master/users/${query(admins[0].id)}`, {
    method: "DELETE",
    token,
    expected: 204,
  });
}

/** Retire the owned temporary admin only after the owner has a real client session. */
export async function recoverLocalIdentity({
  root = ROOT,
  env = process.env,
} = {}) {
  const bootstrap = await import("./config-bootstrap/index.mjs");
  const { loadPlatformConfig } = await import("../scripts/config-lib.mjs");
  const status = await inspectLocalRuntime({ root });
  if (status.some((entry) => !isLocalRuntimeReady(entry)))
    throw new Error("RECOVERY_REQUIRED: runtime is not healthy");
  const keycloak = status.find((entry) => entry.service === "keycloak");
  const docker = (args) =>
    execFileSync("docker", args, {
      cwd: root,
      encoding: "utf8",
      timeout: 120_000,
    });
  const rows = JSON.parse(docker(["inspect", keycloak.containerId]));
  const mount = rows[0]?.Mounts?.find(
    (entry) => entry.Destination === "/run/keycloak",
  );
  const importMount = rows[0]?.Mounts?.find(
    (entry) => entry.Destination === "/opt/keycloak/data/import",
  );
  const secretsDir = mount ? dirname(mount.Source) : "";
  const releaseId = secretsDir.replace(
    /^\/dev\/shm\/coffee-platform-local-/u,
    "",
  );
  if (
    rows.length !== 1 ||
    rows[0].Id !== keycloak.containerId ||
    mount?.RW !== false ||
    mount.Source !== join(secretsDir, "keycloak") ||
    importMount?.Source !== join(secretsDir, "keycloak-import") ||
    importMount.RW !== false ||
    secretsDir !== `/dev/shm/coffee-platform-local-${releaseId}` ||
    !/^[a-f0-9]{40}-[a-f0-9]{16}-[a-f0-9]{12}$/u.test(releaseId) ||
    (await readFile(join(secretsDir, "owner.json"), "utf8")) !==
      `${releaseId}\n`
  )
    throw new Error("RECOVERY_REQUIRED: identity secret ownership is unknown");
  const secretsInfo = await lstat(secretsDir);
  if (
    !secretsInfo.isDirectory() ||
    secretsInfo.isSymbolicLink() ||
    secretsInfo.uid !== process.getuid() ||
    (secretsInfo.mode & 0o777) !== 0o700 ||
    (await realpath(secretsDir)) !== secretsDir
  )
    throw new Error("RECOVERY_REQUIRED: identity secret directory is foreign");
  const releaseDir = join(
    homedir(),
    "coffee-platform/runtime/releases",
    releaseId,
  );
  const releaseInfo = await lstat(releaseDir);
  const identity = JSON.parse(
    await readFile(join(releaseDir, "release.json"), "utf8"),
  );
  const configPath = join(releaseDir, "platform.yaml");
  const steadyPath = join(releaseDir, "compose-steady.json");
  const gitSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
  }).trim();
  const sha = (data) => createHash("sha256").update(data).digest("hex");
  if (
    !releaseInfo.isDirectory() ||
    releaseInfo.isSymbolicLink() ||
    releaseInfo.uid !== process.getuid() ||
    (releaseInfo.mode & 0o777) !== 0o500 ||
    identity.sourceSha !== gitSha ||
    releaseId !==
      `${identity.sourceSha}-${identity.configSha256.slice(0, 16)}-${identity.encryptedSecretsSha256.slice(0, 12)}` ||
    identity.keycloakImageId !== keycloak.imageId ||
    sha(await readFile(join(root, "secrets/platform.secrets.sops.yaml"))) !==
      identity.encryptedSecretsSha256 ||
    sha(await readFile(configPath)) !== identity.configSha256 ||
    sha(await readFile(steadyPath)) !== identity.artifacts?.steadyComposeSha256
  )
    throw new Error("RECOVERY_REQUIRED: identity release binding is invalid");
  const config = await loadPlatformConfig(root, configPath);
  if (!/^\d{10,30}$/u.test(env.COFFEE_DB_EXPECTED_SERVER_IDENTITY ?? ""))
    throw new Error(
      "RECOVERY_REQUIRED: approved PostgreSQL identity is missing",
    );
  const identityBinding = {
    postgresSystemIdentifier: env.COFFEE_DB_EXPECTED_SERVER_IDENTITY,
    databaseName: config.localIdentity.databaseName,
    databaseRole: config.localIdentity.databaseRole,
    realm: config.localIdentity.realm,
  };
  const retirement = await identityState({
    identity: identityBinding,
    bootstrap,
  });
  if (retirement.stage !== "pending")
    throw new Error("RECOVERY_REQUIRED: identity is already retired");
  const smoke = await import("./compose-smoke.mjs");
  const bootstrapEnv = smoke.bootstrapEnvironment(
    join(secretsDir, "unused"),
    env,
    root,
  );
  bootstrapEnv.COFFEE_CONFIG_FILE = configPath;
  const databaseProof = await bootstrap.provisionLocalIdentityDatabase({
    root,
    expectedServerIdentity: identityBinding.postgresSystemIdentifier,
    requireExisting: true,
    env: bootstrapEnv,
  });
  const ca = await readFile(join(secretsDir, "keycloak/ca.crt"));
  if (
    new X509Certificate(ca).fingerprint256 !== identity.certificates?.identityCa
  )
    throw new Error("RECOVERY_REQUIRED: identity CA differs from the release");
  const secretPath = join(secretsDir, "keycloak/keycloak.conf");
  const secretInfo = await lstat(secretPath);
  if (
    !secretInfo.isFile() ||
    secretInfo.isSymbolicLink() ||
    secretInfo.uid !== process.getuid() ||
    (secretInfo.mode & 0o777) !== 0o400
  )
    throw new Error(
      "RECOVERY_REQUIRED: identity bootstrap secret ownership is unknown",
    );
  const secret = await readFile(secretPath, "utf8");
  const match =
    /^db-password=[A-Za-z0-9_-]{32,128}\nbootstrap-admin-password=([A-Za-z0-9_-]{32,128})\n$/u.exec(
      secret,
    );
  if (!match)
    throw new Error("RECOVERY_REQUIRED: identity bootstrap secret is invalid");
  const call = (path, options = {}) =>
    identityRequest({
      base: config.localIdentity.publicBaseUrl,
      ca,
      timeoutMs: config.platform.requestDeadlineMs,
      maxBytes: config.platform.bodyLimitBytes,
      path,
      ...options,
    });
  const jwks = await call(
    `/realms/${encodeURIComponent(identityBinding.realm)}/protocol/openid-connect/certs`,
  );
  const signingKeySha256 = identitySigningKeysHash(jwks);
  const receipt = {
    ...identityBinding,
    databaseOid: databaseProof.databaseOid,
    signingKeySha256,
    stage: "retiring",
  };
  await authorizeIdentityRetirement({
    config,
    bootstrapPassword: match[1],
    call,
    beforeDelete: async () => {
      const file = await open(retirement.path, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify(receipt));
        await file.sync();
      } finally {
        await file.close();
      }
      const directory = await open(dirname(retirement.path), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    },
  });
  await bootstrap.retireKeycloakBootstrapSecret({
    outputDir: join(secretsDir, "keycloak"),
  });
  const composeEnv = { ...env, COFFEE_COMPOSE_SECRETS_DIR: secretsDir };
  delete composeEnv.COFFEE_LAUNCH_CONTEXT_FILE;
  execFileSync(
    "docker",
    [
      "compose",
      "--project-name",
      PROJECT,
      "--project-directory",
      root,
      "--file",
      join(root, "compose.yaml"),
      "--file",
      steadyPath,
      "up",
      "--no-deps",
      "--force-recreate",
      "--no-build",
      "--pull",
      "never",
      "--wait",
      "keycloak",
    ],
    { cwd: root, env: composeEnv, stdio: "inherit", timeout: 300_000 },
  );
  const after = await inspectLocalRuntime({ root });
  const next = after.find((entry) => entry.service === "keycloak");
  const nextRows = JSON.parse(docker(["inspect", next.containerId]));
  if (
    after.some((entry) => !isLocalRuntimeReady(entry)) ||
    next.imageId !== identity.keycloakImageId ||
    nextRows.length !== 1 ||
    nextRows[0].Id !== next.containerId ||
    nextRows[0].Mounts.some(
      (entry) => entry.Destination === "/opt/keycloak/data/import",
    ) ||
    nextRows[0].Config.Env.some((value) =>
      value.startsWith("KC_BOOTSTRAP_ADMIN_"),
    )
  )
    throw new Error(
      "RECOVERY_REQUIRED: steady identity container is not proven",
    );
  const updated = await open(retirement.path, "r+");
  try {
    await updated.truncate(0);
    await updated.writeFile(JSON.stringify({ ...receipt, stage: "retired" }));
    await updated.sync();
  } finally {
    await updated.close();
  }
  return { releaseDir, state: "awaiting-owner-relogin" };
}

/** Report only resources owned by this exact release directory. */
export async function inspectLocalRuntime({
  root = ROOT,
  run = (args) =>
    execFileSync("docker", args, {
      encoding: "utf8",
      timeout: DOCKER_COMMAND_TIMEOUT_MS,
    }),
  telemetryRoot = () =>
    execFileSync(
      "systemctl",
      [
        "--user",
        "show",
        "coffee-observability.service",
        "--property=WorkingDirectory",
        "--value",
      ],
      { encoding: "utf8", timeout: TELEMETRY_UNIT_QUERY_TIMEOUT_MS },
    ).trim(),
  inspectTelemetry,
} = {}) {
  const catalog = JSON.parse(
    await readFile(join(root, "config/service-catalog.json"), "utf8"),
  );
  const services = [
    ...catalog.runtimes.map((runtime) => runtime.name),
    "kafka",
    "keycloak",
  ];
  const result = [];
  for (const service of services) {
    const output = String(
      run([
        "ps",
        "--all",
        "--quiet",
        "--no-trunc",
        "--filter",
        `label=com.docker.compose.project=${PROJECT}`,
        "--filter",
        `label=com.docker.compose.service=${service}`,
      ]),
    ).trim();
    const ids = output ? output.split(/\s+/u) : [];
    if (ids.length > 1 || ids.some((id) => !/^[a-f0-9]{64}$/u.test(id)))
      throw new Error(`${service}: container identity is ambiguous`);
    if (ids.length === 0) {
      result.push({ service, status: "missing" });
      continue;
    }
    let rows;
    try {
      rows = JSON.parse(String(run(["inspect", ids[0]])));
    } catch {
      throw new Error(`${service}: container inspection failed`);
    }
    const item = rows[0];
    const labels = item?.Config?.Labels;
    if (
      rows.length !== 1 ||
      item?.Id !== ids[0] ||
      labels?.["com.docker.compose.project"] !== PROJECT ||
      labels["com.docker.compose.service"] !== service ||
      labels["com.docker.compose.project.working_dir"] !== root ||
      !/^sha256:[a-f0-9]{64}$/u.test(item.Image ?? "")
    )
      throw new Error(`${service}: container does not belong to this release`);
    result.push({
      service,
      containerId: item.Id,
      imageId: item.Image,
      status: item.State?.Status ?? "unknown",
      health: item.State?.Health?.Status ?? "unknown",
    });
  }
  const observabilityRoot = await telemetryRoot();
  if (!observabilityRoot || resolve(observabilityRoot) !== observabilityRoot)
    throw new Error("observability release directory is unavailable");
  const verifyTelemetry =
    inspectTelemetry ??
    (await import("./observability/service.mjs")).inspectOwnedTelemetry;
  const telemetryIds = await verifyTelemetry({ root: observabilityRoot, run });
  const observed = new Map();
  for (const id of telemetryIds) {
    let rows;
    try {
      rows = JSON.parse(String(run(["inspect", id])));
    } catch {
      throw new Error("observability container inspection failed");
    }
    const item = rows[0];
    const service = item?.Config?.Labels?.["com.docker.compose.service"];
    if (
      rows.length !== 1 ||
      item?.Id !== id ||
      !OBSERVABILITY.includes(service) ||
      observed.has(service) ||
      !/^sha256:[a-f0-9]{64}$/u.test(item.Image ?? "")
    )
      throw new Error("observability container identity is invalid");
    observed.set(service, {
      service,
      imageId: item.Image,
      status: item.State?.Status ?? "unknown",
      health:
        service === "alert-sink" &&
        item.State?.Health === undefined &&
        item.Config?.Healthcheck == null
          ? "none"
          : (item.State?.Health?.Status ?? "unknown"),
    });
  }
  for (const service of OBSERVABILITY)
    result.push(observed.get(service) ?? { service, status: "missing" });
  return result;
}

/** Inspect the owned application roles in one batch without touching telemetry. */
export async function inspectOwnedLocalRuntime({ root = ROOT, run }) {
  const catalog = JSON.parse(
    await readFile(join(root, "config/service-catalog.json"), "utf8"),
  );
  const services = new Set([
    ...catalog.runtimes.map((entry) => entry.name),
    "kafka",
    "keycloak",
  ]);
  const output = String(
    run([
      "ps",
      "--all",
      "--quiet",
      "--no-trunc",
      "--filter",
      `label=com.docker.compose.project=${PROJECT}`,
    ]),
  ).trim();
  const ids = output ? output.split(/\s+/u) : [];
  if (
    ids.some((id) => !/^[a-f0-9]{64}$/u.test(id)) ||
    new Set(ids).size !== ids.length
  )
    throw new Error("local runtime container identity is ambiguous");
  if (ids.length === 0) return [];
  const rows = JSON.parse(String(run(["inspect", ...ids])));
  if (
    !Array.isArray(rows) ||
    rows.length !== ids.length ||
    new Set(rows.map((item) => item.Id)).size !== ids.length ||
    rows.some((item) => !ids.includes(item.Id))
  )
    throw new Error("local runtime container inspection is incomplete");
  const found = new Map();
  for (const item of rows) {
    const labels = item?.Config?.Labels;
    const service = labels?.["com.docker.compose.service"];
    if (labels?.["com.docker.compose.project"] !== PROJECT)
      throw new Error("local runtime container project differs");
    if (!services.has(service)) continue;
    if (
      found.has(service) ||
      labels["com.docker.compose.project.working_dir"] !== root ||
      !/^sha256:[a-f0-9]{64}$/u.test(item.Image ?? "")
    )
      throw new Error(`${service}: container does not belong to this release`);
    found.set(service, {
      service,
      containerId: item.Id,
      imageId: item.Image,
      status: item.State?.Status ?? "unknown",
    });
  }
  return [...services]
    .filter((service) => found.has(service))
    .map((service) => found.get(service));
}

/** Stop only this release's application containers; keep observability and data. */
export async function stopLocalRuntime({
  root = ROOT,
  run,
  inspect = inspectOwnedLocalRuntime,
  loadConfig,
  loadRelease = readLocalRelease,
  env = process.env,
} = {}) {
  const readConfig =
    loadConfig ??
    (await import("../scripts/config-lib.mjs")).loadPlatformConfig;
  const config = await readConfig(root);
  const docker =
    run ??
    ((args) =>
      execFileSync("docker", args, {
        cwd: root,
        encoding: "utf8",
        killSignal: "SIGKILL",
        timeout:
          args[0] === "stop"
            ? Math.ceil(config.platform.shutdownGraceMs / 1000) * 1000 +
              STOP_COMMAND_OVERHEAD_MS
            : STOP_METADATA_TIMEOUT_MS,
      }));
  const status = await inspect({ root, run: docker });
  const application = status.filter(
    (entry) => !OBSERVABILITY.includes(entry.service),
  );
  if (env.COFFEE_LOCAL_RELEASE_ID && application.length) {
    const { identity } = await loadRelease(env.COFFEE_LOCAL_RELEASE_ID);
    const expected = new Map(
      identity.runtimeImages.map((entry) => [entry.service, entry.imageId]),
    );
    expected.set("kafka", identity.kafkaImageId);
    expected.set("keycloak", identity.keycloakImageId);
    if (
      expected.size !== 17 ||
      application.some((entry) => expected.get(entry.service) !== entry.imageId)
    )
      throw new Error(
        "RECOVERY_REQUIRED: stop container image identity differs",
      );
  }
  const ordered = [
    "edge-nginx",
    ...application
      .map((entry) => entry.service)
      .filter(
        (service) => !["edge-nginx", "kafka", "keycloak"].includes(service),
      ),
    "keycloak",
    "kafka",
  ];
  const timeout = String(Math.ceil(config.platform.shutdownGraceMs / 1000));
  for (const service of ordered) {
    const container = application.find((entry) => entry.service === service);
    if (["running", "restarting"].includes(container?.status))
      docker(["stop", "--time", timeout, container.containerId]);
  }
  if (env.SERVICE_RESULT && env.SERVICE_RESULT !== "success")
    throw new Error(
      "RECOVERY_REQUIRED: unit stopped after an unsuccessful operation",
    );
  return {
    stopped: ordered.filter((service) =>
      application.some(
        (entry) =>
          entry.service === service &&
          ["running", "restarting"].includes(entry.status),
      ),
    ),
  };
}

async function readLocalRelease(releaseId) {
  if (!/^[a-f0-9]{40}-[a-f0-9]{16}-[a-f0-9]{12}$/u.test(releaseId))
    throw new Error("RECOVERY_REQUIRED: stop release identity is invalid");
  const releaseDir = join(
    homedir(),
    "coffee-platform/runtime/releases",
    releaseId,
  );
  const info = await lstat(releaseDir);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid() ||
    (info.mode & 0o777) !== 0o500 ||
    (await realpath(releaseDir)) !== releaseDir
  )
    throw new Error("RECOVERY_REQUIRED: active release ownership is unknown");
  const identity = JSON.parse(
    await readFile(join(releaseDir, "release.json"), "utf8"),
  );
  if (
    releaseId !==
    `${identity.sourceSha}-${identity.configSha256.slice(0, 16)}-${identity.encryptedSecretsSha256.slice(0, 12)}`
  )
    throw new Error("RECOVERY_REQUIRED: active release identity differs");
  return { releaseDir, identity };
}

async function readActiveLocalRelease({ root, active }) {
  const status = await inspectLocalRuntime({ root });
  if (status.some((entry) => !isLocalRuntimeReady(entry)))
    throw new Error(
      "RECOVERY_REQUIRED: running local release is not ready for installation",
    );
  const keycloak = status.find((entry) => entry.service === "keycloak");
  const rows = JSON.parse(
    execFileSync("docker", ["inspect", keycloak.containerId], {
      cwd: root,
      encoding: "utf8",
      timeout: 120_000,
    }),
  );
  const mount = rows[0]?.Mounts?.find(
    (entry) => entry.Destination === "/run/keycloak",
  );
  const secretsDir = mount ? dirname(mount.Source) : "";
  const releaseId = secretsDir.replace(
    /^\/dev\/shm\/coffee-platform-local-/u,
    "",
  );
  if (
    rows.length !== 1 ||
    rows[0].Id !== keycloak.containerId ||
    mount?.RW !== false ||
    mount.Source !== join(secretsDir, "keycloak") ||
    secretsDir !== `/dev/shm/coffee-platform-local-${releaseId}` ||
    !/^[a-f0-9]{40}-[a-f0-9]{16}-[a-f0-9]{12}$/u.test(releaseId) ||
    (await readFile(join(secretsDir, "owner.json"), "utf8")) !==
      `${releaseId}\n`
  )
    throw new Error("RECOVERY_REQUIRED: active release identity is unknown");
  const { releaseDir, identity } = await readLocalRelease(releaseId);
  const hash = (data) => createHash("sha256").update(data).digest("hex");
  if (
    identity.sourceSha !== active.context.candidateSha ||
    releaseId !==
      `${identity.sourceSha}-${identity.configSha256.slice(0, 16)}-${identity.encryptedSecretsSha256.slice(0, 12)}` ||
    hash(await readFile(join(releaseDir, "platform.yaml"))) !==
      identity.configSha256 ||
    hash(await readFile(join(root, "secrets/platform.secrets.sops.yaml"))) !==
      identity.encryptedSecretsSha256
  )
    throw new Error("RECOVERY_REQUIRED: active release metadata differs");
  const expected = new Map(
    identity.runtimeImages.map((entry) => [entry.service, entry.imageId]),
  );
  expected.set("kafka", identity.kafkaImageId);
  expected.set("keycloak", identity.keycloakImageId);
  const product = status.filter(
    (entry) => !OBSERVABILITY.includes(entry.service),
  );
  if (
    product.length !== 17 ||
    expected.size !== 17 ||
    product.some((entry) => expected.get(entry.service) !== entry.imageId)
  )
    throw new Error("RECOVERY_REQUIRED: active release image IDs differ");
  return { status, releaseId, releaseDir, secretsDir, identity, product };
}

/** Examine the scoped certificates actually mounted by the accepted release. */
export async function readLocalCertificateExpiry({ root, release, config }) {
  const docker = (args) =>
    execFileSync("docker", args, {
      cwd: root,
      encoding: "utf8",
      timeout: 30_000,
    });
  const rows = JSON.parse(
    docker(["inspect", ...release.product.map((entry) => entry.containerId)]),
  );
  if (
    rows.length !== release.product.length ||
    rows.some(
      (row) =>
        !release.product.some(
          (entry) =>
            entry.containerId === row.Id && entry.imageId === row.Image,
        ),
    )
  )
    throw new Error(
      "RECOVERY_REQUIRED: certificate container identity differs",
    );
  const mount = (service, destination, source) => {
    const id = release.product.find(
      (entry) => entry.service === service,
    ).containerId;
    const row = rows.find((item) => item.Id === id);
    const mounts = row.Mounts.filter(
      (item) => item.Destination === destination,
    );
    if (
      mounts.length !== 1 ||
      mounts[0].Type !== "bind" ||
      mounts[0].Source !== source ||
      mounts[0].RW !== false
    )
      throw new Error(`${service}: scoped certificate mount differs`);
    return id;
  };
  const scope = release.secretsDir;
  const caFingerprint = release.identity.certificates.transportCa;
  const expiry = [];
  const inspect = (
    certificatePem,
    authorityPem,
    keyPem,
    dnsNames = [],
    uri,
    keySha256,
    expectedCaFingerprint = caFingerprint,
  ) => {
    const certificate = new X509Certificate(certificatePem);
    const authority = new X509Certificate(authorityPem);
    if (
      !authority.ca ||
      authority.fingerprint256 !== expectedCaFingerprint ||
      !Number.isFinite(Date.parse(authority.validFrom)) ||
      !Number.isFinite(Date.parse(authority.validTo)) ||
      Date.now() < Date.parse(authority.validFrom) ||
      Date.now() >= Date.parse(authority.validTo) ||
      certificate.ca ||
      !certificate.checkIssued(authority) ||
      !certificate.verify(authority.publicKey) ||
      (keyPem && !certificate.checkPrivateKey(createPrivateKey(keyPem))) ||
      (keySha256 &&
        createHash("sha256")
          .update(certificate.publicKey.export({ type: "spki", format: "der" }))
          .digest("hex") !== keySha256) ||
      dnsNames.some(
        (name) =>
          !certificate.checkHost(name, { subject: "never", wildcards: false }),
      ) ||
      (uri &&
        !certificate.subjectAltName?.split(", ").includes(`URI:${uri}`)) ||
      !Number.isFinite(Date.parse(certificate.validFrom)) ||
      !Number.isFinite(Date.parse(certificate.validTo)) ||
      Date.now() < Date.parse(certificate.validFrom) ||
      Date.parse(certificate.validTo) > Date.parse(authority.validTo)
    )
      throw new Error("RECOVERY_REQUIRED: active certificate identity differs");
    expiry.push(Date.parse(certificate.validTo));
  };
  const catalog = JSON.parse(
    await readFile(join(root, "config/service-catalog.json"), "utf8"),
  );
  for (const { name } of catalog.runtimes.filter(
    (entry) => entry.name !== "edge-nginx",
  )) {
    const path = join(scope, `${name}.yaml`);
    const id = mount(name, "/run/secrets/coffee-platform.yaml", path);
    const projection = JSON.parse(
      docker([
        "exec",
        id,
        "node",
        "-e",
        'try { const fs = require("node:fs"); const crypto = require("node:crypto"); const yaml = require("node:module").createRequire(require.resolve("@coffee-platform/runtime"))("js-yaml"); const scoped = yaml.load(fs.readFileSync("/run/secrets/coffee-platform.yaml", "utf8")); const material = JSON.parse(scoped.secrets.security.serviceTransportKeys[process.argv[1]]); const keySha256 = crypto.createHash("sha256").update(crypto.createPublicKey(crypto.createPrivateKey(material.keyPem)).export({ type: "spki", format: "der" })).digest("hex"); process.stdout.write(JSON.stringify({ runtime: scoped.runtime, environment: scoped.environment, certPem: material.certPem, caPem: material.caPem, keySha256 })); } catch { process.stderr.write("certificate projection failed\\n"); process.exitCode = 1; }',
        name,
      ]),
    );
    if (
      projection.runtime !== name ||
      projection.environment !== config.environment ||
      !/^[a-f0-9]{64}$/u.test(projection.keySha256 ?? "")
    )
      throw new Error(`${name}: scoped certificate identity differs`);
    const dns = [
      `${name}.${config.environment}.svc.coffee-platform.internal`,
      ...Object.values(config.nginxTransport.upstreams)
        .filter((entry) => entry.host === name)
        .map((entry) => entry.serverName),
    ];
    inspect(
      projection.certPem,
      projection.caPem,
      null,
      dns,
      `spiffe://coffee-platform/${config.environment}/${name}`,
      projection.keySha256,
    );
  }
  const nginxId = mount(
    "edge-nginx",
    "/run/secrets/edge-nginx/client.crt",
    join(scope, "edge-nginx/client.crt"),
  );
  mount(
    "edge-nginx",
    "/run/secrets/edge-nginx/upstream-ca.crt",
    join(scope, "edge-nginx/upstream-ca.crt"),
  );
  mount(
    "edge-nginx",
    "/run/secrets/edge-nginx/public.crt",
    join(scope, "edge-nginx/public.crt"),
  );
  const nginxCert = (name) =>
    docker(["exec", nginxId, "cat", `/run/secrets/edge-nginx/${name}`]);
  inspect(
    nginxCert("client.crt"),
    nginxCert("upstream-ca.crt"),
    null,
    [`edge-nginx.${config.environment}.svc.coffee-platform.internal`],
    `spiffe://coffee-platform/${config.environment}/edge-nginx`,
  );
  const publicCertificate = new X509Certificate(nginxCert("public.crt"));
  if (
    publicCertificate.fingerprint256 !== release.identity.certificates.edge ||
    !publicCertificate.checkHost(config.nginxTransport.publicHost, {
      subject: "never",
      wildcards: false,
    }) ||
    Date.now() < Date.parse(publicCertificate.validFrom)
  )
    throw new Error(
      "RECOVERY_REQUIRED: public edge certificate is invalid or expired",
    );
  mount("keycloak", "/run/keycloak", join(scope, "keycloak"));
  const identityCert = await readFile(join(scope, "keycloak/tls.crt"), "utf8");
  const identityKey = await readFile(join(scope, "keycloak/tls.key"), "utf8");
  const identityCa = await readFile(join(scope, "keycloak/ca.crt"), "utf8");
  if (
    createHash("sha256")
      .update(
        new X509Certificate(identityCert).publicKey.export({
          type: "spki",
          format: "der",
        }),
      )
      .digest("hex") !== release.identity.certificates.identityKeySha256
  )
    throw new Error("RECOVERY_REQUIRED: identity certificate key differs");
  inspect(
    identityCert,
    identityCa,
    identityKey,
    [
      new URL(config.localIdentity.publicBaseUrl).hostname,
      new URL(config.localIdentity.privateBaseUrl).hostname,
    ],
    undefined,
    undefined,
    release.identity.certificates.identityCa ?? "",
  );
  mount("kafka", "/etc/kafka/secrets", join(scope, "kafka"));
  const kafka = join(scope, "kafka");
  const [kafkaCertificate, kafkaCa] = [
    ["kafka.keystore.p12", "-clcerts"],
    ["kafka.truststore.p12", "-cacerts"],
  ].map(([file, filter]) =>
    execFileSync(
      "openssl",
      [
        "pkcs12",
        "-in",
        join(kafka, file),
        filter,
        "-nokeys",
        "-passin",
        `file:${join(kafka, "kafka.keystore.password")}`,
      ],
      {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 30_000,
      },
    ),
  );
  if (
    [kafkaCertificate, kafkaCa].some(
      (pem) => (pem.match(/-----BEGIN CERTIFICATE-----/gu) ?? []).length !== 1,
    )
  )
    throw new Error("RECOVERY_REQUIRED: Kafka certificate store is invalid");
  inspect(kafkaCertificate, kafkaCa, null, ["kafka", "localhost"]);
  return {
    earliest: Math.min(...expiry),
    publicExpiry: Date.parse(publicCertificate.validTo),
  };
}

export async function publishMaintenanceWarning({
  reason,
  releaseId,
  publicNotAfter,
  readObservability,
  inspectTelemetry,
  run,
} = {}) {
  if (
    !/^[a-f0-9]{40}-[a-f0-9]{16}-[a-f0-9]{12}$/u.test(releaseId ?? "") ||
    !["public_certificate_expiring", "certificate_maintenance_failed"].includes(
      reason,
    ) ||
    (reason === "public_certificate_expiring" &&
      (!Number.isSafeInteger(publicNotAfter) || publicNotAfter <= 0))
  )
    throw new Error("maintenance warning input is invalid");
  const telemetry = await import("./observability/service.mjs");
  const accepted = await (
    readObservability ?? telemetry.readAcceptedObservabilityRelease
  )();
  const execute =
    run ??
    ((args, options = {}) =>
      execFileSync("docker", args, {
        encoding: "utf8",
        timeout: 30_000,
        ...options,
      }));
  const ids = (inspectTelemetry ?? telemetry.inspectOwnedTelemetry)({
    root: accepted.root,
    run: execute,
  });
  if (ids.length !== 6)
    throw new Error("maintenance warning telemetry is incomplete");
  const rows = JSON.parse(execute(["inspect", ...ids]));
  const sinks = rows.filter(
    (row) =>
      row.Config?.Labels?.["com.docker.compose.service"] === "alert-sink",
  );
  if (
    rows.length !== 6 ||
    sinks.length !== 1 ||
    !ids.includes(sinks[0].Id) ||
    sinks[0].Image !== accepted.helper.imageId ||
    sinks[0].State?.Running !== true
  )
    throw new Error("maintenance warning sink identity differs");
  const endpoint = new URL(accepted.config.telemetry.loki.endpoint);
  if (
    endpoint.protocol !== "http:" ||
    endpoint.hostname !== "loki" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw new Error("maintenance warning Loki endpoint is invalid");
  const event = {
    service: "coffee-platform-maintenance",
    environment: accepted.config.environment,
    namespace: accepted.config.telemetry.namespace,
    release_id: releaseId,
    event_id: randomUUID(),
    time: new Date().toISOString(),
    reason,
    severity: reason === "public_certificate_expiring" ? "warn" : "error",
    ...(reason === "public_certificate_expiring"
      ? { public_not_after: new Date(publicNotAfter).toISOString() }
      : {}),
    action:
      reason === "public_certificate_expiring"
        ? "Продлите публичный сертификат у его действующего издателя."
        : "Проверьте состояние обслуживания и выполните recovery.",
  };
  const program = `const fs=require('node:fs');const {endpoint,event,budget}=JSON.parse(fs.readFileSync(0,'utf8'));const start=Date.now();const request=async(url,options={})=>{const left=budget-(Date.now()-start);if(left<=0)throw Error('deadline');const response=await fetch(url,{...options,signal:AbortSignal.timeout(left)});if(!response.ok)throw Error('http');return response;};(async()=>{const body={resourceLogs:[{resource:{attributes:[{key:'service.name',value:{stringValue:event.service}}]},scopeLogs:[{scope:{name:'coffee-platform-maintenance'},logRecords:[{timeUnixNano:String(BigInt(Date.parse(event.time))*1000000n),body:{stringValue:JSON.stringify(event)}}]}]}]};await request(new URL('/otlp/v1/logs',endpoint),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});while(Date.now()-start<budget){const query=new URLSearchParams({query:'{service_name="coffee-platform-maintenance"} |= '+JSON.stringify(event.event_id),start:String(BigInt(Date.parse(event.time)-1000)*1000000n),end:String(BigInt(Date.now()+1000)*1000000n),limit:'100',direction:'forward'});const result=await(await request(new URL('/loki/api/v1/query_range?'+query,endpoint))).json();if(result.status!=='success'||result.data?.resultType!=='streams'||!Array.isArray(result.data.result))throw Error('response');for(const stream of result.data.result){if(stream.stream?.service_name!==event.service||!Array.isArray(stream.values))continue;for(const row of stream.values){try{const seen=JSON.parse(row[1]);if(seen.event_id===event.event_id&&JSON.stringify(seen)===JSON.stringify(event)){process.stdout.write(JSON.stringify({event_id:event.event_id}));return;}}catch{}}}await new Promise(resolve=>setTimeout(resolve,200));}throw Error('not visible');})().catch(()=>{process.stderr.write('maintenance warning delivery failed\\n');process.exitCode=1;});`;
  const budget = accepted.config.platform.requestDeadlineMs;
  const result = JSON.parse(
    execute(["exec", "-i", sinks[0].Id, "node", "-e", program], {
      input: JSON.stringify({ endpoint: endpoint.href, event, budget }),
      timeout: budget + 5000,
      stdio: ["pipe", "pipe", "pipe"],
    }),
  );
  if (result.event_id !== event.event_id)
    throw new Error("maintenance warning readback differs");
  return { eventId: event.event_id };
}

export async function dispatchCertificateMaintenance({
  env = process.env,
  unitState,
  reload,
  publish = publishMaintenanceWarning,
} = {}) {
  const state =
    unitState ??
    (() =>
      execFileSync(
        "systemctl",
        [
          "--user",
          "show",
          "coffee-platform.service",
          "--property=ActiveState",
          "--value",
        ],
        { encoding: "utf8", timeout: 10_000 },
      ).trim());
  const current = await state();
  if (current === "inactive" || current === "deactivating")
    return { state: "inactive" };
  if (current !== "active")
    throw new Error("RECOVERY_REQUIRED: local unit state is unknown");
  try {
    await (
      reload ??
      (() =>
        execFileSync(
          "systemctl",
          ["--user", "--job-mode=fail", "reload", "coffee-platform.service"],
          { stdio: "ignore" },
        ))
    )();
  } catch (cause) {
    let after;
    try {
      after = await state();
    } catch {
      after = undefined;
    }
    if (after === "inactive" || after === "deactivating")
      return { state: "inactive" };
    let warningDelivery = "delivered";
    try {
      await publish({
        reason: "certificate_maintenance_failed",
        releaseId: env.COFFEE_LOCAL_RELEASE_ID,
      });
    } catch {
      warningDelivery = "failed";
    }
    const error = new Error(
      `RECOVERY_REQUIRED: certificate maintenance reload failed; warningDelivery=${warningDelivery}`,
      { cause },
    );
    error.warningDelivery = warningDelivery;
    throw error;
  }
  return { state: "reloaded" };
}

export async function maintainLocalCertificates({
  root = ROOT,
  env = process.env,
  validateContext,
  readRelease = readActiveLocalRelease,
  loadConfig,
  readExpiry = readLocalCertificateExpiry,
  stop = stopLocalRuntime,
  start = startLocalRuntime,
  publish = publishMaintenanceWarning,
} = {}) {
  if (
    !/^[a-f0-9]{32}$/u.test(env.INVOCATION_ID ?? "") ||
    env.SYSTEMD_EXEC_PID !== String(process.pid)
  )
    throw new Error(
      "RECOVERY_REQUIRED: certificate maintenance requires the unit reload process",
    );
  const validate =
    validateContext ??
    (await import("../verification/launch/v1/report.mjs"))
      .validateLaunchContext;
  const active = await validate(env.COFFEE_LAUNCH_CONTEXT_FILE);
  if (active.candidateRoot !== root)
    throw new Error("RECOVERY_REQUIRED: maintenance source differs");
  const release = await readRelease({ root, active });
  if (release.releaseId !== env.COFFEE_LOCAL_RELEASE_ID)
    throw new Error("RECOVERY_REQUIRED: maintenance release differs");
  const readConfig =
    loadConfig ??
    (await import("../scripts/config-lib.mjs")).loadPlatformConfig;
  const config = await readConfig(
    root,
    join(release.releaseDir, "platform.yaml"),
  );
  const dates = await readExpiry({ root, release, config });
  const threshold = config.security.certificateRenewBeforeHours * 3_600_000;
  const publicRenewalRequired = dates.publicExpiry - Date.now() <= threshold;
  if (publicRenewalRequired)
    await publish({
      reason: "public_certificate_expiring",
      releaseId: release.releaseId,
      publicNotAfter: dates.publicExpiry,
    });
  if (dates.publicExpiry <= Date.now())
    throw new Error("RECOVERY_REQUIRED: public edge certificate has expired");
  if (dates.earliest - Date.now() > threshold)
    return { state: "current", publicRenewalRequired };
  await stop({ root, env });
  const result = await start({ root, env });
  return { state: result.state, publicRenewalRequired };
}

/** Enable boot provisioning only for the running release whose inputs were accepted. */
export async function installLocalRuntimeUnit({
  root = ROOT,
  env = process.env,
} = {}) {
  const contextFile = env.COFFEE_LAUNCH_CONTEXT_FILE;
  const expectedServerIdentity = env.COFFEE_DB_EXPECTED_SERVER_IDENTITY;
  const ageKeyFile = env.SOPS_AGE_KEY_FILE;
  if (
    ![contextFile, ageKeyFile].every(
      (value) => typeof value === "string" && resolve(value) === value,
    ) ||
    !/^\d{10,30}$/u.test(expectedServerIdentity ?? "")
  )
    throw new Error(
      "local unit requires the approved context, server identity and age key locator",
    );
  const ageInfo = await lstat(ageKeyFile);
  if (
    !ageInfo.isFile() ||
    ageInfo.isSymbolicLink() ||
    ageInfo.uid !== process.getuid() ||
    (ageInfo.mode & 0o077) !== 0 ||
    (await realpath(ageKeyFile)) !== ageKeyFile
  )
    throw new Error("local unit age key locator is not an owned private file");
  const { validateLaunchContext } =
    await import("../verification/launch/v1/report.mjs");
  const active = await validateLaunchContext(contextFile);
  const git = (args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      timeout: 30_000,
    }).trim();
  const controllerRoot = join(
    homedir(),
    "coffee-platform/runtime/controllers",
    active.context.candidateSha,
  );
  if (root !== controllerRoot || (await realpath(root)) !== root)
    throw new Error(
      "local unit requires the persistent accepted controller checkout",
    );
  if (
    active.candidateRoot !== root ||
    git(["rev-parse", "HEAD"]) !== active.context.candidateSha ||
    git(["status", "--porcelain", "--untracked-files=all"])
  )
    throw new Error(
      "local unit source checkout differs from the approved context",
    );
  const { releaseDir, releaseId, product } = await readActiveLocalRelease({
    root,
    active,
  });
  const pnpmPath = execFileSync("which", ["pnpm"], {
    encoding: "utf8",
    timeout: 10_000,
  }).trim();
  const flockPath = execFileSync("which", ["flock"], {
    encoding: "utf8",
    timeout: 10_000,
  }).trim();
  const lockPath = join(
    env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid()}`,
    "coffee-platform-heavy.lock",
  );
  const { loadPlatformConfig } = await import("../scripts/config-lib.mjs");
  const releaseConfig = await loadPlatformConfig(
    root,
    join(releaseDir, "platform.yaml"),
  );
  const unitOptions = {
    root,
    nodePath: process.execPath,
    pnpmPath,
    flockPath,
    lockPath,
    contextFile,
    expectedServerIdentity,
    releaseId,
    ageKeyFile,
    ownedServiceCount: product.length,
    shutdownGraceMs: releaseConfig.platform.shutdownGraceMs,
    certificateRenewBeforeHours:
      releaseConfig.security.certificateRenewBeforeHours,
  };
  const unit = renderLocalRuntimeUnit(unitOptions);
  const maintenance = renderLocalCertificateMaintenanceUnits(unitOptions);
  const unitDir = join(homedir(), ".config/systemd/user");
  await mkdir(unitDir, { recursive: true, mode: 0o700 });
  const unitDirInfo = await lstat(unitDir);
  if (
    !unitDirInfo.isDirectory() ||
    unitDirInfo.isSymbolicLink() ||
    unitDirInfo.uid !== process.getuid() ||
    (await realpath(unitDir)) !== unitDir
  )
    throw new Error("RECOVERY_REQUIRED: user unit directory is foreign");
  const path = join(unitDir, "coffee-platform.service");
  for (const [name, contents] of [
    ["coffee-platform.service", unit],
    ["coffee-platform-certificates.service", maintenance.service],
    ["coffee-platform-certificates.timer", maintenance.timer],
  ]) {
    const unitPath = join(unitDir, name);
    try {
      await writeFile(unitPath, contents, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const existing = await lstat(unitPath);
      if (
        !existing.isFile() ||
        existing.isSymbolicLink() ||
        existing.uid !== process.getuid() ||
        (await readFile(unitPath, "utf8")) !== contents
      )
        throw new Error("RECOVERY_REQUIRED: existing user unit differs");
    }
  }
  execFileSync("systemctl", ["--user", "daemon-reload"], {
    stdio: "inherit",
    timeout: 30_000,
  });
  execFileSync("systemctl", ["--user", "enable", "coffee-platform.service"], {
    stdio: "inherit",
    timeout: 30_000,
  });
  return {
    releaseDir,
    unit: path,
    state: "enabled",
    maintenance: "prepared-not-enabled",
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    if (process.argv[2] === "--help" && process.argv.length === 3) {
      process.stdout.write(
        "usage: node tools/platform-service.mjs start|stop|status|recover|install|maintain-certificates|dispatch-maintenance\n",
      );
    } else if (process.argv[2] === "start" && process.argv.length === 3) {
      process.stdout.write(`${JSON.stringify(await startLocalRuntime())}\n`);
    } else if (process.argv[2] === "stop" && process.argv.length === 3) {
      process.stdout.write(`${JSON.stringify(await stopLocalRuntime())}\n`);
    } else if (process.argv[2] === "recover" && process.argv.length === 3) {
      process.stdout.write(`${JSON.stringify(await recoverLocalIdentity())}\n`);
    } else if (
      process.argv[2] === "maintain-certificates" &&
      process.argv.length === 3
    ) {
      process.stdout.write(
        `${JSON.stringify(await maintainLocalCertificates())}\n`,
      );
    } else if (
      process.argv[2] === "dispatch-maintenance" &&
      process.argv.length === 3
    ) {
      process.stdout.write(
        `${JSON.stringify(await dispatchCertificateMaintenance())}\n`,
      );
    } else if (process.argv[2] === "install" && process.argv.length === 3) {
      process.stdout.write(
        `${JSON.stringify(await installLocalRuntimeUnit())}\n`,
      );
    } else {
      if (process.argv[2] !== "status" || process.argv.length !== 3)
        throw new Error(
          "usage: node tools/platform-service.mjs start|stop|status|recover|install|maintain-certificates|dispatch-maintenance",
        );
      process.stdout.write(`${JSON.stringify(await inspectLocalRuntime())}\n`);
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
