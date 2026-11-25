import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

const WORKER_ROOTS = [
  "apps/catalog-supplier-sync/src",
  "apps/aroma-convergence/src",
  "apps/catalog-activation-worker/src",
  "apps/aroma-observer/src",
  "apps/pricing-service/src",
];

// Перемещённые модули: старый корневой путь удалён, листовой — существует.
const MOVED_MODULES = [
  [
    "apps/catalog-supplier-sync/src/observability.ts",
    "apps/catalog-supplier-sync/src/telemetry/index.ts",
  ],
  [
    "apps/aroma-convergence/src/cart-plan.ts",
    "apps/aroma-convergence/src/domain/cart-plan.ts",
  ],
  [
    "apps/aroma-convergence/src/gateway-client.ts",
    "apps/aroma-convergence/src/infrastructure/gateway-client.ts",
  ],
  [
    "apps/aroma-convergence/src/observability.ts",
    "apps/aroma-convergence/src/telemetry/index.ts",
  ],
  [
    "apps/catalog-activation-worker/src/events.ts",
    "apps/catalog-activation-worker/src/domain/events.ts",
  ],
  [
    "apps/catalog-activation-worker/src/identity.ts",
    "apps/catalog-activation-worker/src/domain/identity.ts",
  ],
  [
    "apps/catalog-activation-worker/src/verify-generation.ts",
    "apps/catalog-activation-worker/src/domain/verify-generation.ts",
  ],
  [
    "apps/aroma-observer/src/observability.ts",
    "apps/aroma-observer/src/telemetry/index.ts",
  ],
  [
    "apps/aroma-observer/src/gateway-client.ts",
    "apps/aroma-observer/src/infrastructure/gateway-client.ts",
  ],
  [
    "apps/pricing-service/src/observability.ts",
    "apps/pricing-service/src/telemetry/index.ts",
  ],
];

// Импортёры листовых модулей: относительный спецификатор не должен возвращаться в корень src.
const LEAF_IMPORTS = [
  [
    "apps/catalog-supplier-sync/src/infrastructure/catalog-import-store.ts",
    "../telemetry/index.js",
  ],
  [
    "apps/aroma-convergence/src/infrastructure/convergence-store.ts",
    "../domain/cart-plan.js",
  ],
  [
    "apps/aroma-convergence/src/infrastructure/convergence-store.ts",
    "./gateway-client.js",
  ],
  [
    "apps/aroma-convergence/src/infrastructure/convergence-store.ts",
    "../telemetry/index.js",
  ],
  [
    "apps/aroma-convergence/src/infrastructure/row-schemas.ts",
    "../domain/cart-plan.js",
  ],
  [
    "apps/aroma-convergence/src/runtime-composition.ts",
    "./infrastructure/gateway-client.js",
  ],
  ["apps/aroma-convergence/src/runtime-composition.ts", "./telemetry/index.js"],
  [
    "apps/catalog-activation-worker/src/infrastructure/activation-store.ts",
    "../domain/events.js",
  ],
  [
    "apps/catalog-activation-worker/src/infrastructure/activation-store.ts",
    "../domain/identity.js",
  ],
  [
    "apps/catalog-activation-worker/src/infrastructure/activation-store.ts",
    "../domain/verify-generation.js",
  ],
  [
    "apps/aroma-observer/src/infrastructure/observation-store.ts",
    "./gateway-client.js",
  ],
  [
    "apps/aroma-observer/src/infrastructure/observation-store.ts",
    "../telemetry/index.js",
  ],
  [
    "apps/aroma-observer/src/runtime-composition.ts",
    "./infrastructure/gateway-client.js",
  ],
  ["apps/aroma-observer/src/runtime-composition.ts", "./telemetry/index.js"],
  ["apps/pricing-service/src/main.ts", "./telemetry/index.js"],
  ["apps/pricing-service/src/http/index.ts", "../telemetry/index.js"],
  [
    "apps/pricing-service/src/infrastructure/database/pricing-store.ts",
    "../../telemetry/index.js",
  ],
];

async function readSource(path) {
  return readFile(join(REPO_ROOT, path), "utf8");
}

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

function isReExportOnly(source) {
  return (
    stripComments(source)
      .replace(/export\s+(type\s+)?(\*|\{[^}]*\})\s+from\s+"[^"]+";/g, "")
      .trim().length === 0
  );
}

void test("старые корневые модули воркеров удалены", () => {
  for (const [legacyPath] of MOVED_MODULES) {
    assert.equal(
      existsSync(join(REPO_ROOT, legacyPath)),
      false,
      `legacy module ${legacyPath} must be deleted`,
    );
  }
});

void test("листовые модули воркеров существуют", () => {
  for (const [, leafPath] of MOVED_MODULES) {
    assert.equal(
      existsSync(join(REPO_ROOT, leafPath)),
      true,
      `leaf module ${leafPath} must exist`,
    );
  }
});

void test("импорты store и runtime-composition ведут в листовые модули", async () => {
  for (const [importer, specifier] of LEAF_IMPORTS) {
    const source = await readSource(importer);
    assert.ok(
      source.includes(`"${specifier}"`),
      `${importer} must import ${specifier}`,
    );
  }
});

void test("в корне src воркеров нет реэкспортных обёрток", async () => {
  for (const workerRoot of WORKER_ROOTS) {
    const entries = await readdir(join(REPO_ROOT, workerRoot), {
      withFileTypes: true,
    });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
      const source = await readSource(join(workerRoot, entry.name));
      assert.equal(
        isReExportOnly(source),
        false,
        `${workerRoot}/${entry.name} must not be a re-export wrapper`,
      );
    }
  }
});
