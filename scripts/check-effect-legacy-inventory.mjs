#!/usr/bin/env node

import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INVENTORY_PATH = "config/effect-legacy-inventory.json";
const SCHEMA_PATH = "config/effect-legacy-inventory.schema.json";

function fail(ruleId, message) {
  const error = new Error(`${ruleId} ${message}`);
  error.ruleId = ruleId;
  throw error;
}

async function readJson(path, ruleId = "ARCH-EFFECT-LEGACY-INVENTORY") {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    fail(ruleId, `${path}: strict JSON is required: ${error.message}`);
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

function packageDependencies(manifest) {
  return {
    ...manifest.dependencies,
    ...manifest.devDependencies,
    ...manifest.optionalDependencies,
    ...manifest.peerDependencies,
  };
}

function normalizePath(root, path) {
  return relative(root, path).replaceAll("\\", "/");
}

function assertUnique(values, label) {
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) fail("ARCH-EFFECT-LEGACY-INVENTORY", `${label}: duplicate ${value}`);
    seen.add(value);
  }
}

function dependencyKey(name, version, manifest) {
  return `${name}\u0000${version}\u0000${manifest}`;
}

function flattenInventory(inventory) {
  const ids = inventory.entries.map((entry) => entry.id);
  assertUnique(ids, "entries");
  assertUnique(inventory.legacyProductionSourceFiles, "legacyProductionSourceFiles");
  assertUnique(inventory.legacySourceMarkers, "legacySourceMarkers");

  const dependencies = new Map();
  for (const entry of inventory.entries) {
    if (entry.dependencies.length === 0) fail("ARCH-EFFECT-LEGACY-INVENTORY", `${entry.id}: dependencies cannot be empty`);
    for (const dependency of entry.dependencies) {
      for (const manifest of dependency.manifests) {
        const key = dependencyKey(dependency.name, dependency.version, manifest);
        if (dependencies.has(key)) {
          fail("ARCH-EFFECT-LEGACY-INVENTORY", `${entry.id}: duplicate dependency allowance ${dependency.name}@${dependency.version} in ${manifest}`);
        }
        dependencies.set(key, { entryId: entry.id, ...dependency, manifest });
      }
    }
  }
  return {
    ids: new Set(ids),
    dependencies,
    sourceFiles: new Set(inventory.legacyProductionSourceFiles),
    markers: new Set(inventory.legacySourceMarkers),
  };
}

async function validateSchema(root, inventory) {
  const schema = await readJson(join(root, SCHEMA_PATH));
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validate = ajv.compile(schema);
  if (!validate(inventory)) {
    const details = (validate.errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message}`).join("; ");
    fail("ARCH-EFFECT-LEGACY-INVENTORY", `schema validation failed: ${details}`);
  }
}

async function checkDeclaredDependencies(root, inventoryView) {
  const manifests = [
    join(root, "package.json"),
    ...await walk(join(root, "apps")),
    ...await walk(join(root, "packages")),
  ].filter((path) => path.endsWith("package.json"));

  const actual = new Map();
  const legacyNames = new Set([...inventoryView.dependencies.values()].map((entry) => entry.name));
  for (const path of manifests) {
    const label = normalizePath(root, path);
    const document = await readJson(path);
    for (const [name, version] of Object.entries(packageDependencies(document))) {
      if (!legacyNames.has(name)) continue;
      if (typeof version !== "string") fail("ARCH-EFFECT-LEGACY-DEPENDENCY", `${label}:${name} must use a string version`);
      actual.set(dependencyKey(name, version, label), { name, version, manifest: label });
    }
  }

  for (const [key, expected] of inventoryView.dependencies) {
    if (!actual.has(key)) {
      fail(
        "ARCH-EFFECT-LEGACY-INVENTORY",
        `${expected.entryId}: stale or incorrect allowance ${expected.name}@${expected.version} in ${expected.manifest}`,
      );
    }
  }
  for (const occurrence of actual.values()) {
    const key = dependencyKey(occurrence.name, occurrence.version, occurrence.manifest);
    if (!inventoryView.dependencies.has(key)) {
      fail(
        "ARCH-EFFECT-LEGACY-GROWTH",
        `${occurrence.manifest}: new or changed legacy dependency ${occurrence.name}@${occurrence.version} is forbidden`,
      );
    }
  }
}

function readGitSource(root, ref, path) {
  const result = spawnSync("git", ["show", `${ref}:${path}`], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) {
    fail(
      "ARCH-EFFECT-LEGACY-BASELINE",
      `${ref}:${path} cannot be read: ${result.error?.message ?? result.stderr.trim() || `git exit ${result.status}`}`,
    );
  }
  return result.stdout;
}

async function checkProductionSources(root, inventoryView, baselineCommit) {
  const compareWithGitBaseline = existsSync(join(root, ".git"));
  for (const path of inventoryView.sourceFiles) {
    const absolute = join(root, path);
    if (!existsSync(absolute)) fail("ARCH-EFFECT-LEGACY-INVENTORY", `stale source allowance ${path}`);
    if (compareWithGitBaseline) {
      const currentSource = await readFile(absolute, "utf8");
      const baselineSource = readGitSource(root, baselineCommit, path);
      if (currentSource !== baselineSource) {
        fail(
          "ARCH-EFFECT-LEGACY-GROWTH",
          `${path}: registered legacy source differs from ${baselineCommit}; an owning cutover must remove the old path from the inventory instead of modifying it`,
        );
      }
    }
  }

  const files = [
    ...await walk(join(root, "apps")),
    ...await walk(join(root, "packages")),
  ].filter((path) => /\.(?:ts|tsx|mts|cts)$/.test(path) && normalizePath(root, path).includes("/src/"));

  for (const path of files) {
    const label = normalizePath(root, path);
    const source = await readFile(path, "utf8");
    const markers = [...inventoryView.markers].filter((marker) => source.includes(marker));
    if (markers.length > 0 && !inventoryView.sourceFiles.has(label)) {
      fail(
        "ARCH-EFFECT-LEGACY-GROWTH",
        `${label}: new legacy implementation marker(s) ${markers.join(", ")} are forbidden`,
      );
    }
  }
}

function readBaseInventory(root, ref) {
  const result = spawnSync("git", ["show", `${ref}:${INVENTORY_PATH}`], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) return null;
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    fail("ARCH-EFFECT-LEGACY-BASELINE", `${ref}:${INVENTORY_PATH} is invalid JSON: ${error.message}`);
  }
}

function assertSubset(current, baseline) {
  const currentView = flattenInventory(current);
  const baselineView = flattenInventory(baseline);

  for (const id of currentView.ids) {
    if (!baselineView.ids.has(id)) fail("ARCH-EFFECT-LEGACY-GROWTH", `new legacy entry ${id} is forbidden`);
  }
  for (const key of currentView.dependencies.keys()) {
    if (!baselineView.dependencies.has(key)) fail("ARCH-EFFECT-LEGACY-GROWTH", `legacy dependency allowance expanded: ${key.replaceAll("\u0000", " ")}`);
  }
  for (const path of currentView.sourceFiles) {
    if (!baselineView.sourceFiles.has(path)) fail("ARCH-EFFECT-LEGACY-GROWTH", `legacy source allowance expanded: ${path}`);
  }
  for (const marker of currentView.markers) {
    if (!baselineView.markers.has(marker)) fail("ARCH-EFFECT-LEGACY-GROWTH", `legacy marker allowance expanded: ${marker}`);
  }
}

function checkBaselineCommit(root, inventory) {
  if (!existsSync(join(root, ".git"))) return;
  const result = spawnSync("git", ["merge-base", "--is-ancestor", inventory.baselineCommit, "HEAD"], {
    cwd: root,
    stdio: "ignore",
  });
  if (result.status !== 0) {
    fail("ARCH-EFFECT-LEGACY-BASELINE", `baseline commit ${inventory.baselineCommit} is not an ancestor of HEAD`);
  }
}

export async function checkEffectLegacyInventory(root = REPO_ROOT, options = {}) {
  const resolvedRoot = resolve(root);
  const inventory = await readJson(join(resolvedRoot, INVENTORY_PATH));
  await validateSchema(resolvedRoot, inventory);
  if (inventory.allowNewUsage !== false) fail("ARCH-EFFECT-LEGACY-INVENTORY", "allowNewUsage must remain false");
  checkBaselineCommit(resolvedRoot, inventory);

  const view = flattenInventory(inventory);
  await checkDeclaredDependencies(resolvedRoot, view);
  await checkProductionSources(resolvedRoot, view, inventory.baselineCommit);

  const baseRef = options.baseRef ?? process.env.EFFECT_LEGACY_BASE_REF ?? "origin/develop";
  const baseline = readBaseInventory(resolvedRoot, baseRef);
  if (baseline) assertSubset(inventory, baseline);

  return {
    entries: inventory.entries.length,
    dependencies: view.dependencies.size,
    sourceFiles: view.sourceFiles.size,
    sourceBaselineCompared: existsSync(join(resolvedRoot, ".git")),
    baseCompared: baseline !== null,
    baseRef,
  };
}

function parseArguments(argv) {
  const rootIndex = argv.indexOf("--root");
  const baseIndex = argv.indexOf("--base-ref");
  return {
    root: rootIndex === -1 ? REPO_ROOT : resolve(argv[rootIndex + 1]),
    baseRef: baseIndex === -1 ? undefined : argv[baseIndex + 1],
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const result = await checkEffectLegacyInventory(options.root, { baseRef: options.baseRef });
    console.log(
      `effect legacy inventory: passed (${result.entries} entries, ${result.dependencies} dependency allowances, ${result.sourceFiles} source files${result.sourceBaselineCompared ? ", source baseline locked" : ""}${result.baseCompared ? `, compared with ${result.baseRef}` : ""})`,
    );
  } catch (error) {
    console.error(`effect legacy inventory: FAIL: ${error.message}`);
    process.exitCode = 1;
  }
}
