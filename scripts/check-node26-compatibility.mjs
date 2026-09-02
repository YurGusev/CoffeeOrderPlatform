#!/usr/bin/env node
/**
 * Read-only Node 26 foundation compatibility smoke.
 *
 * This checker deliberately does not install packages, connect to external
 * services, launch a browser or run contract generation. It proves that the
 * pinned modules are directly declared, resolve from the workspace and load
 * on the exact Node image. Contract generation is owned by Effect
 * Schema/HttpApi and is not a Node foundation probe.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MATRIX_PATH = "config/node26-compatibility-matrix.json";
const MATRIX_SCHEMA_PATH = "config/node26-compatibility-matrix.schema.json";
const TOOLCHAIN_PATH = "config/toolchain-versions.json";
const EXPECTED_IDS = new Set([
  "fastify",
  "pg",
  "confluent-kafka",
  "opentelemetry-api",
  "fastify-swagger",
  "vitest",
  "playwright",
]);
const EXPECTED_COMPONENTS = Object.freeze({
  fastify: {
    package: "fastify",
    kind: "runtime",
    probe: "fastify-factory",
    required: true,
    authoritative: true,
  },
  pg: {
    package: "pg",
    kind: "runtime",
    probe: "pg-pool",
    required: true,
    authoritative: true,
  },
  "confluent-kafka": {
    package: "@confluentinc/kafka-javascript",
    kind: "runtime-native",
    probe: "confluent-kafka-native",
    required: true,
    authoritative: true,
  },
  "opentelemetry-api": {
    package: "@opentelemetry/api",
    kind: "runtime",
    probe: "opentelemetry-api",
    required: true,
    authoritative: true,
  },
  "fastify-swagger": {
    package: "@fastify/swagger",
    kind: "contract",
    probe: "fastify-swagger-plugin",
    required: true,
    authoritative: true,
  },
  vitest: {
    package: "vitest",
    kind: "test",
    probe: "vitest-cli",
    required: true,
    authoritative: true,
  },
  playwright: {
    package: "playwright",
    kind: "browser-test",
    probe: "playwright-module",
    required: true,
    authoritative: true,
  },
});

export class CompatibilityError extends Error {
  constructor(rule, message) {
    super(`${rule} ${message}`);
    this.name = "CompatibilityError";
    this.ruleId = rule;
  }
}

function fail(rule, message) {
  throw new CompatibilityError(rule, message);
}

async function readJson(root, path, rule = "NODE26-FILE") {
  try {
    return JSON.parse(await readFile(join(root, path), "utf8"));
  } catch (error) {
    fail(rule, `${path}: strict JSON is required: ${error.message}`);
  }
}

async function walkPackageManifests(root, directory) {
  const absolute = join(root, directory);
  if (!existsSync(absolute)) return [];
  const result = [];
  for (const entry of await readdir(absolute, { withFileTypes: true })) {
    const path = join(absolute, entry.name);
    if (entry.isDirectory())
      result.push(...(await walkPackageManifests(path, ".")));
    else if (entry.name === "package.json") result.push(path);
  }
  return result;
}

async function packageManifests(root) {
  return [
    join(root, "package.json"),
    ...(await walkPackageManifests(root, "apps")),
    ...(await walkPackageManifests(root, "packages")),
  ];
}

function dependencies(manifest) {
  return Object.entries({
    ...manifest.dependencies,
    ...manifest.devDependencies,
    ...manifest.optionalDependencies,
    ...manifest.peerDependencies,
  });
}

function directDeclarations(manifestPaths, packageName) {
  return manifestPaths.filter((path) => {
    const manifest = JSON.parse(requireText(path));
    const specifier = dependencies(manifest).find(
      ([name]) => name === packageName,
    )?.[1];
    return typeof specifier === "string" && !specifier.startsWith("workspace:");
  });
}

function requireText(path) {
  // package.json has already been selected from the repository. This helper
  // keeps declaration discovery synchronous and has no network side effect.
  return readFileSync(path, "utf8");
}

function packageRootFromResolved(resolved, packageName) {
  let current = dirname(resolved);
  while (current !== dirname(current)) {
    const manifestPath = join(current, "package.json");
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(requireText(manifestPath));
        if (manifest.name === packageName)
          return { path: manifestPath, manifest };
      } catch {
        // Continue walking when a dependency's package metadata is malformed;
        // the caller reports the normal unresolved/mismatched package error.
      }
    }
    current = dirname(current);
  }
  return null;
}

function resolvePackage(manifestPaths, packageName) {
  const declarationPaths = directDeclarations(manifestPaths, packageName);
  const attempts =
    declarationPaths.length > 0 ? declarationPaths : manifestPaths;
  for (const manifestPath of attempts) {
    try {
      const resolved = createRequire(manifestPath).resolve(packageName);
      const packageRoot = packageRootFromResolved(resolved, packageName);
      if (!packageRoot) continue;
      return {
        declarationPaths,
        declarationPath: declarationPaths[0],
        manifestPath: packageRoot.path,
        manifest: packageRoot.manifest,
        resolved,
      };
    } catch {
      // Some CLI-only packages intentionally do not expose a package entry
      // through exports. Resolve their package metadata through the direct
      // workspace link instead.
      const packageJsonPath = join(
        dirname(manifestPath),
        "node_modules",
        packageName,
        "package.json",
      );
      if (existsSync(packageJsonPath)) {
        try {
          const manifest = JSON.parse(requireText(packageJsonPath));
          return {
            declarationPaths,
            declarationPath: declarationPaths[0],
            manifestPath: packageJsonPath,
            manifest,
            resolved: packageJsonPath,
          };
        } catch {
          // Try the next workspace's node_modules lookup path.
        }
      }
    }
  }
  return { declarationPaths };
}

function registryValue(registry, reference) {
  const prefix = "config/toolchain-versions.json#/";
  if (!reference.startsWith(prefix))
    fail("NODE26-MATRIX-REF", `registry reference is required: ${reference}`);
  const key = reference.slice(prefix.length);
  if (!Object.hasOwn(registry, key) || typeof registry[key] !== "string")
    fail("NODE26-MATRIX-REF", `registry key is missing: ${key}`);
  return registry[key];
}

function validateMatrix(matrix, schema, registry) {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validate = ajv.compile(schema);
  if (!validate(matrix)) {
    fail(
      "NODE26-MATRIX-SCHEMA",
      ajv.errorsText(validate.errors, { separator: "; " }),
    );
  }
  const ids = matrix.components.map((component) => component.id);
  if (
    new Set(ids).size !== ids.length ||
    ids.length !== EXPECTED_IDS.size ||
    ids.some((id) => !EXPECTED_IDS.has(id))
  ) {
    fail(
      "NODE26-MATRIX-COMPONENTS",
      `component ids must be exactly ${[...EXPECTED_IDS].join(", ")}`,
    );
  }
  if (registryValue(registry, matrix.runtime.nodeRef) !== registry.node)
    fail("NODE26-MATRIX-REF", "runtime.nodeRef does not resolve to registry.node");
  if (matrix.policy.generatedContractSource !== "effect-schema-httpapi" || matrix.policy.generatedOpenApi !== "3.1.0")
    fail("NODE26-CODEGEN-POLICY", "contract projection must use Effect Schema/HttpApi and OpenAPI 3.1");
  for (const component of matrix.components) {
    const expected = EXPECTED_COMPONENTS[component.id];
    for (const [key, value] of Object.entries(expected)) {
      if (component[key] !== value) {
        fail(
          "NODE26-MATRIX-COMPONENT",
          `${component.id}.${key}: expected ${JSON.stringify(value)}, got ${JSON.stringify(component[key])}`,
        );
      }
    }
  }
  return matrix;
}

export async function loadCompatibilityMatrix(root = REPO_ROOT) {
  const [matrix, schema] = await Promise.all([
    readJson(root, MATRIX_PATH),
    readJson(root, MATRIX_SCHEMA_PATH),
  ]);
  const registry = await readJson(root, TOOLCHAIN_PATH);
  const validated = validateMatrix(matrix, schema, registry);
  for (const component of validated.components)
    component.version = registryValue(registry, component.registryRef);
  return validated;
}

function assertExact(actual, expected, label) {
  if (actual !== expected)
    fail(
      "NODE26-PIN",
      `${label}: expected ${expected}, got ${actual ?? "missing"}`,
    );
}

function moduleVersion(info, component) {
  assertExact(
    info.manifest?.version,
    component.version,
    `${component.package} installed version`,
  );
  if (!info.declarationPaths?.length)
    fail(
      "NODE26-MANIFEST",
      `${component.package}: direct package declaration is missing`,
    );
  const exactDeclaration = info.declarationPaths.some((path) => {
    const manifest = JSON.parse(requireText(path));
    return dependencies(manifest).some(
      ([name, value]) =>
        name === component.package && value === component.version,
    );
  });
  if (!exactDeclaration)
    fail(
      "NODE26-MANIFEST",
      `${component.package}: exact ${component.version} declaration is missing`,
    );
}

async function loadModule(info, component) {
  try {
    return await import(pathToFileURL(info.resolved).href);
  } catch (error) {
    fail(
      "NODE26-LOAD",
      `${component.package}@${component.version}: ${error.message}`,
    );
  }
}

function executableCandidates(root, info, name) {
  const candidates = [
    join(root, "node_modules", ".bin", name),
    info.declarationPath &&
      join(dirname(info.declarationPath), "node_modules", ".bin", name),
  ].filter(Boolean);
  return candidates.filter(
    (path, index) => candidates.indexOf(path) === index && existsSync(path),
  );
}

function runExecutable(path, args, root) {
  return spawnSync(path, args, {
    cwd: root,
    encoding: "utf8",
    timeout: 30000,
    env: { ...process.env, CI: "1" },
  });
}

async function probeFastify(info, component) {
  const module = await loadModule(info, component);
  const factory = module.default ?? module.fastify ?? module;
  if (typeof factory !== "function")
    fail("NODE26-PROBE", "fastify factory export is not callable");
  const app = factory({ logger: false });
  await app.ready();
  await app.close();
  return { factory: "callable", lifecycle: "ready-close" };
}

async function probePg(info, component) {
  const module = await loadModule(info, component);
  const Pool = module.Pool ?? module.default?.Pool;
  if (typeof Pool !== "function")
    fail("NODE26-PROBE", "pg Pool export is not a constructor");
  const pool = new Pool({ max: 1, connectionTimeoutMillis: 25 });
  await pool.end();
  return { pool: "construct-close" };
}

async function probeConfluentKafka(info, component) {
  const module = await loadModule(info, component);
  const Kafka = module.KafkaJS?.Kafka ?? module.default?.KafkaJS?.Kafka;
  if (typeof Kafka !== "function")
    fail(
      "NODE26-NATIVE",
      "KafkaJS.Kafka export is not available after native module load",
    );
  const NativeProducer =
    module.RdKafka?.Producer ?? module.default?.RdKafka?.Producer;
  if (typeof NativeProducer !== "function")
    fail("NODE26-NATIVE", "RdKafka.Producer native export is not available");
  // Importing the package loads the .node addon; constructing the callback API
  // creates the librdkafka client without connecting to a broker.
  const nativeProducer = new NativeProducer({
    "metadata.broker.list": "127.0.0.1:1",
  });
  if (!nativeProducer || typeof nativeProducer !== "object")
    fail("NODE26-NATIVE", "librdkafka Producer construction failed");
  const kafka = new Kafka();
  const producer = kafka.producer({ "bootstrap.servers": "127.0.0.1:1" });
  if (!producer || typeof producer !== "object")
    fail("NODE26-NATIVE", "KafkaJS producer construction failed");
  return {
    binding: "loaded",
    nativeProducer: "construct",
    kafka: "construct",
    brokerConnection: "not attempted",
  };
}

async function probeOpenTelemetry(info, component) {
  const module = await loadModule(info, component);
  if (
    typeof module.trace?.getTracer !== "function" ||
    typeof module.metrics?.getMeter !== "function"
  ) {
    fail("NODE26-PROBE", "OpenTelemetry trace/metrics API exports are missing");
  }
  const span = module.trace
    .getTracer("coffee-platform-node26")
    .startSpan("compatibility-smoke");
  span.end();
  return { trace: "getTracer-start-end", metrics: "getMeter" };
}

async function probeSwagger(info, component) {
  const module = await loadModule(info, component);
  const plugin = module.default ?? module;
  if (typeof plugin !== "function")
    fail("NODE26-PROBE", "@fastify/swagger plugin export is not callable");
  return { plugin: "callable", contract: "effect-schema-httpapi" };
}

async function probePlaywright(info, component) {
  const module = await loadModule(info, component);
  const playwright = module.default ?? module;
  if (
    typeof playwright.chromium?.executablePath !== "function" ||
    typeof playwright.firefox?.executablePath !== "function"
  ) {
    fail(
      "NODE26-PROBE",
      "Playwright chromium/firefox module exports are missing",
    );
  }
  return { module: "loaded", browserBinaryLaunch: "not attempted" };
}

function probeCli(root, info, component, name) {
  const executable = executableCandidates(root, info, name)[0];
  if (!executable)
    return { status: "missing", reason: `${name} executable is not installed` };
  const result = runExecutable(executable, ["--version"], root);
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (result.status === 0 && output.length > 0)
    return { status: "passed", output };
  return {
    status: "failed",
    output: output || `exit ${result.status ?? "unknown"}`,
  };
}

const MODULE_PROBES = Object.freeze({
  "fastify-factory": probeFastify,
  "pg-pool": probePg,
  "confluent-kafka-native": probeConfluentKafka,
  "opentelemetry-api": probeOpenTelemetry,
  "fastify-swagger-plugin": probeSwagger,
  "playwright-module": probePlaywright,
});

async function probeComponent(root, component, info) {
  if (component.probe === "vitest-cli")
    return probeCli(root, info, component, "vitest");
  const probe = MODULE_PROBES[component.probe];
  if (!probe)
    fail(
      "NODE26-PROBE",
      `${component.id}: unsupported probe ${component.probe}`,
    );
  return probe(info, component);
}

function componentRecord(root, component, info) {
  return {
    id: component.id,
    package: component.package,
    expectedVersion: component.version,
    required: component.required,
    authoritative: component.authoritative,
    declaredIn: (info.declarationPaths ?? []).map((path) =>
      relative(root, path).replaceAll("\\", "/"),
    ),
  };
}

export async function checkNode26Compatibility(root = REPO_ROOT, options = {}) {
  const resolvedRoot = resolve(root);
  const matrix = await loadCompatibilityMatrix(resolvedRoot);
  const toolchain = await readJson(resolvedRoot, TOOLCHAIN_PATH);
  assertExact(
    process.versions.node,
    registryValue(toolchain, matrix.runtime.nodeRef),
    "running Node version",
  );
  assertExact(process.platform, matrix.runtime.platform, "running platform");
  assertExact(
    process.arch,
    matrix.runtime.architecture,
    "running architecture",
  );
  const manifests = await packageManifests(resolvedRoot);
  const results = [];
  const failures = [];
  for (const component of matrix.components) {
    assertExact(registryValue(toolchain, component.registryRef), component.version, `toolchain ${component.package}`);
    const info = resolvePackage(manifests, component.package);
    const result = componentRecord(resolvedRoot, component, info);
    if (!info.resolved) {
      result.status = component.required ? "missing" : "blocked";
      result.reason =
        "package does not resolve from a directly declaring workspace";
      if (component.required)
        failures.push(
          `${component.package}: package is not installed or directly declared`,
        );
      results.push(result);
      continue;
    }
    try {
      moduleVersion(info, component);
      if (options.skipNativeLoad && component.kind === "runtime-native") {
        result.status = "deferred-to-image-build";
        result.details = { nativeLoad: "validated-by-Dockerfile-build" };
        results.push(result);
        continue;
      }
      result.details = await probeComponent(resolvedRoot, component, info);
      result.status = "passed";
      if (
        component.required &&
        result.details.status &&
        result.details.status !== "passed"
      )
        failures.push(
          `${component.package}: ${result.details.reason ?? result.details.status}`,
        );
    } catch (error) {
      result.status = component.authoritative ? "failed" : "blocked";
      result.reason = error.message;
      if (component.required) failures.push(error.message);
    }
    results.push(result);
  }
  const report = {
    node: process.versions.node,
    platform: `${process.platform}-${process.arch}`,
    matrix: MATRIX_PATH,
    components: results,
    candidate: null,
    status: failures.length === 0 ? "passed" : "failed",
    failures,
  };
  if (failures.length > 0) {
    const error = new CompatibilityError(
      "NODE26-COMPATIBILITY",
      failures.join("; ") || "candidate codegen is not accepted",
    );
    error.report = report;
    throw error;
  }
  return report;
}

function parseArgs(argv) {
  const rootIndex = argv.indexOf("--root");
  return {
    root: rootIndex >= 0 ? resolve(argv[rootIndex + 1]) : REPO_ROOT,
    json: argv.includes("--json"),
    matrixOnly: argv.includes("--matrix-only"),
    skipNativeLoad: argv.includes("--skip-native-load"),
    strictCandidate: argv.includes("--strict-candidate"),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  try {
    if (args.matrixOnly) {
      await loadCompatibilityMatrix(args.root);
      console.log(
        args.json
          ? JSON.stringify({ matrix: MATRIX_PATH, status: "passed" })
          : `Node 26 compatibility matrix: passed (${MATRIX_PATH})`,
      );
    } else {
      const report = await checkNode26Compatibility(args.root, {
        skipNativeLoad: args.skipNativeLoad,
        strictCandidate: args.strictCandidate,
      });
      console.log(
        args.json
          ? JSON.stringify(report)
          : "Node 26 compatibility: passed; canonical registry projection verified",
      );
    }
  } catch (error) {
    if (args.json && error.report) console.error(JSON.stringify(error.report));
    else console.error(`Node 26 compatibility: FAIL: ${error.message}`);
    process.exitCode = 1;
  }
}
