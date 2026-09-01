#!/usr/bin/env node
import {readFile} from "node:fs/promises";
import {spawn} from "node:child_process";
import {dirname, join, resolve, relative} from "node:path";
import {fileURLToPath} from "node:url";

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
  if (!Array.isArray(runtimes) || runtimes.length !== 15 || new Set(runtimes).size !== 15) {
    fail("connectivity policy must contain the exact 15 runtime set");
  }
  const manifests = [];
  for (const runtime of runtimes) manifests.push(await validatePermissionManifest(root, runtime));
  return manifests;
}

function localizeReadPath(path, root) {
  if (root === "/app" || !path.startsWith("/app/")) return path;
  return path === "/app" ? root : join(root, path.slice("/app/".length));
}

export function permissionFlags(manifest, mode, root = "/app", listenPort) {
  if (mode !== "audit" && mode !== "enforce") fail(`unknown mode ${mode}`);
  const flags = [mode === "audit" ? "--permission-audit" : "--permission"];
  const allowNet = [
    ...manifest.allowNet,
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
  const flags = permissionFlags(manifest, mode, root, listenPort);
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
