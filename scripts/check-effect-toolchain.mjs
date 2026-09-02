#!/usr/bin/env node

import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const FIELD_BY_PACKAGE = Object.freeze({
  effect: "effect",
  "@effect/platform-node": "effectPlatformNode",
  "@effect/platform-browser": "effectPlatformBrowser",
  "@effect/sql-pg": "effectSqlPg",
  "@effect/opentelemetry": "effectOpenTelemetry",
  "@effect/atom-react": "effectAtomReact",
  "@effect/vitest": "effectVitest",
  "@effect/tsgo": "effectTsgo",
  "pg-copy-streams": "pgCopyStreams",
});

const DIRECT_ISSUE_26_DEPENDENCIES = Object.freeze({
  effect: "4.0.0-rc.112",
  "@effect/tsgo": "0.39.0",
  "@effect/vitest": "4.0.0-rc.112",
});

const REQUIRED_DIAGNOSTICS = Object.freeze([
  "floatingEffect",
  "floatingEffectInVitest",
  "missingEffectContext",
  "missingEffectError",
  "missingLayerContext",
  "promiseInEffectSuccess",
  "anyUnknownInErrorContext",
  "effectFnImplicitAny",
  "leakingRequirements",
  "multipleEffectProvide",
  "runEffectInsideEffect",
  "scopeInLayerEffect",
  "strictEffectProvide",
  "tryCatchInEffectGen",
  "unknownInEffectCatch",
  "globalErrorInEffectCatch",
  "globalErrorInEffectFailure",
  "abortControllerInEffect",
  "asyncFunction",
  "extendsNativeError",
  "duplicatePackage",
  "outdatedApi",
]);

function fail(ruleId, message) {
  const error = new Error(`${ruleId} ${message}`);
  error.ruleId = ruleId;
  throw error;
}

async function readJson(path, ruleId = "EFFECT-TOOLCHAIN-FILE") {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    fail(ruleId, `${path}: strict JSON is required: ${error.message}`);
  }
}

async function readText(path, ruleId = "EFFECT-TOOLCHAIN-FILE") {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    fail(ruleId, `${path}: cannot read: ${error.message}`);
  }
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

function exact(actual, expected, label, ruleId = "EFFECT-TOOLCHAIN-PIN") {
  if (actual !== expected) fail(ruleId, `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function isExactRegistryVersion(version) {
  return typeof version === "string" && /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(version);
}

function dependenciesOf(manifest) {
  return {
    ...manifest.dependencies,
    ...manifest.devDependencies,
    ...manifest.optionalDependencies,
    ...manifest.peerDependencies,
  };
}

function lockVersions(lockfile, packageName) {
  const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const versions = new Set();
  const patterns = [
    new RegExp(`^  ['"]?${escaped}@([^'":()\\s]+)['"]?(?::|\\()`, "gm"),
    new RegExp(`^      ['"]?${escaped}@([^'":()\\s]+)['"]?(?::|\\()`, "gm"),
  ];
  for (const pattern of patterns) {
    for (const match of lockfile.matchAll(pattern)) versions.add(match[1]);
  }
  return versions;
}

function findEffectPlugin(document, label) {
  const plugins = document.compilerOptions?.plugins;
  if (!Array.isArray(plugins)) fail("EFFECT-DIAGNOSTICS-CONFIG", `${label}: compilerOptions.plugins is required`);
  const matches = plugins.filter((plugin) => plugin?.name === "@effect/language-service");
  if (matches.length !== 1) fail("EFFECT-DIAGNOSTICS-CONFIG", `${label}: exactly one @effect/language-service plugin is required`);
  return matches[0];
}

async function checkTsConfig(root) {
  const document = await readJson(join(root, "tsconfig.effect.json"));
  exact(document.extends, "./tsconfig.base.json", "tsconfig.effect.json.extends", "EFFECT-DIAGNOSTICS-CONFIG");
  const plugin = findEffectPlugin(document, "tsconfig.effect.json");
  exact(plugin.ignoreEffectSuggestionsInTscExitCode, true, "ignoreEffectSuggestionsInTscExitCode", "EFFECT-DIAGNOSTICS-CONFIG");
  exact(plugin.ignoreEffectWarningsInTscExitCode, false, "ignoreEffectWarningsInTscExitCode", "EFFECT-DIAGNOSTICS-CONFIG");
  exact(plugin.ignoreEffectErrorsInTscExitCode, false, "ignoreEffectErrorsInTscExitCode", "EFFECT-DIAGNOSTICS-CONFIG");
  for (const rule of REQUIRED_DIAGNOSTICS) {
    exact(plugin.diagnosticSeverity?.[rule], "error", `diagnosticSeverity.${rule}`, "EFFECT-DIAGNOSTICS-CONFIG");
  }

  const rootConfig = await readJson(join(root, "tsconfig.json"));
  const references = new Set((rootConfig.references ?? []).map((reference) => reference.path));
  if (!references.has("tests/effect-policy")) {
    fail("EFFECT-DIAGNOSTICS-CONFIG", "root tsconfig.json must reference tests/effect-policy");
  }
  const policyConfig = await readJson(join(root, "tests/effect-policy/tsconfig.json"));
  exact(policyConfig.extends, "../../tsconfig.effect.json", "tests/effect-policy/tsconfig.json.extends", "EFFECT-DIAGNOSTICS-CONFIG");
}

async function checkManifestGraph(root, bom) {
  const paths = [
    join(root, "package.json"),
    ...await walk(join(root, "apps")),
    ...await walk(join(root, "packages")),
  ].filter((path) => path.endsWith("package.json"));

  for (const path of paths) {
    const manifest = await readJson(path);
    const label = relative(root, path).replaceAll("\\", "/");
    for (const [name, version] of Object.entries(dependenciesOf(manifest))) {
      if (name !== "effect" && !name.startsWith("@effect/")) continue;
      if (!(name in bom)) fail("EFFECT-MODULE-AUTHORITY", `${label}: unapproved Effect package ${name}`);
      exact(version, bom[name], `${label}:${name}`);
      if (!isExactRegistryVersion(version)) fail("EFFECT-TOOLCHAIN-PIN", `${label}:${name} must use an exact version`);
    }
  }
}

async function checkLockfile(root, bom) {
  const lockfile = await readText(join(root, "pnpm-lock.yaml"));
  for (const [name, expected] of Object.entries(bom)) {
    const versions = lockVersions(lockfile, name);
    if (name === "pg-copy-streams" && versions.size === 0) continue;
    if (name.startsWith("@effect/") && !["@effect/tsgo", "@effect/vitest"].includes(name) && versions.size === 0) continue;
    if (versions.size !== 1 || !versions.has(expected)) {
      fail(
        "EFFECT-TOOLCHAIN-DUPLICATE",
        `pnpm-lock.yaml must contain only ${name}@${expected}; got ${[...versions].join(", ") || "none"}`,
      );
    }
  }
  const allEffectCore = new Set();
  for (const match of lockfile.matchAll(/^  ['"]?effect@([^'":()\s]+)['"]?(?::|\()/gm)) allEffectCore.add(match[1]);
  if ([...allEffectCore].some((version) => version.startsWith("3."))) {
    fail("EFFECT-TOOLCHAIN-DUPLICATE", `Effect 3 is forbidden in pnpm-lock.yaml: ${[...allEffectCore].join(", ")}`);
  }
}

export async function checkEffectToolchain(root = REPO_ROOT) {
  const resolvedRoot = resolve(root);
  const authority = await readJson(join(resolvedRoot, "platform/runtime-foundation-decision.json"));
  const registry = await readJson(join(resolvedRoot, "config/toolchain-versions.json"));
  const rootManifest = await readJson(join(resolvedRoot, "package.json"));
  const bom = authority.effectPlatform?.bom;
  if (!bom || typeof bom !== "object") fail("EFFECT-TOOLCHAIN-AUTHORITY", "effectPlatform.bom is missing");

  for (const [name, field] of Object.entries(FIELD_BY_PACKAGE)) {
    exact(registry[field], bom[name], `config/toolchain-versions.json.${field}`);
    exact(registry.effectTarget?.packages?.[name], bom[name], `config/toolchain-versions.json.effectTarget.packages.${name}`);
    exact(rootManifest.pnpm?.overrides?.[name], bom[name], `package.json.pnpm.overrides.${name}`);
  }
  exact(registry.temporaryLegacyInventory, "config/effect-legacy-inventory.json", "config/toolchain-versions.json.temporaryLegacyInventory");

  for (const [name, expected] of Object.entries(DIRECT_ISSUE_26_DEPENDENCIES)) {
    exact(rootManifest.devDependencies?.[name], expected, `package.json.devDependencies.${name}`);
  }
  exact(rootManifest.scripts?.prepare, "effect-tsgo patch --typescript --no-oxlint", "package.json.scripts.prepare", "EFFECT-DIAGNOSTICS-CONFIG");
  exact(
    rootManifest.scripts?.typecheck,
    "effect-tsgo patch --typescript --no-oxlint && tsc -b --pretty false",
    "package.json.scripts.typecheck",
    "EFFECT-DIAGNOSTICS-CONFIG",
  );
  if (/effect-tsgo\s+diagnostics/.test(rootManifest.scripts?.typecheck ?? "")) {
    fail("EFFECT-DIAGNOSTICS-CONFIG", "typecheck must not run a second dedicated diagnostics lane");
  }

  await checkTsConfig(resolvedRoot);
  await checkManifestGraph(resolvedRoot, bom);
  await checkLockfile(resolvedRoot, bom);
  return { packages: Object.keys(bom).length, effect: bom.effect, tsgo: bom["@effect/tsgo"] };
}

function parseRoot(argv) {
  const index = argv.indexOf("--root");
  return index === -1 ? REPO_ROOT : resolve(argv[index + 1]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = await checkEffectToolchain(parseRoot(process.argv.slice(2)));
    console.log(`effect toolchain: passed (${result.packages} pinned packages, Effect ${result.effect}, TS-Go ${result.tsgo})`);
  } catch (error) {
    console.error(`effect toolchain: FAIL: ${error.message}`);
    process.exitCode = 1;
  }
}
