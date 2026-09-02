import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const IMPORT_RE = /\b(?:from|import|require)\b[^\n]*["']([^"']+)["']/giu;
const EFFECT_RUN_RE = /\b(?:Effect\.run[A-Z][A-Za-z]*|Layer\.launch|ManagedRuntime\.make)\s*\(/u;
const EFFECT_PROVIDE_RE = /\b(?:Effect\.provide(?:Service)?|Layer\.(?:provide(?:Merge)?|merge(?:All)?))\s*\(/u;
const RETRY_RE = /\b(?:Effect\.(?:retry|repeat)|Schedule\.(?:recurs|exponential|spaced|fixed|jittered|compose|and|or))\b/u;
const MUTATION_RE = /\b(?:mutation|mutator|setCart|removeCart|setLine|removeLine|operationRef|unsafe\s+mutation)\b/iu;
const LEGACY_EXECUTION_RE = /\b(?:async\s+function|new\s+Promise\s*\(|Promise\.(?:all|race)\s*\(|setTimeout\s*\(|setInterval\s*\(|new\s+AbortController\s*\(|Date\.now\s*\(|Temporal\.Now\b)/u;
const DURABLE_PATH_RE = /(?:idempotenc|inbox|outbox|attempt|lease|fence|reservation|journal)/iu;
const IN_MEMORY_STATE_RE = /\b(?:new\s+Map\s*\(|Ref\.(?:make|unsafeMake)\s*\(|Queue\.(?:bounded|unbounded)\s*\(|Cache\.(?:make|makeWith)\s*\()/u;

function fail(ruleId, message) {
  const error = new Error(`${ruleId} ${message}`);
  error.ruleId = ruleId;
  throw error;
}

async function readJson(path) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { fail("ARCH-EFFECT-AUTHORITY", `${path}: strict JSON required: ${error.message}`); }
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

function normalized(root, path) {
  return relative(root, path).replaceAll("\\", "/");
}

function isTestPath(label) {
  return /(?:^|\/)(?:test|tests|__tests__|fixtures)(?:\/|$)/u.test(label) || label.startsWith("packages/platform-testing/");
}

function isRunBoundary(label) {
  return /\/src\/main\.(?:ts|tsx|mts|cts)$/u.test(label) || label.startsWith("apps/web/src/runtime/") || isTestPath(label);
}

function isProvideBoundary(label) {
  return /\/src\/(?:main|layer(?:[./-]|$))[^/]*\.(?:ts|tsx|mts|cts)$/u.test(label)
    || /\/src\/layers\//u.test(label)
    || isTestPath(label);
}

function isSafeReadPath(label) {
  return /(?:safe-read|reader|read-|get-|catalog-export|cart-snapshot)/iu.test(label);
}

function checkModule(label, moduleName, policy) {
  if (moduleName === "effect" || moduleName.startsWith("effect/")) {
    if (moduleName.startsWith("effect/unstable/")) {
      const allowed = policy.allowedUnstablePrefixes.some((prefix) => moduleName.startsWith(prefix));
      if (!allowed) fail("ARCH-EFFECT-MODULE-ALLOWLIST", `${label}: forbidden unstable Effect import ${moduleName}`);
    }
    return;
  }
  if (moduleName.startsWith("@effect/")) {
    if (!policy.allowedOfficialPackages.includes(moduleName)) {
      fail("ARCH-EFFECT-MODULE-ALLOWLIST", `${label}: unapproved official Effect package ${moduleName}`);
    }
    if (label.startsWith("apps/web/") && moduleName === "@effect/platform-node") {
      fail("ARCH-EFFECT-MODULE-ALLOWLIST", `${label}: browser cannot import ${moduleName}`);
    }
    if (!label.startsWith("apps/web/") && ["@effect/platform-browser", "@effect/atom-react"].includes(moduleName)) {
      fail("ARCH-EFFECT-MODULE-ALLOWLIST", `${label}: backend cannot import ${moduleName}`);
    }
  }
  if (label.startsWith("apps/web/") && moduleName.includes("contracts-internal")) {
    fail("ARCH-EFFECT-CONTRACT-AUTHORITY", `${label}: frontend cannot import internal-v1 contract ${moduleName}`);
  }
  if (["pg", "pg-cursor", "pg-copy-streams"].includes(moduleName) && !label.startsWith("packages/platform-database/")) {
    fail("ARCH-EFFECT-SQL-BOUNDARY", `${label}: direct ${moduleName} import is allowed only in platform-database`);
  }
  if (/^@coffee-platform\/(?:platform-)?effect(?:$|[-/])/u.test(moduleName)) {
    fail("ARCH-EFFECT-WRAPPER", `${label}: internal Effect wrapper package ${moduleName} is forbidden`);
  }
}

function checkSource(label, source, policy, legacyFiles) {
  for (const match of source.matchAll(IMPORT_RE)) checkModule(label, match[1], policy);
  if (legacyFiles.has(label)) return;
  if (isTestPath(label)) return;

  if (EFFECT_RUN_RE.test(source) && !isRunBoundary(label)) {
    fail("ARCH-EFFECT-RUN-BOUNDARY", `${label}: Effect runtime execution is allowed only at process/browser runtime roots`);
  }
  if (EFFECT_PROVIDE_RE.test(source) && !isProvideBoundary(label)) {
    fail("ARCH-EFFECT-PROVIDE-BOUNDARY", `${label}: dependency provision/composition is allowed only in layer/main boundaries`);
  }
  if (/\bEffect\.forkDaemon\s*\(/u.test(source)) {
    fail("ARCH-EFFECT-SCOPED-FIBER", `${label}: forkDaemon creates an unowned fiber`);
  }
  if (LEGACY_EXECUTION_RE.test(source)) {
    fail("ARCH-EFFECT-PRIMARY", `${label}: new production effectful code must use Effect, Scope, Clock and structured concurrency`);
  }
  if (/\b(?:type|interface|class)\s+(?:AppEffect|CoffeeEffect|PlatformEffect)\b/u.test(source)) {
    fail("ARCH-EFFECT-WRAPPER", `${label}: AppEffect/CoffeeEffect/PlatformEffect wrapper is forbidden`);
  }
  if (DURABLE_PATH_RE.test(label) && IN_MEMORY_STATE_RE.test(source)) {
    fail("ARCH-EFFECT-DURABILITY", `${label}: durable protocol cannot use process-memory state as authority`);
  }
  if ((label.startsWith("apps/aroma-convergence/") || label.startsWith("apps/aroma-gateway/")) && RETRY_RE.test(source)) {
    if (MUTATION_RE.test(source) || !isSafeReadPath(label)) {
      fail("ARCH-EFFECT-UNSAFE-RETRY", `${label}: retry primitives are forbidden on AROMA mutation or non-approved paths`);
    }
  }
}

export async function checkEffectArchitecture(root) {
  const resolvedRoot = resolve(root);
  const authorityPath = join(resolvedRoot, "platform/runtime-foundation-decision.json");
  const inventoryPath = join(resolvedRoot, "config/effect-legacy-inventory.json");
  if (!existsSync(authorityPath) || !existsSync(inventoryPath)) return { skipped: true };

  const authority = await readJson(authorityPath);
  const inventory = await readJson(inventoryPath);
  const policy = authority.effectPlatform?.modulePolicy;
  if (!policy || !Array.isArray(policy.allowedUnstablePrefixes) || !Array.isArray(policy.allowedOfficialPackages)) {
    fail("ARCH-EFFECT-AUTHORITY", "Effect module policy is missing from runtime foundation decision");
  }
  const legacyFiles = new Set(inventory.legacyProductionSourceFiles ?? []);
  const sourceFiles = [
    ...await walk(join(resolvedRoot, "apps")),
    ...await walk(join(resolvedRoot, "packages")),
  ].filter((path) => /\.(?:ts|tsx|mts|cts)$/u.test(path));

  for (const path of sourceFiles) {
    const label = normalized(resolvedRoot, path);
    checkSource(label, await readFile(path, "utf8"), policy, legacyFiles);
  }
  return { skipped: false, files: sourceFiles.length };
}
