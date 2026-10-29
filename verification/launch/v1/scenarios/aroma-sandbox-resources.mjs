#!/usr/bin/env node

import { execFile } from "node:child_process";
import { lstat, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { load as parseYaml } from "js-yaml";

const execFileAsync = promisify(execFile);
const PROJECT_ROOT = resolve(
  fileURLToPath(new URL("../../../..", import.meta.url)),
);
const RUN_ID = /^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{7}$/;
const LABEL_RUN = "coffee.g16.run-id";
const LABEL_OWNER = "coffee.g16.owner";
const OWNER_LABEL = "aroma-sandbox-resources-v1";
const OWNERS = Object.freeze(["catalog", "orders", "integration"]);
const RUNTIME_OWNERS = Object.freeze({
  "aroma-gateway": "integration",
  "aroma-convergence": "orders",
  "orders-aroma-preparation": "orders",
  "catalog-supplier-sync": "catalog",
  "catalog-activation-worker": "catalog",
  "catalog-service": "catalog",
});
const STARTUP_INTERVAL_MS = 250;
const MAX_OUTPUT_BYTES = 64 * 1024;

function fail(code) {
  throw new Error(`AROMA-SANDBOX-RESOURCES ${code}`);
}

function normalizedRunId(value) {
  if (typeof value !== "string" || !RUN_ID.test(value)) fail("RUN_ID_INVALID");
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  return normalized;
}

export function aromaSandboxResourceNames(runId) {
  const normalized = normalizedRunId(runId);
  const databases = Object.fromEntries(
    OWNERS.map((owner) => {
      const name = `coffee_verify_${normalized}_${owner}`;
      if (name.length > 63 || !/^[a-z][a-z0-9_]*$/.test(name))
        fail("DATABASE_NAME_INVALID");
      return [owner, name];
    }),
  );
  const suffix = normalized.replaceAll("_", "-");
  return {
    network: `coffee-g16-${suffix}-net`,
    container: `coffee-g16-${suffix}-postgres`,
    databases,
  };
}

function resourceOwner(resourceLocator, runId) {
  if (
    !resourceLocator ||
    resourceLocator.runId !== runId ||
    resourceLocator.host !== "127.0.0.1"
  )
    fail("RESOURCE_LOCATOR_INVALID");
  const expected = aromaSandboxResourceNames(runId);
  const ids = resourceLocator.resourceIDs;
  if (
    ids?.runId !== runId ||
    ids.container?.name !== expected.container ||
    ids.network?.name !== expected.network ||
    !/^[a-f0-9]{64}$/i.test(ids.container?.id ?? "") ||
    !/^[a-f0-9]{64}$/i.test(ids.network?.id ?? "") ||
    !/^sha256:[a-f0-9]{64}$/.test(ids.imageId ?? "") ||
    !Number.isInteger(resourceLocator.port) ||
    resourceLocator.port < 1 ||
    resourceLocator.port > 65535 ||
    typeof ids.databaseSystemIdentifier !== "string" ||
    !ids.databaseSystemIdentifier
  )
    fail("RESOURCE_LOCATOR_INVALID");
  for (const owner of OWNERS) {
    if (resourceLocator.databases?.[owner] !== expected.databases[owner])
      fail("RESOURCE_LOCATOR_DATABASE_INVALID");
  }
  return expected;
}

async function assertLiveOwnedResources(
  resourceLocator,
  runId,
  root = PROJECT_ROOT,
) {
  const names = resourceOwner(resourceLocator, runId);
  const container = await inspectExact("container", names.container);
  const network = await inspectExact("network", names.network);
  const ids = resourceLocator.resourceIDs;
  const toolchain = JSON.parse(
    await readFile(join(root, "config/toolchain-versions.json"), "utf8"),
  );
  if (ids.image !== `postgres:${toolchain.postgresql}-alpine`)
    fail("POSTGRES_IMAGE_PIN_MISMATCH");
  if (
    container?.Id !== ids.container.id ||
    container.Config?.Labels?.[LABEL_RUN] !== runId ||
    container.Config?.Labels?.[LABEL_OWNER] !== OWNER_LABEL ||
    container.Config?.Image !== ids.image ||
    container.State?.Running !== true
  )
    fail("CONTAINER_OWNERSHIP_MISMATCH");
  if (
    network?.Id !== ids.network.id ||
    network.Labels?.[LABEL_RUN] !== runId ||
    network.Labels?.[LABEL_OWNER] !== OWNER_LABEL
  )
    fail("NETWORK_OWNERSHIP_MISMATCH");
  if (
    container.HostConfig?.NetworkMode !== names.network ||
    Object.keys(container.NetworkSettings?.Networks ?? {}).join(",") !==
      names.network
  )
    fail("POSTGRES_NETWORK_ISOLATION_MISMATCH");
  const bindings = container.NetworkSettings?.Ports?.["5432/tcp"];
  if (
    !Array.isArray(bindings) ||
    bindings.length !== 1 ||
    bindings[0].HostIp !== "127.0.0.1" ||
    Number(bindings[0].HostPort) !== resourceLocator.port
  )
    fail("POSTGRES_BINDING_MISMATCH");
  if (
    (await docker(["image", "inspect", ids.image, "--format", "{{.Id}}"])) !==
    ids.imageId
  )
    fail("POSTGRES_IMAGE_CHANGED");
  return names;
}

async function readScopedRuntimeSecret(root, path, runtime, expectedUsername) {
  const absolute = resolve(path ?? "");
  if (
    !absolute.startsWith("/dev/shm/coffee-g16-secrets-") ||
    (await realpath(absolute).catch(() => null)) !== absolute
  )
    fail("SCOPED_SECRET_LOCATOR_INVALID");
  if (
    absolute.split("/").at(-1) !== "coffee-platform.yaml" ||
    absolute.split("/").at(-2) !== runtime ||
    !absolute.split("/").at(-3).startsWith("coffee-g16-secrets-")
  )
    fail("SCOPED_SECRET_LOCATOR_INVALID");
  const metadata = await lstat(absolute);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== process.getuid() ||
    (metadata.mode & 0o777) !== 0o400
  )
    fail("SCOPED_SECRET_FILE_INVALID");
  const document = parseYaml(await readFile(absolute, "utf8"));
  if (document?.runtime !== runtime || !document?.secrets)
    fail("SCOPED_SECRET_SCOPE_MISMATCH");
  const config = parseYaml(
    await readFile(join(root, "config/platform.yaml"), "utf8"),
  );
  const service = config.services?.[runtime];
  const reference = service?.secretRefs?.filter(
    (ref) => typeof ref === "string" && ref.startsWith("postgres."),
  );
  if (!Array.isArray(reference) || reference.length !== 1)
    fail("SCOPED_SECRET_DB_REF_INVALID");
  let credential = document.secrets;
  for (const part of reference[0].split(".")) credential = credential?.[part];
  if (
    document.environment !== config.environment ||
    credential?.username !== expectedUsername ||
    typeof credential.password !== "string" ||
    !credential.password
  )
    fail("SCOPED_SECRET_DB_CREDENTIAL_INVALID");
  return { credential, service, config };
}

export async function openAromaSandboxDatabase({
  root = PROJECT_ROOT,
  context,
  runtime,
  resourceLocator,
} = {}) {
  const runId = context?.runId;
  if (!Object.hasOwn(RUNTIME_OWNERS, runtime)) fail("RUNTIME_INVALID");
  const names = await assertLiveOwnedResources(resourceLocator, runId, root);
  const owner = RUNTIME_OWNERS[runtime];
  const expectedDatabase = names.databases[owner];
  const runtimeLocator = resourceLocator.runtimes?.[runtime];
  if (
    !runtimeLocator ||
    runtimeLocator.owner !== owner ||
    runtimeLocator.database !== expectedDatabase ||
    runtimeLocator.endpoint?.host !== "127.0.0.1" ||
    runtimeLocator.endpoint?.port !== resourceLocator.port ||
    runtimeLocator.endpoint?.database !== expectedDatabase
  )
    fail("RUNTIME_LOCATOR_INVALID");
  const ownership = JSON.parse(
    await readFile(
      join(resolve(root), "config/database-ownership.json"),
      "utf8",
    ),
  );
  const claim = ownership.runtimeClaims?.find(
    (entry) => entry.runtime === runtime,
  );
  if (
    !claim ||
    claim.database !== `coffee_platform_${owner}` ||
    claim.secretRef === null ||
    claim.role !== runtimeLocator.username
  )
    fail("RUNTIME_ROLE_MISMATCH");
  const { credential, service, config } = await readScopedRuntimeSecret(
    resolve(root),
    runtimeLocator.scopedSecretsFile,
    runtime,
    claim.role,
  );
  const { createDatabase } = await import(
    pathToFileURL(
      join(resolve(root), "packages/platform-database/dist/index.js"),
    ).href
  );
  return createDatabase({
    owner: runtime,
    database: expectedDatabase,
    allowedDatabase: expectedDatabase,
    host: "127.0.0.1",
    port: resourceLocator.port,
    user: credential.username,
    password: credential.password,
    ssl: false,
    pool: service.dbPool,
    shutdownGraceMs: config.platform.shutdownGraceMs,
  });
}

function dockerOperation(args) {
  const subjects = new Set(["container", "network", "image"]);
  const verbs = new Set(["inspect", "create", "rm", "run", "exec"]);
  if (["run", "exec"].includes(args[0])) return args[0];
  return subjects.has(args[0]) && verbs.has(args[1])
    ? `${args[0]}-${args[1]}`
    : "other";
}

export function isExpectedMissingDockerInspect(error, kind, name) {
  if (
    error.code !== 1 ||
    error.signal ||
    error.killed ||
    !["container", "network"].includes(kind) ||
    !/^[a-z][a-z0-9-]*$/.test(name)
  )
    return false;
  const stderr = (error.stderr ?? "").trim();
  const stdout = (error.stdout ?? "").trim();
  const expectedStderr =
    kind === "network"
      ? [`Error response from daemon: network ${name} not found`]
      : [
          `Error response from daemon: No such container: ${name}`,
          `Error: No such object: ${name}`,
        ];
  return expectedStderr.includes(stderr) && (stdout === "" || stdout === "[]");
}

async function docker(args, { timeout = 10_000, missingTarget } = {}) {
  try {
    const result = await execFileAsync("docker", args, {
      encoding: "utf8",
      timeout,
      maxBuffer: MAX_OUTPUT_BYTES,
      windowsHide: true,
    });
    return result.stdout.trim();
  } catch (error) {
    if (
      missingTarget &&
      args[0] === missingTarget.kind &&
      args[1] === "inspect" &&
      args[2] === missingTarget.name &&
      isExpectedMissingDockerInspect(
        error,
        missingTarget.kind,
        missingTarget.name,
      )
    )
      return null;
    const category =
      error.killed || error.code === "ETIMEDOUT"
        ? "TIMEOUT"
        : error.code === "ENOENT"
          ? "UNAVAILABLE"
          : Number.isInteger(error.code)
            ? `EXIT_${error.code}`
            : error.signal
              ? "SIGNAL"
              : "SPAWN_ERROR";
    fail(`DOCKER_COMMAND_FAILED_${dockerOperation(args)}_${category}`);
  }
}

async function inspectExact(kind, name) {
  const output = await docker([kind, "inspect", name], {
    missingTarget: { kind, name },
  });
  if (output === null) return null;
  try {
    return JSON.parse(output)[0];
  } catch {
    fail("DOCKER_INSPECT_INVALID");
  }
}

async function assertTmpfs() {
  const path = "/dev/shm";
  if ((await realpath(path).catch(() => null)) !== path)
    fail("TMPFS_PATH_INVALID");
  const mounts = await readFile("/proc/mounts", "utf8").catch(() => "");
  if (
    !mounts
      .split("\n")
      .some(
        (line) => line.split(" ")[1] === path && line.split(" ")[2] === "tmpfs",
      )
  )
    fail("TMPFS_UNAVAILABLE");
}

async function verifyOwnership(resource, runId, id) {
  if (
    !resource ||
    resource.Id !== id ||
    resource.Config?.Labels?.[LABEL_RUN] !== runId ||
    resource.Config?.Labels?.[LABEL_OWNER] !== OWNER_LABEL
  ) {
    fail("RESOURCE_OWNERSHIP_MISMATCH");
  }
}

export async function prepareAromaSandboxResources({
  root = PROJECT_ROOT,
  context,
} = {}) {
  const runId = context?.runId;
  const names = aromaSandboxResourceNames(runId);
  const absoluteRoot = resolve(root);
  const config = parseYaml(
    await readFile(join(absoluteRoot, "config/platform.yaml"), "utf8"),
  );
  const toolchain = JSON.parse(
    await readFile(
      join(absoluteRoot, "config/toolchain-versions.json"),
      "utf8",
    ),
  );
  const policy = config.verification?.aromaSandbox;
  if (config.environment === "production")
    fail("PRODUCTION_ENVIRONMENT_DENIED");
  if (!policy) fail("SANDBOX_POLICY_ABSENT");
  if (
    policy.resourceLimits?.postgresMemoryMiB !== 1024 ||
    policy.resourceLimits?.postgresTmpfsMiB !== 512
  )
    fail("RESOURCE_LIMITS_INVALID");
  if (
    typeof toolchain.postgresql !== "string" ||
    !/^\d+\.\d+(?:\.\d+)?$/.test(toolchain.postgresql)
  )
    fail("POSTGRES_VERSION_PIN_INVALID");
  const image = `postgres:${toolchain.postgresql}-alpine`;
  const imageInspect = await docker([
    "image",
    "inspect",
    image,
    "--format",
    "{{.Id}}",
  ]);
  if (!/^sha256:[a-f0-9]{64}$/.test(imageInspect))
    fail("POSTGRES_IMAGE_ID_INVALID");
  await assertTmpfs();
  if (
    (await inspectExact("container", names.container)) ||
    (await inspectExact("network", names.network))
  )
    fail("RESOURCE_NAME_ALREADY_EXISTS");

  const secretDirectory = await mkdtemp("/dev/shm/coffee-g16-secrets-");
  let network;
  let container;
  let closed = false;
  const databaseAdapters = new Set();
  const migratorClients = new Set();
  const labelArgs = [
    "--label",
    `${LABEL_RUN}=${runId}`,
    "--label",
    `${LABEL_OWNER}=${OWNER_LABEL}`,
  ];
  const cleanup = async () => {
    if (closed) return { removed: true };
    const errors = [];
    for (const client of migratorClients)
      await client
        .end()
        .catch(() => errors.push("MIGRATOR_CLIENT_STOP_FAILED"));
    for (const database of databaseAdapters)
      await database.resource
        .stop(AbortSignal.timeout(config.platform.shutdownGraceMs))
        .catch(() => errors.push("RUNTIME_DATABASE_STOP_FAILED"));
    try {
      const actual = await inspectExact("container", names.container);
      if (actual) {
        if (!container) fail("CONTAINER_OWNERSHIP_UNKNOWN");
        await verifyOwnership(actual, runId, container.Id);
        if (actual.Mounts?.some((mount) => mount.Type === "volume"))
          fail("UNEXPECTED_VOLUME_ATTACHED");
        await docker(["rm", "--force", names.container], {
          timeout: config.platform.shutdownGraceMs,
        });
        if (await inspectExact("container", names.container))
          fail("CONTAINER_CLEANUP_FAILED");
      }
    } catch (error) {
      errors.push(error.message);
    }
    try {
      const actual = await inspectExact("network", names.network);
      if (actual) {
        if (
          !network ||
          actual.Id !== network.Id ||
          actual.Labels?.[LABEL_RUN] !== runId ||
          actual.Labels?.[LABEL_OWNER] !== OWNER_LABEL
        )
          fail("NETWORK_OWNERSHIP_MISMATCH");
        if (Object.keys(actual.Containers ?? {}).length !== 0)
          fail("NETWORK_STILL_IN_USE");
        await docker(["network", "rm", names.network], {
          timeout: config.platform.shutdownGraceMs,
        });
        if (await inspectExact("network", names.network))
          fail("NETWORK_CLEANUP_FAILED");
      }
    } catch (error) {
      errors.push(error.message);
    }
    try {
      if (
        (await realpath(secretDirectory).catch(() => null)) !==
          secretDirectory ||
        !secretDirectory.startsWith("/dev/shm/coffee-g16-secrets-")
      )
        fail("SECRET_DIRECTORY_OWNERSHIP_MISMATCH");
      await rm(secretDirectory, { recursive: true, force: true });
    } catch (error) {
      errors.push(error.message);
    }
    closed = errors.length === 0;
    if (errors.length)
      throw new Error(
        `AROMA-SANDBOX-RESOURCES CLEANUP_FAILED: ${errors.join(", ")}`,
      );
    return { removed: true };
  };

  try {
    const secretBootstrap = await import(
      new URL("../../../../tools/config-bootstrap/index.mjs", import.meta.url)
    );
    const secrets = await secretBootstrap.materializeAromaSandboxSecrets({
      root: absoluteRoot,
      runId,
      outputDir: secretDirectory,
    });
    const networkId = await docker([
      "network",
      "create",
      ...labelArgs,
      names.network,
    ]);
    network = { Id: networkId };
    const createdNetwork = await inspectExact("network", names.network);
    if (
      !createdNetwork ||
      createdNetwork.Id !== networkId ||
      createdNetwork.Labels?.[LABEL_RUN] !== runId ||
      createdNetwork.Labels?.[LABEL_OWNER] !== OWNER_LABEL
    )
      fail("NETWORK_OWNERSHIP_INVALID");
    network = createdNetwork;
    const tmpfs = `/var/lib/postgresql/data:rw,noexec,nosuid,size=${policy.resourceLimits.postgresTmpfsMiB}m,mode=0700`;
    const containerId = await docker(
      [
        "run",
        "--detach",
        "--pull=never",
        "--name",
        names.container,
        "--network",
        names.network,
        "--memory",
        `${policy.resourceLimits.postgresMemoryMiB}m`,
        "--memory-swap",
        `${policy.resourceLimits.postgresMemoryMiB}m`,
        "--tmpfs",
        tmpfs,
        "--mount",
        `type=bind,source=${secrets.adminPasswordFile},target=/run/secrets/postgres-admin,readonly`,
        "--env",
        "POSTGRES_PASSWORD_FILE=/run/secrets/postgres-admin",
        "--publish",
        "127.0.0.1::5432",
        ...labelArgs,
        image,
      ],
      { timeout: config.platform.shutdownGraceMs },
    );
    container = { Id: containerId };
    const createdContainer = await inspectExact("container", names.container);
    if (createdContainer?.Id !== containerId)
      fail("CONTAINER_OWNERSHIP_INVALID");
    container = createdContainer;
    if (
      !container ||
      container.Config?.Labels?.[LABEL_RUN] !== runId ||
      container.Config?.Labels?.[LABEL_OWNER] !== OWNER_LABEL ||
      container.Config?.Image !== image
    )
      fail("CONTAINER_OWNERSHIP_INVALID");
    const started = Date.now();
    const deadline = started + config.platform.shutdownGraceMs;
    let ready = false;
    while (Date.now() < deadline) {
      try {
        await docker(
          [
            "exec",
            names.container,
            "pg_isready",
            "-U",
            "postgres",
            "-d",
            "postgres",
          ],
          { timeout: 2_000 },
        );
        ready = true;
        break;
      } catch {
        await new Promise((resolvePromise) =>
          setTimeout(resolvePromise, STARTUP_INTERVAL_MS),
        );
      }
    }
    if (!ready) fail("POSTGRES_STARTUP_TIMEOUT");
    const readyContainer = await inspectExact("container", names.container);
    if (
      readyContainer?.Id !== container.Id ||
      readyContainer.Config?.Labels?.[LABEL_RUN] !== runId ||
      readyContainer.Config?.Labels?.[LABEL_OWNER] !== OWNER_LABEL ||
      readyContainer.Config?.Image !== image ||
      readyContainer.State?.Running !== true ||
      readyContainer.HostConfig?.NetworkMode !== names.network
    )
      fail("CONTAINER_CHANGED_AFTER_STARTUP");
    const readyNetwork = await inspectExact("network", names.network);
    if (
      readyNetwork?.Id !== network.Id ||
      readyNetwork.Labels?.[LABEL_RUN] !== runId ||
      readyNetwork.Labels?.[LABEL_OWNER] !== OWNER_LABEL
    )
      fail("NETWORK_CHANGED_AFTER_STARTUP");
    container = readyContainer;
    network = readyNetwork;
    const portOutput = container.NetworkSettings?.Ports?.["5432/tcp"];
    if (
      !Array.isArray(portOutput) ||
      portOutput.length !== 1 ||
      portOutput[0].HostIp !== "127.0.0.1"
    ) {
      const bindings = Array.isArray(portOutput) ? portOutput.slice(0, 4) : [];
      const hostIPs = [
        ...new Set(
          bindings.map(({ HostIp }) =>
            typeof HostIp === "string" && /^[0-9a-fA-F:.]+$/.test(HostIp)
              ? HostIp
              : "invalid",
          ),
        ),
      ];
      const hostPorts = bindings.map(({ HostPort }) =>
        Number.isInteger(Number(HostPort)) &&
        Number(HostPort) > 0 &&
        Number(HostPort) <= 65535
          ? Number(HostPort)
          : "invalid",
      );
      fail(
        `POSTGRES_BINDING_INVALID bindings=${Array.isArray(portOutput) ? portOutput.length : "invalid"} hostIPs=${hostIPs.join(",") || "none"} hostPorts=${hostPorts.join(",") || "none"}`,
      );
    }
    const port = Number(portOutput[0].HostPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      fail("POSTGRES_PORT_INVALID");

    const provisioned = await secretBootstrap.provisionAromaSandboxDatabases({
      root: absoluteRoot,
      runId,
      host: "127.0.0.1",
      port,
      outputDir: secretDirectory,
    });
    const resourceIDs = {
      runId,
      image,
      imageId: imageInspect,
      container: { name: names.container, id: container.Id, label: LABEL_RUN },
      network: { name: names.network, id: network.Id, label: LABEL_RUN },
      databaseSystemIdentifier: provisioned.systemIdentifier,
    };
    const runtimes = {};
    for (const owner of OWNERS) {
      for (const runtime of provisioned.databases[owner].runtimes) {
        if (!runtime.scopedSecretRef) continue;
        runtimes[runtime.runtime] = {
          owner,
          endpoint: {
            host: "127.0.0.1",
            port,
            database: names.databases[owner],
          },
          database: names.databases[owner],
          username: runtime.role,
          scopedSecretsFile: runtime.scopedSecretRef,
        };
      }
    }
    const resourceLocator = {
      runId,
      host: "127.0.0.1",
      port,
      databases: names.databases,
      resourceIDs,
      runtimes,
    };
    const openDatabase = async (runtime) => {
      const database = await openAromaSandboxDatabase({
        root: absoluteRoot,
        context,
        runtime,
        resourceLocator,
      });
      databaseAdapters.add(database);
      return database;
    };
    const openMigrator = async (owner) => {
      await assertLiveOwnedResources(resourceLocator, runId, absoluteRoot);
      const client = await secretBootstrap.openAromaSandboxMigrator({
        root: absoluteRoot,
        runId,
        owner,
        host: "127.0.0.1",
        port,
        expectedSystemIdentifier: provisioned.systemIdentifier,
      });
      migratorClients.add(client);
      return client;
    };
    const finalizeDatabase = async (owner) => {
      await assertLiveOwnedResources(resourceLocator, runId, absoluteRoot);
      return secretBootstrap.finalizeAromaSandboxDatabase({
        root: absoluteRoot,
        runId,
        owner,
        host: "127.0.0.1",
        port,
        expectedSystemIdentifier: provisioned.systemIdentifier,
      });
    };
    return {
      resourceIDs,
      runtimes,
      resourceLocator,
      openDatabase,
      openMigrator,
      finalizeDatabase,
      cleanup,
    };
  } catch (error) {
    let cleanupError;
    try {
      await cleanup();
    } catch (failure) {
      cleanupError = failure;
    }
    if (cleanupError)
      throw new Error(`${error.message}; ${cleanupError.message}`);
    throw error;
  }
}
