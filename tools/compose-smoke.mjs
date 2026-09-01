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
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--stub-secrets") options.stubSecrets = true;
    else if (argument === "--provision-empty-postgres-network")
      options.provisionNetwork = true;
    else if (argument === "--no-build") options.noBuild = true;
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
  if (!options.stubSecrets && !process.env.SOPS_AGE_KEY_FILE) {
    throw new Error(
      "SOPS_AGE_KEY_FILE is required for decrypted scoped secrets; use --stub-secrets only for topology smoke without DB/provider proof",
    );
  }
  return options;
}

function composeArgs(projectName, args) {
  return [
    "compose",
    "--project-name",
    projectName,
    "-f",
    COMPOSE_FILE,
    ...args,
  ];
}

function runCompose(projectName, secretsDir, args, options = {}) {
  const env = {
    ...process.env,
    COFFEE_COMPOSE_SECRETS_DIR: secretsDir,
  };
  return execFileSync("docker", composeArgs(projectName, args), {
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
    stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
  });
}

async function writeStubSecret(path, runtime, environment, refs) {
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
    current[segments.at(-1)] = "compose-smoke-placeholder";
  }
  const content = `${JSON.stringify({ schemaVersion: 1, environment, runtime, secrets })}\n`;
  await writeFile(path, content, { encoding: "utf8", mode: 0o400 });
  await chmod(path, 0o400);
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
  const platformConfig = parseYaml(
    await readFile(join(ROOT, "config/platform.yaml"), "utf8"),
    { json: true },
  );
  for (const runtime of RUNTIMES) {
    const path = join(secretsDir, `${runtime}.yaml`);
    if (options.stubSecrets) {
      const service = platformConfig.services[runtime];
      await writeStubSecret(
        path,
        runtime,
        platformConfig.environment,
        service.secretRefs,
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

function ensureExternalNetwork(options) {
  try {
    runDocker(["network", "inspect", EXTERNAL_POSTGRES_NETWORK]);
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
    return true;
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

function serviceRows(projectName, secretsDir) {
  return parseComposePs(
    runCompose(projectName, secretsDir, ["ps", "--all", "--format", "json"]),
  );
}

function assertHealthy(projectName, secretsDir) {
  const rows = serviceRows(projectName, secretsDir);
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

function assertSecretMounts(projectName, secretsDir, rows) {
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
    const modeOutput = runCompose(projectName, secretsDir, [
      "exec",
      "-T",
      runtime,
      "node",
      "-e",
      "const fs=require('node:fs'); const {execFileSync}=require('node:child_process'); const s=fs.statSync(process.env.COFFEE_RUNTIME_SECRETS_FILE); const df=execFileSync('df',['-T','/run/secrets'],{encoding:'utf8'}); console.log(JSON.stringify({mode:s.mode & 0o777,uid:process.getuid(),tmpfs:df.includes('tmpfs')}));",
    ]).trim();
    const mode = JSON.parse(modeOutput.split("\n").at(-1));
    assert.deepEqual(
      mode,
      { mode: 0o400, uid: 1000, tmpfs: true },
      `${runtime} scoped secret ownership/mode/tmpfs mismatch`,
    );
  }
}

async function assertReadiness(projectName, secretsDir) {
  for (const runtime of RUNTIMES) {
    const output = runCompose(projectName, secretsDir, [
      "exec",
      "-T",
      runtime,
      "node",
      "-e",
      "Promise.all(['/health/live', '/health/ready', '/metrics'].map(async (path) => { const response = await fetch('http://127.0.0.1:' + process.env.PORT + path); if (!response.ok) throw new Error(path + ':' + response.status); })).catch(() => process.exit(1));",
    ]).trim();
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

function assertHostExposure(rows) {
  const edgeContainer = JSON.parse(
    runDocker(["inspect", rows.get("edge-gateway").ID]),
  )[0];
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

function assertStopped(projectName, secretsDir) {
  for (const row of serviceRows(projectName, secretsDir)) {
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
  let composeAttempted = false;
  try {
    await materializeSecrets(secretsDir, options);
    runCompose(projectName, secretsDir, ["config", "--quiet"]);
    provisionedNetwork = ensureExternalNetwork(options);
    const upArguments = ["up", "--detach", "--wait"];
    if (!options.noBuild) upArguments.splice(1, 0, "--build");
    composeAttempted = true;
    runCompose(projectName, secretsDir, upArguments, { inherit: true });
    const rows = assertHealthy(projectName, secretsDir);
    assertTelemetryEnvironment(rows);
    assertSecretMounts(projectName, secretsDir, rows);
    await assertReadiness(projectName, secretsDir);
    assertHostExposure(rows);
    if (!options.keep) {
      runCompose(projectName, secretsDir, ["stop", "--timeout", "30"], {
        inherit: true,
      });
      assertStopped(projectName, secretsDir);
    }
    console.log(
      JSON.stringify({
        project: projectName,
        runtimes: RUNTIMES.length,
        kafka: true,
        telemetry: true,
        healthEndpoints: ["/health/live", "/health/ready", "/metrics"],
        stubSecrets: options.stubSecrets,
        dbIntegrationProof: false,
        hostPublish: ["4000:4000"],
        gracefulShutdown: true,
      }),
    );
  } finally {
    if (composeAttempted && !options.keep) {
      try {
        runCompose(projectName, secretsDir, ["down", "--remove-orphans"]);
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
