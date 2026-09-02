import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { checkEffectLegacyInventory } from "../../scripts/check-effect-legacy-inventory.mjs";
import { checkEffectArchitecture } from "../../scripts/effect-architecture-policy.mjs";

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const BASELINE_COMMIT = "8ab79c83674e4e0543663a5ae995710d5814aae5";

async function sourceRoot(path, source) {
  const root = await mkdtemp(join(tmpdir(), "coffee-effect-policy-"));
  const target = join(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, source, "utf8");
  return root;
}

async function expectRule(path, source, ruleId) {
  const root = await sourceRoot(path, source);
  try {
    await assert.rejects(
      checkEffectArchitecture(root, { policyRoot: REPO_ROOT }),
      (error) => {
        assert.match(String(error?.message), new RegExp(ruleId));
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

void test("GREEN ARCH-EFFECT: owner-local Effect program passes", async () => {
  const root = await sourceRoot(
    "apps/orders-service/src/application/read-order.ts",
    'import { Effect } from "effect";\nexport const readOrder = Effect.succeed("ord_01");\n',
  );
  try {
    const result = await checkEffectArchitecture(root, { policyRoot: REPO_ROOT });
    assert.equal(result.checked, 1);
    assert.equal(result.legacyChecked, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("GREEN ARCH-EFFECT: approved unstable HTTP module passes", async () => {
  const root = await sourceRoot(
    "packages/platform-runtime/src/layer.ts",
    'import * as HttpClient from "effect/unstable/http/HttpClient";\nexport const client = HttpClient;\n',
  );
  try {
    await checkEffectArchitecture(root, { policyRoot: REPO_ROOT });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("GREEN ARCH-EFFECT: Promise bridge is limited to an approved interop path", async () => {
  const root = await sourceRoot(
    "packages/platform-database/src/interop/pg.ts",
    'import pg from "pg";\nexport const connect = async () => pg;\n',
  );
  try {
    await checkEffectArchitecture(root, { policyRoot: REPO_ROOT });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("RED ARCH-EFFECT-MODULE-ALLOWLIST: Workflow is forbidden", () =>
  expectRule(
    "apps/orders-service/src/application/workflow.ts",
    'import * as Workflow from "effect/unstable/workflow/Workflow";\nexport const value = Workflow;\n',
    "ARCH-EFFECT-MODULE-ALLOWLIST",
  ));

void test("RED ARCH-EFFECT-PRIMARY: async application workflow is forbidden", () =>
  expectRule(
    "apps/orders-service/src/application/async-work.ts",
    "export async function execute() { return 1; }\n",
    "ARCH-EFFECT-PRIMARY",
  ));

void test("RED ARCH-EFFECT-RUN-BOUNDARY: nested runtime execution is forbidden", () =>
  expectRule(
    "apps/orders-service/src/application/run.ts",
    'import { Effect } from "effect";\nexport const result = Effect.runPromise(Effect.succeed(1));\n',
    "ARCH-EFFECT-RUN-BOUNDARY",
  ));

void test("RED ARCH-EFFECT-PROVIDE-BOUNDARY: application cannot provide dependencies", () =>
  expectRule(
    "apps/orders-service/src/application/provide.ts",
    'import { Effect } from "effect";\nexport const result = Effect.provide(Effect.succeed(1), {});\n',
    "ARCH-EFFECT-PROVIDE-BOUNDARY",
  ));

void test("RED ARCH-EFFECT-SCOPED-FIBER: daemon fiber is forbidden", () =>
  expectRule(
    "apps/orders-service/src/application/background.ts",
    'import { Effect } from "effect";\nexport const result = Effect.forkDaemon(Effect.never);\n',
    "ARCH-EFFECT-SCOPED-FIBER",
  ));

void test("RED ARCH-EFFECT-DURABILITY: process memory cannot implement Outbox", () =>
  expectRule(
    "packages/platform-outbox/src/store.ts",
    "export const durableMessages = new Map();\n",
    "ARCH-EFFECT-DURABILITY",
  ));

void test("RED ARCH-EFFECT-UNSAFE-RETRY: AROMA mutation cannot use retry", () =>
  expectRule(
    "apps/aroma-convergence/src/application/mutate.ts",
    'import { Effect } from "effect";\nexport const mutation = Effect.retry(Effect.succeed("ack"));\n',
    "ARCH-EFFECT-UNSAFE-RETRY",
  ));

void test("RED ARCH-EFFECT-SQL-BOUNDARY: application cannot import pg", () =>
  expectRule(
    "apps/orders-service/src/infrastructure/repository.ts",
    'import pg from "pg";\nexport const driver = pg;\n',
    "ARCH-EFFECT-SQL-BOUNDARY",
  ));

void test("RED ARCH-EFFECT-CONTRACT-AUTHORITY: web cannot import internal-v1", () =>
  expectRule(
    "apps/web/src/api/internal.ts",
    'import { InternalApiV1 } from "@coffee-platform/contracts-internal-v1";\nexport const api = InternalApiV1;\n',
    "ARCH-EFFECT-CONTRACT-AUTHORITY",
  ));

void test("RED ARCH-EFFECT-OWNER-LAYER: Orders Layer cannot import Catalog infrastructure", () =>
  expectRule(
    "apps/orders-service/src/layer.ts",
    'import { CatalogRepository } from "../../catalog-service/src/infrastructure/repository.js";\nexport const repository = CatalogRepository;\n',
    "ARCH-EFFECT-OWNER-LAYER",
  ));

async function legacyRoot() {
  const root = await mkdtemp(join(tmpdir(), "coffee-effect-legacy-"));
  await mkdir(join(root, "config"), { recursive: true });
  await mkdir(join(root, "apps/demo/src"), { recursive: true });
  await cp(
    join(REPO_ROOT, "config/effect-legacy-inventory.schema.json"),
    join(root, "config/effect-legacy-inventory.schema.json"),
  );
  const inventory = {
    $schema: "./effect-legacy-inventory.schema.json",
    schemaVersion: 1,
    baselineCommit: BASELINE_COMMIT,
    introducedBy: "#3/PR#22",
    ownerIssue: 26,
    finalRemovalTask: "3.8",
    allowNewUsage: false,
    entries: [
      {
        id: "legacy-fastify-runtime",
        category: "http-runtime",
        removalTask: "3.4",
        dependencies: [
          {
            name: "fastify",
            version: "5.12.1",
            manifests: ["package.json"],
          },
        ],
      },
    ],
    legacyProductionSourceFiles: ["apps/demo/src/main.ts"],
    legacySourceMarkers: ["async function"],
  };
  await writeFile(
    join(root, "config/effect-legacy-inventory.json"),
    `${JSON.stringify(inventory, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    join(root, "package.json"),
    `${JSON.stringify({ private: true, dependencies: { fastify: "5.12.1" } }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    join(root, "apps/demo/src/main.ts"),
    "export async function legacyStart() { return 1; }\n",
    "utf8",
  );
  return root;
}

void test("GREEN ARCH-EFFECT-LEGACY: exact closed inventory passes", async () => {
  const root = await legacyRoot();
  try {
    const result = await checkEffectLegacyInventory(root, { baseRef: "missing-base" });
    assert.equal(result.entries, 1);
    assert.equal(result.dependencies, 1);
    assert.equal(result.sourceFiles, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("RED ARCH-EFFECT-LEGACY-GROWTH: new legacy source is rejected", async () => {
  const root = await legacyRoot();
  try {
    await writeFile(
      join(root, "apps/demo/src/extra.ts"),
      "export async function addedLegacyPath() { return 2; }\n",
      "utf8",
    );
    await assert.rejects(
      checkEffectLegacyInventory(root, { baseRef: "missing-base" }),
      /ARCH-EFFECT-LEGACY-GROWTH/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
