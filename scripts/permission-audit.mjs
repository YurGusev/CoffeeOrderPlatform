#!/usr/bin/env node
import {access, readFile} from "node:fs/promises";
import {spawn} from "node:child_process";
import {dirname, join, resolve, relative} from "node:path";
import {fileURLToPath} from "node:url";
import {createRequire} from "node:module";

const SCRIPT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PERMISSION_FIELDS = new Set([
  "schemaVersion",
  "runtime",
  "allowNet",
  "allowFsRead",
  "allowFsWrite",
  "allowChildProcess",
  "allowWorker",
  "allowAddons",
  "allowFfi",
]);
const NATIVE_NGINX_RUNTIME = "edge-nginx";
const DEPLOYABLE_RUNTIMES = [
  "edge-gateway", "api-public", "api-internal", "edge-nginx", "customer-service",
  "catalog-service", "catalog-supplier-sync", "catalog-activation-worker",
  "pricing-service", "orders-service", "orders-aroma-preparation",
  "aroma-observer", "aroma-convergence", "aroma-gateway", "realtime-gateway",
];
const NGINX_ALLOWED_HOST_PORTS = ["edge-gateway:4000", "api-public:4050", "realtime-gateway:4401"];
const NGINX_NETWORKS = ["coffee_host_ingress", "coffee_edge_backend"];

const KAFKA_RUNTIMES = new Set([
  "catalog-activation-worker",
  "orders-service",
  "orders-aroma-preparation",
  "aroma-observer",
  "aroma-convergence",
  "realtime-gateway",
]);

function fail(message) {
  const error = new Error(`PERMISSION_POLICY ${message}`);
  error.ruleId = "PERMISSION_POLICY";
  throw error;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    fail(`${path}: invalid JSON (${errorMessage(error)})`);
  }
}

function uniqueStrings(value, field) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    fail(`${field}: non-empty string array required`);
  }
  if (new Set(value).size !== value.length) fail(`${field}: duplicate entries are forbidden`);
}

function exactKeys(value) {
  const keys = new Set(Object.keys(value));
  const missing = [...PERMISSION_FIELDS].filter((key) => !keys.has(key));
  const unknown = [...keys].filter((key) => !PERMISSION_FIELDS.has(key));
  if (missing.length || unknown.length) fail(`manifest keys missing=[${missing.join(",")}] unknown=[${unknown.join(",")}]`);
}

function assertBoolean(value, field) {
  if (typeof value !== "boolean") fail(`${field}: boolean required`);
}

export async function loadPermissionManifest(root, runtime) {
  if (!/^[a-z0-9-]+$/.test(runtime)) fail(`invalid runtime name ${runtime}`);
  const path = join(root, "config", "permissions", `${runtime}.json`);
  const manifest = await readJson(path);
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) fail(`${path}: object required`);
  exactKeys(manifest);
  if (manifest.schemaVersion !== 1) fail(`${runtime}: schemaVersion must be 1`);
  if (manifest.runtime !== runtime) fail(`${path}: runtime does not match filename/argument`);
  for (const field of ["allowNet", "allowFsRead", "allowFsWrite"]) uniqueStrings(manifest[field], `${runtime}.${field}`);
  for (const field of ["allowChildProcess", "allowWorker", "allowAddons", "allowFfi"]) assertBoolean(manifest[field], `${runtime}.${field}`);
  return manifest;
}

async function expectedNetworkAllowlist(root, runtime) {
  const policy = await readJson(join(root, "platform", "launch-v1-connectivity-policy.json"));
  const row = policy.runtimePolicies?.find((entry) => entry.runtime === runtime);
  if (!row) fail(`${runtime}: connectivity policy is missing`);
  return [...row.allowedHostPorts, ...row.allowedExternalEgress];
}

async function validateNativeNginxPolicy(root, policy) {
  const row = policy.runtimePolicies.find((entry) => entry.runtime === NATIVE_NGINX_RUNTIME);
  if (!row) fail("edge-nginx: connectivity policy is missing");
  if (JSON.stringify(row.dockerNetworks) !== JSON.stringify(NGINX_NETWORKS))
    fail("edge-nginx: native upstream network allowlist differs from the approved topology");
  if (JSON.stringify(row.allowedHostPorts) !== JSON.stringify(NGINX_ALLOWED_HOST_PORTS))
    fail("edge-nginx: upstream allowlist differs from the approved topology");
  if (JSON.stringify(row.allowedExternalEgress) !== "[]")
    fail("edge-nginx: external egress is forbidden");
  if (JSON.stringify(row.hostPortPolicy) !== JSON.stringify({default: "deny", allowedPublishedHostPorts: [8443]}))
    fail("edge-nginx: only the loopback public 8443 listener may be published");
  try {
    await access(join(root, "config/permissions/edge-nginx.json"));
    fail("edge-nginx: native runtime must not carry a Node permissions manifest");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export async function validatePermissionManifest(root, runtime) {
  const manifest = await loadPermissionManifest(root, runtime);
  const expected = await expectedNetworkAllowlist(root, runtime);
  if (JSON.stringify(manifest.allowNet) !== JSON.stringify(expected)) {
    fail(`${runtime}: allowNet differs from launch connectivity policy`);
  }
  if (
    manifest.allowChildProcess ||
    manifest.allowWorker ||
    manifest.allowFfi ||
    manifest.allowAddons !== KAFKA_RUNTIMES.has(runtime)
  ) {
    fail(`${runtime}: child process, worker and FFI permissions are deny-by-default; addons are limited to Kafka runtimes`);
  }
  return manifest;
}

export async function validateAllPermissionManifests(root = SCRIPT_ROOT) {
  const policy = await readJson(join(root, "platform", "launch-v1-connectivity-policy.json"));
  const runtimes = policy.runtimePolicies?.map((entry) => entry.runtime);
  if (
    !Array.isArray(runtimes) ||
    JSON.stringify(runtimes) !== JSON.stringify(DEPLOYABLE_RUNTIMES) ||
    new Set(runtimes).size !== DEPLOYABLE_RUNTIMES.length
  ) {
    fail("connectivity policy must contain the exact 14 Node + native nginx runtime set");
  }
  await validateNativeNginxPolicy(root, policy);
  const manifests = [];
  for (const runtime of runtimes) {
    if (runtime === NATIVE_NGINX_RUNTIME) continue;
    manifests.push(await validatePermissionManifest(root, runtime));
  }
  return manifests;
}

function localizeReadPath(path, root) {
  if (root === "/app" || !path.startsWith("/app/")) return path;
  return path === "/app" ? root : join(root, path.slice("/app/".length));
}

export function telemetryHostPort(config) {
  const endpoint = new URL(config.telemetry.collector.otlpEndpoint);
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== 'otel-collector' || endpoint.port !== '4318' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) fail('invalid telemetry ingest endpoint');
  return endpoint.host;
}

export function permissionFlags(manifest, mode, root = "/app", listenPort, telemetryEndpoint) {
  if (mode !== "audit" && mode !== "enforce") fail(`unknown mode ${mode}`);
  const flags = [mode === "audit" ? "--permission-audit" : "--permission"];
  const allowNet = [
    ...manifest.allowNet,
    ...(telemetryEndpoint ? [telemetryEndpoint] : []),
    ...(listenPort ? [`0.0.0.0:${listenPort}`] : []),
  ];
  if (allowNet.length) flags.push(`--allow-net=${allowNet.join(",")}`);
  for (const path of manifest.allowFsRead) flags.push(`--allow-fs-read=${localizeReadPath(path, root)}`);
  for (const path of manifest.allowFsWrite) flags.push(`--allow-fs-write=${localizeReadPath(path, root)}`);
  if (manifest.allowChildProcess) flags.push("--allow-child-process");
  if (manifest.allowWorker) flags.push("--allow-worker");
  if (manifest.allowAddons) flags.push("--allow-addons");
  if (manifest.allowFfi) flags.push("--allow-ffi");
  return flags;
}

function parseArguments(argv) {
  const runtimeIndex = argv.indexOf("--runtime");
  const entryIndex = argv.indexOf("--entry");
  const runtime = runtimeIndex === -1 ? process.env.RUNTIME_NAME : argv[runtimeIndex + 1];
  if (!runtime || entryIndex === -1 || !argv[entryIndex + 1]) {
    fail("usage: permission-audit.mjs [--runtime <runtime>] --entry <entry.ts|entry.mjs> [-- <args...>]");
  }
  const separator = argv.indexOf("--");
  const scriptArguments = separator === -1 ? [] : argv.slice(separator + 1);
  return {runtime, entry: argv[entryIndex + 1], scriptArguments};
}

function resolveEntry(root, runtime, entry) {
  const runtimeRoot = resolve(root, "apps", runtime);
  const path = resolve(root, entry);
  if (path !== resolve(root, "dist/main.js")) {
    const relativePath = relative(runtimeRoot, path);
    if (relativePath === ".." || relativePath.startsWith("../") || relativePath.startsWith("..\\")) {
      fail(`entry must remain inside apps/${runtime}`);
    }
  }
  return path;
}

export async function runPermissionMode(mode, argv, root = SCRIPT_ROOT) {
  const {runtime, entry, scriptArguments} = parseArguments(argv);
  const manifest = await validatePermissionManifest(root, runtime);
  const entryPath = resolveEntry(root, runtime, entry);
  const listenPort = process.env.PORT;
  if (!/^\d+$/.test(listenPort ?? "")) fail(`${runtime}: PORT is required`);
  const appRequire = createRequire(join(root, 'package.json'));
  const runtimeRequire = createRequire(root === '/app'
    ? appRequire.resolve('@coffee-platform/runtime')
    : join(root, 'packages/platform-runtime/package.json'));
  const {load: parseYaml} = runtimeRequire('js-yaml');
  const {parsePlatformConfig} = runtimeRequire('@coffee-platform/config');
  const config = parsePlatformConfig(parseYaml(await readFile(process.env.COFFEE_CONFIG_FILE ?? join(root, 'config/platform.yaml'), 'utf8')));
  const flags = permissionFlags(manifest, mode, root, listenPort, telemetryHostPort(config));
  if (mode === "audit") flags.push("--import", join(SCRIPT_ROOT, "scripts/permission-audit-listener.mjs"));
  const child = spawn(process.execPath, [...flags, entryPath, ...scriptArguments], {
    cwd: root,
    env: {...process.env, NODE_NO_WARNINGS: "1"},
    stdio: "inherit",
  });
  const forwardSigterm = () => child.kill("SIGTERM");
  const forwardSigint = () => child.kill("SIGINT");
  const removeSignalHandlers = () => {
    process.off("SIGTERM", forwardSigterm);
    process.off("SIGINT", forwardSigint);
  };
  process.once("SIGTERM", forwardSigterm);
  process.once("SIGINT", forwardSigint);
  return await new Promise((resolveResult, reject) => {
    child.once("error", (error) => {
      removeSignalHandlers();
      reject(error);
    });
    child.once("exit", (code, signal) => {
      removeSignalHandlers();
      resolveResult({code: code ?? 1, signal});
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = await runPermissionMode("audit", process.argv.slice(2));
    process.exitCode = result.code;
  } catch (error) {
    console.error(`permission audit: FAIL: ${errorMessage(error)}`);
    process.exitCode = 1;
  }
}
