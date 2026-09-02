#!/usr/bin/env node

import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { load as parseYaml } from "js-yaml";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIELD_BY_PACKAGE = {
  effect: "effect",
  "@effect/platform-node": "effectPlatformNode",
  "@effect/platform-browser": "effectPlatformBrowser",
  "@effect/sql-pg": "effectSqlPg",
  "@effect/opentelemetry": "effectOpenTelemetry",
  "@effect/atom-react": "effectAtomReact",
  "@effect/vitest": "effectVitest",
  "@effect/tsgo": "effectTsgo",
  "pg-copy-streams": "pgCopyStreams",
};
const DIRECT = {
  effect: "4.0.0-rc.112",
  "@effect/tsgo": "0.39.0",
  "@effect/vitest": "4.0.0-rc.112",
};
const DIAGNOSTICS = [
  "floatingEffect", "floatingEffectInVitest", "missingEffectContext", "missingEffectError",
  "missingLayerContext", "promiseInEffectSuccess", "anyUnknownInErrorContext", "effectFnImplicitAny",
  "leakingRequirements", "multipleEffectProvide", "runEffectInsideEffect", "scopeInLayerEffect",
  "strictEffectProvide", "tryCatchInEffectGen", "unknownInEffectCatch", "globalErrorInEffectCatch",
  "globalErrorInEffectFailure", "abortControllerInEffect", "asyncFunction", "extendsNativeError",
  "duplicatePackage", "outdatedApi",
];

function fail(rule, message) {
  const error = new Error(`${rule} ${message}`);
  error.ruleId = rule;
  throw error;
}

async function text(path) {
  try { return await readFile(path, "utf8"); }
  catch (error) { fail("EFFECT-TOOLCHAIN-FILE", `${path}: ${error.message}`); }
}

async function json(path) {
  try { return JSON.parse(await text(path)); }
  catch (error) { fail("EFFECT-TOOLCHAIN-FILE", `${path}: strict JSON required: ${error.message}`); }
}

async function yaml(path) {
  try {
    const value = parseYaml(await text(path));
    if (!value || typeof value !== "object" || Array.isArray(value)) fail("EFFECT-TOOLCHAIN-FILE", `${path}: object root required`);
    return value;
  } catch (error) {
    fail("EFFECT-TOOLCHAIN-FILE", `${path}: valid YAML required: ${error.message}`);
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

function exact(actual, expected, label, rule = "EFFECT-TOOLCHAIN-PIN") {
  if (actual !== expected) fail(rule, `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function dependencies(manifest) {
  return { ...manifest.dependencies, ...manifest.devDependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies };
}

function packageIdentity(key) {
  const separator = key.startsWith("@") ? key.indexOf("@", key.indexOf("/") + 1) : key.indexOf("@");
  if (separator <= 0) return null;
  return { name: key.slice(0, separator), version: key.slice(separator + 1).split("(")[0] };
}

function packageVersions(lock, name) {
  const versions = new Set();
  for (const key of Object.keys(lock.packages ?? {})) {
    const identity = packageIdentity(key);
    if (identity?.name === name) versions.add(identity.version);
  }
  return versions;
}

async function checkTsConfig(root) {
  const effectConfig = await json(join(root, "tsconfig.effect.json"));
  exact(effectConfig.extends, "./tsconfig.base.json", "tsconfig.effect.json.extends", "EFFECT-DIAGNOSTICS-CONFIG");
  const plugins = effectConfig.compilerOptions?.plugins;
  const matching = Array.isArray(plugins) ? plugins.filter((item) => item?.name === "@effect/language-service") : [];
  if (matching.length !== 1) fail("EFFECT-DIAGNOSTICS-CONFIG", "exactly one @effect/language-service plugin required");
  const plugin = matching[0];
  exact(plugin.ignoreEffectSuggestionsInTscExitCode, true, "ignoreEffectSuggestionsInTscExitCode", "EFFECT-DIAGNOSTICS-CONFIG");
  exact(plugin.ignoreEffectWarningsInTscExitCode, false, "ignoreEffectWarningsInTscExitCode", "EFFECT-DIAGNOSTICS-CONFIG");
  exact(plugin.ignoreEffectErrorsInTscExitCode, false, "ignoreEffectErrorsInTscExitCode", "EFFECT-DIAGNOSTICS-CONFIG");
  for (const rule of DIAGNOSTICS) exact(plugin.diagnosticSeverity?.[rule], "error", `diagnosticSeverity.${rule}`, "EFFECT-DIAGNOSTICS-CONFIG");

  const rootConfig = await json(join(root, "tsconfig.json"));
  const refs = new Set((rootConfig.references ?? []).map((item) => item.path));
  if (!refs.has("tests/effect-policy")) fail("EFFECT-DIAGNOSTICS-CONFIG", "root tsconfig must reference tests/effect-policy");
  const policy = await json(join(root, "tests/effect-policy/tsconfig.json"));
  exact(policy.extends, "../../tsconfig.effect.json", "tests/effect-policy/tsconfig.json.extends", "EFFECT-DIAGNOSTICS-CONFIG");
}

async function checkManifests(root, bom) {
  const paths = [join(root, "package.json"), ...await walk(join(root, "apps")), ...await walk(join(root, "packages"))]
    .filter((path) => path.endsWith("package.json"));
  for (const path of paths) {
    const document = await json(path);
    const label = relative(root, path).replaceAll("\\", "/");
    for (const [name, version] of Object.entries(dependencies(document))) {
      if (name !== "effect" && !name.startsWith("@effect/")) continue;
      if (!(name in bom)) fail("EFFECT-MODULE-AUTHORITY", `${label}: unapproved package ${name}`);
      exact(version, bom[name], `${label}:${name}`);
    }
  }
}

async function checkLock(root, bom) {
  const lock = await yaml(join(root, "pnpm-lock.yaml"));
  const importer = lock.importers?.["."];
  for (const [name, expected] of Object.entries(DIRECT)) {
    const declared = importer?.devDependencies?.[name] ?? importer?.dependencies?.[name];
    exact(declared?.specifier, expected, `pnpm-lock.yaml importer .:${name}`, "EFFECT-TOOLCHAIN-LOCK");
  }
  for (const [name, expected] of Object.entries(bom)) {
    const versions = packageVersions(lock, name);
    const requiredNow = Object.hasOwn(DIRECT, name);
    if (!requiredNow && versions.size === 0) continue;
    if (versions.size !== 1 || !versions.has(expected)) {
      fail("EFFECT-TOOLCHAIN-DUPLICATE", `${name} must resolve only to ${expected}; got ${[...versions].join(", ") || "none"}`);
    }
  }
  const core = packageVersions(lock, "effect");
  if ([...core].some((version) => version.startsWith("3."))) fail("EFFECT-TOOLCHAIN-DUPLICATE", `Effect 3 forbidden: ${[...core].join(", ")}`);
}

export async function checkEffectToolchain(root = ROOT) {
  const authority = await json(join(root, "platform/runtime-foundation-decision.json"));
  const registry = await json(join(root, "config/toolchain-versions.json"));
  const manifest = await json(join(root, "package.json"));
  const workspace = await yaml(join(root, "pnpm-workspace.yaml"));
  const bom = authority.effectPlatform?.bom;
  if (!bom || typeof bom !== "object") fail("EFFECT-TOOLCHAIN-AUTHORITY", "effectPlatform.bom missing");

  for (const [name, field] of Object.entries(FIELD_BY_PACKAGE)) {
    exact(registry[field], bom[name], `toolchain.${field}`);
    exact(registry.effectTarget?.packages?.[name], bom[name], `effectTarget.packages.${name}`);
    exact(workspace.overrides?.[name], bom[name], `pnpm-workspace.yaml.overrides.${name}`);
  }
  exact(registry.temporaryLegacyInventory, "config/effect-legacy-inventory.json", "temporaryLegacyInventory");
  if (manifest.pnpm !== undefined) fail("EFFECT-TOOLCHAIN-AUTHORITY", "package.json.pnpm forbidden under pnpm 11");
  for (const [name, expected] of Object.entries(DIRECT)) exact(manifest.devDependencies?.[name], expected, `package.json.devDependencies.${name}`);
  exact(manifest.scripts?.prepare, "effect-tsgo patch --typescript --no-oxlint", "package.json.scripts.prepare", "EFFECT-DIAGNOSTICS-CONFIG");
  exact(manifest.scripts?.typecheck, "effect-tsgo patch --typescript --no-oxlint && tsc -b --pretty false", "package.json.scripts.typecheck", "EFFECT-DIAGNOSTICS-CONFIG");
  if (/effect-tsgo\s+diagnostics/.test(manifest.scripts?.typecheck ?? "")) fail("EFFECT-DIAGNOSTICS-CONFIG", "second diagnostics lane forbidden");

  await checkTsConfig(root);
  await checkManifests(root, bom);
  await checkLock(root, bom);
  return { packages: Object.keys(bom).length, effect: bom.effect, tsgo: bom["@effect/tsgo"] };
}

const rootIndex = process.argv.indexOf("--root");
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = await checkEffectToolchain(rootIndex === -1 ? ROOT : resolve(process.argv[rootIndex + 1]));
    console.log(`effect toolchain: passed (${result.packages} pins, Effect ${result.effect}, TS-Go ${result.tsgo})`);
  } catch (error) {
    console.error(`effect toolchain: FAIL: ${error.message}`);
    process.exitCode = 1;
  }
}
