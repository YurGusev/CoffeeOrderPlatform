import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const POLICY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_FILE_RE = /\.(?:ts|tsx|mts|cts)$/;
const IMPORT_RE = /\b(?:from\s*|import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/g;

const APPROVED_INTEROP_PREFIXES = Object.freeze([
  "packages/platform-runtime/src/interop/",
  "packages/platform-database/src/interop/",
  "packages/platform-kafka-runtime/src/interop/",
  "packages/platform-observability/src/interop/",
  "packages/platform-security/src/interop/",
  "apps/web/src/runtime/",
]);

const DURABLE_PATH_RE = /(?:^|\/)(?:platform-(?:idempotency|inbox|outbox)|[^/]*(?:attempt|lease|fence|reservation|journal)[^/]*)(?:\/|$)/i;
const DURABLE_MEMORY_RE = /\bnew\s+Map\s*\(|\b(?:Ref|SynchronizedRef)\.make\s*\(|\bQueue\.(?:bounded|unbounded|make)\s*\(|\bCache\.make\s*\(/m;
const MUTATION_CONTEXT_RE = /(?:apps\/(?:aroma-convergence|aroma-gateway)\/|AromaCartMutator|setCartLineQuantity|removeCartLine|unsafeMutation|operationRef)/;
const RETRY_RE = /\bEffect\.(?:retry|repeat)\b|\bSchedule\.(?:exponential|spaced|recurs|forever|union|intersect|jittered|compose)\b/m;
const EFFECT_RUN_RE = /\b(?:Effect\.(?:runPromise|runPromiseExit|runSync|runSyncExit|runFork)|ManagedRuntime\.make|NodeRuntime\.runMain|Layer\.launch)\b/m;
const EFFECT_PROVIDE_RE = /\b(?:Effect\.provide(?:Service)?|Layer\.(?:provide|provideMerge|merge|mergeAll))\b/m;
const EFFECT_PRIMARY_RE = [
  ["async function", /\basync\s+(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/m],
  ["new Promise", /\bnew\s+Promise\s*[<(]/m],
  ["Promise.all", /\bPromise\.all\s*\(/m],
  ["Promise.race", /\bPromise\.race\s*\(/m],
  ["setTimeout", /\bsetTimeout\s*\(/m],
  ["setInterval", /\bsetInterval\s*\(/m],
  ["AbortController", /\bAbortController\b/m],
  ["Date.now", /\bDate\.now\s*\(/m],
  ["Temporal.Now", /\bTemporal\.Now\b/m],
];

function fail(ruleId, message) {
  const error = new Error(`${ruleId} ${message}`);
  error.ruleId = ruleId;
  throw error;
}

async function walk(root) {
  if (!existsSync(root)) return [];
  const output = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) output.push(...await walk(path));
    else output.push(path);
  }
  return output;
}

async function readJson(path, ruleId) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    fail(ruleId, `${path}: strict JSON is required: ${error.message}`);
  }
}

function labelOf(root, path) {
  return relative(root, path).replaceAll("\\", "/");
}

function packageRoot(moduleName) {
  if (!moduleName.startsWith("@")) return moduleName.split("/")[0];
  return moduleName.split("/").slice(0, 2).join("/");
}

function importedModules(source) {
  return [...source.matchAll(IMPORT_RE)].map((match) => match[1]);
}

function matchesPrefix(moduleName, prefix) {
  return moduleName === prefix.slice(0, -1) || moduleName.startsWith(prefix);
}

function isApprovedInterop(label) {
  return APPROVED_INTEROP_PREFIXES.some((prefix) => label.startsWith(prefix));
}

function isRunBoundary(label) {
  return (
    /^apps\/[^/]+\/src\/main\.(?:ts|mts|cts)$/.test(label)
    || label.startsWith("apps/web/src/runtime/")
    || label.startsWith("packages/platform-testing/")
  );
}

function isCompositionBoundary(label) {
  return (
    /^apps\/[^/]+\/src\/(?:main|layer)\.(?:ts|mts|cts)$/.test(label)
    || /^packages\/platform-[^/]+\/src\/(?:layer(?:\.[^/]+)?|layer\/[^/]+)\.(?:ts|mts|cts)$/.test(label)
    || label.startsWith("packages/platform-testing/")
  );
}

function isDriverOwner(label, moduleName) {
  if (!["pg", "pg-cursor", "pg-copy-streams"].includes(packageRoot(moduleName))) return true;
  return label.startsWith("packages/platform-database/");
}

function checkModulePolicy(label, modules, modulePolicy) {
  const allowedOfficial = new Set(modulePolicy.allowedOfficialPackages ?? []);
  const allowedUnstable = modulePolicy.allowedUnstablePrefixes ?? [];
  const forbiddenUnstable = modulePolicy.explicitlyForbiddenUnstablePrefixes ?? [];

  for (const moduleName of modules) {
    if (moduleName === "effect" || moduleName.startsWith("effect/")) {
      if (!moduleName.startsWith("effect/unstable/")) continue;
      const forbidden = forbiddenUnstable.find((prefix) => matchesPrefix(moduleName, prefix));
      if (forbidden) {
        fail("ARCH-EFFECT-MODULE-ALLOWLIST", `${label}: forbidden Effect module ${moduleName} (${forbidden})`);
      }
      if (!allowedUnstable.some((prefix) => matchesPrefix(moduleName, prefix))) {
        fail("ARCH-EFFECT-MODULE-ALLOWLIST", `${label}: Effect unstable module is not allowlisted: ${moduleName}`);
      }
      continue;
    }

    if (moduleName.startsWith("@effect/")) {
      const root = packageRoot(moduleName);
      if (!allowedOfficial.has(root)) {
        fail("ARCH-EFFECT-MODULE-ALLOWLIST", `${label}: unapproved official/community Effect package ${moduleName}`);
      }
    }
  }
}

function checkPrimaryExecution(label, source, legacy) {
  if (legacy || isApprovedInterop(label)) return;
  for (const [name, pattern] of EFFECT_PRIMARY_RE) {
    if (pattern.test(source)) {
      fail("ARCH-EFFECT-PRIMARY", `${label}: ${name} is forbidden outside an approved Effect interop boundary`);
    }
  }
}

function checkRunBoundary(label, source, legacy) {
  if (legacy || !EFFECT_RUN_RE.test(source)) return;
  if (!isRunBoundary(label)) {
    fail("ARCH-EFFECT-RUN-BOUNDARY", `${label}: Effect runtime execution is allowed only at a process/browser/test boundary`);
  }
  if (/\bNodeRuntime\.runMain\b/.test(source) && !/^apps\/[^/]+\/src\/main\.(?:ts|mts|cts)$/.test(label)) {
    fail("ARCH-EFFECT-RUN-BOUNDARY", `${label}: NodeRuntime.runMain is allowed only in apps/<runtime>/src/main.ts`);
  }
  if (/\bManagedRuntime\.make\b/.test(source) && !label.startsWith("apps/web/src/runtime/") && !label.startsWith("packages/platform-testing/")) {
    fail("ARCH-EFFECT-RUN-BOUNDARY", `${label}: ManagedRuntime.make is allowed only in the browser runtime or tests`);
  }
}

function checkProvideBoundary(label, source, legacy) {
  if (legacy || !EFFECT_PROVIDE_RE.test(source)) return;
  if (!isCompositionBoundary(label)) {
    fail("ARCH-EFFECT-PROVIDE-BOUNDARY", `${label}: Effect/Layer composition is allowed only in main.ts, layer.ts or technical layer modules`);
  }
}

function checkScopedFiber(label, source, legacy) {
  if (legacy) return;
  if (/\b(?:Effect\.)?forkDaemon\b|\bFiber\.unsafeFork\b/m.test(source)) {
    fail("ARCH-EFFECT-SCOPED-FIBER", `${label}: daemon/unowned fibers are forbidden; use an owning Scope`);
  }
}

function checkDurability(label, source, legacy) {
  if (legacy || !DURABLE_PATH_RE.test(label)) return;
  if (DURABLE_MEMORY_RE.test(source)) {
    fail("ARCH-EFFECT-DURABILITY", `${label}: process memory cannot be authoritative durable state`);
  }
}

function checkUnsafeRetry(label, source, legacy) {
  if (legacy) return;
  if (MUTATION_CONTEXT_RE.test(`${label}\n${source}`) && RETRY_RE.test(source)) {
    fail("ARCH-EFFECT-UNSAFE-RETRY", `${label}: retry/repeat Schedule is forbidden for an unsafe AROMA mutation path`);
  }
}

function checkSqlBoundary(label, modules, legacy) {
  if (legacy) return;
  for (const moduleName of modules) {
    if (!isDriverOwner(label, moduleName)) {
      fail("ARCH-EFFECT-SQL-BOUNDARY", `${label}: direct ${moduleName} import is allowed only in packages/platform-database`);
    }
  }
}

function checkContractBoundary(label, modules, legacy) {
  if (legacy) return;
  if (label.startsWith("apps/web/")) {
    const internal = modules.find((moduleName) => moduleName.includes("contracts-internal-v1") || moduleName.includes("/internal-v1"));
    if (internal) {
      fail("ARCH-EFFECT-CONTRACT-AUTHORITY", `${label}: frontend cannot import internal contract ${internal}`);
    }
  }
  const generated = modules.find((moduleName) => moduleName.startsWith("@hey-api/") || moduleName.includes("packages/generated") || moduleName.includes("/generated/"));
  if (generated) {
    fail("ARCH-EFFECT-CONTRACT-AUTHORITY", `${label}: generated/Hey API contract path is forbidden for new production code: ${generated}`);
  }
}

function checkOwnerLayer(label, modules) {
  if (!/\/src\/(?:main|layer)\.(?:ts|mts|cts)$/.test(label)) return;
  const sourceRuntime = label.startsWith("apps/") ? label.split("/")[1] : null;
  if (!sourceRuntime) return;
  for (const moduleName of modules) {
    const match = moduleName.match(/(?:^|\/|@coffee-platform\/apps\/)([^/]+)\/(?:src\/)?(?:domain|application|infrastructure|store|layer)/);
    if (match && match[1] !== sourceRuntime) {
      fail("ARCH-EFFECT-OWNER-LAYER", `${label}: owner Layer cannot import ${moduleName}`);
    }
  }
}

async function legacySources(root) {
  const path = join(root, "config/effect-legacy-inventory.json");
  if (!existsSync(path)) return new Set();
  const inventory = await readJson(path, "ARCH-EFFECT-LEGACY-INVENTORY");
  return new Set(inventory.legacyProductionSourceFiles ?? []);
}

export async function checkEffectArchitecture(root = POLICY_ROOT, options = {}) {
  const resolvedRoot = resolve(root);
  const policyRoot = resolve(options.policyRoot ?? POLICY_ROOT);
  const decision = await readJson(
    join(policyRoot, "platform/runtime-foundation-decision.json"),
    "ARCH-EFFECT-MODULE-ALLOWLIST",
  );
  const modulePolicy = decision.effectPlatform?.modulePolicy;
  if (!modulePolicy || modulePolicy.unstableDefault !== "deny") {
    fail("ARCH-EFFECT-MODULE-ALLOWLIST", "Effect module policy with unstable default-deny is required");
  }

  const legacy = await legacySources(resolvedRoot);
  const files = [
    ...await walk(join(resolvedRoot, "apps")),
    ...await walk(join(resolvedRoot, "packages")),
  ].filter((path) => SOURCE_FILE_RE.test(path) && labelOf(resolvedRoot, path).includes("/src/"));

  let checked = 0;
  let legacyChecked = 0;
  for (const path of files) {
    const label = labelOf(resolvedRoot, path);
    const source = await readFile(path, "utf8");
    const modules = importedModules(source);
    const isLegacy = legacy.has(label);
    if (isLegacy) legacyChecked += 1;

    checkModulePolicy(label, modules, modulePolicy);
    checkPrimaryExecution(label, source, isLegacy);
    checkRunBoundary(label, source, isLegacy);
    checkProvideBoundary(label, source, isLegacy);
    checkScopedFiber(label, source, isLegacy);
    checkDurability(label, source, isLegacy);
    checkUnsafeRetry(label, source, isLegacy);
    checkSqlBoundary(label, modules, isLegacy);
    checkContractBoundary(label, modules, isLegacy);
    checkOwnerLayer(label, modules);
    checked += 1;
  }

  return {
    checked,
    legacyChecked,
    interopPrefixes: APPROVED_INTEROP_PREFIXES.length,
  };
}
